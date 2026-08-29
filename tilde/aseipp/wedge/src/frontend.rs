// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Translation from a validated WebAssembly Core module into Wedge IR.
//!
//! The frontend owns everything it retains. `wasmparser` readers and borrowed
//! strings never escape this module, which makes the resulting IR suitable for
//! long-running analysis and transformation pipelines.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use wasmparser::{
    AbstractHeapType, BinaryReaderError, BlockType, CompositeInnerType, CustomSectionReader,
    DataKind, ElementItems, ElementKind, Encoding, ExternalKind, FuncToValidate, FuncValidator,
    FuncValidatorAllocations, HeapType as WasmHeapType, KnownCustom, Name, NameSectionReader,
    Operator, PackedIndex, Parser, Payload, ProducersSectionReader, RefType as WasmRefType,
    StorageType as WasmStorageType, TableInit, TypeRef, UnpackedIndex, ValType, ValidPayload,
    Validator, ValidatorResources,
};

use crate::ir;
use crate::opcode::CoreOpcode;

/// Lower a validated WebAssembly Core 3.0 module into Wedge's owned IR.
///
/// Parsing, validation, and lowering are interleaved so the translator can use
/// `wasmparser`'s instantiated operand types directly. The explicit language
/// profile rejects proposals that must never enter the IR contract
/// (continuations, shared types, and exact/custom descriptors).
pub(crate) fn lower_module(wasm: &[u8]) -> Result<ir::Program, FrontendError> {
    let mut frontend = Frontend::new(wasm.len());
    frontend.parse(wasm)?;
    frontend.finish()
}

struct Frontend {
    program: ir::Program,
    canonical_types: BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
    saw_header: bool,
    next_code_function: usize,
}

impl Frontend {
    fn new(module_len: usize) -> Self {
        let mut program = ir::Program::new(0);
        program.source = source_span(0..module_len as u64);
        Self {
            program,
            canonical_types: BTreeMap::new(),
            saw_header: false,
            next_code_function: 0,
        }
    }

    fn parse(&mut self, wasm: &[u8]) -> Result<(), FrontendError> {
        let mut parser = Parser::new(0);
        parser.set_features(crate::STANDARD_WASM_3_FEATURES);
        let mut validator = Validator::new_with_features(crate::STANDARD_WASM_3_FEATURES);
        let mut function_allocations = FuncValidatorAllocations::default();
        for payload in parser.parse_all(wasm) {
            let payload = payload?;
            let validated = validator.payload(&payload)?;
            match payload {
                Payload::Version {
                    num,
                    encoding: Encoding::Module,
                    ..
                } => {
                    self.program.wasm_version = num;
                    self.saw_header = true;
                }
                Payload::Version { .. } => return Err(FrontendError::UnsupportedEncoding),
                Payload::TypeSection(reader) => {
                    self.lower_types(reader)?;
                    let validator_types = validator
                        .types(0)
                        .ok_or(FrontendError::MissingValidatorTypes)?;
                    for (index, definition) in self.program.types.iter_mut().enumerate() {
                        let id = ir::TypeId(index as u32);
                        let canonical = validator_types.core_type_at_in_module(index as u32);
                        let representative = *self.canonical_types.entry(canonical).or_insert(id);
                        definition.canonical_alias =
                            (representative != id).then_some(representative);
                    }
                }
                Payload::ImportSection(reader) => self.lower_imports(reader)?,
                Payload::FunctionSection(reader) => self.lower_function_declarations(reader)?,
                Payload::TableSection(reader) => self.lower_tables(reader)?,
                Payload::MemorySection(reader) => self.lower_memories(reader)?,
                Payload::TagSection(reader) => self.lower_tags(reader)?,
                Payload::GlobalSection(reader) => self.lower_globals(reader)?,
                Payload::ExportSection(reader) => self.lower_exports(reader)?,
                Payload::StartSection { func, .. } => {
                    self.program.start = Some(ir::FunctionId(func));
                }
                Payload::ElementSection(reader) => self.lower_elements(reader)?,
                Payload::DataSection(reader) => self.lower_data(reader)?,
                Payload::CodeSectionStart { .. } | Payload::DataCountSection { .. } => {}
                Payload::CodeSectionEntry(body) => {
                    let ValidPayload::Func(function_validator, _) = validated else {
                        return Err(FrontendError::MissingFunctionValidator);
                    };
                    function_allocations =
                        self.lower_code_entry(body, function_validator, function_allocations)?;
                }
                Payload::CustomSection(reader) => self.lower_custom_section(&reader),
                Payload::UnknownSection { id, range, .. } => {
                    return Err(FrontendError::UnsupportedSection {
                        id,
                        offset: range.start,
                    });
                }
                Payload::End(_) => {}
                _ => {
                    return Err(FrontendError::UnsupportedPayload);
                }
            }
        }
        Ok(())
    }

    fn finish(mut self) -> Result<ir::Program, FrontendError> {
        if !self.saw_header {
            return Err(FrontendError::MissingModuleHeader);
        }

        let missing_body =
            self.program
                .functions
                .iter()
                .enumerate()
                .find_map(|(index, function)| match function.origin {
                    ir::EntityOrigin::Defined if function.body.is_none() => Some(index as u32),
                    _ => None,
                });
        if let Some(function_index) = missing_body {
            return Err(FrontendError::MissingFunctionBody { function_index });
        }

        // Nothing validates a name section against the index spaces it
        // names, and the module is valid without it, so an entry naming
        // nothing is dropped rather than rejecting the module.
        let program = &mut self.program;
        let functions = &program.functions;
        program
            .metadata
            .function_names
            .retain(|function, _| function.index() < functions.len());
        program.metadata.local_names.retain(|(function, local), _| {
            functions
                .get(function.index())
                .is_some_and(|function| local.index() < function.locals.len())
        });

        self.program
            .verify()
            .map_err(|errors| FrontendError::InvalidIr {
                message: errors.to_string(),
            })?;
        Ok(self.program)
    }

    /// Decodes the standard `name` and `producers` sections into the module
    /// metadata and retains every other custom section opaquely. Custom
    /// sections carry no semantics, so a standard section that fails to
    /// decode is retained opaquely too instead of rejecting the module.
    fn lower_custom_section(&mut self, reader: &CustomSectionReader<'_>) {
        let decoded = match reader.as_known() {
            KnownCustom::Name(names) => self.lower_names(names).is_ok(),
            KnownCustom::Producers(producers) => self.lower_producers(producers).is_ok(),
            _ => false,
        };
        if !decoded {
            self.program
                .metadata
                .custom_sections
                .push(ir::CustomSection {
                    name: reader.name().to_owned(),
                    data: reader.data().to_vec(),
                    source: source_span(reader.range()),
                });
        }
    }

