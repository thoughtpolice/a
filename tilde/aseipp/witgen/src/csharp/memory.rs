// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The canonical ABI through linear memory: glue for the functions whose
//! values do not all fit the flat parameters and result, or are variants,
//! whose flat payloads join (see `join`). Strings and lists
//! are (pointer, length) pairs into the module's boundary memory, strings
//! in UTF-8; what does not fit the sixteen flat parameters or the one flat
//! result goes through memory as a tuple. The generated C# copies between
//! that memory and GC objects with gameplayc's Gameplay.Runtime.Canonical
//! helpers, and carries `[Gameplay.CanonicalAbi]`, the only code allowed to.

use wit_parser::Type;
use wit_parser::abi::WasmType;

/// A value's type, as the glue lowers and lifts it.
#[derive(Clone, Debug)]
pub(crate) enum Ty {
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
    /// A Unicode scalar value, as an int.
    Char,
    /// A C# enum from a WIT enum (`flags` false) or flags; `size` is its
    /// discriminant's bytes in memory.
    Enum {
        path: String,
        size: usize,
        flags: bool,
    },
    /// A resource handle, owned or borrowed; one of a resource the world
    /// exports (`exported`) is the module's own object.
    Handle {
        class: String,
        owned: bool,
        exported: bool,
    },
    /// The readable end of a future (`stream` false) or stream: the
    /// CoreLib's `FutureReader<T>` or `StreamReader<T>`, over the ops class
    /// witgen generates for its payload (`ops`, an expression).
    Channel {
        stream: bool,
        payload: Box<Ty>,
        ops: String,
    },
    Record {
        path: String,
        fields: Vec<(String, Ty)>,
    },
    /// A tuple: the world's `TupleN<...>` struct.
    Tuple(Vec<Ty>),
    String,
    /// A list: a C# array.
    List(Box<Ty>),
    /// An option: null when the payload is a reference, else the world's
    /// `Option<T>` struct.
    Option(Box<Ty>),
    /// A variant with payloads, or a result: a C# 15 union of one class per
    /// case, holding the payload as its `Value`.
    Variant {
        path: String,
        cases: Vec<Case>,
        /// The discriminant's bytes in memory.
        size: usize,
    },
}

/// One case of a variant or result.
#[derive(Clone, Debug)]
pub(crate) struct Case {
    /// The C# class of the case.
    pub(crate) class: String,
    pub(crate) payload: Option<Ty>,
    /// A result's case without a payload, whose class still holds one:
    /// `Unit`, null.
    pub(crate) unit: bool,
}

use crate::abi::{Sizes, join};

/// Whether a flat type is 64 bits wide in C#.
fn wide(ty: WasmType) -> bool {
    matches!(ty, WasmType::I64 | WasmType::F64 | WasmType::PointerOrI64)
}

/// A flat value of type `from` as the joined type `to`: widened (unsigned)
/// or its float bits, as the canonical ABI lowers a variant's payload.
fn widen(expression: &str, from: WasmType, to: WasmType) -> String {
    let memory = "global::Gameplay.Runtime.Memory";
    let bits = match from {
        WasmType::F32 if !matches!(to, WasmType::F32) => format!("{memory}.F32Bits({expression})"),
        WasmType::F64 if !matches!(to, WasmType::F64) => format!("{memory}.F64Bits({expression})"),
        _ => expression.to_string(),
    };
    if wide(to) && !wide(from) {
        format!("(long)unchecked((uint)({bits}))")
    } else {
        bits
    }
}

/// A joined flat value back as the case's type `to`.
fn narrow(expression: &str, from: WasmType, to: WasmType) -> String {
    let memory = "global::Gameplay.Runtime.Memory";
    let value = if wide(from) && !wide(to) {
        format!("unchecked((int){expression})")
    } else {
        expression.to_string()
    };
    match to {
        WasmType::F32 if !matches!(from, WasmType::F32) => format!("{memory}.F32FromBits({value})"),
        WasmType::F64 if !matches!(from, WasmType::F64) => format!("{memory}.F64FromBits({value})"),
        _ => value,
    }
}

/// A case's payload, joined into the variant's flat payload types.
fn joined_payload(cases: &[Case]) -> Vec<WasmType> {
    let mut joined: Vec<WasmType> = Vec::new();
    for case in cases {
        let mut flat = Vec::new();
        if let Some(payload) = &case.payload {
            payload.flat(&mut flat);
        }
        for (index, ty) in flat.into_iter().enumerate() {
            if index < joined.len() {
                joined[index] = join(joined[index], ty);
            } else {
                joined.push(ty);
            }
        }
    }
    joined
}

impl Ty {
    /// Whether the C# value is a reference, so `null` can stand for `none`.
    fn is_reference(&self) -> bool {
        matches!(
            self,
            Ty::Handle { .. } | Ty::Channel { .. } | Ty::Record { .. } | Ty::String | Ty::List(_)
        )
    }

    /// Whether a handle of an exported resource is in the value.
    pub(crate) fn has_exported_handle(&self) -> bool {
        match self {
            Ty::Handle { exported, .. } => *exported,
            Ty::Channel { payload, .. } | Ty::List(payload) | Ty::Option(payload) => {
                payload.has_exported_handle()
            }
            Ty::Record { fields, .. } => {
                fields.iter().any(|(_, field)| field.has_exported_handle())
            }
            Ty::Tuple(items) => items.iter().any(Ty::has_exported_handle),
            Ty::Variant { cases, .. } => cases
                .iter()
                .any(|case| case.payload.as_ref().is_some_and(Ty::has_exported_handle)),
            _ => false,
        }
    }

    /// Whether `option<self>` is `self` with null for none.
    fn nullable(&self) -> bool {
        self.is_reference()
    }

