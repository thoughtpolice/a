// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! TypeScript host bindings, for a host that instantiates the linked module
//! with the JavaScript API. Per imported interface: an interface the host
//! implements, and `bind<Name>`, which returns the core imports of its
//! module calling it. Numbers are `number`, 64-bit integers `bigint`;
//! parameter strings and lists are views of the guest's memory (typed
//! arrays of numbers, valid until the import returns) and results the
//! host's own values, which the bindings copy into memory the import's
//! allocator gives. The output is written as `deno fmt` formats it, since a
//! host checks it in beside its own sources.

use std::collections::BTreeSet;

use anyhow::Result;
use wit_bindgen_core::abi::Instruction;
use wit_parser::abi::WasmType;
use wit_parser::{Resolve, SizeAlign, Type, TypeId};

use super::plan::{self, Body, Render, at, operand};
use super::{Def, Func, Group, Kind, Model, Ty, doc_lines, provenance};
use crate::names;

/// The line width `deno fmt` keeps to.
const WIDTH: usize = 80;

const RESERVED: &[&str] = &[
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    // The bindings' own names.
    "b",
    "guest",
    "host",
    "result",
    "spill",
];

/// A parameter or local named after a WIT name.
fn local(name: &str) -> String {
    let name = names::camel(name);
    if RESERVED.contains(&name.as_str()) || name.starts_with("wit") || super::is_flat_name(&name) {
        format!("{name}_")
    } else {
        name
    }
}

struct Code {
    out: String,
    indent: usize,
    /// The helpers the bindings call, emitted once at the end.
    helpers: BTreeSet<&'static str>,
}

impl Code {
    fn line(&mut self, text: impl AsRef<str>) {
        let text = text.as_ref();
        if !text.is_empty() {
            for _ in 0..self.indent {
                self.out.push_str("  ");
            }
        }
        self.out.push_str(text);
        self.out.push('\n');
    }

    fn docs(&mut self, docs: &wit_parser::Docs) {
        let lines = doc_lines(docs);
        match lines.as_slice() {
            [] => {}
            [only] => self.line(format!("/** {} */", only.trim())),
            _ => {
                self.line("/**");
                for line in lines {
                    let line = line.trim();
                    if line.is_empty() {
                        self.line(" *");
                    } else {
                        self.line(format!(" * {line}"));
                    }
                }
                self.line(" */");
            }
        }
    }

    /// `head(item, item)tail`, or one item a line when that is too wide, as
    /// `deno fmt` breaks parameter and argument lists.
    fn list(&mut self, head: &str, items: &[String], tail: &str) {
        let single = format!("{head}{}{tail}", items.join(", "));
        if items.is_empty() || self.indent * 2 + single.len() <= WIDTH {
            self.line(single);
            return;
        }
        self.line(head);
        self.indent += 1;
        for item in items {
            self.line(format!("{item},"));
        }
        self.indent -= 1;
        self.line(tail);
    }
}

pub(super) fn generate(model: &Model, out: &mut String) -> Result<()> {
    let mut code = Code {
        out: String::new(),
        indent: 0,
        helpers: BTreeSet::new(),
    };
    for line in provenance(model) {
        code.line(format!("// {line}"));
    }
    code.line("// A host implements each interface below; `bind<Interface>` gives the");
    code.line("// core imports of its module, under wlink's host ABI, calling it.");
    code.line("");
    prelude(&mut code);
    for group in &model.groups {
        for id in &group.defs {
            definition(model, &mut code, *id);
        }
        interface(model, &mut code, group);
        bind(model, &mut code, group);
    }
    helpers(model, &mut code);
    while code.out.ends_with("\n\n") {
        code.out.pop();
    }
    out.push_str(&code.out);
    Ok(())
}

fn prelude(code: &mut Code) {
    for line in [
        "/** An import's canonical memory. */",
        "export interface GuestMemory {",
        "  /** The `len` bytes at `ptr`, or the guest's trap outside the memory. */",
        "  range(ptr: number, len: number): Uint8Array;",
        "  /** The memory as it is now; an allocation may replace it. */",
        "  data(): DataView;",
        "}",
        "",
        "/** An import's canonical memory and allocator. */",
        "export interface GuestBinding {",
        "  readonly mem: GuestMemory;",
        "  /**",
        "   * `len` fresh bytes aligned to `align` from the import's allocator, or",
        "   * `align` itself when `len` is zero.",
        "   */",
        "  alloc(align: number, len: number): number;",
        "}",
        "",
        "/** What the bindings need of the guest. */",
        "export interface Guest {",
        "  /** The memory and allocator of the import `name` of `module`. */",
        "  binding(module: string, name: string): GuestBinding;",
        "  /** The error that ends the guest's run with a trap. */",
        "  trap(message: string): Error;",
        "}",
        "",
    ] {
        code.line(line);
    }
}

