// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! C host bindings, for a host of the C wasm2c translates the linked module
//! to. One header: the types and the prototypes of the functions the host
//! implements, and, where the host defines `<BASE>IMPLEMENTATION` before
//! including it, the definitions of the imports wasm2c's module calls. The
//! names wasm2c gives those imports and the exports holding their memories
//! and allocators are the host's to alias (the console SDK's
//! `host_bindings.py` reads them out of wasm2c's header): the bindings
//! define `F<name>` and call `F<name>_memory` and `F<name>_realloc` with the
//! guest instance `<BASE>GUEST(instance)` gives, `F` being the flat prefix.
//!
//! Parameter strings and lists of bytes point into the guest's memory, other
//! lists are views read element by element (little-endian, so the host's
//! byte order does not matter), and results point into the host's memory
//! until the import returns, when the bindings have copied them.

use std::collections::BTreeMap;

use anyhow::{Result, bail};
use wit_bindgen_core::abi::Instruction;
use wit_parser::abi::WasmType;
use wit_parser::{ArchitectureSize, Resolve, SizeAlign, Type, TypeId};

use super::plan::{self, Body, Render, operand};
use super::{COptions, Def, Func, Group, Kind, Model, Ty, doc_lines, group_snake, provenance};
use crate::names;

const KEYWORDS: &[&str] = &[
    "auto", "bool", "break", "case", "char", "const", "continue", "default", "do", "double",
    "else", "enum", "extern", "false", "float", "for", "goto", "if", "inline", "int", "long",
    "register", "restrict", "return", "short", "signed", "sizeof", "static", "struct", "switch",
    "true", "typedef", "union", "unsigned", "void", "volatile", "while",
    // The bindings' own locals.
    "bytes", "instance", "memory", "result", "spilled",
];

