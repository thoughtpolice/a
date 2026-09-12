// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! C# bindings for gameplayc from a WIT world. The modules gameplayc
//! produces are wrapped into components by `wlink componentize`.
//!
//! gameplayc modules have no linear memory: every value crossing the module
//! boundary is an i32, i64, f32 or f64. The component model's canonical ABI
//! passes exactly those for scalars, enums, flags, handles of imported
//! resources, records of them and options of such records (as parameters and
//! record fields), so a WIT world restricted to that vocabulary is
//! implementable by a gameplayc module, and the generated bindings name the
//! imports and exports the way the canonical ABI does. A function whose
//! signature needs memory (strings, lists, records as results, more than
//! sixteen flat parameters) or names an exported resource is reported and
//! left out.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::Path;

use anyhow::{Context, Result, bail};
use wit_parser::abi::{AbiVariant, WasmSignature, WasmType};
use wit_parser::{
    Function, FunctionKind, Handle, InterfaceId, PackageId, Resolve, Type, TypeDefKind, TypeId,
    TypeOwner, World, WorldId, WorldItem, WorldKey,
};

mod names;
#[cfg(test)]
mod tests;

/// Parses WIT files or package directories in dependency order and selects a
/// world from the last one.
pub fn load(wit: &[impl AsRef<Path>], world: Option<&str>) -> Result<(Resolve, WorldId)> {
    let mut resolve = Resolve::default();
    let mut main: Option<PackageId> = None;
    for path in wit {
        let path = path.as_ref();
        let (package, _) = resolve
            .push_path(path)
            .with_context(|| format!("parsing WIT at {}", path.display()))?;
        main = Some(package);
    }
    let Some(main) = main else {
        bail!("at least one WIT file or package directory is needed")
    };
    let world = resolve
        .select_world(&[main], world)
        .context("selecting the world")?;
    Ok((resolve, world))
}

/// What the generator could not express, one line per function or type.
#[derive(Debug, Default)]
pub struct Report {
    pub skipped: Vec<String>,
}

/// The SPDX header lines a WIT file starts with, if any: generated code
/// carries the license of the WIT it came from.
pub fn spdx_header(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .take_while(|line| line.starts_with("// SPDX-"))
        .map(str::to_string)
        .collect()
}

/// Generates the C# bindings for `world`, under `header` lines.
pub fn csharp(
    resolve: &Resolve,
    world: WorldId,
    namespace: Option<&str>,
    header: &[String],
) -> Result<(String, Report)> {
    let mut generator = Generator {
        resolve,
        world,
        out: String::new(),
        report: Report::default(),
        indent: 0,
        exported: Vec::new(),
        interface_classes: HashMap::new(),
        world_class: String::new(),
    };
    for line in header {
        generator.line(line);
    }
    if !header.is_empty() {
        generator.line("");
    }
    generator.world(namespace)?;
    Ok((generator.out, generator.report))
}

/// How a WIT type crosses the boundary from C#.
#[derive(Clone, Debug, PartialEq)]
enum Repr {
    /// A C# scalar type: one flat value, passed as it is.
    Scalar(&'static str, WasmType),
    /// A C# enum declared from a WIT enum or flags: one i32.
    Enum(String),
    /// A resource handle wrapped by a sealed class: one i32.
    Handle(String, bool),
    /// A record: a sealed class whose fields flatten in order.
    Record(String, Vec<(String, Repr)>),
    /// An option of a record: one i32 discriminant, then the record's
    /// fields, zero when absent. Parameters and record fields only.
    OptionRecord(Box<Repr>),
}

impl Repr {
    fn csharp(&self) -> String {
        match self {
            Repr::Scalar(name, _) => (*name).to_string(),
            Repr::Enum(name) | Repr::Handle(name, _) | Repr::Record(name, _) => name.clone(),
            Repr::OptionRecord(inner) => inner.csharp(),
        }
    }

    /// Visits the flat values in the order the canonical ABI lowers a
    /// parameter: each scalar, enum or handle, and None for an option's i32
    /// discriminant.
    fn each_flat<'a>(&'a self, visit: &mut impl FnMut(Option<&'a Repr>)) {
        match self {
            Repr::Scalar(..) | Repr::Enum(_) | Repr::Handle(..) => visit(Some(self)),
            Repr::Record(_, fields) => {
                for (_, field) in fields {
                    field.each_flat(visit);
                }
            }
            Repr::OptionRecord(inner) => {
                visit(None);
                inner.each_flat(visit);
            }
        }
    }

    /// The flat Wasm types, as the canonical ABI lowers a parameter.
    fn flat(&self, into: &mut Vec<WasmType>) {
        self.each_flat(&mut |leaf| {
            into.push(match leaf {
                Some(Repr::Scalar(_, wasm)) => *wasm,
                _ => WasmType::I32,
            })
        });
    }

    fn is_scalar_like(&self) -> bool {
        matches!(self, Repr::Scalar(..) | Repr::Enum(_) | Repr::Handle(..))
    }
}

struct Generator<'a> {
    resolve: &'a Resolve,
    world: WorldId,
    out: String,
    report: Report,
    indent: usize,
    /// Interfaces the world exports; their functions become partial methods.
    exported: Vec<InterfaceId>,
    /// The C# class of each interface of the world.
    interface_classes: HashMap<InterfaceId, String>,
    /// The C# class of the world itself.
    world_class: String,
}

