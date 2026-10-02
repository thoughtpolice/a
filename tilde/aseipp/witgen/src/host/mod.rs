// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Host bindings: the side of a world's imports that a host implements
//! itself, under wlink's host ABI (wlink's README, "Host ABI"). A package
//! wlink links keeps every import nothing in it satisfies as a core import
//! with its canonical lowered signature, and exports the memory and
//! allocator of each one's canonical options as `wlink:import:M#F:memory`
//! and `:realloc`. The host, as the callee of those lowerings, lifts the
//! arguments out of the flat values and that memory, and lowers the results
//! back, allocating strings and lists with that allocator.
//!
//! The bindings do that part, so a host implements each function with
//! typed values: a trait in Rust, an interface in TypeScript, prototypes in
//! C over wasm2c's output. How they do it is wit-bindgen-core's plan for a
//! host providing an import, which each language renders ([`plan`]). Strings and lists the guest passes are views of
//! its memory (strings as their UTF-8 bytes, which the bindings do not
//! validate), and the host returns its own, which the bindings copy in.
//!
//! What a host implements this way is plain data: booleans, numbers,
//! characters, strings, lists, records, tuples, enums and flags of up to 32
//! members. Functions that pass anything else (options, results, variants,
//! resources, futures and streams), async functions, and lists of strings or
//! lists as parameters are reported and left out.

use std::collections::{HashMap, HashSet};

use anyhow::{Result, bail};
use wit_parser::abi::{AbiVariant, WasmSignature, WasmType};
use wit_parser::{
    Docs, Function, FunctionKind, Resolve, Type, TypeDefKind, TypeId, WorldId, WorldItem, WorldKey,
};

use crate::abi::{Sizes, core, discriminant_size};
use crate::{Report, kind_name, names};

mod c;
mod plan;
mod rust;
#[cfg(test)]
mod tests;
mod ts;

/// The language of a host's bindings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    C,
    Rust,
    Ts,
}

/// Names for the C bindings, whose functions and types share one namespace.
#[derive(Clone, Debug, Default)]
pub struct COptions {
    /// The prefix of the types and of the functions the host implements;
    /// `namespace_package_interface_` by default.
    pub prefix: Option<String>,
    /// The prefix under which the bindings define the imports wasm2c's
    /// module calls and find their memories and allocators, as the host's
    /// aliases of wasm2c's names give them (`F`, `F_memory`, `F_realloc`);
    /// `namespace_package_` by default.
    pub flat_prefix: Option<String>,
    /// The type of the imports' context argument, which the host declares
    /// before it includes the bindings; `namespace_package_t` by default.
    pub context: Option<String>,
}

/// Generates the host bindings of `world`'s imports in `lang`, under
/// `header` lines.
pub fn host(
    resolve: &Resolve,
    world: WorldId,
    lang: Lang,
    c: &COptions,
    header: &[String],
) -> Result<(String, Report)> {
    let model = Model::new(resolve, world)?;
    let mut out = String::new();
    for line in header {
        out.push_str(line);
        out.push('\n');
    }
    if !header.is_empty() {
        out.push('\n');
    }
    match lang {
        Lang::C => c::generate(&model, c, &mut out)?,
        Lang::Rust => rust::generate(&model, &mut out),
        Lang::Ts => ts::generate(&model, &mut out)?,
    }
    Ok((out, model.report))
}

/// A WIT type a host's bindings carry, with the WIT type it lays out as.
#[derive(Clone, Debug)]
pub(crate) struct Ty {
    pub wit: Type,
    pub kind: Kind,
}

#[derive(Clone, Debug)]
pub(crate) enum Kind {
    Bool,
    U8,
    S8,
    U16,
    S16,
    U32,
    S32,
    U64,
    S64,
    F32,
    F64,
    Char,
    String,
    List(Box<Ty>),
    Tuple(Vec<Ty>),
    /// A record, enum or flags: its definition is in [`Model::defs`].
    Named(TypeId),
}

/// A named type's definition.
#[derive(Clone, Debug)]
pub(crate) enum Def {
    Record { fields: Vec<(String, Ty, Docs)> },
    Enum { cases: Vec<(String, Docs)> },
    Flags { flags: Vec<(String, Docs)> },
}