    pub(crate) fn csharp(&self, world: &str) -> String {
        match self {
            Ty::Bool => "bool".into(),
            Ty::U8 => "byte".into(),
            Ty::S8 => "sbyte".into(),
            Ty::U16 => "ushort".into(),
            Ty::S16 => "short".into(),
            Ty::U32 => "uint".into(),
            Ty::S32 | Ty::Char => "int".into(),
            Ty::U64 => "ulong".into(),
            Ty::S64 => "long".into(),
            Ty::F32 => "float".into(),
            Ty::F64 => "double".into(),
            Ty::Enum { path, .. } | Ty::Record { path, .. } => path.clone(),
            Ty::Handle { class, .. } => class.clone(),
            Ty::Channel {
                stream, payload, ..
            } => format!(
                "global::Gameplay.Runtime.{}Reader<{}>",
                if *stream { "Stream" } else { "Future" },
                payload.csharp(world)
            ),
            Ty::Tuple(items) => format!(
                "{world}.Tuple{}<{}>",
                items.len(),
                items
                    .iter()
                    .map(|item| item.csharp(world))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Ty::String => "string".into(),
            Ty::List(element) => format!("{}[]", element.csharp(world)),
            Ty::Option(payload) if payload.nullable() => payload.csharp(world),
            Ty::Option(payload) => format!("{world}.Option<{}>", payload.csharp(world)),
            Ty::Variant { path, .. } => path.clone(),
        }
    }

    /// The flat Wasm types, as the canonical ABI flattens the value.
    pub(crate) fn flat(&self, into: &mut Vec<WasmType>) {
        match self {
            Ty::U64 | Ty::S64 => into.push(WasmType::I64),
            Ty::F32 => into.push(WasmType::F32),
            Ty::F64 => into.push(WasmType::F64),
            Ty::String | Ty::List(_) => {
                into.push(WasmType::Pointer);
                into.push(WasmType::Length);
            }
            Ty::Record { fields, .. } => {
                for (_, field) in fields {
                    field.flat(into);
                }
            }
            Ty::Tuple(items) => {
                for item in items {
                    item.flat(into);
                }
            }
            Ty::Option(payload) => {
                into.push(WasmType::I32);
                payload.flat(into);
            }
            Ty::Variant { cases, .. } => {
                into.push(WasmType::I32);
                into.extend(joined_payload(cases));
            }
            _ => into.push(WasmType::I32),
        }
    }

    /// Records and tuples of what the glue cannot yet express: tuples
    /// whose C# struct would need more parameters than it has.
    pub(crate) fn tuple_arities(&self, into: &mut Vec<usize>) {
        match self {
            Ty::Tuple(items) => {
                into.push(items.len());
                for item in items {
                    item.tuple_arities(into);
                }
            }
            Ty::Record { fields, .. } => {
                for (_, field) in fields {
                    field.tuple_arities(into);
                }
            }
            Ty::List(inner) | Ty::Option(inner) => inner.tuple_arities(into),
            Ty::Channel { payload, .. } => payload.tuple_arities(into),
            Ty::Variant { cases, .. } => {
                for case in cases {
                    if let Some(payload) = &case.payload {
                        payload.tuple_arities(into);
                    }
                }
            }
            _ => {}
        }
    }

    /// Whether the world's `Result<T, E>` union appears in the type.
    pub(crate) fn uses_result(&self, world: &str) -> bool {
        match self {
            Ty::Variant { path, cases, .. } => {
                path.starts_with(&format!("{world}.Result<"))
                    || cases.iter().any(|case| {
                        case.payload
                            .as_ref()
                            .is_some_and(|payload| payload.uses_result(world))
                    })
            }
            Ty::Option(inner) | Ty::List(inner) => inner.uses_result(world),
            Ty::Channel { payload, .. } => payload.uses_result(world),
            Ty::Tuple(items) => items.iter().any(|item| item.uses_result(world)),
            Ty::Record { fields, .. } => fields.iter().any(|(_, field)| field.uses_result(world)),
            _ => false,
        }
    }

    pub(crate) fn uses_option_struct(&self) -> bool {
        match self {
            Ty::Option(payload) => !payload.nullable() || payload.uses_option_struct(),
            Ty::Tuple(items) => items.iter().any(Ty::uses_option_struct),
            Ty::Record { fields, .. } => fields.iter().any(|(_, field)| field.uses_option_struct()),
            Ty::List(inner) => inner.uses_option_struct(),
            Ty::Channel { payload, .. } => payload.uses_option_struct(),
            Ty::Variant { cases, .. } => cases
                .iter()
                .any(|case| case.payload.as_ref().is_some_and(Ty::uses_option_struct)),
            _ => false,
        }
    }
}

/// The C# type of one flat value.
pub(crate) fn wasm_csharp(ty: WasmType) -> &'static str {
    match ty {
        WasmType::I64 | WasmType::PointerOrI64 => "long",
        WasmType::F32 => "float",
        WasmType::F64 => "double",
        _ => "int",
    }
}

/// An exported method's receiver, a rep, is a pointer to wit-parser (an
/// i32 here), as Rust's bindings make it.
pub(crate) fn receiver_pointer(function: &Function, import: bool, flat: &mut [WasmType]) {
    if !import
        && matches!(
            function.kind,
            FunctionKind::Method(_) | FunctionKind::AsyncMethod(_)
        )
    {
        flat[0] = WasmType::Pointer;
    }
}

/// C# statements, with their nesting.
#[derive(Default)]
pub(crate) struct Code {
    pub(crate) lines: Vec<String>,
    indent: usize,
    next: usize,
}

impl Code {
    pub(crate) fn line(&mut self, text: impl AsRef<str>) {
        self.lines
            .push(format!("{}{}", "    ".repeat(self.indent), text.as_ref()));
    }

    fn open(&mut self, header: impl AsRef<str>) {
        self.line(header);
        self.line("{");
        self.indent += 1;
    }

    fn close(&mut self) {
        self.indent -= 1;
        self.line("}");
    }

    /// A fresh local name: `stem_N`. WIT names never contain `_`, so these
    /// never collide with a parameter.
    pub(crate) fn temp(&mut self, stem: &str) -> String {
        self.next += 1;
        format!("{stem}_{}", self.next)
    }
}

/// Sizes, alignments and offsets, from witgen's canonical layout, and how
/// the glue lifts and lowers values in C#.
pub(crate) struct Layout<'a> {
    pub(crate) sizes: Sizes<'a>,
    pub(crate) world: String,
    /// Whether the lifts free what they read of the host's strings and
    /// lists (`ComponentTasks.Consumed`): in a world where the host may
    /// allocate them in held memory (see `tasks`).
    pub(crate) consume: bool,
}

impl<'a> std::ops::Deref for Layout<'a> {
    type Target = Sizes<'a>;

    fn deref(&self) -> &Sizes<'a> {
        &self.sizes
    }
}

