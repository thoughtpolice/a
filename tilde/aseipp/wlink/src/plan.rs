// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Static instantiation of components.
//!
//! The component model describes a program as a graph of instantiations:
//! nested components are instantiated with arguments, core modules are
//! instantiated with imports drawn from earlier instances, and canonical
//! `lift`/`lower` pairs connect the two levels. Because every input here is
//! a static composition, the whole graph can be evaluated ahead of time. The
//! result is a [`Plan`]: a flat list of core module instances in
//! instantiation order, the fused adapters that stand between lowered imports
//! and lifted exports, the imports nothing in the package satisfies, and the
//! exports of the package as a whole.
//!
//! Several top-level components may be linked at once. A component's imports
//! are satisfied by the exports of another component with the same name, so
//! a game component importing `console:sdk/gfx` and a platform component
//! exporting it plug together without a separate composition step.
//!
//! Every component instantiation is a frame, and a frame is what the
//! canonical ABI calls a component instance: the owner of a table of
//! resource handles. Resource types are created as the frames that define
//! them are instantiated, flow to other frames through type imports,
//! exports, and aliases, and are identified by their index in
//! [`Plan::resources`] in every function type the plan records.

use std::collections::{BTreeSet, HashMap, HashSet};

use anyhow::{Context, Result, anyhow, bail};
use indexmap::IndexMap;
use wasmparser::{Parser, Payload, TypeRef};

use crate::component::{
    Builtin, CanonOptions, Component, CoreInstance, CoreKind, Def, ImportType, InstanceDef, Kind,
    OuterKind, StringEncoding, TypeDef,
};
use crate::types::{FuncType, Resource, ValType, contains_handles};

/// The result of evaluating a composition.
#[derive(Debug, Default)]
pub struct Plan {
    pub modules: Vec<Vec<u8>>,
    /// Every component instantiation, in instantiation order.
    pub frames: Vec<FramePlan>,
    pub instances: Vec<InstancePlan>,
    pub resources: Vec<ResourcePlan>,
    pub builtins: Vec<BuiltinPlan>,
    pub adapters: Vec<AdapterPlan>,
    pub imports: Vec<ImportPlan>,
    pub exports: Vec<ExportPlan>,
    pub resource_exports: Vec<ResourceExportPlan>,
}

/// One component instantiation, which owns a table of resource handles.
#[derive(Debug)]
pub struct FramePlan {
    pub name: String,
    /// The top-level component this frame belongs to.
    pub component: String,
}

/// One core module instance of the linked program.
#[derive(Debug)]
pub struct InstancePlan {
    pub name: String,
    /// The top-level component this instance belongs to.
    pub component: String,
    pub module: usize,
    /// The instance's imports, in the module's import order.
    pub args: Vec<InstanceArg>,
}

#[derive(Debug)]
pub struct InstanceArg {
    pub module: String,
    pub field: String,
    pub item: CoreItem,
}

/// A resource type of the linked program.
#[derive(Debug)]
pub struct ResourcePlan {
    /// `<frame>:<name>` for a resource a frame implements, `<module>#<name>`
    /// for one the host does. The name is the first one the resource is
    /// exported, aliased, or imported under; a resource nothing names is
    /// numbered.
    pub name: String,
    /// Whether `name` came from the components rather than the numbering.
    pub named: bool,
    /// The frame that implements the resource, or `None` when the host does.
    pub owner: Option<usize>,
    pub dtor: Option<CoreFunc>,
    /// For a host resource, the module and field of the destructor the host
    /// is asked for when a component drops an owned handle.
    pub host_drop_name: Option<(String, String)>,
    /// The import of that destructor, once something needs it.
    pub host_drop: Option<usize>,
}

/// A canonical resource built-in some frame uses.
#[derive(Debug)]
pub struct BuiltinPlan {
    pub frame: usize,
    pub resource: usize,
    pub kind: Builtin,
}

/// A core function of the linked program.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoreFunc {
    Export(CoreExport),
    Adapter(usize),
    Import(usize),
    Builtin(usize),
}

/// An export of a core module instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreExport {
    pub instance: usize,
    pub name: String,
}

#[derive(Clone, Debug)]
pub enum CoreItem {
    Func(CoreFunc),
    Table(CoreExport),
    Memory(CoreExport),
    Global(CoreExport),
}

impl CoreItem {
    fn kind(&self) -> CoreKind {
        match self {
            CoreItem::Func(_) => CoreKind::Func,
            CoreItem::Table(_) => CoreKind::Table,
            CoreItem::Memory(_) => CoreKind::Memory,
            CoreItem::Global(_) => CoreKind::Global,
        }
    }
}

/// The resolved options of a `canon lift`.
#[derive(Clone, Debug, Default)]
pub struct LiftOptions {
    pub memory: Option<CoreExport>,
    pub realloc: Option<CoreFunc>,
    pub post_return: Option<CoreFunc>,
    pub encoding: StringEncoding,
}

/// The resolved options of a `canon lower`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LowerOptions {
    pub memory: Option<CoreExport>,
    pub realloc: Option<CoreFunc>,
    pub encoding: StringEncoding,
}

/// A lowered import satisfied by a lifted export of another instance.
#[derive(Debug)]
pub struct AdapterPlan {
    pub name: String,
    pub ty: FuncType,
    pub callee: CoreFunc,
    pub lift: LiftOptions,
    pub lower: LowerOptions,
    /// The frame that lowered the function: the caller's resource table.
    pub caller_frame: usize,
    /// The frame that lifted it: the callee's resource table.
    pub callee_frame: usize,
}

