// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The component model's async conformance tests, linked and run.
//!
//! Each upstream WAST script is a series of components and assertions over
//! calls of their exports. For every component instance a script makes, a
//! driver component is generated that imports the exports the script calls
//! and makes those calls in order, comparing each result. The driver's own
//! export is an async function lifted synchronously, so a call that blocks
//! waits for its result as the script's host does. The instance and its
//! driver are linked into one core module, which WABT's interpreter runs.
//! A trap the script expects ends a run; the calls after it run against a
//! fresh instance, the canonical ABI poisoning a trapped one.
//!
//! The scripts that need what a static link cannot give (the thread
//! built-ins and stackful lifts, which switch stacks) are listed with the
//! reason, and must keep failing to link for it.

use std::fmt::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use wlink::types::{FuncType, ValType};

fn tests_dir() -> PathBuf {
    PathBuf::from(std::env::var("COMPONENT_MODEL_ASYNC_TESTS").expect("the tests' directory"))
}

fn interpreter() -> PathBuf {
    PathBuf::from(std::env::var("WASM_INTERP").expect("WABT's interpreter"))
}

/// A parsed s-expression, with the byte span it came from.
#[derive(Debug, Clone)]
enum Sexp {
    Atom(String),
    Str(String),
    List(Vec<Sexp>, std::ops::Range<usize>),
}

impl Sexp {
    fn atom(&self) -> Option<&str> {
        match self {
            Sexp::Atom(atom) => Some(atom),
            _ => None,
        }
    }

    fn list(&self) -> Option<&[Sexp]> {
        match self {
            Sexp::List(items, _) => Some(items),
            _ => None,
        }
    }

    fn head(&self) -> Option<&str> {
        self.list()?.first()?.atom()
    }
}

struct Parser<'a> {
    text: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn skip(&mut self) {
        loop {
            while self.at < self.text.len() && self.text[self.at].is_ascii_whitespace() {
                self.at += 1;
            }
            if self.text[self.at..].starts_with(b";;") {
                while self.at < self.text.len() && self.text[self.at] != b'\n' {
                    self.at += 1;
                }
            } else if self.text[self.at..].starts_with(b"(;") {
                let mut depth = 0;
                loop {
                    if self.text[self.at..].starts_with(b"(;") {
                        depth += 1;
                        self.at += 2;
                    } else if self.text[self.at..].starts_with(b";)") {
                        depth -= 1;
                        self.at += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        self.at += 1;
                    }
                }
            } else {
                return;
            }
        }
    }

    fn done(&mut self) -> bool {
        self.skip();
        self.at >= self.text.len()
    }

    fn sexp(&mut self) -> Sexp {
        self.skip();
        let start = self.at;
        match self.text[self.at] {
            b'(' => {
                self.at += 1;
                let mut items = Vec::new();
                loop {
                    self.skip();
                    if self.text[self.at] == b')' {
                        self.at += 1;
                        return Sexp::List(items, start..self.at);
                    }
                    items.push(self.sexp());
                }
            }
            b'"' => {
                self.at += 1;
                let mut out = String::new();
                while self.text[self.at] != b'"' {
                    if self.text[self.at] == b'\\' {
                        self.at += 1;
                    }
                    out.push(self.text[self.at] as char);
                    self.at += 1;
                }
                self.at += 1;
                Sexp::Str(out)
            }
            _ => {
                while self.at < self.text.len()
                    && !self.text[self.at].is_ascii_whitespace()
                    && !matches!(self.text[self.at], b'(' | b')')
                {
                    self.at += 1;
                }
                Sexp::Atom(String::from_utf8_lossy(&self.text[start..self.at]).into())
            }
        }
    }
}

/// A constant of the script: its type's name and its text.
#[derive(Debug, Clone)]
struct Const {
    ty: String,
    value: String,
}

impl Const {
    fn parse(sexp: &Sexp) -> Option<Const> {
        Const::parse_items(sexp.list()?)
    }

    fn parse_items(items: &[Sexp]) -> Option<Const> {
        let (ty, _) = items.first()?.atom()?.split_once(".const")?;
        Some(Const {
            ty: ty.to_string(),
            value: items.get(1)?.atom()?.to_string(),
        })
    }

    /// The core instruction pushing the constant.
    fn core(&self) -> Option<String> {
        Some(match self.ty.as_str() {
            "bool" => format!("(i32.const {})", (self.value == "true") as i32),
            "u8" | "s8" | "u16" | "s16" | "u32" | "s32" => format!("(i32.const {})", self.value),
            "u64" | "s64" => format!("(i64.const {})", self.value),
            "f32" => format!("(f32.const {})", self.value),
            "f64" => format!("(f64.const {})", self.value),
            "char" => format!("(i32.const {})", self.value.chars().next()? as u32),
            _ => return None,
        })
    }
}

/// An argument of a call: a constant, or a list, record, variant or enum
/// of them, which the driver lays out in its memory.
#[derive(Debug, Clone)]
enum Value {
    Scalar(Const),
    List(Vec<Value>),
    Record(Vec<(String, Value)>),
    Variant(String, Option<Box<Value>>),
    Enum(String),
}

impl Value {
    /// The value starting at `items[*at]`: a parenthesized constant, or, as
    /// a record's fields spell theirs, one without the parentheses.
    fn parse_from(items: &[Sexp], at: &mut usize) -> Option<Value> {
        match items.get(*at)? {
            Sexp::List(inner, _) => {
                *at += 1;
                Value::parse(inner)
            }
            Sexp::Atom(head) => {
                let (kind, _) = head.split_once(".const")?;
                *at += 2;
                Some(match (kind, items.get(*at - 1)?) {
                    ("enum", Sexp::Str(name)) => Value::Enum(name.clone()),
                    (_, Sexp::Atom(value)) => Value::Scalar(Const {
                        ty: kind.to_string(),
                        value: value.clone(),
                    }),
                    _ => return None,
                })
            }
            Sexp::Str(_) => None,
        }
    }

