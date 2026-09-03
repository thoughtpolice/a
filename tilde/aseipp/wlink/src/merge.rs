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
//!
//! When anything in the package is async, the async runtime (`tasks.rs`)
//! is spliced in after the resource built-ins, as one more instance whose
//! imports the linker supplies: the handle table, and the dispatchers,
//! thunks and copies it generates for the package. Its state memory and
//! globals follow everything else's.

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
use crate::component::{AsyncBuiltin, Builtin, CoreKind, StringEncoding};
use crate::handles::{self, Runtime, Synthesized};
use crate::plan::{CoreExport, CoreFunc, CoreItem, Plan};
use crate::tasks::{self, AsyncLink, AsyncRuntime, Call, SiteKind, SiteThunks};
use crate::types::{CoreType, async_lift_signature, lower_signature};

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
    /// Output index of the first async built-in.
    async_builtin_base: u32,
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
            CoreFunc::Async(index) => Ok(self.async_builtin_base + *index as u32),
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
    /// A type already in the type section, for a spliced function.
    ty: Option<u32>,
}

impl From<(String, Synthesized)> for Addition {
    fn from((name, synthesized): (String, Synthesized)) -> Addition {
        Addition {
            name,
            params: synthesized.params,
            results: synthesized.results,
            body: synthesized.body,
            ty: None,
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
            ty: None,
        }
    }
}

fn core_type(ty: wasmparser::ValType) -> Result<CoreType> {
    Ok(match ty {
        wasmparser::ValType::I32 => CoreType::I32,
        wasmparser::ValType::I64 => CoreType::I64,
        wasmparser::ValType::F32 => CoreType::F32,
        wasmparser::ValType::F64 => CoreType::F64,
        other => bail!("the async runtime has a {other:?}"),
    })
}

/// The async runtime's module and where its pieces land in the output.
struct Spliced<'a> {
    module: ParsedModule<'a>,
    /// Its function types, by type index.
    signatures: Vec<(Vec<CoreType>, Vec<CoreType>)>,
    func_base: u32,
    global_base: u32,
    memory: u32,
}

impl Spliced<'_> {
    fn export(&self, name: &str, kind: CoreKind) -> Result<u32> {
        let export = self
            .module
            .exports
            .iter()
            .find(|export| export.name == name && export_kind(export.kind) == Some(kind))
            .ok_or_else(|| anyhow!("the async runtime exports no `{name}`"))?;
        Ok(match kind {
            CoreKind::Func => self.func_base + export.index - self.module.imported.funcs,
            CoreKind::Global => self.global_base + export.index,
            _ => unreachable!("the runtime exports functions and globals"),
        })
    }
}

/// Where the functions generated around the async runtime go.
struct AsyncSlots {
    callback: u32,
    start: u32,
    resolve: u32,
    host_resolve: u32,
    copy: u32,
    /// The host's functions, or stand-ins when the host has none to offer.
    wait: u32,
    cancel: u32,
    task_cancelled: u32,
    event: u32,
    /// The host's frame, and the side of its buffers of each type.
    host_frame: u32,
    host_side: u32,
    /// Each site's start thunk, and its resolve thunk when it has a callback.
    starts: Vec<u32>,
    resolves: Vec<Option<u32>>,
    /// Each host import site's thunk for the result the host wrote.
    host_resolves: Vec<u32>,
    /// For each writer side and reader side of one type whose elements
    /// convert, the copy between them.
    pair_copies: Vec<Vec<Option<u32>>>,
}

impl AsyncSlots {
    fn allocate(
        link: &AsyncLink,
        plan: &Plan,
        next: &mut u32,
        [wait, cancel, task_cancelled, event]: [Option<u32>; 4],
    ) -> Result<AsyncSlots> {
        let mut take = || {
            *next += 1;
            *next - 1
        };
        let (callback, start, resolve, host_resolve, copy) =
            (take(), take(), take(), take(), take());
        let wait = wait.unwrap_or_else(&mut take);
        let cancel = cancel.unwrap_or_else(&mut take);
        let task_cancelled = task_cancelled.unwrap_or_else(&mut take);
        let event = event.unwrap_or_else(&mut take);
        let (host_frame, host_side) = (take(), take());
        let starts = link.sites.iter().map(|_| take()).collect();
        let resolves = link
            .site_returns
            .iter()
            .map(|returns| returns.then(&mut take))
            .collect();
        let host_resolves = link.host_imports.iter().map(|_| take()).collect();
        let sides = side_shapes(plan, link, HOST, &|_| Ok(HOST))?;
        let mut pair_copies = Vec::with_capacity(sides.len());
        for writer in &sides {
            let row = sides
                .iter()
                .map(|reader| tasks::pair_converts(writer, reader).then(&mut take))
                .collect();
            pair_copies.push(row);
        }
        Ok(AsyncSlots {
            callback,
            start,
            resolve,
            host_resolve,
            copy,
            wait,
            cancel,
            task_cancelled,
            event,
            host_frame,
            host_side,
            starts,
            resolves,
            host_resolves,
            pair_copies,
        })
    }
}