/// A lowered import nothing in the package satisfies.
#[derive(Debug)]
pub struct ImportPlan {
    pub module: String,
    pub name: String,
    pub ty: FuncType,
    pub lower: LowerOptions,
    /// The frame whose handles the call lifts. Frames lowering an import
    /// identically share it unless handles cross, so this is only meaningful
    /// when the type names a resource.
    pub frame: usize,
}

/// A lifted function the package exports.
#[derive(Debug)]
pub struct ExportPlan {
    pub name: String,
    pub func: CoreFunc,
    pub ty: FuncType,
    pub lift: LiftOptions,
    /// The frame that lifted it: the resource table its handles live in.
    pub frame: usize,
}

/// A resource type the package exports, for which the host gets a
/// destructor taking the resource's representation.
#[derive(Debug)]
pub struct ResourceExportPlan {
    pub name: String,
    pub resource: usize,
}

/// A component-level function.
#[derive(Clone, Debug)]
pub enum ComponentFunc {
    Lifted {
        name: Option<String>,
        frame: usize,
        core: CoreFunc,
        ty: FuncType,
        options: LiftOptions,
    },
    Import {
        interface: Option<String>,
        name: String,
        ty: FuncType,
    },
}

impl ComponentFunc {
    fn ty(&self) -> &FuncType {
        match self {
            ComponentFunc::Lifted { ty, .. } | ComponentFunc::Import { ty, .. } => ty,
        }
    }

    fn named(mut self, new_name: &str) -> ComponentFunc {
        if let ComponentFunc::Lifted { name, .. } = &mut self {
            if name.is_none() {
                *name = Some(new_name.to_string());
            }
        }
        self
    }
}

/// A component-level item.
#[derive(Clone, Debug)]
pub enum Entity<'c> {
    Func(ComponentFunc),
    Instance(IndexMap<String, Entity<'c>>),
    Module(usize),
    Component(ComponentClosure<'c>),
    /// A type; a resource type carries its index in [`Plan::resources`].
    Type(Option<usize>),
}

/// A component definition with the frame in which its outer aliases were bound.
#[derive(Clone, Copy, Debug)]
pub struct ComponentClosure<'c> {
    component: &'c Component,
    scope: usize,
}

impl Entity<'_> {
    fn describe(&self) -> &'static str {
        match self {
            Entity::Func(_) => "function",
            Entity::Instance(_) => "instance",
            Entity::Module(_) => "module",
            Entity::Component(_) => "component",
            Entity::Type(_) => "type",
        }
    }
}

enum CoreInstanceRef {
    Real(usize),
    Synthetic(IndexMap<String, CoreItem>),
}

#[derive(Default)]
struct Frame<'c> {
    /// The lexical parent; this need not be the frame instantiating us.
    outer: Option<usize>,
    core_modules: Vec<usize>,
    core_instances: Vec<CoreInstanceRef>,
    core_funcs: Vec<CoreFunc>,
    core_tables: Vec<CoreExport>,
    core_memories: Vec<CoreExport>,
    core_globals: Vec<CoreExport>,
    components: Vec<ComponentClosure<'c>>,
    instances: Vec<IndexMap<String, Entity<'c>>>,
    funcs: Vec<ComponentFunc>,
    /// The component type index space: the resource at each index, if any.
    types: Vec<Option<usize>>,
    /// The component's resource ordinals bound so far.
    resources: HashMap<u32, usize>,
    exports: IndexMap<String, Entity<'c>>,
    /// Nested components instantiated so far, which names their instances.
    instantiations: usize,
}

/// What the linker needs to know about a core module: its imports in order
/// and its exports.
#[derive(Debug)]
pub struct ModuleInfo {
    pub imports: Vec<(String, String, CoreKind)>,
    pub exports: Vec<(String, CoreKind)>,
}

impl ModuleInfo {
    pub fn parse(bytes: &[u8]) -> Result<ModuleInfo> {
        let mut info = ModuleInfo {
            imports: Vec::new(),
            exports: Vec::new(),
        };
        for payload in Parser::new(0).parse_all(bytes) {
            match payload? {
                Payload::ImportSection(reader) => {
                    for import in reader.into_imports() {
                        let import = import?;
                        let kind = match import.ty {
                            TypeRef::Func(_) => CoreKind::Func,
                            TypeRef::Table(_) => CoreKind::Table,
                            TypeRef::Memory(_) => CoreKind::Memory,
                            TypeRef::Global(_) => CoreKind::Global,
                            TypeRef::Tag(_) => CoreKind::Tag,
                            other => bail!("unsupported import kind {other:?}"),
                        };
                        info.imports.push((
                            import.module.to_string(),
                            import.name.to_string(),
                            kind,
                        ));
                    }
                }
                Payload::ExportSection(reader) => {
                    for export in reader {
                        let export = export?;
                        info.exports.push((
                            export.name.to_string(),
                            CoreKind::from_external(export.kind)?,
                        ));
                    }
                }
                _ => {}
            }
        }
        Ok(info)
    }

    fn has_export(&self, name: &str, kind: CoreKind) -> bool {
        self.exports
            .iter()
            .any(|(export, export_kind)| export == name && *export_kind == kind)
    }
}

/// The type of a host resource's destructor: it takes the representation.
fn host_drop_type() -> FuncType {
    FuncType {
        params: vec![("rep".to_string(), ValType::U32)],
        result: None,
    }
}

fn type_has_handles(ty: &FuncType) -> bool {
    ty.params.iter().any(|(_, param)| contains_handles(param))
        || ty.result.as_ref().is_some_and(contains_handles)
}

struct Linker<'c> {
    plan: Plan,
    module_info: Vec<ModuleInfo>,
    /// An arena: a component can outlive the instantiation that defined it.
    frames: Vec<Frame<'c>>,
}