    fn parse(items: &[Sexp]) -> Option<Value> {
        let (kind, _) = items.first()?.atom()?.split_once(".const")?;
        let name = || match items.get(1) {
            Some(Sexp::Str(name)) => Some(name.clone()),
            _ => None,
        };
        Some(match kind {
            "list" => {
                let mut at = 1;
                let mut values = Vec::new();
                while at < items.len() {
                    values.push(Value::parse_from(items, &mut at)?);
                }
                Value::List(values)
            }
            "record" => Value::Record(
                items[1..]
                    .iter()
                    .map(|field| {
                        let field = field.list()?;
                        let Sexp::Str(name) = field.get(1)? else {
                            return None;
                        };
                        Some((name.clone(), Value::parse_from(field, &mut 2)?))
                    })
                    .collect::<Option<_>>()?,
            ),
            "variant" => Value::Variant(
                name()?,
                (items.len() > 2)
                    .then(|| Value::parse_from(items, &mut 2).map(Box::new))
                    .flatten(),
            ),
            "enum" => Value::Enum(name()?),
            _ => Value::Scalar(Const::parse_items(items)?),
        })
    }

    fn scalar(&self) -> Option<&Const> {
        match self {
            Value::Scalar(value) => Some(value),
            _ => None,
        }
    }
}

/// The driver's memory: what it holds from `DATA` on.
const DATA: usize = 1024;

/// Parses an integer constant as the scripts write it.
fn integer(text: &str) -> Option<i64> {
    let text = text.replace('_', "");
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest.to_string()),
        None => (false, text),
    };
    let magnitude = match digits.strip_prefix("0x") {
        Some(hex) => u64::from_str_radix(hex, 16).ok()? as i64,
        None => digits.parse::<u64>().ok()? as i64,
    };
    Some(if negative { -magnitude } else { magnitude })
}

/// Stores `value` of type `ty` at `at` in `memory`, as the canonical ABI's
/// `store` lays it out, its lists appended to `memory`.
fn store(value: &Value, ty: &ValType, memory: &mut Vec<u8>, at: usize) -> Option<()> {
    use wlink::types::{align_to, alignment, discriminant_size, size};
    let mut put = |memory: &mut Vec<u8>, at: usize, bytes: &[u8]| {
        memory[at..at + bytes.len()].copy_from_slice(bytes);
    };
    match (value, ty) {
        (Value::Scalar(constant), ty) => {
            let bytes: Vec<u8> = match ty {
                ValType::F32 => constant.value.parse::<f32>().ok()?.to_le_bytes().to_vec(),
                ValType::F64 => constant.value.parse::<f64>().ok()?.to_le_bytes().to_vec(),
                ValType::Bool => vec![(constant.value == "true") as u8],
                _ => integer(&constant.value)?.to_le_bytes()[..size(ty) as usize].to_vec(),
            };
            put(memory, at, &bytes);
        }
        (Value::List(values), ValType::List(element)) => {
            let stride = size(element) as usize;
            let start = align_to(memory.len() as u32, alignment(element).max(8)) as usize;
            memory.resize(start + stride * values.len(), 0);
            for (index, value) in values.iter().enumerate() {
                store(value, element, memory, start + index * stride)?;
            }
            put(memory, at, &((DATA + start) as u32).to_le_bytes());
            put(memory, at + 4, &(values.len() as u32).to_le_bytes());
        }
        (Value::Record(values), ValType::Record(fields)) => {
            let mut offset = at as u32;
            for (name, field) in fields {
                offset = align_to(offset, alignment(field));
                let (_, value) = values.iter().find(|(known, _)| known == name)?;
                store(value, field, memory, offset as usize)?;
                offset += size(field);
            }
        }
        (Value::Variant(name, payload), ValType::Variant(cases)) => {
            let index = cases.iter().position(|(case, _)| case == name)?;
            let discriminant = discriminant_size(cases.len()) as usize;
            put(memory, at, &(index as u32).to_le_bytes()[..discriminant]);
            if let (Some(payload), Some(case)) = (payload, &cases[index].1) {
                let align = cases
                    .iter()
                    .filter_map(|(_, case)| case.as_ref().map(alignment))
                    .max()
                    .unwrap_or(1);
                let offset = align_to(discriminant as u32, align) as usize;
                store(payload, case, memory, at + offset)?;
            }
        }
        (Value::Enum(name), ValType::Enum(names)) => {
            let index = names.iter().position(|known| known == name)?;
            let discriminant = discriminant_size(names.len()) as usize;
            put(memory, at, &(index as u32).to_le_bytes()[..discriminant]);
        }
        _ => return None,
    }
    Some(())
}

#[derive(Debug, Clone)]
enum Expect {
    Nothing,
    Return(Vec<Const>),
    Trap(String),
}

#[derive(Debug, Clone)]
struct Action {
    export: String,
    args: Vec<Value>,
    expect: Expect,
}

/// A run: one instance of a component, the calls made of it, and whether
/// instantiating it traps.
#[derive(Debug)]
struct Run {
    component: String,
    actions: Vec<Action>,
    instantiation_traps: bool,
    /// For a trapping instantiation, what the script says of the trap.
    trap_message: String,
    line: usize,
}

#[derive(Debug)]
enum Step {
    Run(Run),
    Invalid {
        component: String,
        line: usize,
    },
    /// A call of an instance that trapped: the canonical ABI refuses to
    /// enter it, and a linked program's instance is gone with its process.
    Poisoned,
}