/// A named type: its WIT name, documentation and definition, and the group
/// that defines it in the bindings.
#[derive(Clone, Debug)]
pub(crate) struct Named {
    pub name: String,
    pub docs: Docs,
    pub def: Def,
    /// The group whose bindings define it, once a function it binds uses it.
    pub group: Option<usize>,
}

/// A function the host implements.
#[derive(Clone, Debug)]
pub(crate) struct Func {
    /// The WIT function, whose plan the backends render.
    pub function: Function,
    /// The WIT name, which is also the core import's.
    pub name: String,
    pub docs: Docs,
    pub params: Vec<(String, Ty)>,
    pub result: Option<Ty>,
    /// The core signature: params spilled to memory when there are more
    /// than sixteen flat ones, results through a return pointer when more
    /// than one.
    pub sig: WasmSignature,
    /// Whether the import has a memory: it passes or returns a pointer.
    pub memory: bool,
    /// Whether it has an allocator: its result holds strings or lists.
    pub realloc: bool,
}

/// The functions of one imported interface, or the world's own.
#[derive(Clone, Debug)]
pub(crate) struct Group {
    /// The core import module: `ns:pkg/iface@version`, or `$root`.
    pub module: String,
    /// The interface's name, or the world's for its own functions.
    pub name: String,
    pub docs: Docs,
    pub funcs: Vec<Func>,
    /// The named types this group defines, in the order they are first used.
    pub defs: Vec<TypeId>,
}

pub(crate) struct Model<'a> {
    pub resolve: &'a Resolve,
    pub sizes: Sizes<'a>,
    /// The world's name and its package's namespace and name.
    pub world: String,
    pub namespace: String,
    pub package: String,
    pub groups: Vec<Group>,
    pub named: HashMap<TypeId, Named>,
    pub report: Report,
}

impl<'a> Model<'a> {
    fn new(resolve: &'a Resolve, world_id: WorldId) -> Result<Self> {
        let world = &resolve.worlds[world_id];
        let package = world
            .package
            .map(|id| &resolve.packages[id].name)
            .ok_or_else(|| anyhow::anyhow!("world {} has no package", world.name))?;
        let mut model = Model {
            resolve,
            sizes: Sizes::new(resolve),
            world: world.name.clone(),
            namespace: package.namespace.clone(),
            package: package.name.clone(),
            groups: Vec::new(),
            named: HashMap::new(),
            report: Report::default(),
        };
        let mut root = Vec::new();
        for (key, item) in &world.imports {
            match item {
                WorldItem::Interface { id, .. } => {
                    let interface = &resolve.interfaces[*id];
                    let name = match key {
                        WorldKey::Name(name) => name.clone(),
                        WorldKey::Interface(_) => interface.name.clone().unwrap_or_default(),
                    };
                    let module = resolve.name_world_key(key);
                    let functions: Vec<&Function> = interface.functions.values().collect();
                    model.group(module, name, interface.docs.clone(), &functions);
                }
                WorldItem::Function(function) => root.push(function),
                WorldItem::Type { .. } => {}
            }
        }
        if !root.is_empty() {
            let name = model.world.clone();
            model.group("$root".to_string(), name, Docs::default(), &root);
        }
        model.check_names()?;
        Ok(model)
    }

    fn group(&mut self, module: String, name: String, docs: Docs, functions: &[&Function]) {
        let index = self.groups.len();
        self.groups.push(Group {
            module: module.clone(),
            name,
            docs,
            funcs: Vec::new(),
            defs: Vec::new(),
        });
        for function in functions {
            match self.func(function) {
                Ok(func) => {
                    let mut used = Vec::new();
                    for (_, ty) in &func.params {
                        self.uses(ty, &mut used);
                    }
                    if let Some(ty) = &func.result {
                        self.uses(ty, &mut used);
                    }
                    for id in used {
                        let named = self.named.get_mut(&id).expect("registered");
                        if named.group.is_none() {
                            named.group = Some(index);
                            self.groups[index].defs.push(id);
                        }
                    }
                    self.groups[index].funcs.push(func);
                }
                Err(reason) => self
                    .report
                    .skipped
                    .push(format!("{module}#{}: {reason}", function.name)),
            }
        }
    }