fn type_name(model: &Model, id: TypeId) -> String {
    names::pascal(&model.named(id).name)
}

/// A type as a parameter: views of the guest's memory.
fn param_type(model: &Model, ty: &Ty) -> String {
    match &ty.kind {
        Kind::String => "Uint8Array".into(),
        Kind::List(element) => match typed_array(element) {
            Some(array) => array.into(),
            None => format!("{}[]", element_type(model, element)),
        },
        _ => value_type(model, ty),
    }
}

/// A type as a result: the host's own values.
fn result_type(model: &Model, ty: &Ty) -> String {
    value_type(model, ty)
}

/// A list's element type, parenthesized where `[]` would bind tighter.
fn element_type(model: &Model, ty: &Ty) -> String {
    let ty = value_type(model, ty);
    if ty.contains(' ') && !ty.starts_with('[') && !ty.starts_with("ArrayLike") {
        format!("({ty})")
    } else {
        ty
    }
}

/// A type inside a record, a tuple or a list, or a result.
fn value_type(model: &Model, ty: &Ty) -> String {
    match &ty.kind {
        Kind::Bool => "boolean".into(),
        Kind::U64 | Kind::S64 => "bigint".into(),
        Kind::String => "Uint8Array | string".into(),
        Kind::List(element) if matches!(element.kind, Kind::U8) => "Uint8Array".into(),
        Kind::List(element) => format!("ArrayLike<{}>", element_type(model, element)),
        Kind::Tuple(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|item| value_type(model, item))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Kind::Named(id) if model.is_record(*id) => type_name(model, *id),
        _ => "number".into(),
    }
}

/// The typed array a list of numbers is a view of.
fn typed_array(ty: &Ty) -> Option<&'static str> {
    Some(match ty.kind {
        Kind::U8 => "Uint8Array",
        Kind::S8 => "Int8Array",
        Kind::U16 => "Uint16Array",
        Kind::S16 => "Int16Array",
        Kind::U32 => "Uint32Array",
        Kind::S32 => "Int32Array",
        Kind::U64 => "BigUint64Array",
        Kind::S64 => "BigInt64Array",
        Kind::F32 => "Float32Array",
        Kind::F64 => "Float64Array",
        _ => return None,
    })
}

fn definition(model: &Model, code: &mut Code, id: TypeId) {
    let named = model.named(id);
    let name = type_name(model, id);
    code.docs(&named.docs);
    match &named.def {
        Def::Record { fields } => {
            code.line(format!("export interface {name} {{"));
            code.indent += 1;
            for (field, ty, docs) in fields {
                code.docs(docs);
                code.line(format!(
                    "{}: {};",
                    names::camel(field),
                    value_type(model, ty)
                ));
            }
            code.indent -= 1;
            code.line("}");
        }
        Def::Enum { cases } => {
            code.line(format!("export const {name} = {{"));
            code.indent += 1;
            for (index, (case, docs)) in cases.iter().enumerate() {
                code.docs(docs);
                code.line(format!("{}: {index},", names::camel(case)));
            }
            code.indent -= 1;
            code.line("} as const;");
            code.line(format!("export type {name} = number;"));
        }
        Def::Flags { flags } => {
            code.line(format!("export const {name} = {{"));
            code.indent += 1;
            for (index, (flag, docs)) in flags.iter().enumerate() {
                code.docs(docs);
                code.line(format!("{}: 0x{:x},", names::camel(flag), 1u64 << index));
            }
            code.indent -= 1;
            code.line("} as const;");
            code.line(format!("export type {name} = number;"));
        }
    }
    code.line("");
}

/// `RAW` for interface `raw`: the prefix of a group's constants.
fn constant(group: &Group) -> String {
    names::shouty(&group.name)
}