impl Generator<'_> {
    fn line(&mut self, text: &str) {
        if text.is_empty() {
            self.out.push('\n');
            return;
        }
        for _ in 0..self.indent {
            self.out.push_str("    ");
        }
        self.out.push_str(text);
        self.out.push('\n');
    }

    fn open(&mut self, header: &str) {
        self.line(header);
        self.line("{");
        self.indent += 1;
    }

    fn close(&mut self) {
        self.indent -= 1;
        self.line("}");
    }

    fn docs(&mut self, docs: &wit_parser::Docs) {
        if let Some(contents) = &docs.contents {
            self.line("/// <summary>");
            for text in contents.trim_end().lines() {
                let escaped = text
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;");
                self.line(&format!("/// {}", escaped.trim_end()));
            }
            self.line("/// </summary>");
        }
    }

    fn skip(&mut self, what: String) {
        self.line(&format!("// Not generated: {what}"));
        self.report.skipped.push(what);
    }

    // MARK: World

    fn world(&mut self, namespace: Option<&str>) -> Result<()> {
        let resolve = self.resolve;
        let world = &resolve.worlds[self.world];
        let package = world
            .package
            .map(|id| &resolve.packages[id].name)
            .context("the world belongs to no package")?;
        let namespace = namespace
            .map(str::to_string)
            .unwrap_or_else(|| names::namespace(&package.namespace, &package.name));
        let world_class = names::class(&world.name);
        self.world_class = world_class.clone();
        self.interface_classes = interface_classes(resolve, world, &world_class);

        self.line("// <auto-generated/>");
        self.line(&format!(
            "// Bindings for world {} of {package}, generated by witgen for gameplayc.",
            world.name
        ));
        self.line("// The module implements the world's exports and calls its imports; edit");
        self.line("// the WIT and regenerate rather than this file.");
        self.line("#nullable disable");
        self.line("");
        self.line(&format!("namespace {namespace};"));

        for item in world.exports.values() {
            if let WorldItem::Interface { id, .. } = item {
                self.exported.push(*id);
            }
        }

        // Imported interfaces: a static class each, with their types.
        let imports: Vec<(WorldKey, WorldItem)> = world
            .imports
            .iter()
            .map(|(key, item)| (key.clone(), item.clone()))
            .collect();
        for (key, item) in &imports {
            if let WorldItem::Interface { id, .. } = item {
                self.line("");
                self.interface(key, *id, false)?;
            }
        }

        // The world's own imports and exports share the world class; the
        // exported interfaces nest inside it.
        self.line("");
        self.docs(&world.docs.clone());
        self.open(&format!("public static partial class {world_class}"));
        let mut first = true;
        for (_, item) in &imports {
            match item {
                WorldItem::Function(function) => {
                    if !first {
                        self.line("");
                    }
                    first = false;
                    self.import_function(function)?;
                }
                WorldItem::Type { id, .. } => {
                    if !self.emits_definition(*id) {
                        continue;
                    }
                    if !first {
                        self.line("");
                    }
                    first = false;
                    self.type_definition(*id)?;
                }
                WorldItem::Interface { .. } => {}
            }
        }
        let exports: Vec<(WorldKey, WorldItem)> = world
            .exports
            .iter()
            .map(|(key, item)| (key.clone(), item.clone()))
            .collect();
        for (key, item) in &exports {
            if let WorldItem::Type { id, .. } = item {
                if !self.emits_definition(*id) {
                    continue;
                }
            }
            if !first {
                self.line("");
            }
            first = false;
            match item {
                WorldItem::Function(function) => self.export_function(None, function)?,
                WorldItem::Type { id, .. } => self.type_definition(*id)?,
                WorldItem::Interface { id, .. } => self.interface(key, *id, true)?,
            }
        }
        if !first {
            self.line("");
        }
        self.open("private static class Imports");
        self.imports_of(&imports)?;
        self.close();
        self.close();
        Ok(())
    }

    /// The extern declarations behind a set of world items.
    fn imports_of(&mut self, items: &[(WorldKey, WorldItem)]) -> Result<()> {
        let mut first = true;
        for (_, item) in items {
            if let WorldItem::Function(function) = item {
                if let Some(repr) = self.function_reprs(function, true) {
                    if !first {
                        self.line("");
                    }
                    first = false;
                    self.extern_declaration("$root", function, &repr);
                }
            }
        }
        Ok(())
    }

    // MARK: Interfaces

    fn interface(&mut self, key: &WorldKey, id: InterfaceId, exported: bool) -> Result<()> {
        let resolve = self.resolve;
        let interface = &resolve.interfaces[id];
        let module = resolve.name_world_key(key);
        let class = self.interface_class(id);
        self.docs(&interface.docs.clone());
        if exported {
            self.line(&format!(
                "// Exported as {module}: implement the partial methods."
            ));
            self.open(&format!("public static partial class {class}"));
        } else {
            self.line(&format!("// Imported from {module}."));
            self.open(&format!("public static class {class}"));
        }

        let mut first = true;
        let type_ids: Vec<TypeId> = interface.types.values().copied().collect();
        for type_id in type_ids {
            if !self.emits_definition(type_id) {
                continue;
            }
            if !first {
                self.line("");
            }
            first = false;
            self.type_definition(type_id)?;
        }

        let functions: Vec<Function> = interface.functions.values().cloned().collect();
        for function in &functions {
            if !matches!(function.kind, FunctionKind::Freestanding) {
                continue;
            }
            if !first {
                self.line("");
            }
            first = false;
            if exported {
                self.export_function(Some(&module), function)?;
            } else {
                self.import_function(function)?;
            }
        }

        if !exported {
            if !first {
                self.line("");
            }
            self.open("private static class Imports");
            let mut first_extern = true;
            for function in &functions {
                if let Some(repr) = self.function_reprs(function, true) {
                    if !first_extern {
                        self.line("");
                    }
                    first_extern = false;
                    self.extern_declaration(&module, function, &repr);
                }
            }
            for type_id in interface.types.values() {
                if matches!(resolve.types[*type_id].kind, TypeDefKind::Resource) {
                    let name = resolve.types[*type_id].name.clone().unwrap_or_default();
                    if !first_extern {
                        self.line("");
                    }
                    first_extern = false;
                    self.line(&format!(
                        "[global::Gameplay.WasmImport(\"{module}\", \"[resource-drop]{name}\")]"
                    ));
                    self.line(&format!(
                        "internal static extern void {}Drop(int handle);",
                        names::pascal(&name)
                    ));
                }
            }
            self.close();
        }
        self.close();
        Ok(())
    }

    // MARK: Types

    /// The representation of a WIT type, or None when it needs memory.
    fn repr(&self, ty: &Type) -> Option<Repr> {
        Some(match ty {
            Type::Bool => Repr::Scalar("bool", WasmType::I32),
            Type::U8 => Repr::Scalar("byte", WasmType::I32),
            Type::S8 => Repr::Scalar("sbyte", WasmType::I32),
            Type::U16 => Repr::Scalar("ushort", WasmType::I32),
            Type::S16 => Repr::Scalar("short", WasmType::I32),
            Type::U32 => Repr::Scalar("uint", WasmType::I32),
            Type::S32 => Repr::Scalar("int", WasmType::I32),
            Type::U64 => Repr::Scalar("ulong", WasmType::I64),
            Type::S64 => Repr::Scalar("long", WasmType::I64),
            Type::F32 => Repr::Scalar("float", WasmType::F32),
            Type::F64 => Repr::Scalar("double", WasmType::F64),
            // A Unicode scalar value, as an int code point.
            Type::Char => Repr::Scalar("int", WasmType::I32),
            Type::String | Type::ErrorContext => return None,
            Type::Id(id) => {
                let definition = &self.resolve.types[*id];
                match &definition.kind {
                    TypeDefKind::Type(inner) => return self.repr(inner),
                    TypeDefKind::Enum(_) => Repr::Enum(self.type_path(*id)?),
                    TypeDefKind::Flags(flags) if flags.flags.len() <= 32 => {
                        Repr::Enum(self.type_path(*id)?)
                    }
                    TypeDefKind::Handle(handle) => {
                        let (resource, owned) = match handle {
                            Handle::Own(resource) => (*resource, true),
                            Handle::Borrow(resource) => (*resource, false),
                        };
                        // Only the resources of imported interfaces have a
                        // class; see `resource`.
                        let resource = self.dealias(resource);
                        match self.resolve.types[resource].owner {
                            TypeOwner::Interface(owner) if !self.exported.contains(&owner) => {}
                            _ => return None,
                        }
                        Repr::Handle(self.type_path(resource)?, owned)
                    }
                    TypeDefKind::Record(record) => {
                        let mut fields = Vec::new();
                        for field in &record.fields {
                            fields.push((names::pascal(&field.name), self.repr(&field.ty)?));
                        }
                        Repr::Record(self.type_path(*id)?, fields)
                    }
                    TypeDefKind::Option(inner) => match self.repr(inner)? {
                        record @ Repr::Record(..) => Repr::OptionRecord(Box::new(record)),
                        _ => return None,
                    },
                    _ => return None,
                }
            }
        })
    }

    /// The definition a type names, past any `use` aliases: `use a.{thing}`
    /// in interface b is declared once, as a's.
    fn dealias(&self, mut id: TypeId) -> TypeId {
        while let TypeDefKind::Type(Type::Id(inner)) = &self.resolve.types[id].kind {
            id = *inner;
        }
        id
    }

    /// The class of an interface of the world.
    fn interface_class(&self, id: InterfaceId) -> String {
        self.interface_classes.get(&id).cloned().unwrap_or_else(|| {
            names::class(
                self.resolve.interfaces[id]
                    .name
                    .as_deref()
                    .unwrap_or("anonymous"),
            )
        })
    }

    /// `Gfx.Color`: the class of the interface that defines the type, then
    /// the type; world-level types live in the world class.
    fn type_path(&self, id: TypeId) -> Option<String> {
        let definition = &self.resolve.types[self.dealias(id)];
        let name = names::pascal(definition.name.as_deref()?);
        Some(match definition.owner {
            TypeOwner::Interface(owner) => {
                let class = self.interface_class(owner);
                if self.exported.contains(&owner) {
                    format!("{}.{class}.{name}", self.world_class)
                } else {
                    format!("{class}.{name}")
                }
            }
            TypeOwner::World(world) => {
                format!("{}.{name}", names::class(&self.resolve.worlds[world].name))
            }
            TypeOwner::None => name,
        })
    }

    /// Whether a type gets a declaration: `use` aliases and handle types
    /// refer to declarations made elsewhere.
    fn emits_definition(&self, id: TypeId) -> bool {
        let definition = &self.resolve.types[id];
        definition.name.is_some()
            && !matches!(
                definition.kind,
                TypeDefKind::Type(_) | TypeDefKind::Handle(_)
            )
    }

    fn type_definition(&mut self, id: TypeId) -> Result<()> {
        let resolve = self.resolve;
        let definition = resolve.types[id].clone();
        let Some(name) = definition.name.clone() else {
            return Ok(());
        };
        let class = names::pascal(&name);
        match &definition.kind {
            TypeDefKind::Type(_) => {
                // A `use` of another interface's type: the original's class is
                // referenced by its path wherever the alias appears.
                Ok(())
            }
            TypeDefKind::Enum(definition_enum) => {
                self.docs(&definition.docs);
                self.open(&format!("public enum {class}"));
                for case in &definition_enum.cases {
                    self.docs(&case.docs);
                    self.line(&format!("{},", names::pascal(&case.name)));
                }
                self.close();
                Ok(())
            }
            TypeDefKind::Flags(flags) => {
                if flags.flags.len() > 32 {
                    self.skip(format!(
                        "flags {name}: more than 32 flags need several i32s"
                    ));
                    return Ok(());
                }
                self.docs(&definition.docs);
                self.line("[global::System.Flags]");
                self.open(&format!("public enum {class} : uint"));
                // The empty set, unless a flag already takes the name.
                if !flags
                    .flags
                    .iter()
                    .any(|flag| names::pascal(&flag.name) == "None")
                {
                    self.line("None = 0,");
                }
                for (index, flag) in flags.flags.iter().enumerate() {
                    self.docs(&flag.docs);
                    self.line(&format!("{} = 1u << {index},", names::pascal(&flag.name)));
                }
                self.close();
                Ok(())
            }
            TypeDefKind::Record(record) => {
                let Some(Repr::Record(_, fields)) = self.repr(&Type::Id(id)) else {
                    self.skip(format!("record {name}: a field needs memory"));
                    return Ok(());
                };
                self.docs(&definition.docs);
                self.open(&format!("public sealed class {class}"));
                for (field, (field_name, repr)) in record.fields.iter().zip(&fields) {
                    self.docs(&field.docs);
                    self.line(&format!("public {} {field_name};", repr.csharp()));
                }
                self.line("");
                self.open(&format!("public {class}()"));
                self.close();
                self.line("");
                let parameters: Vec<String> = record
                    .fields
                    .iter()
                    .zip(&fields)
                    .map(|(field, (_, repr))| {
                        format!("{} {}", repr.csharp(), names::camel(&field.name))
                    })
                    .collect();
                self.open(&format!("public {class}({})", parameters.join(", ")));
                for (field, (field_name, _)) in record.fields.iter().zip(&fields) {
                    self.line(&format!("{field_name} = {};", names::camel(&field.name)));
                }
                self.close();
                self.close();
                Ok(())
            }
            TypeDefKind::Resource => self.resource(id, &name, &definition.docs),
            TypeDefKind::Handle(_) => Ok(()),
            other => {
                self.skip(format!(
                    "type {name}: {} needs memory or is unsupported",
                    kind_name(other)
                ));
                Ok(())
            }
        }
    }

    /// A resource is a sealed class around the i32 handle. Its constructor,
    /// methods and statics come from the owning interface's functions.
    fn resource(&mut self, id: TypeId, name: &str, docs: &wit_parser::Docs) -> Result<()> {
        let resolve = self.resolve;
        let class = names::pascal(name);
        let TypeOwner::Interface(owner) = resolve.types[id].owner else {
            self.skip(format!(
                "resource {name}: only interface resources are supported"
            ));
            return Ok(());
        };
        let exported = self.exported.contains(&owner);
        if exported {
            self.skip(format!(
                "resource {name}: exported resources are not supported"
            ));
            return Ok(());
        }
        let functions: Vec<Function> = resolve.interfaces[owner]
            .functions
            .values()
            .filter(|function| match function.kind {
                FunctionKind::Constructor(resource)
                | FunctionKind::Method(resource)
                | FunctionKind::Static(resource) => resource == id,
                _ => false,
            })
            .cloned()
            .collect();

        self.docs(docs);
        self.open(&format!("public sealed class {class}"));
        self.line("internal int Handle;");
        self.line("internal bool Dropped;");
        self.line("");
        // The wrapping constructor takes a marker no WIT constructor can
        // (WIT names never contain `_`), so it never collides with one.
        self.open("private enum Adopt_");
        self.line("Handle,");
        self.close();
        self.line("");
        self.open(&format!("private {class}(Adopt_ adopt, int handle)"));
        self.line("Handle = handle;");
        self.close();
        self.line("");
        self.line(
            "/// <summary>Wraps a handle the host handed over; the caller owns it.</summary>",
        );
        self.line(&format!(
            "public static {class} FromHandle(int handle) => new {class}(Adopt_.Handle, handle);"
        ));
        self.line("");
        self.line("/// <summary>The handle as the host sees it.</summary>");
        self.line("public int ToHandle() => Handle;");
        self.line("");
        self.line("/// <summary>Drops the handle; later calls through it fault.</summary>");
        self.open("public void Dispose()");
        self.open("if (!Dropped)");
        self.line("Dropped = true;");
        self.line(&format!("Imports.{class}Drop(Handle);"));
        self.line("Handle = 0;");
        self.close();
        self.close();
        for function in &functions {
            self.line("");
            match function.kind {
                FunctionKind::Constructor(_) => self.resource_constructor(&class, function)?,
                _ => self.import_function(function)?,
            }
        }
        self.close();
        Ok(())
    }

    fn resource_constructor(&mut self, class: &str, function: &Function) -> Result<()> {
        let Some(repr) = self.function_reprs(function, true) else {
            self.skip(format!(
                "{}: a parameter needs memory or is unsupported",
                function.name
            ));
            return Ok(());
        };
        self.docs(&function.docs);
        let header = format!(
            "public {class}({})",
            csharp_params(function, &repr.params, 0)
        );
        self.import_wrapper(&header, function, &repr, Call::Constructor);
        Ok(())
    }

    // MARK: Functions

    /// The C# names an extern takes: the resource-qualified function name
    /// in PascalCase, so `[method]sheet.draw` is `SheetDraw`.
    fn extern_name(&self, function: &Function) -> String {
        match function.kind {
            FunctionKind::Constructor(resource) => {
                format!("{}Constructor", self.resource_class(resource))
            }
            FunctionKind::Method(resource) | FunctionKind::Static(resource) => {
                format!(
                    "{}{}",
                    self.resource_class(resource),
                    names::pascal(function.item_name())
                )
            }
            _ => names::pascal(function.item_name()),
        }
    }

    fn resource_class(&self, resource: TypeId) -> String {
        names::pascal(
            self.resolve.types[resource]
                .name
                .as_deref()
                .unwrap_or("resource"),
        )
    }

    /// The representations of a function's parameters and result, checked
    /// against the canonical ABI's flat signature; None when the function
    /// needs memory or is asynchronous.
    fn function_reprs(&self, function: &Function, import: bool) -> Option<FunctionRepr> {
        if matches!(
            function.kind,
            FunctionKind::AsyncFreestanding
                | FunctionKind::AsyncMethod(_)
                | FunctionKind::AsyncStatic(_)
        ) {
            return None;
        }
        let mut params = Vec::new();
        for param in &function.params {
            params.push(self.repr(&param.ty)?);
        }
        let result = match &function.result {
            None => None,
            Some(ty) => {
                let repr = self.repr(ty)?;
                if !repr.is_scalar_like() {
                    return None;
                }
                Some(repr)
            }
        };

        // The generator's own lowering must agree with wit-parser's canonical
        // ABI, which also rejects what spills into memory.
        let variant = if import {
            AbiVariant::GuestImport
        } else {
            AbiVariant::GuestExport
        };
        let signature: WasmSignature = self.resolve.wasm_signature(variant, function);
        if signature.indirect_params || signature.retptr {
            return None;
        }
        let mut flat = Vec::new();
        for param in &params {
            param.flat(&mut flat);
        }
        let mut flat_results = Vec::new();
        if let Some(result) = &result {
            result.flat(&mut flat_results);
        }
        if flat != signature.params || flat_results != signature.results {
            panic!(
                "witgen lowered {} as {:?} -> {:?}, but the canonical ABI says {:?} -> {:?}",
                function.name, flat, flat_results, signature.params, signature.results
            );
        }
        Some(FunctionRepr { params, result })
    }

    /// The extern for one import, with flat parameters.
    fn extern_declaration(&mut self, module: &str, function: &Function, repr: &FunctionRepr) {
        let mut parameters = Vec::new();
        for (param, repr) in function.params.iter().zip(&repr.params) {
            flat_parameters(&names::camel(&param.name), repr, &mut parameters);
        }
        let result = repr_extern_or_void(repr.result.as_ref());
        self.line(&format!(
            "[global::Gameplay.WasmImport(\"{module}\", \"{}\")]",
            function.name
        ));
        self.line(&format!(
            "internal static extern {result} {}({});",
            self.extern_name(function),
            parameters.join(", ")
        ));
    }

    /// A call of a function's extern. Resource classes nest in their
    /// interface's class, so the interface's Imports class is in scope for
    /// them too.
    fn extern_call(&self, function: &Function, arguments: &[String]) -> String {
        format!(
            "Imports.{}({})",
            self.extern_name(function),
            arguments.join(", ")
        )
    }

    /// A typed wrapper over an extern: records flatten into their fields,
    /// handles into their representation, results of handle type are wrapped.
    fn import_function(&mut self, function: &Function) -> Result<()> {
        let Some(repr) = self.function_reprs(function, true) else {
            self.skip(format!(
                "{}: needs memory (strings, lists, records as results), is asynchronous or uses an unsupported type",
                function.name
            ));
            return Ok(());
        };
        let is_method = matches!(function.kind, FunctionKind::Method(_));
        let skip = usize::from(is_method);
        let result = csharp_result(repr.result.as_ref());
        let name = names::pascal(function.item_name());
        // Static wrappers are internal: a public static scalar method of a
        // public class would itself become a module export.
        let modifier = if is_method {
            "public"
        } else {
            "internal static"
        };
        self.docs(&function.docs);
        let header = format!(
            "{modifier} {result} {name}({})",
            csharp_params(function, &repr.params, skip)
        );
        let call = if is_method {
            Call::Method
        } else {
            Call::Function
        };
        self.import_wrapper(&header, function, &repr, call);
        Ok(())
    }

    /// The body of a typed wrapper over an extern: records flatten into
    /// their fields, options into flat locals set only when the value is
    /// present, handles into their representation. Handles given away as
    /// `own` are spent after the call, and handle results are wrapped.
    fn import_wrapper(
        &mut self,
        header: &str,
        function: &Function,
        repr: &FunctionRepr,
        call: Call,
    ) {
        let mut lowering = Lowering::default();
        for (index, (param, param_repr)) in function.params.iter().zip(&repr.params).enumerate() {
            if index == 0 && matches!(call, Call::Method) {
                // A method's receiver is this object's own handle.
                lowering.arguments.push("Handle".to_string());
                continue;
            }
            let name = names::camel(&param.name);
            lower(&name, &name, param_repr, &mut lowering);
        }
        let extern_call = self.extern_call(function, &lowering.arguments);
        let result = match call {
            Call::Constructor => None,
            _ => repr.result.as_ref(),
        };
        let wrapped = wrap_result(result, extern_call.clone());
        let simple = lowering.before.is_empty() && lowering.after.is_empty();
        if simple && !matches!(call, Call::Constructor) {
            self.line(&format!("{header} => {wrapped};"));
            return;
        }

        self.open(header);
        for line in &lowering.before {
            self.line(line);
        }
        if !lowering.before.is_empty() {
            self.line("");
        }
        let returns = result.is_some();
        if matches!(call, Call::Constructor) {
            self.line(&format!("Handle = {extern_call};"));
        } else if returns && !lowering.after.is_empty() {
            self.line(&format!("var result_ = {wrapped};"));
        } else if returns {
            self.line(&format!("return {wrapped};"));
        } else {
            self.line(&format!("{wrapped};"));
        }
        for line in &lowering.after {
            self.line(line);
        }
        if returns && !lowering.after.is_empty() {
            self.line("return result_;");
        }
        self.close();
    }

    /// A partial method the module implements, exported under the canonical
    /// name; records arrive flattened and are rebuilt by a wrapper.
    fn export_function(&mut self, module: Option<&str>, function: &Function) -> Result<()> {
        let Some(repr) = self.function_reprs(function, false) else {
            self.skip(format!(
                "export {}: needs memory (strings, lists, records as results), is asynchronous or uses an unsupported type",
                function.name
            ));
            return Ok(());
        };
        let export_name = match module {
            Some(module) => format!("{module}#{}", function.name),
            None => function.name.clone(),
        };
        let name = names::pascal(function.item_name());
        let result = csharp_result(repr.result.as_ref());
        let parameters = csharp_params(function, &repr.params, 0);
        // gameplayc exports only scalar signatures: anything else goes
        // through a wrapper that takes the flat values.
        let flat_needed = repr
            .params
            .iter()
            .chain(&repr.result)
            .any(|repr| !matches!(repr, Repr::Scalar(..) | Repr::Enum(_)));

        self.docs(&function.docs);
        if !flat_needed {
            self.line(&format!("[global::Gameplay.WasmExport(\"{export_name}\")]"));
            self.line(&format!(
                "public static partial {result} {name}({parameters});"
            ));
            return Ok(());
        }

        // The export takes the flat values and constructs the records,
        // options and handle objects.
        let mut values = Vec::new();
        for (param, repr) in function.params.iter().zip(&repr.params) {
            flat_values(&names::camel(&param.name), repr, &mut values);
        }
        let flat_list: Vec<String> = values
            .iter()
            .map(|(ty, name)| format!("{ty} {name}"))
            .collect();
        let mut value_names = values.into_iter().map(|(_, name)| name);
        let arguments: Vec<String> = repr
            .params
            .iter()
            .map(|repr| construct(repr, &mut value_names))
            .collect();
        let call = format!("{name}({})", arguments.join(", "));
        self.line(&format!(
            "public static partial {result} {name}({parameters});"
        ));
        self.line("");
        self.line(&format!("[global::Gameplay.WasmExport(\"{export_name}\")]"));
        let header = format!(
            "public static {} {name}Export({})",
            repr_extern_or_void(repr.result.as_ref()),
            flat_list.join(", ")
        );
        if let Some(Repr::Handle(..)) = &repr.result {
            // An owned handle result moves to the caller: the module's object
            // is spent, as Dispose leaves it, without dropping the handle.
            self.open(&header);
            self.line(&format!("var result_ = {call};"));
            self.line("int handle_ = result_.Handle;");
            self.line("result_.Dropped = true;");
            self.line("result_.Handle = 0;");
            self.line("return handle_;");
            self.close();
        } else {
            self.line(&format!("{header} => {call};"));
        }
        Ok(())
    }
}

