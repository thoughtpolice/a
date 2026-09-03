// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Component-model value types and the parts of the canonical ABI the linker
//! needs: memory layout, flattening to core types, and the core signatures of
//! lifted and lowered functions.
//!
//! Everything here follows `CanonicalABI.md` for the synchronous ABI. The
//! `Layout` type additionally summarizes whether a value's representation
//! reaches into linear memory or names resource handles, which is what
//! decides whether a call between two instances needs an adapter at all.

use std::fmt;
use std::hash::{Hash, Hasher};

/// A component-model value type.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ValType {
    Bool,
    S8,
    U8,
    S16,
    U16,
    S32,
    U32,
    S64,
    U64,
    F32,
    F64,
    Char,
    String,
    List(Box<ValType>),
    Record(Vec<(String, ValType)>),
    Tuple(Vec<ValType>),
    Variant(Vec<(String, Option<ValType>)>),
    Enum(Vec<String>),
    Option(Box<ValType>),
    Result {
        ok: Option<Box<ValType>>,
        err: Option<Box<ValType>>,
    },
    Flags(Vec<String>),
    Own(Resource),
    Borrow(Resource),
}

/// A resource type, identified by `id`; `name` only serves diagnostics, so
/// two views of one resource under different names are the same type.
///
/// As decoded from a component, `id` is an ordinal of that component's
/// resource types, whatever their type index: a resource reachable only
/// through an imported instance's type has an ordinal but no type index.
/// [`crate::plan::link`] replaces the ordinal with the index of the runtime
/// resource in `Plan::resources`, which is what every type in a plan carries.
#[derive(Clone, Debug)]
pub struct Resource {
    pub name: String,
    pub id: u32,
}

impl PartialEq for Resource {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for Resource {}

impl Hash for Resource {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.id.hash(state);
    }
}

impl Resource {
    /// The name diagnostics print: the lexical name when one is known.
    pub fn label(&self) -> String {
        if self.name.is_empty() {
            format!("resource{}", self.id)
        } else {
            self.name.clone()
        }
    }
}

/// A component-model function type.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct FuncType {
    pub params: Vec<(String, ValType)>,
    pub result: Option<ValType>,
}

/// A core WebAssembly value type as used by the flat ABI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CoreType {
    I32,
    I64,
    F32,
    F64,
}

impl CoreType {
    pub fn encode(self) -> wasm_encoder::ValType {
        match self {
            CoreType::I32 => wasm_encoder::ValType::I32,
            CoreType::I64 => wasm_encoder::ValType::I64,
            CoreType::F32 => wasm_encoder::ValType::F32,
            CoreType::F64 => wasm_encoder::ValType::F64,
        }
    }

    /// The canonical ABI's `join` of two flat types.
    fn join(self, other: CoreType) -> CoreType {
        match (self, other) {
            (a, b) if a == b => a,
            (CoreType::I32, CoreType::F32) | (CoreType::F32, CoreType::I32) => CoreType::I32,
            _ => CoreType::I64,
        }
    }
}

/// The most flat parameters a core signature may carry before the parameters
/// are spilled to linear memory.
pub const MAX_FLAT_PARAMS: usize = 16;

/// The most flat results a core signature may carry before the result is
/// returned through linear memory.
pub const MAX_FLAT_RESULTS: usize = 1;

pub fn align_to(offset: u32, align: u32) -> u32 {
    offset.div_ceil(align) * align
}

pub fn discriminant_size(cases: usize) -> u32 {
    match cases {
        0..=256 => 1,
        257..=65536 => 2,
        _ => 4,
    }
}

/// The cases of a variant-like type after despecialization, or `None` for
/// every other type.
pub fn variant_cases(ty: &ValType) -> Option<Vec<Option<&ValType>>> {
    match ty {
        ValType::Variant(cases) => Some(cases.iter().map(|(_, ty)| ty.as_ref()).collect()),
        ValType::Enum(names) => Some(names.iter().map(|_| None).collect()),
        ValType::Option(ty) => Some(vec![None, Some(ty)]),
        ValType::Result { ok, err } => Some(vec![ok.as_deref(), err.as_deref()]),
        _ => None,
    }
}