    fn func(&mut self, function: &Function) -> Result<Func, String> {
        match function.kind {
            FunctionKind::Freestanding => {}
            FunctionKind::AsyncFreestanding => return Err("async functions".into()),
            _ => return Err("functions of resources".into()),
        }
        let mut params = Vec::new();
        for param in &function.params {
            let (name, ty) = (&param.name, &param.ty);
            let ty = self.ty(ty)?;
            if let Kind::List(element) = &ty.kind
                && self.has_pointers(element)
            {
                return Err("passes a list of strings or lists".into());
            }
            params.push((name.clone(), ty));
        }
        let result = match &function.result {
            Some(ty) => Some(self.ty(ty)?),
            None => None,
        };
        let sig = self
            .resolve
            .wasm_signature(AbiVariant::GuestImport, function);
        self.check_signature(&params, result.as_ref(), &sig)?;
        let memory = sig.indirect_params
            || sig.retptr
            || params.iter().any(|(_, ty)| self.has_pointers(ty))
            || result.as_ref().is_some_and(|ty| self.has_pointers(ty));
        let realloc = result.as_ref().is_some_and(|ty| self.has_pointers(ty));
        Ok(Func {
            function: function.clone(),
            name: function.name.clone(),
            docs: function.docs.clone(),
            params,
            result,
            sig,
            memory,
            realloc,
        })
    }

    fn ty(&mut self, ty: &Type) -> Result<Ty, String> {
        let kind = match ty {
            Type::Bool => Kind::Bool,
            Type::U8 => Kind::U8,
            Type::S8 => Kind::S8,
            Type::U16 => Kind::U16,
            Type::S16 => Kind::S16,
            Type::U32 => Kind::U32,
            Type::S32 => Kind::S32,
            Type::U64 => Kind::U64,
            Type::S64 => Kind::S64,
            Type::F32 => Kind::F32,
            Type::F64 => Kind::F64,
            Type::Char => Kind::Char,
            Type::String => Kind::String,
            Type::ErrorContext => return Err("passes an error-context".into()),
            Type::Id(id) => {
                let def = &self.resolve.types[*id];
                match &def.kind {
                    TypeDefKind::Type(inner) => return self.ty(inner),
                    TypeDefKind::List(element) => Kind::List(Box::new(self.ty(element)?)),
                    TypeDefKind::Tuple(tuple) => Kind::Tuple(
                        tuple
                            .types
                            .iter()
                            .map(|ty| self.ty(ty))
                            .collect::<Result<_, _>>()?,
                    ),
                    TypeDefKind::Record(record) => {
                        if !self.named.contains_key(id) {
                            let mut fields = Vec::new();
                            for field in &record.fields {
                                fields.push((
                                    field.name.clone(),
                                    self.ty(&field.ty)?,
                                    field.docs.clone(),
                                ));
                            }
                            self.declare(*id, Def::Record { fields });
                        }
                        Kind::Named(*id)
                    }
                    TypeDefKind::Enum(enum_) => {
                        let cases = enum_
                            .cases
                            .iter()
                            .map(|case| (case.name.clone(), case.docs.clone()))
                            .collect();
                        self.declare(*id, Def::Enum { cases });
                        Kind::Named(*id)
                    }
                    TypeDefKind::Flags(flags) => {
                        if flags.flags.len() > 32 {
                            return Err("passes flags of more than 32 members".into());
                        }
                        let flags = flags
                            .flags
                            .iter()
                            .map(|flag| (flag.name.clone(), flag.docs.clone()))
                            .collect();
                        self.declare(*id, Def::Flags { flags });
                        Kind::Named(*id)
                    }
                    other => return Err(format!("passes a {}", kind_name(other))),
                }
            }
        };
        Ok(Ty { wit: *ty, kind })
    }

    /// Registers a named type; the group that first uses it in a function
    /// it binds defines it.
    fn declare(&mut self, id: TypeId, def: Def) {
        if self.named.contains_key(&id) {
            return;
        }
        let ty = &self.resolve.types[id];
        self.named.insert(
            id,
            Named {
                name: ty.name.clone().unwrap_or_default(),
                docs: ty.docs.clone(),
                def,
                group: None,
            },
        );
    }

