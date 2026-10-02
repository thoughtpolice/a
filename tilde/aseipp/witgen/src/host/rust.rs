// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Rust host bindings, for a host that runs the linked module in an engine
//! of its own. Per imported interface, a module with a trait the host
//! implements and `call`, which runs one of the module's imports with its
//! core arguments; the engine reaches the import's memory and allocator
//! through [`Guest`], so the bindings name no engine. Parameter strings and
//! lists of bytes are slices of the guest's memory, other lists copies, and
//! results the host's own values, which the bindings copy into memory the
//! import's allocator gives.

use wit_bindgen_core::abi::Instruction;
use wit_parser::abi::WasmType;
use wit_parser::{ArchitectureSize, Resolve, SizeAlign, Type, TypeId};

use super::plan::{self, Body, Render, at, operand};
use super::{Def, Func, Group, Kind, Model, Ty, doc_lines, provenance};
use crate::names;

const KEYWORDS: &[&str] = &[
    "as", "async", "await", "box", "break", "const", "continue", "crate", "dyn", "else", "enum",
    "extern", "false", "final", "fn", "for", "gen", "if", "impl", "in", "let", "loop", "macro",
    "match", "mod", "move", "mut", "override", "priv", "pub", "ref", "return", "self", "static",
    "struct", "super", "trait", "true", "try", "type", "typeof", "unsafe", "unsized", "use",
    "virtual", "where", "while", "yield",
];

/// The bindings' own locals and helpers, which a parameter must not shadow.
const LOCALS: &[&str] = &[
    "args",
    "bytes",
    "bytes_at",
    "call",
    "guest",
    "host",
    "lift_char",
    "put",
    "result",
    "spilled",
    "store_bytes",
    "store_list",
    "view",
    "word",
];

/// A parameter or module named after a WIT name.
fn local(name: &str) -> String {
    let name = names::snake(name);
    if KEYWORDS.contains(&name.as_str())
        || LOCALS.contains(&name.as_str())
        || super::is_flat_name(&name)
    {
        format!("{name}_")
    } else {
        name
    }
}

/// A method or field named after a WIT name.
fn member(name: &str) -> String {
    let name = names::snake(name);
    if KEYWORDS.contains(&name.as_str()) {
        format!("{name}_")
    } else {
        name
    }
}

struct Code {
    out: String,
    indent: usize,
}

impl Code {
    fn line(&mut self, text: impl AsRef<str>) {
        let text = text.as_ref();
        if !text.is_empty() {
            for _ in 0..self.indent {
                self.out.push_str("    ");
            }
        }
        self.out.push_str(text);
        self.out.push('\n');
    }

    fn docs(&mut self, docs: &wit_parser::Docs) {
        for line in doc_lines(docs) {
            let line = line.trim();
            if line.is_empty() {
                self.line("///");
            } else {
                self.line(format!("/// {line}"));
            }
        }
    }
}

pub(super) fn generate(model: &Model, out: &mut String) {
    let mut code = Code {
        out: String::new(),
        indent: 0,
    };
    for line in provenance(model) {
        code.line(format!("// {line}"));
    }
    code.line("// A host implements each trait below; its module's `call` runs one of the");
    code.line("// module's core imports, under wlink's host ABI, calling it.");
    code.line("");
    code.line("#![allow(dead_code, clippy::all)]");
    code.line("");
    prelude(&mut code);
    for group in &model.groups {
        module(model, &mut code, group);
    }
    for line in FIXED {
        code.line(*line);
    }
    while code.out.ends_with("\n\n") {
        code.out.pop();
    }
    out.push_str(&code.out);
}