impl<'c> Linker<'c> {
    fn add_module(&mut self, bytes: &[u8]) -> Result<usize> {
        let info = ModuleInfo::parse(bytes)?;
        self.plan.modules.push(bytes.to_vec());
        self.module_info.push(info);
        Ok(self.plan.modules.len() - 1)
    }

    fn export_item(&self, instance: usize, name: &str, kind: CoreKind) -> Result<CoreItem> {
        let plan = &self.plan.instances[instance];
        let info = &self.module_info[plan.module];
        if !info.has_export(name, kind) {
            bail!(
                "instance `{}` has no {} export named `{name}`",
                plan.name,
                kind.describe()
            );
        }
        let export = CoreExport {
            instance,
            name: name.to_string(),
        };
        Ok(match kind {
            CoreKind::Func => CoreItem::Func(CoreFunc::Export(export)),
            CoreKind::Table => CoreItem::Table(export),
            CoreKind::Memory => CoreItem::Memory(export),
            CoreKind::Global => CoreItem::Global(export),
            CoreKind::Tag => bail!("tags cannot be shared between instances"),
        })
    }

    fn core_instance_item(
        &self,
        frame: usize,
        instance: u32,
        name: &str,
        kind: CoreKind,
    ) -> Result<CoreItem> {
        let instances = &self.frames[frame].core_instances;
        let instance = instances
            .get(instance as usize)
            .ok_or_else(|| anyhow!("core instance index {instance} is out of range"))?;
        match instance {
            CoreInstanceRef::Real(index) => self.export_item(*index, name, kind),
            CoreInstanceRef::Synthetic(items) => {
                let item = items
                    .get(name)
                    .ok_or_else(|| anyhow!("synthetic instance has no export `{name}`"))?;
                if item.kind() != kind {
                    bail!(
                        "export `{name}` is a {}, not a {}",
                        item.kind().describe(),
                        kind.describe()
                    );
                }
                Ok(item.clone())
            }
        }
    }

    fn push_core_item(&mut self, frame: usize, item: CoreItem) {
        let frame = &mut self.frames[frame];
        match item {
            CoreItem::Func(func) => frame.core_funcs.push(func),
            CoreItem::Table(export) => frame.core_tables.push(export),
            CoreItem::Memory(export) => frame.core_memories.push(export),
            CoreItem::Global(export) => frame.core_globals.push(export),
        }
    }

    fn core_item(&self, frame: usize, kind: CoreKind, index: u32) -> Result<CoreItem> {
        let frame = &self.frames[frame];
        let index = index as usize;
        let missing = || anyhow!("core {} index {index} is out of range", kind.describe());
        Ok(match kind {
            CoreKind::Func => {
                CoreItem::Func(frame.core_funcs.get(index).ok_or_else(missing)?.clone())
            }
            CoreKind::Table => {
                CoreItem::Table(frame.core_tables.get(index).ok_or_else(missing)?.clone())
            }
            CoreKind::Memory => {
                CoreItem::Memory(frame.core_memories.get(index).ok_or_else(missing)?.clone())
            }
            CoreKind::Global => {
                CoreItem::Global(frame.core_globals.get(index).ok_or_else(missing)?.clone())
            }
            CoreKind::Tag => bail!("tags cannot be shared between instances"),
        })
    }

    fn core_func(&self, frame: usize, index: u32, what: &str) -> Result<CoreFunc> {
        self.frames[frame]
            .core_funcs
            .get(index as usize)
            .cloned()
            .ok_or_else(|| anyhow!("{what} names core function {index}, which is out of range"))
    }

