// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Emitting one core module from a [`Plan`].
//!
//! Every core module instance of the plan contributes its definitions to the
//! output, with each index space renumbered: an instance's imports resolve to
//! whatever the plan bound them to (another instance's export, a fused
//! adapter, or one of the imports the package leaves open), and its own
//! definitions land after those of the instances before it. Fused adapters
//! and a synthesized start function that runs every instance's start in
//! instantiation order come last.
//!
//! The output is a standard module: multiple memories are ordinary Core 3.0,
//! so the instances' memories simply coexist, and only the package's
//! unsatisfied imports remain as imports. When the package moves resource
//! handles, the handle table, its maintenance functions, the resource
//! built-ins, and wrappers for the host-facing edges are added after the
//! adapters and trampolines.

use std::collections::{BTreeSet, HashMap};
use std::fmt;

use anyhow::{Context, Result, anyhow, bail};
use wasm_encoder::reencode::{self, Reencode};
use wasm_encoder::{
    CodeSection, DataCountSection, DataSection, ElementSection, Elements, EntityType, ExportKind,
    ExportSection, Function, FunctionSection, GlobalSection, ImportSection, Instruction,
    MemorySection, MemoryType, Module, NameMap, NameSection, StartSection, TableSection,
    TagSection, TypeSection,
};
use wasmparser::{
    DataKind, ElementItems, ElementKind, KnownCustom, Name, Operator, Parser, Payload, TypeRef,
    Validator, WasmFeatures,
};

use crate::adapter::{self, Boundary, Environment, Handles, Party, ResourceInfo};
use crate::component::{Builtin, CoreKind, StringEncoding};
use crate::handles::{self, Runtime, Synthesized};
use crate::plan::{CoreExport, CoreFunc, CoreItem, Plan};
use crate::types::{CoreType, lower_signature};

#[derive(Clone, Copy, Debug, Default)]
struct Counts {
    funcs: u32,
    tables: u32,
    memories: u32,
    globals: u32,
    tags: u32,
}

impl Counts {
    fn get(&self, kind: CoreKind) -> u32 {
        match kind {
            CoreKind::Func => self.funcs,
            CoreKind::Table => self.tables,
            CoreKind::Memory => self.memories,
            CoreKind::Global => self.globals,
            CoreKind::Tag => self.tags,
        }
    }
}

struct ParsedModule<'a> {
    types: Vec<wasmparser::RecGroup>,
    type_count: u32,
    imports: Vec<wasmparser::Import<'a>>,
    imported: Counts,
    func_types: Vec<u32>,
    tables: Vec<wasmparser::Table<'a>>,
    memories: Vec<wasmparser::MemoryType>,
    tags: Vec<wasmparser::TagType>,
    globals: Vec<wasmparser::Global<'a>>,
    exports: Vec<wasmparser::Export<'a>>,
    start: Option<u32>,
    elements: Vec<wasmparser::Element<'a>>,
    data: Vec<wasmparser::Data<'a>>,
    code: Vec<wasmparser::FunctionBody<'a>>,
    func_names: HashMap<u32, String>,
}

impl ParsedModule<'_> {
    fn defined(&self) -> Counts {
        Counts {
            funcs: self.code.len() as u32,
            tables: self.tables.len() as u32,
            memories: self.memories.len() as u32,
            globals: self.globals.len() as u32,
            tags: self.tags.len() as u32,
        }
    }
}

fn import_kind(ty: &TypeRef) -> Result<CoreKind> {
    Ok(match ty {
        TypeRef::Func(_) => CoreKind::Func,
        TypeRef::Table(_) => CoreKind::Table,
        TypeRef::Memory(_) => CoreKind::Memory,
        TypeRef::Global(_) => CoreKind::Global,
        TypeRef::Tag(_) => CoreKind::Tag,
        other => bail!("unsupported import kind {other:?}"),
    })
}

fn export_kind(kind: wasmparser::ExternalKind) -> Option<CoreKind> {
    CoreKind::from_external(kind).ok()
}