fn prelude(code: &mut Code) {
    for line in [
        "/// A core value an import takes or returns.",
        "#[derive(Clone, Copy, Debug, PartialEq)]",
        "pub enum Flat {",
        "    I32(u32),",
        "    I64(u64),",
        "    F32(f32),",
        "    F64(f64),",
        "}",
        "",
        "/// Why the bindings trap.",
        "#[derive(Clone, Copy, Debug, PartialEq, Eq)]",
        "pub enum Trap {",
        "    /// The arguments are not the import's core signature.",
        "    Signature,",
        "    /// A pointer is not aligned to what it points at.",
        "    Misaligned,",
        "    /// A list is longer than a 32-bit memory.",
        "    OutOfBounds,",
        "    /// A character or an enum's discriminant is out of range.",
        "    InvalidValue,",
        "}",
        "",
        "/// What the bindings need of the guest for one import: its canonical memory",
        "/// and allocator.",
        "pub trait Guest<H: ?Sized> {",
        "    type Error;",
        "    /// The `len` bytes at `ptr`, or the trap of a range outside the memory.",
        "    fn read(&self, ptr: u32, len: u32) -> Result<&[u8], Self::Error>;",
        "    /// Writes `bytes` at `ptr`, or traps outside the memory.",
        "    fn write(&mut self, ptr: u32, bytes: &[u8]) -> Result<(), Self::Error>;",
        "    /// `len` fresh bytes aligned to `align` from the import's allocator,",
        "    /// which runs in the guest; `len` is never zero.",
        "    fn alloc(&mut self, host: &mut H, align: u32, len: u32) -> Result<u32, Self::Error>;",
        "    /// The error of a trap the bindings raise.",
        "    fn trap(&self, trap: Trap) -> Self::Error;",
        "}",
        "",
    ] {
        code.line(line);
    }
}

fn type_name(model: &Model, id: TypeId) -> String {
    names::pascal(&model.named(id).name)
}

/// A type as a parameter: slices of the guest's memory for bytes.
fn param_type(model: &Model, ty: &Ty) -> String {
    match &ty.kind {
        Kind::String => "&[u8]".into(),
        Kind::List(element) if matches!(element.kind, Kind::U8) => "&[u8]".into(),
        _ => value_type(model, ty),
    }
}

/// A type as a result, a field or an element: owned.
fn value_type(model: &Model, ty: &Ty) -> String {
    match &ty.kind {
        Kind::Bool => "bool".into(),
        Kind::U8 => "u8".into(),
        Kind::S8 => "i8".into(),
        Kind::U16 => "u16".into(),
        Kind::S16 => "i16".into(),
        Kind::U32 => "u32".into(),
        Kind::S32 => "i32".into(),
        Kind::U64 => "u64".into(),
        Kind::S64 => "i64".into(),
        Kind::F32 => "f32".into(),
        Kind::F64 => "f64".into(),
        Kind::Char => "char".into(),
        Kind::String => "Vec<u8>".into(),
        Kind::List(element) => format!("Vec<{}>", value_type(model, element)),
        Kind::Tuple(items) => {
            let items: Vec<String> = items.iter().map(|item| value_type(model, item)).collect();
            if items.len() == 1 {
                format!("({},)", items[0])
            } else {
                format!("({})", items.join(", "))
            }
        }
        Kind::Named(id) => match model.named(*id).def {
            Def::Flags { .. } => "u32".into(),
            _ => format!("{}::{}", group_module(model, *id), type_name(model, *id)),
        },
    }
}

/// The module of the group that defines a named type.
fn group_module(model: &Model, id: TypeId) -> String {
    let group = model.named(id).group.expect("a bound type has a group");
    local(&model.groups[group].name)
}