/// The fields of a record-like type after despecialization, or `None` for
/// every other type.
pub fn record_fields(ty: &ValType) -> Option<Vec<&ValType>> {
    match ty {
        ValType::Record(fields) => Some(fields.iter().map(|(_, ty)| ty).collect()),
        ValType::Tuple(types) => Some(types.iter().collect()),
        _ => None,
    }
}

pub fn alignment(ty: &ValType) -> u32 {
    match ty {
        ValType::Bool | ValType::S8 | ValType::U8 => 1,
        ValType::S16 | ValType::U16 => 2,
        ValType::S32 | ValType::U32 | ValType::F32 | ValType::Char => 4,
        ValType::S64 | ValType::U64 | ValType::F64 => 8,
        ValType::String | ValType::List(_) => 4,
        ValType::Own(_) | ValType::Borrow(_) => 4,
        ValType::Flags(names) => flags_size(names.len()),
        _ => {
            if let Some(fields) = record_fields(ty) {
                fields
                    .iter()
                    .map(|field| alignment(field))
                    .max()
                    .unwrap_or(1)
            } else if let Some(cases) = variant_cases(ty) {
                let payload = cases.iter().flatten().map(|case| alignment(case)).max();
                discriminant_size(cases.len()).max(payload.unwrap_or(1))
            } else {
                unreachable!("every type is scalar, record-like or variant-like")
            }
        }
    }
}

fn flags_size(count: usize) -> u32 {
    match count {
        0..=8 => 1,
        9..=16 => 2,
        _ => 4,
    }
}

pub fn size(ty: &ValType) -> u32 {
    match ty {
        ValType::Bool | ValType::S8 | ValType::U8 => 1,
        ValType::S16 | ValType::U16 => 2,
        ValType::S32 | ValType::U32 | ValType::F32 | ValType::Char => 4,
        ValType::S64 | ValType::U64 | ValType::F64 => 8,
        ValType::String | ValType::List(_) => 8,
        ValType::Own(_) | ValType::Borrow(_) => 4,
        ValType::Flags(names) => flags_size(names.len()),
        _ => {
            if let Some(fields) = record_fields(ty) {
                let mut offset = 0;
                for field in &fields {
                    offset = align_to(offset, alignment(field)) + size(field);
                }
                align_to(offset, alignment(ty))
            } else if let Some(cases) = variant_cases(ty) {
                let payload_align = cases.iter().flatten().map(|case| alignment(case)).max();
                let offset = align_to(discriminant_size(cases.len()), payload_align.unwrap_or(1));
                let payload = cases
                    .iter()
                    .flatten()
                    .map(|case| size(case))
                    .max()
                    .unwrap_or(0);
                align_to(offset + payload, alignment(ty))
            } else {
                unreachable!("every type is scalar, record-like or variant-like")
            }
        }
    }
}

/// Appends the flat core types of `ty` to `out`.
pub fn flatten(ty: &ValType, out: &mut Vec<CoreType>) {
    match ty {
        ValType::Bool
        | ValType::S8
        | ValType::U8
        | ValType::S16
        | ValType::U16
        | ValType::S32
        | ValType::U32
        | ValType::Char
        | ValType::Flags(_)
        | ValType::Own(_)
        | ValType::Borrow(_) => out.push(CoreType::I32),
        ValType::S64 | ValType::U64 => out.push(CoreType::I64),
        ValType::F32 => out.push(CoreType::F32),
        ValType::F64 => out.push(CoreType::F64),
        ValType::String | ValType::List(_) => out.extend([CoreType::I32, CoreType::I32]),
        _ => {
            if let Some(fields) = record_fields(ty) {
                for field in fields {
                    flatten(field, out);
                }
            } else if let Some(cases) = variant_cases(ty) {
                let mut joined: Vec<CoreType> = Vec::new();
                for case in cases.into_iter().flatten() {
                    let mut flat = Vec::new();
                    flatten(case, &mut flat);
                    for (index, ty) in flat.into_iter().enumerate() {
                        match joined.get_mut(index) {
                            Some(existing) => *existing = existing.join(ty),
                            None => joined.push(ty),
                        }
                    }
                }
                out.push(CoreType::I32);
                out.extend(joined);
            } else {
                unreachable!("every type is scalar, record-like or variant-like")
            }
        }
    }
}

