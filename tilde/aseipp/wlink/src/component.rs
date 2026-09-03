// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Decoding a component binary into the list of definitions the linker
//! interprets.
//!
//! A component is a sequence of definitions, each of which appends to one of
//! the component's index spaces. The linker only needs the definitions that
//! shape instantiation: core modules and their instances, nested components
//! and their instances, aliases, canonical lifts, lowers and resource
//! built-ins, and the component's imports and exports. Value types are
//! resolved through wasmparser's validator instead of being tracked here.
//!
//! The component model's async built-ins, which name stream and future
//! types, become [`AsyncBuiltin`]s with those types resolved like any
//! function's.
//!
//! Resource types are the one kind of type definition that matters at run
//! time: each instantiation of a component creates fresh resource types, and
//! handles are only valid for the resource type they were created with. The
//! decoder therefore records every definition that appends to the component
//! type index space, and gives each resource type a component-local ordinal
//! that the type index space, imports, exports, aliases, built-ins, and the
//! function types all refer to. The linker binds ordinals to runtime resources
//! as it instantiates.

use std::collections::HashMap;
use std::ops::Range;

use anyhow::{Context, Result, anyhow, bail};
use wasmparser::ComponentValType as ReaderValType;
use wasmparser::component_types::{
    ComponentAnyTypeId, ComponentDefinedType, ComponentDefinedTypeId, ComponentEntityType,
    ComponentFuncTypeId, ComponentInstanceTypeId, ComponentValType, ResourceId,
};
use wasmparser::types::TypesRef;
use wasmparser::{
    CanonicalFunction, CanonicalOption, ComponentAlias, ComponentExternalKind, ComponentInstance,
    ComponentOuterAliasKind, ComponentType, ComponentTypeRef, Encoding, ExternalKind,
    Instance as CoreInstanceReader, InstantiationArgKind, Parser, Payload, PrimitiveValType,
    ValType as CoreValType, Validator, WasmFeatures,
};

use crate::types::{FuncType, Resource, ValType};

/// A decoded component.
#[derive(Debug, Default)]
pub struct Component {
    pub defs: Vec<Def>,
    /// The lexical name of each resource type ordinal, when one of its
    /// imports, exports, or aliases gave it a name.
    pub resource_names: Vec<String>,
}

/// One definition of a component, in binary order.
#[derive(Debug)]
pub enum Def {
    CoreModule(Vec<u8>),
    CoreInstance(CoreInstance),
    CoreAlias {
        instance: u32,
        name: String,
        kind: CoreKind,
    },
    Component(Component),
    Instance(InstanceDef),
    Alias {
        instance: u32,
        name: String,
        kind: Kind,
        /// For a type alias, the resource ordinal the new type index binds.
        resource: Option<u32>,
    },
    OuterAlias {
        kind: OuterKind,
        count: u32,
        index: u32,
        resource: Option<u32>,
    },
    /// An entry of the component type index space.
    Type(TypeDef),
    Lift {
        core_func: u32,
        ty: FuncType,
        options: CanonOptions,
    },
    Lower {
        func: u32,
        options: CanonOptions,
    },
    /// A canonical resource built-in, which defines a core function.
    Builtin {
        kind: Builtin,
        resource: u32,
    },
    /// A canonical async built-in, which defines a core function.
    Async(AsyncBuiltin),
    Import {
        name: String,
        ty: ImportType,
    },
    Export {
        name: String,
        kind: Kind,
        index: u32,
        /// For a type export, the resource ordinal the new type index binds.
        resource: Option<u32>,
    },
}

/// A type definition, as far as the linker cares.
#[derive(Debug)]
pub enum TypeDef {
    /// `(type (resource (rep i32) (dtor $f)))`: a fresh resource type for
    /// every instantiation, whose destructor is a core function index.
    Resource { resource: u32, dtor: Option<u32> },
    /// Any other type; it only occupies its index.
    Other,
}

/// The canonical built-ins over resources.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Builtin {
    ResourceNew,
    ResourceRep,
    ResourceDrop,
}

impl Builtin {
    pub fn describe(self) -> &'static str {
        match self {
            Builtin::ResourceNew => "resource.new",
            Builtin::ResourceRep => "resource.rep",
            Builtin::ResourceDrop => "resource.drop",
        }
    }
}

/// The canonical built-ins of the component model's async ABI. A stream or
/// future built-in carries the `stream` or `future` type it operates on.
#[derive(Clone, Debug)]
pub enum AsyncBuiltin {
    BackpressureInc,
    BackpressureDec,
    TaskReturn {
        result: Option<ValType>,
        options: CanonOptions,
    },
    TaskCancel,
    ContextGet(u32),
    ContextSet(u32),
    Yield,
    SubtaskDrop,
    SubtaskCancel {
        async_: bool,
    },
    WaitableSetNew,
    WaitableSetWait {
        memory: u32,
    },
    WaitableSetPoll {
        memory: u32,
    },
    WaitableSetDrop,
    WaitableJoin,
    New {
        ty: ValType,
    },
    Read {
        ty: ValType,
        options: CanonOptions,
    },
    Write {
        ty: ValType,
        options: CanonOptions,
    },
    CancelRead {
        ty: ValType,
        async_: bool,
    },
    CancelWrite {
        ty: ValType,
        async_: bool,
    },
    DropReadable {
        ty: ValType,
    },
    DropWritable {
        ty: ValType,
    },
    /// A thread built-in, which needs stack switching: it traps when called.
    Unsupported {
        name: &'static str,
        params: u32,
        result: bool,
    },
}