fn line_of(text: &str, at: usize) -> usize {
    text[..at].matches('\n').count() + 1
}

/// The component text of a `(component ...)` or `(component definition
/// ...)` form, and the name it defines.
fn component_text(text: &str, sexp: &Sexp) -> (Option<String>, String) {
    let Sexp::List(items, span) = sexp else {
        unreachable!("a component is a list")
    };
    let mut source = text[span.clone()].to_string();
    let mut index = 1;
    if items.get(1).and_then(Sexp::atom) == Some("definition") {
        source = source.replacen("definition", "", 1);
        index = 2;
    }
    let name = items
        .get(index)
        .and_then(Sexp::atom)
        .filter(|atom| atom.starts_with('$'))
        .map(str::to_string);
    (name, source)
}

fn action(sexp: &Sexp) -> Option<(String, Vec<Value>)> {
    let items = sexp.list()?;
    if items.first()?.atom()? != "invoke" {
        return None;
    }
    let Sexp::Str(export) = items.get(1)? else {
        return None;
    };
    let mut at = 2;
    let mut args = Vec::new();
    while at < items.len() {
        args.push(Value::parse_from(items, &mut at)?);
    }
    Some((export.clone(), args))
}

/// Splits a script into runs.
fn steps(text: &str) -> Vec<Step> {
    let mut parser = Parser {
        text: text.as_bytes(),
        at: 0,
    };
    let mut definitions: Vec<(Option<String>, String)> = Vec::new();
    let mut steps: Vec<Step> = Vec::new();
    // The run the next calls go to, as an index into `steps`.
    let mut current: Option<usize> = None;
    let mut instantiate = |steps: &mut Vec<Step>, component: String, traps: bool, line| {
        steps.push(Step::Run(Run {
            component,
            actions: Vec::new(),
            instantiation_traps: traps,
            trap_message: String::new(),
            line,
        }));
        steps.len() - 1
    };
    while !parser.done() {
        let sexp = parser.sexp();
        let Sexp::List(items, span) = &sexp else {
            continue;
        };
        let line = line_of(text, span.start);
        let head = items.first().and_then(Sexp::atom).unwrap_or_default();
        let second = items.get(1).and_then(Sexp::atom);
        match (head, second) {
            ("component", Some("instance")) => {
                let def = items
                    .get(3)
                    .and_then(Sexp::atom)
                    .expect("an instance names its definition");
                let (_, source) = definitions
                    .iter()
                    .rev()
                    .find(|(name, _)| name.as_deref() == Some(def))
                    .expect("the definition precedes its instance")
                    .clone();
                current = Some(instantiate(&mut steps, source, false, line));
            }
            ("component", Some("definition")) => {
                definitions.push(component_text(text, &sexp));
            }
            ("component", _) => {
                let (name, source) = component_text(text, &sexp);
                definitions.push((name, source.clone()));
                current = Some(instantiate(&mut steps, source, false, line));
            }
            ("assert_invalid", _) => {
                let (_, source) = component_text(text, &items[1]);
                steps.push(Step::Invalid {
                    component: source,
                    line,
                });
            }
            ("assert_return" | "assert_trap" | "invoke", _) => {
                let (invoke, rest) = if head == "invoke" {
                    (&sexp, &items[0..0])
                } else {
                    (&items[1], &items[2..])
                };
                if head == "assert_trap" && invoke.head() == Some("component") {
                    // Instantiation itself traps: of a definition, or of a
                    // component written in place.
                    let inner = invoke.list().expect("a component form");
                    let source = if inner.get(1).and_then(Sexp::atom) == Some("instance") {
                        let def = inner[3].atom().expect("an instance names its definition");
                        definitions
                            .iter()
                            .rev()
                            .find(|(name, _)| name.as_deref() == Some(def))
                            .expect("the definition precedes its instance")
                            .1
                            .clone()
                    } else {
                        component_text(text, invoke).1
                    };
                    let message = match &rest[0] {
                        Sexp::Str(message) => message.clone(),
                        _ => String::new(),
                    };
                    let index = instantiate(&mut steps, source, true, line);
                    if let Step::Run(run) = &mut steps[index] {
                        run.trap_message = message;
                    }
                    current = None;
                    continue;
                }
                let (export, args) = action(invoke).expect("an invoke of an export");
                let expect = match head {
                    "assert_return" => Expect::Return(
                        rest.iter()
                            .map(|sexp| Const::parse(sexp).expect("a constant result"))
                            .collect(),
                    ),
                    "assert_trap" => Expect::Trap(match &rest[0] {
                        Sexp::Str(message) => message.clone(),
                        _ => String::new(),
                    }),
                    _ => Expect::Nothing,
                };
                let index = current.expect("a call follows an instance");
                if let Expect::Trap(message) = &expect {
                    if message.contains("cannot enter component instance") {
                        steps.push(Step::Poisoned);
                        continue;
                    }
                }
                let trapped = matches!(
                    &steps[index],
                    Step::Run(run) if run.actions.last().is_some_and(|last| matches!(last.expect, Expect::Trap(_)))
                );
                let index = if trapped {
                    // The trapped instance is poisoned; later calls go to a
                    // fresh one.
                    let Step::Run(run) = &steps[index] else {
                        unreachable!()
                    };
                    let component = run.component.clone();
                    let fresh = instantiate(&mut steps, component, false, line);
                    current = Some(fresh);
                    fresh
                } else {
                    index
                };
                let Step::Run(run) = &mut steps[index] else {
                    unreachable!()
                };
                run.actions.push(Action {
                    export,
                    args,
                    expect,
                });
            }
            (other, _) => panic!("unexpected script form `{other}` at line {line}"),
        }
    }
    steps
}