fn module(model: &Model, code: &mut Code, group: &Group) {
    code.docs(&group.docs);
    let module = local(&group.name);
    code.line(format!("pub mod {module} {{"));
    code.indent += 1;
    code.line("use super::*;");
    code.line("");
    code.line("/// The core import module.");
    code.line(format!("pub const MODULE: &str = \"{}\";", group.module));
    for (what, constant, realloc) in [
        (
            "take or return a pointer, and so have a memory",
            "MEMORY",
            false,
        ),
        (
            "return strings or lists, and so have an allocator",
            "REALLOC",
            true,
        ),
    ] {
        let functions: Vec<String> = group
            .funcs
            .iter()
            .filter(|func| if realloc { func.realloc } else { func.memory })
            .map(|func| format!("\"{}\"", func.name))
            .collect();
        code.line(format!("/// The functions that {what}."));
        code.line(format!(
            "pub const {constant}: &[&str] = &[{}];",
            functions.join(", ")
        ));
    }
    code.line("");
    for id in &group.defs {
        definition(model, code, *id);
    }
    let name = names::pascal(&group.name);
    code.line(format!("pub trait {name} {{"));
    code.indent += 1;
    code.line("type Error;");
    for func in &group.funcs {
        code.docs(&func.docs);
        let mut params = vec!["&mut self".to_string()];
        params.extend(
            func.params
                .iter()
                .map(|(name, ty)| format!("{}: {}", local(name), param_type(model, ty))),
        );
        let result = match &func.result {
            Some(ty) => value_type(model, ty),
            None => "()".into(),
        };
        code.line(format!(
            "fn {}({}) -> Result<{result}, Self::Error>;",
            member(&func.name),
            params.join(", ")
        ));
    }
    code.indent -= 1;
    code.line("}");
    code.line("");
    code.line("/// Runs the import `name` of `MODULE` with its core arguments, or `None`");
    code.line("/// when it has none of that name.");
    code.line("pub fn call<H, G>(");
    code.line("    host: &mut H,");
    code.line("    guest: &mut G,");
    code.line("    name: &str,");
    code.line("    args: &[Flat],");
    code.line(") -> Option<Result<Option<Flat>, H::Error>>");
    code.line("where");
    code.line(format!("    H: {name},"));
    code.line("    G: Guest<H, Error = H::Error>,");
    code.line("{");
    code.indent += 1;
    code.line("Some(match name {");
    code.indent += 1;
    for func in &group.funcs {
        code.line(format!(
            "\"{}\" => import_{}(host, guest, args),",
            func.name,
            names::snake(&func.name)
        ));
    }
    code.line("_ => return None,");
    code.indent -= 1;
    code.line("})");
    code.indent -= 1;
    code.line("}");
    for func in &group.funcs {
        code.line("");
        import(model, code, &name, func);
    }
    code.indent -= 1;
    code.line("}");
    code.line("");
}

fn definition(model: &Model, code: &mut Code, id: TypeId) {
    let named = model.named(id);
    let name = type_name(model, id);
    code.docs(&named.docs);
    match &named.def {
        Def::Record { fields } => {
            code.line("#[derive(Clone, Debug, PartialEq)]");
            code.line(format!("pub struct {name} {{"));
            code.indent += 1;
            for (field, ty, docs) in fields {
                code.docs(docs);
                code.line(format!("pub {}: {},", member(field), value_type(model, ty)));
            }
            code.indent -= 1;
            code.line("}");
        }
        Def::Enum { cases } => {
            code.line("#[derive(Clone, Copy, Debug, PartialEq, Eq)]");
            code.line(format!("pub enum {name} {{"));
            code.indent += 1;
            for (case, docs) in cases {
                code.docs(docs);
                code.line(format!("{},", names::pascal(case)));
            }
            code.indent -= 1;
            code.line("}");
            code.line("");
            code.line(format!("impl {name} {{"));
            code.indent += 1;
            code.line("pub fn from_discriminant(value: u32) -> Option<Self> {");
            code.indent += 1;
            code.line("Some(match value {");
            code.indent += 1;
            for (index, (case, _)) in cases.iter().enumerate() {
                code.line(format!("{index} => Self::{},", names::pascal(case)));
            }
            code.line("_ => return None,");
            code.indent -= 1;
            code.line("})");
            code.indent -= 1;
            code.line("}");
            code.indent -= 1;
            code.line("}");
        }
        Def::Flags { flags } => {
            for (index, (flag, docs)) in flags.iter().enumerate() {
                code.docs(docs);
                code.line(format!(
                    "pub const {}_{}: u32 = 1 << {index};",
                    names::shouty(&named.name),
                    names::shouty(flag)
                ));
            }
        }
    }
    code.line("");
}