/// What an import wrapper is.
#[derive(Clone, Copy)]
enum Call {
    /// A static wrapper: a free function or a resource's static.
    Function,
    /// A method: the first parameter is the receiver's handle.
    Method,
    /// A resource constructor: the result becomes this object's handle.
    Constructor,
}

struct FunctionRepr {
    params: Vec<Repr>,
    result: Option<Repr>,
}

/// The extern's own parameter or result type: enums and scalars as they
/// are, handles as int.
fn repr_extern(repr: &Repr) -> &str {
    match repr {
        Repr::Scalar(name, _) => name,
        Repr::Enum(name) => name.as_str(),
        Repr::Handle(..) => "int",
        Repr::Record(..) | Repr::OptionRecord(_) => unreachable!("records never appear flat"),
    }
}

fn repr_extern_or_void(repr: Option<&Repr>) -> String {
    repr.map(|repr| repr_extern(repr).to_string())
        .unwrap_or_else(|| "void".to_string())
}

/// The typed C# parameter list of a function, past its first `skip`
/// parameters.
fn csharp_params(function: &Function, reprs: &[Repr], skip: usize) -> String {
    function
        .params
        .iter()
        .zip(reprs)
        .skip(skip)
        .map(|(param, repr)| format!("{} {}", repr.csharp(), names::camel(&param.name)))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The C# result type of a wrapper or partial method.
fn csharp_result(result: Option<&Repr>) -> String {
    result
        .map(Repr::csharp)
        .unwrap_or_else(|| "void".to_string())
}

/// An extern call as the wrapper's result: handles become their class.
fn wrap_result(result: Option<&Repr>, call: String) -> String {
    match result {
        Some(Repr::Handle(class, _)) => format!("{class}.FromHandle({call})"),
        _ => call,
    }
}

/// The C# type of one flat value: the scalar or enum itself, int for
/// handles and discriminants.
fn flat_csharp(leaf: Option<&Repr>) -> &str {
    leaf.map(repr_extern).unwrap_or("int")
}

/// The literal a flat value of an absent option takes.
fn zero_literal(leaf: Option<&Repr>) -> &'static str {
    match leaf {
        Some(Repr::Scalar("bool", _)) => "false",
        _ => "0",
    }
}