/// The component text of a value type the driver can pass.
fn type_text(ty: &ValType) -> Option<String> {
    let optional = |ty: &Option<Box<ValType>>| -> Option<String> {
        Some(match ty {
            Some(ty) => format!(" {}", type_text(ty)?),
            None => String::new(),
        })
    };
    Some(match ty {
        ValType::Stream(element) => format!("(stream{})", optional(element)?),
        ValType::Future(element) => format!("(future{})", optional(element)?),
        ValType::String => "string".into(),
        ValType::List(element) => format!("(list {})", type_text(element)?),
        ValType::Option(element) => format!("(option {})", type_text(element)?),
        ValType::Record(fields) => {
            let mut text = "(record".to_string();
            for (name, field) in fields {
                text += &format!(" (field \"{name}\" {})", type_text(field)?);
            }
            text + ")"
        }
        ValType::Tuple(items) => {
            let mut text = "(tuple".to_string();
            for item in items {
                text += &format!(" {}", type_text(item)?);
            }
            text + ")"
        }
        ValType::Variant(cases) => {
            let mut text = "(variant".to_string();
            for (name, case) in cases {
                let payload = match case {
                    Some(case) => format!(" {}", type_text(case)?),
                    None => String::new(),
                };
                text += &format!(" (case \"{name}\"{payload})");
            }
            text + ")"
        }
        ValType::Enum(names) | ValType::Flags(names) => {
            let kind = if matches!(ty, ValType::Enum(_)) {
                "enum"
            } else {
                "flags"
            };
            let names: Vec<String> = names.iter().map(|name| format!("\"{name}\"")).collect();
            format!("({kind} {})", names.join(" "))
        }
        ValType::Result { ok, err } => {
            let ok = optional(ok)?;
            let err = match err {
                Some(err) => format!(" (error {})", type_text(err)?),
                None => String::new(),
            };
            format!("(result{ok}{err})")
        }
        ValType::Own(_) | ValType::Borrow(_) => return None,
        other => scalar_text(other)?.into(),
    })
}

fn core_name(ty: wlink::types::CoreType) -> &'static str {
    match ty {
        wlink::types::CoreType::I32 => "i32",
        wlink::types::CoreType::I64 => "i64",
        wlink::types::CoreType::F32 => "f32",
        wlink::types::CoreType::F64 => "f64",
    }
}

fn scalar_text(ty: &ValType) -> Option<&'static str> {
    Some(match ty {
        ValType::Bool => "bool",
        ValType::U8 => "u8",
        ValType::S8 => "s8",
        ValType::U16 => "u16",
        ValType::S16 => "s16",
        ValType::U32 => "u32",
        ValType::S32 => "s32",
        ValType::U64 => "u64",
        ValType::S64 => "s64",
        ValType::F32 => "f32",
        ValType::F64 => "f64",
        ValType::Char => "char",
        _ => return None,
    })
}

fn core_text(ty: &ValType) -> &'static str {
    match ty {
        ValType::U64 | ValType::S64 => "i64",
        ValType::F32 => "f32",
        ValType::F64 => "f64",
        _ => "i32",
    }
}