fn parse_module(bytes: &[u8]) -> Result<ParsedModule<'_>> {
    let mut module = ParsedModule {
        types: Vec::new(),
        type_count: 0,
        imports: Vec::new(),
        imported: Counts::default(),
        func_types: Vec::new(),
        tables: Vec::new(),
        memories: Vec::new(),
        tags: Vec::new(),
        globals: Vec::new(),
        exports: Vec::new(),
        start: None,
        elements: Vec::new(),
        data: Vec::new(),
        code: Vec::new(),
        func_names: HashMap::new(),
    };
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::TypeSection(reader) => {
                for group in reader {
                    let group = group?;
                    module.type_count += group.types().count() as u32;
                    module.types.push(group);
                }
            }
            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    let import = import?;
                    match import_kind(&import.ty)? {
                        CoreKind::Func => module.imported.funcs += 1,
                        CoreKind::Table => module.imported.tables += 1,
                        CoreKind::Memory => module.imported.memories += 1,
                        CoreKind::Global => module.imported.globals += 1,
                        CoreKind::Tag => module.imported.tags += 1,
                    }
                    module.imports.push(import);
                }
            }
            Payload::FunctionSection(reader) => {
                for ty in reader {
                    module.func_types.push(ty?);
                }
            }
            Payload::TableSection(reader) => {
                for table in reader {
                    module.tables.push(table?);
                }
            }
            Payload::MemorySection(reader) => {
                for memory in reader {
                    module.memories.push(memory?);
                }
            }
            Payload::TagSection(reader) => {
                for tag in reader {
                    module.tags.push(tag?);
                }
            }
            Payload::GlobalSection(reader) => {
                for global in reader {
                    module.globals.push(global?);
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    module.exports.push(export?);
                }
            }
            Payload::StartSection { func, .. } => module.start = Some(func),
            Payload::ElementSection(reader) => {
                for element in reader {
                    module.elements.push(element?);
                }
            }
            Payload::DataSection(reader) => {
                for datum in reader {
                    module.data.push(datum?);
                }
            }
            Payload::CodeSectionEntry(body) => module.code.push(body),
            Payload::CustomSection(reader) => {
                if let KnownCustom::Name(names) = reader.as_known() {
                    for name in names {
                        if let Name::Function(map) = name? {
                            for naming in map {
                                let naming = naming?;
                                module
                                    .func_names
                                    .insert(naming.index, naming.name.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if module.func_types.len() != module.code.len() {
        bail!(
            "module declares {} functions but defines {}",
            module.func_types.len(),
            module.code.len()
        );
    }
    Ok(module)
}

/// Output indices of the first definition of each kind an instance owns.
#[derive(Clone, Copy, Debug, Default)]
struct Bases {
    func: u32,
    table: u32,
    memory: u32,
    global: u32,
    tag: u32,
    ty: u32,
    data: u32,
    elem: u32,
}

impl Bases {
    fn get(&self, kind: CoreKind) -> u32 {
        match kind {
            CoreKind::Func => self.func,
            CoreKind::Table => self.table,
            CoreKind::Memory => self.memory,
            CoreKind::Global => self.global,
            CoreKind::Tag => self.tag,
        }
    }
}

#[derive(Debug)]
struct RemapError(String);

impl fmt::Display for RemapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RemapError {}

/// Renumbers one instance's index spaces into the output module.
struct Remap {
    funcs: Vec<u32>,
    tables: Vec<u32>,
    memories: Vec<u32>,
    globals: Vec<u32>,
    tags: Vec<u32>,
    ty: u32,
    data: u32,
    elem: u32,
}

fn lookup(space: &[u32], index: u32, what: &str) -> Result<u32, reencode::Error<RemapError>> {
    space.get(index as usize).copied().ok_or_else(|| {
        reencode::Error::UserError(RemapError(format!("{what} index {index} is out of range")))
    })
}

impl Reencode for Remap {
    type Error = RemapError;

    fn function_index(&mut self, func: u32) -> Result<u32, reencode::Error<RemapError>> {
        lookup(&self.funcs, func, "function")
    }

    fn table_index(&mut self, table: u32) -> Result<u32, reencode::Error<RemapError>> {
        lookup(&self.tables, table, "table")
    }

    fn memory_index(&mut self, memory: u32) -> Result<u32, reencode::Error<RemapError>> {
        lookup(&self.memories, memory, "memory")
    }

    fn global_index(&mut self, global: u32) -> Result<u32, reencode::Error<RemapError>> {
        lookup(&self.globals, global, "global")
    }

    fn tag_index(&mut self, tag: u32) -> Result<u32, reencode::Error<RemapError>> {
        lookup(&self.tags, tag, "tag")
    }

    fn type_index(&mut self, ty: u32) -> Result<u32, reencode::Error<RemapError>> {
        Ok(self.ty + ty)
    }

    fn data_index(&mut self, data: u32) -> Result<u32, reencode::Error<RemapError>> {
        Ok(self.data + data)
    }

    fn element_index(&mut self, element: u32) -> Result<u32, reencode::Error<RemapError>> {
        Ok(self.elem + element)
    }
}

impl Remap {
    /// Emit a segment offset in a function, without the const expression's end.
    fn emit_offset(&mut self, body: &mut Function, expr: &wasmparser::ConstExpr<'_>) -> Result<()> {
        let mut operators = expr.get_operators_reader();
        while !operators.eof() {
            let op = operators.read()?;
            if !matches!(op, Operator::End) {
                body.instruction(&self.instruction(op)?);
            }
        }
        Ok(())
    }

    /// Active segments become passive in the output, then initialize and drop
    /// at their original instantiation point, immediately before its start.
    fn initialize_segments(
        &mut self,
        body: &mut Function,
        module: &ParsedModule<'_>,
    ) -> Result<()> {
        for (index, element) in module.elements.iter().enumerate() {
            if let ElementKind::Active {
                table_index,
                offset_expr,
            } = &element.kind
            {
                let count = match &element.items {
                    ElementItems::Functions(items) => items.count(),
                    ElementItems::Expressions(_, items) => items.count(),
                };
                let elem_index = self.element_index(index as u32)?;
                self.emit_offset(body, offset_expr)?;
                body.instruction(&Instruction::I32Const(0));
                body.instruction(&Instruction::I32Const(count as i32));
                body.instruction(&Instruction::TableInit {
                    elem_index,
                    table: self.table_index(table_index.unwrap_or(0))?,
                });
                body.instruction(&Instruction::ElemDrop(elem_index));
            }
        }
        for (index, datum) in module.data.iter().enumerate() {
            if let DataKind::Active {
                memory_index,
                offset_expr,
            } = &datum.kind
            {
                let data_index = self.data_index(index as u32)?;
                self.emit_offset(body, offset_expr)?;
                body.instruction(&Instruction::I32Const(0));
                body.instruction(&Instruction::I32Const(datum.data.len() as i32));
                body.instruction(&Instruction::MemoryInit {
                    mem: self.memory_index(*memory_index)?,
                    data_index,
                });
                body.instruction(&Instruction::DataDrop(data_index));
            }
        }
        Ok(())
    }
}

struct Merger<'a> {
    plan: &'a Plan,
    modules: Vec<ParsedModule<'a>>,
    bases: Vec<Bases>,
    /// For each adapter, its output function index when it is emitted, or
    /// `None` when it binds straight to its callee.
    adapter_slots: Vec<Option<u32>>,
    /// Output index of the first import trampoline.
    trampoline_base: u32,
    /// Output index of the first resource built-in.
    builtin_base: u32,
}

impl<'a> Merger<'a> {
    fn module(&self, instance: usize) -> &ParsedModule<'a> {
        &self.modules[self.plan.instances[instance].module]
    }

    fn export_local(&self, export: &CoreExport, kind: CoreKind) -> Result<u32> {
        let module = self.module(export.instance);
        module
            .exports
            .iter()
            .find(|candidate| {
                candidate.name == export.name && export_kind(candidate.kind) == Some(kind)
            })
            .map(|candidate| candidate.index)
            .ok_or_else(|| {
                anyhow!(
                    "instance `{}` has no {} export `{}`",
                    self.plan.instances[export.instance].name,
                    kind.describe(),
                    export.name
                )
            })
    }

    fn resolve_local(&self, instance: usize, kind: CoreKind, local: u32) -> Result<u32> {
        let module = self.module(instance);
        let imported = module.imported.get(kind);
        if local < imported {
            let mut seen = 0;
            for (position, import) in module.imports.iter().enumerate() {
                if import_kind(&import.ty)? != kind {
                    continue;
                }
                if seen == local {
                    let arg = &self.plan.instances[instance].args[position];
                    return self.resolve_item(&arg.item);
                }
                seen += 1;
            }
            unreachable!("an import index below the import count names an import");
        }
        Ok(self.bases[instance].get(kind) + (local - imported))
    }

    fn resolve_export(&self, export: &CoreExport, kind: CoreKind) -> Result<u32> {
        let local = self.export_local(export, kind)?;
        self.resolve_local(export.instance, kind, local)
    }

    fn resolve_item(&self, item: &CoreItem) -> Result<u32> {
        match item {
            CoreItem::Func(func) => self.resolve_func(func),
            CoreItem::Table(export) => self.resolve_export(export, CoreKind::Table),
            CoreItem::Memory(export) => self.resolve_export(export, CoreKind::Memory),
            CoreItem::Global(export) => self.resolve_export(export, CoreKind::Global),
        }
    }

    fn resolve_func(&self, func: &CoreFunc) -> Result<u32> {
        match func {
            CoreFunc::Export(export) => self.resolve_export(export, CoreKind::Func),
            CoreFunc::Adapter(index) => match self.adapter_slots[*index] {
                Some(slot) => Ok(slot),
                None => self.resolve_func(&self.plan.adapters[*index].callee),
            },
            // Every use of an import goes through its trampoline, so the
            // import itself is never referenced from a table or `ref.func`.
            // wasm2c passes a table-called import the address of its
            // instance slot rather than the instance, which this sidesteps.
            CoreFunc::Import(index) => Ok(self.trampoline_base + *index as u32),
            CoreFunc::Builtin(index) => Ok(self.builtin_base + *index as u32),
        }
    }

    fn remap(&self, instance: usize) -> Result<Remap> {
        let module = self.module(instance);
        let defined = module.defined();
        let space = |kind: CoreKind| -> Result<Vec<u32>> {
            (0..module.imported.get(kind) + defined.get(kind))
                .map(|local| self.resolve_local(instance, kind, local))
                .collect()
        };
        let bases = self.bases[instance];
        Ok(Remap {
            funcs: space(CoreKind::Func)?,
            tables: space(CoreKind::Table)?,
            memories: space(CoreKind::Memory)?,
            globals: space(CoreKind::Global)?,
            tags: space(CoreKind::Tag)?,
            ty: bases.ty,
            data: bases.data,
            elem: bases.elem,
        })
    }

    /// Expose the canonical memory and allocator alongside a raw host ABI.
    fn export_memory_options(
        &self,
        exports: &mut ExportSection,
        prefix: &str,
        memory: &Option<CoreExport>,
        realloc: &Option<CoreFunc>,
    ) -> Result<()> {
        if let Some(memory) = memory {
            exports.export(
                &format!("{prefix}:memory"),
                ExportKind::Memory,
                self.resolve_export(memory, CoreKind::Memory)?,
            );
        }
        if let Some(realloc) = realloc {
            exports.export(
                &format!("{prefix}:realloc"),
                ExportKind::Func,
                self.resolve_func(realloc)?,
            );
        }
        Ok(())
    }
}

/// Adds a function type and returns its index. `count` is the number of
/// types added so far: a recursive type group is one section entry but
/// several types, so `TypeSection::len` would undercount after a module
/// with GC types.
fn function_type(
    types: &mut TypeSection,
    count: &mut u32,
    params: &[CoreType],
    results: &[CoreType],
) -> u32 {
    let index = *count;
    types.ty().function(
        params.iter().map(|ty| ty.encode()),
        results.iter().map(|ty| ty.encode()),
    );
    *count += 1;
    index
}

/// A function the linker adds to the output, in index order after the
/// instances' own definitions.
struct Addition {
    name: String,
    params: Vec<CoreType>,
    results: Vec<CoreType>,
    body: Function,
}

impl From<(String, Synthesized)> for Addition {
    fn from((name, synthesized): (String, Synthesized)) -> Addition {
        Addition {
            name,
            params: synthesized.params,
            results: synthesized.results,
            body: synthesized.body,
        }
    }
}

impl From<(String, adapter::Emitted)> for Addition {
    fn from((name, emitted): (String, adapter::Emitted)) -> Addition {
        Addition {
            name,
            params: emitted.params,
            results: emitted.results,
            body: emitted.body,
        }
    }
}

/// Whether anything in the plan moves a resource handle, and so needs the
/// handle table.
fn uses_handles(plan: &Plan) -> bool {
    !plan.builtins.is_empty()
        || plan
            .adapters
            .iter()
            .any(|adapter| adapter::edge_needs_adapter(&adapter.ty))
        || plan
            .imports
            .iter()
            .any(|import| adapter::edge_needs_adapter(&import.ty))
        || plan
            .exports
            .iter()
            .any(|export| adapter::edge_needs_adapter(&export.ty))
}

/// Emits the linked module described by `plan` and validates it.
pub fn merge(plan: &Plan) -> Result<Vec<u8>> {
    let mut modules = Vec::with_capacity(plan.modules.len());
    for (index, bytes) in plan.modules.iter().enumerate() {
        modules.push(parse_module(bytes).with_context(|| format!("parsing core module {index}"))?);
    }

    let mut bases = Vec::with_capacity(plan.instances.len());
    let mut next = Bases {
        func: plan.imports.len() as u32,
        ..Bases::default()
    };
    for instance in &plan.instances {
        let module = &modules[instance.module];
        let defined = module.defined();
        bases.push(next);
        next.func += defined.funcs;
        next.table += defined.tables;
        next.memory += defined.memories;
        next.global += defined.globals;
        next.tag += defined.tags;
        next.ty += module.type_count;
        next.data += module.data.len() as u32;
        next.elem += module.elements.len() as u32;
    }

    // Everything the linker adds follows the instances' own functions.
    let first_addition = next.func;
    let mut adapter_slots = Vec::with_capacity(plan.adapters.len());
    for adapter in &plan.adapters {
        let direct = adapter.lift.post_return.is_none() && adapter::is_passthrough(&adapter.ty);
        if direct {
            adapter_slots.push(None);
        } else {
            adapter_slots.push(Some(next.func));
            next.func += 1;
        }
    }
    let trampoline_base = next.func;
    next.func += plan.imports.len() as u32;
    // The handle table's memory follows every instance's memories; its
    // maintenance functions follow the trampolines.
    let runtime = uses_handles(plan).then(|| {
        let runtime = Runtime {
            memory: next.memory,
            add: next.func,
            get: next.func + 1,
            free: next.func + 2,
        };
        next.func += 3;
        runtime
    });
    let builtin_base = next.func;
    next.func += plan.builtins.len() as u32;
    let mut wrapper_slots = Vec::with_capacity(plan.exports.len());
    for export in &plan.exports {
        if adapter::edge_needs_adapter(&export.ty) {
            wrapper_slots.push(Some(next.func));
            next.func += 1;
        } else {
            wrapper_slots.push(None);
        }
    }
    let resource_export_base = next.func;
    next.func += plan.resource_exports.len() as u32;
    let start_index = plan
        .instances
        .iter()
        .any(|instance| modules[instance.module].start.is_some())
        .then_some(next.func);
    if start_index.is_some() {
        next.func += 1;
    }
    // Without any starts, retaining active segments preserves initialization
    // order. Otherwise they must execute between the original starts.
    let defer_segments = start_index.is_some();

    let merger = Merger {
        plan,
        modules,
        bases,
        adapter_slots,
        trampoline_base,
        builtin_base,
    };
    let resource_infos: Vec<ResourceInfo> = plan
        .resources
        .iter()
        .map(|resource| ResourceInfo {
            owner: resource.owner.map(|frame| frame as u32),
        })
        .collect();
    let handles = runtime.map(|runtime| Handles {
        runtime,
        resources: &resource_infos,
    });
    let host = Party {
        frame: None,
        memory: None,
        realloc: None,
        encoding: StringEncoding::Utf8,
    };

    // A component with a single memory exports it under its own name, which
    // is what a host wants to reach for; anything else is named per instance.
    let mut component_memories: HashMap<&str, usize> = HashMap::new();
    for (index, instance) in plan.instances.iter().enumerate() {
        *component_memories
            .entry(instance.component.as_str())
            .or_default() += merger.module(index).memories.len();
    }
    let memory_name = |index: usize, local: usize| -> String {
        let instance = &plan.instances[index];
        let count = merger.module(index).memories.len();
        if component_memories[instance.component.as_str()] == 1 {
            format!("{}:memory", instance.component)
        } else if count == 1 {
            format!("{}:memory", instance.name)
        } else {
            format!("{}:memory{local}", instance.name)
        }
    };

    let mut types = TypeSection::new();
    let mut imports = ImportSection::new();
    let mut functions = FunctionSection::new();
    let mut tables = TableSection::new();
    let mut memories = MemorySection::new();
    let mut tags = TagSection::new();
    let mut globals = GlobalSection::new();
    let mut exports = ExportSection::new();
    let mut elements = ElementSection::new();
    let mut code = CodeSection::new();
    let mut data = DataSection::new();
    let mut function_names = NameMap::new();
    let mut memory_names = NameMap::new();

    let mut remaps = Vec::with_capacity(plan.instances.len());
    for index in 0..plan.instances.len() {
        remaps.push(merger.remap(index).with_context(|| {
            format!("resolving the imports of `{}`", plan.instances[index].name)
        })?);
    }

    let mut type_count: u32 = 0;
    for index in 0..plan.instances.len() {
        let module = merger.module(index);
        let remap = &mut remaps[index];
        for group in &module.types {
            type_count += group.types().count() as u32;
            remap.parse_recursive_type_group(types.ty(), group.clone())?;
        }
    }

    for (index, import) in plan.imports.iter().enumerate() {
        let signature = lower_signature(&import.ty);
        let ty = function_type(
            &mut types,
            &mut type_count,
            &signature.params,
            &signature.results,
        );
        imports.import(&import.module, &import.name, EntityType::Function(ty));
        function_names.append(index as u32, &format!("{}#{}", import.module, import.name));
        merger.export_memory_options(
            &mut exports,
            &format!("wlink:import:{}#{}", import.module, import.name),
            &import.lower.memory,
            &import.lower.realloc,
        )?;
    }

    for (index, instance) in plan.instances.iter().enumerate() {
        let module = merger.module(index);
        let remap = &mut remaps[index];
        let bases = merger.bases[index];
        for (local, ty) in module.func_types.iter().enumerate() {
            functions.function(remap.type_index(*ty)?);
            let local_index = module.imported.funcs + local as u32;
            let name = match module.func_names.get(&local_index) {
                Some(name) => format!("{}.{name}", instance.name),
                None => format!("{}.func{local}", instance.name),
            };
            function_names.append(bases.func + local as u32, &name);
        }
        for table in &module.tables {
            remap.parse_table(&mut tables, table.clone())?;
        }
        for (local, memory) in module.memories.iter().enumerate() {
            memories.memory(remap.memory_type(*memory)?);
            memory_names.append(bases.memory + local as u32, &memory_name(index, local));
        }
        for tag in &module.tags {
            tags.tag(remap.tag_type(*tag)?);
        }
        for global in &module.globals {
            remap.parse_global(&mut globals, global.clone())?;
        }
    }
    if let Some(runtime) = runtime {
        // One page holds the header and the first entries; the table grows
        // by a page whenever it fills.
        memories.memory(MemoryType {
            minimum: 1,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        memory_names.append(runtime.memory, "wlink:handles");
    }

    let memory = |export: &Option<CoreExport>| -> Result<Option<u32>> {
        export
            .as_ref()
            .map(|export| merger.resolve_export(export, CoreKind::Memory))
            .transpose()
    };
    let func = |func: &Option<CoreFunc>| -> Result<Option<u32>> {
        func.as_ref()
            .map(|func| merger.resolve_func(func))
            .transpose()
    };

    let mut additions: Vec<Addition> = Vec::new();
    for (index, adapter) in plan.adapters.iter().enumerate() {
        if merger.adapter_slots[index].is_none() {
            continue;
        }
        let env = Environment {
            boundary: Boundary::Fused,
            callee: merger.resolve_func(&adapter.callee)?,
            caller: Party {
                frame: Some(adapter.caller_frame as u32),
                memory: memory(&adapter.lower.memory)?,
                realloc: func(&adapter.lower.realloc)?,
                encoding: adapter.lower.encoding,
            },
            target: Party {
                frame: Some(adapter.callee_frame as u32),
                memory: memory(&adapter.lift.memory)?,
                realloc: func(&adapter.lift.realloc)?,
                encoding: adapter.lift.encoding,
            },
            post_return: func(&adapter.lift.post_return)?,
            handles,
        };
        let emitted = adapter::emit(&adapter.name, &adapter.ty, &env)
            .with_context(|| format!("generating the adapter for `{}`", adapter.name))?;
        additions.push((format!("adapter#{}", adapter.name), emitted).into());
    }

    for (index, import) in plan.imports.iter().enumerate() {
        let name = format!("trampoline#{}#{}", import.module, import.name);
        if adapter::edge_needs_adapter(&import.ty) {
            let env = Environment {
                boundary: Boundary::Import,
                callee: index as u32,
                caller: Party {
                    frame: Some(import.frame as u32),
                    memory: memory(&import.lower.memory)?,
                    realloc: func(&import.lower.realloc)?,
                    encoding: import.lower.encoding,
                },
                target: host,
                post_return: None,
                handles,
            };
            let emitted = adapter::emit(&import.name, &import.ty, &env)
                .with_context(|| format!("generating the trampoline for `{}`", import.name))?;
            additions.push((name, emitted).into());
        } else {
            let signature = lower_signature(&import.ty);
            let mut body = Function::new([]);
            for param in 0..signature.params.len() as u32 {
                body.instruction(&Instruction::LocalGet(param));
            }
            body.instruction(&Instruction::Call(index as u32));
            body.instruction(&Instruction::End);
            additions.push(Addition {
                name,
                params: signature.params,
                results: signature.results,
                body,
            });
        }
    }

    if let Some(runtime) = runtime {
        additions.push(("wlink#handle.add".to_string(), handles::add(runtime)).into());
        additions.push(("wlink#handle.get".to_string(), handles::get(runtime)).into());
        additions.push(("wlink#handle.free".to_string(), handles::free(runtime)).into());
    }
    for builtin in &plan.builtins {
        let runtime = runtime.expect("a built-in implies the handle table");
        let resource = &plan.resources[builtin.resource];
        let (frame, index) = (builtin.frame as u32, builtin.resource as u32);
        let synthesized = match builtin.kind {
            Builtin::ResourceNew => handles::resource_new(runtime, frame, index),
            Builtin::ResourceRep => handles::resource_rep(runtime, frame, index),
            Builtin::ResourceDrop => {
                let dtor = match resource.owner {
                    Some(_) => func(&resource.dtor)?,
                    None => resource
                        .host_drop
                        .map(|import| merger.resolve_func(&CoreFunc::Import(import)))
                        .transpose()?,
                };
                handles::resource_drop(runtime, frame, index, dtor)
            }
        };
        let name = format!(
            "{}#{}#{}",
            builtin.kind.describe(),
            plan.frames[builtin.frame].name,
            resource.name
        );
        additions.push((name, synthesized).into());
    }
    for (index, export) in plan.exports.iter().enumerate() {
        if wrapper_slots[index].is_none() {
            continue;
        }
        let env = Environment {
            boundary: Boundary::Export,
            callee: merger.resolve_func(&export.func)?,
            caller: host,
            target: Party {
                frame: Some(export.frame as u32),
                memory: memory(&export.lift.memory)?,
                realloc: func(&export.lift.realloc)?,
                encoding: export.lift.encoding,
            },
            post_return: None,
            handles,
        };
        let emitted = adapter::emit(&export.name, &export.ty, &env)
            .with_context(|| format!("generating the export wrapper for `{}`", export.name))?;
        additions.push((format!("export#{}", export.name), emitted).into());
    }
    for resource_export in &plan.resource_exports {
        let resource = &plan.resources[resource_export.resource];
        let dtor = func(&resource.dtor)?;
        additions.push(
            (
                format!("resource-drop#{}", resource_export.name),
                handles::host_facing_drop(dtor),
            )
                .into(),
        );
    }

    if start_index.is_some() {
        let mut body = Function::new([]);
        for index in 0..plan.instances.len() {
            remaps[index].initialize_segments(&mut body, merger.module(index))?;
            if let Some(local) = merger.module(index).start {
                body.instruction(&Instruction::Call(merger.resolve_local(
                    index,
                    CoreKind::Func,
                    local,
                )?));
            }
        }
        body.instruction(&Instruction::End);
        additions.push(Addition {
            name: "wlink#start".to_string(),
            params: Vec::new(),
            results: Vec::new(),
            body,
        });
    }
    if first_addition + additions.len() as u32 != next.func {
        bail!(
            "the linker planned {} functions after the instances' own but generated {}",
            next.func - first_addition,
            additions.len()
        );
    }
    for (offset, addition) in additions.iter().enumerate() {
        let ty = function_type(
            &mut types,
            &mut type_count,
            &addition.params,
            &addition.results,
        );
        functions.function(ty);
        function_names.append(first_addition + offset as u32, &addition.name);
    }

    for (index, export) in plan.exports.iter().enumerate() {
        let target = match wrapper_slots[index] {
            Some(wrapper) => wrapper,
            None => merger.resolve_func(&export.func)?,
        };
        exports.export(&export.name, ExportKind::Func, target);
        merger.export_memory_options(
            &mut exports,
            &format!("wlink:export:{}", export.name),
            &export.lift.memory,
            &export.lift.realloc,
        )?;
        // The host must read a result before cleanup can reclaim its storage.
        if let Some(post_return) = &export.lift.post_return {
            exports.export(
                &format!("cabi_post_{}", export.name),
                ExportKind::Func,
                merger.resolve_func(post_return)?,
            );
        }
    }
    for (index, resource_export) in plan.resource_exports.iter().enumerate() {
        exports.export(
            &resource_export.name,
            ExportKind::Func,
            resource_export_base + index as u32,
        );
    }
    for index in 0..plan.instances.len() {
        for local in 0..merger.module(index).memories.len() {
            exports.export(
                &memory_name(index, local),
                ExportKind::Memory,
                merger.bases[index].memory + local as u32,
            );
        }
    }
    if let Some(runtime) = runtime {
        exports.export("wlink:handles", ExportKind::Memory, runtime.memory);
    }

    let mut data_count = 0;
    let mut declared_functions = BTreeSet::new();
    for index in 0..plan.instances.len() {
        let module = merger.module(index);
        let remap = &mut remaps[index];
        for element in &module.elements {
            let mut element = element.clone();
            if defer_segments && matches!(element.kind, ElementKind::Active { .. }) {
                element.kind = ElementKind::Passive;
            }
            remap.parse_element(&mut elements, element)?;
        }
        for body in &module.code {
            remap.parse_function_body(&mut code, body.clone())?;
        }
        for datum in &module.data {
            let mut datum = datum.clone();
            if defer_segments && matches!(datum.kind, DataKind::Active { .. }) {
                datum.kind = DataKind::Passive;
            }
            remap.parse_data(&mut data, datum)?;
            data_count += 1;
        }
        // A core function export also declares that function for ref.func.
        // Most core exports disappear during linking, but their declarations
        // must survive (including those remapped to adapters or trampolines).
        for export in &module.exports {
            if export_kind(export.kind) == Some(CoreKind::Func) {
                declared_functions.insert(remap.function_index(export.index)?);
            }
        }
    }
    // Append after the original segments so their indices do not change.
    if !declared_functions.is_empty() {
        elements.declared(Elements::Functions(
            declared_functions.into_iter().collect::<Vec<_>>().into(),
        ));
    }
    for addition in &additions {
        code.function(&addition.body);
    }

    let mut names = NameSection::new();
    names.module("wlink");
    names.functions(&function_names);
    names.memories(&memory_names);

    let mut module = Module::new();
    module.section(&types);
    if !plan.imports.is_empty() {
        module.section(&imports);
    }
    module.section(&functions);
    if !tables.is_empty() {
        module.section(&tables);
    }
    if !memories.is_empty() {
        module.section(&memories);
    }
    if !tags.is_empty() {
        module.section(&tags);
    }
    if !globals.is_empty() {
        module.section(&globals);
    }
    module.section(&exports);
    if let Some(start) = start_index {
        module.section(&StartSection {
            function_index: start,
        });
    }
    if !elements.is_empty() {
        module.section(&elements);
    }
    if data_count > 0 {
        module.section(&DataCountSection { count: data_count });
    }
    module.section(&code);
    if data_count > 0 {
        module.section(&data);
    }
    module.section(&names);

    let bytes = module.finish();
    Validator::new_with_features(WasmFeatures::all())
        .validate_all(&bytes)
        .context("the linked module does not validate")?;
    Ok(bytes)
}