    /// Module, function, and local names. The metadata models no other name
    /// subsection, so label, type, table, memory, global, segment, field, and
    /// tag names are dropped. Nothing is recorded from a malformed section.
    fn lower_names(&mut self, names: NameSectionReader<'_>) -> Result<(), BinaryReaderError> {
        let mut module_name = None;
        let mut function_names = Vec::new();
        let mut local_names = Vec::new();
        for name in names {
            match name? {
                Name::Module { name, .. } => module_name = Some(name.to_owned()),
                Name::Function(map) => {
                    for naming in map {
                        let naming = naming?;
                        function_names.push((ir::FunctionId(naming.index), naming.name.to_owned()));
                    }
                }
                Name::Local(map) => {
                    for function in map {
                        let function = function?;
                        for naming in function.names {
                            let naming = naming?;
                            local_names.push((
                                (ir::FunctionId(function.index), ir::LocalId(naming.index)),
                                naming.name.to_owned(),
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
        let metadata = &mut self.program.metadata;
        if module_name.is_some() {
            metadata.module_name = module_name;
        }
        metadata.function_names.extend(function_names);
        metadata.local_names.extend(local_names);
        Ok(())
    }

    fn lower_producers(
        &mut self,
        producers: ProducersSectionReader<'_>,
    ) -> Result<(), BinaryReaderError> {
        let mut decoded = Vec::new();
        for field in producers {
            let field = field?;
            for value in field.values {
                let value = value?;
                decoded.push(ir::Producer {
                    field: field.name.to_owned(),
                    name: value.name.to_owned(),
                    version: value.version.to_owned(),
                });
            }
        }
        self.program.metadata.producers.extend(decoded);
        Ok(())
    }

    fn lower_types(
        &mut self,
        reader: wasmparser::TypeSectionReader<'_>,
    ) -> Result<(), FrontendError> {
        for group in reader {
            let group = group?;
            let group_base = self.program.types.len() as u32;
            let raw_types: Vec<_> = group.into_types_and_offsets().collect();
            let group_source = raw_types
                .first()
                .map(|(offset, _)| point_source(*offset))
                .unwrap_or_else(ir::SourceInfo::synthetic);
            let mut type_ids = Vec::with_capacity(raw_types.len());

            for (relative_index, (offset, subtype)) in raw_types.into_iter().enumerate() {
                let type_id = ir::TypeId(group_base + relative_index as u32);
                let context = TypeContext {
                    group_base: Some(group_base),
                };
                let composite = &subtype.composite_type;

                if composite.shared {
                    return Err(FrontendError::UnsupportedFeature {
                        feature: "shared composite types",
                        offset,
                    });
                }
                if composite.descriptor_idx.is_some() || composite.describes_idx.is_some() {
                    return Err(FrontendError::UnsupportedFeature {
                        feature: "custom type descriptors",
                        offset,
                    });
                }

                let supertype = subtype
                    .supertype_idx
                    .map(|index| context.type_index(index, offset))
                    .transpose()?;
                let composite = match &composite.inner {
                    CompositeInnerType::Func(function) => {
                        ir::CompositeType::Function(context.function_type(function, offset)?)
                    }
                    CompositeInnerType::Struct(structure) => ir::CompositeType::Struct(
                        structure
                            .fields
                            .iter()
                            .map(|field| context.field_type(*field, offset))
                            .collect::<Result<_, _>>()?,
                    ),
                    CompositeInnerType::Array(array) => {
                        ir::CompositeType::Array(context.field_type(array.0, offset)?)
                    }
                    CompositeInnerType::Cont(_) => {
                        return Err(FrontendError::UnsupportedFeature {
                            feature: "stack switching continuation types",
                            offset,
                        });
                    }
                };

                self.program.types.push(ir::TypeDefinition {
                    canonical_alias: None,
                    final_: subtype.is_final,
                    supertype,
                    composite,
                    source: point_source(offset),
                });
                type_ids.push(type_id);
            }

            self.program.rec_groups.push(ir::RecGroup {
                types: type_ids,
                source: group_source,
            });
        }
        Ok(())
    }

    fn lower_imports(
        &mut self,
        reader: wasmparser::ImportSectionReader<'_>,
    ) -> Result<(), FrontendError> {
        for import in reader.into_imports_with_offsets() {
            let (offset, import) = import?;
            let import_id = ir::ImportId(self.program.imports.len() as u32);
            let origin = ir::EntityOrigin::Imported(import_id);
            let source = point_source(offset);
            let item = match import.ty {
                TypeRef::Func(type_index) => {
                    let ty = ir::TypeId(type_index);
                    let signature = self.function_signature(ty, offset)?.clone();
                    let function = ir::FunctionId(self.program.functions.len() as u32);
                    self.program.functions.push(ir::Function {
                        wasm_index: function.0,
                        ty,
                        origin,
                        locals: signature.params,
                        body: None,
                        source,
                    });
                    ir::ImportItem::Function(function)
                }
                TypeRef::FuncExact(_) => {
                    return Err(FrontendError::UnsupportedFeature {
                        feature: "exact function imports",
                        offset,
                    });
                }
                TypeRef::Table(ty) => {
                    let table = ir::TableId(self.program.tables.len() as u32);
                    self.program.tables.push(ir::Table {
                        ty: lower_table_type(ty, offset)?,
                        origin,
                        initializer: None,
                        source,
                    });
                    ir::ImportItem::Table(table)
                }
                TypeRef::Memory(ty) => {
                    let memory = ir::MemoryId(self.program.memories.len() as u32);
                    self.program.memories.push(ir::Memory {
                        ty: lower_memory_type(ty, offset)?,
                        origin,
                        source,
                    });
                    ir::ImportItem::Memory(memory)
                }
                TypeRef::Global(ty) => {
                    let global = ir::GlobalId(self.program.globals.len() as u32);
                    self.program.globals.push(ir::Global {
                        ty: lower_global_type(ty, offset)?,
                        origin,
                        initializer: None,
                        source,
                    });
                    ir::ImportItem::Global(global)
                }
                TypeRef::Tag(ty) => {
                    let tag = ir::TagId(self.program.tags.len() as u32);
                    self.program.tags.push(ir::Tag {
                        ty: ir::TagType {
                            signature: ir::TypeId(ty.func_type_idx),
                        },
                        origin,
                        source,
                    });
                    ir::ImportItem::Tag(tag)
                }
            };

            self.program.imports.push(ir::Import {
                module: import.module.to_owned(),
                name: import.name.to_owned(),
                item,
                source,
            });
        }
        self.next_code_function = self.program.functions.len();
        Ok(())
    }

    fn lower_function_declarations(
        &mut self,
        reader: wasmparser::FunctionSectionReader<'_>,
    ) -> Result<(), FrontendError> {
        for declaration in reader.into_iter_with_offsets() {
            let (offset, type_index) = declaration?;
            let ty = ir::TypeId(type_index);
            let signature = self.function_signature(ty, offset)?.clone();
            let function = ir::FunctionId(self.program.functions.len() as u32);
            self.program.functions.push(ir::Function {
                wasm_index: function.0,
                ty,
                origin: ir::EntityOrigin::Defined,
                locals: signature.params,
                body: None,
                source: point_source(offset),
            });
        }
        Ok(())
    }

    fn lower_tables(
        &mut self,
        reader: wasmparser::TableSectionReader<'_>,
    ) -> Result<(), FrontendError> {
        for table in reader.into_iter_with_offsets() {
            let (offset, table) = table?;
            let ty = lower_table_type(table.ty, offset)?;
            let initializer = match table.init {
                TableInit::RefNull => None,
                TableInit::Expr(expression) => Some(self.lower_const_expr(expression)?),
            };
            self.program.tables.push(ir::Table {
                ty,
                origin: ir::EntityOrigin::Defined,
                initializer,
                source: point_source(offset),
            });
        }
        Ok(())
    }

    fn lower_memories(
        &mut self,
        reader: wasmparser::MemorySectionReader<'_>,
    ) -> Result<(), FrontendError> {
        for memory in reader.into_iter_with_offsets() {
            let (offset, memory) = memory?;
            self.program.memories.push(ir::Memory {
                ty: lower_memory_type(memory, offset)?,
                origin: ir::EntityOrigin::Defined,
                source: point_source(offset),
            });
        }
        Ok(())
    }

    fn lower_tags(
        &mut self,
        reader: wasmparser::TagSectionReader<'_>,
    ) -> Result<(), FrontendError> {
        for tag in reader.into_iter_with_offsets() {
            let (offset, tag) = tag?;
            self.program.tags.push(ir::Tag {
                ty: ir::TagType {
                    signature: ir::TypeId(tag.func_type_idx),
                },
                origin: ir::EntityOrigin::Defined,
                source: point_source(offset),
            });
        }
        Ok(())
    }

    fn lower_globals(
        &mut self,
        reader: wasmparser::GlobalSectionReader<'_>,
    ) -> Result<(), FrontendError> {
        for global in reader.into_iter_with_offsets() {
            let (offset, global) = global?;
            let ty = lower_global_type(global.ty, offset)?;
            let initializer = self.lower_const_expr(global.init_expr)?;
            self.program.globals.push(ir::Global {
                ty,
                origin: ir::EntityOrigin::Defined,
                initializer: Some(initializer),
                source: point_source(offset),
            });
        }
        Ok(())
    }

    fn lower_exports(
        &mut self,
        reader: wasmparser::ExportSectionReader<'_>,
    ) -> Result<(), FrontendError> {
        for export in reader.into_iter_with_offsets() {
            let (offset, export) = export?;
            let item = match export.kind {
                ExternalKind::Func => ir::ExportItem::Function(ir::FunctionId(export.index)),
                ExternalKind::Table => ir::ExportItem::Table(ir::TableId(export.index)),
                ExternalKind::Memory => ir::ExportItem::Memory(ir::MemoryId(export.index)),
                ExternalKind::Global => ir::ExportItem::Global(ir::GlobalId(export.index)),
                ExternalKind::Tag => ir::ExportItem::Tag(ir::TagId(export.index)),
                ExternalKind::FuncExact => {
                    return Err(FrontendError::UnsupportedFeature {
                        feature: "exact function exports",
                        offset,
                    });
                }
            };
            self.program.exports.push(ir::Export {
                name: export.name.to_owned(),
                item,
                source: point_source(offset),
            });
        }
        Ok(())
    }

    fn lower_elements(
        &mut self,
        reader: wasmparser::ElementSectionReader<'_>,
    ) -> Result<(), FrontendError> {
        for element in reader {
            let element = element?;
            let source = source_span(element.range.clone());
            let (ty, items) = match element.items {
                ElementItems::Functions(functions) => {
                    let items = functions
                        .into_iter()
                        .map(|function| {
                            function
                                .map(|index| ir::ElementItem::Function(ir::FunctionId(index)))
                                .map_err(FrontendError::from)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    (
                        ir::RefType {
                            nullable: true,
                            heap: ir::HeapType::Func,
                        },
                        items,
                    )
                }
                ElementItems::Expressions(reference, expressions) => {
                    let ty = lower_ref_type(reference, TypeContext::module(), element.range.start)?;
                    let items = expressions
                        .into_iter()
                        .map(|expression| {
                            self.lower_const_expr(expression?)
                                .map(ir::ElementItem::Expression)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    (ty, items)
                }
            };
            let mode = match element.kind {
                ElementKind::Passive => ir::ElementMode::Passive,
                ElementKind::Declared => ir::ElementMode::Declarative,
                ElementKind::Active {
                    table_index,
                    offset_expr,
                } => ir::ElementMode::Active {
                    table: ir::TableId(table_index.unwrap_or(0)),
                    offset: self.lower_const_expr(offset_expr)?,
                },
            };
            self.program.elements.push(ir::Element {
                ty,
                mode,
                items,
                source,
            });
        }
        Ok(())
    }

    fn lower_data(
        &mut self,
        reader: wasmparser::DataSectionReader<'_>,
    ) -> Result<(), FrontendError> {
        for data in reader {
            let data = data?;
            let source = source_span(data.range.clone());
            let mode = match data.kind {
                DataKind::Passive => ir::DataMode::Passive,
                DataKind::Active {
                    memory_index,
                    offset_expr,
                } => ir::DataMode::Active {
                    memory: ir::MemoryId(memory_index),
                    offset: self.lower_const_expr(offset_expr)?,
                },
            };
            self.program.data.push(ir::DataSegment {
                mode,
                bytes: data.data.to_vec(),
                source,
            });
        }
        Ok(())
    }

    fn lower_code_entry(
        &mut self,
        body: wasmparser::FunctionBody<'_>,
        function_to_validate: FuncToValidate<ValidatorResources>,
        allocations: FuncValidatorAllocations,
    ) -> Result<FuncValidatorAllocations, FrontendError> {
        let function_index = self.next_code_function as u32;
        let body_range = body.range();
        let function = self
            .program
            .functions
            .get(self.next_code_function)
            .ok_or(FrontendError::UnexpectedFunctionBody { function_index })?;
        if !matches!(function.origin, ir::EntityOrigin::Defined) {
            return Err(FrontendError::UnexpectedFunctionBody { function_index });
        }
        let signature = self
            .function_signature(function.ty, body_range.start)?
            .clone();
        let mut validator = function_to_validate.into_validator(allocations);
        let mut locals = signature.params.clone();
        // The validator sees every declaration before it is materialized, so
        // a count beyond the locals limit is rejected without allocating.
        let mut declarations = body.get_locals_reader()?;
        for _ in 0..declarations.get_count() {
            let offset = declarations.original_position();
            let (count, ty) = declarations.read()?;
            validator.define_locals(offset, count, ty)?;
            let ty = lower_value_type(ty, TypeContext::module(), offset)?;
            locals.extend(std::iter::repeat(ty).take(count as usize));
        }
        let (lowered, allocations) = lower_function_body(
            function_index,
            body,
            validator,
            &signature,
            &locals,
            &self.program.types,
            &self.program.tags,
            &self.canonical_types,
        )?;

        let function = &mut self.program.functions[self.next_code_function];
        function.locals = locals;
        function.body = Some(lowered);
        function.source = source_span(body_range);
        self.next_code_function += 1;
        Ok(allocations)
    }

    fn lower_const_expr(
        &self,
        expression: wasmparser::ConstExpr<'_>,
    ) -> Result<ir::ConstExpr, FrontendError> {
        let range = expression.get_binary_reader().range();
        let mut reader = expression.get_operators_reader();
        let mut instructions = Vec::new();
        let mut stack = Vec::new();
        let mut ordinal = 0;

        while !reader.eof() {
            let (operator, offset) = reader.read_with_offset()?;
            let source = ir::SourceInfo::new(
                ir::ByteSpan::new(offset, reader.original_position()),
                ordinal,
            );
            ordinal += 1;
            let operation = match operator {
                Operator::End => break,
                Operator::I32Const { value } => {
                    ir::Operation::core(CoreOpcode::I32Const, vec![], vec![ir::ValueType::I32])
                        .with_immediates(vec![ir::Immediate::S32(value)])
                }
                Operator::I64Const { value } => {
                    ir::Operation::core(CoreOpcode::I64Const, vec![], vec![ir::ValueType::I64])
                        .with_immediates(vec![ir::Immediate::S64(value)])
                }
                Operator::F32Const { value } => {
                    ir::Operation::core(CoreOpcode::F32Const, vec![], vec![ir::ValueType::F32])
                        .with_immediates(vec![ir::Immediate::F32(value.bits())])
                }
                Operator::F64Const { value } => {
                    ir::Operation::core(CoreOpcode::F64Const, vec![], vec![ir::ValueType::F64])
                        .with_immediates(vec![ir::Immediate::F64(value.bits())])
                }
                Operator::V128Const { value } => {
                    ir::Operation::core(CoreOpcode::V128Const, vec![], vec![ir::ValueType::V128])
                        .with_immediates(vec![ir::Immediate::V128(*value.bytes())])
                }
                Operator::GlobalGet { global_index } => {
                    let global = self.program.globals.get(global_index as usize).ok_or(
                        FrontendError::InvalidEntityIndex {
                            kind: "global",
                            index: global_index,
                            offset,
                        },
                    )?;
                    ir::Operation::core(
                        CoreOpcode::GlobalGet,
                        vec![],
                        vec![global.ty.value.clone()],
                    )
                    .with_immediates(vec![ir::Immediate::Global(ir::GlobalId(global_index))])
                }
                Operator::RefNull { hty } => {
                    let heap = lower_heap_type(hty, TypeContext::module(), offset)?;
                    let ty = ir::ValueType::Ref(ir::RefType {
                        nullable: true,
                        heap: heap.clone(),
                    });
                    ir::Operation::core(CoreOpcode::RefNull, vec![], vec![ty])
                        .with_immediates(vec![ir::Immediate::HeapType(heap)])
                }
                Operator::RefFunc { function_index } => {
                    let function = self.program.functions.get(function_index as usize).ok_or(
                        FrontendError::InvalidEntityIndex {
                            kind: "function",
                            index: function_index,
                            offset,
                        },
                    )?;
                    let ty = ir::ValueType::Ref(ir::RefType {
                        nullable: false,
                        heap: ir::HeapType::Concrete(function.ty),
                    });
                    ir::Operation::core(CoreOpcode::RefFunc, vec![], vec![ty]).with_immediates(
                        vec![ir::Immediate::Function(ir::FunctionId(function_index))],
                    )
                }
                Operator::StructNew { struct_type_index } => {
                    let parameters = self.const_struct_parameters(struct_type_index, offset)?;
                    let result = concrete_gc_ref(struct_type_index);
                    ir::Operation::core(CoreOpcode::StructNew, parameters, vec![result])
                        .with_immediates(vec![ir::Immediate::Type(ir::TypeId(struct_type_index))])
                }
                Operator::StructNewDefault { struct_type_index } => {
                    self.const_struct_parameters(struct_type_index, offset)?;
                    let result = concrete_gc_ref(struct_type_index);
                    ir::Operation::core(CoreOpcode::StructNewDefault, vec![], vec![result])
                        .with_immediates(vec![ir::Immediate::Type(ir::TypeId(struct_type_index))])
                }
                Operator::ArrayNew { array_type_index } => {
                    let element = self.const_array_element(array_type_index, offset)?;
                    let result = concrete_gc_ref(array_type_index);
                    ir::Operation::core(
                        CoreOpcode::ArrayNew,
                        vec![element, ir::ValueType::I32],
                        vec![result],
                    )
                    .with_immediates(vec![ir::Immediate::Type(ir::TypeId(array_type_index))])
                }
                Operator::ArrayNewDefault { array_type_index } => {
                    self.const_array_element(array_type_index, offset)?;
                    let result = concrete_gc_ref(array_type_index);
                    ir::Operation::core(
                        CoreOpcode::ArrayNewDefault,
                        vec![ir::ValueType::I32],
                        vec![result],
                    )
                    .with_immediates(vec![ir::Immediate::Type(ir::TypeId(array_type_index))])
                }
                Operator::ArrayNewFixed {
                    array_type_index,
                    array_size,
                } => {
                    let element = self.const_array_element(array_type_index, offset)?;
                    if stack.len() < array_size as usize {
                        return Err(lowering_invariant(
                            None,
                            offset,
                            "operation operands",
                            format!(
                                "array.new_fixed with {array_size} elements underflows the operand stack"
                            ),
                        ));
                    }
                    let result = concrete_gc_ref(array_type_index);
                    ir::Operation::core(
                        CoreOpcode::ArrayNewFixed,
                        vec![element; array_size as usize],
                        vec![result],
                    )
                    .with_immediates(vec![
                        ir::Immediate::Type(ir::TypeId(array_type_index)),
                        ir::Immediate::U32(array_size),
                    ])
                }
                Operator::RefI31 => ir::Operation::core(
                    CoreOpcode::RefI31,
                    vec![ir::ValueType::I32],
                    vec![ir::ValueType::Ref(ir::RefType {
                        nullable: false,
                        heap: ir::HeapType::I31,
                    })],
                ),
                Operator::AnyConvertExtern => self.const_reference_conversion(
                    CoreOpcode::AnyConvertExtern,
                    &stack,
                    ir::HeapType::Extern,
                    ir::HeapType::Any,
                    offset,
                )?,
                Operator::ExternConvertAny => self.const_reference_conversion(
                    CoreOpcode::ExternConvertAny,
                    &stack,
                    ir::HeapType::Any,
                    ir::HeapType::Extern,
                    offset,
                )?,
                Operator::I32Add => binary_const_operation(CoreOpcode::I32Add, ir::ValueType::I32),
                Operator::I32Sub => binary_const_operation(CoreOpcode::I32Sub, ir::ValueType::I32),
                Operator::I32Mul => binary_const_operation(CoreOpcode::I32Mul, ir::ValueType::I32),
                Operator::I64Add => binary_const_operation(CoreOpcode::I64Add, ir::ValueType::I64),
                Operator::I64Sub => binary_const_operation(CoreOpcode::I64Sub, ir::ValueType::I64),
                Operator::I64Mul => binary_const_operation(CoreOpcode::I64Mul, ir::ValueType::I64),
                unsupported => {
                    return Err(FrontendError::UnsupportedConstOperator {
                        offset,
                        operator: format!("{unsupported:?}"),
                    });
                }
            };
            apply_stack_signature(
                &mut stack,
                &operation.signature,
                &self.program.types,
                None,
                offset,
                operation.mnemonic(),
            )?;
            instructions.push(ir::ConstInstruction { operation, source });
        }

        let result_type = match stack.as_slice() {
            [result] => result.clone(),
            _ => {
                return Err(FrontendError::LoweringInvariant {
                    subject: "module expression".to_owned(),
                    offset: range.start,
                    operation: "constant expression result type",
                    detail: format!("left {stack:?}, expected exactly one result"),
                });
            }
        };
        Ok(ir::ConstExpr {
            instructions,
            // Preserve the expression's most precise type. The module-level
            // verifier checks that it is a subtype of the contextual type.
            result_type,
            source: source_span(range),
        })
    }

    fn const_struct_parameters(
        &self,
        type_index: u32,
        offset: u64,
    ) -> Result<Vec<ir::ValueType>, FrontendError> {
        match self.program.types.get(type_index as usize) {
            Some(ir::TypeDefinition {
                composite: ir::CompositeType::Struct(fields),
                ..
            }) => Ok(fields
                .iter()
                .map(|field| field.storage.stack_type())
                .collect()),
            Some(_) => Err(lowering_invariant(
                None,
                offset,
                "struct allocation type",
                format!("type {type_index} is not a struct"),
            )),
            None => Err(FrontendError::InvalidEntityIndex {
                kind: "type",
                index: type_index,
                offset,
            }),
        }
    }

    fn const_array_element(
        &self,
        type_index: u32,
        offset: u64,
    ) -> Result<ir::ValueType, FrontendError> {
        match self.program.types.get(type_index as usize) {
            Some(ir::TypeDefinition {
                composite: ir::CompositeType::Array(field),
                ..
            }) => Ok(field.storage.stack_type()),
            Some(_) => Err(lowering_invariant(
                None,
                offset,
                "array allocation type",
                format!("type {type_index} is not an array"),
            )),
            None => Err(FrontendError::InvalidEntityIndex {
                kind: "type",
                index: type_index,
                offset,
            }),
        }
    }

    fn const_reference_conversion(
        &self,
        opcode: CoreOpcode,
        stack: &[ir::ValueType],
        expected_heap: ir::HeapType,
        result_heap: ir::HeapType,
        offset: u64,
    ) -> Result<ir::Operation, FrontendError> {
        let Some(ir::ValueType::Ref(input)) = stack.last() else {
            return Err(lowering_invariant(
                None,
                offset,
                "reference conversion operand",
                format!("{} requires a reference operand", opcode.mnemonic()),
            ));
        };
        if !ir::is_heap_subtype(&self.program.types, &input.heap, &expected_heap) {
            return Err(lowering_invariant(
                None,
                offset,
                "reference conversion operand",
                format!(
                    "{} received heap type {}, expected a subtype of {expected_heap}",
                    opcode.mnemonic(),
                    input.heap
                ),
            ));
        }

        let parameter = ir::ValueType::Ref(input.clone());
        let result = ir::ValueType::Ref(ir::RefType {
            nullable: input.nullable,
            heap: result_heap,
        });
        Ok(ir::Operation::core(opcode, vec![parameter], vec![result]))
    }

    fn function_signature(
        &self,
        ty: ir::TypeId,
        offset: u64,
    ) -> Result<&ir::FunctionType, FrontendError> {
        match self.program.types.get(ty.index()) {
            Some(ir::TypeDefinition {
                composite: ir::CompositeType::Function(signature),
                ..
            }) => Ok(signature),
            _ => Err(FrontendError::InvalidFunctionType {
                type_index: ty.0,
                offset,
            }),
        }
    }
}

#[derive(Clone, Copy)]
struct TypeContext {
    group_base: Option<u32>,
}

impl TypeContext {
    const fn module() -> Self {
        Self { group_base: None }
    }

    fn type_index(self, index: PackedIndex, offset: u64) -> Result<ir::TypeId, FrontendError> {
        self.unpacked_type_index(index.unpack(), offset)
    }

    fn unpacked_type_index(
        self,
        index: UnpackedIndex,
        offset: u64,
    ) -> Result<ir::TypeId, FrontendError> {
        if let Some(index) = index.as_module_index() {
            return Ok(ir::TypeId(index));
        }
        if let (Some(base), Some(index)) = (self.group_base, index.as_rec_group_index()) {
            return Ok(ir::TypeId(base + index));
        }
        Err(FrontendError::UnsupportedTypeIndex {
            index: format!("{index:?}"),
            offset,
        })
    }

    fn function_type(
        self,
        function: &wasmparser::FuncType,
        offset: u64,
    ) -> Result<ir::FunctionType, FrontendError> {
        Ok(ir::FunctionType {
            params: function
                .params()
                .iter()
                .copied()
                .map(|ty| lower_value_type(ty, self, offset))
                .collect::<Result<_, _>>()?,
            results: function
                .results()
                .iter()
                .copied()
                .map(|ty| lower_value_type(ty, self, offset))
                .collect::<Result<_, _>>()?,
        })
    }

    fn field_type(
        self,
        field: wasmparser::FieldType,
        offset: u64,
    ) -> Result<ir::FieldType, FrontendError> {
        let storage = match field.element_type {
            WasmStorageType::I8 => ir::StorageType::I8,
            WasmStorageType::I16 => ir::StorageType::I16,
            WasmStorageType::Val(ty) => ir::StorageType::Value(lower_value_type(ty, self, offset)?),
        };
        Ok(ir::FieldType {
            storage,
            mutable: field.mutable,
        })
    }
}

fn lower_value_type(
    ty: ValType,
    context: TypeContext,
    offset: u64,
) -> Result<ir::ValueType, FrontendError> {
    Ok(match ty {
        ValType::I32 => ir::ValueType::I32,
        ValType::I64 => ir::ValueType::I64,
        ValType::F32 => ir::ValueType::F32,
        ValType::F64 => ir::ValueType::F64,
        ValType::V128 => ir::ValueType::V128,
        ValType::Ref(reference) => ir::ValueType::Ref(lower_ref_type(reference, context, offset)?),
    })
}

fn lower_ref_type(
    ty: WasmRefType,
    context: TypeContext,
    offset: u64,
) -> Result<ir::RefType, FrontendError> {
    Ok(ir::RefType {
        nullable: ty.is_nullable(),
        heap: lower_heap_type(ty.heap_type(), context, offset)?,
    })
}

fn lower_heap_type(
    ty: WasmHeapType,
    context: TypeContext,
    offset: u64,
) -> Result<ir::HeapType, FrontendError> {
    match ty {
        WasmHeapType::Concrete(index) => Ok(ir::HeapType::Concrete(
            context.unpacked_type_index(index, offset)?,
        )),
        WasmHeapType::Exact(_) => Err(FrontendError::UnsupportedFeature {
            feature: "exact reference types",
            offset,
        }),
        WasmHeapType::Abstract { shared: true, .. } => Err(FrontendError::UnsupportedFeature {
            feature: "shared reference types",
            offset,
        }),
        WasmHeapType::Abstract { shared: false, ty } => Ok(match ty {
            AbstractHeapType::Any => ir::HeapType::Any,
            AbstractHeapType::Eq => ir::HeapType::Eq,
            AbstractHeapType::I31 => ir::HeapType::I31,
            AbstractHeapType::Struct => ir::HeapType::Struct,
            AbstractHeapType::Array => ir::HeapType::Array,
            AbstractHeapType::None => ir::HeapType::None,
            AbstractHeapType::Func => ir::HeapType::Func,
            AbstractHeapType::NoFunc => ir::HeapType::NoFunc,
            AbstractHeapType::Extern => ir::HeapType::Extern,
            AbstractHeapType::NoExtern => ir::HeapType::NoExtern,
            AbstractHeapType::Exn => ir::HeapType::Exn,
            AbstractHeapType::NoExn => ir::HeapType::NoExn,
            AbstractHeapType::Cont | AbstractHeapType::NoCont => {
                return Err(FrontendError::UnsupportedFeature {
                    feature: "stack switching continuation references",
                    offset,
                });
            }
        }),
    }
}

fn lower_validated_stack_types(
    types: Vec<Option<ValType>>,
    canonical_types: &BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
    offset: u64,
    operation: &'static str,
) -> Result<Vec<ir::ValueType>, FrontendError> {
    types
        .into_iter()
        .map(|ty| {
            let ty = ty.ok_or_else(|| {
                lowering_invariant(
                    None,
                    offset,
                    operation,
                    "validator reported a polymorphic stack value in reachable code",
                )
            })?;
            lower_validated_value_type(ty, canonical_types, offset)
        })
        .collect()
}

fn lower_validated_value_type(
    ty: ValType,
    canonical_types: &BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
    offset: u64,
) -> Result<ir::ValueType, FrontendError> {
    match ty {
        ValType::Ref(reference) => Ok(ir::ValueType::Ref(ir::RefType {
            nullable: reference.is_nullable(),
            heap: lower_validated_heap_type(reference.heap_type(), canonical_types, offset)?,
        })),
        _ => lower_value_type(ty, TypeContext::module(), offset),
    }
}

fn lower_validated_heap_type(
    ty: WasmHeapType,
    canonical_types: &BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
    offset: u64,
) -> Result<ir::HeapType, FrontendError> {
    match ty {
        WasmHeapType::Concrete(UnpackedIndex::Id(id)) => canonical_types
            .get(&id)
            .copied()
            .map(ir::HeapType::Concrete)
            .ok_or_else(|| FrontendError::UnsupportedTypeIndex {
                index: format!("canonical {id:?}"),
                offset,
            }),
        _ => lower_heap_type(ty, TypeContext::module(), offset),
    }
}

trait AppendImmediate {
    fn append(
        self,
        name: &'static str,
        offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError>;
}

fn append_immediate<T: AppendImmediate>(
    output: &mut Vec<ir::Immediate>,
    name: &'static str,
    value: T,
    offset: u64,
) -> Result<(), FrontendError> {
    value.append(name, offset, output)
}

impl AppendImmediate for u32 {
    fn append(
        self,
        name: &'static str,
        _offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        let immediate = if name == "function_index" {
            ir::Immediate::Function(ir::FunctionId(self))
        } else if name == "local_index" {
            ir::Immediate::Local(ir::LocalId(self))
        } else if name == "global_index" {
            ir::Immediate::Global(ir::GlobalId(self))
        } else if name == "tag_index" || name == "tag" {
            ir::Immediate::Tag(ir::TagId(self))
        } else if name == "elem_index"
            || name == "array_elem_index"
            || name == "array_elem_index_dst"
            || name == "array_elem_index_src"
        {
            ir::Immediate::Element(ir::ElementId(self))
        } else if name == "data_index"
            || name == "array_data_index"
            || name == "array_data_index_dst"
            || name == "array_data_index_src"
        {
            ir::Immediate::Data(ir::DataId(self))
        } else if name == "table"
            || name == "table_index"
            || name == "dst_table"
            || name == "src_table"
        {
            ir::Immediate::Table(ir::TableId(self))
        } else if name == "mem" || name == "dst_mem" || name == "src_mem" {
            ir::Immediate::Memory(ir::MemoryId(self))
        } else if name.contains("type_index") {
            ir::Immediate::Type(ir::TypeId(self))
        } else {
            ir::Immediate::U32(self)
        };
        output.push(immediate);
        Ok(())
    }
}

impl AppendImmediate for u8 {
    fn append(
        self,
        _name: &'static str,
        _offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::Lane(self));
        Ok(())
    }
}

impl AppendImmediate for i32 {
    fn append(
        self,
        _name: &'static str,
        _offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::S32(self));
        Ok(())
    }
}

impl AppendImmediate for i64 {
    fn append(
        self,
        _name: &'static str,
        _offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::S64(self));
        Ok(())
    }
}

impl AppendImmediate for wasmparser::Ieee32 {
    fn append(
        self,
        _name: &'static str,
        _offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::F32(self.bits()));
        Ok(())
    }
}

impl AppendImmediate for wasmparser::Ieee64 {
    fn append(
        self,
        _name: &'static str,
        _offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::F64(self.bits()));
        Ok(())
    }
}

impl AppendImmediate for wasmparser::V128 {
    fn append(
        self,
        _name: &'static str,
        _offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::V128(*self.bytes()));
        Ok(())
    }
}

impl AppendImmediate for [u8; 16] {
    fn append(
        self,
        _name: &'static str,
        _offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::Bytes(self.to_vec()));
        Ok(())
    }
}

impl AppendImmediate for wasmparser::MemArg {
    fn append(
        self,
        _name: &'static str,
        _offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::MemoryArgument(ir::MemoryArgument {
            memory: ir::MemoryId(self.memory),
            offset: self.offset,
            alignment_log2: self.align,
        }));
        Ok(())
    }
}

impl AppendImmediate for ValType {
    fn append(
        self,
        _name: &'static str,
        offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::ValueType(lower_value_type(
            self,
            TypeContext::module(),
            offset,
        )?));
        Ok(())
    }
}

impl AppendImmediate for Vec<ValType> {
    fn append(
        self,
        name: &'static str,
        offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::U32(self.len() as u32));
        for ty in self {
            ty.append(name, offset, output)?;
        }
        Ok(())
    }
}

impl AppendImmediate for WasmHeapType {
    fn append(
        self,
        _name: &'static str,
        offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::HeapType(lower_heap_type(
            self,
            TypeContext::module(),
            offset,
        )?));
        Ok(())
    }
}

impl AppendImmediate for WasmRefType {
    fn append(
        self,
        _name: &'static str,
        offset: u64,
        output: &mut Vec<ir::Immediate>,
    ) -> Result<(), FrontendError> {
        output.push(ir::Immediate::ValueType(ir::ValueType::Ref(
            lower_ref_type(self, TypeContext::module(), offset)?,
        )));
        Ok(())
    }
}

macro_rules! debug_immediate {
    ($ty:ty) => {
        impl AppendImmediate for $ty {
            fn append(
                self,
                _name: &'static str,
                _offset: u64,
                output: &mut Vec<ir::Immediate>,
            ) -> Result<(), FrontendError> {
                output.push(ir::Immediate::Bytes(format!("{self:?}").into_bytes()));
                Ok(())
            }
        }
    };
}

debug_immediate!(BlockType);
debug_immediate!(wasmparser::BrTable<'_>);
debug_immediate!(wasmparser::Ordering);
debug_immediate!(wasmparser::ResumeTable);
debug_immediate!(wasmparser::TryTable);

fn collect_operator_immediates(
    operator: &Operator<'_>,
    offset: u64,
) -> Result<Vec<ir::Immediate>, FrontendError> {
    macro_rules! collect {
        ($( @$proposal:ident $op:ident $({ $($arg:ident: $argty:ty),* })? => $visit:ident ($($ann:tt)*) )*) => {
            match operator.clone() {
                $(
                    Operator::$op $({ $($arg),* })? => {
                        #[allow(unused_mut)]
                        let mut output = Vec::new();
                        $(
                            $(append_immediate(&mut output, stringify!($arg), $arg, offset)?;)*
                        )?
                        Ok(output)
                    }
                )*
                _ => Err(FrontendError::UnsupportedOperator {
                    function_index: u32::MAX,
                    offset,
                    operator: format!("{operator:?}"),
                }),
            }
        };
    }
    wasmparser::for_each_operator!(collect)
}

fn lower_table_type(
    ty: wasmparser::TableType,
    offset: u64,
) -> Result<ir::TableType, FrontendError> {
    if ty.shared {
        return Err(FrontendError::UnsupportedFeature {
            feature: "shared tables",
            offset,
        });
    }
    Ok(ir::TableType {
        element: lower_ref_type(ty.element_type, TypeContext::module(), offset)?,
        limits: ir::Limits {
            min: ty.initial,
            max: ty.maximum,
        },
        address_type: if ty.table64 {
            ir::AddressType::I64
        } else {
            ir::AddressType::I32
        },
    })
}

fn lower_memory_type(
    ty: wasmparser::MemoryType,
    offset: u64,
) -> Result<ir::MemoryType, FrontendError> {
    if ty.shared {
        return Err(FrontendError::UnsupportedFeature {
            feature: "threads/shared memories",
            offset,
        });
    }
    if ty.page_size_log2.is_some() {
        return Err(FrontendError::UnsupportedFeature {
            feature: "custom memory page sizes",
            offset,
        });
    }
    Ok(ir::MemoryType {
        limits: ir::Limits {
            min: ty.initial,
            max: ty.maximum,
        },
        address_type: if ty.memory64 {
            ir::AddressType::I64
        } else {
            ir::AddressType::I32
        },
    })
}

fn lower_global_type(
    ty: wasmparser::GlobalType,
    offset: u64,
) -> Result<ir::GlobalType, FrontendError> {
    if ty.shared {
        return Err(FrontendError::UnsupportedFeature {
            feature: "shared globals",
            offset,
        });
    }
    Ok(ir::GlobalType {
        value: lower_value_type(ty.content_type, TypeContext::module(), offset)?,
        mutable: ty.mutable,
    })
}

fn lower_function_body(
    function_index: u32,
    body: wasmparser::FunctionBody<'_>,
    mut validator: FuncValidator<ValidatorResources>,
    signature: &ir::FunctionType,
    locals: &[ir::ValueType],
    types: &[ir::TypeDefinition],
    tags: &[ir::Tag],
    canonical_types: &BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
) -> Result<(ir::FunctionBody, FuncValidatorAllocations), FrontendError> {
    let body_range = body.range();
    let mut reader = body.get_operators_reader()?;
    let mut lowerer = FunctionBodyLowerer::new(
        function_index,
        signature,
        locals,
        types,
        tags,
        body_range.clone(),
    )?;
    let mut ordinal = 0;
    let mut saw_function_end = false;

    while !reader.eof() {
        let (operator, offset) = reader.read_with_offset()?;
        let source = ir::SourceInfo::new(
            ir::ByteSpan::new(offset, reader.original_position()),
            ordinal,
        );
        ordinal += 1;

        let (parameter_count, result_count) =
            operator.operator_arity(&validator).ok_or_else(|| {
                lowering_invariant(
                    Some(function_index),
                    offset,
                    "operator arity",
                    format!("could not derive arity for {operator:?}"),
                )
            })?;
        let parameters = validated_stack_types(&validator, parameter_count as usize);
        validator.op(offset, &operator)?;
        let results = validated_stack_types(&validator, result_count as usize);
        let validated = ValidatedOperatorSignature {
            parameters,
            results,
        };

        if lowerer.lower_operator(operator, validated, canonical_types, offset, source)? {
            saw_function_end = true;
            break;
        }
    }

    reader.finish()?;

    if !saw_function_end {
        return Err(FrontendError::MissingFunctionTerminator {
            function_index,
            offset: body_range.end,
        });
    }

    let body = lowerer.finish()?;
    Ok((body, validator.into_allocations()))
}

#[derive(Clone, Debug)]
struct ValidatedOperatorSignature {
    parameters: Vec<Option<ValType>>,
    results: Vec<Option<ValType>>,
}

enum TailCallTarget {
    Direct(ir::FunctionId),
    Indirect { ty: ir::TypeId, table: ir::TableId },
    Reference { ty: ir::TypeId },
}

#[derive(Clone, Copy)]
enum CastBranchKind {
    Success,
    Failure,
}

impl CastBranchKind {
    const fn mnemonic(self) -> &'static str {
        match self {
            Self::Success => "br_on_cast",
            Self::Failure => "br_on_cast_fail",
        }
    }
}

/// The validator's types for the top `count` operands, oldest first.
///
/// `count` is an operator's arity, which for `array.new_fixed` is an
/// unvalidated immediate, so it is clamped to the operand stack height and no
/// allocation is proportional to the immediate. A valid operator in reachable
/// code never needs more operands than are present, and the lowerer discards
/// the signatures of unreachable code.
fn validated_stack_types(
    validator: &FuncValidator<ValidatorResources>,
    count: usize,
) -> Vec<Option<ValType>> {
    let count = count.min(validator.operand_stack_height() as usize);
    (0..count)
        .rev()
        .map(|depth| validator.get_operand_type(depth).flatten())
        .collect()
}

type StackValue = (ir::ValueId, ir::ValueType);

struct PendingBlock {
    id: ir::BlockId,
    region: ir::RegionId,
    parameters: Vec<ir::ValueDefinition>,
    instructions: Vec<ir::Instruction>,
    terminator: Option<ir::Terminator>,
    source: ir::SourceInfo,
}

#[derive(Clone)]
enum ControlKind {
    Function,
    Block {
        region: ir::RegionId,
    },
    Loop {
        region: ir::RegionId,
    },
    If {
        then_region: ir::RegionId,
        else_region: ir::RegionId,
        else_block: ir::BlockId,
        has_else: bool,
    },
    TryTable {
        region: ir::RegionId,
    },
}

#[derive(Clone)]
struct ControlFrame {
    kind: ControlKind,
    signature: ir::FunctionType,
    prefix: Vec<StackValue>,
    label_target: Option<ir::BlockId>,
    continuation: Option<ir::BlockId>,
    parent_region: ir::RegionId,
}

impl ControlFrame {
    fn label_types(&self) -> &[ir::ValueType] {
        match self.kind {
            ControlKind::Loop { .. } => &self.signature.params,
            _ => &self.signature.results,
        }
    }
}

struct FunctionBodyLowerer<'a> {
    function_index: u32,
    signature: &'a ir::FunctionType,
    locals: &'a [ir::ValueType],
    types: &'a [ir::TypeDefinition],
    tags: &'a [ir::Tag],
    body_range: Range<u64>,
    blocks: Vec<PendingBlock>,
    block_reachable: Vec<bool>,
    regions: Vec<ir::Region>,
    stack: Vec<StackValue>,
    control: Vec<ControlFrame>,
    current: ir::BlockId,
    current_region: ir::RegionId,
    reachable: bool,
    current_definitions: BTreeMap<(ir::BlockId, ir::LocalId), ir::ValueId>,
    local_parameters: Vec<Vec<(ir::LocalId, ir::ValueId)>>,
    predecessors: Vec<Vec<ir::BlockId>>,
    sealed: Vec<bool>,
    next_value: u32,
    next_instruction: u32,
}