fn local(name: &str) -> String {
    let name = names::snake(name);
    if KEYWORDS.contains(&name.as_str()) || super::is_flat_name(&name) {
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
            [only] => self.line(format!("/* {} */", only.trim())),
            _ => {
                self.line("/*");
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
}

/// One group's names.
struct Names {
    /// The prefix of types and of the functions the host implements.
    prefix: String,
    /// The prefix of the imports and their memories' and allocators'.
    flat: String,
    /// The type of the imports' context argument.
    context: String,
}

/// What a group's bindings need besides its functions: the list types its
/// functions use, by mnemonic.
#[derive(Default)]
struct Needs {
    views: BTreeMap<String, Ty>,
    lists: BTreeMap<String, Ty>,
    tuples: BTreeMap<String, Ty>,
}

pub(super) fn generate(model: &Model, options: &COptions, out: &mut String) -> Result<()> {
    if model.groups.len() > 1 && options.prefix.is_some() {
        bail!("--c-prefix names one interface's bindings, and the world imports several");
    }
    let base = match (&options.prefix, model.groups.as_slice()) {
        (Some(prefix), _) => format!("{}_", names::shouty(prefix)),
        (None, [group]) => format!("{}_", names::shouty(&group_snake(model, group))),
        _ => format!(
            "{}_{}_{}_HOST_",
            names::shouty(&model.namespace),
            names::shouty(&model.package),
            names::shouty(&model.world)
        ),
    };
    let package = format!(
        "{}_{}",
        names::snake(&model.namespace),
        names::snake(&model.package)
    );
    let names = |group: &Group| Names {
        prefix: options
            .prefix
            .clone()
            .unwrap_or_else(|| format!("{}_", group_snake(model, group))),
        flat: options
            .flat_prefix
            .clone()
            .unwrap_or_else(|| format!("{package}_")),
        context: options
            .context
            .clone()
            .unwrap_or_else(|| format!("{package}_t")),
    };
    let mut code = Code {
        out: String::new(),
        indent: 0,
    };
    let context = names(&model.groups[0]).context;
    for line in provenance(model) {
        code.line(format!("// {line}"));
    }
    for line in [
        "// A host of the C wasm2c translates the linked module to implements the".to_string(),
        "// functions declared below, and includes this file after declaring".to_string(),
        format!("// `{context}`. In one source file it includes it again where"),
        format!("// `{base}IMPLEMENTATION` is defined, and `{base}GUEST(instance)`"),
        "// as the wasm2c instance whose exports hold the imports' memories and".into(),
        "// allocators: there this file defines the imports wasm2c's module calls,".into(),
        "// under wlink's host ABI.".into(),
    ] {
        code.line(line);
    }
    code.line("");
    code.line(format!("#ifndef {base}H"));
    code.line(format!("#define {base}H"));
    code.line("");
    code.line("#include <stdbool.h>");
    code.line("#include <stddef.h>");
    code.line("#include <stdint.h>");
    code.line("");
    let mut needs = Vec::new();
    for group in &model.groups {
        let names = names(group);
        let mut need = Needs::default();
        declarations(model, &mut code, group, &names, &mut need)?;
        needs.push(need);
    }
    code.line(format!("#endif /* {base}H */"));
    code.line("");
    code.line(format!(
        "#if defined({base}IMPLEMENTATION) && !defined({base}IMPLEMENTED)"
    ));
    code.line(format!("#define {base}IMPLEMENTED"));
    code.line("");
    code.line("#include <string.h>");
    code.line("#include \"wasm-rt.h\"");
    code.line("");
    code.line(format!("#ifndef {base}GUEST"));
    code.line(format!(
        "#error \"define {base}GUEST(instance) as the wasm2c instance of the imports\""
    ));
    code.line("#endif");
    code.line("");
    for (group, need) in model.groups.iter().zip(&mut needs) {
        let names = names(group);
        definitions(model, &mut code, group, &names, &base, need);
    }
    code.line(format!("#endif /* {base}IMPLEMENTATION */"));
    out.push_str(&code.out);
    Ok(())
}

fn type_name(model: &Model, names: &Names, id: TypeId) -> String {
    format!("{}{}_t", names.prefix, names::snake(&model.named(id).name))
}

/// The prefix of a named type's constants: `PREFIX_NAME`.
fn constant_prefix(model: &Model, names: &Names, id: TypeId) -> String {
    names::shouty(&format!(
        "{}{}",
        names.prefix,
        names::snake(&model.named(id).name)
    ))
}

/// A short name for a type, for the types and helpers named after it.
fn mnemonic(model: &Model, ty: &Ty) -> String {
    match &ty.kind {
        Kind::Bool => "bool".into(),
        Kind::U8 => "u8".into(),
        Kind::S8 => "s8".into(),
        Kind::U16 => "u16".into(),
        Kind::S16 => "s16".into(),
        Kind::U32 => "u32".into(),
        Kind::S32 => "s32".into(),
        Kind::U64 => "u64".into(),
        Kind::S64 => "s64".into(),
        Kind::F32 => "f32".into(),
        Kind::F64 => "f64".into(),
        Kind::Char => "char".into(),
        Kind::String => "string".into(),
        Kind::List(element) => format!("list_{}", mnemonic(model, element)),
        Kind::Tuple(items) => format!(
            "tuple_{}",
            items
                .iter()
                .map(|item| mnemonic(model, item))
                .collect::<Vec<_>>()
                .join("_")
        ),
        Kind::Named(id) => names::snake(&model.named(*id).name),
    }
}

/// A value's C type, inside a record, as a result, or as a parameter other
/// than a list of more than bytes.
fn value_type(model: &Model, names: &Names, need: &mut Needs, ty: &Ty) -> String {
    match &ty.kind {
        Kind::Bool => "bool".into(),
        Kind::U8 => "uint8_t".into(),
        Kind::S8 => "int8_t".into(),
        Kind::U16 => "uint16_t".into(),
        Kind::S16 => "int16_t".into(),
        Kind::U32 | Kind::Char => "uint32_t".into(),
        Kind::S32 => "int32_t".into(),
        Kind::U64 => "uint64_t".into(),
        Kind::S64 => "int64_t".into(),
        Kind::F32 => "float".into(),
        Kind::F64 => "double".into(),
        Kind::String => format!("{}bytes_t", names.prefix),
        Kind::List(element) if matches!(element.kind, Kind::U8) => {
            format!("{}bytes_t", names.prefix)
        }
        Kind::List(element) => {
            value_type(model, names, need, element);
            let mnemonic = mnemonic(model, element);
            need.lists
                .entry(mnemonic.clone())
                .or_insert_with(|| (**element).clone());
            format!("{}{mnemonic}_list_t", names.prefix)
        }
        Kind::Tuple(items) => {
            for item in items {
                value_type(model, names, need, item);
            }
            let mnemonic = mnemonic(model, ty);
            need.tuples
                .entry(mnemonic.clone())
                .or_insert_with(|| ty.clone());
            format!("{}{mnemonic}_t", names.prefix)
        }
        Kind::Named(id) => type_name(model, names, *id),
    }
}

/// A parameter's C type: lists of more than bytes are views.
fn param_type(model: &Model, names: &Names, need: &mut Needs, ty: &Ty) -> Result<String> {
    match &ty.kind {
        Kind::List(element) if !matches!(element.kind, Kind::U8) => {
            if traps(model, element) {
                bail!("a C host takes no lists of characters or enums as parameters");
            }
            value_type(model, names, need, element);
            let mnemonic = mnemonic(model, element);
            need.views
                .entry(mnemonic.clone())
                .or_insert_with(|| (**element).clone());
            Ok(format!("{}{mnemonic}_view_t", names.prefix))
        }
        _ => {
            if lists_in_parts(model, ty) {
                bail!("a C host takes no records or tuples holding lists of more than bytes");
            }
            Ok(value_type(model, names, need, ty))
        }
    }
}

/// Whether lifting a value can trap on what it holds.
fn traps(model: &Model, ty: &Ty) -> bool {
    match &ty.kind {
        Kind::Char => true,
        Kind::Tuple(items) => items.iter().any(|item| traps(model, item)),
        Kind::Named(id) => match &model.named(*id).def {
            Def::Record { fields } => fields.iter().any(|(_, ty, _)| traps(model, ty)),
            Def::Enum { .. } => true,
            Def::Flags { .. } => false,
        },
        _ => false,
    }
}

/// Whether a record or tuple holds a list of more than bytes.
fn lists_in_parts(model: &Model, ty: &Ty) -> bool {
    model.parts(ty).iter().any(|part| match &part.kind {
        Kind::List(element) => !matches!(element.kind, Kind::U8),
        _ => lists_in_parts(model, part),
    })
}

fn declarations(
    model: &Model,
    code: &mut Code,
    group: &Group,
    names: &Names,
    need: &mut Needs,
) -> Result<()> {
    let prefix = &names.prefix;
    code.docs(&group.docs);
    code.line(format!(
        "/* `{}`: a string's UTF-8 bytes, or a list<u8>. */",
        group.module
    ));
    code.line("typedef struct {");
    code.line("  const uint8_t *ptr;");
    code.line("  size_t len;");
    code.line(format!("}} {prefix}bytes_t;"));
    code.line("");
    // Every type a function uses, then the composite types after what they
    // hold: records in the model's order, lists and tuples once their
    // elements are declared.
    let mut prototypes = Vec::new();
    for func in &group.funcs {
        let mut params = vec![format!("{} *instance", names.context)];
        for (name, ty) in &func.params {
            let ty = param_type(model, names, need, ty)?;
            params.push(format!("{ty} {}", local(name)));
        }
        let result = match &func.result {
            Some(ty) => value_type(model, names, need, ty),
            None => "void".into(),
        };
        prototypes.push((func, result, params));
    }
    let mut declared = std::collections::BTreeSet::new();
    for id in &group.defs {
        composites_before(model, code, names, need, &mut declared, *id);
        definition(model, code, names, need, *id);
    }
    for (mnemonic, ty) in need.tuples.clone() {
        if declared.insert(format!("tuple:{mnemonic}")) {
            tuple(model, code, names, need, &mnemonic, &ty);
        }
    }
    for (mnemonic, ty) in need.lists.clone() {
        if !declared.insert(format!("list:{mnemonic}")) {
            continue;
        }
        let element = value_type(model, names, need, &ty);
        code.line(format!("/* A result list<{}>. */", wit_name(model, &ty)));
        code.line("typedef struct {");
        code.line(format!("  const {element} *ptr;"));
        code.line("  size_t len;");
        code.line(format!("}} {prefix}{mnemonic}_list_t;"));
        code.line("");
    }
    for line in [
        format!("static inline uint16_t {prefix}le16_(const uint8_t *p) {{"),
        "  return (uint16_t)(p[0] | p[1] << 8);".into(),
        "}".into(),
        "".into(),
        format!("static inline uint32_t {prefix}le32_(const uint8_t *p) {{"),
        "  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 |".into(),
        "         (uint32_t)p[3] << 24;".into(),
        "}".into(),
        "".into(),
        format!("static inline uint64_t {prefix}le64_(const uint8_t *p) {{"),
        format!("  return (uint64_t){prefix}le32_(p) | (uint64_t){prefix}le32_(p + 4) << 32;"),
        "}".into(),
        "".into(),
        format!("static inline float {prefix}f32_(uint32_t bits) {{"),
        "  union { uint32_t bits; float value; } pun = {bits};".into(),
        "  return pun.value;".into(),
        "}".into(),
        "".into(),
        format!("static inline double {prefix}f64_(uint64_t bits) {{"),
        "  union { uint64_t bits; double value; } pun = {bits};".into(),
        "  return pun.value;".into(),
        "}".into(),
        "".into(),
    ] {
        code.line(line);
    }
    for (mnemonic, ty) in need.views.clone() {
        let element = value_type(model, names, need, &ty);
        let size = model.size(&ty);
        code.line(format!(
            "/* A parameter list<{}>: `len` elements of {size} bytes at `bytes`. */",
            wit_name(model, &ty)
        ));
        code.line("typedef struct {");
        code.line("  const uint8_t *bytes;");
        code.line("  size_t len;");
        code.line(format!("}} {prefix}{mnemonic}_view_t;"));
        code.line("");
        code.line(format!(
            "static inline {element} {prefix}{mnemonic}_view_get({prefix}{mnemonic}_view_t view, size_t index) {{"
        ));
        code.indent += 1;
        let value = loaded(
            model,
            names,
            need,
            &ty,
            &format!("view.bytes + index * {size}"),
        );
        code.line(format!("return {value};"));
        code.indent -= 1;
        code.line("}");
        code.line("");
    }
    for (func, result, params) in prototypes {
        code.docs(&func.docs);
        code.line(format!(
            "{result} {prefix}{}({});",
            names::snake(&func.name),
            params.join(", ")
        ));
    }
    code.line("");
    Ok(())
}

/// Declares the tuples and lists a record's fields use before it.
fn composites_before(
    model: &Model,
    code: &mut Code,
    names: &Names,
    need: &mut Needs,
    declared: &mut std::collections::BTreeSet<String>,
    id: TypeId,
) {
    let Def::Record { fields } = &model.named(id).def else {
        return;
    };
    for (_, ty, _) in fields {
        if let Kind::Tuple(_) = ty.kind {
            let mnemonic = mnemonic(model, ty);
            if declared.insert(format!("tuple:{mnemonic}")) {
                tuple(model, code, names, need, &mnemonic, ty);
            }
        }
        if let Kind::List(element) = &ty.kind
            && !matches!(element.kind, Kind::U8)
        {
            let mnemonic = mnemonic(model, element);
            if declared.insert(format!("list:{mnemonic}")) {
                let element_type = value_type(model, names, need, element);
                code.line("typedef struct {");
                code.line(format!("  const {element_type} *ptr;"));
                code.line("  size_t len;");
                code.line(format!("}} {}{mnemonic}_list_t;", names.prefix));
                code.line("");
            }
        }
    }
}

fn tuple(model: &Model, code: &mut Code, names: &Names, need: &mut Needs, mnemonic: &str, ty: &Ty) {
    let Kind::Tuple(items) = &ty.kind else {
        return;
    };
    code.line("typedef struct {");
    for (index, item) in items.iter().enumerate() {
        code.line(format!(
            "  {} f{index};",
            value_type(model, names, need, item)
        ));
    }
    code.line(format!("}} {}{mnemonic}_t;", names.prefix));
    code.line("");
}

fn definition(model: &Model, code: &mut Code, names: &Names, need: &mut Needs, id: TypeId) {
    let named = model.named(id);
    let name = type_name(model, names, id);
    code.docs(&named.docs);
    match &named.def {
        Def::Record { fields } => {
            code.line("typedef struct {");
            code.indent += 1;
            for (field, ty, docs) in fields {
                code.docs(docs);
                code.line(format!(
                    "{} {};",
                    value_type(model, names, need, ty),
                    local(field)
                ));
            }
            code.indent -= 1;
            code.line(format!("}} {name};"));
        }
        Def::Enum { cases } => {
            code.line("typedef enum {");
            code.indent += 1;
            for (index, (case, docs)) in cases.iter().enumerate() {
                code.docs(docs);
                code.line(format!(
                    "{}_{} = {index},",
                    constant_prefix(model, names, id),
                    names::shouty(case)
                ));
            }
            code.indent -= 1;
            code.line(format!("}} {name};"));
        }
        Def::Flags { flags } => {
            code.line(format!("typedef uint32_t {name};"));
            for (index, (flag, docs)) in flags.iter().enumerate() {
                code.docs(docs);
                code.line(format!(
                    "#define {}_{} (UINT32_C(1) << {index})",
                    constant_prefix(model, names, id),
                    names::shouty(flag)
                ));
            }
        }
    }
    code.line("");
}

/// An expression loading a value at `at` (a `const uint8_t *`), little-endian.
fn loaded(model: &Model, names: &Names, need: &mut Needs, ty: &Ty, at: &str) -> String {
    let prefix = &names.prefix;
    let offset = |offset: usize| {
        if offset == 0 {
            at.to_string()
        } else {
            format!("{at} + {offset}")
        }
    };
    match &ty.kind {
        Kind::Bool => format!("({at})[0] != 0"),
        Kind::U8 => format!("({at})[0]"),
        Kind::S8 => format!("(int8_t)({at})[0]"),
        Kind::U16 => format!("{prefix}le16_({at})"),
        Kind::S16 => format!("(int16_t){prefix}le16_({at})"),
        Kind::U32 | Kind::Char => format!("{prefix}le32_({at})"),
        Kind::S32 => format!("(int32_t){prefix}le32_({at})"),
        Kind::U64 => format!("{prefix}le64_({at})"),
        Kind::S64 => format!("(int64_t){prefix}le64_({at})"),
        Kind::F32 => format!("{prefix}f32_({prefix}le32_({at}))"),
        Kind::F64 => format!("{prefix}f64_({prefix}le64_({at}))"),
        Kind::Tuple(items) => {
            let name = value_type(model, names, need, ty);
            let items: Vec<String> = items
                .iter()
                .zip(model.offsets(ty))
                .map(|(item, at)| loaded(model, names, need, item, &offset(at)))
                .collect();
            format!("({name}){{{}}}", items.join(", "))
        }
        Kind::Named(id) => match &model.named(*id).def {
            Def::Record { fields } => {
                let name = value_type(model, names, need, ty);
                let fields: Vec<String> = fields
                    .iter()
                    .zip(model.offsets(ty))
                    .map(|((field, ty, _), at)| {
                        format!(
                            ".{} = {}",
                            local(field),
                            loaded(model, names, need, ty, &offset(at))
                        )
                    })
                    .collect();
                format!("({name}){{{}}}", fields.join(", "))
            }
            _ => {
                let name = type_name(model, names, *id);
                match model.scalar_size(*id) {
                    1 => format!("({name})({at})[0]"),
                    2 => format!("({name}){prefix}le16_({at})"),
                    _ => format!("({name}){prefix}le32_({at})"),
                }
            }
        },
        Kind::String | Kind::List(_) => unreachable!("views hold no pointers"),
    }
}

/// A type's WIT spelling, for comments.
fn wit_name(model: &Model, ty: &Ty) -> String {
    match &ty.kind {
        Kind::Bool => "bool".into(),
        Kind::U8 => "u8".into(),
        Kind::S8 => "s8".into(),
        Kind::U16 => "u16".into(),
        Kind::S16 => "s16".into(),
        Kind::U32 => "u32".into(),
        Kind::S32 => "s32".into(),
        Kind::U64 => "u64".into(),
        Kind::S64 => "s64".into(),
        Kind::F32 => "f32".into(),
        Kind::F64 => "f64".into(),
        Kind::Char => "char".into(),
        Kind::String => "string".into(),
        Kind::List(element) => format!("list<{}>", wit_name(model, element)),
        Kind::Tuple(items) => format!(
            "tuple<{}>",
            items
                .iter()
                .map(|item| wit_name(model, item))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Kind::Named(id) => model.named(*id).name.clone(),
    }
}

fn flat_type(ty: WasmType) -> &'static str {
    match crate::abi::core(ty) {
        WasmType::I64 => "uint64_t",
        WasmType::F32 => "float",
        WasmType::F64 => "double",
        _ => "uint32_t",
    }
}

fn definitions(
    model: &Model,
    code: &mut Code,
    group: &Group,
    names: &Names,
    base: &str,
    need: &mut Needs,
) {
    let prefix = &names.prefix;
    for line in [
        format!(
            "static inline uint8_t *{prefix}range_(wasm_rt_memory_t *memory, uint64_t ptr, uint64_t len) {{"
        ),
        "  if (ptr + len > memory->size) wasm_rt_trap(WASM_RT_TRAP_OOB);".into(),
        "  return memory->data + ptr;".into(),
        "}".into(),
        "".into(),
        format!(
            "static inline uint8_t *{prefix}view_(wasm_rt_memory_t *memory, uint32_t ptr, uint32_t count,"
        ),
        "                                     uint32_t size, uint32_t align) {".into(),
        "  if (ptr % align) wasm_rt_trap(WASM_RT_TRAP_UNALIGNED);".into(),
        format!("  return {prefix}range_(memory, ptr, (uint64_t)count * size);"),
        "}".into(),
        "".into(),
        format!("static inline void {prefix}put_(uint8_t *p, uint64_t value, unsigned size) {{"),
        "  for (unsigned i = 0; i < size; ++i) p[i] = (uint8_t)(value >> (8 * i));".into(),
        "}".into(),
        "".into(),
        format!("static inline uint32_t {prefix}char_(uint32_t value) {{"),
        "  if (value >= 0x110000 || (value >= 0xd800 && value < 0xe000))".into(),
        "    wasm_rt_trap(WASM_RT_TRAP_UNREACHABLE);".into(),
        "  return value;".into(),
        "}".into(),
        "".into(),
        format!("static inline uint32_t {prefix}enum_(uint32_t value, uint32_t cases) {{"),
        "  if (value >= cases) wasm_rt_trap(WASM_RT_TRAP_UNREACHABLE);".into(),
        "  return value;".into(),
        "}".into(),
        "".into(),
        format!("static inline uint32_t {prefix}f32_bits_(float value) {{"),
        "  uint32_t bits;".into(),
        "  memcpy(&bits, &value, sizeof bits);".into(),
        "  return bits;".into(),
        "}".into(),
        "".into(),
        format!("static inline uint64_t {prefix}f64_bits_(double value) {{"),
        "  uint64_t bits;".into(),
        "  memcpy(&bits, &value, sizeof bits);".into(),
        "  return bits;".into(),
        "}".into(),
        "".into(),
    ] {
        code.line(line);
    }
    for func in &group.funcs {
        import(model, code, names, base, need, func);
    }
}

fn import(
    model: &Model,
    code: &mut Code,
    names: &Names,
    base: &str,
    need: &mut Needs,
    func: &Func,
) {
    let prefix = &names.prefix;
    let name = names::snake(&func.name);
    let flat = format!("{}{name}", names.flat);
    let alloc = format!("{prefix}{name}_alloc_");
    if func.realloc {
        code.line(format!(
            "static uint32_t {alloc}({} *instance, uint32_t align, uint32_t len) {{",
            names.context
        ));
        code.line(format!(
            "  return len ? {flat}_realloc({base}GUEST(instance), 0, 0, align, len) : align;"
        ));
        code.line("}");
        code.line("");
    }
    let mut params = vec![format!("{} *instance", names.context)];
    params.extend(
        func.sig
            .params
            .iter()
            .enumerate()
            .map(|(index, ty)| format!("{} a{index}", flat_type(*ty))),
    );
    let returns = match func.sig.results.first() {
        Some(ty) => flat_type(*ty),
        None => "void",
    };
    code.line(format!("{returns} {flat}({}) {{", params.join(", ")));
    code.indent += 1;
    if func.memory {
        code.line(format!(
            "wasm_rt_memory_t *memory = {flat}_memory({base}GUEST(instance));"
        ));
    }
    let mut c = C {
        model,
        func,
        names,
        need,
        alloc,
    };
    for line in plan::body(model.resolve, &func.function, &mut c) {
        code.line(line);
    }
    code.indent -= 1;
    code.line("}");
    code.line("");
}

/// The plan of an import, in C over wasm2c's runtime.
struct C<'a, 'm> {
    model: &'a Model<'m>,
    func: &'a Func,
    names: &'a Names,
    need: &'a mut Needs,
    /// The import's allocator, as the bindings call it.
    alloc: String,
}

impl C<'_, '_> {
    fn c_type(&mut self, ty: &Type) -> String {
        let ty = self.model.ty_of(ty);
        value_type(self.model, self.names, self.need, &ty)
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
            body.line(format!(
                "{}view_(memory, a{nth}, 1, {size}, {align});",
                self.names.prefix
            ));
        }
        format!("a{nth}")
    }

    /// The `size` bytes at `address + offset`, checked.
    fn range(&self, address: &str, offset: &ArchitectureSize, size: usize) -> String {
        let offset = offset.size_wasm32();
        let at = if offset == 0 {
            format!("(uint64_t){}", operand(address))
        } else {
            format!("(uint64_t){} + {offset}", operand(address))
        };
        format!("{}range_(memory, {at}, {size})", self.names.prefix)
    }

    /// A temporary holding a value, unless it is a name already.
    fn bind(&self, body: &mut Body, ty: &str, value: &str) -> String {
        if value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return value.to_string();
        }
        let name = body.temp();
        body.line(format!("{ty} {name} = {value};"));
        name
    }

    fn store(
        &self,
        body: &mut Body,
        operands: &[String],
        offset: &ArchitectureSize,
        size: usize,
        value: String,
    ) {
        let range = self.range(&operands[1], offset, size);
        body.line(format!(
            "{}put_({range}, {value}, {size});",
            self.names.prefix
        ));
    }

    /// Copies bytes into fresh guest memory: their pointer and length.
    fn bytes(&self, body: &mut Body, value: &str) -> Vec<String> {
        let prefix = &self.names.prefix;
        body.line(format!(
            "if ({value}.len > UINT32_MAX) wasm_rt_trap(WASM_RT_TRAP_OOB);"
        ));
        let ptr = body.temp();
        body.line(format!(
            "uint32_t {ptr} = {}(instance, 1, (uint32_t){value}.len);",
            self.alloc
        ));
        body.line(format!(
            "if ({value}.len) memcpy({prefix}range_(memory, {ptr}, {value}.len), {value}.ptr, {value}.len);"
        ));
        vec![ptr, format!("(uint32_t){value}.len")]
    }

    /// A view of a list the guest passes, checked.
    fn view(&mut self, body: &mut Body, element: &Type, ptr: &str, len: &str) -> String {
        let prefix = self.names.prefix.clone();
        let ptr = self.bind(body, "uint32_t", ptr);
        let len = self.bind(body, "uint32_t", len);
        let (size, align) = (
            self.model.sizes.size(element),
            self.model.sizes.align(element),
        );
        if matches!(element, Type::U8) {
            return format!("({prefix}bytes_t){{{prefix}range_(memory, {ptr}, {len}), {len}}}");
        }
        let mnemonic = mnemonic(self.model, &self.model.ty_of(element));
        format!(
            "({prefix}{mnemonic}_view_t){{{prefix}view_(memory, {ptr}, {len}, {size}, {align}), {len}}}"
        )
    }
}