    fn entity(&self, frame: usize, kind: Kind, index: u32) -> Result<Entity<'c>> {
        let frame = &self.frames[frame];
        let index = index as usize;
        let missing = || anyhow!("{kind:?} index {index} is out of range");
        Ok(match kind {
            Kind::Func => Entity::Func(frame.funcs.get(index).ok_or_else(missing)?.clone()),
            Kind::Instance => {
                Entity::Instance(frame.instances.get(index).ok_or_else(missing)?.clone())
            }
            Kind::Module => Entity::Module(*frame.core_modules.get(index).ok_or_else(missing)?),
            Kind::Component => Entity::Component(*frame.components.get(index).ok_or_else(missing)?),
            Kind::Type => Entity::Type(*frame.types.get(index).ok_or_else(missing)?),
            Kind::Value => bail!("component values are not supported"),
        })
    }

    fn push_entity(
        &mut self,
        frame: usize,
        kind: Kind,
        entity: Entity<'c>,
        what: &str,
    ) -> Result<()> {
        let frame = &mut self.frames[frame];
        match (kind, entity) {
            (Kind::Func, Entity::Func(func)) => frame.funcs.push(func),
            (Kind::Instance, Entity::Instance(items)) => frame.instances.push(items),
            (Kind::Module, Entity::Module(module)) => frame.core_modules.push(module),
            (Kind::Component, Entity::Component(component)) => frame.components.push(component),
            (Kind::Type, Entity::Type(resource)) => frame.types.push(resource),
            (Kind::Type, _) => frame.types.push(None),
            (kind, entity) => bail!(
                "{what} is a {} where a {kind:?} was expected",
                entity.describe()
            ),
        }
        Ok(())
    }

    /// Binds a component's resource ordinal to a runtime resource. A type
    /// reached along two paths binds twice; that is fine as long as both
    /// paths lead to the same resource.
    fn bind_resource(&mut self, frame: usize, ordinal: u32, resource: usize) -> Result<()> {
        match self.frames[frame].resources.insert(ordinal, resource) {
            Some(previous) if previous != resource => bail!(
                "resource type `{}` of `{}` is bound to both `{}` and `{}`",
                ordinal,
                self.plan.frames[frame].name,
                self.plan.resources[previous].name,
                self.plan.resources[resource].name
            ),
            _ => Ok(()),
        }
    }

    fn resource_of(&self, frame: usize, ordinal: u32) -> Result<usize> {
        self.frames[frame]
            .resources
            .get(&ordinal)
            .copied()
            .ok_or_else(|| {
                anyhow!(
                    "`{}` uses resource type {ordinal} before anything defines it",
                    self.plan.frames[frame].name
                )
            })
    }

    /// Replaces a component's resource ordinals with the plan's resources.
    fn resolve_type(&self, frame: usize, ty: &FuncType) -> Result<FuncType> {
        let mut params = Vec::with_capacity(ty.params.len());
        for (name, param) in &ty.params {
            params.push((name.clone(), self.resolve_val(frame, param)?));
        }
        let result = ty
            .result
            .as_ref()
            .map(|result| self.resolve_val(frame, result))
            .transpose()?;
        Ok(FuncType { params, result })
    }

    fn resolve_val(&self, frame: usize, ty: &ValType) -> Result<ValType> {
        let resolve = |resource: &Resource| -> Result<Resource> {
            let index = self.resource_of(frame, resource.id)?;
            Ok(Resource {
                name: self.plan.resources[index].name.clone(),
                id: index as u32,
            })
        };
        Ok(match ty {
            ValType::Own(resource) => ValType::Own(resolve(resource)?),
            ValType::Borrow(resource) => ValType::Borrow(resolve(resource)?),
            ValType::List(element) => ValType::List(Box::new(self.resolve_val(frame, element)?)),
            ValType::Record(fields) => ValType::Record(
                fields
                    .iter()
                    .map(|(name, field)| Ok((name.clone(), self.resolve_val(frame, field)?)))
                    .collect::<Result<_>>()?,
            ),
            ValType::Tuple(items) => ValType::Tuple(
                items
                    .iter()
                    .map(|item| self.resolve_val(frame, item))
                    .collect::<Result<_>>()?,
            ),
            ValType::Variant(cases) => ValType::Variant(
                cases
                    .iter()
                    .map(|(name, case)| {
                        Ok((
                            name.clone(),
                            case.as_ref()
                                .map(|case| self.resolve_val(frame, case))
                                .transpose()?,
                        ))
                    })
                    .collect::<Result<_>>()?,
            ),
            ValType::Option(inner) => ValType::Option(Box::new(self.resolve_val(frame, inner)?)),
            ValType::Result { ok, err } => ValType::Result {
                ok: ok
                    .as_ref()
                    .map(|ok| self.resolve_val(frame, ok))
                    .transpose()?
                    .map(Box::new),
                err: err
                    .as_ref()
                    .map(|err| self.resolve_val(frame, err))
                    .transpose()?
                    .map(Box::new),
            },
            scalar => scalar.clone(),
        })
    }

    /// A resource type the host implements, imported as `name` from
    /// `interface` (or the root namespace).
    fn host_resource(&mut self, interface: Option<&str>, name: &str) -> usize {
        let module = interface.unwrap_or("$root").to_string();
        self.plan.resources.push(ResourcePlan {
            name: format!("{module}#{name}"),
            named: true,
            owner: None,
            dtor: None,
            host_drop_name: Some((module, format!("[resource-drop]{name}"))),
            host_drop: None,
        });
        self.plan.resources.len() - 1
    }

    /// Names a resource after the first export or alias that names it,
    /// wherever in the composition that happens.
    fn name_resource(&mut self, resource: usize, name: &str) {
        let plan = &mut self.plan.resources[resource];
        if plan.named {
            return;
        }
        if let Some(owner) = plan.owner {
            plan.name = format!("{}:{name}", self.plan.frames[owner].name);
            plan.named = true;
        }
    }

    /// Checks an import against what another component provides for it, and
    /// binds the resource types it brings into scope.
    fn bind_import(
        &mut self,
        frame: usize,
        name: &str,
        expected: &ImportType,
        provided: &Entity<'c>,
    ) -> Result<()> {
        match (expected, provided) {
            (ImportType::Func(expected), Entity::Func(func)) => {
                let expected = self.resolve_type(frame, expected)?;
                if *func.ty() != expected {
                    bail!(
                        "import `{name}` expects {expected}, but its provider is {}",
                        func.ty()
                    );
                }
            }
            (ImportType::Instance(items), Entity::Instance(exports)) => {
                // Types bind first: the function types are stated in terms
                // of them.
                for (item, ty) in items {
                    let ImportType::Type(Some(ordinal)) = ty else {
                        continue;
                    };
                    match exports.get(item) {
                        Some(Entity::Type(Some(resource))) => {
                            self.bind_resource(frame, *ordinal, *resource)?;
                        }
                        Some(Entity::Type(None)) => bail!(
                            "import `{name}.{item}` is a resource type, but its provider's is not"
                        ),
                        Some(other) => bail!(
                            "import `{name}.{item}` is a type, but its provider is a {}",
                            other.describe()
                        ),
                        None => bail!(
                            "import `{name}` needs resource type `{item}`, which its provider \
                             does not export"
                        ),
                    }
                }
                for (item, ty) in items {
                    match exports.get(item) {
                        Some(entity) => {
                            self.bind_import(frame, &format!("{name}.{item}"), ty, entity)?;
                        }
                        None if matches!(ty, ImportType::Type(_)) => {}
                        None => bail!(
                            "import `{name}` needs `{item}`, which its provider does not export"
                        ),
                    }
                }
            }
            (ImportType::Type(Some(ordinal)), Entity::Type(Some(resource))) => {
                self.bind_resource(frame, *ordinal, *resource)?;
            }
            (ImportType::Type(Some(_)), Entity::Type(None)) => {
                bail!("import `{name}` is a resource type, but its provider's is not")
            }
            (ImportType::Type(_), _) => {}
            (ImportType::Other(what), _) => {
                bail!("import `{name}` is a {what}, which is not supported")
            }
            (expected, provided) => {
                bail!(
                    "import `{name}` is a {:?}, but its provider is a {}",
                    expected.kind(),
                    provided.describe()
                )
            }
        }
        Ok(())
    }

    /// The entity of an import nothing in the package satisfies: functions
    /// the host implements and resource types the host owns.
    fn import_entity(
        &mut self,
        frame: usize,
        interface: Option<&str>,
        name: &str,
        ty: &ImportType,
    ) -> Result<Entity<'c>> {
        Ok(match ty {
            ImportType::Func(ty) => Entity::Func(ComponentFunc::Import {
                interface: interface.map(str::to_string),
                name: name.to_string(),
                ty: self.resolve_type(frame, ty)?,
            }),
            ImportType::Instance(items) => {
                let mut exports: IndexMap<String, Entity<'c>> = IndexMap::new();
                for (item, ty) in items {
                    if let ImportType::Type(_) = ty {
                        let entity = self.import_entity(frame, Some(name), item, ty)?;
                        exports.insert(item.clone(), entity);
                    }
                }
                for (item, ty) in items {
                    if !matches!(ty, ImportType::Type(_)) {
                        let entity = self.import_entity(frame, Some(name), item, ty)?;
                        exports.insert(item.clone(), entity);
                    }
                }
                Entity::Instance(exports)
            }
            ImportType::Type(Some(ordinal)) => {
                let resource = self.host_resource(interface, name);
                self.bind_resource(frame, *ordinal, resource)?;
                Entity::Type(Some(resource))
            }
            ImportType::Type(None) => Entity::Type(None),
            ImportType::Other(what) => {
                bail!("import `{name}` is a {what}, which is not supported")
            }
        })
    }

    fn lift_options(&self, frame: usize, options: &CanonOptions) -> Result<LiftOptions> {
        let frame_ref = &self.frames[frame];
        let core_func = |index: u32| -> Result<CoreFunc> {
            frame_ref
                .core_funcs
                .get(index as usize)
                .cloned()
                .ok_or_else(|| {
                    anyhow!("canonical option names core function {index}, which is out of range")
                })
        };
        let memory = |index: u32| -> Result<CoreExport> {
            frame_ref
                .core_memories
                .get(index as usize)
                .cloned()
                .ok_or_else(|| {
                    anyhow!("canonical option names core memory {index}, which is out of range")
                })
        };
        Ok(LiftOptions {
            memory: options.memory.map(memory).transpose()?,
            realloc: options.realloc.map(core_func).transpose()?,
            post_return: options.post_return.map(core_func).transpose()?,
            encoding: options.encoding,
        })
    }

    /// The core function of a resource built-in, planned once per frame,
    /// resource, and kind.
    fn builtin(&mut self, frame: usize, kind: Builtin, ordinal: u32) -> Result<CoreFunc> {
        let resource = self.resource_of(frame, ordinal)?;
        let plan = &self.plan.resources[resource];
        if kind != Builtin::ResourceDrop && plan.owner != Some(frame) {
            bail!(
                "`{}` uses {} on `{}`, which it does not implement",
                self.plan.frames[frame].name,
                kind.describe(),
                plan.name
            );
        }
        if kind == Builtin::ResourceDrop && plan.owner.is_none() && plan.host_drop.is_none() {
            let (module, name) = plan
                .host_drop_name
                .clone()
                .expect("a host resource names its destructor");
            let index = self.plan.imports.len();
            self.plan.imports.push(ImportPlan {
                module,
                name,
                ty: host_drop_type(),
                lower: LowerOptions::default(),
                frame,
            });
            self.plan.resources[resource].host_drop = Some(index);
        }
        let existing = self.plan.builtins.iter().position(|builtin| {
            builtin.frame == frame && builtin.resource == resource && builtin.kind == kind
        });
        let index = match existing {
            Some(index) => index,
            None => {
                self.plan.builtins.push(BuiltinPlan {
                    frame,
                    resource,
                    kind,
                });
                self.plan.builtins.len() - 1
            }
        };
        Ok(CoreFunc::Builtin(index))
    }

    fn instantiate(
        &mut self,
        component: &'c Component,
        outer: Option<usize>,
        imports: &IndexMap<String, Entity<'c>>,
        name: &str,
        top: &str,
    ) -> Result<IndexMap<String, Entity<'c>>> {
        self.frames.push(Frame {
            outer,
            ..Frame::default()
        });
        self.plan.frames.push(FramePlan {
            name: name.to_string(),
            component: top.to_string(),
        });
        let frame = self.frames.len() - 1;

        for def in &component.defs {
            match def {
                Def::CoreModule(bytes) => {
                    let module = self.add_module(bytes)?;
                    self.frames[frame].core_modules.push(module);
                }
                Def::CoreInstance(CoreInstance::Instantiate { module, args }) => {
                    let module = *self.frames[frame]
                        .core_modules
                        .get(*module as usize)
                        .ok_or_else(|| anyhow!("core module index {module} is out of range"))?;
                    let mut resolved = Vec::new();
                    for (import_module, field, kind) in &self.module_info[module].imports {
                        let (_, instance) = args
                            .iter()
                            .find(|(arg, _)| arg == import_module)
                            .ok_or_else(|| {
                                anyhow!(
                                    "instantiation of module {module} supplies nothing \
                                     for import `{import_module}`"
                                )
                            })?;
                        let item = self
                            .core_instance_item(frame, *instance, field, *kind)
                            .with_context(|| {
                                format!("resolving import `{import_module}` `{field}`")
                            })?;
                        resolved.push(InstanceArg {
                            module: import_module.clone(),
                            field: field.clone(),
                            item,
                        });
                    }
                    let ordinal = self.frames[frame]
                        .core_instances
                        .iter()
                        .filter(|instance| matches!(instance, CoreInstanceRef::Real(_)))
                        .count();
                    let index = self.plan.instances.len();
                    self.plan.instances.push(InstancePlan {
                        name: if ordinal == 0 {
                            name.to_string()
                        } else {
                            format!("{name}.{ordinal}")
                        },
                        component: top.to_string(),
                        module,
                        args: resolved,
                    });
                    self.frames[frame]
                        .core_instances
                        .push(CoreInstanceRef::Real(index));
                }
                Def::CoreInstance(CoreInstance::FromExports(items)) => {
                    let mut map: IndexMap<String, CoreItem> = IndexMap::new();
                    for (export, kind, index) in items {
                        map.insert(export.clone(), self.core_item(frame, *kind, *index)?);
                    }
                    self.frames[frame]
                        .core_instances
                        .push(CoreInstanceRef::Synthetic(map));
                }
                Def::CoreAlias {
                    instance,
                    name: export,
                    kind,
                } => {
                    let item = self.core_instance_item(frame, *instance, export, *kind)?;
                    self.push_core_item(frame, item);
                }
                Def::Component(nested) => self.frames[frame].components.push(ComponentClosure {
                    component: nested,
                    scope: frame,
                }),
                Def::Instance(InstanceDef::Instantiate { component, args }) => {
                    let nested = *self.frames[frame]
                        .components
                        .get(*component as usize)
                        .ok_or_else(|| anyhow!("component index {component} is out of range"))?;
                    let mut nested_imports: IndexMap<String, Entity<'c>> = IndexMap::new();
                    for (arg, kind, index) in args {
                        nested_imports.insert(arg.clone(), self.entity(frame, *kind, *index)?);
                    }
                    let ordinal = self.frames[frame].instantiations;
                    self.frames[frame].instantiations += 1;
                    let exports = self.instantiate(
                        nested.component,
                        Some(nested.scope),
                        &nested_imports,
                        &format!("{name}/{ordinal}"),
                        top,
                    )?;
                    self.frames[frame].instances.push(exports);
                }
                Def::Instance(InstanceDef::FromExports(items)) => {
                    let mut map: IndexMap<String, Entity<'c>> = IndexMap::new();
                    for (export, kind, index) in items {
                        let entity = match self.entity(frame, *kind, *index)? {
                            Entity::Func(func) => Entity::Func(func.named(export)),
                            Entity::Type(Some(resource)) => {
                                self.name_resource(resource, export);
                                Entity::Type(Some(resource))
                            }
                            other => other,
                        };
                        map.insert(export.clone(), entity);
                    }
                    self.frames[frame].instances.push(map);
                }
                Def::Alias {
                    instance,
                    name: export,
                    kind,
                    resource,
                } => {
                    let entity = self.frames[frame]
                        .instances
                        .get(*instance as usize)
                        .ok_or_else(|| anyhow!("instance index {instance} is out of range"))?
                        .get(export)
                        .ok_or_else(|| anyhow!("instance {instance} has no export `{export}`"))?
                        .clone();
                    let entity = match entity {
                        Entity::Func(func) => Entity::Func(func.named(export)),
                        other => other,
                    };
                    if let (Some(ordinal), Entity::Type(Some(index))) = (resource, &entity) {
                        self.bind_resource(frame, *ordinal, *index)?;
                        self.name_resource(*index, export);
                    }
                    self.push_entity(frame, *kind, entity, &format!("export `{export}`"))?;
                }
                Def::OuterAlias {
                    kind,
                    count,
                    index,
                    resource,
                } => {
                    let mut outer = frame;
                    for _ in 0..*count {
                        outer = self.frames[outer].outer.ok_or_else(|| {
                            anyhow!("outer alias reaches above the root component")
                        })?;
                    }
                    match kind {
                        OuterKind::CoreModule => {
                            let module = *self.frames[outer]
                                .core_modules
                                .get(*index as usize)
                                .ok_or_else(|| {
                                    anyhow!("outer core module index {index} is out of range")
                                })?;
                            self.frames[frame].core_modules.push(module);
                        }
                        OuterKind::Component => {
                            let component = self.frames[outer]
                                .components
                                .get(*index as usize)
                                .copied()
                                .ok_or_else(|| {
                                    anyhow!("outer component index {index} is out of range")
                                })?;
                            self.frames[frame].components.push(component);
                        }
                        OuterKind::Type => {
                            let found = *self.frames[outer].types.get(*index as usize).ok_or_else(
                                || anyhow!("outer type index {index} is out of range"),
                            )?;
                            if let (Some(ordinal), Some(found)) = (resource, found) {
                                self.bind_resource(frame, *ordinal, found)?;
                            }
                            self.frames[frame].types.push(found);
                        }
                    }
                }
                Def::Type(TypeDef::Resource { resource, dtor }) => {
                    let dtor = dtor
                        .map(|dtor| self.core_func(frame, dtor, "resource destructor"))
                        .transpose()?;
                    let lexical = component
                        .resource_names
                        .get(*resource as usize)
                        .filter(|name| !name.is_empty());
                    let index = self.plan.resources.len();
                    self.plan.resources.push(ResourcePlan {
                        name: match lexical {
                            Some(lexical) => format!("{name}:{lexical}"),
                            None => format!("{name}:resource{index}"),
                        },
                        named: lexical.is_some(),
                        owner: Some(frame),
                        dtor,
                        host_drop_name: None,
                        host_drop: None,
                    });
                    self.bind_resource(frame, *resource, index)?;
                    self.frames[frame].types.push(Some(index));
                }
                Def::Type(TypeDef::Other) => self.frames[frame].types.push(None),
                Def::Lift {
                    core_func,
                    ty,
                    options,
                } => {
                    let core = self.core_func(frame, *core_func, "canon lift")?;
                    let options = self.lift_options(frame, options)?;
                    let ty = self.resolve_type(frame, ty)?;
                    self.frames[frame].funcs.push(ComponentFunc::Lifted {
                        name: None,
                        frame,
                        core,
                        ty,
                        options,
                    });
                }
                Def::Lower { func, options } => {
                    let lift = self.lift_options(frame, options)?;
                    let lower = LowerOptions {
                        memory: lift.memory,
                        realloc: lift.realloc,
                        encoding: lift.encoding,
                    };
                    let target = self.frames[frame]
                        .funcs
                        .get(*func as usize)
                        .cloned()
                        .ok_or_else(|| {
                            anyhow!("canon lower names function {func}, which is out of range")
                        })?;
                    let core = match target {
                        ComponentFunc::Import {
                            interface,
                            name,
                            ty,
                        } => {
                            let module = interface.unwrap_or_else(|| "$root".to_string());
                            // The host must know which memory and allocator a
                            // pointer belongs to, and which table a handle
                            // belongs to. Only identical lowerings can share
                            // an import of the output module.
                            let handles = type_has_handles(&ty);
                            let existing = self.plan.imports.iter().position(|import| {
                                import.module == module
                                    && import.name == name
                                    && import.ty == ty
                                    && import.lower == lower
                                    && (!handles || import.frame == frame)
                            });
                            let index = match existing {
                                Some(index) => index,
                                None => {
                                    self.plan.imports.push(ImportPlan {
                                        module,
                                        name,
                                        ty,
                                        lower,
                                        frame,
                                    });
                                    self.plan.imports.len() - 1
                                }
                            };
                            CoreFunc::Import(index)
                        }
                        ComponentFunc::Lifted {
                            name: lifted_name,
                            frame: callee_frame,
                            core,
                            ty,
                            options,
                        } => {
                            let index = self.plan.adapters.len();
                            self.plan.adapters.push(AdapterPlan {
                                name: lifted_name.unwrap_or_else(|| format!("adapter{index}")),
                                ty,
                                callee: core,
                                lift: options,
                                lower,
                                caller_frame: frame,
                                callee_frame,
                            });
                            CoreFunc::Adapter(index)
                        }
                    };
                    self.frames[frame].core_funcs.push(core);
                }
                Def::Builtin { kind, resource } => {
                    let core = self.builtin(frame, *kind, *resource)?;
                    self.frames[frame].core_funcs.push(core);
                }
                Def::Import { name: import, ty } => {
                    let entity = match imports.get(import) {
                        Some(provided) => {
                            let provided = provided.clone();
                            self.bind_import(frame, import, ty, &provided)?;
                            provided
                        }
                        None => self.import_entity(frame, None, import, ty)?,
                    };
                    self.push_entity(frame, ty.kind(), entity, &format!("import `{import}`"))?;
                }
                Def::Export {
                    name: export,
                    kind,
                    index,
                    resource,
                } => {
                    let entity = match self.entity(frame, *kind, *index)? {
                        Entity::Func(func) => Entity::Func(func.named(export)),
                        other => other,
                    };
                    if let (Some(ordinal), Entity::Type(Some(index))) = (resource, &entity) {
                        self.bind_resource(frame, *ordinal, *index)?;
                        self.name_resource(*index, export);
                    }
                    // An export is also a definition: it appends the exported
                    // item to its index space under a fresh index.
                    self.push_entity(frame, *kind, entity.clone(), &format!("export `{export}`"))?;
                    self.frames[frame].exports.insert(export.clone(), entity);
                }
            }
        }

        Ok(std::mem::take(&mut self.frames[frame].exports))
    }
}