pub fn flat_types(ty: &ValType) -> Vec<CoreType> {
    let mut out = Vec::new();
    flatten(ty, &mut out);
    out
}

/// A core function signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signature {
    pub params: Vec<CoreType>,
    pub results: Vec<CoreType>,
}

fn flat_params(ty: &FuncType) -> Vec<CoreType> {
    let mut out = Vec::new();
    for (_, param) in &ty.params {
        flatten(param, &mut out);
    }
    out
}

fn flat_results(ty: &FuncType) -> Vec<CoreType> {
    ty.result.as_ref().map(flat_types).unwrap_or_default()
}

/// The core signature of the function a `canon lift` wraps.
pub fn lift_signature(ty: &FuncType) -> Signature {
    let params = flat_params(ty);
    let results = flat_results(ty);
    Signature {
        params: if params.len() > MAX_FLAT_PARAMS {
            vec![CoreType::I32]
        } else {
            params
        },
        results: if results.len() > MAX_FLAT_RESULTS {
            vec![CoreType::I32]
        } else {
            results
        },
    }
}

/// The core signature of the function a `canon lower` produces.
pub fn lower_signature(ty: &FuncType) -> Signature {
    let mut params = flat_params(ty);
    let results = flat_results(ty);
    if params.len() > MAX_FLAT_PARAMS {
        params = vec![CoreType::I32];
    }
    if results.len() > MAX_FLAT_RESULTS {
        params.push(CoreType::I32);
        return Signature {
            params,
            results: Vec::new(),
        };
    }
    Signature { params, results }
}

/// Whether a value's representation reaches into linear memory: it holds a
/// string or a list, at any depth.
pub fn contains_pointers(ty: &ValType) -> bool {
    match ty {
        ValType::String | ValType::List(_) => true,
        _ => {
            if let Some(fields) = record_fields(ty) {
                fields.into_iter().any(contains_pointers)
            } else if let Some(cases) = variant_cases(ty) {
                cases.into_iter().flatten().any(contains_pointers)
            } else {
                false
            }
        }
    }
}

/// Whether a value names a resource handle at any depth.
pub fn contains_handles(ty: &ValType) -> bool {
    match ty {
        ValType::Own(_) | ValType::Borrow(_) => true,
        ValType::List(element) => contains_handles(element),
        _ => {
            if let Some(fields) = record_fields(ty) {
                fields.into_iter().any(contains_handles)
            } else if let Some(cases) = variant_cases(ty) {
                cases.into_iter().flatten().any(contains_handles)
            } else {
                false
            }
        }
    }
}

/// Whether a value names a borrowed handle at any depth.
pub fn contains_borrows(ty: &ValType) -> bool {
    match ty {
        ValType::Borrow(_) => true,
        ValType::List(element) => contains_borrows(element),
        _ => {
            if let Some(fields) = record_fields(ty) {
                fields.into_iter().any(contains_borrows)
            } else if let Some(cases) = variant_cases(ty) {
                cases.into_iter().flatten().any(contains_borrows)
            } else {
                false
            }
        }
    }
}

/// Whether a value names a resource handle that lives only in linear memory:
/// inside a list, at any depth.
pub fn contains_handles_in_memory(ty: &ValType) -> bool {
    match ty {
        ValType::List(element) => contains_handles(element),
        _ => {
            if let Some(fields) = record_fields(ty) {
                fields.into_iter().any(contains_handles_in_memory)
            } else if let Some(cases) = variant_cases(ty) {
                cases.into_iter().flatten().any(contains_handles_in_memory)
            } else {
                false
            }
        }
    }
}