/// Whether C reads a list of the element whole: numbers, as views or
/// copies of their bytes.
fn number(ty: &Type) -> bool {
    matches!(
        ty,
        Type::U8
            | Type::S8
            | Type::U16
            | Type::S16
            | Type::U32
            | Type::S32
            | Type::U64
            | Type::S64
            | Type::F32
            | Type::F64
    )
}

impl Render for C<'_, '_> {
    fn sizes(&self) -> &SizeAlign {
        self.model.sizes.size_align()
    }

    fn whole(&self, _resolve: &Resolve, element: &Type) -> bool {
        number(element)
    }

    fn render(
        &mut self,
        body: &mut Body,
        _resolve: &Resolve,
        instruction: &Instruction<'_>,
        ops: &[String],
    ) -> Vec<String> {
        use Instruction::*;
        let prefix = self.names.prefix.clone();
        let one = |text: String| vec![text];
        let x = || operand(&ops[0]);
        match instruction {
            GetArg { nth } => one(self.arg(body, *nth)),

            // Lifting.
            BoolFromI32 => one(format!("{} != 0", x())),
            U8FromI32 => one(format!("(uint8_t){}", x())),
            S8FromI32 => one(format!("(int8_t){}", x())),
            U16FromI32 => one(format!("(uint16_t){}", x())),
            S16FromI32 => one(format!("(int16_t){}", x())),
            S32FromI32 => one(format!("(int32_t){}", x())),
            S64FromI64 => one(format!("(int64_t){}", x())),
            U32FromI32 | U64FromI64 | F32FromCoreF32 | F64FromCoreF64 | FlagsLift { .. } => {
                one(ops[0].clone())
            }
            CharFromI32 => one(format!("{prefix}char_({})", ops[0])),
            EnumLift { enum_, ty, .. } => one(format!(
                "({}){prefix}enum_({}, {})",
                type_name(self.model, self.names, *ty),
                ops[0],
                enum_.cases.len()
            )),
            I32Load { offset } | PointerLoad { offset } | LengthLoad { offset } => {
                one(format!("{prefix}le32_({})", self.range(&ops[0], offset, 4)))
            }
            I32Load8U { offset } => one(format!("{}[0]", self.range(&ops[0], offset, 1))),
            I32Load8S { offset } => one(format!(
                "(uint32_t)(int32_t)(int8_t){}[0]",
                self.range(&ops[0], offset, 1)
            )),
            I32Load16U { offset } => {
                one(format!("{prefix}le16_({})", self.range(&ops[0], offset, 2)))
            }
            I32Load16S { offset } => one(format!(
                "(uint32_t)(int32_t)(int16_t){prefix}le16_({})",
                self.range(&ops[0], offset, 2)
            )),
            I64Load { offset } => one(format!("{prefix}le64_({})", self.range(&ops[0], offset, 8))),
            F32Load { offset } => one(format!(
                "{prefix}f32_({prefix}le32_({}))",
                self.range(&ops[0], offset, 4)
            )),
            F64Load { offset } => one(format!(
                "{prefix}f64_({prefix}le64_({}))",
                self.range(&ops[0], offset, 8)
            )),
            StringLift => one(self.view(body, &Type::U8, &ops[0], &ops[1])),
            ListCanonLift { element, .. } => one(self.view(body, element, &ops[0], &ops[1])),
            // A C host reads the elements of other lists through the view's
            // getter; the block that loads each is not needed.
            ListLift { element, .. } => {
                body.take();
                one(self.view(body, element, &ops[0], &ops[1]))
            }
            IterBasePointer => one(format!("base{}", body.depth())),
            IterElem { .. } => one(format!("(*e{})", body.depth())),
            RecordLift { record, ty, .. } => {
                let fields: Vec<String> = record
                    .fields
                    .iter()
                    .zip(ops)
                    .map(|(field, value)| format!(".{} = {value}", local(&field.name)))
                    .collect();
                one(format!(
                    "({}){{{}}}",
                    type_name(self.model, self.names, *ty),
                    fields.join(", ")
                ))
            }
            TupleLift { ty, .. } => {
                let name = self.c_type(&Type::Id(*ty));
                one(format!("({name}){{{}}}", ops.join(", ")))
            }
            CallInterface { func, .. } => {
                let mut args = vec!["instance".to_string()];
                args.extend(ops.iter().cloned());
                let call = format!("{prefix}{}({})", names::snake(&func.name), args.join(", "));
                match &func.result {
                    Some(ty) => {
                        let ty = self.c_type(ty);
                        let name = body.temp();
                        body.line(format!("{ty} {name} = {call};"));
                        one(name)
                    }
                    None => {
                        body.line(format!("{call};"));
                        Vec::new()
                    }
                }
            }
            Return { amt, .. } => {
                if *amt == 1 {
                    body.line(format!("return {};", ops[0]));
                }
                Vec::new()
            }

            // Lowering.
            I32FromBool => one(format!("{} ? 1u : 0u", x())),
            I32FromU8
            | I32FromU16
            | I32FromU32
            | I32FromChar
            | EnumLower { .. }
            | FlagsLower { .. } => one(format!("(uint32_t){}", x())),
            I32FromS8 | I32FromS16 | I32FromS32 => one(format!("(uint32_t)(int32_t){}", x())),
            I64FromS64 => one(format!("(uint64_t){}", x())),
            I64FromU64 | CoreF32FromF32 | CoreF64FromF64 => one(ops[0].clone()),
            RecordLower { record, .. } => record
                .fields
                .iter()
                .map(|field| format!("{}.{}", ops[0], local(&field.name)))
                .collect(),
            TupleLower { tuple, .. } => (0..tuple.types.len())
                .map(|index| format!("{}.f{index}", ops[0]))
                .collect(),
            StringLower { .. } => self.bytes(body, &ops[0]),
            ListCanonLower { element, .. } => {
                if matches!(element, Type::U8) {
                    return self.bytes(body, &ops[0]);
                }
                let value = &ops[0];
                let (size, align) = (
                    self.model.sizes.size(element),
                    self.model.sizes.align(element),
                );
                body.line(format!(
                    "if ({value}.len > UINT32_MAX / {size}) wasm_rt_trap(WASM_RT_TRAP_OOB);"
                ));
                let len = body.temp();
                body.line(format!("uint32_t {len} = (uint32_t){value}.len;"));
                let ptr = body.temp();
                body.line(format!(
                    "uint32_t {ptr} = {}(instance, {align}, {len} * {size});",
                    self.alloc
                ));
                let index = body.temp();
                let bits = match element {
                    Type::F32 => format!("{prefix}f32_bits_({value}.ptr[{index}])"),
                    Type::F64 => format!("{prefix}f64_bits_({value}.ptr[{index}])"),
                    _ => format!("(uint64_t){value}.ptr[{index}]"),
                };
                body.line(format!(
                    "for (uint32_t {index} = 0; {index} < {len}; ++{index}) {{"
                ));
                body.line(format!(
                    "  {prefix}put_({prefix}range_(memory, (uint64_t){ptr} + (uint64_t){index} * {size}, {size}), {bits}, {size});"
                ));
                body.line("}");
                vec![ptr, len]
            }
            ListLower { element, .. } => {
                let (lines, _) = body.take();
                let value = &ops[0];
                let (size, align) = (
                    self.model.sizes.size(element),
                    self.model.sizes.align(element),
                );
                let element_type = self.c_type(element);
                body.line(format!(
                    "if ({value}.len > UINT32_MAX / {size}) wasm_rt_trap(WASM_RT_TRAP_OOB);"
                ));
                let len = body.temp();
                body.line(format!("uint32_t {len} = (uint32_t){value}.len;"));
                let ptr = body.temp();
                body.line(format!(
                    "uint32_t {ptr} = {}(instance, {align}, {len} * {size});",
                    self.alloc
                ));
                body.line(format!(
                    "if ({len}) memset({prefix}range_(memory, {ptr}, (uint64_t){len} * {size}), 0, (size_t){len} * {size});"
                ));
                let depth = body.depth() + 1;
                body.line(format!(
                    "for (uint32_t i{depth} = 0; i{depth} < {len}; ++i{depth}) {{"
                ));
                body.line(format!(
                    "  const {element_type} *e{depth} = &{value}.ptr[i{depth}];"
                ));
                body.line(format!(
                    "  uint32_t base{depth} = {ptr} + i{depth} * {size};"
                ));
                body.lines(&lines, "  ");
                body.line("}");
                vec![ptr, len]
            }
            I32Store { offset } | PointerStore { offset } | LengthStore { offset } => {
                self.store(body, ops, offset, 4, ops[0].clone());
                Vec::new()
            }
            I32Store8 { offset } => {
                self.store(body, ops, offset, 1, ops[0].clone());
                Vec::new()
            }
            I32Store16 { offset } => {
                self.store(body, ops, offset, 2, ops[0].clone());
                Vec::new()
            }
            I64Store { offset } => {
                self.store(body, ops, offset, 8, ops[0].clone());
                Vec::new()
            }
            F32Store { offset } => {
                self.store(
                    body,
                    ops,
                    offset,
                    4,
                    format!("{prefix}f32_bits_({})", ops[0]),
                );
                Vec::new()
            }
            F64Store { offset } => {
                self.store(
                    body,
                    ops,
                    offset,
                    8,
                    format!("{prefix}f64_bits_({})", ops[0]),
                );
                Vec::new()
            }
            Flush { .. } => ops.to_vec(),
            _ => unreachable!("host bindings carry no values of this instruction's kind"),
        }
    }
}