/// A driver making `actions` of the instance whose exports have `types`,
/// returning 0 when every call behaved, the failing call's number plus one
/// when one did not, or 1000 plus the number of a call that should have
/// trapped and did not.
fn driver(actions: &[Action], types: &[(String, FuncType)]) -> Result<String, String> {
    let mut imports = String::new();
    let mut core_imports = String::new();
    let mut lowers = String::new();
    let mut with = String::new();
    let mut body = String::new();
    // What the calls' lists hold, from `DATA` in the driver's memory.
    let mut data: Vec<u8> = Vec::new();
    // Every export the driver can type is imported, so none is left for the
    // host, which cannot take streams and futures.
    let mut used: Vec<&str> = Vec::new();
    for (export, ty) in types {
        let params: Option<Vec<String>> = ty
            .params
            .iter()
            .map(|(name, param)| Some(format!(" (param \"{name}\" {})", type_text(param)?)))
            .collect();
        let result = match &ty.result {
            Some(result) => type_text(result).map(|text| format!(" (result {text})")),
            None => Some(String::new()),
        };
        let (Some(params), Some(result)) = (params, result) else {
            continue;
        };
        used.push(export);
        let index = used.len() - 1;
        let signature = wlink::types::lower_signature(ty);
        let core_params: String = signature
            .params
            .iter()
            .map(|ty| format!(" (param {})", core_name(*ty)))
            .collect();
        let core_result: String = signature
            .results
            .iter()
            .map(|ty| format!(" (result {})", core_name(*ty)))
            .collect();
        let effect = if ty.async_ { " async" } else { "" };
        let params = params.concat();
        let _ = writeln!(
            imports,
            "  (import \"{export}\" (func $f{index}{effect}{params}{result}))"
        );
        let _ = writeln!(
            core_imports,
            "    (import \"\" \"f{index}\" (func $f{index}{core_params}{core_result}))"
        );
        let _ = writeln!(
            lowers,
            "  (core func $l{index} (canon lower (func $f{index}) (memory (core memory $mem \"mem\")) (realloc (core func $mem \"realloc\"))))"
        );
        let _ = write!(with, " (export \"f{index}\" (func $l{index}))");
    }
    for (number, action) in actions.iter().enumerate() {
        let (_, ty) = types
            .iter()
            .find(|(name, _)| *name == action.export)
            .ok_or_else(|| format!("the instance exports no `{}`", action.export))?;
        let index = used
            .iter()
            .position(|name| *name == action.export)
            .ok_or_else(|| format!("`{}` has a type the driver cannot pass", action.export))?;
        let signature = wlink::types::lower_signature(ty);
        let flat: usize = ty
            .params
            .iter()
            .map(|(_, param)| wlink::types::flat_types(param).len())
            .sum();
        if flat > wlink::types::MAX_FLAT_PARAMS {
            return Err(format!("`{}` spills its parameters", action.export));
        }
        let mut call = format!("(call $f{index}");
        for ((_, param), arg) in ty.params.iter().zip(&action.args) {
            match (param, arg) {
                (ValType::List(_), Value::List(_)) => {
                    // The list's pointer and length, stored where the data
                    // area puts them.
                    let slot = wlink::types::align_to(data.len() as u32, 8) as usize;
                    data.resize(slot + 8, 0);
                    store(arg, param, &mut data, slot).ok_or("a list argument")?;
                    let pointer = u32::from_le_bytes(data[slot..slot + 4].try_into().unwrap());
                    let length = u32::from_le_bytes(data[slot + 4..slot + 8].try_into().unwrap());
                    let _ = write!(call, " (i32.const {pointer}) (i32.const {length})");
                }
                (_, Value::Scalar(constant)) => {
                    let _ = write!(call, " {}", constant.core().ok_or("an argument")?);
                }
                _ => return Err(format!("an argument of {param}")),
            }
        }
        // A result through memory lands in the scratch area below the data.
        if signature.params.len() > flat {
            call.push_str(" (i32.const 512)");
        }
        call.push(')');
        let returns = !signature.results.is_empty();
        match &action.expect {
            Expect::Return(results) if !results.is_empty() => {
                let result = &results[0];
                let ne = match signature.results.first().map(|ty| core_name(*ty)) {
                    Some("i64") => "i64.ne",
                    Some("f32") => "f32.ne",
                    Some("f64") => "f64.ne",
                    Some(_) => "i32.ne",
                    None => {
                        return Err(format!(
                            "`{}` returns what the driver cannot compare",
                            action.export
                        ));
                    }
                };
                let _ = writeln!(
                    body,
                    "      (if ({ne} {call} {}) (then (return (i32.const {}))))",
                    result.core().ok_or("a result")?,
                    number + 1
                );
            }
            Expect::Trap(_) => {
                let call = if returns {
                    format!("(drop {call})")
                } else {
                    call
                };
                let _ = writeln!(
                    body,
                    "      {call}\n      (return (i32.const {}))",
                    1000 + number + 1
                );
            }
            _ => {
                let call = if returns {
                    format!("(drop {call})")
                } else {
                    call
                };
                let _ = writeln!(body, "      {call}");
            }
        }
    }
    let bytes: String = data.iter().map(|byte| format!("\\{byte:02x}")).collect();
    let pages = (DATA + data.len()).div_ceil(65536) + 1;
    Ok(format!(
        "(component\n{imports}  (core module $Mem\n    (memory (export \"mem\") {pages})\n    (global $heap (mut i32) (i32.const {heap}))\n    (func (export \"realloc\") (param i32 i32 i32 i32) (result i32)\n      (local $at i32)\n      (local.set $at (i32.and (i32.add (global.get $heap) (i32.const 7)) (i32.const -8)))\n      (global.set $heap (i32.add (local.get $at) (local.get 3)))\n      (local.get $at))\n    (data (i32.const {DATA}) \"{bytes}\"))\n  (core instance $mem (instantiate $Mem))\n  (core module $M\n{core_imports}    (func (export \"drive\") (result i32)\n{body}      (i32.const 0)))\n{lowers}  (core instance $m (instantiate $M (with \"\" (instance{with}))))\n  (func (export \"wlink-drive\") async (result u32) (canon lift (core func $m \"drive\")))\n)\n",
        heap = DATA + data.len() + 64,
    ))
}

/// How a run ended: the driver's return value, or a trap with the
/// runtime's code for it (0 for a trap of the components' own).
#[derive(Debug, PartialEq, Eq)]
enum Ending {
    Returned(i64),
    Trapped(i64),
}

fn interpret(path: &Path, export: &str, trace: bool) -> Result<std::process::Child, String> {
    let mut command = Command::new(interpreter());
    command
        .arg("--enable-all")
        .arg(format!("--run-export={export}"))
        .arg(path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if trace {
        command.arg("--trace");
    }
    command.spawn().map_err(|error| error.to_string())
}

/// The global the runtime keeps its trap code in, from the module's
/// `wlink:async:trap` export.
fn trap_global(module: &[u8]) -> Option<u32> {
    for payload in wasmparser::Parser::new(0).parse_all(module) {
        if let Ok(wasmparser::Payload::ExportSection(reader)) = payload {
            for export in reader.into_iter().flatten() {
                if export.name == "wlink:async:trap" {
                    return Some(export.index);
                }
            }
        }
    }
    None
}

/// Runs the export again under the interpreter's trace, to find the code
/// the runtime set before it trapped: the last value stored to its trap
/// global.
fn trap_code(module: &[u8], path: &Path, export: &str) -> Result<i64, String> {
    use std::io::BufRead;
    let Some(global) = trap_global(module) else {
        return Ok(0);
    };
    let needle = format!("global.set ${global}, ");
    let mut child = interpret(path, export, true)?;
    let stdout = child.stdout.take().expect("piped");
    let mut code = 0;
    for line in std::io::BufReader::new(stdout).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if let Some((_, value)) = line.split_once(&needle) {
            code = value.trim().parse().unwrap_or(-1);
        }
    }
    let _ = child.wait();
    Ok(code)
}