fn interface(model: &Model, code: &mut Code, group: &Group) {
    let prefix = constant(group);
    code.line(format!(
        "/** The core import module of `{}`. */",
        group.name
    ));
    code.line(format!(
        "export const {prefix}_MODULE = \"{}\";",
        group.module
    ));
    code.line("");
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
        let functions: Vec<&Func> = group
            .funcs
            .iter()
            .filter(|func| if realloc { func.realloc } else { func.memory })
            .collect();
        code.line(format!("/** The functions that {what}. */"));
        let head = format!("export const {prefix}_{constant}: readonly string[] = [");
        if functions.is_empty() {
            code.line(format!("{head}];"));
        } else {
            code.line(head);
            code.indent += 1;
            for func in functions {
                code.line(format!("\"{}\",", func.name));
            }
            code.indent -= 1;
            code.line("];");
        }
        code.line("");
    }
    code.docs(&group.docs);
    code.line(format!(
        "export interface {} {{",
        names::pascal(&group.name)
    ));
    code.indent += 1;
    for func in &group.funcs {
        code.docs(&func.docs);
        let params: Vec<String> = func
            .params
            .iter()
            .map(|(name, ty)| format!("{}: {}", local(name), param_type(model, ty)))
            .collect();
        let result = match &func.result {
            Some(ty) => result_type(model, ty),
            None => "void".into(),
        };
        code.list(
            &format!("{}(", names::camel(&func.name)),
            &params,
            &format!("): {result};"),
        );
    }
    code.indent -= 1;
    code.line("}");
    code.line("");
}

fn bind(model: &Model, code: &mut Code, group: &Group) {
    let interface = names::pascal(&group.name);
    let prefix = constant(group);
    code.line(format!(
        "/** The core imports of `{prefix}_MODULE`, calling `host`. */"
    ));
    code.list(
        &format!("export function bind{interface}("),
        &[format!("host: {interface}"), "guest: Guest".into()],
        "): WebAssembly.ModuleImports {",
    );
    code.indent += 1;
    code.line("return {");
    code.indent += 1;
    for func in &group.funcs {
        import(model, code, group, func);
    }
    code.indent -= 1;
    code.line("};");
    code.indent -= 1;
    code.line("}");
    code.line("");
}

fn flat_type(ty: WasmType) -> &'static str {
    match crate::abi::core(ty) {
        WasmType::I64 => "bigint",
        _ => "number",
    }
}

fn import(model: &Model, code: &mut Code, group: &Group, func: &Func) {
    let prefix = constant(group);
    let flat: Vec<String> = func
        .sig
        .params
        .iter()
        .enumerate()
        .map(|(index, ty)| format!("a{index}: {}", flat_type(*ty)))
        .collect();
    let returns = match func.sig.results.first() {
        Some(ty) => flat_type(*ty),
        None => "void",
    };
    code.list(
        &format!("\"{}\": (", func.name),
        &flat,
        &format!("): {returns} => {{"),
    );
    code.indent += 1;
    if func.memory {
        code.line(format!(
            "const b = guest.binding({prefix}_MODULE, \"{}\");",
            func.name
        ));
    }
    let mut ts = Ts {
        model,
        func,
        helpers: &mut code.helpers,
        indent: code.indent * 2,
    };
    for line in plan::body(model.resolve, &func.function, &mut ts) {
        code.line(line);
    }
    code.indent -= 1;
    code.line("},");
}

/// The plan of an import, in TypeScript.
struct Ts<'a, 'm> {
    model: &'a Model<'m>,
    func: &'a Func,
    helpers: &'a mut BTreeSet<&'static str>,
    /// The column the import's statements start at.
    indent: usize,
}

impl Ts<'_, '_> {
    /// A name for a value, binding it to a temporary unless it is one, or a
    /// member of one.
    fn bind(&self, body: &mut Body, value: &str) -> String {
        let path = value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
        if path {
            return value.to_string();
        }
        let name = body.temp();
        body.line(format!("const {name} = {value};"));
        name
    }

    /// `head(item, item)tail` as statements, one item a line when too wide.
    fn list(&self, body: &mut Body, head: &str, items: &[String], tail: &str) {
        let single = format!("{head}{}{tail}", items.join(", "));
        if items.is_empty() || self.indent + body.depth() * 2 + single.len() <= WIDTH {
            body.line(single);
            return;
        }
        body.line(head);
        for item in items {
            body.line(format!("  {item},"));
        }
        body.line(tail);
    }