fn flat_pattern(ty: WasmType, index: usize) -> String {
    match crate::abi::core(ty) {
        WasmType::I64 => format!("Flat::I64(a{index})"),
        WasmType::F32 => format!("Flat::F32(a{index})"),
        WasmType::F64 => format!("Flat::F64(a{index})"),
        _ => format!("Flat::I32(a{index})"),
    }
}

fn import(model: &Model, code: &mut Code, trait_name: &str, func: &Func) {
    code.line(format!("fn import_{}<H, G>(", names::snake(&func.name)));
    code.line("    host: &mut H,");
    code.line("    guest: &mut G,");
    code.line("    args: &[Flat],");
    code.line(") -> Result<Option<Flat>, H::Error>");
    code.line("where");
    code.line(format!("    H: {trait_name},"));
    code.line("    G: Guest<H, Error = H::Error>,");
    code.line("{");
    code.indent += 1;
    let patterns: Vec<String> = func
        .sig
        .params
        .iter()
        .enumerate()
        .map(|(index, ty)| flat_pattern(*ty, index))
        .collect();
    code.line(format!("let &[{}] = args else {{", patterns.join(", ")));
    code.line("    return Err(guest.trap(Trap::Signature));");
    code.line("};");
    let mut rust = Rs { model, func };
    for line in plan::body(model.resolve, &func.function, &mut rust) {
        code.line(line);
    }
    code.indent -= 1;
    code.line("}");
}

/// The plan of an import, in Rust.
struct Rs<'a, 'm> {
    model: &'a Model<'m>,
    func: &'a Func,
}

impl Rs<'_, '_> {
    /// A name for a value: a borrow of it, unless it is a path already.
    fn bind(&self, body: &mut Body, value: &str) -> String {
        let path = value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.*()".contains(c));
        if path {
            return value.to_string();
        }
        let name = body.temp();
        body.line(format!("let {name} = &{value};"));
        name
    }

    /// The flat argument `nth`, checking a pointer to spilled parameters or
    /// to the return area before anything reads or writes through it.
    fn arg(&self, body: &mut Body, nth: usize) -> String {
        let sig = &self.func.sig;
        let area = if sig.indirect_params && nth == 0 {
            let (_, size, align) = self.model.spilled(self.func);
            Some((size, align))
        } else if sig.retptr && nth == sig.params.len() - 1 {
            let ty = self
                .func
                .result
                .as_ref()
                .expect("a return area holds a result");
            Some((self.model.size(ty), self.model.align(ty)))
        } else {
            None
        };
        if let Some((size, align)) = area {
            body.line(format!("view(guest, a{nth}, 1, {size}, {align})?;"));
        }
        format!("a{nth}")
    }

    /// A lifted part of a record or tuple, which owns its bytes.
    fn owned(&self, ty: &Type, value: &str) -> String {
        match self.model.ty_of(ty).kind {
            Kind::String => format!("{value}.to_vec()"),
            Kind::List(element) if matches!(element.kind, Kind::U8) => format!("{value}.to_vec()"),
            _ => value.to_string(),
        }
    }

    fn store(
        &self,
        body: &mut Body,
        helper: &str,
        address: &str,
        offset: ArchitectureSize,
        value: String,
    ) {
        body.line(format!(
            "{helper}(guest, {}, {value})?;",
            at(address, offset)
        ));
    }

    fn path(&self, id: TypeId) -> String {
        format!(
            "{}::{}",
            group_module(self.model, id),
            type_name(self.model, id)
        )
    }
}

/// The Rust type of a list of numbers' elements.
fn number(ty: &Type) -> Option<&'static str> {
    Some(match ty {
        Type::U8 => "u8",
        Type::S8 => "i8",
        Type::U16 => "u16",
        Type::S16 => "i16",
        Type::U32 => "u32",
        Type::S32 => "i32",
        Type::U64 => "u64",
        Type::S64 => "i64",
        Type::F32 => "f32",
        Type::F64 => "f64",
        _ => return None,
    })
}