    /// The named types a type uses, each after the ones it holds, as C
    /// declares them.
    fn uses(&self, ty: &Ty, into: &mut Vec<TypeId>) {
        match &ty.kind {
            Kind::List(element) => self.uses(element, into),
            Kind::Tuple(items) => {
                for item in items {
                    self.uses(item, into);
                }
            }
            Kind::Named(id) => {
                if into.contains(id) {
                    return;
                }
                if let Def::Record { fields } = &self.named(*id).def {
                    for (_, field, _) in fields {
                        self.uses(field, into);
                    }
                }
                into.push(*id);
            }
            _ => {}
        }
    }

    /// Two named types of one name in a language without namespaces would
    /// collide; so would two groups of one name.
    fn check_names(&self) -> Result<()> {
        let mut seen = HashSet::new();
        for group in &self.groups {
            if !seen.insert(group.name.as_str()) {
                bail!("two imported interfaces are named {}", group.name);
            }
        }
        let mut seen = HashSet::new();
        for named in self.named.values().filter(|named| named.group.is_some()) {
            if !seen.insert(named.name.as_str()) {
                bail!("two imported types are named {}", named.name);
            }
        }
        Ok(())
    }

    /// The flat types the bindings take and return must be wit-parser's.
    fn check_signature(
        &self,
        params: &[(String, Ty)],
        result: Option<&Ty>,
        sig: &WasmSignature,
    ) -> Result<(), String> {
        let mut flat = Vec::new();
        for (_, ty) in params {
            self.flat(ty, &mut flat);
        }
        if flat.len() > 16 {
            flat = vec![WasmType::I32];
        }
        let mut results = Vec::new();
        if let Some(ty) = result {
            self.flat(ty, &mut results);
        }
        if results.len() > 1 {
            flat.push(WasmType::I32);
            results.clear();
        }
        let expected: Vec<WasmType> = sig.params.iter().map(|ty| core(*ty)).collect();
        let expected_results: Vec<WasmType> = sig.results.iter().map(|ty| core(*ty)).collect();
        if flat != expected || results != expected_results {
            return Err(format!(
                "flattens to ({flat:?}) -> ({results:?}), but the canonical ABI says ({expected:?}) -> ({expected_results:?})"
            ));
        }
        Ok(())
    }

    /// The flat types of a value, as the canonical ABI flattens it.
    pub fn flat(&self, ty: &Ty, into: &mut Vec<WasmType>) {
        match &ty.kind {
            Kind::U64 | Kind::S64 => into.push(WasmType::I64),
            Kind::F32 => into.push(WasmType::F32),
            Kind::F64 => into.push(WasmType::F64),
            Kind::String | Kind::List(_) => into.extend([WasmType::I32, WasmType::I32]),
            Kind::Tuple(items) => {
                for item in items {
                    self.flat(item, into);
                }
            }
            Kind::Named(id) => match &self.named(*id).def {
                Def::Record { fields } => {
                    for (_, field, _) in fields {
                        self.flat(field, into);
                    }
                }
                _ => into.push(WasmType::I32),
            },
            _ => into.push(WasmType::I32),
        }
    }

    /// Whether a value of the type holds a pointer into memory.
    pub fn has_pointers(&self, ty: &Ty) -> bool {
        match &ty.kind {
            Kind::String | Kind::List(_) => true,
            Kind::Tuple(items) => items.iter().any(|item| self.has_pointers(item)),
            Kind::Named(id) => match &self.named(*id).def {
                Def::Record { fields } => fields.iter().any(|(_, ty, _)| self.has_pointers(ty)),
                _ => false,
            },
            _ => false,
        }
    }