/// The flat values of one WIT parameter as C# types and names: scalars as
/// they are, records spread into `name_Field`, an option into `name_Some`
/// and `name_0`, `name_1`... for its record's flat values. WIT names never
/// contain `_`, so these never collide with each other or a parameter.
fn flat_values(name: &str, repr: &Repr, into: &mut Vec<(String, String)>) {
    match repr {
        Repr::Scalar(..) | Repr::Enum(_) | Repr::Handle(..) => {
            into.push((repr_extern(repr).to_string(), name.to_string()));
        }
        Repr::Record(_, fields) => {
            for (field, field_repr) in fields {
                flat_values(&format!("{name}_{field}"), field_repr, into);
            }
        }
        Repr::OptionRecord(inner) => {
            into.push(("int".to_string(), format!("{name}_Some")));
            let mut index = 0;
            inner.each_flat(&mut |leaf| {
                into.push((flat_csharp(leaf).to_string(), format!("{name}_{index}")));
                index += 1;
            });
        }
    }
}

/// The flat C# parameters of an extern for one WIT parameter.
fn flat_parameters(name: &str, repr: &Repr, into: &mut Vec<String>) {
    let mut values = Vec::new();
    flat_values(name, repr, &mut values);
    into.extend(values.into_iter().map(|(ty, name)| format!("{ty} {name}")));
}