impl Render for Rs<'_, '_> {
    fn sizes(&self) -> &SizeAlign {
        self.model.sizes.size_align()
    }

    fn whole(&self, _resolve: &Resolve, element: &Type) -> bool {
        number(element).is_some()
    }

    fn render(
        &mut self,
        body: &mut Body,
        _resolve: &Resolve,
        instruction: &Instruction<'_>,
        ops: &[String],
    ) -> Vec<String> {
        use Instruction::*;
        let one = |text: String| vec![text];
        let x = || operand(&ops[0]);
        let load = |helper: &str, offset: &ArchitectureSize| {
            format!("{helper}(guest, {})?", at(&ops[0], *offset))
        };
        match instruction {
            GetArg { nth } => one(self.arg(body, *nth)),

            // Lifting.
            BoolFromI32 => one(format!("{} != 0", x())),
            U8FromI32 => one(format!("{} as u8", x())),
            S8FromI32 => one(format!("{} as i8", x())),
            U16FromI32 => one(format!("{} as u16", x())),
            S16FromI32 => one(format!("{} as i16", x())),
            S32FromI32 => one(format!("{} as i32", x())),
            S64FromI64 => one(format!("{} as i64", x())),
            U32FromI32 | U64FromI64 | F32FromCoreF32 | F64FromCoreF64 | FlagsLift { .. } => {
                one(ops[0].clone())
            }
            CharFromI32 => one(format!("lift_char(guest, {})?", ops[0])),
            EnumLift { ty, .. } => one(format!(
                "{}::from_discriminant({}).ok_or_else(|| guest.trap(Trap::InvalidValue))?",
                self.path(*ty),
                ops[0]
            )),
            I32Load { offset } | PointerLoad { offset } | LengthLoad { offset } => {
                one(load("load_u32", offset))
            }
            I32Load8U { offset } => one(format!("u32::from({})", load("load_u8", offset))),
            I32Load8S { offset } => one(format!("{} as i8 as u32", load("load_u8", offset))),
            I32Load16U { offset } => one(format!("u32::from({})", load("load_u16", offset))),
            I32Load16S { offset } => one(format!("{} as i16 as u32", load("load_u16", offset))),
            I64Load { offset } => one(load("load_u64", offset)),
            F32Load { offset } => one(format!("f32::from_bits({})", load("load_u32", offset))),
            F64Load { offset } => one(format!("f64::from_bits({})", load("load_u64", offset))),
            StringLift => one(format!("guest.read({}, {})?", ops[0], ops[1])),
            ListCanonLift { element, .. } => {
                let (size, align) = (
                    self.model.sizes.size(element),
                    self.model.sizes.align(element),
                );
                let view = format!("view(guest, {}, {}, {size}, {align})?", ops[0], ops[1]);
                match number(element) {
                    Some("u8") => one(view),
                    Some(rust) => one(format!("decode({view}, {rust}::from_le_bytes)")),
                    None => unreachable!("only lists of numbers are whole"),
                }
            }
            ListLift { element, .. } => {
                let (lines, results) = body.take();
                let (size, align) = (
                    self.model.sizes.size(element),
                    self.model.sizes.align(element),
                );
                let ptr = body.temp();
                body.line(format!("let {ptr} = {};", ops[0]));
                let len = body.temp();
                body.line(format!("let {len} = {};", ops[1]));
                body.line(format!("view(guest, {ptr}, {len}, {size}, {align})?;"));
                let items = body.temp();
                let depth = body.depth() + 1;
                body.line(format!("let {items} = (0..{len})"));
                body.line(format!("    .map(|i{depth}| -> Result<_, H::Error> {{"));
                body.line(format!(
                    "        let base{depth} = {ptr} + i{depth} * {size};"
                ));
                body.lines(&lines, "        ");
                body.line(format!("        Ok({})", self.owned(element, &results[0])));
                body.line("    })");
                body.line("    .collect::<Result<Vec<_>, _>>()?;");
                one(items)
            }
            IterBasePointer => one(format!("base{}", body.depth())),
            IterElem { .. } => one(format!("(*e{})", body.depth())),
            RecordLift { record, ty, .. } => {
                let fields: Vec<String> = record
                    .fields
                    .iter()
                    .zip(ops)
                    .map(|(field, value)| {
                        format!("{}: {}", member(&field.name), self.owned(&field.ty, value))
                    })
                    .collect();
                let name = body.temp();
                body.line(format!("let {name} = {} {{", self.path(*ty)));
                for field in fields {
                    body.line(format!("    {field},"));
                }
                body.line("};");
                one(name)
            }
            TupleLift { tuple, .. } => {
                let items: Vec<String> = tuple
                    .types
                    .iter()
                    .zip(ops)
                    .map(|(ty, value)| self.owned(ty, value))
                    .collect();
                let name = body.temp();
                if items.len() == 1 {
                    body.line(format!("let {name} = ({},);", items[0]));
                } else {
                    body.line(format!("let {name} = ({});", items.join(", ")));
                }
                one(name)
            }
            CallInterface { func, .. } => {
                let call = format!("host.{}({})?", member(&func.name), ops.join(", "));
                if func.result.is_some() {
                    let name = body.temp();
                    body.line(format!("let {name} = {call};"));
                    one(name)
                } else {
                    body.line(format!("{call};"));
                    Vec::new()
                }
            }
            Return { amt, .. } => {
                if *amt == 1 {
                    let flat = match crate::abi::core(self.func.sig.results[0]) {
                        WasmType::I64 => "I64",
                        WasmType::F32 => "F32",
                        WasmType::F64 => "F64",
                        _ => "I32",
                    };
                    body.line(format!("Ok(Some(Flat::{flat}({})))", ops[0]));
                } else {
                    body.line("Ok(None)");
                }
                Vec::new()
            }

            // Lowering.
            I32FromBool | I32FromU8 | I32FromU16 | I32FromChar => {
                one(format!("u32::from({})", ops[0]))
            }
            I32FromS8 | I32FromS16 => one(format!("{} as i32 as u32", x())),
            I32FromS32 | EnumLower { .. } => one(format!("{} as u32", x())),
            I64FromS64 => one(format!("{} as u64", x())),
            I32FromU32 | I64FromU64 | CoreF32FromF32 | CoreF64FromF64 | FlagsLower { .. } => {
                one(ops[0].clone())
            }
            RecordLower { record, .. } => {
                let value = self.bind(body, &ops[0]);
                record
                    .fields
                    .iter()
                    .map(|field| format!("{value}.{}", member(&field.name)))
                    .collect()
            }
            TupleLower { tuple, .. } => {
                let value = self.bind(body, &ops[0]);
                (0..tuple.types.len())
                    .map(|index| format!("{value}.{index}"))
                    .collect()
            }
            StringLower { .. } => {
                let (ptr, len) = (body.temp(), body.temp());
                body.line(format!(
                    "let ({ptr}, {len}) = store_bytes(host, guest, &{})?;",
                    ops[0]
                ));
                vec![ptr, len]
            }
            ListCanonLower { element, .. } => {
                let (ptr, len) = (body.temp(), body.temp());
                match number(element) {
                    Some("u8") => body.line(format!(
                        "let ({ptr}, {len}) = store_bytes(host, guest, &{})?;",
                        ops[0]
                    )),
                    Some(_) => body.line(format!(
                        "let ({ptr}, {len}) = store_numbers(host, guest, &{}, {}, |value| value.to_le_bytes())?;",
                        ops[0],
                        self.model.sizes.align(element)
                    )),
                    None => unreachable!("only lists of numbers are whole"),
                }
                vec![ptr, len]
            }
            ListLower { element, .. } => {
                let (lines, _) = body.take();
                let (size, align) = (
                    self.model.sizes.size(element),
                    self.model.sizes.align(element),
                );
                let items = body.temp();
                body.line(format!("let {items} = &{};", ops[0]));
                let len = body.temp();
                body.line(format!(
                    "let {len} = u32::try_from({items}.len()).map_err(|_| guest.trap(Trap::OutOfBounds))?;"
                ));
                let ptr = body.temp();
                body.line(format!(
                    "let {ptr} = alloc_zeroed(host, guest, {len}, {size}, {align})?;"
                ));
                let depth = body.depth() + 1;
                body.line(format!(
                    "for (i{depth}, e{depth}) in {items}.iter().enumerate() {{"
                ));
                body.line(format!(
                    "    let base{depth} = {ptr} + i{depth} as u32 * {size};"
                ));
                body.lines(&lines, "    ");
                body.line("}");
                vec![ptr, len]
            }
            I32Store { offset } | PointerStore { offset } | LengthStore { offset } => {
                self.store(body, "store_u32", &ops[1], *offset, ops[0].clone());
                Vec::new()
            }
            I32Store8 { offset } => {
                self.store(body, "store_u8", &ops[1], *offset, format!("{} as u8", x()));
                Vec::new()
            }
            I32Store16 { offset } => {
                self.store(
                    body,
                    "store_u16",
                    &ops[1],
                    *offset,
                    format!("{} as u16", x()),
                );
                Vec::new()
            }
            I64Store { offset } => {
                self.store(body, "store_u64", &ops[1], *offset, ops[0].clone());
                Vec::new()
            }
            F32Store { offset } => {
                self.store(
                    body,
                    "store_u32",
                    &ops[1],
                    *offset,
                    format!("{}.to_bits()", x()),
                );
                Vec::new()
            }
            F64Store { offset } => {
                self.store(
                    body,
                    "store_u64",
                    &ops[1],
                    *offset,
                    format!("{}.to_bits()", x()),
                );
                Vec::new()
            }
            Flush { .. } => ops.to_vec(),
            _ => unreachable!("host bindings carry no values of this instruction's kind"),
        }
    }
}