impl Layout<'_> {
    /// The expression of a case's value, from its payload, if any.
    fn construct_case(case: &Case, value: Option<String>) -> String {
        match value {
            Some(value) => format!("new {}({value})", case.class),
            None if case.unit => format!("new {}(null)", case.class),
            None => format!("new {}()", case.class),
        }
    }

    fn csharp(&self, ty: &Ty) -> String {
        ty.csharp(&self.world)
    }

    // MARK: Flat values

    /// Lowers the C# value `expression` into flat values, appended to
    /// `into` as expressions of their Wasm types; statements go to `code`.
    pub(crate) fn lower_flat(
        &self,
        expression: &str,
        wit: &Type,
        ty: &Ty,
        code: &mut Code,
        into: &mut Vec<String>,
    ) {
        match ty {
            Ty::String => {
                let pointer = code.temp("pointer");
                let length = code.temp("length");
                code.line(format!(
                    "int {pointer} = global::Gameplay.Runtime.Canonical.StoreString({expression}, out int {length});"
                ));
                into.push(pointer);
                into.push(length);
            }
            Ty::List(element) => {
                let array = code.temp("array");
                code.line(format!("var {array} = {expression};"));
                let pointer = self.store_list(&array, &self.parts(wit)[0], element, code);
                into.push(pointer);
                into.push(format!("{array}.Length"));
            }
            Ty::Record { fields, .. } => {
                let parts = self.parts(wit);
                for ((name, field), part) in fields.iter().zip(&parts) {
                    self.lower_flat(&format!("{expression}.{name}"), part, field, code, into);
                }
            }
            Ty::Tuple(items) => {
                let parts = self.parts(wit);
                for (index, (item, part)) in items.iter().zip(&parts).enumerate() {
                    self.lower_flat(&format!("{expression}.Item{index}"), part, item, code, into);
                }
            }
            Ty::Option(payload) => {
                let value = code.temp("option");
                code.line(format!("var {value} = {expression};"));
                let (present, inner) = if payload.nullable() {
                    (format!("{value} != null"), value.clone())
                } else {
                    (format!("{value}.HasValue"), format!("{value}.Value"))
                };
                let some = code.temp("some");
                code.line(format!("int {some} = 0;"));
                let mut flat = Vec::new();
                payload.flat(&mut flat);
                let locals: Vec<String> = flat
                    .iter()
                    .map(|wasm| {
                        let local = code.temp("flat");
                        code.line(format!("{} {local} = 0;", wasm_csharp(*wasm)));
                        local
                    })
                    .collect();
                code.open(format!("if ({present})"));
                code.line(format!("{some} = 1;"));
                let mut values = Vec::new();
                self.lower_flat(&inner, &self.parts(wit)[0], payload, code, &mut values);
                for (local, value) in locals.iter().zip(values) {
                    code.line(format!("{local} = {value};"));
                }
                code.close();
                into.push(some);
                into.extend(locals);
            }
            Ty::Variant { cases, .. } => {
                let value = code.temp("variant");
                code.line(format!("var {value} = {expression};"));
                let tag = code.temp("case");
                code.line(format!("int {tag} = 0;"));
                let joined = joined_payload(cases);
                let locals: Vec<String> = joined
                    .iter()
                    .map(|wasm| {
                        let local = code.temp("flat");
                        code.line(format!("{} {local} = 0;", wasm_csharp(*wasm)));
                        local
                    })
                    .collect();
                let wits = self.case_types(wit);
                for (index, (case, case_wit)) in cases.iter().zip(&wits).enumerate() {
                    let bound = code.temp("value");
                    let keyword = if index == 0 { "if" } else { "else if" };
                    code.open(format!("{keyword} ({value} is {} {bound})", case.class));
                    code.line(format!("{tag} = {index};"));
                    if let (Some(payload), Some(payload_wit)) = (&case.payload, case_wit) {
                        let mut flat = Vec::new();
                        payload.flat(&mut flat);
                        let mut values = Vec::new();
                        self.lower_flat(
                            &format!("{bound}.Value"),
                            payload_wit,
                            payload,
                            code,
                            &mut values,
                        );
                        for ((local, value), (from, to)) in locals
                            .iter()
                            .zip(values)
                            .zip(flat.into_iter().zip(joined.iter().copied()))
                        {
                            code.line(format!("{local} = {};", widen(&value, from, to)));
                        }
                    }
                    code.close();
                }
                code.open("else");
                code.line("throw new global::System.InvalidOperationException();");
                code.close();
                into.push(tag);
                into.extend(locals);
            }
            scalar => into.push(self.lower_scalar(expression, scalar, code)),
        }
    }

    /// A scalar, enum or handle as its one flat value.
    fn lower_scalar(&self, expression: &str, ty: &Ty, code: &mut Code) -> String {
        match ty {
            Ty::Bool => format!("({expression} ? 1 : 0)"),
            Ty::U8 | Ty::S8 | Ty::U16 | Ty::S16 => format!("(int){expression}"),
            Ty::U32 => format!("unchecked((int){expression})"),
            Ty::S32 | Ty::Char | Ty::S64 | Ty::F32 | Ty::F64 => expression.to_string(),
            Ty::U64 => format!("unchecked((long){expression})"),
            Ty::Enum { flags: false, .. } => format!("(int){expression}"),
            Ty::Enum { flags: true, .. } => format!("unchecked((int)(uint){expression})"),
            Ty::Handle {
                class,
                exported: true,
                owned,
            } => {
                // Only own handles of the module's objects are lowered:
                // to the caller of an export, or to `task.return`.
                assert!(*owned, "a borrow of an exported resource is never lowered");
                format!("{class}.LowerOwn_({expression})")
            }
            Ty::Handle { owned, .. } => {
                let object = code.temp("object");
                let handle = code.temp("handle");
                code.line(format!("var {object} = {expression};"));
                code.line(format!("int {handle} = {object}.Handle;"));
                if *owned {
                    // Ownership moves to the callee: the object is spent,
                    // as Dispose leaves it.
                    code.line(format!("{object}.Dropped = true;"));
                    code.line(format!("{object}.Handle = 0;"));
                }
                handle
            }
            // The end moves to the callee: the object no longer holds it.
            Ty::Channel { stream, .. } => format!(
                "global::Gameplay.Runtime.ComponentTasks.Lower{}({expression})",
                if *stream { "Stream" } else { "Future" }
            ),
            _ => unreachable!("not a scalar"),
        }
    }

    /// Lifts a value from flat values, taking them from `values` in order;
    /// statements go to `code`, and the result is an expression.
    pub(crate) fn lift_flat(
        &self,
        values: &mut impl Iterator<Item = String>,
        wit: &Type,
        ty: &Ty,
        code: &mut Code,
    ) -> String {
        fn next(values: &mut impl Iterator<Item = String>) -> String {
            values.next().expect("one name per flat value")
        }
        match ty {
            Ty::String => {
                let pointer = next(values);
                let length = next(values);
                let text =
                    format!("global::Gameplay.Runtime.Canonical.LoadString({pointer}, {length})");
                self.consumed(text, &pointer, ty, code)
            }
            Ty::List(element) => {
                let pointer = next(values);
                let length = next(values);
                let array = self.load_list(&pointer, &length, &self.parts(wit)[0], element, code);
                self.consumed(array, &pointer, ty, code)
            }
            Ty::Record { fields, .. } => {
                let parts = self.parts(wit);
                let mut arguments = Vec::new();
                for ((_, field), part) in fields.iter().zip(&parts) {
                    let value = self.lift_flat(values, part, field, code);
                    arguments.push(self.hold(value, field, code));
                }
                format!("new {}({})", self.csharp(ty), arguments.join(", "))
            }
            Ty::Tuple(items) => {
                let parts = self.parts(wit);
                let mut arguments = Vec::new();
                for (item, part) in items.iter().zip(&parts) {
                    let value = self.lift_flat(values, part, item, code);
                    arguments.push(self.hold(value, item, code));
                }
                format!("new {}({})", self.csharp(ty), arguments.join(", "))
            }
            Ty::Option(payload) => {
                let some = next(values);
                let result = code.temp("option");
                code.line(format!("{} {result} = default;", self.csharp(ty)));
                // The payload's values are there, zero when absent, and are
                // taken either way.
                let mut flat = Vec::new();
                payload.flat(&mut flat);
                let taken: Vec<String> = (0..flat.len()).map(|_| next(values)).collect();
                code.open(format!("if ({some} != 0)"));
                let value =
                    self.lift_flat(&mut taken.into_iter(), &self.parts(wit)[0], payload, code);
                if payload.nullable() {
                    code.line(format!("{result} = {value};"));
                } else {
                    code.line(format!("{result} = new {}({value});", self.csharp(ty)));
                }
                code.close();
                result
            }
            Ty::Variant { cases, .. } => {
                let tag = next(values);
                let joined = joined_payload(cases);
                let taken: Vec<String> = (0..joined.len()).map(|_| next(values)).collect();
                let result = code.temp("variant");
                code.line(format!("{} {result} = default;", self.csharp(ty)));
                let wits = self.case_types(wit);
                for (index, (case, case_wit)) in cases.iter().zip(&wits).enumerate() {
                    let keyword = if index == 0 { "if" } else { "else if" };
                    code.open(format!("{keyword} ({tag} == {index})"));
                    let value = match (&case.payload, case_wit) {
                        (Some(payload), Some(payload_wit)) => {
                            let mut flat = Vec::new();
                            payload.flat(&mut flat);
                            let narrowed: Vec<String> = taken
                                .iter()
                                .zip(joined.iter().copied())
                                .zip(flat)
                                .map(|((name, from), to)| {
                                    let local = code.temp("flat");
                                    code.line(format!(
                                        "{} {local} = {};",
                                        wasm_csharp(to),
                                        narrow(name, from, to)
                                    ));
                                    local
                                })
                                .collect();
                            Some(self.lift_flat(
                                &mut narrowed.into_iter(),
                                payload_wit,
                                payload,
                                code,
                            ))
                        }
                        _ => None,
                    };
                    code.line(format!("{result} = {};", Self::construct_case(case, value)));
                    code.close();
                }
                code.open("else");
                code.line("throw new global::System.InvalidOperationException();");
                code.close();
                result
            }
            scalar => {
                let value = next(values);
                self.lift_scalar(&value, scalar)
            }
        }
    }

    /// Evaluates `value` into a local when it is not already a name, so
    /// fields are lifted in order.
    fn hold(&self, value: String, ty: &Ty, code: &mut Code) -> String {
        if value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return value;
        }
        let local = code.temp("value");
        code.line(format!("{} {local} = {value};", self.csharp(ty)));
        local
    }

    /// A scalar, enum or handle from its one flat value; narrow integers
    /// wrap, as the canonical ABI lifts them, and bools are nonzero.
    fn lift_scalar(&self, value: &str, ty: &Ty) -> String {
        match ty {
            Ty::Bool => format!("({value} != 0)"),
            Ty::U8 => format!("unchecked((byte){value})"),
            Ty::S8 => format!("unchecked((sbyte){value})"),
            Ty::U16 => format!("unchecked((ushort){value})"),
            Ty::S16 => format!("unchecked((short){value})"),
            Ty::U32 => format!("unchecked((uint){value})"),
            Ty::U64 => format!("unchecked((ulong){value})"),
            Ty::S32 | Ty::Char | Ty::S64 | Ty::F32 | Ty::F64 => value.to_string(),
            Ty::Enum {
                path, flags: false, ..
            } => format!("({path}){value}"),
            Ty::Enum {
                path, flags: true, ..
            } => format!("({path})unchecked((uint){value})"),
            Ty::Handle {
                class,
                owned,
                exported,
            } => super::lift_handle(class, *owned, *exported, value),
            Ty::Channel { stream, ops, .. } => format!(
                "global::Gameplay.Runtime.ComponentTasks.Lift{}({value}, {ops})",
                if *stream { "Stream" } else { "Future" }
            ),
            _ => unreachable!("not a scalar"),
        }
    }

    // MARK: Memory

    /// Stores the C# value `expression` at `address`.
    pub(crate) fn store(
        &self,
        expression: &str,
        address: &str,
        wit: &Type,
        ty: &Ty,
        code: &mut Code,
    ) {
        let memory = "global::Gameplay.Runtime.Memory";
        match ty {
            Ty::Bool => code.line(format!(
                "global::Gameplay.Runtime.Canonical.StoreBool({address}, {expression});"
            )),
            Ty::U8 | Ty::S8 => code.line(format!("{memory}.Store8({address}, {expression});")),
            Ty::U16 | Ty::S16 => code.line(format!("{memory}.Store16({address}, {expression});")),
            Ty::U32 => code.line(format!(
                "{memory}.Store32({address}, unchecked((int){expression}));"
            )),
            Ty::S32 | Ty::Char => code.line(format!("{memory}.Store32({address}, {expression});")),
            Ty::U64 => code.line(format!(
                "{memory}.Store64({address}, unchecked((long){expression}));"
            )),
            Ty::S64 => code.line(format!("{memory}.Store64({address}, {expression});")),
            Ty::F32 => code.line(format!("{memory}.StoreF32({address}, {expression});")),
            Ty::F64 => code.line(format!("{memory}.StoreF64({address}, {expression});")),
            Ty::Enum { size, flags, .. } => {
                let value = if *flags {
                    format!("unchecked((int)(uint){expression})")
                } else {
                    format!("(int){expression}")
                };
                code.line(format!("{memory}.Store{}({address}, {value});", size * 8));
            }
            Ty::Handle { .. } | Ty::Channel { .. } => {
                let handle = self.lower_scalar(expression, ty, code);
                code.line(format!("{memory}.Store32({address}, {handle});"));
            }
            Ty::String => {
                let length = code.temp("length");
                code.line(format!(
                    "{memory}.Store32({address}, global::Gameplay.Runtime.Canonical.StoreString({expression}, out int {length}));"
                ));
                code.line(format!("{memory}.Store32({address} + 4, {length});"));
            }
            Ty::List(element) => {
                let array = code.temp("array");
                code.line(format!("var {array} = {expression};"));
                let pointer = self.store_list(&array, &self.parts(wit)[0], element, code);
                code.line(format!("{memory}.Store32({address}, {pointer});"));
                code.line(format!("{memory}.Store32({address} + 4, {array}.Length);"));
            }
            Ty::Record { fields, .. } => {
                let parts = self.parts(wit);
                let offsets = self.offsets(&parts);
                let record = code.temp("record");
                code.line(format!("var {record} = {expression};"));
                for (((name, field), part), offset) in fields.iter().zip(&parts).zip(offsets) {
                    self.store(
                        &format!("{record}.{name}"),
                        &format!("{address} + {offset}"),
                        part,
                        field,
                        code,
                    );
                }
            }
            Ty::Tuple(items) => {
                let parts = self.parts(wit);
                let offsets = self.offsets(&parts);
                let tuple = code.temp("tuple");
                code.line(format!("var {tuple} = {expression};"));
                for (index, ((item, part), offset)) in
                    items.iter().zip(&parts).zip(offsets).enumerate()
                {
                    self.store(
                        &format!("{tuple}.Item{index}"),
                        &format!("{address} + {offset}"),
                        part,
                        item,
                        code,
                    );
                }
            }
            Ty::Option(payload) => {
                let part = self.parts(wit)[0];
                let value = code.temp("option");
                code.line(format!("var {value} = {expression};"));
                let (present, inner) = if payload.nullable() {
                    (format!("{value} != null"), value.clone())
                } else {
                    (format!("{value}.HasValue"), format!("{value}.Value"))
                };
                code.open(format!("if ({present})"));
                code.line(format!("{memory}.Store8({address}, 1);"));
                self.store(
                    &inner,
                    &format!("{address} + {}", self.payload_offset(&part)),
                    &part,
                    payload,
                    code,
                );
                code.close();
                code.open("else");
                code.line(format!("{memory}.Store8({address}, 0);"));
                code.close();
            }
            Ty::Variant { cases, size, .. } => {
                let base = self.hold_address(address, code);
                let wits = self.case_types(wit);
                let offset = self.variant_payload_offset(&wits, *size);
                let value = code.temp("variant");
                code.line(format!("var {value} = {expression};"));
                for (index, (case, case_wit)) in cases.iter().zip(&wits).enumerate() {
                    let bound = code.temp("value");
                    let keyword = if index == 0 { "if" } else { "else if" };
                    code.open(format!("{keyword} ({value} is {} {bound})", case.class));
                    code.line(format!("{memory}.Store{}({base}, {index});", size * 8));
                    if let (Some(payload), Some(payload_wit)) = (&case.payload, case_wit) {
                        self.store(
                            &format!("{bound}.Value"),
                            &format!("{base} + {offset}"),
                            payload_wit,
                            payload,
                            code,
                        );
                    }
                    code.close();
                }
                code.open("else");
                code.line("throw new global::System.InvalidOperationException();");
                code.close();
            }
        }
    }

    /// Copies an array into memory; the expression of its address.
    fn store_list(&self, array: &str, element_wit: &Type, element: &Ty, code: &mut Code) -> String {
        let size = self.size(element_wit);
        let align = self.align(element_wit);
        let pointer = code.temp("elements");
        code.line(format!(
            "int {pointer} = global::Gameplay.Runtime.Canonical.Allocate(global::Gameplay.Runtime.Canonical.Size({array}.Length, {size}), {align});"
        ));
        let index = code.temp("index");
        code.open(format!(
            "for (int {index} = 0; {index} < {array}.Length; {index}++)"
        ));
        self.store(
            &format!("{array}[{index}]"),
            &format!("{pointer} + {index} * {size}"),
            element_wit,
            element,
            code,
        );
        code.close();
        pointer
    }

    /// Loads a value from `address`; the expression of its C# value.
    pub(crate) fn load(&self, address: &str, wit: &Type, ty: &Ty, code: &mut Code) -> String {
        let memory = "global::Gameplay.Runtime.Memory";
        match ty {
            Ty::Bool => format!("global::Gameplay.Runtime.Canonical.LoadBool({address})"),
            Ty::U8 => format!("(byte){memory}.Load8U({address})"),
            Ty::S8 => format!("(sbyte){memory}.Load8S({address})"),
            Ty::U16 => format!("(ushort){memory}.Load16U({address})"),
            Ty::S16 => format!("(short){memory}.Load16S({address})"),
            Ty::U32 => format!("unchecked((uint){memory}.Load32({address}))"),
            Ty::S32 | Ty::Char => format!("{memory}.Load32({address})"),
            Ty::U64 => format!("unchecked((ulong){memory}.Load64({address}))"),
            Ty::S64 => format!("{memory}.Load64({address})"),
            Ty::F32 => format!("{memory}.LoadF32({address})"),
            Ty::F64 => format!("{memory}.LoadF64({address})"),
            Ty::Enum { path, size, flags } => {
                let load = match size {
                    1 => format!("{memory}.Load8U({address})"),
                    2 => format!("{memory}.Load16U({address})"),
                    _ => format!("{memory}.Load32({address})"),
                };
                if *flags {
                    format!("({path})unchecked((uint){load})")
                } else {
                    format!("({path}){load}")
                }
            }
            Ty::Handle { .. } | Ty::Channel { .. } => {
                self.lift_scalar(&format!("{memory}.Load32({address})"), ty)
            }
            Ty::String if self.consume => {
                let base = self.hold_address(address, code);
                let pointer = code.temp("pointer");
                code.line(format!("int {pointer} = {memory}.Load32({base});"));
                let text = format!(
                    "global::Gameplay.Runtime.Canonical.LoadString({pointer}, {memory}.Load32({base} + 4))"
                );
                self.consumed(text, &pointer, ty, code)
            }
            Ty::String => {
                let base = self.hold_address(address, code);
                format!(
                    "global::Gameplay.Runtime.Canonical.LoadString({memory}.Load32({base}), {memory}.Load32({base} + 4))"
                )
            }
            Ty::List(element) => {
                let base = self.hold_address(address, code);
                let pointer = code.temp("pointer");
                let length = code.temp("length");
                code.line(format!("int {pointer} = {memory}.Load32({base});"));
                code.line(format!("int {length} = {memory}.Load32({base} + 4);"));
                let array = self.load_list(&pointer, &length, &self.parts(wit)[0], element, code);
                self.consumed(array, &pointer, ty, code)
            }
            Ty::Record { .. } | Ty::Tuple(_) => {
                let base = self.hold_address(address, code);
                let parts = self.parts(wit);
                let offsets = self.offsets(&parts);
                let members: Vec<&Ty> = match ty {
                    Ty::Record { fields, .. } => fields.iter().map(|(_, field)| field).collect(),
                    Ty::Tuple(items) => items.iter().collect(),
                    _ => unreachable!(),
                };
                let mut arguments = Vec::new();
                for ((member, part), offset) in members.into_iter().zip(&parts).zip(offsets) {
                    let value = self.load(&format!("{base} + {offset}"), part, member, code);
                    arguments.push(self.hold(value, member, code));
                }
                format!("new {}({})", self.csharp(ty), arguments.join(", "))
            }
            Ty::Option(payload) => {
                let base = self.hold_address(address, code);
                let part = self.parts(wit)[0];
                let result = code.temp("option");
                code.line(format!("{} {result} = default;", self.csharp(ty)));
                code.open(format!("if ({memory}.Load8U({base}) != 0)"));
                let value = self.load(
                    &format!("{base} + {}", self.payload_offset(&part)),
                    &part,
                    payload,
                    code,
                );
                if payload.nullable() {
                    code.line(format!("{result} = {value};"));
                } else {
                    code.line(format!("{result} = new {}({value});", self.csharp(ty)));
                }
                code.close();
                result
            }
            Ty::Variant { cases, size, .. } => {
                let base = self.hold_address(address, code);
                let wits = self.case_types(wit);
                let offset = self.variant_payload_offset(&wits, *size);
                let tag = code.temp("case");
                let load = match size {
                    1 => "Load8U",
                    2 => "Load16U",
                    _ => "Load32",
                };
                code.line(format!("int {tag} = {memory}.{load}({base});"));
                let result = code.temp("variant");
                code.line(format!("{} {result} = default;", self.csharp(ty)));
                for (index, (case, case_wit)) in cases.iter().zip(&wits).enumerate() {
                    let keyword = if index == 0 { "if" } else { "else if" };
                    code.open(format!("{keyword} ({tag} == {index})"));
                    let value = match (&case.payload, case_wit) {
                        (Some(payload), Some(payload_wit)) => Some(self.load(
                            &format!("{base} + {offset}"),
                            payload_wit,
                            payload,
                            code,
                        )),
                        _ => None,
                    };
                    code.line(format!("{result} = {};", Self::construct_case(case, value)));
                    code.close();
                }
                code.open("else");
                code.line("throw new global::System.InvalidOperationException();");
                code.close();
                result
            }
        }
    }

    /// A lifted string or list, and, where the lifts free what they read,
    /// the host's block at `pointer` freed once it is read.
    fn consumed(&self, value: String, pointer: &str, ty: &Ty, code: &mut Code) -> String {
        if !self.consume {
            return value;
        }
        let local = self.hold(value, ty, code);
        code.line(format!(
            "global::Gameplay.Runtime.ComponentTasks.Consumed({pointer});"
        ));
        local
    }

    /// Where the lifts free what they read, the host's block of an export's
    /// parameters, once they are read.
    pub(crate) fn consume_parameters(&self, code: &mut Code) {
        if self.consume {
            code.line("global::Gameplay.Runtime.ComponentTasks.Consumed(in_0);");
        }
    }

    fn hold_address(&self, address: &str, code: &mut Code) -> String {
        if address
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return address.to_string();
        }
        let local = code.temp("address");
        code.line(format!("int {local} = {address};"));
        local
    }

    /// Copies `length` elements at `pointer` into a new array; the
    /// expression of the array.
    fn load_list(
        &self,
        pointer: &str,
        length: &str,
        element_wit: &Type,
        element: &Ty,
        code: &mut Code,
    ) -> String {
        let size = self.size(element_wit);
        let array = code.temp("array");
        let element_type = self.csharp(element);
        // `new T[n][]`: the element type's brackets go last.
        let creation = match element_type.find('[') {
            Some(at) => format!(
                "new {}[{length}]{}",
                &element_type[..at],
                &element_type[at..]
            ),
            None => format!("new {element_type}[{length}]"),
        };
        code.line(format!("var {array} = {creation};"));
        let index = code.temp("index");
        code.open(format!(
            "for (int {index} = 0; {index} < {length}; {index}++)"
        ));
        let value = self.load(
            &format!("{pointer} + {index} * {size}"),
            element_wit,
            element,
            code,
        );
        code.line(format!("{array}[{index}] = {value};"));
        code.close();
        array
    }
}