impl AsyncBuiltin {
    pub fn describe(&self) -> String {
        let prefix = |ty: &ValType| match ty {
            ValType::Future(_) => "future",
            _ => "stream",
        };
        match self {
            AsyncBuiltin::BackpressureInc => "backpressure.inc".into(),
            AsyncBuiltin::BackpressureDec => "backpressure.dec".into(),
            AsyncBuiltin::TaskReturn { .. } => "task.return".into(),
            AsyncBuiltin::TaskCancel => "task.cancel".into(),
            AsyncBuiltin::ContextGet(slot) => format!("context.get {slot}"),
            AsyncBuiltin::ContextSet(slot) => format!("context.set {slot}"),
            AsyncBuiltin::Yield => "thread.yield".into(),
            AsyncBuiltin::SubtaskDrop => "subtask.drop".into(),
            AsyncBuiltin::SubtaskCancel { .. } => "subtask.cancel".into(),
            AsyncBuiltin::WaitableSetNew => "waitable-set.new".into(),
            AsyncBuiltin::WaitableSetWait { .. } => "waitable-set.wait".into(),
            AsyncBuiltin::WaitableSetPoll { .. } => "waitable-set.poll".into(),
            AsyncBuiltin::WaitableSetDrop => "waitable-set.drop".into(),
            AsyncBuiltin::WaitableJoin => "waitable.join".into(),
            AsyncBuiltin::New { ty } => format!("{}.new", prefix(ty)),
            AsyncBuiltin::Read { ty, .. } => format!("{}.read", prefix(ty)),
            AsyncBuiltin::Write { ty, .. } => format!("{}.write", prefix(ty)),
            AsyncBuiltin::CancelRead { ty, .. } => format!("{}.cancel-read", prefix(ty)),
            AsyncBuiltin::CancelWrite { ty, .. } => format!("{}.cancel-write", prefix(ty)),
            AsyncBuiltin::DropReadable { ty } => format!("{}.drop-readable", prefix(ty)),
            AsyncBuiltin::DropWritable { ty } => format!("{}.drop-writable", prefix(ty)),
            AsyncBuiltin::Unsupported { name, .. } => name.to_string(),
        }
    }

    /// The `stream` or `future` type a built-in operates on.
    pub fn end_type(&self) -> Option<&ValType> {
        match self {
            AsyncBuiltin::New { ty }
            | AsyncBuiltin::Read { ty, .. }
            | AsyncBuiltin::Write { ty, .. }
            | AsyncBuiltin::CancelRead { ty, .. }
            | AsyncBuiltin::CancelWrite { ty, .. }
            | AsyncBuiltin::DropReadable { ty }
            | AsyncBuiltin::DropWritable { ty } => Some(ty),
            _ => None,
        }
    }