fn export_names(component: &Component) -> HashSet<String> {
    component
        .defs
        .iter()
        .filter_map(|def| match def {
            Def::Export { name, kind, .. } if *kind != Kind::Type => Some(name.clone()),
            _ => None,
        })
        .collect()
}

fn import_names(component: &Component) -> HashSet<String> {
    component
        .defs
        .iter()
        .filter_map(|def| match def {
            Def::Import { name, ty } if !matches!(ty, ImportType::Type(_)) => Some(name.clone()),
            _ => None,
        })
        .collect()
}

fn add_exports(plan: &mut Plan, name: &str, entity: &Entity<'_>) -> Result<()> {
    match entity {
        Entity::Func(ComponentFunc::Lifted {
            frame,
            core,
            ty,
            options,
            ..
        }) => plan.exports.push(ExportPlan {
            name: name.to_string(),
            func: core.clone(),
            ty: ty.clone(),
            lift: options.clone(),
            frame: *frame,
        }),
        Entity::Func(ComponentFunc::Import { .. }) => {
            bail!("export `{name}` re-exports an import nothing in the package satisfies")
        }
        Entity::Instance(exports) => {
            for (item, entity) in exports {
                match entity {
                    Entity::Instance(_) => {
                        bail!("export `{name}` nests instance `{item}`, which is not supported")
                    }
                    Entity::Type(resource) => add_resource_export(
                        plan,
                        &format!("{name}#[resource-drop]{item}"),
                        *resource,
                    ),
                    entity => add_exports(plan, &format!("{name}#{item}"), entity)?,
                }
            }
        }
        Entity::Type(resource) => {
            add_resource_export(plan, &format!("[resource-drop]{name}"), *resource)
        }
        Entity::Module(_) | Entity::Component(_) => {}
    }
    Ok(())
}