    /// The flat argument `nth`, checking a pointer to spilled parameters or
    /// to the return area before anything reads or writes through it.
    fn arg(&mut self, body: &mut Body, nth: usize) -> String {
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
        let Some((size, align)) = area else {
            return format!("a{nth}");
        };
        self.helpers.insert("view");
        body.line(format!("witView(guest, b, a{nth}, 1, {size}, {align});"));
        let name = body.temp();
        body.line(format!("const {name} = a{nth} >>> 0;"));
        name
    }

    fn load(
        &mut self,
        helper: &'static str,
        address: &str,
        offset: wit_parser::ArchitectureSize,
    ) -> Vec<String> {
        self.helpers.insert(helper);
        vec![format!("{helper}(b, {})", at(address, offset))]
    }

    fn store(
        &mut self,
        body: &mut Body,
        helper: &'static str,
        operands: &[String],
        offset: wit_parser::ArchitectureSize,
    ) -> Vec<String> {
        self.helpers.insert(helper);
        body.line(format!(
            "{helper}(b, {}, {});",
            at(&operands[1], offset),
            operands[0]
        ));
        Vec::new()
    }

    fn ts_type(&self, ty: &Type) -> String {
        value_type(self.model, &self.model.ty_of(ty))
    }
}

/// The typed array of a list of numbers, and the helper that stores one of
/// its elements.
fn numbers(ty: &Type) -> Option<(&'static str, &'static str)> {
    Some(match ty {
        Type::U8 => ("Uint8Array", "witSet8"),
        Type::S8 => ("Int8Array", "witSet8"),
        Type::U16 => ("Uint16Array", "witSet16"),
        Type::S16 => ("Int16Array", "witSet16"),
        Type::U32 => ("Uint32Array", "witSet32"),
        Type::S32 => ("Int32Array", "witSet32"),
        Type::U64 => ("BigUint64Array", "witSet64"),
        Type::S64 => ("BigInt64Array", "witSet64"),
        Type::F32 => ("Float32Array", "witSetF32"),
        Type::F64 => ("Float64Array", "witSetF64"),
        _ => return None,
    })
}

impl Render for Ts<'_, '_> {
    fn sizes(&self) -> &SizeAlign {
        self.model.sizes.size_align()
    }