    fn end_type_mut(&mut self) -> Option<&mut ValType> {
        match self {
            AsyncBuiltin::New { ty }
            | AsyncBuiltin::Read { ty, .. }
            | AsyncBuiltin::Write { ty, .. }
            | AsyncBuiltin::CancelRead { ty, .. }
            | AsyncBuiltin::CancelWrite { ty, .. }
            | AsyncBuiltin::DropReadable { ty }
            | AsyncBuiltin::DropWritable { ty } => Some(ty),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum CoreInstance {
    Instantiate {
        module: u32,
        args: Vec<(String, u32)>,
    },
    FromExports(Vec<(String, CoreKind, u32)>),
}

#[derive(Debug)]
pub enum InstanceDef {
    Instantiate {
        component: u32,
        args: Vec<(String, Kind, u32)>,
    },
    FromExports(Vec<(String, Kind, u32)>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoreKind {
    Func,
    Table,
    Memory,
    Global,
    Tag,
}

impl CoreKind {
    pub fn from_external(kind: ExternalKind) -> Result<CoreKind> {
        Ok(match kind {
            ExternalKind::Func => CoreKind::Func,
            ExternalKind::Table => CoreKind::Table,
            ExternalKind::Memory => CoreKind::Memory,
            ExternalKind::Global => CoreKind::Global,
            ExternalKind::Tag => CoreKind::Tag,
            other => bail!("unsupported core export kind {other:?}"),
        })
    }

    pub fn describe(self) -> &'static str {
        match self {
            CoreKind::Func => "function",
            CoreKind::Table => "table",
            CoreKind::Memory => "memory",
            CoreKind::Global => "global",
            CoreKind::Tag => "tag",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Module,
    Func,
    Value,
    Type,
    Instance,
    Component,
}

impl From<ComponentExternalKind> for Kind {
    fn from(kind: ComponentExternalKind) -> Kind {
        match kind {
            ComponentExternalKind::Module => Kind::Module,
            ComponentExternalKind::Func => Kind::Func,
            ComponentExternalKind::Value => Kind::Value,
            ComponentExternalKind::Type => Kind::Type,
            ComponentExternalKind::Instance => Kind::Instance,
            ComponentExternalKind::Component => Kind::Component,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OuterKind {
    CoreModule,
    Component,
    Type,
}

/// How a canonical option encodes strings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StringEncoding {
    #[default]
    Utf8,
    Utf16,
    CompactUtf16,
}

/// The options of a `canon lift` or `canon lower`, as indices into the
/// defining component's core index spaces.
#[derive(Clone, Debug, Default)]
pub struct CanonOptions {
    pub memory: Option<u32>,
    pub realloc: Option<u32>,
    pub post_return: Option<u32>,
    pub encoding: StringEncoding,
    /// The async ABI.
    pub async_: bool,
    /// For an async lift, the callback that receives its events.
    pub callback: Option<u32>,
}

/// The type of an imported item, as far as the linker cares.
#[derive(Clone, Debug)]
pub enum ImportType {
    Func(FuncType),
    Instance(Vec<(String, ImportType)>),
    /// A type import; a resource type carries its ordinal.
    Type(Option<u32>),
    Other(&'static str),
}

impl ImportType {
    pub fn kind(&self) -> Kind {
        match self {
            ImportType::Func(_) => Kind::Func,
            ImportType::Instance(_) => Kind::Instance,
            ImportType::Type(_) => Kind::Type,
            ImportType::Other(_) => Kind::Value,
        }
    }
}

/// Definitions whose types are only resolvable once the component has been
/// validated, each with the type index it occupies when it defines a type.
enum Pending {
    Lift {
        def: usize,
        type_index: u32,
    },
    Import {
        def: usize,
        ty: ComponentTypeRef,
        type_index: Option<u32>,
    },
    TypeExport {
        def: usize,
        type_index: u32,
    },
    TypeAlias {
        def: usize,
        type_index: u32,
    },
    TypeOuterAlias {
        def: usize,
        type_index: u32,
    },
    Resource {
        def: usize,
        type_index: u32,
    },
    Builtin {
        def: usize,
        type_index: u32,
    },
    /// An async built-in naming a stream or future type.
    EndType {
        def: usize,
        type_index: u32,
    },
    /// `task.return` of a result type.
    TaskReturn {
        def: usize,
        result: ReaderValType,
    },
    /// A type exported from a synthesized instance, which only lends the
    /// resource its name.
    TypeName {
        type_index: u32,
        name: String,
    },
}

/// The resource ordinals of one component, keyed by wasmparser's identity,
/// which is stable across every alias and export of a resource within the
/// component and fresh for every import and definition.
#[derive(Default)]
struct Ordinals {
    by_id: HashMap<ResourceId, u32>,
    names: Vec<String>,
}

impl Ordinals {
    fn get(&mut self, id: ResourceId, name: Option<&str>) -> u32 {
        let ordinal = *self.by_id.entry(id).or_insert_with(|| {
            self.names.push(String::new());
            self.names.len() as u32 - 1
        });
        if let Some(name) = name {
            let slot = &mut self.names[ordinal as usize];
            if slot.is_empty() {
                *slot = name.to_string();
            }
        }
        ordinal
    }

    /// The ordinal of the resource at `index` in the component type index
    /// space, or `None` for any other kind of type.
    fn at(&mut self, types: &TypesRef<'_>, index: u32, name: Option<&str>) -> Option<u32> {
        match types.component_any_type_at(index) {
            ComponentAnyTypeId::Resource(id) => Some(self.get(id.resource(), name)),
            _ => None,
        }
    }

    /// Names the resources an instance type exports, at any depth.
    fn register_instance(&mut self, types: &TypesRef<'_>, id: ComponentInstanceTypeId) {
        for (name, item) in types[id].exports.iter() {
            match &item.ty {
                ComponentEntityType::Type {
                    created: ComponentAnyTypeId::Resource(id),
                    ..
                } => {
                    self.get(id.resource(), Some(name));
                }
                ComponentEntityType::Instance(id) => self.register_instance(types, *id),
                _ => {}
            }
        }
    }
}

#[derive(Default)]
struct Builder {
    defs: Vec<Def>,
    pending: Vec<Pending>,
    /// The next index of the component type index space.
    type_count: u32,
}

impl Builder {
    fn define_type(&mut self) -> u32 {
        let index = self.type_count;
        self.type_count += 1;
        index
    }

    fn finish(mut self, types: &TypesRef<'_>) -> Result<Component> {
        let pending = std::mem::take(&mut self.pending);
        let mut ordinals = Ordinals::default();

        // Every type index space entry and imported instance binds its
        // resource ordinal first, so the function types converted afterwards
        // print the lexical names.
        for pending in &pending {
            match pending {
                Pending::Resource { def, type_index } => {
                    let ordinal = ordinals
                        .at(types, *type_index, None)
                        .ok_or_else(|| anyhow!("type {type_index} is not a resource type"))?;
                    if let Def::Type(TypeDef::Resource { resource, .. }) = &mut self.defs[*def] {
                        *resource = ordinal;
                    }
                }
                Pending::Import {
                    def,
                    ty,
                    type_index,
                } => {
                    let name = def_name(&self.defs[*def]);
                    if let Some(type_index) = type_index {
                        let resource = ordinals.at(types, *type_index, name);
                        if let Def::Import { ty, .. } = &mut self.defs[*def] {
                            *ty = ImportType::Type(resource);
                        }
                    } else if let ComponentTypeRef::Instance(index) = ty {
                        if let ComponentAnyTypeId::Instance(id) =
                            types.component_any_type_at(*index)
                        {
                            ordinals.register_instance(types, id);
                        }
                    }
                }
                Pending::TypeExport { def, type_index } => {
                    let name = def_name(&self.defs[*def]);
                    let found = ordinals.at(types, *type_index, name);
                    if let Def::Export { resource, .. } = &mut self.defs[*def] {
                        *resource = found;
                    }
                }
                Pending::TypeAlias { def, type_index } => {
                    let name = def_name(&self.defs[*def]);
                    let found = ordinals.at(types, *type_index, name);
                    if let Def::Alias { resource, .. } = &mut self.defs[*def] {
                        *resource = found;
                    }
                }
                Pending::TypeOuterAlias { def, type_index } => {
                    let found = ordinals.at(types, *type_index, None);
                    if let Def::OuterAlias { resource, .. } = &mut self.defs[*def] {
                        *resource = found;
                    }
                }
                Pending::TypeName { type_index, name } => {
                    ordinals.at(types, *type_index, Some(name));
                }
                Pending::Lift { .. }
                | Pending::Builtin { .. }
                | Pending::EndType { .. }
                | Pending::TaskReturn { .. } => {}
            }
        }

        for pending in pending {
            match pending {
                Pending::Lift { def, type_index } => {
                    let resolved = match types.component_any_type_at(type_index) {
                        ComponentAnyTypeId::Func(id) => convert_func(types, id, &mut ordinals)?,
                        _ => bail!("canon lift names a type that is not a function type"),
                    };
                    if let Def::Lift { ty, .. } = &mut self.defs[def] {
                        *ty = resolved;
                    }
                }
                Pending::Import {
                    def,
                    ty,
                    type_index: None,
                } => {
                    let resolved = import_type(types, ty, &mut ordinals)?;
                    if let Def::Import { ty, .. } = &mut self.defs[def] {
                        *ty = resolved;
                    }
                }
                Pending::Builtin { def, type_index } => {
                    let Some(resource) = ordinals.at(types, type_index, None) else {
                        bail!("canonical built-in names type {type_index}, which is not a resource")
                    };
                    if let Def::Builtin { resource: slot, .. } = &mut self.defs[def] {
                        *slot = resource;
                    }
                }
                Pending::EndType { def, type_index } => {
                    let resolved = match types.component_any_type_at(type_index) {
                        ComponentAnyTypeId::Defined(id) => {
                            convert_defined(types, id, &mut ordinals)?
                        }
                        _ => bail!("async built-in names type {type_index}, which is not defined"),
                    };
                    if !matches!(resolved, ValType::Stream(_) | ValType::Future(_)) {
                        bail!("async built-in names {resolved}, which is not a stream or future");
                    }
                    if let Def::Async(builtin) = &mut self.defs[def] {
                        if let Some(ty) = builtin.end_type_mut() {
                            *ty = resolved;
                        }
                    }
                }
                Pending::TaskReturn { def, result } => {
                    let resolved = match result {
                        ReaderValType::Primitive(primitive) => convert_primitive(primitive)?,
                        ReaderValType::Type(index) => match types.component_any_type_at(index) {
                            ComponentAnyTypeId::Defined(id) => {
                                convert_defined(types, id, &mut ordinals)?
                            }
                            _ => bail!("task.return names type {index}, which is not a value type"),
                        },
                    };
                    if let Def::Async(AsyncBuiltin::TaskReturn { result, .. }) = &mut self.defs[def]
                    {
                        *result = Some(resolved);
                    }
                }
                _ => {}
            }
        }
        Ok(Component {
            defs: self.defs,
            resource_names: ordinals.names,
        })
    }
}

fn def_name(def: &Def) -> Option<&str> {
    match def {
        Def::Import { name, .. } | Def::Export { name, .. } | Def::Alias { name, .. } => {
            Some(name.as_str())
        }
        _ => None,
    }
}

/// Decodes and validates a component binary.
pub fn parse(bytes: &[u8]) -> Result<Component> {
    let mut validator = Validator::new_with_features(WasmFeatures::all());
    let mut stack: Vec<Builder> = Vec::new();
    let mut module_depth = 0usize;
    let mut root = None;

    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload?;
        if module_depth > 0 {
            if let Payload::End(_) = payload {
                module_depth -= 1;
            }
            validator.payload(&payload)?;
            continue;
        }
        match &payload {
            Payload::Version {
                encoding: Encoding::Component,
                ..
            } => stack.push(Builder::default()),
            Payload::Version {
                encoding: Encoding::Module,
                ..
            } => {
                if stack.is_empty() {
                    bail!("the input is a core module, not a component");
                }
                module_depth += 1;
            }
            Payload::ModuleSection {
                unchecked_range, ..
            } => {
                let range = usize_range(unchecked_range, bytes.len())?;
                current(&mut stack)?
                    .defs
                    .push(Def::CoreModule(bytes[range].to_vec()));
            }
            Payload::ComponentSection { .. } => {}
            Payload::InstanceSection(reader) => {
                let builder = current(&mut stack)?;
                for instance in reader.clone() {
                    builder
                        .defs
                        .push(Def::CoreInstance(core_instance(instance?)?));
                }
            }
            Payload::ComponentInstanceSection(reader) => {
                let builder = current(&mut stack)?;
                for instance in reader.clone() {
                    let instance = component_instance(instance?)?;
                    if let InstanceDef::FromExports(items) = &instance {
                        for (name, kind, index) in items {
                            if *kind == Kind::Type {
                                builder.pending.push(Pending::TypeName {
                                    type_index: *index,
                                    name: name.clone(),
                                });
                            }
                        }
                    }
                    builder.defs.push(Def::Instance(instance));
                }
            }
            Payload::ComponentAliasSection(reader) => {
                let builder = current(&mut stack)?;
                for alias in reader.clone() {
                    alias_def(builder, alias?)?;
                }
            }
            Payload::ComponentTypeSection(reader) => {
                let builder = current(&mut stack)?;
                for ty in reader.clone() {
                    let type_index = builder.define_type();
                    match ty? {
                        ComponentType::Resource { rep, dtor } => {
                            if rep != CoreValType::I32 {
                                bail!(
                                    "resource type {type_index} is represented as {rep:?}, not i32"
                                );
                            }
                            let def = builder.defs.len();
                            builder.pending.push(Pending::Resource { def, type_index });
                            builder
                                .defs
                                .push(Def::Type(TypeDef::Resource { resource: 0, dtor }));
                        }
                        _ => builder.defs.push(Def::Type(TypeDef::Other)),
                    }
                }
            }
            Payload::ComponentCanonicalSection(reader) => {
                let builder = current(&mut stack)?;
                for canon in reader.clone() {
                    match canon? {
                        CanonicalFunction::Lift {
                            core_func_index,
                            type_index,
                            options,
                        } => {
                            let def = builder.defs.len();
                            builder.pending.push(Pending::Lift { def, type_index });
                            builder.defs.push(Def::Lift {
                                core_func: core_func_index,
                                ty: FuncType {
                                    params: Vec::new(),
                                    result: None,
                                    async_: false,
                                },
                                options: canon_options(&options)?,
                            });
                        }
                        CanonicalFunction::Lower {
                            func_index,
                            options,
                        } => {
                            builder.defs.push(Def::Lower {
                                func: func_index,
                                options: canon_options(&options)?,
                            });
                        }
                        CanonicalFunction::ResourceNew { resource } => {
                            builtin(builder, Builtin::ResourceNew, resource);
                        }
                        CanonicalFunction::ResourceDrop { resource } => {
                            builtin(builder, Builtin::ResourceDrop, resource);
                        }
                        CanonicalFunction::ResourceRep { resource } => {
                            builtin(builder, Builtin::ResourceRep, resource);
                        }
                        other => async_builtin(builder, other)?,
                    }
                }
            }
            Payload::ComponentStartSection { .. } => {
                bail!("component start functions are not supported")
            }
            Payload::ComponentImportSection(reader) => {
                let builder = current(&mut stack)?;
                for import in reader.clone() {
                    let import = import?;
                    let def = builder.defs.len();
                    let type_index = matches!(import.ty, ComponentTypeRef::Type(_))
                        .then(|| builder.define_type());
                    builder.pending.push(Pending::Import {
                        def,
                        ty: import.ty,
                        type_index,
                    });
                    builder.defs.push(Def::Import {
                        name: import.name.name.to_string(),
                        ty: ImportType::Other("unresolved"),
                    });
                }
            }
            Payload::ComponentExportSection(reader) => {
                let builder = current(&mut stack)?;
                for export in reader.clone() {
                    let export = export?;
                    let def = builder.defs.len();
                    if export.kind == ComponentExternalKind::Type {
                        let type_index = builder.define_type();
                        builder
                            .pending
                            .push(Pending::TypeExport { def, type_index });
                    }
                    builder.defs.push(Def::Export {
                        name: export.name.name.to_string(),
                        kind: export.kind.into(),
                        index: export.index,
                        resource: None,
                    });
                }
            }
            Payload::CoreTypeSection(_) | Payload::CustomSection(_) => {}
            Payload::End(_) => {
                let builder = stack
                    .pop()
                    .ok_or_else(|| anyhow!("unbalanced component end"))?;
                let component = {
                    let types = validator
                        .types(0)
                        .ok_or_else(|| anyhow!("validator has no component types"))?;
                    builder.finish(&types)?
                };
                validator.payload(&payload)?;
                match stack.last_mut() {
                    Some(parent) => parent.defs.push(Def::Component(component)),
                    None => root = Some(component),
                }
                continue;
            }
            other => bail!("unexpected section in a component: {other:?}"),
        }
        validator.payload(&payload)?;
    }

    root.ok_or_else(|| anyhow!("the input has no component"))
}

/// Decodes a canonical async built-in; the stream, future, and result
/// types it names resolve once the component has been validated.
fn async_builtin(builder: &mut Builder, canon: CanonicalFunction) -> Result<()> {
    let def = builder.defs.len();
    let placeholder = || ValType::Bool;
    let end_type = |builder: &mut Builder, type_index: u32| {
        builder.pending.push(Pending::EndType { def, type_index });
    };
    let builtin = match canon {
        CanonicalFunction::BackpressureInc => AsyncBuiltin::BackpressureInc,
        CanonicalFunction::BackpressureDec => AsyncBuiltin::BackpressureDec,
        CanonicalFunction::TaskReturn { result, options } => {
            if let Some(result) = result {
                builder.pending.push(Pending::TaskReturn { def, result });
            }
            AsyncBuiltin::TaskReturn {
                result: None,
                options: canon_options(&options)?,
            }
        }
        CanonicalFunction::TaskCancel => AsyncBuiltin::TaskCancel,
        CanonicalFunction::ContextGet { ty, slot } | CanonicalFunction::ContextSet { ty, slot }
            if ty != CoreValType::I32 =>
        {
            bail!("context slot {slot} is {ty:?}; only i32 thread-local storage is supported")
        }
        CanonicalFunction::ContextGet { slot, .. } => AsyncBuiltin::ContextGet(slot),
        CanonicalFunction::ContextSet { slot, .. } => AsyncBuiltin::ContextSet(slot),
        CanonicalFunction::ThreadYield => AsyncBuiltin::Yield,
        CanonicalFunction::SubtaskDrop => AsyncBuiltin::SubtaskDrop,
        CanonicalFunction::SubtaskCancel { async_ } => AsyncBuiltin::SubtaskCancel { async_ },
        CanonicalFunction::WaitableSetNew => AsyncBuiltin::WaitableSetNew,
        CanonicalFunction::WaitableSetWait { memory } => AsyncBuiltin::WaitableSetWait { memory },
        CanonicalFunction::WaitableSetPoll { memory } => AsyncBuiltin::WaitableSetPoll { memory },
        CanonicalFunction::WaitableSetDrop => AsyncBuiltin::WaitableSetDrop,
        CanonicalFunction::WaitableJoin => AsyncBuiltin::WaitableJoin,
        CanonicalFunction::StreamNew { ty } | CanonicalFunction::FutureNew { ty } => {
            end_type(builder, ty);
            AsyncBuiltin::New { ty: placeholder() }
        }
        CanonicalFunction::StreamRead { ty, options }
        | CanonicalFunction::FutureRead { ty, options } => {
            end_type(builder, ty);
            AsyncBuiltin::Read {
                ty: placeholder(),
                options: canon_options(&options)?,
            }
        }
        CanonicalFunction::StreamWrite { ty, options }
        | CanonicalFunction::FutureWrite { ty, options } => {
            end_type(builder, ty);
            AsyncBuiltin::Write {
                ty: placeholder(),
                options: canon_options(&options)?,
            }
        }
        CanonicalFunction::StreamCancelRead { ty, async_ }
        | CanonicalFunction::FutureCancelRead { ty, async_ } => {
            end_type(builder, ty);
            AsyncBuiltin::CancelRead {
                ty: placeholder(),
                async_,
            }
        }
        CanonicalFunction::StreamCancelWrite { ty, async_ }
        | CanonicalFunction::FutureCancelWrite { ty, async_ } => {
            end_type(builder, ty);
            AsyncBuiltin::CancelWrite {
                ty: placeholder(),
                async_,
            }
        }
        CanonicalFunction::StreamDropReadable { ty }
        | CanonicalFunction::FutureDropReadable { ty } => {
            end_type(builder, ty);
            AsyncBuiltin::DropReadable { ty: placeholder() }
        }
        CanonicalFunction::StreamDropWritable { ty }
        | CanonicalFunction::FutureDropWritable { ty } => {
            end_type(builder, ty);
            AsyncBuiltin::DropWritable { ty: placeholder() }
        }
        // Cooperative threads need stack switching; a component that has
        // them links, and traps when it calls one.
        CanonicalFunction::ThreadIndex => unsupported("thread.index", 0, true),
        CanonicalFunction::ThreadNewIndirect { .. } => unsupported("thread.new-indirect", 2, true),
        CanonicalFunction::ThreadResumeLater => unsupported("thread.resume-later", 1, false),
        CanonicalFunction::ThreadSuspend => unsupported("thread.suspend", 0, true),
        CanonicalFunction::ThreadSuspendThenResume => {
            unsupported("thread.suspend-then-resume", 1, true)
        }
        CanonicalFunction::ThreadYieldThenResume => {
            unsupported("thread.yield-then-resume", 1, true)
        }
        CanonicalFunction::ThreadSuspendThenPromote => {
            unsupported("thread.suspend-then-promote", 1, true)
        }
        CanonicalFunction::ThreadYieldThenPromote => {
            unsupported("thread.yield-then-promote", 1, true)
        }
        CanonicalFunction::ThreadSpawnRef { .. }
        | CanonicalFunction::ThreadSpawnIndirect { .. }
        | CanonicalFunction::ThreadAvailableParallelism => {
            bail!("the thread built-ins are not supported: their threads need stack switching")
        }
        CanonicalFunction::ErrorContextNew { .. }
        | CanonicalFunction::ErrorContextDebugMessage { .. }
        | CanonicalFunction::ErrorContextDrop => {
            bail!("error-context is not supported")
        }
        other => bail!("unsupported canonical built-in {other:?}"),
    };
    builder.defs.push(Def::Async(builtin));
    Ok(())
}

fn unsupported(name: &'static str, params: u32, result: bool) -> AsyncBuiltin {
    AsyncBuiltin::Unsupported {
        name,
        params,
        result,
    }
}

fn builtin(builder: &mut Builder, kind: Builtin, type_index: u32) {
    let def = builder.defs.len();
    builder.pending.push(Pending::Builtin { def, type_index });
    builder.defs.push(Def::Builtin { kind, resource: 0 });
}

fn current(stack: &mut [Builder]) -> Result<&mut Builder> {
    stack
        .last_mut()
        .ok_or_else(|| anyhow!("component section outside of a component"))
}

fn usize_range(range: &Range<u64>, len: usize) -> Result<Range<usize>> {
    let start = usize::try_from(range.start)?;
    let end = usize::try_from(range.end)?;
    if start > end || end > len {
        bail!("nested module range {start}..{end} is outside the input");
    }
    Ok(start..end)
}

fn core_instance(instance: CoreInstanceReader<'_>) -> Result<CoreInstance> {
    Ok(match instance {
        CoreInstanceReader::Instantiate { module_index, args } => {
            let mut resolved = Vec::with_capacity(args.len());
            for arg in args.iter() {
                if arg.kind != InstantiationArgKind::Instance {
                    bail!(
                        "core instantiation argument `{}` is not an instance",
                        arg.name
                    );
                }
                resolved.push((arg.name.to_string(), arg.index));
            }
            CoreInstance::Instantiate {
                module: module_index,
                args: resolved,
            }
        }
        CoreInstanceReader::FromExports(exports) => {
            let mut items = Vec::with_capacity(exports.len());
            for export in exports.iter() {
                items.push((
                    export.name.to_string(),
                    CoreKind::from_external(export.kind)?,
                    export.index,
                ));
            }
            CoreInstance::FromExports(items)
        }
    })
}

fn component_instance(instance: ComponentInstance<'_>) -> Result<InstanceDef> {
    Ok(match instance {
        ComponentInstance::Instantiate {
            component_index,
            args,
        } => InstanceDef::Instantiate {
            component: component_index,
            args: args
                .iter()
                .map(|arg| (arg.name.to_string(), arg.kind.into(), arg.index))
                .collect(),
        },
        ComponentInstance::FromExports(exports) => InstanceDef::FromExports(
            exports
                .iter()
                .map(|export| {
                    (
                        export.name.name.to_string(),
                        export.kind.into(),
                        export.index,
                    )
                })
                .collect(),
        ),
    })
}

fn alias_def(builder: &mut Builder, alias: ComponentAlias<'_>) -> Result<()> {
    match alias {
        ComponentAlias::InstanceExport {
            kind,
            instance_index,
            name,
        } => {
            let def = builder.defs.len();
            if kind == ComponentExternalKind::Type {
                let type_index = builder.define_type();
                builder.pending.push(Pending::TypeAlias { def, type_index });
            }
            builder.defs.push(Def::Alias {
                instance: instance_index,
                name: name.to_string(),
                kind: kind.into(),
                resource: None,
            });
        }
        ComponentAlias::CoreInstanceExport {
            kind,
            instance_index,
            name,
        } => builder.defs.push(Def::CoreAlias {
            instance: instance_index,
            name: name.to_string(),
            kind: CoreKind::from_external(kind)?,
        }),
        ComponentAlias::Outer { kind, count, index } => {
            let kind = match kind {
                ComponentOuterAliasKind::CoreModule => OuterKind::CoreModule,
                ComponentOuterAliasKind::Component => OuterKind::Component,
                ComponentOuterAliasKind::Type => {
                    let def = builder.defs.len();
                    let type_index = builder.define_type();
                    builder
                        .pending
                        .push(Pending::TypeOuterAlias { def, type_index });
                    OuterKind::Type
                }
                ComponentOuterAliasKind::CoreType => return Ok(()),
            };
            builder.defs.push(Def::OuterAlias {
                kind,
                count,
                index,
                resource: None,
            });
        }
    }
    Ok(())
}

fn canon_options(options: &[CanonicalOption]) -> Result<CanonOptions> {
    let mut out = CanonOptions::default();
    for option in options {
        match option {
            CanonicalOption::UTF8 => out.encoding = StringEncoding::Utf8,
            CanonicalOption::UTF16 => out.encoding = StringEncoding::Utf16,
            CanonicalOption::CompactUTF16 => out.encoding = StringEncoding::CompactUtf16,
            CanonicalOption::Memory(index) => out.memory = Some(*index),
            CanonicalOption::Realloc(index) => out.realloc = Some(*index),
            CanonicalOption::PostReturn(index) => out.post_return = Some(*index),
            CanonicalOption::Async => out.async_ = true,
            CanonicalOption::Callback(index) => out.callback = Some(*index),
            CanonicalOption::CoreType(_) => {}
            other => bail!("unsupported canonical option {other:?}"),
        }
    }
    Ok(out)
}

fn convert_func(
    types: &TypesRef<'_>,
    id: ComponentFuncTypeId,
    ordinals: &mut Ordinals,
) -> Result<FuncType> {
    let func = &types[id];
    let mut params = Vec::with_capacity(func.params.len());
    for (name, ty) in func.params.iter() {
        params.push((name.to_string(), convert_val(types, ty, ordinals)?));
    }
    let result = func
        .result
        .as_ref()
        .map(|ty| convert_val(types, ty, ordinals))
        .transpose()?;
    Ok(FuncType {
        params,
        result,
        async_: func.async_,
    })
}

fn convert_val(
    types: &TypesRef<'_>,
    ty: &ComponentValType,
    ordinals: &mut Ordinals,
) -> Result<ValType> {
    match ty {
        ComponentValType::Primitive(primitive) => convert_primitive(*primitive),
        ComponentValType::Type(id) => convert_defined(types, *id, ordinals),
    }
}

fn convert_primitive(primitive: PrimitiveValType) -> Result<ValType> {
    Ok(match primitive {
        PrimitiveValType::Bool => ValType::Bool,
        PrimitiveValType::S8 => ValType::S8,
        PrimitiveValType::U8 => ValType::U8,
        PrimitiveValType::S16 => ValType::S16,
        PrimitiveValType::U16 => ValType::U16,
        PrimitiveValType::S32 => ValType::S32,
        PrimitiveValType::U32 => ValType::U32,
        PrimitiveValType::S64 => ValType::S64,
        PrimitiveValType::U64 => ValType::U64,
        PrimitiveValType::F32 => ValType::F32,
        PrimitiveValType::F64 => ValType::F64,
        PrimitiveValType::Char => ValType::Char,
        PrimitiveValType::String => ValType::String,
        other => bail!("unsupported primitive type {other:?}"),
    })
}

fn convert_resource(id: ResourceId, ordinals: &mut Ordinals) -> Resource {
    let ordinal = ordinals.get(id, None);
    Resource {
        name: ordinals.names[ordinal as usize].clone(),
        id: ordinal,
    }
}

fn convert_defined(
    types: &TypesRef<'_>,
    id: ComponentDefinedTypeId,
    ordinals: &mut Ordinals,
) -> Result<ValType> {
    Ok(match &types[id] {
        ComponentDefinedType::Primitive(primitive) => convert_primitive(*primitive)?,
        ComponentDefinedType::Record(record) => {
            let mut fields = Vec::with_capacity(record.fields.len());
            for (name, ty) in record.fields.iter() {
                fields.push((name.to_string(), convert_val(types, ty, ordinals)?));
            }
            ValType::Record(fields)
        }
        ComponentDefinedType::Variant(variant) => {
            let mut cases = Vec::with_capacity(variant.cases.len());
            for (name, case) in variant.cases.iter() {
                let ty = case
                    .ty
                    .as_ref()
                    .map(|ty| convert_val(types, ty, ordinals))
                    .transpose()?;
                cases.push((name.to_string(), ty));
            }
            ValType::Variant(cases)
        }
        ComponentDefinedType::List { element, .. } => {
            ValType::List(Box::new(convert_val(types, element, ordinals)?))
        }
        ComponentDefinedType::Tuple(tuple) => {
            let mut items = Vec::with_capacity(tuple.types.len());
            for ty in tuple.types.iter() {
                items.push(convert_val(types, ty, ordinals)?);
            }
            ValType::Tuple(items)
        }
        ComponentDefinedType::Flags(names) => {
            ValType::Flags(names.iter().map(|name| name.to_string()).collect())
        }
        ComponentDefinedType::Enum(names) => {
            ValType::Enum(names.iter().map(|name| name.to_string()).collect())
        }
        ComponentDefinedType::Option { ty, .. } => {
            ValType::Option(Box::new(convert_val(types, ty, ordinals)?))
        }
        ComponentDefinedType::Result { ok, err, .. } => ValType::Result {
            ok: ok
                .as_ref()
                .map(|ty| convert_val(types, ty, ordinals))
                .transpose()?
                .map(Box::new),
            err: err
                .as_ref()
                .map(|ty| convert_val(types, ty, ordinals))
                .transpose()?
                .map(Box::new),
        },
        ComponentDefinedType::Own(resource) => {
            ValType::Own(convert_resource(resource.resource(), ordinals))
        }
        ComponentDefinedType::Borrow(resource) => {
            ValType::Borrow(convert_resource(resource.resource(), ordinals))
        }
        ComponentDefinedType::Stream { ty, .. } => ValType::Stream(
            ty.as_ref()
                .map(|ty| convert_val(types, ty, ordinals))
                .transpose()?
                .map(Box::new),
        ),
        ComponentDefinedType::Future { ty, .. } => ValType::Future(
            ty.as_ref()
                .map(|ty| convert_val(types, ty, ordinals))
                .transpose()?
                .map(Box::new),
        ),
        other => bail!("unsupported defined type {other:?}"),
    })
}

fn import_type(
    types: &TypesRef<'_>,
    ty: ComponentTypeRef,
    ordinals: &mut Ordinals,
) -> Result<ImportType> {
    Ok(match ty {
        ComponentTypeRef::Func(index) => match types.component_any_type_at(index) {
            ComponentAnyTypeId::Func(id) => ImportType::Func(convert_func(types, id, ordinals)?),
            _ => bail!("function import names a type that is not a function type"),
        },
        ComponentTypeRef::Instance(index) => match types.component_any_type_at(index) {
            ComponentAnyTypeId::Instance(id) => instance_type(types, id, ordinals)?,
            _ => bail!("instance import names a type that is not an instance type"),
        },
        ComponentTypeRef::Type(_) => ImportType::Type(None),
        ComponentTypeRef::Module(_) => ImportType::Other("module"),
        ComponentTypeRef::Component(_) => ImportType::Other("component"),
        ComponentTypeRef::Value(_) => ImportType::Other("value"),
    })
}

fn instance_type(
    types: &TypesRef<'_>,
    id: ComponentInstanceTypeId,
    ordinals: &mut Ordinals,
) -> Result<ImportType> {
    let instance = &types[id];
    let mut items = Vec::with_capacity(instance.exports.len());
    for (name, item) in instance.exports.iter() {
        let ty = match &item.ty {
            ComponentEntityType::Func(id) => ImportType::Func(convert_func(types, *id, ordinals)?),
            ComponentEntityType::Instance(id) => instance_type(types, *id, ordinals)?,
            ComponentEntityType::Type {
                created: ComponentAnyTypeId::Resource(id),
                ..
            } => ImportType::Type(Some(ordinals.get(id.resource(), Some(name)))),
            ComponentEntityType::Type { .. } => ImportType::Type(None),
            ComponentEntityType::Module(_) => ImportType::Other("module"),
            ComponentEntityType::Component(_) => ImportType::Other("component"),
            ComponentEntityType::Value(_) => ImportType::Other("value"),
        };
        items.push((name.clone(), ty));
    }
    Ok(ImportType::Instance(items))
}

/// Parses a component from either its binary or its text form.
pub fn parse_source(bytes: &[u8]) -> Result<Component> {
    if bytes.starts_with(b"\0asm") {
        parse(bytes)
    } else {
        let text = std::str::from_utf8(bytes).context("component text is not UTF-8")?;
        let binary = wat::parse_str(text).context("failed to assemble component text")?;
        parse(&binary)
    }
}