/// The module with its start function exported as `wlink-start` rather
/// than run at instantiation, which the interpreter's trace leaves out.
fn export_start(module: &[u8]) -> Result<Vec<u8>, String> {
    let mut start = None;
    for payload in wasmparser::Parser::new(0).parse_all(module) {
        if let Ok(wasmparser::Payload::StartSection { func, .. }) = payload {
            start = Some(func);
        }
    }
    let start = start.ok_or("the module has no start function")?;
    let mut out = wasm_encoder::Module::new();
    for payload in wasmparser::Parser::new(0).parse_all(module) {
        let payload = payload.map_err(|error| error.to_string())?;
        match &payload {
            wasmparser::Payload::StartSection { .. } => {}
            wasmparser::Payload::ExportSection(reader) => {
                let mut exports = wasm_encoder::ExportSection::new();
                for export in reader.clone() {
                    let export = export.map_err(|error| error.to_string())?;
                    let kind = match export.kind {
                        wasmparser::ExternalKind::Func => wasm_encoder::ExportKind::Func,
                        wasmparser::ExternalKind::Memory => wasm_encoder::ExportKind::Memory,
                        wasmparser::ExternalKind::Global => wasm_encoder::ExportKind::Global,
                        wasmparser::ExternalKind::Table => wasm_encoder::ExportKind::Table,
                        _ => wasm_encoder::ExportKind::Tag,
                    };
                    exports.export(export.name, kind, export.index);
                }
                exports.export("wlink-start", wasm_encoder::ExportKind::Func, start);
                out.section(&exports);
            }
            _ => {
                if let Some((id, range)) = payload.as_section() {
                    out.section(&wasm_encoder::RawSection {
                        id,
                        data: &module[range.start as usize..range.end as usize],
                    });
                }
            }
        }
    }
    Ok(out.finish())
}

/// Runs the linked module's export.
fn run(module: &[u8], scratch: &Path, export: &str) -> Result<Ending, String> {
    let path = scratch.join("linked.wasm");
    std::fs::write(&path, module).map_err(|error| error.to_string())?;
    let mut child = interpret(&path, export, false)?;
    // A scheduler that livelocks runs until killed.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("the run did not finish in 10 seconds".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if let Some(value) = stdout
        .lines()
        .find_map(|line| line.split_once("=> i32:").map(|(_, value)| value.trim()))
    {
        return value
            .parse()
            .map(Ending::Returned)
            .map_err(|_| format!("odd output {stdout}"));
    }
    if stdout.contains("error") || stderr.contains("error") {
        return trap_code(module, &path, export).map(Ending::Trapped);
    }
    // Instantiation finished, and the interpreter found no such export.
    Ok(Ending::Returned(-1))
}

/// The runtime's trap code for a trap the script names by the reference
/// implementation's message; `None` for a message this table lacks.
fn expected_code(message: &str) -> Option<i64> {
    const CODES: &[(&str, i64)] = &[
        ("deadlock detected", 1),
        ("cannot block a synchronous task", 2),
        ("used with the wrong type", 3),
        ("unknown handle index", 3),
        (
            "`task.cancel` called by task which has not been cancelled",
            4,
        ),
        ("borrow handles still remain", 5),
        ("unsupported callback code", 7),
        ("cannot drop waitable set with waiters", 8),
        ("cannot drop a subtask which has not yet resolved", 9),
        ("after being notified that", 10),
        ("after previous", 10),
        ("cannot drop busy", 10),
        ("cannot remove busy", 10),
        ("cannot drop future write end", 10),
        ("cannot have concurrent operations", 10),
        ("intra-component", 12),
        ("while added to a waitable set", 14),
        ("while it's in a waitable set", 14),
        ("cannot resume thread", 19),
        ("unreachable", 0),
    ];
    CODES
        .iter()
        .find(|(needle, _)| message.contains(needle))
        .map(|(_, code)| *code)
}

/// What one script did: the calls that behaved, and each failure.
#[derive(Default, Debug)]
struct Outcome {
    passed: usize,
    failures: Vec<String>,
}