/// A resource a component of the package implements gets a destructor
/// export; one the host implements is the host's own.
fn add_resource_export(plan: &mut Plan, name: &str, resource: Option<usize>) {
    if let Some(resource) = resource {
        if plan.resources[resource].owner.is_some() {
            plan.resource_exports.push(ResourceExportPlan {
                name: name.to_string(),
                resource,
            });
        }
    }
}

/// Evaluates the instantiation graph of `components`, plugging each
/// component's imports with the same-named exports of the others.
///
/// The exports of the linked program are the exports of the components no
/// other component draws from, and the bare functions of the rest that no
/// component imports: a platform's own entry points stay reachable from the
/// host, while an interface it offers that no game happens to use stays
/// internal.
pub fn link(components: &[(String, Component)]) -> Result<Plan> {
    let exports: Vec<HashSet<String>> = components.iter().map(|(_, c)| export_names(c)).collect();
    let imports: Vec<HashSet<String>> = components.iter().map(|(_, c)| import_names(c)).collect();
    let imported: HashSet<&str> = imports.iter().flatten().map(String::as_str).collect();

    let mut provider: HashMap<&str, usize> = HashMap::new();
    for (index, names) in exports.iter().enumerate() {
        for name in names {
            if let Some(previous) = provider.insert(name, index) {
                bail!(
                    "both `{}` and `{}` export `{name}`",
                    components[previous].0,
                    components[index].0
                );
            }
        }
    }

    // Dependency edges point from a provider to its consumer.
    let mut dependencies: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); components.len()];
    let mut consumed = vec![false; components.len()];
    for (index, names) in imports.iter().enumerate() {
        for name in names {
            if let Some(&source) = provider.get(name.as_str()) {
                if source == index {
                    bail!("`{}` imports its own export `{name}`", components[index].0);
                }
                dependencies[index].insert(source);
                consumed[source] = true;
            }
        }
    }

    let mut order = Vec::with_capacity(components.len());
    let mut placed = vec![false; components.len()];
    while order.len() < components.len() {
        let next = (0..components.len())
            .find(|&index| !placed[index] && dependencies[index].iter().all(|&dep| placed[dep]))
            .ok_or_else(|| anyhow!("the components import each other in a cycle"))?;
        placed[next] = true;
        order.push(next);
    }

    let mut linker = Linker {
        plan: Plan::default(),
        module_info: Vec::new(),
        frames: Vec::new(),
    };
    let mut provided: IndexMap<String, Entity<'_>> = IndexMap::new();
    let mut roots: Vec<(usize, IndexMap<String, Entity<'_>>)> = Vec::new();
    for index in order {
        let (name, component) = &components[index];
        let exports = linker
            .instantiate(component, None, &provided, name, name)
            .with_context(|| format!("instantiating component `{name}`"))?;
        if consumed[index] {
            let mut own = IndexMap::new();
            for (export, entity) in exports {
                if !imported.contains(export.as_str()) && matches!(entity, Entity::Func(_)) {
                    own.insert(export, entity);
                } else {
                    provided.insert(export, entity);
                }
            }
            if !own.is_empty() {
                roots.push((index, own));
            }
        } else {
            roots.push((index, exports));
        }
    }

    let mut plan = linker.plan;
    // Preserve ordinary import names when there is only one lowering. A
    // reserved suffix distinguishes multiple contexts without asking a host
    // to guess the caller from its pointer arguments. '$' cannot occur in a
    // component external name.
    let mut counts = HashMap::new();
    for import in &plan.imports {
        *counts
            .entry((import.module.clone(), import.name.clone()))
            .or_insert(0) += 1;
    }
    for (index, import) in plan.imports.iter_mut().enumerate() {
        if counts[&(import.module.clone(), import.name.clone())] > 1 {
            import.name = format!("{}$lower{index}", import.name);
        }
    }
    for (index, exports) in roots {
        for (export, entity) in &exports {
            add_exports(&mut plan, export, entity)
                .with_context(|| format!("exporting from component `{}`", components[index].0))?;
        }
    }
    // A resource may be named after the types that mention it were
    // resolved; give every type the final name.
    let names: Vec<String> = plan
        .resources
        .iter()
        .map(|resource| resource.name.clone())
        .collect();
    let rename = |ty: &mut FuncType| {
        for (_, param) in &mut ty.params {
            rename_resources(param, &names);
        }
        if let Some(result) = &mut ty.result {
            rename_resources(result, &names);
        }
    };
    for adapter in &mut plan.adapters {
        rename(&mut adapter.ty);
    }
    for import in &mut plan.imports {
        rename(&mut import.ty);
    }
    for export in &mut plan.exports {
        rename(&mut export.ty);
    }
    Ok(plan)
}

fn rename_resources(ty: &mut ValType, names: &[String]) {
    match ty {
        ValType::Own(resource) | ValType::Borrow(resource) => {
            resource.name = names[resource.id as usize].clone();
        }
        ValType::List(element) | ValType::Option(element) => rename_resources(element, names),
        ValType::Record(fields) => {
            for (_, field) in fields {
                rename_resources(field, names);
            }
        }
        ValType::Tuple(items) => {
            for item in items {
                rename_resources(item, names);
            }
        }
        ValType::Variant(cases) => {
            for (_, case) in cases {
                if let Some(case) = case {
                    rename_resources(case, names);
                }
            }
        }
        ValType::Result { ok, err } => {
            for side in [ok, err].into_iter().flatten() {
                rename_resources(side, names);
            }
        }
        _ => {}
    }
}