/// Each side of the link's copies, numbered from 1: the read and write
/// built-ins, then the host's buffers of each type that crosses its edge,
/// with the parties `party` gives the built-ins' frames.
fn side_shapes(
    plan: &Plan,
    link: &AsyncLink,
    host: Party,
    party: &dyn Fn(&crate::plan::AsyncBuiltinPlan) -> Result<Party>,
) -> Result<Vec<tasks::Side>> {
    let mut sides = Vec::with_capacity(link.sides.len() + link.host_end_types.len());
    for &index in &link.sides {
        let builtin = &plan.async_builtins[index];
        let (ty, reads) = match &builtin.builtin {
            AsyncBuiltin::Read { ty, .. } => (ty.clone(), true),
            AsyncBuiltin::Write { ty, .. } => (ty.clone(), false),
            _ => unreachable!("sides are reads and writes"),
        };
        sides.push(tasks::Side {
            ty,
            party: party(builtin)?,
            reads,
            writes: !reads,
            host: false,
        });
    }
    for ty in &link.host_end_types {
        sides.push(tasks::Side {
            ty: ty.clone(),
            party: host,
            reads: true,
            writes: true,
            host: true,
        });
    }
    Ok(sides)
}

/// The host, as a party to a call: it holds representations, not handles.
const HOST: Party = Party {
    frame: None,
    memory: None,
    realloc: None,
    encoding: StringEncoding::Utf8,
};

/// Parses the async runtime's text, once per link.
fn runtime_module() -> Result<Vec<u8>> {
    wat::parse_str(tasks::RUNTIME).context("assembling the async runtime")
}