fn run_script(name: &str) -> Outcome {
    let text = std::fs::read_to_string(tests_dir().join(name)).expect("the script");
    let scratch =
        std::env::temp_dir().join(format!("wlink-conformance-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).expect("a scratch directory");
    let mut outcome = Outcome::default();
    for step in steps(&text) {
        match step {
            Step::Poisoned => outcome.passed += 1,
            Step::Invalid { component, line } => {
                let input = wlink::Input {
                    name: "invalid".into(),
                    bytes: component.into_bytes(),
                };
                match wlink::link(&[input]) {
                    Err(_) => outcome.passed += 1,
                    Ok(_) => outcome
                        .failures
                        .push(format!("line {line}: an invalid component linked")),
                }
            }
            Step::Run(run_step) => {
                let component = wlink::Input {
                    name: "tested".into(),
                    bytes: run_step.component.clone().into_bytes(),
                };
                let line = run_step.line;
                let plan = wlink::component::parse_source(&component.bytes)
                    .and_then(|decoded| wlink::plan::link(&[("tested".to_string(), decoded)]));
                let plan = match plan {
                    Ok(plan) => plan,
                    Err(error) => {
                        outcome
                            .failures
                            .push(format!("line {line}: linking failed: {error:#}"));
                        continue;
                    }
                };
                if run_step.instantiation_traps {
                    let alone = match wlink::link(std::slice::from_ref(&component)) {
                        Ok(linked) => linked,
                        Err(error) => {
                            outcome
                                .failures
                                .push(format!("line {line}: linking failed: {error:#}"));
                            continue;
                        }
                    };
                    // No export runs: the module's start must trap.
                    let expected = expected_code(&run_step.trap_message);
                    let module = match export_start(&alone.module) {
                        Ok(module) => module,
                        Err(error) => {
                            outcome.failures.push(format!("line {line}: {error}"));
                            continue;
                        }
                    };
                    match run(&module, &scratch, "wlink-start") {
                        Ok(Ending::Trapped(code)) if Some(code) == expected => outcome.passed += 1,
                        other => outcome.failures.push(format!(
                            "line {line}: instantiation should trap with {expected:?}, got {other:?}"
                        )),
                    }
                    continue;
                }
                let types: Vec<(String, FuncType)> = plan
                    .exports
                    .iter()
                    .map(|export| (export.name.clone(), export.ty.clone()))
                    .collect();
                let driver = match driver(&run_step.actions, &types) {
                    Ok(driver) => driver,
                    Err(error) => {
                        outcome
                            .failures
                            .push(format!("line {line}: no driver: {error}"));
                        continue;
                    }
                };
                let inputs = [
                    component,
                    wlink::Input {
                        name: "driver".into(),
                        bytes: driver.clone().into_bytes(),
                    },
                ];
                let linked = match wlink::link(&inputs) {
                    Ok(linked) => linked,
                    Err(error) => {
                        outcome.failures.push(format!(
                            "line {line}: linking the driver failed: {error:#}\n{driver}"
                        ));
                        continue;
                    }
                };
                let expects_trap = run_step
                    .actions
                    .last()
                    .is_some_and(|action| matches!(action.expect, Expect::Trap(_)));
                let calls = run_step.actions.len();
                // For debugging a failure: keep every linked module.
                if let Ok(keep) = std::env::var("WLINK_CONFORMANCE_KEEP") {
                    let path = Path::new(&keep).join(format!("{name}-{line}.wasm"));
                    let _ = std::fs::create_dir_all(&keep);
                    let _ = std::fs::write(&path, &linked.module);
                    let _ = std::fs::write(path.with_extension("driver.wat"), &driver);
                }
                let expected = match run_step.actions.last().map(|action| &action.expect) {
                    Some(Expect::Trap(message)) => Some(expected_code(message)),
                    _ => None,
                };
                match (run(&linked.module, &scratch, "wlink-drive"), expected) {
                    (Ok(Ending::Returned(0)), None) => outcome.passed += calls,
                    (Ok(Ending::Trapped(code)), Some(Some(expected))) if code == expected => {
                        outcome.passed += calls
                    }
                    (Ok(Ending::Trapped(code)), Some(expected)) => outcome.failures.push(format!(
                        "line {line}: trapped with code {code} where {expected:?} was expected"
                    )),
                    (Ok(Ending::Returned(code)), _) if code > 1000 => {
                        outcome.failures.push(format!(
                            "line {line}: call {} of `{}` did not trap",
                            code - 1000,
                            run_step.actions[(code - 1001) as usize].export
                        ))
                    }
                    (Ok(Ending::Returned(code)), _) if code > 0 => outcome.failures.push(format!(
                        "line {line}: call {code} of `{}` returned the wrong value",
                        run_step.actions[(code - 1) as usize].export
                    )),
                    (Ok(Ending::Returned(_)), _) => outcome
                        .failures
                        .push(format!("line {line}: the expected trap did not happen")),
                    (Ok(Ending::Trapped(code)), None) => outcome.failures.push(format!(
                        "line {line}: trapped with code {code} among {:?}",
                        run_step
                            .actions
                            .iter()
                            .map(|action| action.export.as_str())
                            .collect::<Vec<_>>()
                    )),
                    (Err(error), _) => outcome.failures.push(format!("line {line}: {error}")),
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&scratch);
    outcome
}

/// Why a script's call cannot behave as the reference implementation's in
/// a static link.
#[derive(Clone, Copy, Debug)]
enum Limit {
    /// It uses a thread built-in, which traps: cooperative threads need
    /// stack switching.
    Threads,
    /// A callee an async call started blocks synchronously (a synchronous
    /// or stackful lift, or a synchronous built-in) until its own caller
    /// acts. The canonical ABI returns to that caller; a wait nested on
    /// the native stack cannot, and finds nothing else to run: a deadlock.
    Nested,
    /// The same, with a callee that yields instead of waiting: it spins.
    Spins,
    /// Its text uses `stream.forward`, which the pinned text parser
    /// predates.
    Forward,
}

impl Limit {
    /// What the run's failure says for this reason.
    fn failure(self) -> &'static str {
        match self {
            Limit::Threads => "with code 19 ",
            Limit::Nested => "with code 1 ",
            Limit::Spins => "did not finish",
            Limit::Forward => "failed to assemble component text",
        }
    }
}

/// Runs `name`, whose runs must all pass except those at the lines
/// `limits` lists, which must fail for their reason.
fn limited(name: &str, limits: &[(usize, Limit)]) {
    let outcome = run_script(name);
    assert!(
        outcome.passed > 0 || !outcome.failures.is_empty(),
        "{name} checked nothing"
    );
    let mut unexplained = Vec::new();
    for failure in &outcome.failures {
        let line: usize = failure
            .strip_prefix("line ")
            .and_then(|rest| rest.split_once(':'))
            .and_then(|(line, _)| line.parse().ok())
            .expect("a failure names its line");
        match limits.iter().find(|(known, _)| *known == line) {
            Some((_, limit)) if failure.contains(limit.failure()) => {}
            _ => unexplained.push(failure.as_str()),
        }
    }
    let failed_lines: Vec<&str> = outcome.failures.iter().map(String::as_str).collect();
    let passing: Vec<usize> = limits
        .iter()
        .map(|(line, _)| *line)
        .filter(|line| {
            !failed_lines
                .iter()
                .any(|failure| failure.starts_with(&format!("line {line}:")))
        })
        .collect();
    assert!(
        unexplained.is_empty() && passing.is_empty(),
        "{name}: {} passed; unexplained failures:\n{}\nlisted as limited but passing: {passing:?}",
        outcome.passed,
        unexplained.join("\n"),
    );
}

/// One test per script: its limits, if any.
macro_rules! conformance {
    ($($test:ident: $name:literal => $limits:expr;)*) => {
        $(
            #[test]
            fn $test() {
                limited($name, $limits)
            }
        )*
    };
}

conformance! {
    async_calls_sync: "async-calls-sync.wast" => &[(12, Limit::Spins)];
    big_interleaving_test: "big-interleaving-test.wast" => &[893, 912, 982, 1476, 1485, 1507, 1516, 1661, 1669, 1724].map(|line| (line, Limit::Forward));
    builtin_trap_poisons_instance: "builtin-trap-poisons-instance.wast" => &[];
    cancel_and_exclusive_lock: "cancel-and-exclusive-lock.wast" => &[(10, Limit::Nested)];
    cancel_delivery: "cancel-delivery.wast" => &[(4, Limit::Nested), (382, Limit::Nested)];
    cancel_not_delivered: "cancel-not-delivered.wast" => &[(3, Limit::Nested)];
    cancel_resumed_callback_switch: "cancel-resumed-callback-switch.wast" => &[(10, Limit::Threads), (155, Limit::Threads)];
    cancel_stream: "cancel-stream.wast" => &[];
    cancel_subtask: "cancel-subtask.wast" => &[(8, Limit::Nested)];
    cancel_targeted_resume: "cancel-targeted-resume.wast" => &[(11, Limit::Threads), (106, Limit::Nested), (285, Limit::Nested), (613, Limit::Threads)];
    closed_stream: "closed-stream.wast" => &[];
    cross_abi_calls: "cross-abi-calls.wast" => &[];
    cross_task_future: "cross-task-future.wast" => &[];
    deadlock: "deadlock.wast" => &[];
    dont_block_start: "dont-block-start.wast" => &[];
    drop_cross_task_borrow: "drop-cross-task-borrow.wast" => &[];
    drop_stream: "drop-stream.wast" => &[];
    drop_subtask: "drop-subtask.wast" => &[];
    drop_waitable_set: "drop-waitable-set.wast" => &[];
    during_sync_call_exclusive_resume: "during-sync-call-exclusive-resume.wast" => &[(9, Limit::Threads), (65, Limit::Threads)];
    during_sync_call_may_block_if_other_ready_threads: "during-sync-call-may-block-if-other-ready-threads.wast" => &[(110, Limit::Threads), (114, Limit::Threads), (136, Limit::Threads)];
    during_sync_call_no_sibling_resume: "during-sync-call-no-sibling-resume.wast" => &[(16, Limit::Threads), (162, Limit::Threads)];
    during_sync_scheduling_candidates: "during-sync-scheduling-candidates.wast" => &[19, 78, 144, 303, 307, 403, 407, 414].map(|line| (line, Limit::Threads));
    empty_wait: "empty-wait.wast" => &[];
    forward: "forward.wast" => &[938, 940, 942, 944, 946, 948, 950, 952, 954, 956, 958, 960, 962, 964, 966, 968, 970, 972, 974, 976, 978, 980, 982, 984, 986, 988, 990, 992, 994, 996, 998, 1000, 1002, 1004, 1006, 1008, 1010, 1012, 1014, 1016, 1018, 1185, 1187, 1189, 1440].map(|line| (line, Limit::Forward));
    future_completion_order: "future-completion-order.wast" => &[];
    futures_must_write: "futures-must-write.wast" => &[];
    idle_drop: "idle-drop.wast" => &[];
    partial_stream_copies: "partial-stream-copies.wast" => &[];
    passing_resources: "passing-resources.wast" => &[];
    reentrance: "reentrance.wast" => &[(530, Limit::Threads), (674, Limit::Threads)];
    same_component_stream_future: "same-component-stream-future.wast" => &[];
    self_switch_traps: "self-switch-traps.wast" => &[];
    switch_to_ready_callback: "switch-to-ready-callback.wast" => &[(358, Limit::Threads), (360, Limit::Threads), (366, Limit::Threads), (368, Limit::Threads)];
    sync_barges_in: "sync-barges-in.wast" => &[(322, Limit::Nested)];
    sync_streams: "sync-streams.wast" => &[(7, Limit::Nested)];
    trap_if_block_and_sync: "trap-if-block-and-sync.wast" => &[(321, Limit::Threads), (337, Limit::Threads), (339, Limit::Threads), (341, Limit::Threads), (343, Limit::Threads), (345, Limit::Threads), (347, Limit::Threads), (349, Limit::Threads), (351, Limit::Nested)];
    trap_if_done: "trap-if-done.wast" => &[];
    trap_if_sync_and_waitable_set: "trap-if-sync-and-waitable-set.wast" => &[(300, Limit::Threads), (302, Limit::Threads), (304, Limit::Threads), (306, Limit::Threads)];
    trap_if_transfer_in_waitable_set: "trap-if-transfer-in-waitable-set.wast" => &[];
    validate_no_async_abi_for_sync_type: "validate-no-async-abi-for-sync-type.wast" => &[];
    validate_no_stream_char: "validate-no-stream-char.wast" => &[];
    wait_during_callback: "wait-during-callback.wast" => &[];
    zero_length: "zero-length.wast" => &[];
}