    /// A type of a bound function, which the model already knows.
    pub fn ty_of(&self, ty: &Type) -> Ty {
        let kind = match ty {
            Type::Bool => Kind::Bool,
            Type::U8 => Kind::U8,
            Type::S8 => Kind::S8,
            Type::U16 => Kind::U16,
            Type::S16 => Kind::S16,
            Type::U32 => Kind::U32,
            Type::S32 => Kind::S32,
            Type::U64 => Kind::U64,
            Type::S64 => Kind::S64,
            Type::F32 => Kind::F32,
            Type::F64 => Kind::F64,
            Type::Char => Kind::Char,
            Type::String => Kind::String,
            Type::ErrorContext => unreachable!("no bound function passes an error-context"),
            Type::Id(id) => match &self.resolve.types[*id].kind {
                TypeDefKind::Type(inner) => return self.ty_of(inner),
                TypeDefKind::List(element) => Kind::List(Box::new(self.ty_of(element))),
                TypeDefKind::Tuple(tuple) => {
                    Kind::Tuple(tuple.types.iter().map(|ty| self.ty_of(ty)).collect())
                }
                _ => Kind::Named(*id),
            },
        };
        Ty { wit: *ty, kind }
    }

    pub fn named(&self, id: TypeId) -> &Named {
        &self.named[&id]
    }

    pub fn size(&self, ty: &Ty) -> usize {
        self.sizes.size(&ty.wit)
    }

    pub fn align(&self, ty: &Ty) -> usize {
        self.sizes.align(&ty.wit)
    }

    /// The offsets of a record's fields or a tuple's items.
    pub fn offsets(&self, ty: &Ty) -> Vec<usize> {
        self.sizes.offsets(&self.sizes.parts(&ty.wit))
    }

    /// The parts of a record or tuple, in memory order.
    pub fn parts<'t>(&'t self, ty: &'t Ty) -> Vec<&'t Ty> {
        match &ty.kind {
            Kind::Tuple(items) => items.iter().collect(),
            Kind::Named(id) => match &self.named(*id).def {
                Def::Record { fields } => fields.iter().map(|(_, ty, _)| ty).collect(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// Whether a named type is a record, rather than an enum or flags.
    pub fn is_record(&self, id: TypeId) -> bool {
        matches!(self.named(id).def, Def::Record { .. })
    }

    /// The bytes an enum's discriminant or a flags value takes.
    pub fn scalar_size(&self, id: TypeId) -> usize {
        match &self.named(id).def {
            Def::Enum { cases } => discriminant_size(cases.len()),
            Def::Flags { flags } => match flags.len() {
                0..=8 => 1,
                9..=16 => 2,
                _ => 4,
            },
            Def::Record { .. } => unreachable!("a record is not a scalar"),
        }
    }

    /// The layout of a function's spilled parameters, as a tuple's: the
    /// offset of each, the tuple's size and alignment.
    pub fn spilled(&self, func: &Func) -> (Vec<usize>, usize, usize) {
        let types: Vec<Type> = func.params.iter().map(|(_, ty)| ty.wit).collect();
        let offsets = self.sizes.offsets(&types);
        let align = types
            .iter()
            .map(|ty| self.sizes.align(ty))
            .max()
            .unwrap_or(1);
        let end = offsets
            .iter()
            .zip(&types)
            .map(|(offset, ty)| offset + self.sizes.size(ty))
            .max()
            .unwrap_or(0);
        (offsets, end.next_multiple_of(align), align)
    }
}

/// Whether a name is one the bindings give a flat argument: `a0`, `a1`...
pub(crate) fn is_flat_name(name: &str) -> bool {
    name.strip_prefix('a').is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

/// Documentation lines, without trailing blank ones.
pub(crate) fn doc_lines(docs: &Docs) -> Vec<&str> {
    let Some(contents) = &docs.contents else {
        return Vec::new();
    };
    contents.trim_end().lines().map(str::trim_end).collect()
}

/// The comment every backend's output starts with: where the bindings come
/// from, a line of it at a time.
pub(crate) fn provenance(model: &Model) -> [String; 2] {
    [
        format!(
            "Host bindings for the imports of world {} of {}:{},",
            model.world, model.namespace, model.package
        ),
        "generated by witgen.".to_string(),
    ]
}

/// The C-style name of a group: `namespace_package_interface`.
pub(crate) fn group_snake(model: &Model, group: &Group) -> String {
    format!(
        "{}_{}_{}",
        names::snake(&model.namespace),
        names::snake(&model.package),
        names::snake(&group.name)
    )
}