    fn whole(&self, _resolve: &Resolve, element: &Type) -> bool {
        numbers(element).is_some()
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
        match instruction {
            GetArg { nth } => vec![self.arg(body, *nth)],

            // Lifting.
            BoolFromI32 => one(format!("{} !== 0", x())),
            U8FromI32 => one(format!("{} & 0xff", x())),
            S8FromI32 => one(format!("({} << 24) >> 24", x())),
            U16FromI32 => one(format!("{} & 0xffff", x())),
            S16FromI32 => one(format!("({} << 16) >> 16", x())),
            U32FromI32 => one(format!("{} >>> 0", x())),
            S32FromI32 => one(format!("{} | 0", x())),
            U64FromI64 => one(format!("BigInt.asUintN(64, {})", ops[0])),
            S64FromI64 => one(format!("BigInt.asIntN(64, {})", ops[0])),
            F32FromCoreF32 | F64FromCoreF64 => one(ops[0].clone()),
            CharFromI32 => {
                self.helpers.insert("char");
                one(format!("witChar(guest, {})", ops[0]))
            }
            EnumLift { enum_, .. } => {
                self.helpers.insert("enum");
                one(format!("witEnum(guest, {}, {})", ops[0], enum_.cases.len()))
            }
            FlagsLift { .. } => one(format!("{} >>> 0", x())),
            I32Load { offset } => self.load("witI32", &ops[0], *offset),
            I32Load8U { offset } => self.load("witU8", &ops[0], *offset),
            I32Load8S { offset } => self.load("witS8", &ops[0], *offset),
            I32Load16U { offset } => self.load("witU16", &ops[0], *offset),
            I32Load16S { offset } => self.load("witS16", &ops[0], *offset),
            I64Load { offset } => self.load("witI64", &ops[0], *offset),
            F32Load { offset } => self.load("witF32", &ops[0], *offset),
            F64Load { offset } => self.load("witF64", &ops[0], *offset),
            PointerLoad { offset } | LengthLoad { offset } => self.load("witU32", &ops[0], *offset),
            StringLift => one(format!(
                "b.mem.range({} >>> 0, {} >>> 0)",
                x(),
                operand(&ops[1])
            )),
            ListCanonLift { element, .. } => match numbers(element) {
                Some(("Uint8Array", _)) => one(format!(
                    "b.mem.range({} >>> 0, {} >>> 0)",
                    x(),
                    operand(&ops[1])
                )),
                Some((array, _)) => {
                    self.helpers.insert("view");
                    self.helpers.insert("typed");
                    let size = self.model.sizes.size(element);
                    one(format!(
                        "witTyped(guest, b, {}, {}, {size}, {array})",
                        ops[0], ops[1]
                    ))
                }
                None => unreachable!("only lists of numbers are whole"),
            },
            ListLift { element, .. } => {
                let (lines, results) = body.take();
                let (size, align) = (
                    self.model.sizes.size(element),
                    self.model.sizes.align(element),
                );
                let ptr = body.temp();
                body.line(format!("const {ptr} = {} >>> 0;", x()));
                let len = body.temp();
                body.line(format!("const {len} = {} >>> 0;", operand(&ops[1])));
                self.helpers.insert("view");
                body.line(format!("witView(guest, b, {ptr}, {len}, {size}, {align});"));
                let items = body.temp();
                let element = element_type(self.model, &self.model.ty_of(element));
                body.line(format!("const {items}: {element}[] = [];"));
                let depth = body.depth() + 1;
                body.line(format!(
                    "for (let i{depth} = 0; i{depth} < {len}; i{depth}++) {{"
                ));
                body.line(format!("  const base{depth} = {ptr} + i{depth} * {size};"));
                body.lines(&lines, "  ");
                body.line(format!("  {items}.push({});", results[0]));
                body.line("}");
                one(items)
            }
            IterBasePointer => one(format!("base{}", body.depth())),
            IterElem { .. } => one(format!("e{}", body.depth())),
            RecordLift { record, ty, .. } => {
                let name = body.temp();
                body.line(format!("const {name}: {} = {{", type_name(self.model, *ty)));
                for (field, value) in record.fields.iter().zip(ops) {
                    body.line(format!("  {}: {value},", names::camel(&field.name)));
                }
                body.line("};");
                one(name)
            }
            TupleLift { ty, .. } => {
                let name = body.temp();
                let tuple = self.ts_type(&Type::Id(*ty));
                let single = format!("const {name}: {tuple} = [{}];", ops.join(", "));
                if self.indent + body.depth() * 2 + single.len() <= WIDTH {
                    body.line(single);
                } else {
                    body.line(format!("const {name}: {tuple} = ["));
                    for value in ops {
                        body.line(format!("  {value},"));
                    }
                    body.line("];");
                }
                one(name)
            }
            CallInterface { func, .. } => {
                let call = format!("host.{}(", names::camel(&func.name));
                if func.result.is_some() {
                    let name = body.temp();
                    self.list(body, &format!("const {name} = {call}"), ops, ");");
                    one(name)
                } else {
                    self.list(body, &call, ops, ");");
                    Vec::new()
                }
            }
            Return { amt, .. } => {
                if *amt == 1 {
                    body.line(format!("return {};", ops[0]));
                }
                Vec::new()
            }

            // Lowering.
            I32FromBool => one(format!("{} ? 1 : 0", x())),
            I32FromU8 => one(format!("{} & 0xff", x())),
            I32FromS8 => one(format!("({} << 24) >> 24", x())),
            I32FromU16 => one(format!("{} & 0xffff", x())),
            I32FromS16 => one(format!("({} << 16) >> 16", x())),
            I32FromU32 | I32FromChar => one(format!("{} >>> 0", x())),
            I32FromS32 => one(format!("{} | 0", x())),
            I64FromU64 => one(format!("BigInt.asUintN(64, {})", ops[0])),
            I64FromS64 => one(format!("BigInt.asIntN(64, {})", ops[0])),
            CoreF32FromF32 | CoreF64FromF64 => one(ops[0].clone()),
            EnumLower { .. } | FlagsLower { .. } => one(ops[0].clone()),
            RecordLower { record, .. } => {
                let value = self.bind(body, &ops[0]);
                record
                    .fields
                    .iter()
                    .map(|field| format!("{value}.{}", names::camel(&field.name)))
                    .collect()
            }
            TupleLower { tuple, .. } => {
                let value = self.bind(body, &ops[0]);
                (0..tuple.types.len())
                    .map(|index| format!("{value}[{index}]"))
                    .collect()
            }
            StringLower { .. } => {
                self.helpers.insert("encode");
                let bytes = body.temp();
                body.line(format!("const {bytes} = witEncode({});", ops[0]));
                let ptr = body.temp();
                body.line(format!("const {ptr} = b.alloc(1, {bytes}.length);"));
                body.line(format!("b.mem.range({ptr}, {bytes}.length).set({bytes});"));
                vec![ptr, format!("{bytes}.length")]
            }
            ListCanonLower { element, .. } => {
                let values = self.bind(body, &ops[0]);
                let (size, align) = (
                    self.model.sizes.size(element),
                    self.model.sizes.align(element),
                );
                let ptr = body.temp();
                match numbers(element) {
                    Some(("Uint8Array", _)) => {
                        body.line(format!("const {ptr} = b.alloc(1, {values}.length);"));
                        body.line(format!(
                            "b.mem.range({ptr}, {values}.length).set({values});"
                        ));
                    }
                    Some((_, setter)) => {
                        self.helpers.insert(setter);
                        body.line(format!(
                            "const {ptr} = b.alloc({align}, {values}.length * {size});"
                        ));
                        let index = body.temp();
                        body.line(format!(
                            "for (let {index} = 0; {index} < {values}.length; {index}++) {{"
                        ));
                        body.line(format!(
                            "  {setter}(b, {ptr} + {index} * {size}, {values}[{index}]);"
                        ));
                        body.line("}");
                    }
                    None => unreachable!("only lists of numbers are whole"),
                }
                vec![ptr, format!("{values}.length")]
            }
            ListLower { element, .. } => {
                let (lines, _) = body.take();
                let values = self.bind(body, &ops[0]);
                let (size, align) = (
                    self.model.sizes.size(element),
                    self.model.sizes.align(element),
                );
                let ptr = body.temp();
                body.line(format!(
                    "const {ptr} = b.alloc({align}, {values}.length * {size});"
                ));
                body.line(format!("if ({values}.length > 0) {{"));
                body.line(format!(
                    "  b.mem.range({ptr}, {values}.length * {size}).fill(0);"
                ));
                body.line("}");
                let depth = body.depth() + 1;
                body.line(format!(
                    "for (let i{depth} = 0; i{depth} < {values}.length; i{depth}++) {{"
                ));
                body.line(format!("  const e{depth} = {values}[i{depth}];"));
                body.line(format!("  const base{depth} = {ptr} + i{depth} * {size};"));
                body.lines(&lines, "  ");
                body.line("}");
                vec![ptr, format!("{values}.length")]
            }
            I32Store { offset } | PointerStore { offset } | LengthStore { offset } => {
                self.store(body, "witSet32", ops, *offset)
            }
            I32Store8 { offset } => self.store(body, "witSet8", ops, *offset),
            I32Store16 { offset } => self.store(body, "witSet16", ops, *offset),
            I64Store { offset } => self.store(body, "witSet64", ops, *offset),
            F32Store { offset } => self.store(body, "witSetF32", ops, *offset),
            F64Store { offset } => self.store(body, "witSetF64", ops, *offset),
            Flush { .. } => ops.to_vec(),
            _ => unreachable!("host bindings carry no values of this instruction's kind"),
        }
    }
}