/// How C# arguments reach an extern.
#[derive(Default)]
struct Lowering {
    /// Statements before the call: the flat locals of options, set only
    /// when the option is present.
    before: Vec<String>,
    /// The extern's arguments, one per flat value.
    arguments: Vec<String>,
    /// Statements after the call: owned handles given away are spent.
    after: Vec<String>,
}

/// Lowers the C# value `expression` of type `repr`; `name` is its flat name
/// (see `flat_values`), which also names the locals of options.
fn lower(expression: &str, name: &str, repr: &Repr, into: &mut Lowering) {
    match repr {
        Repr::Scalar(..) | Repr::Enum(_) => into.arguments.push(expression.to_string()),
        Repr::Handle(_, owned) => {
            into.arguments.push(format!("{expression}.Handle"));
            if *owned {
                // Ownership moves to the callee: the object is spent, with
                // its handle cleared as Dispose leaves it.
                into.after.push(format!("{expression}.Dropped = true;"));
                into.after.push(format!("{expression}.Handle = 0;"));
            }
        }
        Repr::Record(_, fields) => {
            for (field, field_repr) in fields {
                lower(
                    &format!("{expression}.{field}"),
                    &format!("{name}_{field}"),
                    field_repr,
                    into,
                );
            }
        }
        Repr::OptionRecord(inner) => {
            // One local per flat value, zero for `none`, assigned from the
            // record when it is there; each option is independent.
            let mut present = Lowering::default();
            lower(expression, name, inner, &mut present);
            let some = format!("{name}_Some");
            into.before.push(format!("int {some} = 0;"));
            let mut locals = Vec::new();
            inner.each_flat(&mut |leaf| {
                let local = format!("{name}_{}", locals.len());
                into.before.push(format!(
                    "{} {local} = {};",
                    flat_csharp(leaf),
                    zero_literal(leaf)
                ));
                locals.push(local);
            });
            into.before.push(format!("if ({expression} != null)"));
            into.before.push("{".to_string());
            for line in &present.before {
                into.before.push(format!("    {line}"));
            }
            into.before.push(format!("    {some} = 1;"));
            for (local, argument) in locals.iter().zip(&present.arguments) {
                into.before.push(format!("    {local} = {argument};"));
            }
            into.before.push("}".to_string());
            into.arguments.push(some);
            into.arguments.extend(locals);
            if !present.after.is_empty() {
                into.after.push(format!("if ({expression} != null)"));
                into.after.push("{".to_string());
                for line in &present.after {
                    into.after.push(format!("    {line}"));
                }
                into.after.push("}".to_string());
            }
        }
    }
}