fn function_signatures(module: &ParsedModule<'_>) -> Result<Vec<(Vec<CoreType>, Vec<CoreType>)>> {
    let mut out = Vec::new();
    for group in &module.types {
        for ty in group.types() {
            let wasmparser::CompositeInnerType::Func(func) = &ty.composite_type.inner else {
                bail!("the async runtime defines a type that is not a function type");
            };
            out.push((
                func.params()
                    .iter()
                    .map(|ty| core_type(*ty))
                    .collect::<Result<_>>()?,
                func.results()
                    .iter()
                    .map(|ty| core_type(*ty))
                    .collect::<Result<_>>()?,
            ));
        }
    }
    Ok(out)
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

    let link = tasks::analyze(plan)?;
    let runtime_bytes = link.as_ref().map(|_| runtime_module()).transpose()?;

    // The host functions the async runtime needs, imported after the
    // package's own imports.
    let mut extra_imports: Vec<(String, String, Vec<CoreType>, Vec<CoreType>)> = Vec::new();
    let mut host_wait = None;
    let mut host_cancel = None;
    let mut task_cancelled = None;
    let mut host_event = None;
    let mut host_realloc = None;
    let mut host_returns: Vec<Option<u32>> = vec![None; plan.exports.len()];
    if let Some(link) = &link {
        let base = plan.imports.len() as u32;
        let mut add = |module: &str, name: &str, params: Vec<CoreType>, results: Vec<CoreType>| {
            extra_imports.push((module.to_string(), name.to_string(), params, results));
            base + extra_imports.len() as u32 - 1
        };
        if link.host_waits() {
            host_wait = Some(add("wlink:async", "wait", vec![], vec![CoreType::I32]));
        }
        if link.host_cancels() {
            host_cancel = Some(add("wlink:async", "cancel", vec![CoreType::I32], vec![]));
        }
        if link.host_ends() {
            host_event = Some(add("wlink:async", "event", vec![CoreType::I32; 3], vec![]));
        }
        if link.host_allocates() {
            host_realloc = Some(add(
                "wlink:async",
                "realloc",
                vec![CoreType::I32; 4],
                vec![CoreType::I32],
            ));
        }
        if link.host_tasks() {
            task_cancelled = Some(add(
                "wlink:async",
                "task-cancelled",
                vec![CoreType::I32, CoreType::I32],
                vec![],
            ));
            for (index, export) in plan.exports.iter().enumerate() {
                if link.export_sites[index].is_some() {
                    let signature = tasks::host_return_signature(&export.ty);
                    host_returns[index] = Some(add(
                        "wlink:task-return",
                        &export.name,
                        signature.params,
                        signature.results,
                    ));
                }
            }
        }
    }
    let import_count = plan.imports.len() as u32 + extra_imports.len() as u32;

    let mut bases = Vec::with_capacity(plan.instances.len());
    let mut next = Bases {
        func: import_count,
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
    for (index, adapter) in plan.adapters.iter().enumerate() {
        // An async call has thunks around it, and a call into a frame the
        // runtime tracks switches threads.
        let tracked = link.as_ref().is_some_and(|link| {
            link.adapter_sites[index].is_some() || link.aware[adapter.callee_frame]
        });
        let direct =
            !tracked && adapter.lift.post_return.is_none() && adapter::is_passthrough(&adapter.ty);
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
    let mut runtime = (uses_handles(plan) || link.is_some()).then(|| {
        let runtime = Runtime {
            memory: next.memory,
            entry_size: if link.is_some() {
                handles::ASYNC_ENTRY_SIZE
            } else {
                handles::ENTRY_SIZE
            },
            add: next.func,
            get: next.func + 1,
            free: next.func + 2,
            tables: None,
        };
        next.func += 3;
        runtime
    });
    let builtin_base = next.func;
    next.func += plan.builtins.len() as u32;
    let async_builtin_base = next.func;
    next.func += plan.async_builtins.len() as u32;
    let mut spliced = match &runtime_bytes {
        Some(bytes) => {
            let module = parse_module(bytes).context("parsing the async runtime")?;
            let signatures = function_signatures(&module)?;
            let func_base = next.func;
            next.func += module.code.len() as u32;
            Some(Spliced {
                module,
                signatures,
                func_base,
                global_base: 0,
                memory: 0,
            })
        }
        None => None,
    };
    // The async runtime keeps the frames' tables the handles are indices of.
    if let (Some(spliced), Some(runtime)) = (&spliced, &mut runtime) {
        runtime.tables = Some(handles::Tables {
            publish: spliced.export("handle.publish", CoreKind::Func)?,
            unpublish: spliced.export("handle.unpublish", CoreKind::Func)?,
            lookup: spliced.export("handle.lookup", CoreKind::Func)?,
        });
    }
    let slots = link
        .as_ref()
        .map(|link| {
            AsyncSlots::allocate(
                link,
                plan,
                &mut next.func,
                [host_wait, host_cancel, task_cancelled, host_event],
            )
        })
        .transpose()?;
    let mut wrapper_slots = Vec::with_capacity(plan.exports.len());
    for (index, export) in plan.exports.iter().enumerate() {
        let tracked = link.as_ref().is_some_and(|link| {
            link.export_sites[index].is_some() || export.ty.async_ || link.aware[export.frame]
        });
        if tracked || adapter::edge_needs_adapter(&export.ty) {
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

    if let (Some(spliced), Some(runtime)) = (&mut spliced, runtime) {
        spliced.global_base = next.global;
        // The state memory, then the tables' memory.
        spliced.memory = runtime.memory + 1;
    }

    let merger = Merger {
        plan,
        modules,
        bases,
        adapter_slots,
        trampoline_base,
        builtin_base,
        async_builtin_base,
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

    // The async runtime's types follow the instances', and its imports are
    // what the linker generates for it.
    let mut runtime_remap = None;
    let mut async_runtime = None;
    if let (Some(spliced), Some(slots), Some(handles_runtime), Some(link)) =
        (&spliced, &slots, runtime, &link)
    {
        let mut funcs = Vec::new();
        for import in &spliced.module.imports {
            if !matches!(import.ty, TypeRef::Func(_)) {
                continue;
            }
            funcs.push(match import.name {
                "handle.add" => handles_runtime.add,
                "handle.free" => handles_runtime.free,
                "callback" => slots.callback,
                "start" => slots.start,
                "resolve" => slots.resolve,
                "host-resolve" => slots.host_resolve,
                "copy" => slots.copy,
                "host-wait" => slots.wait,
                "host-cancel" => slots.cancel,
                "task-cancelled" => slots.task_cancelled,
                "host-frame" => slots.host_frame,
                "host-side" => slots.host_side,
                "host-event" => slots.event,
                other => bail!("the async runtime imports an unknown `{other}`"),
            });
        }
        for local in 0..spliced.module.code.len() as u32 {
            funcs.push(spliced.func_base + local);
        }
        let mut remap = Remap {
            funcs,
            tables: Vec::new(),
            memories: vec![handles_runtime.memory, spliced.memory, spliced.memory + 1],
            globals: (0..spliced.module.globals.len() as u32)
                .map(|local| spliced.global_base + local)
                .collect(),
            tags: Vec::new(),
            ty: type_count,
            data: 0,
            elem: 0,
        };
        for group in &spliced.module.types {
            type_count += group.types().count() as u32;
            remap.parse_recursive_type_group(types.ty(), group.clone())?;
        }
        let mut funcs = HashMap::new();
        for export in &spliced.module.exports {
            if export_kind(export.kind) == Some(CoreKind::Func) {
                funcs.insert(
                    export.name.to_string(),
                    spliced.export(export.name, CoreKind::Func)?,
                );
            }
        }
        let global = |name: &str| spliced.export(name, CoreKind::Global);
        async_runtime = Some(AsyncRuntime {
            funcs,
            globals: [
                global("cur_task")?,
                global("ctx0")?,
                global("ctx1")?,
                global("sync_frame")?,
            ],
            handles_memory: handles_runtime.memory,
            state_memory: spliced.memory,
            host_frame: plan.frames.len() as u32,
            end_types: link.end_types.clone(),
            result_types: link.result_types.clone(),
        });
        runtime_remap = Some(remap);
    }
    let async_runtime = async_runtime.as_ref();

    for (index, import) in plan.imports.iter().enumerate() {
        let host_async = link
            .as_ref()
            .is_some_and(|link| link.import_sites[index].is_some());
        let signature = if host_async {
            tasks::host_import_signature(&import.ty)
        } else {
            lower_signature(&import.ty)
        };
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
    for (offset, (module, name, params, results)) in extra_imports.iter().enumerate() {
        let ty = function_type(&mut types, &mut type_count, params, results);
        imports.import(module, name, EntityType::Function(ty));
        function_names.append(
            plan.imports.len() as u32 + offset as u32,
            &format!("{module}#{name}"),
        );
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
    if let (Some(spliced), Some(remap)) = (&spliced, &mut runtime_remap) {
        // Scratch below 256, then thirty-two bytes per frame, the host's
        // last; the tables grow as they fill.
        let bytes = 256 + 32 * (plan.frames.len() as u64 + 1);
        for (local, memory) in spliced.module.memories.iter().enumerate() {
            let mut memory = remap.memory_type(*memory)?;
            if local == 0 {
                memory.minimum = memory.minimum.max(bytes.div_ceil(65536));
            }
            memories.memory(memory);
        }
        memory_names.append(spliced.memory, "wlink:async");
        memory_names.append(spliced.memory + 1, "wlink:tables");
        if link.as_ref().is_some_and(AsyncLink::host_ends) {
            // The host's buffers, which it manages.
            memories.memory(MemoryType {
                minimum: 1,
                maximum: None,
                memory64: false,
                shared: false,
                page_size_log2: None,
            });
            memory_names.append(spliced.memory + 2, "wlink:host");
        }
        for global in &spliced.module.globals {
            remap.parse_global(&mut globals, global.clone())?;
        }
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

    let adapter_party =
        |frame: usize, lift: bool, adapter: &crate::plan::AdapterPlan| -> Result<Party> {
            Ok(if lift {
                Party {
                    frame: Some(frame as u32),
                    memory: memory(&adapter.lift.memory)?,
                    realloc: func(&adapter.lift.realloc)?,
                    encoding: adapter.lift.encoding,
                }
            } else {
                Party {
                    frame: Some(frame as u32),
                    memory: memory(&adapter.lower.memory)?,
                    realloc: func(&adapter.lower.realloc)?,
                    encoding: adapter.lower.encoding,
                }
            })
        };
    let export_party = |export: &crate::plan::ExportPlan| -> Result<Party> {
        Ok(Party {
            frame: Some(export.frame as u32),
            memory: memory(&export.lift.memory)?,
            realloc: func(&export.lift.realloc)?,
            encoding: export.lift.encoding,
        })
    };
    // The identity `task.return` must match a lift's memory by, when the
    // result goes through memory: its index plus one. A result that does
    // not reads no memory, and the upstream conformance tests return one
    // with a `task.return` that names none from a lift that names one.
    let result_memory =
        |export: &Option<CoreExport>, result: Option<&crate::types::ValType>| -> Result<u32> {
            let uses_memory = result.is_some_and(|result| {
                crate::types::contains_pointers(result)
                    || crate::types::flat_types(result).len() > crate::types::MAX_FLAT_PARAMS
            });
            Ok(if uses_memory {
                memory(export)?.map_or(0, |memory| memory + 1)
            } else {
                0
            })
        };
    let adapter_env = |adapter: &crate::plan::AdapterPlan| -> Result<Environment<'_>> {
        Ok(Environment {
            boundary: Boundary::Fused,
            callee: merger.resolve_func(&adapter.callee)?,
            caller: adapter_party(adapter.caller_frame, false, adapter)?,
            target: adapter_party(adapter.callee_frame, true, adapter)?,
            post_return: func(&adapter.lift.post_return)?,
            handles,
            runtime: async_runtime,
            context: None,
            task: None,
        })
    };
    let export_env = |export: &crate::plan::ExportPlan| -> Result<Environment<'_>> {
        Ok(Environment {
            boundary: Boundary::Export,
            callee: merger.resolve_func(&export.func)?,
            caller: host,
            target: export_party(export)?,
            post_return: None,
            handles,
            runtime: async_runtime,
            context: None,
            task: None,
        })
    };
    let import_env = |index: usize| -> Result<Environment<'_>> {
        let import = &plan.imports[index];
        Ok(Environment {
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
            runtime: async_runtime,
            context: None,
            task: None,
        })
    };
    // A site's call, as its thunks see it.
    let site_call = |site: u32| -> Result<(Call<'_>, Environment<'_>)> {
        let (link, slots, runtime) = (
            link.as_ref().expect("sites imply the async runtime"),
            slots.as_ref().expect("sites imply the async runtime"),
            async_runtime.expect("sites imply the async runtime"),
        );
        let lift = link.site_lifts[site as usize].unwrap_or(0);
        let start = slots.starts[site as usize];
        Ok(match link.sites[site as usize] {
            SiteKind::Adapter(index) => {
                let adapter = &plan.adapters[index];
                let call = Call {
                    name: &adapter.name,
                    ty: &adapter.ty,
                    caller_async: adapter.lower.async_,
                    callback: adapter.lift.callback.is_some(),
                    stackful: adapter.lift.async_ && adapter.lift.callback.is_none(),
                    site,
                    lift,
                    result_type: runtime.result_type(adapter.ty.result.as_ref()),
                    result_memory: result_memory(&adapter.lift.memory, adapter.ty.result.as_ref())?,
                    start,
                };
                (call, adapter_env(adapter)?)
            }
            SiteKind::Export(index) => {
                let export = &plan.exports[index];
                let call = Call {
                    name: &export.name,
                    ty: &export.ty,
                    caller_async: true,
                    callback: export.lift.callback.is_some(),
                    stackful: export.lift.callback.is_none(),
                    site,
                    lift,
                    result_type: runtime.result_type(export.ty.result.as_ref()),
                    result_memory: result_memory(&export.lift.memory, export.ty.result.as_ref())?,
                    start,
                };
                (call, export_env(export)?)
            }
        })
    };

    let mut additions: Vec<Addition> = Vec::new();
    for (index, adapter) in plan.adapters.iter().enumerate() {
        if merger.adapter_slots[index].is_none() {
            continue;
        }
        let site = link.as_ref().and_then(|link| link.adapter_sites[index]);
        let emitted = match site {
            Some(site) => {
                let (call, env) = site_call(site)?;
                tasks::emit_lower(&call, &env)
            }
            None => {
                let mut env = adapter_env(adapter)?;
                if link
                    .as_ref()
                    .is_some_and(|link| link.aware[adapter.callee_frame])
                {
                    env.context = Some(adapter.callee_frame as u32);
                }
                adapter::emit(&adapter.name, &adapter.ty, &env)
            }
        }
        .with_context(|| format!("generating the adapter for `{}`", adapter.name))?;
        additions.push((format!("adapter#{}", adapter.name), emitted).into());
    }

    for (index, import) in plan.imports.iter().enumerate() {
        let name = format!("trampoline#{}#{}", import.module, import.name);
        let site = link.as_ref().and_then(|link| link.import_sites[index]);
        if let Some(site) = site {
            let slots = slots
                .as_ref()
                .expect("an async import implies the async runtime");
            let env = import_env(index)?;
            let emitted = tasks::emit_host_import(
                &import.name,
                &import.ty,
                &env,
                site,
                slots.host_resolves[site as usize],
            )
            .with_context(|| format!("generating the trampoline for `{}`", import.name))?;
            additions.push((name, emitted).into());
        } else if adapter::edge_needs_adapter(&import.ty) {
            let env = import_env(index)?;
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
                ty: None,
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

    if let (Some(link), Some(slots), Some(spliced), Some(remap), Some(async_runtime)) =
        (&link, &slots, &spliced, &mut runtime_remap, async_runtime)
    {
        // A context for what is generated against the runtime alone.
        let bare = Environment {
            boundary: Boundary::Fused,
            callee: 0,
            caller: host,
            target: host,
            post_return: None,
            handles,
            runtime: Some(async_runtime),
            context: None,
            task: None,
        };
        for (index, builtin) in plan.async_builtins.iter().enumerate() {
            let (result_type, result_memory) = match &builtin.builtin {
                AsyncBuiltin::TaskReturn { result, .. } => (
                    async_runtime.result_type(result.as_ref()),
                    result_memory(&builtin.memory, result.as_ref())?,
                ),
                _ => (0, 0),
            };
            let builtin_env = tasks::BuiltinEnv {
                frame: builtin.frame as u32,
                builtin: &builtin.builtin,
                memory: memory(&builtin.memory)?,
                side: link.builtin_sides[index],
                async_: builtin.async_,
                result_type,
                result_memory,
            };
            let emitted = tasks::emit_builtin(&builtin_env, &bare).with_context(|| {
                format!(
                    "generating {} of `{}`",
                    builtin.builtin.describe(),
                    plan.frames[builtin.frame].name
                )
            })?;
            let name = format!(
                "{}#{}",
                builtin.builtin.describe(),
                plan.frames[builtin.frame].name
            );
            additions.push((name, emitted).into());
        }

        for (local, body) in spliced.module.code.iter().enumerate() {
            let ty = spliced.module.func_types[local];
            let (params, results) = spliced.signatures[ty as usize].clone();
            let mut function = remap.new_function_with_parsed_locals(body)?;
            let mut reader = body.get_operators_reader()?;
            while !reader.eof() {
                function.instruction(&remap.parse_instruction(&mut reader)?);
            }
            let index = spliced.module.imported.funcs + local as u32;
            let exported = spliced
                .module
                .exports
                .iter()
                .find(|export| {
                    export.index == index && export_kind(export.kind) == Some(CoreKind::Func)
                })
                .map(|export| export.name.to_string());
            let name = spliced
                .module
                .func_names
                .get(&index)
                .cloned()
                .or(exported)
                .unwrap_or_else(|| format!("func{local}"));
            additions.push(Addition {
                name: format!("wlink#async.{name}"),
                params,
                results,
                body: function,
                ty: Some(remap.type_index(ty)?),
            });
        }

        let callbacks = link
            .callbacks
            .iter()
            .map(|callback| merger.resolve_func(callback))
            .collect::<Result<Vec<_>>>()?;
        let thunks: Vec<SiteThunks> = (0..link.sites.len() as u32)
            .map(|site| -> Result<SiteThunks> {
                let (call, env) = site_call(site)?;
                let saved = match link.sites[site as usize] {
                    SiteKind::Adapter(_) => call.caller_params(&env),
                    SiteKind::Export(_) => async_lift_signature(call.ty, true).params,
                };
                Ok(SiteThunks {
                    start: slots.starts[site as usize],
                    saved,
                    resolve: slots.resolves[site as usize],
                })
            })
            .collect::<Result<_>>()?;
        additions.push(
            (
                "wlink#async.dispatch-callback".to_string(),
                tasks::emit_dispatch_callback(&bare, &callbacks),
            )
                .into(),
        );
        additions.push(
            (
                "wlink#async.dispatch-start".to_string(),
                tasks::emit_dispatch_start(&bare, &thunks),
            )
                .into(),
        );
        additions.push(
            (
                "wlink#async.dispatch-resolve".to_string(),
                tasks::emit_dispatch_resolve(&bare, &thunks),
            )
                .into(),
        );
        additions.push(
            (
                "wlink#async.dispatch-host-resolve".to_string(),
                tasks::emit_dispatch_host_resolve(&bare, &slots.host_resolves),
            )
                .into(),
        );
        let host_party = Party {
            memory: Some(spliced.memory + 2),
            realloc: host_realloc,
            ..HOST
        };
        let sides = side_shapes(plan, link, host_party, &|builtin| {
            Ok(Party {
                frame: Some(builtin.frame as u32),
                memory: memory(&builtin.memory)?,
                realloc: func(&builtin.realloc)?,
                encoding: builtin.encoding,
            })
        })?;
        let mut pairs = Vec::with_capacity(sides.len());
        for (writer, writer_side) in sides.iter().enumerate() {
            let mut row = Vec::with_capacity(sides.len());
            for (reader, reader_side) in sides.iter().enumerate() {
                row.push(if let Some(func) = slots.pair_copies[writer][reader] {
                    Some(tasks::PairCopy::Convert {
                        func,
                        size: crate::types::size(
                            tasks::end_payload(&writer_side.ty).expect("converting elements exist"),
                        ),
                    })
                } else {
                    tasks::pair_copy(writer_side, reader_side)?
                });
            }
            pairs.push(row);
        }
        additions.push(
            (
                "wlink#async.dispatch-copy".to_string(),
                tasks::emit_dispatch_copy(&bare, &pairs),
            )
                .into(),
        );
        if host_wait.is_none() {
            additions.push(
                (
                    "wlink#async.no-host-wait".to_string(),
                    tasks::emit_no_wait(&bare),
                )
                    .into(),
            );
        }
        if host_cancel.is_none() {
            additions.push(
                (
                    "wlink#async.no-host-cancel".to_string(),
                    tasks::emit_unreachable(&bare, vec![CoreType::I32], vec![]),
                )
                    .into(),
            );
        }
        if task_cancelled.is_none() {
            additions.push(
                (
                    "wlink#async.no-host-tasks".to_string(),
                    tasks::emit_unreachable(&bare, vec![CoreType::I32, CoreType::I32], vec![]),
                )
                    .into(),
            );
        }
        if host_event.is_none() {
            additions.push(
                (
                    "wlink#async.no-host-ends".to_string(),
                    tasks::emit_unreachable(&bare, vec![CoreType::I32; 3], vec![]),
                )
                    .into(),
            );
        }
        additions.push(
            (
                "wlink#async.host-frame".to_string(),
                tasks::emit_host_frame(&bare, async_runtime.host_frame),
            )
                .into(),
        );
        additions.push(
            (
                "wlink#async.host-side".to_string(),
                tasks::emit_host_side(&bare, &link.host_sides()),
            )
                .into(),
        );
        for site in 0..link.sites.len() as u32 {
            let (call, env) = site_call(site)?;
            let emitted = tasks::emit_start(&call, &env)
                .with_context(|| format!("generating the start of `{}`", call.name))?;
            additions.push((format!("start#{}", call.name), emitted).into());
        }
        for site in 0..link.sites.len() as u32 {
            if slots.resolves[site as usize].is_none() {
                continue;
            }
            let (call, env) = site_call(site)?;
            let host_return = match link.sites[site as usize] {
                SiteKind::Export(index) => host_returns[index],
                SiteKind::Adapter(_) => None,
            };
            let emitted = tasks::emit_resolve(&call, &env, host_return)
                .with_context(|| format!("generating the resolve of `{}`", call.name))?;
            additions.push((format!("resolve#{}", call.name), emitted).into());
        }
        for &import in &link.host_imports {
            let env = import_env(import)?;
            let import = &plan.imports[import];
            let emitted = tasks::emit_host_resolve(&import.name, &import.ty, &env)
                .with_context(|| format!("generating the resolve of `{}`", import.name))?;
            additions.push(
                (
                    format!("host-resolve#{}#{}", import.module, import.name),
                    emitted,
                )
                    .into(),
            );
        }
        for (writer, row) in slots.pair_copies.iter().enumerate() {
            for (reader, slot) in row.iter().enumerate() {
                if slot.is_none() {
                    continue;
                }
                let (writer_side, reader_side) = (&sides[writer], &sides[reader]);
                let env = Environment {
                    boundary: Boundary::Fused,
                    callee: 0,
                    caller: writer_side.party,
                    target: reader_side.party,
                    post_return: None,
                    handles,
                    runtime: Some(async_runtime),
                    context: None,
                    task: None,
                };
                let element =
                    tasks::end_payload(&writer_side.ty).expect("converting elements exist");
                let name = format!("copy#{writer}#{reader}");
                let emitted = tasks::emit_pair_copy(&name, element, &env)?;
                additions.push((name, emitted).into());
            }
        }
    }

    for (index, export) in plan.exports.iter().enumerate() {
        if wrapper_slots[index].is_none() {
            continue;
        }
        let site = link.as_ref().and_then(|link| link.export_sites[index]);
        let emitted = match site {
            Some(site) => {
                let (call, env) = site_call(site)?;
                tasks::emit_export(&call, &env)
            }
            None => {
                let mut env = export_env(export)?;
                if export.ty.async_ {
                    // Lifted synchronously: the others are sites.
                    env.task = Some(export.frame as u32);
                } else if link.as_ref().is_some_and(|link| link.aware[export.frame]) {
                    env.context = Some(export.frame as u32);
                }
                adapter::emit(&export.name, &export.ty, &env)
            }
        }
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
        // A start function is a synchronous `func()` of its frame, which may
        // not block.
        let sync_frame = async_runtime.map(|runtime| runtime.thread_globals()[3]);
        for index in 0..plan.instances.len() {
            remaps[index].initialize_segments(&mut body, merger.module(index))?;
            if let Some(local) = merger.module(index).start {
                if let Some(sync_frame) = sync_frame {
                    body.instruction(&Instruction::I32Const(plan.instances[index].frame as i32));
                    body.instruction(&Instruction::GlobalSet(sync_frame));
                }
                body.instruction(&Instruction::Call(merger.resolve_local(
                    index,
                    CoreKind::Func,
                    local,
                )?));
            }
        }
        if let Some(sync_frame) = sync_frame {
            body.instruction(&Instruction::I32Const(-1));
            body.instruction(&Instruction::GlobalSet(sync_frame));
        }
        body.instruction(&Instruction::End);
        additions.push(Addition {
            name: "wlink#start".to_string(),
            params: Vec::new(),
            results: Vec::new(),
            body,
            ty: None,
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
        let ty = match addition.ty {
            Some(ty) => ty,
            None => function_type(
                &mut types,
                &mut type_count,
                &addition.params,
                &addition.results,
            ),
        };
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
    // The async runtime's host interface: the scheduler, the resolution of
    // the host's own async calls, the cancellation of the calls it makes,
    // and why the runtime trapped last.
    if let (Some(spliced), Some(link)) = (&spliced, &link) {
        exports.export(
            "wlink:async:pump",
            ExportKind::Func,
            spliced.export("pump", CoreKind::Func)?,
        );
        if link.host_cancels() {
            exports.export(
                "wlink:async:resolve",
                ExportKind::Func,
                spliced.export("host.resolve", CoreKind::Func)?,
            );
        }
        if link.host_tasks() {
            exports.export(
                "wlink:async:cancel",
                ExportKind::Func,
                spliced.export("host.cancel", CoreKind::Func)?,
            );
        }
        exports.export(
            "wlink:async:trap",
            ExportKind::Global,
            spliced.export("trap", CoreKind::Global)?,
        );
        if link.host_ends() {
            exports.export("wlink:host", ExportKind::Memory, spliced.memory + 2);
            for name in [
                "stream-new",
                "future-new",
                "read",
                "write",
                "cancel-read",
                "cancel-write",
                "drop",
            ] {
                exports.export(
                    &format!("wlink:async:{name}"),
                    ExportKind::Func,
                    spliced.export(&format!("host.{name}"), CoreKind::Func)?,
                );
            }
        }
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
    if !imports.is_empty() {
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