/// How a value is represented, both flat and in memory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    pub size: u32,
    pub align: u32,
    pub flat: Vec<CoreType>,
    /// The value holds a string or a list somewhere.
    pub pointers: bool,
    /// The value holds a resource handle somewhere.
    pub handles: bool,
}

impl Layout {
    /// Whether moving this value between instances needs linear memory.
    pub fn needs_memory(&self) -> bool {
        self.pointers
    }
}

pub fn layout(ty: &ValType) -> Layout {
    Layout {
        size: size(ty),
        align: alignment(ty),
        flat: flat_types(ty),
        pointers: contains_pointers(ty),
        handles: contains_handles(ty),
    }
}

/// The layout of a parameter list, which the canonical ABI treats as a record
/// of the parameters.
pub fn params_layout(params: &[(String, ValType)]) -> Layout {
    layout(&params_record(params))
}

/// The record the canonical ABI reads a parameter list as.
pub fn params_record(params: &[(String, ValType)]) -> ValType {
    ValType::Record(params.to_vec())
}

impl fmt::Display for ValType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ValType::Bool => write!(f, "bool"),
            ValType::S8 => write!(f, "s8"),
            ValType::U8 => write!(f, "u8"),
            ValType::S16 => write!(f, "s16"),
            ValType::U16 => write!(f, "u16"),
            ValType::S32 => write!(f, "s32"),
            ValType::U32 => write!(f, "u32"),
            ValType::S64 => write!(f, "s64"),
            ValType::U64 => write!(f, "u64"),
            ValType::F32 => write!(f, "f32"),
            ValType::F64 => write!(f, "f64"),
            ValType::Char => write!(f, "char"),
            ValType::String => write!(f, "string"),
            ValType::List(ty) => write!(f, "list<{ty}>"),
            ValType::Record(fields) => {
                write!(f, "record {{ ")?;
                for (index, (name, ty)) in fields.iter().enumerate() {
                    if index > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{name}: {ty}")?;
                }
                write!(f, " }}")
            }
            ValType::Tuple(types) => {
                write!(f, "tuple<")?;
                for (index, ty) in types.iter().enumerate() {
                    if index > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{ty}")?;
                }
                write!(f, ">")
            }
            ValType::Variant(cases) => {
                write!(f, "variant {{ ")?;
                for (index, (name, ty)) in cases.iter().enumerate() {
                    if index > 0 {
                        write!(f, ", ")?;
                    }
                    match ty {
                        Some(ty) => write!(f, "{name}({ty})")?,
                        None => write!(f, "{name}")?,
                    }
                }
                write!(f, " }}")
            }
            ValType::Enum(names) => write!(f, "enum {{ {} }}", names.join(", ")),
            ValType::Option(ty) => write!(f, "option<{ty}>"),
            ValType::Result { ok, err } => match (ok, err) {
                (None, None) => write!(f, "result"),
                (Some(ok), None) => write!(f, "result<{ok}>"),
                (None, Some(err)) => write!(f, "result<_, {err}>"),
                (Some(ok), Some(err)) => write!(f, "result<{ok}, {err}>"),
            },
            ValType::Flags(names) => write!(f, "flags {{ {} }}", names.join(", ")),
            ValType::Own(resource) => write!(f, "own<{}>", resource.label()),
            ValType::Borrow(resource) => write!(f, "borrow<{}>", resource.label()),
        }
    }
}

impl fmt::Display for FuncType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "func(")?;
        for (index, (name, ty)) in self.params.iter().enumerate() {
            if index > 0 {
                write!(f, ", ")?;
            }
            write!(f, "{name}: {ty}")?;
        }
        write!(f, ")")?;
        if let Some(result) = &self.result {
            write!(f, " -> {result}")?;
        }
        Ok(())
    }
}