/// The expression that rebuilds a C# value from flat export parameters,
/// taking their names in `flat_values` order.
fn construct(repr: &Repr, names: &mut impl Iterator<Item = String>) -> String {
    match repr {
        Repr::Scalar(..) | Repr::Enum(_) => next_name(names),
        Repr::Handle(class, _) => format!("{class}.FromHandle({})", next_name(names)),
        Repr::Record(class, fields) => {
            let arguments: Vec<String> = fields
                .iter()
                .map(|(_, field_repr)| construct(field_repr, names))
                .collect();
            format!("new {class}({})", arguments.join(", "))
        }
        Repr::OptionRecord(inner) => {
            let some = next_name(names);
            let value = construct(inner, names);
            format!("({some} != 0 ? {value} : null)")
        }
    }
}

fn next_name(names: &mut impl Iterator<Item = String>) -> String {
    names.next().expect("one name per flat value")
}

/// The class of each interface of the world: its PascalCase name, qualified
/// by package (then version, then position) only where two interfaces or an
/// interface and the world would share a name.
fn interface_classes(
    resolve: &Resolve,
    world: &World,
    world_class: &str,
) -> HashMap<InterfaceId, String> {
    let mut ids = Vec::new();
    let mut bases = Vec::new();
    for (key, item) in world.imports.iter().chain(&world.exports) {
        if let WorldItem::Interface { id, .. } = item {
            let name = match (&resolve.interfaces[*id].name, key) {
                (Some(name), _) | (None, WorldKey::Name(name)) => name.as_str(),
                _ => "anonymous",
            };
            ids.push(*id);
            bases.push(names::class(name));
        }
    }
    let mut classes = bases.clone();
    for level in 0..3 {
        let colliding: Vec<bool> = classes
            .iter()
            .map(|class| {
                class == world_class || classes.iter().filter(|other| *other == class).count() > 1
            })
            .collect();
        if !colliding.contains(&true) {
            break;
        }
        for (index, _) in colliding.iter().enumerate().filter(|(_, c)| **c) {
            let package = resolve.interfaces[ids[index]]
                .package
                .map(|package| &resolve.packages[package].name);
            classes[index] = match (level, package) {
                (0, Some(package)) => format!(
                    "{}{}{}",
                    names::pascal(&package.namespace),
                    names::pascal(&package.name),
                    bases[index]
                ),
                (1, Some(package)) => match &package.version {
                    Some(version) => format!(
                        "{}V{}",
                        classes[index],
                        version
                            .to_string()
                            .replace(|c: char| !c.is_ascii_alphanumeric(), "_")
                    ),
                    None => classes[index].clone(),
                },
                _ => format!("{}{index}", classes[index]),
            };
        }
    }
    ids.into_iter().zip(classes).collect()
}

fn kind_name(kind: &TypeDefKind) -> &'static str {
    match kind {
        TypeDefKind::Record(_) => "record",
        TypeDefKind::Resource => "resource",
        TypeDefKind::Handle(_) => "handle",
        TypeDefKind::Flags(_) => "flags",
        TypeDefKind::Tuple(_) => "tuple",
        TypeDefKind::Variant(_) => "variant",
        TypeDefKind::Enum(_) => "enum",
        TypeDefKind::Option(_) => "option",
        TypeDefKind::Result(_) => "result",
        TypeDefKind::List(_) => "list",
        TypeDefKind::Map(..) => "map",
        TypeDefKind::FixedLengthList(..) => "fixed-length list",
        TypeDefKind::Future(_) => "future",
        TypeDefKind::Stream(_) => "stream",
        TypeDefKind::Type(_) => "alias",
        TypeDefKind::Unknown => "unknown",
    }
}

/// Renders the report as one line per skipped item.
pub fn describe(report: &Report) -> String {
    let mut text = String::new();
    for item in &report.skipped {
        let _ = writeln!(text, "witgen: not generated: {item}");
    }
    text
}