// MARK: Functions

use super::{Call, Generator, names};
use wit_parser::abi::AbiVariant;
use wit_parser::{Function, FunctionKind, Handle, TypeDefKind, TypeOwner};

impl Generator<'_> {
    /// A WIT type as the glue sees it, or None when unsupported.
    pub(crate) fn ty(&self, ty: &Type) -> Option<Ty> {
        Some(match ty {
            Type::Bool => Ty::Bool,
            Type::U8 => Ty::U8,
            Type::S8 => Ty::S8,
            Type::U16 => Ty::U16,
            Type::S16 => Ty::S16,
            Type::U32 => Ty::U32,
            Type::S32 => Ty::S32,
            Type::U64 => Ty::U64,
            Type::S64 => Ty::S64,
            Type::F32 => Ty::F32,
            Type::F64 => Ty::F64,
            Type::Char => Ty::Char,
            Type::String => Ty::String,
            Type::ErrorContext => return None,
            Type::Id(id) => match &self.resolve.types[*id].kind {
                TypeDefKind::Type(inner) => return self.ty(inner),
                TypeDefKind::Enum(definition) => Ty::Enum {
                    path: self.type_path(*id)?,
                    size: match definition.cases.len() {
                        0..=256 => 1,
                        257..=65536 => 2,
                        _ => 4,
                    },
                    flags: false,
                },
                TypeDefKind::Flags(flags) if flags.flags.len() <= 32 => Ty::Enum {
                    path: self.type_path(*id)?,
                    size: match flags.flags.len() {
                        0..=8 => 1,
                        9..=16 => 2,
                        _ => 4,
                    },
                    flags: true,
                },
                TypeDefKind::Handle(handle) => {
                    let (resource, owned) = match handle {
                        Handle::Own(resource) => (*resource, true),
                        Handle::Borrow(resource) => (*resource, false),
                    };
                    let resource = self.dealias(resource);
                    let TypeOwner::Interface(owner) = self.resolve.types[resource].owner else {
                        return None;
                    };
                    Ty::Handle {
                        class: self.type_path(resource)?,
                        owned,
                        exported: self.exported.contains(&owner),
                    }
                }
                TypeDefKind::Record(record) => {
                    let mut fields = Vec::new();
                    for field in &record.fields {
                        fields.push((names::pascal(&field.name), self.ty(&field.ty)?));
                    }
                    Ty::Record {
                        path: self.type_path(*id)?,
                        fields,
                    }
                }
                TypeDefKind::Tuple(tuple) => {
                    let mut items = Vec::new();
                    for item in &tuple.types {
                        items.push(self.ty(item)?);
                    }
                    Ty::Tuple(items)
                }
                TypeDefKind::List(element) => Ty::List(Box::new(self.ty(element)?)),
                TypeDefKind::Option(payload) => Ty::Option(Box::new(self.ty(payload)?)),
                TypeDefKind::Variant(variant)
                    if variant.cases.iter().all(|case| case.ty.is_none()) =>
                {
                    Ty::Enum {
                        path: self.type_path(*id)?,
                        size: match variant.cases.len() {
                            0..=256 => 1,
                            257..=65536 => 2,
                            _ => 4,
                        },
                        flags: false,
                    }
                }
                TypeDefKind::Variant(variant) => {
                    let path = self.type_path(*id)?;
                    let prefix = path
                        .rsplit_once('.')
                        .map(|(outer, _)| format!("{outer}."))
                        .unwrap_or_default();
                    let name =
                        names::pascal(self.resolve.types[self.dealias(*id)].name.as_deref()?);
                    let mut cases = Vec::new();
                    for case in &variant.cases {
                        cases.push(Case {
                            class: format!("{prefix}{name}{}", names::pascal(&case.name)),
                            payload: match &case.ty {
                                Some(payload) => Some(self.ty(payload)?),
                                None => None,
                            },
                            unit: false,
                        });
                    }
                    Ty::Variant {
                        path,
                        size: match variant.cases.len() {
                            0..=256 => 1,
                            257..=65536 => 2,
                            _ => 4,
                        },
                        cases,
                    }
                }
                TypeDefKind::Future(Some(_)) | TypeDefKind::Stream(Some(_)) => {
                    let channel = self.channels.get(id)?;
                    Ty::Channel {
                        stream: channel.stream,
                        payload: Box::new(channel.payload.clone()),
                        ops: format!("{}.{}.Instance", self.world_class, channel.class),
                    }
                }
                TypeDefKind::Result(result) => {
                    let world = &self.world_class;
                    let side = |ty: &Option<Type>| -> Option<(String, Option<Ty>)> {
                        match ty {
                            Some(ty) => {
                                let ty = self.ty(ty)?;
                                Some((ty.csharp(world), Some(ty)))
                            }
                            None => Some((format!("{world}.Unit"), None)),
                        }
                    };
                    let (ok, ok_ty) = side(&result.ok)?;
                    let (err, err_ty) = side(&result.err)?;
                    Ty::Variant {
                        path: format!("{world}.Result<{ok}, {err}>"),
                        cases: vec![
                            Case {
                                class: format!("{world}.Ok<{ok}>"),
                                unit: ok_ty.is_none(),
                                payload: ok_ty,
                            },
                            Case {
                                class: format!("{world}.Err<{err}>"),
                                unit: err_ty.is_none(),
                                payload: err_ty,
                            },
                        ],
                        size: 1,
                    }
                }
                _ => return None,
            },
        })
    }

    /// Notes the world's helper structs a type needs.
    pub(crate) fn need_helpers(&mut self, ty: &Ty) {
        let mut arities = Vec::new();
        ty.tuple_arities(&mut arities);
        self.tuples.extend(arities);
        self.option_struct |= ty.uses_option_struct();
        self.result_union |= ty.uses_result(&self.world_class);
    }

    /// The glue's view of a function, or None when a type is unsupported,
    /// the function is asynchronous, a tuple is wider than eight, or an
    /// import would pass an object of an exported resource.
    pub(crate) fn memory_types(
        &self,
        function: &Function,
        import: bool,
    ) -> Option<(Vec<Ty>, Option<Ty>)> {
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
            params.push(self.ty(&param.ty)?);
        }
        let result = match &function.result {
            Some(ty) => Some(self.ty(ty)?),
            None => None,
        };
        let mut arities = Vec::new();
        for ty in params.iter().chain(&result) {
            ty.tuple_arities(&mut arities);
        }
        if arities.iter().any(|arity| *arity > 8) {
            return None;
        }
        if import && params.iter().chain(&result).any(Ty::has_exported_handle) {
            return None;
        }
        Some((params, result))
    }

    /// An import through memory: a wrapper that copies the arguments into
    /// the boundary memory and the result out of it, then returns the
    /// memory it used.
    pub(crate) fn import_memory(&mut self, header: &str, function: &Function, call: Call) -> bool {
        let Some((params, result)) = self.memory_types(function, true) else {
            return false;
        };
        for ty in params.iter().chain(&result) {
            self.need_helpers(ty);
        }
        let signature = self
            .resolve
            .wasm_signature(AbiVariant::GuestImport, function);
        self.check_signature(function, &params, result.as_ref(), &signature, true);

        let layout = self.layout();
        let mut code = Code::default();
        let mark = code.temp("mark");
        code.line(format!(
            "int {mark} = global::Gameplay.Runtime.Canonical.Mark();"
        ));
        let method = matches!(call, Call::Method);
        let expressions: Vec<String> = function
            .params
            .iter()
            .enumerate()
            .map(|(index, param)| {
                if index == 0 && method {
                    "this".to_string()
                } else {
                    names::camel(&param.name)
                }
            })
            .collect();
        let mut arguments = Vec::new();
        if signature.indirect_params {
            // Every argument goes into a tuple in memory.
            let types: Vec<Type> = function.params.iter().map(|param| param.ty).collect();
            let info = layout.sizes.record(types.iter());
            let block = code.temp("params");
            code.line(format!(
                "int {block} = global::Gameplay.Runtime.Canonical.Allocate({}, {});",
                info.size.size_wasm32(),
                info.align.align_wasm32()
            ));
            for (((expression, param), ty), offset) in expressions
                .iter()
                .zip(&function.params)
                .zip(&params)
                .zip(layout.offsets(&types))
            {
                layout.store(
                    expression,
                    &format!("{block} + {offset}"),
                    &param.ty,
                    ty,
                    &mut code,
                );
            }
            arguments.push(block);
        } else {
            for ((expression, param), ty) in expressions.iter().zip(&function.params).zip(&params) {
                layout.lower_flat(expression, &param.ty, ty, &mut code, &mut arguments);
            }
        }
        let area = if signature.retptr {
            let wit = function.result.expect("a result to return through memory");
            let area = code.temp("result");
            code.line(format!(
                "int {area} = global::Gameplay.Runtime.Canonical.Allocate({}, {});",
                layout.size(&wit),
                layout.align(&wit)
            ));
            arguments.push(area.clone());
            Some(area)
        } else {
            None
        };
        let extern_call = self.extern_call(function, &arguments);
        let value = match (&result, signature.results.first()) {
            (Some(ty), Some(_)) => {
                let raw = code.temp("raw");
                code.line(format!("var {raw} = {extern_call};"));
                let wit = function.result.expect("a result");
                Some(layout.lift_flat(&mut std::iter::once(raw), &wit, ty, &mut code))
            }
            (Some(ty), None) => {
                code.line(format!("{extern_call};"));
                let wit = function.result.expect("a result");
                Some(layout.load(area.as_deref().expect("a result area"), &wit, ty, &mut code))
            }
            (None, _) => {
                code.line(format!("{extern_call};"));
                None
            }
        };
        let value = value.map(|value| {
            let local = code.temp("value");
            code.line(format!("var {local} = {value};"));
            local
        });
        code.line(format!(
            "global::Gameplay.Runtime.Canonical.Release({mark});"
        ));
        match (call, value) {
            (Call::Constructor, Some(value)) => code.line(format!("Handle = {value}.Handle;")),
            (_, Some(value)) => code.line(format!("return {value};")),
            _ => {}
        }

        self.docs(&function.docs);
        self.line("[global::Gameplay.CanonicalAbi]");
        self.open(header);
        for line in &code.lines {
            self.line(line);
        }
        self.close();
        true
    }

    /// The extern of an import through memory, in the flat signature's Wasm
    /// types.
    pub(crate) fn memory_extern(&mut self, module: &str, function: &Function) -> bool {
        if self.memory_types(function, true).is_none() {
            return false;
        }
        let signature = self
            .resolve
            .wasm_signature(AbiVariant::GuestImport, function);
        let parameters: Vec<String> = signature
            .params
            .iter()
            .enumerate()
            .map(|(index, ty)| format!("{} in_{index}", wasm_csharp(*ty)))
            .collect();
        let result = signature
            .results
            .first()
            .map(|ty| wasm_csharp(*ty))
            .unwrap_or("void");
        self.line(&format!(
            "[global::Gameplay.WasmImport(\"{module}\", \"{}\")]",
            function.name
        ));
        self.line(&format!(
            "internal static extern {result} {}({});",
            self.extern_name(function),
            parameters.join(", ")
        ));
        true
    }

    /// An export through memory: the partial member the module implements
    /// (see `implementation`), and the exported wrapper that copies its
    /// arguments out of the boundary memory and its result into it. The next outermost entry
    /// empties the arena, so no post-return function is needed.
    pub(crate) fn export_memory(&mut self, export_name: &str, function: &Function) -> bool {
        let Some((params, result)) = self.memory_types(function, false) else {
            return false;
        };
        for ty in params.iter().chain(&result) {
            self.need_helpers(ty);
        }
        let signature = self
            .resolve
            .wasm_signature(AbiVariant::GuestExport, function);
        self.check_signature(function, &params, result.as_ref(), &signature, false);

        let layout = self.layout();
        let world = layout.world.clone();
        let name = self.glue_name(function);
        let typed: Vec<String> = function
            .params
            .iter()
            .zip(&params)
            .map(|(param, ty)| format!("{} {}", ty.csharp(&world), names::camel(&param.name)))
            .collect();
        let result_type = result
            .as_ref()
            .map(|ty| ty.csharp(&world))
            .unwrap_or_else(|| "void".to_string());

        let mut code = Code::default();
        let mut arguments = Vec::new();
        let flat: Vec<String> = signature
            .params
            .iter()
            .enumerate()
            .map(|(index, ty)| format!("{} in_{index}", wasm_csharp(*ty)))
            .collect();
        if signature.indirect_params {
            let types: Vec<Type> = function.params.iter().map(|param| param.ty).collect();
            for ((param, ty), offset) in function
                .params
                .iter()
                .zip(&params)
                .zip(layout.offsets(&types))
            {
                let value = layout.load(&format!("in_0 + {offset}"), &param.ty, ty, &mut code);
                let local = code.temp("argument");
                code.line(format!("{} {local} = {value};", ty.csharp(&world)));
                arguments.push(local);
            }
            layout.consume_parameters(&mut code);
        } else {
            let mut values = (0..signature.params.len()).map(|index| format!("in_{index}"));
            for (param, ty) in function.params.iter().zip(&params) {
                let value = layout.lift_flat(&mut values, &param.ty, ty, &mut code);
                let local = code.temp("argument");
                code.line(format!("{} {local} = {value};", ty.csharp(&world)));
                arguments.push(local);
            }
        }
        let call = self.implementation_call(function, &arguments);
        let returns = match (&result, signature.retptr) {
            (Some(ty), false) => {
                let local = code.temp("result");
                code.line(format!("var {local} = {call};"));
                let wit = function.result.expect("a result");
                let mut values = Vec::new();
                layout.lower_flat(&local, &wit, ty, &mut code, &mut values);
                code.line(format!("return {};", values[0]));
                wasm_csharp(signature.results[0])
            }
            (Some(ty), true) => {
                let local = code.temp("result");
                code.line(format!("var {local} = {call};"));
                let wit = function.result.expect("a result");
                let area = code.temp("area");
                code.line(format!(
                    "int {area} = global::Gameplay.Runtime.Canonical.Allocate({}, {});",
                    layout.size(&wit),
                    layout.align(&wit)
                ));
                layout.store(&local, &area, &wit, ty, &mut code);
                code.line(format!("return {area};"));
                "int"
            }
            (None, _) => {
                code.line(format!("{call};"));
                "void"
            }
        };

        self.docs(&function.docs);
        self.line(&self.implementation(function, &result_type, &typed));
        self.line("");
        self.line(&format!("[global::Gameplay.WasmExport(\"{export_name}\")]"));
        self.line("[global::Gameplay.CanonicalAbi]");
        self.open(&format!(
            "public static {returns} {name}Export({})",
            flat.join(", ")
        ));
        for line in &code.lines {
            self.line(line);
        }
        self.close();
        true
    }

    /// The glue's flattening must agree with wit-parser's canonical ABI.
    fn check_signature(
        &self,
        function: &Function,
        params: &[Ty],
        result: Option<&Ty>,
        signature: &wit_parser::abi::WasmSignature,
        import: bool,
    ) {
        let mut flat = Vec::new();
        for param in params {
            param.flat(&mut flat);
        }
        let mut flat_result = Vec::new();
        if let Some(result) = result {
            result.flat(&mut flat_result);
        }
        let mut expected_params = if signature.indirect_params {
            vec![WasmType::Pointer]
        } else {
            receiver_pointer(function, import, &mut flat);
            flat
        };
        let expected_results = if signature.retptr {
            if import {
                expected_params.push(WasmType::Pointer);
                Vec::new()
            } else {
                vec![WasmType::Pointer]
            }
        } else {
            flat_result
        };
        if expected_params != signature.params || expected_results != signature.results {
            panic!(
                "witgen lowered {} as {:?} -> {:?}, but the canonical ABI says {:?} -> {:?}",
                function.name,
                expected_params,
                expected_results,
                signature.params,
                signature.results
            );
        }
    }

    pub(crate) fn layout(&self) -> Layout<'_> {
        Layout {
            sizes: Sizes::new(self.resolve),
            world: self.world_class.clone(),
            consume: self.consume,
        }
    }

    /// The world's helper structs, for the tuples and options the glue
    /// uses; whether there were any.
    pub(crate) fn helper_structs(&mut self) -> bool {
        let tuples: Vec<usize> = self.tuples.iter().copied().collect();
        let mut first = true;
        for arity in tuples {
            if !first {
                self.line("");
            }
            first = false;
            let parameters: Vec<String> = (0..arity).map(|index| format!("T{index}")).collect();
            self.line(&format!(
                "/// <summary>A WIT <c>tuple</c> of {arity}.</summary>"
            ));
            let items: Vec<String> = (0..arity)
                .map(|index| format!("T{index} Item{index}"))
                .collect();
            self.line(&format!(
                "public record struct Tuple{arity}<{}>({});",
                parameters.join(", "),
                items.join(", ")
            ));
        }
        if self.result_union {
            if !first {
                self.line("");
            }
            first = false;
            self.line("/// <summary>A WIT <c>result</c>'s side without a payload.</summary>");
            self.line("[global::Gameplay.CanonicalAbi]");
            self.line("public sealed record Unit;");
            self.line("");
            for (class, side) in [("Ok", "success"), ("Err", "error")] {
                self.line(&format!(
                    "/// <summary>A WIT <c>result</c>'s {side}.</summary>"
                ));
                self.line(&format!("public sealed record {class}<T>(T Value);"));
                self.line("");
            }
            self.line("/// <summary>A WIT <c>result</c>.</summary>");
            self.line("public union Result<T, E>(Ok<T>, Err<E>);");
        }
        if self.option_struct {
            if !first {
                self.line("");
            }
            first = false;
            self.line("/// <summary>A WIT <c>option</c> of a value that cannot be null.</summary>");
            self.open("public struct Option<T>");
            self.line("public bool HasValue;");
            self.line("public T Value;");
            self.line("");
            self.open("public Option(T value)");
            self.line("HasValue = true;");
            self.line("Value = value;");
            self.close();
            self.close();
        }
        !first
    }
}