/// The fixed helpers the bindings used.
fn helpers(_model: &Model, code: &mut Code) {
    if code.helpers.contains("typed") {
        code.helpers.insert("view");
    }
    for key in code.helpers.clone() {
        for line in fixed(key) {
            code.line(*line);
        }
        code.line("");
    }
}

/// A load helper: `range` checks the access, then the view reads it.
macro_rules! load {
    ($name:literal, $size:literal, $method:literal, $ty:literal) => {
        &[
            concat!(
                "function ",
                $name,
                "(b: GuestBinding, at: number): ",
                $ty,
                " {"
            ),
            concat!("  b.mem.range(at, ", $size, ");"),
            concat!("  return b.mem.data().get", $method, "(at, true);"),
            "}",
        ]
    };
}

fn fixed(key: &str) -> &'static [&'static str] {
    match key {
        "view" => &[
            "/** The `count` elements of `size` bytes at `ptr`, checked. */",
            "function witView(",
            "  guest: Guest,",
            "  b: GuestBinding,",
            "  ptr: number,",
            "  count: number,",
            "  size: number,",
            "  align: number,",
            "): Uint8Array {",
            "  if ((ptr >>> 0) % align !== 0) throw guest.trap(\"misaligned pointer\");",
            "  return b.mem.range(ptr >>> 0, (count >>> 0) * size);",
            "}",
        ],
        "typed" => &[
            "type Typed<T> = new (",
            "  buffer: ArrayBufferLike,",
            "  offset: number,",
            "  length: number,",
            ") => T;",
            "",
            "/** A list of numbers, as a typed array over the guest's memory. */",
            "function witTyped<T>(",
            "  guest: Guest,",
            "  b: GuestBinding,",
            "  ptr: number,",
            "  len: number,",
            "  size: number,",
            "  array: Typed<T>,",
            "): T {",
            "  const bytes = witView(guest, b, ptr, len, size, size);",
            "  return new array(bytes.buffer, bytes.byteOffset, len >>> 0);",
            "}",
        ],
        "char" => &[
            "/** A Unicode scalar value, or a trap. */",
            "function witChar(guest: Guest, value: number): number {",
            "  const char = value >>> 0;",
            "  if (char >= 0x110000 || (char >= 0xd800 && char < 0xe000)) {",
            "    throw guest.trap(\"invalid char\");",
            "  }",
            "  return char;",
            "}",
        ],
        "enum" => &[
            "/** An enum's discriminant, or a trap. */",
            "function witEnum(guest: Guest, value: number, cases: number): number {",
            "  const discriminant = value >>> 0;",
            "  if (discriminant >= cases) {",
            "    throw guest.trap(\"invalid enum discriminant\");",
            "  }",
            "  return discriminant;",
            "}",
        ],
        "encode" => &[
            "const encoder = new TextEncoder();",
            "",
            "/** A string's UTF-8 bytes. */",
            "function witEncode(value: Uint8Array | string): Uint8Array {",
            "  return typeof value === \"string\" ? encoder.encode(value) : value;",
            "}",
        ],
        "witI32" => load!("witI32", "4", "Int32", "number"),
        "witU32" => load!("witU32", "4", "Uint32", "number"),
        "witI64" => load!("witI64", "8", "BigInt64", "bigint"),
        "witF32" => load!("witF32", "4", "Float32", "number"),
        "witF64" => load!("witF64", "8", "Float64", "number"),
        "witU16" => load!("witU16", "2", "Uint16", "number"),
        "witS16" => load!("witS16", "2", "Int16", "number"),
        "witU8" => &[
            "function witU8(b: GuestBinding, at: number): number {",
            "  return b.mem.range(at, 1)[0];",
            "}",
        ],
        "witS8" => &[
            "function witS8(b: GuestBinding, at: number): number {",
            "  return (b.mem.range(at, 1)[0] << 24) >> 24;",
            "}",
        ],
        "witSet8" => &[
            "function witSet8(b: GuestBinding, at: number, value: number): void {",
            "  b.mem.range(at, 1)[0] = value;",
            "}",
        ],
        "witSet16" => &[
            "function witSet16(b: GuestBinding, at: number, value: number): void {",
            "  b.mem.range(at, 2);",
            "  b.mem.data().setUint16(at, value & 0xffff, true);",
            "}",
        ],
        "witSet32" => &[
            "function witSet32(b: GuestBinding, at: number, value: number): void {",
            "  b.mem.range(at, 4);",
            "  b.mem.data().setUint32(at, value >>> 0, true);",
            "}",
        ],
        "witSet64" => &[
            "function witSet64(b: GuestBinding, at: number, value: bigint): void {",
            "  b.mem.range(at, 8);",
            "  b.mem.data().setBigUint64(at, BigInt.asUintN(64, value), true);",
            "}",
        ],
        "witSetF32" => &[
            "function witSetF32(b: GuestBinding, at: number, value: number): void {",
            "  b.mem.range(at, 4);",
            "  b.mem.data().setFloat32(at, value, true);",
            "}",
        ],
        "witSetF64" => &[
            "function witSetF64(b: GuestBinding, at: number, value: number): void {",
            "  b.mem.range(at, 8);",
            "  b.mem.data().setFloat64(at, value, true);",
            "}",
        ],
        other => unreachable!("no helper {other}"),
    }
}