impl<'a> FunctionBodyLowerer<'a> {
    fn new(
        function_index: u32,
        signature: &'a ir::FunctionType,
        locals: &'a [ir::ValueType],
        types: &'a [ir::TypeDefinition],
        tags: &'a [ir::Tag],
        body_range: Range<u64>,
    ) -> Result<Self, FrontendError> {
        let entry = ir::BlockId(0);
        let root_region = ir::RegionId(0);
        let entry_parameters: Vec<_> = signature
            .params
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, ty)| ir::ValueDefinition::new(ir::ValueId(index as u32), ty))
            .collect();
        let mut current_definitions = BTreeMap::new();
        for (index, parameter) in entry_parameters.iter().enumerate() {
            current_definitions.insert((entry, ir::LocalId(index as u32)), parameter.id);
        }
        let mut lowerer = Self {
            function_index,
            signature,
            locals,
            types,
            tags,
            body_range: body_range.clone(),
            blocks: vec![PendingBlock {
                id: entry,
                region: root_region,
                parameters: entry_parameters,
                instructions: Vec::new(),
                terminator: None,
                source: source_span(body_range.clone()),
            }],
            block_reachable: vec![true],
            regions: vec![ir::Region {
                id: root_region,
                parent: None,
                kind: ir::RegionKind::Function,
                entry,
                source: source_span(body_range),
            }],
            stack: Vec::new(),
            control: vec![ControlFrame {
                kind: ControlKind::Function,
                signature: signature.clone(),
                prefix: Vec::new(),
                label_target: None,
                continuation: None,
                parent_region: root_region,
            }],
            current: entry,
            current_region: root_region,
            reachable: true,
            current_definitions,
            local_parameters: vec![Vec::new()],
            predecessors: vec![Vec::new()],
            sealed: vec![true],
            next_value: signature.params.len() as u32,
            next_instruction: 0,
        };
        lowerer.initialize_default_locals()?;
        Ok(lowerer)
    }

    fn initialize_default_locals(&mut self) -> Result<(), FrontendError> {
        let mut defaults: Vec<(ir::ValueType, ir::ValueId)> = Vec::new();
        for local_index in self.signature.params.len()..self.locals.len() {
            let ty = self.locals[local_index].clone();
            // Non-null references are not defaultable. The validator tracks
            // their definite initialization, so leave them without an entry
            // definition until a local.set/local.tee establishes one.
            if matches!(&ty, ir::ValueType::Ref(reference) if !reference.nullable) {
                continue;
            }
            let value = if let Some((_, value)) = defaults.iter().find(|(cached, _)| cached == &ty)
            {
                *value
            } else {
                let operation = match &ty {
                    ir::ValueType::I32 => ir::Operation::new("i32.const", vec![], vec![ty.clone()])
                        .with_immediates(vec![ir::Immediate::S32(0)]),
                    ir::ValueType::I64 => ir::Operation::new("i64.const", vec![], vec![ty.clone()])
                        .with_immediates(vec![ir::Immediate::S64(0)]),
                    ir::ValueType::F32 => ir::Operation::new("f32.const", vec![], vec![ty.clone()])
                        .with_immediates(vec![ir::Immediate::F32(0)]),
                    ir::ValueType::F64 => ir::Operation::new("f64.const", vec![], vec![ty.clone()])
                        .with_immediates(vec![ir::Immediate::F64(0)]),
                    ir::ValueType::V128 => {
                        ir::Operation::new("v128.const", vec![], vec![ty.clone()])
                            .with_immediates(vec![ir::Immediate::V128([0; 16])])
                    }
                    ir::ValueType::Ref(reference) => {
                        ir::Operation::new("ref.null", vec![], vec![ty.clone()])
                            .with_immediates(vec![ir::Immediate::HeapType(reference.heap.clone())])
                    }
                };
                let result = self
                    .emit_operation(
                        operation,
                        Vec::new(),
                        vec![ty.clone()],
                        ir::SourceInfo::synthetic(),
                    )?
                    .into_iter()
                    .next()
                    .expect("default initializer has one result");
                defaults.push((ty.clone(), result.id));
                result.id
            };
            self.current_definitions
                .insert((ir::BlockId(0), ir::LocalId(local_index as u32)), value);
        }
        Ok(())
    }

    /// Returns true only for the `end` that closes the function itself.
    fn lower_operator(
        &mut self,
        operator: Operator<'_>,
        validated: ValidatedOperatorSignature,
        canonical_types: &BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<bool, FrontendError> {
        match operator {
            Operator::Block { blockty } => {
                self.lower_block(blockty, false, offset, source)?;
            }
            Operator::Loop { blockty } => {
                self.lower_block(blockty, true, offset, source)?;
            }
            Operator::If { blockty } => self.lower_if(blockty, offset, source)?,
            Operator::TryTable { try_table } => {
                self.lower_try_table(try_table, offset, source)?;
            }
            Operator::Else => self.lower_else(offset, source)?,
            Operator::Br { relative_depth } => {
                self.lower_br(relative_depth, offset, source)?;
            }
            Operator::BrIf { relative_depth } => {
                self.lower_br_if(relative_depth, offset, source)?;
            }
            Operator::BrTable { targets } => self.lower_br_table(targets, offset, source)?,
            Operator::LocalGet { local_index } => {
                if self.reachable {
                    let ty = self.locals.get(local_index as usize).cloned().ok_or(
                        FrontendError::InvalidEntityIndex {
                            kind: "local",
                            index: local_index,
                            offset,
                        },
                    )?;
                    let value = self.read_local(ir::LocalId(local_index), self.current)?;
                    self.stack.push((value, ty));
                }
            }
            assignment @ (Operator::LocalSet { local_index }
            | Operator::LocalTee { local_index }) => {
                if self.reachable {
                    let ty = self.locals.get(local_index as usize).cloned().ok_or(
                        FrontendError::InvalidEntityIndex {
                            kind: "local",
                            index: local_index,
                            offset,
                        },
                    )?;
                    let value = self.pop_typed(&ty, offset, "local assignment")?;
                    self.write_local(ir::LocalId(local_index), self.current, value);
                    if matches!(assignment, Operator::LocalTee { .. }) {
                        self.stack.push((value, ty));
                    }
                }
            }
            Operator::Return => self.lower_return(offset, source)?,
            Operator::ReturnCall { function_index } => self.lower_tail_call(
                TailCallTarget::Direct(ir::FunctionId(function_index)),
                validated,
                canonical_types,
                offset,
                source,
            )?,
            Operator::ReturnCallIndirect {
                type_index,
                table_index,
            } => self.lower_tail_call(
                TailCallTarget::Indirect {
                    ty: ir::TypeId(type_index),
                    table: ir::TableId(table_index),
                },
                validated,
                canonical_types,
                offset,
                source,
            )?,
            Operator::ReturnCallRef { type_index } => self.lower_tail_call(
                TailCallTarget::Reference {
                    ty: ir::TypeId(type_index),
                },
                validated,
                canonical_types,
                offset,
                source,
            )?,
            Operator::Throw { tag_index } => self.lower_throw(
                ir::TagId(tag_index),
                validated,
                canonical_types,
                offset,
                source,
            )?,
            Operator::ThrowRef => self.lower_throw_ref(offset, source)?,
            Operator::BrOnNull { relative_depth } => {
                self.lower_br_on_null(relative_depth, validated, canonical_types, offset, source)?
            }
            Operator::BrOnNonNull { relative_depth } => {
                self.lower_br_on_non_null(relative_depth, offset, source)?;
            }
            Operator::BrOnCast {
                relative_depth,
                from_ref_type,
                to_ref_type,
            } => self.lower_br_on_cast(
                CastBranchKind::Success,
                relative_depth,
                from_ref_type,
                to_ref_type,
                validated,
                canonical_types,
                offset,
                source,
            )?,
            Operator::BrOnCastFail {
                relative_depth,
                from_ref_type,
                to_ref_type,
            } => self.lower_br_on_cast(
                CastBranchKind::Failure,
                relative_depth,
                from_ref_type,
                to_ref_type,
                validated,
                canonical_types,
                offset,
                source,
            )?,
            Operator::Unreachable => self.lower_unreachable(source)?,
            Operator::End => return self.lower_end(offset, source),
            unsupported => {
                self.lower_leaf_operator(&unsupported, validated, canonical_types, offset, source)?;
            }
        }
        Ok(false)
    }

    fn lower_block(
        &mut self,
        blockty: BlockType,
        is_loop: bool,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        let signature = self.block_signature(blockty, offset)?;
        let was_reachable = self.reachable;
        let (prefix, arguments) = self.enter_arguments(&signature.params, offset, "block input")?;
        if !was_reachable {
            self.close_dead_current(source)?;
        }

        let parent_region = self.current_region;
        let region_kind = if is_loop {
            ir::RegionKind::Loop
        } else {
            ir::RegionKind::Block
        };
        let (region, entry) = self.new_region_entry(
            parent_region,
            region_kind,
            &signature.params,
            structural_source(source),
        );
        let continuation =
            self.new_block(parent_region, &signature.results, structural_source(source));

        if was_reachable {
            self.terminate_current(
                ir::TerminatorKind::Jump(ir::Edge::new(entry, arguments)),
                source,
            )?;
        }
        if !is_loop {
            self.seal_block(entry)?;
        }

        self.control.push(ControlFrame {
            kind: if is_loop {
                ControlKind::Loop { region }
            } else {
                ControlKind::Block { region }
            },
            signature,
            prefix: prefix.clone(),
            label_target: Some(if is_loop { entry } else { continuation }),
            continuation: Some(continuation),
            parent_region,
        });
        self.activate(entry, prefix);
        Ok(())
    }

    fn lower_if(
        &mut self,
        blockty: BlockType,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        let signature = self.block_signature(blockty, offset)?;
        let was_reachable = self.reachable;
        let condition = if was_reachable {
            Some(self.pop_typed(&ir::ValueType::I32, offset, "if condition")?)
        } else {
            None
        };
        let (prefix, arguments) = self.enter_arguments(&signature.params, offset, "if input")?;
        if !was_reachable {
            self.close_dead_current(source)?;
        }

        let parent_region = self.current_region;
        let (then_region, then_block) = self.new_region_entry(
            parent_region,
            ir::RegionKind::IfThen,
            &signature.params,
            structural_source(source),
        );
        let (else_region, else_block) = self.new_region_entry(
            parent_region,
            ir::RegionKind::IfElse,
            &signature.params,
            structural_source(source),
        );
        let continuation =
            self.new_block(parent_region, &signature.results, structural_source(source));

        if let Some(condition) = condition {
            self.terminate_current(
                ir::TerminatorKind::Branch {
                    condition,
                    then_edge: ir::Edge::new(then_block, arguments.clone()),
                    else_edge: ir::Edge::new(else_block, arguments),
                },
                source,
            )?;
        }
        self.seal_block(then_block)?;
        self.seal_block(else_block)?;

        self.control.push(ControlFrame {
            kind: ControlKind::If {
                then_region,
                else_region,
                else_block,
                has_else: false,
            },
            signature,
            prefix: prefix.clone(),
            label_target: Some(continuation),
            continuation: Some(continuation),
            parent_region,
        });
        self.activate(then_block, prefix);
        Ok(())
    }

    fn lower_try_table(
        &mut self,
        table: wasmparser::TryTable,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        let signature = self.block_signature(table.ty, offset)?;
        let was_reachable = self.reachable;
        let (prefix, arguments) =
            self.enter_arguments(&signature.params, offset, "try_table input")?;
        if !was_reachable {
            self.close_dead_current(source)?;
        }

        let mut catches = Vec::with_capacity(table.catches.len());
        for catch in table.catches {
            let (kind, tag, relative_depth) = match catch {
                wasmparser::Catch::One { tag, label } => {
                    (ir::CatchKind::Catch, Some(ir::TagId(tag)), label)
                }
                wasmparser::Catch::OneRef { tag, label } => {
                    (ir::CatchKind::CatchRef, Some(ir::TagId(tag)), label)
                }
                wasmparser::Catch::All { label } => (ir::CatchKind::CatchAll, None, label),
                wasmparser::Catch::AllRef { label } => (ir::CatchKind::CatchAllRef, None, label),
            };
            let (target, _) = self.label(relative_depth, offset)?;
            catches.push(ir::CatchClause { kind, tag, target });
        }

        let parent_region = self.current_region;
        let (region, entry) = self.new_region_entry(
            parent_region,
            ir::RegionKind::TryTable { catches },
            &signature.params,
            structural_source(source),
        );
        let continuation =
            self.new_block(parent_region, &signature.results, structural_source(source));

        if was_reachable {
            self.terminate_current(
                ir::TerminatorKind::Jump(ir::Edge::new(entry, arguments)),
                source,
            )?;
        }
        self.seal_block(entry)?;
        self.control.push(ControlFrame {
            kind: ControlKind::TryTable { region },
            signature,
            prefix: prefix.clone(),
            label_target: Some(continuation),
            continuation: Some(continuation),
            parent_region,
        });
        self.activate(entry, prefix);
        Ok(())
    }

    fn lower_else(&mut self, offset: u64, source: ir::SourceInfo) -> Result<(), FrontendError> {
        let frame = self
            .control
            .last()
            .cloned()
            .ok_or_else(|| self.invariant(offset, "else", "the control stack is empty"))?;
        let (then_region, else_region, else_block, has_else) = match frame.kind {
            ControlKind::If {
                then_region,
                else_region,
                else_block,
                has_else,
            } => (then_region, else_region, else_block, has_else),
            _ => {
                return Err(self.invariant(
                    offset,
                    "else",
                    "the innermost control frame is not an if",
                ));
            }
        };
        if has_else {
            return Err(self.invariant(offset, "else", "the if already has an else arm"));
        }

        let continuation = frame.continuation.expect("if continuation");
        self.finish_arm(&frame.signature.results, continuation, offset, source)?;
        self.set_region_end(then_region, source_start(source));
        self.regions[else_region.index()].source = structural_source(source);
        self.blocks[else_block.index()].source = structural_source(source);
        if let ControlKind::If { has_else, .. } = &mut self
            .control
            .last_mut()
            .expect("if frame remains on the stack")
            .kind
        {
            *has_else = true;
        }
        self.activate(else_block, frame.prefix);
        Ok(())
    }

    fn lower_br(
        &mut self,
        relative_depth: u32,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.reachable {
            self.close_dead_current(source)?;
            self.reset_dead_stack();
            return Ok(());
        }
        let (target, label_types) = self.label(relative_depth, offset)?;
        let arguments = self.take_values(&label_types, offset, "br arguments")?;
        self.terminate_current(
            ir::TerminatorKind::Jump(ir::Edge::new(target, arguments)),
            source,
        )?;
        self.reachable = false;
        self.reset_dead_stack();
        Ok(())
    }

    fn lower_br_if(
        &mut self,
        relative_depth: u32,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.reachable {
            return Ok(());
        }
        let condition = self.pop_typed(&ir::ValueType::I32, offset, "br_if condition")?;
        let (target, label_types) = self.label(relative_depth, offset)?;
        let arguments = self.peek_values(&label_types, offset, "br_if arguments")?;
        let fallthrough_stack = self.stack.clone();
        let fallthrough = self.new_block(self.current_region, &[], structural_source(source));
        self.terminate_current(
            ir::TerminatorKind::Branch {
                condition,
                then_edge: ir::Edge::new(target, arguments),
                else_edge: ir::Edge::new(fallthrough, Vec::new()),
            },
            source,
        )?;
        self.seal_block(fallthrough)?;
        self.activate(fallthrough, fallthrough_stack);
        Ok(())
    }

    fn lower_br_on_null(
        &mut self,
        relative_depth: u32,
        validated: ValidatedOperatorSignature,
        canonical_types: &BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.reachable {
            return Ok(());
        }
        let (reference, reference_type) = self
            .stack
            .pop()
            .ok_or_else(|| self.invariant(offset, "br_on_null", "operand stack is empty"))?;
        let ir::ValueType::Ref(reference_type_info) = &reference_type else {
            return Err(self.invariant(
                offset,
                "br_on_null",
                format!("operand has non-reference type {reference_type}"),
            ));
        };
        let refined_type = validated
            .results
            .last()
            .copied()
            .flatten()
            .map(|ty| lower_validated_value_type(ty, canonical_types, offset))
            .transpose()?
            .unwrap_or_else(|| {
                ir::ValueType::Ref(ir::RefType {
                    nullable: false,
                    heap: reference_type_info.heap.clone(),
                })
            });
        let (target, label_types) = self.label(relative_depth, offset)?;
        let arguments = self.peek_values(&label_types, offset, "br_on_null arguments")?;
        let fallthrough_stack = self.stack.clone();
        let condition = self.emit_reference_null_test(reference, reference_type.clone(), source)?;
        let fallthrough = self.new_block(
            self.current_region,
            std::slice::from_ref(&refined_type),
            structural_source(source),
        );
        self.terminate_current(
            ir::TerminatorKind::Branch {
                condition,
                then_edge: ir::Edge::new(target, arguments),
                else_edge: ir::Edge::new(fallthrough, vec![reference])
                    .with_refinement(0, refined_type),
            },
            source,
        )?;
        self.seal_block(fallthrough)?;
        self.activate(fallthrough, fallthrough_stack);
        Ok(())
    }

    fn lower_br_on_non_null(
        &mut self,
        relative_depth: u32,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.reachable {
            return Ok(());
        }
        let (reference, reference_type) = self
            .stack
            .pop()
            .ok_or_else(|| self.invariant(offset, "br_on_non_null", "operand stack is empty"))?;
        let ir::ValueType::Ref(reference_type_info) = &reference_type else {
            return Err(self.invariant(
                offset,
                "br_on_non_null",
                format!("operand has non-reference type {reference_type}"),
            ));
        };
        let refined_type = ir::ValueType::Ref(ir::RefType {
            nullable: false,
            heap: reference_type_info.heap.clone(),
        });
        let (target, label_types) = self.label(relative_depth, offset)?;
        let (expected_reference, expected_prefix) = label_types.split_last().ok_or_else(|| {
            self.invariant(
                offset,
                "br_on_non_null",
                "target label has no reference argument",
            )
        })?;
        if !ir::is_value_subtype(self.types, &refined_type, expected_reference) {
            return Err(self.invariant(
                offset,
                "br_on_non_null",
                format!(
                    "refined value has type {}, target expects {expected_reference}",
                    refined_type
                ),
            ));
        }
        let mut arguments =
            self.peek_values(expected_prefix, offset, "br_on_non_null arguments")?;
        let refined_argument = arguments.len() as u32;
        arguments.push(reference);
        let fallthrough_stack = self.stack.clone();
        let condition = self.emit_reference_null_test(reference, reference_type, source)?;
        let fallthrough = self.new_block(self.current_region, &[], structural_source(source));
        self.terminate_current(
            ir::TerminatorKind::Branch {
                condition,
                then_edge: ir::Edge::new(fallthrough, Vec::new()),
                else_edge: ir::Edge::new(target, arguments)
                    .with_refinement(refined_argument, refined_type),
            },
            source,
        )?;
        self.seal_block(fallthrough)?;
        self.activate(fallthrough, fallthrough_stack);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn lower_br_on_cast(
        &mut self,
        kind: CastBranchKind,
        relative_depth: u32,
        from_ref_type: WasmRefType,
        to_ref_type: WasmRefType,
        validated: ValidatedOperatorSignature,
        canonical_types: &BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.reachable {
            return Ok(());
        }

        let operation = kind.mnemonic();
        let (reference, reference_type) = self
            .stack
            .pop()
            .ok_or_else(|| self.invariant(offset, operation, "operand stack is empty"))?;
        let ir::ValueType::Ref(_) = &reference_type else {
            return Err(self.invariant(
                offset,
                operation,
                format!("operand has non-reference type {reference_type}"),
            ));
        };

        let declared_from = ir::ValueType::Ref(lower_ref_type(
            from_ref_type,
            TypeContext::module(),
            offset,
        )?);
        if !ir::is_value_subtype(self.types, &reference_type, &declared_from) {
            return Err(self.invariant(
                offset,
                operation,
                format!("operand has type {reference_type}, cast declares input {declared_from}"),
            ));
        }

        let cast_type =
            ir::ValueType::Ref(lower_ref_type(to_ref_type, TypeContext::module(), offset)?);
        let difference_type = ir::ValueType::Ref(lower_ref_type(
            WasmRefType::difference(from_ref_type, to_ref_type),
            TypeContext::module(),
            offset,
        )?);
        let fallthrough_type = validated
            .results
            .last()
            .copied()
            .flatten()
            .ok_or_else(|| {
                self.invariant(
                    offset,
                    operation,
                    "validator reported no fallthrough reference type",
                )
            })
            .and_then(|ty| lower_validated_value_type(ty, canonical_types, offset))?;
        let (branch_type, expected_fallthrough_type) = match kind {
            CastBranchKind::Success => (cast_type.clone(), &difference_type),
            CastBranchKind::Failure => (difference_type.clone(), &cast_type),
        };
        if !ir::is_value_subtype(self.types, &fallthrough_type, expected_fallthrough_type)
            || !ir::is_value_subtype(self.types, expected_fallthrough_type, &fallthrough_type)
        {
            return Err(self.invariant(
                offset,
                operation,
                format!(
                    "validator reported fallthrough type {fallthrough_type}, expected {expected_fallthrough_type}"
                ),
            ));
        }

        let (target, label_types) = self.label(relative_depth, offset)?;
        let (expected_reference, expected_prefix) = label_types.split_last().ok_or_else(|| {
            self.invariant(offset, operation, "target label has no reference argument")
        })?;
        if !ir::is_value_subtype(self.types, &branch_type, expected_reference) {
            return Err(self.invariant(
                offset,
                operation,
                format!(
                    "refined branch value has type {branch_type}, target expects {expected_reference}"
                ),
            ));
        }

        // `ref.test` is true exactly when the cast succeeds. Each successor
        // receives the original reference; its edge records the path fact and
        // its block parameter is the narrowed SSA definition.
        let condition =
            self.emit_reference_cast_test(reference, declared_from, &cast_type, source)?;
        let mut branch_arguments =
            self.peek_values(expected_prefix, offset, "cast branch arguments")?;
        let refined_argument = branch_arguments.len() as u32;
        branch_arguments.push(reference);

        let fallthrough_stack = self.stack.clone();
        let fallthrough = self.new_block(
            self.current_region,
            std::slice::from_ref(&fallthrough_type),
            structural_source(source),
        );
        let branch_edge =
            ir::Edge::new(target, branch_arguments).with_refinement(refined_argument, branch_type);
        let fallthrough_edge =
            ir::Edge::new(fallthrough, vec![reference]).with_refinement(0, fallthrough_type);
        let (then_edge, else_edge) = match kind {
            CastBranchKind::Success => (branch_edge, fallthrough_edge),
            CastBranchKind::Failure => (fallthrough_edge, branch_edge),
        };
        self.terminate_current(
            ir::TerminatorKind::Branch {
                condition,
                then_edge,
                else_edge,
            },
            source,
        )?;
        self.seal_block(fallthrough)?;
        self.activate(fallthrough, fallthrough_stack);
        Ok(())
    }

    fn emit_reference_cast_test(
        &mut self,
        reference: ir::ValueId,
        reference_type: ir::ValueType,
        cast_type: &ir::ValueType,
        source: ir::SourceInfo,
    ) -> Result<ir::ValueId, FrontendError> {
        let ir::ValueType::Ref(cast_reference) = cast_type else {
            return Err(self.invariant(
                source_start(source),
                "reference cast test",
                format!("cast target has non-reference type {cast_type}"),
            ));
        };
        let opcode = if cast_reference.nullable {
            CoreOpcode::RefTestNullable
        } else {
            CoreOpcode::RefTestNonNull
        };
        Ok(self
            .emit_operation(
                ir::Operation::core(opcode, vec![reference_type], vec![ir::ValueType::I32])
                    .with_immediates(vec![ir::Immediate::HeapType(cast_reference.heap.clone())]),
                vec![reference],
                vec![ir::ValueType::I32],
                source,
            )?
            .into_iter()
            .next()
            .expect("reference cast test has one result")
            .id)
    }

    fn emit_reference_null_test(
        &mut self,
        reference: ir::ValueId,
        reference_type: ir::ValueType,
        source: ir::SourceInfo,
    ) -> Result<ir::ValueId, FrontendError> {
        Ok(self
            .emit_operation(
                ir::Operation::core(
                    CoreOpcode::RefIsNull,
                    vec![reference_type],
                    vec![ir::ValueType::I32],
                ),
                vec![reference],
                vec![ir::ValueType::I32],
                source,
            )?
            .into_iter()
            .next()
            .expect("ref.is_null has one result")
            .id)
    }

    fn lower_br_table(
        &mut self,
        table: wasmparser::BrTable<'_>,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        let depths = table.targets().collect::<Result<Vec<_>, _>>()?;
        let default_depth = table.default();
        if !self.reachable {
            self.close_dead_current(source)?;
            self.reset_dead_stack();
            return Ok(());
        }

        let selector = self.pop_typed(&ir::ValueType::I32, offset, "br_table selector")?;
        let (default_target, label_types) = self.label(default_depth, offset)?;
        let arguments = self.peek_values(&label_types, offset, "br_table arguments")?;
        let mut targets = Vec::with_capacity(depths.len());
        for depth in depths {
            // Validation guarantees equal arity and that the live operands
            // match every target. Declared label types may still differ via
            // reference subtyping, which the IR verifier checks per edge.
            let (target, _) = self.label(depth, offset)?;
            targets.push(ir::Edge::new(target, arguments.clone()));
        }
        self.take_values(&label_types, offset, "br_table arguments")?;
        self.terminate_current(
            ir::TerminatorKind::Switch {
                selector,
                targets,
                default: ir::Edge::new(default_target, arguments),
            },
            source,
        )?;
        self.reachable = false;
        self.reset_dead_stack();
        Ok(())
    }

    fn lower_return(&mut self, offset: u64, source: ir::SourceInfo) -> Result<(), FrontendError> {
        if self.reachable {
            let values = self.take_values(&self.signature.results, offset, "return")?;
            self.terminate_current(ir::TerminatorKind::Return { values }, source)?;
            self.reachable = false;
        } else {
            self.close_dead_current(source)?;
        }
        self.reset_dead_stack();
        Ok(())
    }

    fn lower_tail_call(
        &mut self,
        target: TailCallTarget,
        validated: ValidatedOperatorSignature,
        canonical_types: &BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.reachable {
            self.close_dead_current(source)?;
            self.reset_dead_stack();
            return Ok(());
        }

        let parameter_types = lower_validated_stack_types(
            validated.parameters,
            canonical_types,
            offset,
            "tail call",
        )?;
        let mut values = self.take_values(&parameter_types, offset, "tail call")?;
        let callee = match target {
            TailCallTarget::Direct(function) => ir::Callee::Direct(function),
            TailCallTarget::Indirect { ty, table } => {
                let index = values.pop().ok_or_else(|| {
                    self.invariant(offset, "indirect tail call", "missing table index")
                })?;
                ir::Callee::Indirect { ty, table, index }
            }
            TailCallTarget::Reference { ty } => {
                let reference = values.pop().ok_or_else(|| {
                    self.invariant(offset, "reference tail call", "missing callee reference")
                })?;
                ir::Callee::Reference { ty, reference }
            }
        };
        self.terminate_current(
            ir::TerminatorKind::TailCall {
                callee,
                arguments: values,
            },
            source,
        )?;
        self.reachable = false;
        self.reset_dead_stack();
        Ok(())
    }

    fn lower_throw(
        &mut self,
        tag: ir::TagId,
        validated: ValidatedOperatorSignature,
        canonical_types: &BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.reachable {
            self.close_dead_current(source)?;
            self.reset_dead_stack();
            return Ok(());
        }
        let parameter_types =
            lower_validated_stack_types(validated.parameters, canonical_types, offset, "throw")?;
        let arguments = self.take_values(&parameter_types, offset, "throw")?;
        let routing = self.exception_routing(Some((tag, arguments.as_slice())), offset)?;
        self.terminate_current_with_routing(
            ir::TerminatorKind::Throw { tag, arguments },
            routing,
            source,
        )?;
        self.reachable = false;
        self.reset_dead_stack();
        Ok(())
    }

    fn lower_throw_ref(
        &mut self,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.reachable {
            self.close_dead_current(source)?;
            self.reset_dead_stack();
            return Ok(());
        }
        let exception = self.pop_typed(
            &ir::ValueType::Ref(ir::RefType {
                nullable: true,
                heap: ir::HeapType::Exn,
            }),
            offset,
            "throw_ref",
        )?;
        let routing = self.exception_routing(None, offset)?;
        self.terminate_current_with_routing(
            ir::TerminatorKind::ThrowRef { exception },
            routing,
            source,
        )?;
        self.reachable = false;
        self.reset_dead_stack();
        Ok(())
    }

    /// Construct the ordered exceptional dispatch visible at the current
    /// program point. A known `throw` can select its first matching clause
    /// statically; calls and `throw_ref` retain every dynamically possible arm.
    fn exception_routing(
        &mut self,
        known: Option<(ir::TagId, &[ir::ValueId])>,
        offset: u64,
    ) -> Result<ir::ExceptionRouting, FrontendError> {
        let mut handlers = Vec::new();
        for frame in self.control.iter().rev() {
            let ControlKind::TryTable { region } = &frame.kind else {
                continue;
            };
            let region = *region;
            let ir::RegionKind::TryTable { catches } = &self.regions[region.index()].kind else {
                return Err(self.invariant(
                    offset,
                    "exception routing",
                    format!("{region} is not a try_table region"),
                ));
            };
            handlers.push((region, catches.as_slice()));
        }
        let (arms, escapes) = ir::lexical_exception_arms(
            self.types,
            self.tags,
            handlers.iter().copied(),
            known.map(|(tag, _)| tag),
        );
        let selected: Vec<(ir::RegionId, u32, ir::CatchClause)> = arms
            .into_iter()
            .map(|(region, clause)| {
                let catches = handlers
                    .iter()
                    .find(|(handler, _)| *handler == region)
                    .map_or(&[][..], |(_, catches)| catches);
                (region, clause, catches[clause as usize])
            })
            .collect();

        let source = self.current;
        let targets: Vec<ir::BlockId> = selected.iter().map(|(_, _, catch)| catch.target).collect();
        let mut arms = Vec::with_capacity(selected.len());
        for &(handler, clause, catch) in &selected {
            let arguments = self.catch_payload_arguments(catch, known, offset)?;
            arms.push(ir::ExceptionalEdge::new(
                handler,
                clause,
                catch.target,
                arguments,
            ));
        }
        self.append_pending_local_arguments(source, &targets, |index, value| {
            arms[index]
                .arguments
                .push(ir::ExceptionalArgument::Value(value));
        })?;
        Ok(ir::ExceptionRouting { arms, escapes })
    }

    fn catch_payload_arguments(
        &self,
        catch: ir::CatchClause,
        known: Option<(ir::TagId, &[ir::ValueId])>,
        offset: u64,
    ) -> Result<Vec<ir::ExceptionalArgument>, FrontendError> {
        let mut arguments = match catch.kind {
            ir::CatchKind::Catch | ir::CatchKind::CatchRef => {
                let tag = catch.tag.ok_or_else(|| {
                    self.invariant(offset, "exception routing", "tagged catch has no tag")
                })?;
                if let Some((known_tag, values)) = known {
                    if !ir::tags_may_alias(self.types, self.tags, known_tag, tag) {
                        return Err(self.invariant(
                            offset,
                            "exception routing",
                            format!("known {known_tag} was routed to a {tag} catch"),
                        ));
                    }
                    values
                        .iter()
                        .copied()
                        .map(ir::ExceptionalArgument::Value)
                        .collect()
                } else {
                    self.tag_parameter_types(tag, offset)?
                        .into_iter()
                        .enumerate()
                        .map(|(index, ty)| ir::ExceptionalArgument::CaughtPayload {
                            index: index as u32,
                            ty,
                        })
                        .collect()
                }
            }
            ir::CatchKind::CatchAll | ir::CatchKind::CatchAllRef => Vec::new(),
        };
        if matches!(
            catch.kind,
            ir::CatchKind::CatchRef | ir::CatchKind::CatchAllRef
        ) {
            arguments.push(ir::ExceptionalArgument::CaughtException);
        }
        Ok(arguments)
    }

    fn tag_parameter_types(
        &self,
        tag: ir::TagId,
        offset: u64,
    ) -> Result<Vec<ir::ValueType>, FrontendError> {
        let signature = self
            .tags
            .get(tag.index())
            .and_then(|tag| self.types.get(tag.ty.signature.index()))
            .and_then(|definition| match &definition.composite {
                ir::CompositeType::Function(signature) => Some(signature),
                _ => None,
            })
            .ok_or_else(|| {
                self.invariant(
                    offset,
                    "exception routing",
                    format!("{tag} has no function signature"),
                )
            })?;
        Ok(signature.params.clone())
    }

    fn lower_unreachable(&mut self, source: ir::SourceInfo) -> Result<(), FrontendError> {
        if self.block_is_open(self.current) {
            self.terminate_current(
                ir::TerminatorKind::Unreachable {
                    trap: ir::TrapCode::Unreachable,
                },
                source,
            )?;
        }
        self.reachable = false;
        self.reset_dead_stack();
        Ok(())
    }

    fn lower_end(&mut self, offset: u64, source: ir::SourceInfo) -> Result<bool, FrontendError> {
        let frame = self
            .control
            .last()
            .cloned()
            .ok_or_else(|| self.invariant(offset, "end", "the control stack is empty"))?;
        if matches!(frame.kind, ControlKind::Function) {
            if self.block_is_open(self.current) {
                if self.reachable {
                    let values =
                        self.take_values(&frame.signature.results, offset, "function end")?;
                    self.terminate_current(ir::TerminatorKind::Return { values }, source)?;
                } else {
                    self.close_dead_current(source)?;
                }
            }
            self.control.pop();
            return Ok(true);
        }

        let continuation = frame.continuation.expect("structured continuation");
        self.finish_arm(&frame.signature.results, continuation, offset, source)?;

        match frame.kind {
            ControlKind::Block { region } => {
                self.set_region_end(region, source_end(source));
            }
            ControlKind::Loop { region } => {
                self.seal_block(self.regions[region.index()].entry)?;
                self.set_region_end(region, source_end(source));
            }
            ControlKind::TryTable { region } => {
                self.set_region_end(region, source_end(source));
            }
            ControlKind::If {
                then_region,
                else_region,
                else_block,
                has_else,
            } => {
                if !has_else {
                    self.set_region_end(then_region, source_end(source));
                    self.activate(else_block, frame.prefix.clone());
                    self.finish_arm(&frame.signature.results, continuation, offset, source)?;
                }
                self.set_region_end(else_region, source_end(source));
            }
            ControlKind::Function => unreachable!(),
        }

        self.control.pop();
        self.set_block_start(continuation, source_end(source));
        self.seal_block(continuation)?;
        self.activate(continuation, frame.prefix);
        debug_assert_eq!(self.current_region, frame.parent_region);
        Ok(false)
    }

    fn finish_arm(
        &mut self,
        results: &[ir::ValueType],
        continuation: ir::BlockId,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.block_is_open(self.current) {
            return Ok(());
        }
        if self.reachable {
            let arguments = self.take_values(results, offset, "structured result")?;
            self.terminate_current(
                ir::TerminatorKind::Jump(ir::Edge::new(continuation, arguments)),
                source,
            )?;
        } else {
            self.close_dead_current(source)?;
        }
        Ok(())
    }

    fn enter_arguments(
        &mut self,
        params: &[ir::ValueType],
        offset: u64,
        operation: &'static str,
    ) -> Result<(Vec<StackValue>, Vec<ir::ValueId>), FrontendError> {
        if self.reachable {
            let arguments = self.take_stack_values(params.len(), offset, operation)?;
            self.check_stack_types(&arguments, params, offset, operation)?;
            let ids = arguments.iter().map(|(value, _)| *value).collect();
            Ok((self.stack.clone(), ids))
        } else {
            let prefix = self
                .control
                .last()
                .map(|frame| frame.prefix.clone())
                .unwrap_or_default();
            Ok((prefix, Vec::new()))
        }
    }

    fn label(
        &mut self,
        relative_depth: u32,
        offset: u64,
    ) -> Result<(ir::BlockId, Vec<ir::ValueType>), FrontendError> {
        let depth = relative_depth as usize;
        if depth >= self.control.len() {
            return Err(self.invariant(
                offset,
                "branch label",
                format!(
                    "relative depth {relative_depth} exceeds {} active labels",
                    self.control.len()
                ),
            ));
        }
        let frame_index = self.control.len() - depth - 1;
        let label_types = self.control[frame_index].label_types().to_vec();
        let target = match self.control[frame_index].label_target {
            Some(target) => target,
            None if matches!(self.control[frame_index].kind, ControlKind::Function) => {
                let target =
                    self.new_block(ir::RegionId(0), &label_types, ir::SourceInfo::synthetic());
                let values = self.block_parameter_values(target);
                self.set_block_terminator(
                    target,
                    ir::TerminatorKind::Return { values },
                    ir::SourceInfo::synthetic(),
                )?;
                self.control[frame_index].label_target = Some(target);
                target
            }
            None => {
                return Err(self.invariant(
                    offset,
                    "branch label",
                    "structured label has no CFG target",
                ));
            }
        };
        Ok((target, label_types))
    }

    fn block_signature(
        &self,
        blockty: BlockType,
        offset: u64,
    ) -> Result<ir::FunctionType, FrontendError> {
        match blockty {
            BlockType::Empty => Ok(ir::FunctionType {
                params: Vec::new(),
                results: Vec::new(),
            }),
            BlockType::Type(ty) => Ok(ir::FunctionType {
                params: Vec::new(),
                results: vec![lower_value_type(ty, TypeContext::module(), offset)?],
            }),
            BlockType::FuncType(type_index) => match self.types.get(type_index as usize) {
                Some(ir::TypeDefinition {
                    composite: ir::CompositeType::Function(signature),
                    ..
                }) => Ok(signature.clone()),
                _ => Err(FrontendError::InvalidFunctionType { type_index, offset }),
            },
        }
    }

    fn lower_leaf_operator(
        &mut self,
        operator: &Operator<'_>,
        validated: ValidatedOperatorSignature,
        canonical_types: &BTreeMap<wasmparser::types::CoreTypeId, ir::TypeId>,
        offset: u64,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.reachable {
            return Ok(());
        }

        let opcode = CoreOpcode::from_operator(operator).ok_or_else(|| {
            FrontendError::UnsupportedOperator {
                function_index: self.function_index,
                offset,
                operator: format!("{operator:?}"),
            }
        })?;
        if !opcode.is_standard_wasm3() {
            return Err(FrontendError::UnsupportedFeature {
                feature: "operator outside the standard WebAssembly 3.0 profile",
                offset,
            });
        }

        let parameters = lower_validated_stack_types(
            validated.parameters,
            canonical_types,
            offset,
            opcode.parser_name(),
        )?;
        let results = lower_validated_stack_types(
            validated.results,
            canonical_types,
            offset,
            opcode.parser_name(),
        )?;
        let operands = self.take_values(&parameters, offset, "leaf operation")?;
        let operation = ir::Operation::core(opcode, parameters, results.clone())
            .with_immediates(collect_operator_immediates(operator, offset)?);
        let results = self.emit_operation(operation, operands, results, source)?;
        self.push_results(results);
        Ok(())
    }

    fn emit_operation(
        &mut self,
        operation: ir::Operation,
        operands: Vec<ir::ValueId>,
        result_types: Vec<ir::ValueType>,
        source: ir::SourceInfo,
    ) -> Result<Vec<ir::ValueDefinition>, FrontendError> {
        if !self.block_is_open(self.current) {
            return Err(self.invariant(
                source_start(source),
                "instruction",
                "the current block already has a terminator",
            ));
        }
        let results: Vec<_> = result_types
            .into_iter()
            .map(|ty| self.fresh_value(ty))
            .collect();
        let effects = crate::semantics::effects_for_operation(&operation);
        if effects.exception == ir::ExceptionEffect::MayThrow {
            let routing = self.exception_routing(None, source_start(source))?;
            if !routing.arms.is_empty() {
                // An exception that can reach an in-function handler leaves at
                // this exact program point, so the operation ends its block as
                // an invoke whose results are its continuation's parameters.
                let normal_stack = self.stack.clone();
                let continuation = self.new_block_with_parameters(
                    self.current_region,
                    results.clone(),
                    structural_source(source),
                );
                self.terminate_current_with_routing(
                    ir::TerminatorKind::Invoke {
                        operation,
                        operands,
                        effects,
                        normal: ir::Edge::new(continuation, Vec::new()),
                    },
                    routing,
                    source,
                )?;
                self.seal_block(continuation)?;
                self.enter(continuation, normal_stack);
                return Ok(results);
            }
        }
        let mut instruction = ir::Instruction::new(
            ir::InstructionId(self.next_instruction),
            operation,
            operands,
            results.clone(),
            source,
        );
        instruction.effects = effects;
        self.next_instruction += 1;
        self.blocks[self.current.index()]
            .instructions
            .push(instruction);
        self.extend_block_source(self.current, source_end(source));
        Ok(results)
    }

    fn push_results(&mut self, results: Vec<ir::ValueDefinition>) {
        self.stack
            .extend(results.into_iter().map(|result| (result.id, result.ty)));
    }

    fn pop_typed(
        &mut self,
        expected: &ir::ValueType,
        offset: u64,
        operation: &'static str,
    ) -> Result<ir::ValueId, FrontendError> {
        let (value, actual) = self
            .stack
            .pop()
            .ok_or_else(|| self.invariant(offset, operation, "operand stack is empty"))?;
        if !ir::is_value_subtype(self.types, &actual, expected) {
            return Err(self.invariant(
                offset,
                operation,
                format!("found {actual:?}, expected {expected:?}"),
            ));
        }
        Ok(value)
    }

    fn take_values(
        &mut self,
        expected: &[ir::ValueType],
        offset: u64,
        operation: &'static str,
    ) -> Result<Vec<ir::ValueId>, FrontendError> {
        let values = self.take_stack_values(expected.len(), offset, operation)?;
        self.check_stack_types(&values, expected, offset, operation)?;
        Ok(values.into_iter().map(|(value, _)| value).collect())
    }

    fn peek_values(
        &self,
        expected: &[ir::ValueType],
        offset: u64,
        operation: &'static str,
    ) -> Result<Vec<ir::ValueId>, FrontendError> {
        if self.stack.len() < expected.len() {
            return Err(self.invariant(
                offset,
                operation,
                format!(
                    "operand stack has {} values but {} are required",
                    self.stack.len(),
                    expected.len()
                ),
            ));
        }
        let values = &self.stack[self.stack.len() - expected.len()..];
        self.check_stack_types(values, expected, offset, operation)?;
        Ok(values.iter().map(|(value, _)| *value).collect())
    }

    fn check_stack_types(
        &self,
        actual: &[StackValue],
        expected: &[ir::ValueType],
        offset: u64,
        operation: &'static str,
    ) -> Result<(), FrontendError> {
        if actual
            .iter()
            .zip(expected)
            .all(|((_, actual), expected)| ir::is_value_subtype(self.types, actual, expected))
        {
            return Ok(());
        }
        Err(self.invariant(
            offset,
            operation,
            format!(
                "found {:?}, expected subtypes of {expected:?}",
                actual.iter().map(|(_, ty)| ty).collect::<Vec<_>>()
            ),
        ))
    }

    fn take_stack_values(
        &mut self,
        count: usize,
        offset: u64,
        operation: &'static str,
    ) -> Result<Vec<StackValue>, FrontendError> {
        if self.stack.len() < count {
            return Err(self.invariant(
                offset,
                operation,
                format!(
                    "operand stack has {} values but {count} are required",
                    self.stack.len()
                ),
            ));
        }
        Ok(self.stack.split_off(self.stack.len() - count))
    }

    fn fresh_value(&mut self, ty: ir::ValueType) -> ir::ValueDefinition {
        let value = ir::ValueDefinition::new(ir::ValueId(self.next_value), ty);
        self.next_value += 1;
        value
    }

    fn write_local(&mut self, local: ir::LocalId, block: ir::BlockId, value: ir::ValueId) {
        self.current_definitions.insert((block, local), value);
    }

    fn read_local(
        &mut self,
        local: ir::LocalId,
        block: ir::BlockId,
    ) -> Result<ir::ValueId, FrontendError> {
        if let Some(value) = self.current_definitions.get(&(block, local)) {
            return Ok(*value);
        }
        let ty =
            self.locals
                .get(local.index())
                .cloned()
                .ok_or(FrontendError::InvalidEntityIndex {
                    kind: "local",
                    index: local.0,
                    offset: source_start(self.blocks[block.index()].source),
                })?;

        // Reads are resolved with an explicit worklist so that neither a long
        // single-predecessor chain nor a deep nest of merges can exhaust the
        // stack. Each task walks a chain of sealed single-predecessor blocks
        // until it finds a definition or a merge point, then delivers the
        // value either as the result or as the argument of one predecessor
        // edge of a newly created parameter.
        let mut pending = vec![(block, LocalRead::Result)];
        let mut chain = Vec::new();
        let mut result = None;
        while let Some((start, delivery)) = pending.pop() {
            chain.clear();
            let mut current = start;
            let value = loop {
                if let Some(value) = self.current_definitions.get(&(current, local)) {
                    break *value;
                }
                let merges =
                    !self.sealed[current.index()] || self.predecessors[current.index()].len() > 1;
                if merges {
                    let parameter = self.fresh_value(ty.clone());
                    let value = parameter.id;
                    self.blocks[current.index()].parameters.push(parameter);
                    self.local_parameters[current.index()].push((local, value));
                    // Install the definition before visiting predecessors so a
                    // loop backedge reading the same local observes this
                    // placeholder and the walk terminates. Predecessors already
                    // recorded receive their argument below; a predecessor
                    // added while the block is unsealed is completed when its
                    // terminator is installed. Tasks are pushed in reverse so
                    // the first predecessor resolves first, which keeps value
                    // numbering in creation order.
                    self.current_definitions.insert((current, local), value);
                    for &predecessor in self.predecessors[current.index()].iter().rev() {
                        pending.push((predecessor, LocalRead::Argument { target: current }));
                    }
                    break value;
                }
                match self.predecessors[current.index()].as_slice() {
                    [predecessor] => {
                        chain.push(current);
                        current = *predecessor;
                    }
                    _ => {
                        return Err(self.invariant(
                            source_start(self.blocks[current.index()].source),
                            "local SSA read",
                            format!(
                                "reachable {current} has no definition for {local} or predecessor"
                            ),
                        ));
                    }
                }
            };
            for &visited in &chain {
                self.current_definitions.insert((visited, local), value);
            }
            match delivery {
                LocalRead::Result => result = Some(value),
                LocalRead::Argument { target } => {
                    self.append_edge_argument(start, target, value)?;
                }
            }
        }
        result.ok_or_else(|| {
            self.invariant(
                source_start(self.blocks[block.index()].source),
                "local SSA read",
                format!("the read of {local} in {block} produced no value"),
            )
        })
    }

    fn seal_block(&mut self, block: ir::BlockId) -> Result<(), FrontendError> {
        if self.sealed[block.index()] {
            return Ok(());
        }
        // Sealing closes the predecessor set. Every existing edge already has
        // arguments for all local parameters, and `record_predecessors`
        // rejects any attempt to add another predecessor after this point.
        self.sealed[block.index()] = true;
        Ok(())
    }

    fn new_block(
        &mut self,
        region: ir::RegionId,
        parameter_types: &[ir::ValueType],
        source: ir::SourceInfo,
    ) -> ir::BlockId {
        let parameters = parameter_types
            .iter()
            .cloned()
            .map(|ty| self.fresh_value(ty))
            .collect();
        self.new_block_with_parameters(region, parameters, source)
    }

    fn new_block_with_parameters(
        &mut self,
        region: ir::RegionId,
        parameters: Vec<ir::ValueDefinition>,
        source: ir::SourceInfo,
    ) -> ir::BlockId {
        let id = ir::BlockId(self.blocks.len() as u32);
        self.blocks.push(PendingBlock {
            id,
            region,
            parameters,
            instructions: Vec::new(),
            terminator: None,
            source,
        });
        self.block_reachable.push(false);
        self.local_parameters.push(Vec::new());
        self.predecessors.push(Vec::new());
        self.sealed.push(false);
        id
    }

    fn new_region_entry(
        &mut self,
        parent: ir::RegionId,
        kind: ir::RegionKind,
        parameter_types: &[ir::ValueType],
        source: ir::SourceInfo,
    ) -> (ir::RegionId, ir::BlockId) {
        let region = ir::RegionId(self.regions.len() as u32);
        let entry = self.new_block(region, parameter_types, source);
        self.regions.push(ir::Region {
            id: region,
            parent: Some(parent),
            kind,
            entry,
            source,
        });
        (region, entry)
    }

    fn activate(&mut self, block: ir::BlockId, mut prefix: Vec<StackValue>) {
        prefix.extend(
            self.blocks[block.index()]
                .parameters
                .iter()
                .cloned()
                .map(|parameter| (parameter.id, parameter.ty)),
        );
        self.enter(block, prefix);
    }

    /// Continues lowering in `block` with exactly `stack` as the operand
    /// stack; an invoke continuation's parameters are pushed by the caller as
    /// the operation's results.
    fn enter(&mut self, block: ir::BlockId, stack: Vec<StackValue>) {
        self.current = block;
        self.current_region = self.blocks[block.index()].region;
        self.reachable = self.block_reachable[block.index()];
        self.stack = stack;
    }

    fn block_parameter_values(&self, block: ir::BlockId) -> Vec<ir::ValueId> {
        self.blocks[block.index()]
            .parameters
            .iter()
            .map(|parameter| parameter.id)
            .collect()
    }

    fn block_is_open(&self, block: ir::BlockId) -> bool {
        self.blocks[block.index()].terminator.is_none()
    }

    /// Appends arguments for the local parameters of every target of one
    /// transfer, repeating while the reads themselves add parameters to a
    /// target of the same transfer.
    ///
    /// Reading a local at `source` can create a parameter on any unsealed
    /// block it walks through, including a target completed earlier in the
    /// same round (an enclosing loop header named by a `br_table` arm or a
    /// catch clause), so a single pass would leave that edge short. A read of
    /// a local that is already a parameter of a target cannot grow that
    /// target again, and no read creates parameters for other locals, so the
    /// rounds terminate; in practice the second round is the last.
    fn append_pending_local_arguments(
        &mut self,
        source: ir::BlockId,
        targets: &[ir::BlockId],
        mut append: impl FnMut(usize, ir::ValueId),
    ) -> Result<(), FrontendError> {
        let mut supplied = vec![0; targets.len()];
        loop {
            let mut progress = false;
            for (index, &target) in targets.iter().enumerate() {
                while let Some(&(local, _)) =
                    self.local_parameters[target.index()].get(supplied[index])
                {
                    supplied[index] += 1;
                    progress = true;
                    let value = self.read_local(local, source)?;
                    append(index, value);
                }
            }
            if !progress {
                return Ok(());
            }
        }
    }

    fn complete_local_edge_arguments(
        &mut self,
        source: ir::BlockId,
        terminator: &mut ir::TerminatorKind,
    ) -> Result<(), FrontendError> {
        let targets = distinct_targets(terminator.targets());
        let mut pending: BTreeMap<ir::BlockId, Vec<ir::ValueId>> = BTreeMap::new();
        self.append_pending_local_arguments(source, &targets, |index, value| {
            pending.entry(targets[index]).or_default().push(value);
        })?;
        for edge in terminator.edges_mut() {
            if let Some(values) = pending.get(&edge.target) {
                edge.arguments.extend_from_slice(values);
            }
        }
        Ok(())
    }

    /// Every edge and exceptional arm of a terminator about to be installed
    /// must supply exactly one argument per parameter of its target.
    fn check_edge_arity(
        &self,
        source: ir::BlockId,
        terminator: &ir::TerminatorKind,
        routing: Option<&ir::ExceptionRouting>,
        offset: u64,
    ) -> Result<(), FrontendError> {
        let leading = terminator.leading_parameters();
        let edges = terminator
            .edges()
            .map(|edge| (edge.target, edge.arguments.len(), leading, None));
        let arms = routing
            .into_iter()
            .flat_map(|routing| &routing.arms)
            .map(|arm| {
                (
                    arm.target,
                    arm.arguments.len(),
                    0,
                    Some((arm.handler, arm.clause)),
                )
            });
        for (target, supplied, leading, route) in edges.chain(arms) {
            let site = || match route {
                None => format!("edge from {source} to {target}"),
                Some((handler, clause)) => {
                    format!("exception route {handler}#{clause} from {source} to {target}")
                }
            };
            let Some(target) = self.blocks.get(target.index()) else {
                return Err(self.invariant(
                    offset,
                    "CFG edge",
                    format!("{} targets a missing block", site()),
                ));
            };
            let parameters = target.parameters.len();
            if let Some(detail) = arity_mismatch(site, supplied, parameters, leading) {
                return Err(self.invariant(offset, "CFG edge", detail));
            }
        }
        Ok(())
    }

    fn record_predecessors(&mut self, source: ir::BlockId) -> Result<(), FrontendError> {
        let terminator_source = self.blocks[source.index()]
            .terminator
            .as_ref()
            .expect("source block was just terminated")
            .source;
        let targets = self.block_successor_targets(source);
        for target in targets {
            if self.sealed[target.index()] {
                return Err(self.invariant(
                    source_start(terminator_source),
                    "CFG edge",
                    format!("cannot add predecessor {source} to sealed {target}"),
                ));
            }
            let predecessors = &mut self.predecessors[target.index()];
            if !predecessors.contains(&source) {
                predecessors.push(source);
            }
        }
        Ok(())
    }

    fn append_edge_argument(
        &mut self,
        source: ir::BlockId,
        target: ir::BlockId,
        value: ir::ValueId,
    ) -> Result<(), FrontendError> {
        let block_source = source_start(self.blocks[source.index()].source);
        let Some(terminator) = self.blocks[source.index()].terminator.as_mut() else {
            return Err(lowering_invariant(
                Some(self.function_index),
                block_source,
                "local SSA parameter",
                format!("predecessor {source} has no terminator"),
            ));
        };
        let terminator_offset = source_start(terminator.source);
        let mut found = false;
        for edge in terminator.kind.edges_mut() {
            if edge.target == target {
                edge.arguments.push(value);
                found = true;
            }
        }
        if let Some(routing) = &mut terminator.exception {
            for arm in &mut routing.arms {
                if arm.target == target {
                    arm.arguments.push(ir::ExceptionalArgument::Value(value));
                    found = true;
                }
            }
        }
        if !found {
            return Err(lowering_invariant(
                Some(self.function_index),
                terminator_offset,
                "local SSA parameter",
                format!("{source} is recorded as a predecessor of {target} without an edge"),
            ));
        }
        Ok(())
    }

    fn terminate_current(
        &mut self,
        kind: ir::TerminatorKind,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        self.terminate_current_impl(kind, None, source)
    }

    fn terminate_current_with_routing(
        &mut self,
        kind: ir::TerminatorKind,
        routing: ir::ExceptionRouting,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        self.terminate_current_impl(kind, Some(routing), source)
    }

    fn terminate_current_impl(
        &mut self,
        mut kind: ir::TerminatorKind,
        routing: Option<ir::ExceptionRouting>,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        let source_block = self.current;
        self.complete_local_edge_arguments(source_block, &mut kind)?;
        self.check_edge_arity(source_block, &kind, routing.as_ref(), source_start(source))?;
        self.set_block_terminator_with_routing(source_block, kind, routing, source)?;
        if self.reachable {
            for target in self.block_successor_targets(source_block) {
                self.block_reachable[target.index()] = true;
            }
        }
        self.record_predecessors(source_block)?;
        Ok(())
    }

    fn set_block_terminator(
        &mut self,
        block: ir::BlockId,
        kind: ir::TerminatorKind,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        self.set_block_terminator_with_routing(block, kind, None, source)
    }

    fn set_block_terminator_with_routing(
        &mut self,
        block: ir::BlockId,
        kind: ir::TerminatorKind,
        routing: Option<ir::ExceptionRouting>,
        source: ir::SourceInfo,
    ) -> Result<(), FrontendError> {
        if !self.block_is_open(block) {
            return Err(self.invariant(
                source_start(source),
                "terminator",
                format!("{block} already has a terminator"),
            ));
        }
        let mut terminator = ir::Terminator::new(kind, source);
        if let Some(routing) = routing {
            terminator.exception = Some(routing);
        }
        self.blocks[block.index()].terminator = Some(terminator);
        self.extend_block_source(block, source_end(source));
        Ok(())
    }

    fn block_successor_targets(&self, source: ir::BlockId) -> Vec<ir::BlockId> {
        self.blocks[source.index()]
            .terminator
            .as_ref()
            .map_or_else(Vec::new, |terminator| {
                let arms = terminator.exceptional_arms().iter().map(|arm| arm.target);
                distinct_targets(terminator.kind.targets().chain(arms))
            })
    }

    fn close_dead_current(&mut self, source: ir::SourceInfo) -> Result<(), FrontendError> {
        if self.block_is_open(self.current) {
            self.terminate_current(
                ir::TerminatorKind::Unreachable {
                    trap: ir::TrapCode::Unreachable,
                },
                source,
            )?;
        }
        Ok(())
    }

    fn reset_dead_stack(&mut self) {
        self.stack = self
            .control
            .last()
            .map(|frame| frame.prefix.clone())
            .unwrap_or_default();
    }

    fn set_region_end(&mut self, region: ir::RegionId, end: u64) {
        extend_source_end(&mut self.regions[region.index()].source, end);
    }

    /// Re-anchor a not-yet-activated continuation at its lexical boundary.
    /// Its opening construct supplied the provisional span, so moving the
    /// start forward may also need to move the end to keep the span valid.
    fn set_block_start(&mut self, block: ir::BlockId, start: u64) {
        let source = &mut self.blocks[block.index()].source;
        match &mut source.byte_span {
            Some(span) => {
                span.start = start;
                span.end = span.end.max(start);
            }
            None => source.byte_span = Some(ir::ByteSpan::new(start, start)),
        }
    }

    fn extend_block_source(&mut self, block: ir::BlockId, end: u64) {
        extend_source_end(&mut self.blocks[block.index()].source, end);
    }

    fn invariant(
        &self,
        offset: u64,
        operation: &'static str,
        detail: impl Into<String>,
    ) -> FrontendError {
        lowering_invariant(Some(self.function_index), offset, operation, detail)
    }

    fn finish(mut self) -> Result<ir::FunctionBody, FrontendError> {
        if !self.control.is_empty() {
            return Err(self.invariant(
                self.body_range.end,
                "function body",
                "the structured control stack was not fully closed",
            ));
        }

        for index in 0..self.blocks.len() {
            self.seal_block(ir::BlockId(index as u32))?;
        }

        let function_index = self.function_index;
        let mut blocks = Vec::with_capacity(self.blocks.len());
        for block in std::mem::take(&mut self.blocks) {
            let terminator = block.terminator.ok_or_else(|| {
                lowering_invariant(
                    Some(function_index),
                    source_start(block.source),
                    "function body",
                    format!("{} has no terminator", block.id),
                )
            })?;
            blocks.push(ir::Block {
                id: block.id,
                region: block.region,
                parameters: block.parameters,
                instructions: block.instructions,
                terminator,
                source: block.source,
            });
        }
        simplify_local_parameters(
            function_index,
            &mut blocks,
            &self.local_parameters,
            self.next_value,
        )?;

        Ok(ir::FunctionBody {
            entry: ir::BlockId(0),
            root_region: ir::RegionId(0),
            blocks,
            regions: self.regions,
        })
    }
}

/// The distinct targets of one transfer in first-occurrence order.
fn distinct_targets(targets: impl IntoIterator<Item = ir::BlockId>) -> Vec<ir::BlockId> {
    let mut seen = BTreeSet::new();
    targets
        .into_iter()
        .filter(|target| seen.insert(*target))
        .collect()
}

/// The diagnostic for a transfer whose argument count does not match the
/// parameters its target declares after the `leading` ones, if any.
fn arity_mismatch(
    site: impl FnOnce() -> String,
    supplied: usize,
    parameters: usize,
    leading: usize,
) -> Option<String> {
    (parameters.checked_sub(leading) != Some(supplied)).then(|| {
        format!(
            "{} supplies {supplied} values, expected {}",
            site(),
            parameters.saturating_sub(leading)
        )
    })
}

/// Where one deferred local read delivers its value.
enum LocalRead {
    /// The value answers the outermost read.
    Result,
    /// The value is the argument for the edge from the read's block to
    /// `target`, whose new local parameter triggered the read.
    Argument { target: ir::BlockId },
}

struct LocalParameter {
    block: usize,
    slot: usize,
    value: ir::ValueId,
    incoming: Vec<ir::ValueId>,
}

enum SiteArguments<'a> {
    Ordinary(&'a [ir::ValueId]),
    Exceptional(&'a [ir::ExceptionalArgument]),
}

impl SiteArguments<'_> {
    fn len(&self) -> usize {
        match self {
            Self::Ordinary(arguments) => arguments.len(),
            Self::Exceptional(arguments) => arguments.len(),
        }
    }

    /// The ordinary SSA value in `slot`, or `None` when the slot carries
    /// dispatch-produced provenance instead.
    fn value(&self, slot: usize) -> Option<ir::ValueId> {
        match self {
            Self::Ordinary(arguments) => arguments.get(slot).copied(),
            Self::Exceptional(arguments) => match arguments.get(slot) {
                Some(ir::ExceptionalArgument::Value(value)) => Some(*value),
                _ => None,
            },
        }
    }
}

/// Every local parameter of a function together with the arguments delivered
/// to it and the parameters that consume it.
struct LocalParameterIndex {
    function_index: u32,
    /// The range of `parameters` owned by each block.
    block_parameters: Vec<Range<usize>>,
    parameters: Vec<LocalParameter>,
    /// The parameter, if any, that each value defines.
    parameter_of_value: Vec<Option<u32>>,
    /// The parameters whose incoming arguments name each parameter.
    users: Vec<Vec<u32>>,
}

impl LocalParameterIndex {
    fn new(
        function_index: u32,
        blocks: &[ir::Block],
        local_parameters: &[Vec<(ir::LocalId, ir::ValueId)>],
        value_count: u32,
    ) -> Result<Self, FrontendError> {
        let mut index = Self {
            function_index,
            block_parameters: Vec::with_capacity(blocks.len()),
            parameters: Vec::new(),
            parameter_of_value: vec![None; value_count as usize],
            users: Vec::new(),
        };
        for (block_index, block) in blocks.iter().enumerate() {
            let locals = local_parameters
                .get(block_index)
                .map_or(&[][..], Vec::as_slice);
            let Some(structured) = block.parameters.len().checked_sub(locals.len()) else {
                return Err(index.invariant(
                    block,
                    format!(
                        "{} has {} local parameters but only {} parameters",
                        block.id,
                        locals.len(),
                        block.parameters.len()
                    ),
                ));
            };
            let start = index.parameters.len();
            for (position, &(_, value)) in locals.iter().enumerate() {
                let slot = structured + position;
                if block.parameters[slot].id != value {
                    return Err(index.invariant(
                        block,
                        format!(
                            "{} local parameter {value} is not parameter slot {slot}",
                            block.id
                        ),
                    ));
                }
                let Some(defines) = index.parameter_of_value.get_mut(value.index()) else {
                    return Err(index.invariant(
                        block,
                        format!(
                            "{} local parameter {value} is outside the value space",
                            block.id
                        ),
                    ));
                };
                *defines = Some(index.parameters.len() as u32);
                index.parameters.push(LocalParameter {
                    block: block_index,
                    slot,
                    value,
                    incoming: Vec::new(),
                });
            }
            index.block_parameters.push(start..index.parameters.len());
        }
        index.users = vec![Vec::new(); index.parameters.len()];
        Ok(index)
    }

    fn invariant(&self, block: &ir::Block, detail: String) -> FrontendError {
        lowering_invariant(
            Some(self.function_index),
            source_start(block.source),
            "local SSA parameter",
            detail,
        )
    }

    /// Records the arguments one edge occurrence or exceptional arm of
    /// `source` delivers to `target`.
    fn record(
        &mut self,
        blocks: &[ir::Block],
        source: &ir::Block,
        target: ir::BlockId,
        arguments: SiteArguments<'_>,
        leading: usize,
        site: &dyn Fn() -> String,
    ) -> Result<(), FrontendError> {
        let Some(block) = blocks.get(target.index()) else {
            return Err(self.invariant(source, format!("{} targets missing {target}", site())));
        };
        if let Some(detail) = arity_mismatch(site, arguments.len(), block.parameters.len(), leading)
        {
            return Err(self.invariant(source, detail));
        }
        for parameter in self.block_parameters[target.index()].clone() {
            let slot = self.parameters[parameter].slot;
            let Some(argument) = slot.checked_sub(leading) else {
                return Err(self.invariant(
                    source,
                    format!(
                        "{} local parameter slot {slot} lies within the invoke result prefix",
                        site()
                    ),
                ));
            };
            let Some(value) = arguments.value(argument) else {
                return Err(self.invariant(
                    source,
                    format!("{} local slot {slot} is not an ordinary SSA value", site()),
                ));
            };
            let Some(defines) = self.parameter_of_value.get(value.index()).copied() else {
                return Err(self.invariant(
                    source,
                    format!(
                        "{} local slot {slot} names {value} outside the value space",
                        site()
                    ),
                ));
            };
            self.parameters[parameter].incoming.push(value);
            if let Some(defines) = defines {
                self.users[defines as usize].push(parameter as u32);
            }
        }
        Ok(())
    }
}

/// Follows `alias` to the representative of `value`, compressing the path.
fn resolve_alias(alias: &mut [u32], value: u32) -> u32 {
    let mut root = value;
    while alias[root as usize] != root {
        root = alias[root as usize];
    }
    let mut current = value;
    while alias[current as usize] != root {
        let next = alias[current as usize];
        alias[current as usize] = root;
        current = next;
    }
    root
}

/// Removes every block parameter introduced for a local whose incoming
/// arguments all name one other value, following Braun et al.'s trivial-φ
/// elimination: a use-list worklist re-examines a parameter whenever one of
/// its incoming parameters is removed, so the pass is linear in the number of
/// edge arguments instead of rescanning the function once per parameter.
fn simplify_local_parameters(
    function_index: u32,
    blocks: &mut [ir::Block],
    local_parameters: &[Vec<(ir::LocalId, ir::ValueId)>],
    value_count: u32,
) -> Result<(), FrontendError> {
    let mut index =
        LocalParameterIndex::new(function_index, blocks, local_parameters, value_count)?;
    if index.parameters.is_empty() {
        return Ok(());
    }
    for block in blocks.iter() {
        let leading = block.terminator.kind.leading_parameters();
        for edge in block.terminator.kind.edges() {
            index.record(
                blocks,
                block,
                edge.target,
                SiteArguments::Ordinary(&edge.arguments),
                leading,
                &|| format!("edge from {} to {}", block.id, edge.target),
            )?;
        }
        if let Some(routing) = &block.terminator.exception {
            for arm in &routing.arms {
                index.record(
                    blocks,
                    block,
                    arm.target,
                    SiteArguments::Exceptional(&arm.arguments),
                    0,
                    &|| {
                        format!(
                            "exception route {}#{} from {} to {}",
                            arm.handler, arm.clause, block.id, arm.target
                        )
                    },
                )?;
            }
        }
    }

    let mut alias: Vec<u32> = (0..value_count).collect();
    let mut worklist: Vec<u32> = (0..index.parameters.len() as u32).rev().collect();
    let mut queued = vec![true; index.parameters.len()];
    let mut removed_any = false;
    while let Some(current) = worklist.pop() {
        queued[current as usize] = false;
        let parameter = &index.parameters[current as usize];
        let own = parameter.value.0;
        if resolve_alias(&mut alias, own) != own {
            continue;
        }
        let mut replacement = None;
        let mut trivial = true;
        for incoming in &parameter.incoming {
            let value = resolve_alias(&mut alias, incoming.0);
            if value == own {
                continue;
            }
            match replacement {
                None => replacement = Some(value),
                Some(existing) if existing == value => {}
                Some(_) => {
                    trivial = false;
                    break;
                }
            }
        }
        let Some(replacement) = replacement.filter(|_| trivial) else {
            continue;
        };
        alias[own as usize] = replacement;
        removed_any = true;
        for &user in &index.users[current as usize] {
            if !queued[user as usize] {
                queued[user as usize] = true;
                worklist.push(user);
            }
        }
    }
    if !removed_any {
        return Ok(());
    }
    let resolved: Vec<ir::ValueId> = (0..value_count)
        .map(|value| ir::ValueId(resolve_alias(&mut alias, value)))
        .collect();

    struct RemovalMask {
        removed: Vec<bool>,
        /// The number of removed slots below each slot.
        shift: Vec<u32>,
    }
    let mut masks: Vec<Option<RemovalMask>> = blocks.iter().map(|_| None).collect();
    for parameter in &index.parameters {
        if canonical_value(parameter.value, &resolved) == parameter.value {
            continue;
        }
        let mask = masks[parameter.block].get_or_insert_with(|| RemovalMask {
            removed: vec![false; blocks[parameter.block].parameters.len()],
            shift: Vec::new(),
        });
        mask.removed[parameter.slot] = true;
    }
    for mask in masks.iter_mut().flatten() {
        let mut removed_below = 0;
        mask.shift = mask
            .removed
            .iter()
            .map(|&removed| {
                let shift = removed_below;
                removed_below += u32::from(removed);
                shift
            })
            .collect();
    }
    /// Drops the items whose parameter slot, `leading` slots after the item
    /// index, was removed.
    fn retain_kept<T>(items: &mut Vec<T>, mask: &RemovalMask, leading: usize) {
        let mut slot = leading;
        items.retain(|_| {
            let removed = mask.removed.get(slot).copied().unwrap_or(false);
            slot += 1;
            !removed
        });
    }

    for (block, mask) in blocks.iter_mut().zip(&masks) {
        if let Some(mask) = mask {
            retain_kept(&mut block.parameters, mask, 0);
        }
    }
    for block in blocks.iter_mut() {
        let source = block.id;
        let offset = source_start(block.source);
        for instruction in &mut block.instructions {
            for operand in &mut instruction.operands {
                *operand = canonical_value(*operand, &resolved);
            }
        }
        rewrite_terminator_values(&mut block.terminator.kind, &resolved);
        let leading = block.terminator.kind.leading_parameters();
        for edge in block.terminator.kind.edges_mut() {
            let Some(mask) = masks.get(edge.target.index()).and_then(Option::as_ref) else {
                continue;
            };
            retain_kept(&mut edge.arguments, mask, leading);
            for refinement in &mut edge.refinements {
                let slot = &mut refinement.slot;
                match mask.removed.get(leading + *slot as usize) {
                    Some(true) => {
                        return Err(lowering_invariant(
                            Some(function_index),
                            offset,
                            "local SSA parameter",
                            format!(
                                "edge from {source} to {} refines removed parameter slot {slot}",
                                edge.target
                            ),
                        ));
                    }
                    Some(false) => *slot -= mask.shift[leading + *slot as usize],
                    None => {}
                }
            }
        }
        if let Some(routing) = &mut block.terminator.exception {
            for arm in &mut routing.arms {
                rewrite_exceptional_arguments(&mut arm.arguments, &resolved);
                if let Some(mask) = masks.get(arm.target.index()).and_then(Option::as_ref) {
                    retain_kept(&mut arm.arguments, mask, 0);
                }
            }
        }
    }
    Ok(())
}

fn canonical_value(value: ir::ValueId, resolved: &[ir::ValueId]) -> ir::ValueId {
    resolved.get(value.index()).copied().unwrap_or(value)
}

fn rewrite_exceptional_arguments(
    arguments: &mut [ir::ExceptionalArgument],
    resolved: &[ir::ValueId],
) {
    for argument in arguments {
        if let ir::ExceptionalArgument::Value(value) = argument {
            *value = canonical_value(*value, resolved);
        }
    }
}

fn rewrite_terminator_values(terminator: &mut ir::TerminatorKind, resolved: &[ir::ValueId]) {
    terminator.for_each_use_mut(|value| *value = canonical_value(*value, resolved));
}

fn structural_source(source: ir::SourceInfo) -> ir::SourceInfo {
    ir::SourceInfo {
        byte_span: source.byte_span,
        ordinal: None,
    }
}

fn source_start(source: ir::SourceInfo) -> u64 {
    source.byte_span.map_or(0, |span| span.start)
}

fn source_end(source: ir::SourceInfo) -> u64 {
    source.byte_span.map_or(0, |span| span.end)
}

fn extend_source_end(source: &mut ir::SourceInfo, end: u64) {
    if let Some(span) = &mut source.byte_span {
        span.end = span.end.max(end);
    }
}

fn binary_const_operation(opcode: CoreOpcode, ty: ir::ValueType) -> ir::Operation {
    ir::Operation::core(opcode, vec![ty.clone(), ty.clone()], vec![ty])
}

fn concrete_gc_ref(type_index: u32) -> ir::ValueType {
    ir::ValueType::Ref(ir::RefType {
        nullable: false,
        heap: ir::HeapType::Concrete(ir::TypeId(type_index)),
    })
}

fn apply_stack_signature(
    stack: &mut Vec<ir::ValueType>,
    signature: &ir::FunctionType,
    types: &[ir::TypeDefinition],
    function_index: Option<u32>,
    offset: u64,
    operation: &str,
) -> Result<(), FrontendError> {
    if stack.len() < signature.params.len() {
        return Err(lowering_invariant(
            function_index,
            offset,
            "operation operands",
            format!("{operation} underflows the operand stack"),
        ));
    }
    let actual = stack.split_off(stack.len() - signature.params.len());
    if actual.len() != signature.params.len()
        || !actual
            .iter()
            .zip(&signature.params)
            .all(|(actual, expected)| ir::is_value_subtype(types, actual, expected))
    {
        return Err(lowering_invariant(
            function_index,
            offset,
            "operation operands",
            format!(
                "{operation} received {actual:?}, expected {:?}",
                signature.params
            ),
        ));
    }
    stack.extend(signature.results.iter().cloned());
    Ok(())
}

fn source_span(range: Range<u64>) -> ir::SourceInfo {
    ir::SourceInfo {
        byte_span: Some(ir::ByteSpan::new(range.start, range.end)),
        ordinal: None,
    }
}

fn point_source(offset: u64) -> ir::SourceInfo {
    source_span(offset..offset)
}

fn lowering_invariant(
    function_index: Option<u32>,
    offset: u64,
    operation: &'static str,
    detail: impl Into<String>,
) -> FrontendError {
    FrontendError::LoweringInvariant {
        subject: function_index
            .map(|index| format!("function {index}"))
            .unwrap_or_else(|| "module expression".to_owned()),
        offset,
        operation,
        detail: detail.into(),
    }
}

/// A diagnostic produced while converting validated bytes into owned IR.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub(crate) enum FrontendError {
    #[error("invalid WebAssembly at byte {offset}: {message}")]
    InvalidWasm { message: String, offset: u64 },
    #[error("WebAssembly components are not supported")]
    UnsupportedEncoding,
    #[error("WebAssembly module header is missing")]
    MissingModuleHeader,
    #[error("wasmparser did not provide a validator for a function body")]
    MissingFunctionValidator,
    #[error("wasmparser did not retain the module's canonical type information")]
    MissingValidatorTypes,
    #[error("unsupported section {id} at byte {offset}")]
    UnsupportedSection { id: u8, offset: u64 },
    #[error("unsupported non-core parser payload")]
    UnsupportedPayload,
    #[error("unsupported non-standard feature at byte {offset}: {feature}")]
    UnsupportedFeature { feature: &'static str, offset: u64 },
    #[error("unsupported type index {index} at byte {offset}")]
    UnsupportedTypeIndex { index: String, offset: u64 },
    #[error(
        "type {type_index} used as a function signature at byte {offset} is missing or not a function type"
    )]
    InvalidFunctionType { type_index: u32, offset: u64 },
    #[error("missing {kind} index {index} referenced at byte {offset}")]
    InvalidEntityIndex {
        kind: &'static str,
        index: u32,
        offset: u64,
    },
    #[error("unexpected body for function {function_index}")]
    UnexpectedFunctionBody { function_index: u32 },
    #[error("defined function {function_index} has no body")]
    MissingFunctionBody { function_index: u32 },
    #[error("function {function_index} has no terminating end at byte {offset}")]
    MissingFunctionTerminator { function_index: u32, offset: u64 },
    #[error("unsupported operator in function {function_index} at byte {offset}: {operator}")]
    UnsupportedOperator {
        function_index: u32,
        offset: u64,
        operator: String,
    },
    #[error("unsupported constant-expression operator at byte {offset}: {operator}")]
    UnsupportedConstOperator { offset: u64, operator: String },
    #[error("could not lower {subject} at byte {offset} while reading {operation}: {detail}")]
    LoweringInvariant {
        subject: String,
        offset: u64,
        operation: &'static str,
        detail: String,
    },
    #[error("frontend produced invalid IR: {message}")]
    InvalidIr { message: String },
}

impl From<BinaryReaderError> for FrontendError {
    fn from(error: BinaryReaderError) -> Self {
        Self::InvalidWasm {
            message: error.message().to_owned(),
            offset: error.offset(),
        }
    }
}