const FIXED: &[&str] = &[
    "/// The `count` elements of `size` bytes at `ptr`, checked.",
    "fn view<H: ?Sized, G: Guest<H>>(",
    "    guest: &G,",
    "    ptr: u32,",
    "    count: u32,",
    "    size: u32,",
    "    align: u32,",
    ") -> Result<&[u8], G::Error> {",
    "    if ptr % align != 0 {",
    "        return Err(guest.trap(Trap::Misaligned));",
    "    }",
    "    let len = u32::try_from(u64::from(count) * u64::from(size))",
    "        .map_err(|_| guest.trap(Trap::OutOfBounds))?;",
    "    guest.read(ptr, len)",
    "}",
    "",
    "/// The elements of a list of numbers, decoded little-endian.",
    "fn decode<T, const N: usize>(bytes: &[u8], from: fn([u8; N]) -> T) -> Vec<T> {",
    "    bytes",
    "        .chunks_exact(N)",
    "        .map(|chunk| from(chunk.try_into().expect(\"a whole element\")))",
    "        .collect()",
    "}",
    "",
    "fn load<H: ?Sized, G: Guest<H>, const N: usize>(guest: &G, at: u32) -> Result<[u8; N], G::Error> {",
    "    let bytes = guest.read(at, N as u32)?;",
    "    Ok(bytes.try_into().expect(\"the guest read N bytes\"))",
    "}",
    "",
    "fn load_u8<H: ?Sized, G: Guest<H>>(guest: &G, at: u32) -> Result<u8, G::Error> {",
    "    Ok(load::<H, G, 1>(guest, at)?[0])",
    "}",
    "",
    "fn load_u16<H: ?Sized, G: Guest<H>>(guest: &G, at: u32) -> Result<u16, G::Error> {",
    "    load::<H, G, 2>(guest, at).map(u16::from_le_bytes)",
    "}",
    "",
    "fn load_u32<H: ?Sized, G: Guest<H>>(guest: &G, at: u32) -> Result<u32, G::Error> {",
    "    load::<H, G, 4>(guest, at).map(u32::from_le_bytes)",
    "}",
    "",
    "fn load_u64<H: ?Sized, G: Guest<H>>(guest: &G, at: u32) -> Result<u64, G::Error> {",
    "    load::<H, G, 8>(guest, at).map(u64::from_le_bytes)",
    "}",
    "",
    "fn store_u8<H: ?Sized, G: Guest<H>>(guest: &mut G, at: u32, value: u8) -> Result<(), G::Error> {",
    "    guest.write(at, &[value])",
    "}",
    "",
    "fn store_u16<H: ?Sized, G: Guest<H>>(guest: &mut G, at: u32, value: u16) -> Result<(), G::Error> {",
    "    guest.write(at, &value.to_le_bytes())",
    "}",
    "",
    "fn store_u32<H: ?Sized, G: Guest<H>>(guest: &mut G, at: u32, value: u32) -> Result<(), G::Error> {",
    "    guest.write(at, &value.to_le_bytes())",
    "}",
    "",
    "fn store_u64<H: ?Sized, G: Guest<H>>(guest: &mut G, at: u32, value: u64) -> Result<(), G::Error> {",
    "    guest.write(at, &value.to_le_bytes())",
    "}",
    "",
    "/// A Unicode scalar value, or a trap.",
    "fn lift_char<H: ?Sized, G: Guest<H>>(guest: &G, value: u32) -> Result<char, G::Error> {",
    "    char::from_u32(value).ok_or_else(|| guest.trap(Trap::InvalidValue))",
    "}",
    "",
    "/// Bytes copied into fresh guest memory: their pointer and length.",
    "fn store_bytes<H: ?Sized, G: Guest<H>>(",
    "    host: &mut H,",
    "    guest: &mut G,",
    "    bytes: &[u8],",
    ") -> Result<(u32, u32), G::Error> {",
    "    let len = u32::try_from(bytes.len()).map_err(|_| guest.trap(Trap::OutOfBounds))?;",
    "    if len == 0 {",
    "        return Ok((1, 0));",
    "    }",
    "    let ptr = guest.alloc(host, 1, len)?;",
    "    guest.write(ptr, bytes)?;",
    "    Ok((ptr, len))",
    "}",
    "",
    "/// A list of numbers copied into fresh guest memory: its pointer and length.",
    "fn store_numbers<H: ?Sized, G: Guest<H>, T: Copy, const N: usize>(",
    "    host: &mut H,",
    "    guest: &mut G,",
    "    items: &[T],",
    "    align: u32,",
    "    bytes: impl Fn(T) -> [u8; N],",
    ") -> Result<(u32, u32), G::Error> {",
    "    let count = u32::try_from(items.len()).map_err(|_| guest.trap(Trap::OutOfBounds))?;",
    "    let len = count.checked_mul(N as u32).ok_or_else(|| guest.trap(Trap::OutOfBounds))?;",
    "    if len == 0 {",
    "        return Ok((align, 0));",
    "    }",
    "    let mut buffer = Vec::with_capacity(len as usize);",
    "    for item in items {",
    "        buffer.extend_from_slice(&bytes(*item));",
    "    }",
    "    let ptr = guest.alloc(host, align, len)?;",
    "    guest.write(ptr, &buffer)?;",
    "    Ok((ptr, count))",
    "}",
    "",
    "/// `count` zeroed elements of `size` bytes in fresh guest memory: their pointer.",
    "fn alloc_zeroed<H: ?Sized, G: Guest<H>>(",
    "    host: &mut H,",
    "    guest: &mut G,",
    "    count: u32,",
    "    size: u32,",
    "    align: u32,",
    ") -> Result<u32, G::Error> {",
    "    let len = count.checked_mul(size).ok_or_else(|| guest.trap(Trap::OutOfBounds))?;",
    "    if len == 0 {",
    "        return Ok(align);",
    "    }",
    "    let ptr = guest.alloc(host, align, len)?;",
    "    guest.write(ptr, &vec![0u8; len as usize])?;",
    "    Ok(ptr)",
    "}",
];
