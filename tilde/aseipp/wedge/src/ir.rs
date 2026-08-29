// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Wedge's owned, target-independent WebAssembly IR.
//!
//! This module deliberately separates WebAssembly semantics from target
//! legalization and code generation. Functions are represented as typed SSA
//! control-flow graphs; structured source regions, effects, traps, exceptional
//! control flow, and source provenance remain explicit. Later EDGE, RISC-V,
//! and MLIR LLVM-dialect paths can therefore derive their own legal forms
//! without recovering information lost by the frontend.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;

use crate::cfg::{ControlFlowGraph, Dominators};
use crate::opcode::CoreOpcode;

macro_rules! entity_id {
    ($name:ident, $prefix:literal) => {
        #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(pub u32);

        impl $name {
            pub const fn new(index: u32) -> Self {
                Self(index)
            }

            pub const fn index(self) -> usize {
                self.0 as usize
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!($prefix, "{}"), self.0)
            }
        }
    };
}

entity_id!(TypeId, "type");
entity_id!(RecGroupId, "rec");
entity_id!(FunctionId, "func");
entity_id!(TableId, "table");
entity_id!(MemoryId, "memory");
entity_id!(GlobalId, "global");
entity_id!(TagId, "tag");
entity_id!(ElementId, "elem");
entity_id!(DataId, "data");
entity_id!(ImportId, "import");
entity_id!(LocalId, "local");
entity_id!(BlockId, "block");
entity_id!(ValueId, "%");
entity_id!(InstructionId, "inst");
entity_id!(RegionId, "region");

/// Compatibility spelling for the original prototype's value identifier.
pub use ValueId as Value;

/// A half-open byte range in the original WebAssembly binary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ByteSpan {
    pub start: u64,
    pub end: u64,
}

impl ByteSpan {
    pub const fn new(start: u64, end: u64) -> Self {
        Self { start, end }
    }

    pub const fn is_valid(self) -> bool {
        self.start <= self.end
    }
}

/// Provenance for an IR object.
///
/// `ordinal` identifies the source operator within a function. Multiple IR
/// operations may share one ordinal when one source operation is expanded.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SourceInfo {
    pub byte_span: Option<ByteSpan>,
    pub ordinal: Option<u32>,
}

impl SourceInfo {
    pub const fn new(byte_span: ByteSpan, ordinal: u32) -> Self {
        Self {
            byte_span: Some(byte_span),
            ordinal: Some(ordinal),
        }
    }

    pub const fn synthetic() -> Self {
        Self {
            byte_span: None,
            ordinal: None,
        }
    }
}

/// The language contract under which the input was validated.
///
/// Only standardized language editions belong here. Experimental proposal
/// switches are intentionally absent from the semantic IR.
/// Under `Wasm3`, a relaxed SIMD result is implementation-defined within
/// the specification's permitted set and its instruction is marked
/// `nondeterministic` in [`Effects`]. Pinning the deterministic profile is an
/// embedder decision made outside this IR.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LanguageProfile {
    #[default]
    Wasm3,
}

impl fmt::Display for LanguageProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Wasm3 => f.write_str("wasm-3.0"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ValueType {
    I32,
    I64,
    F32,
    F64,
    V128,
    Ref(RefType),
}

impl fmt::Display for ValueType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::I32 => f.write_str("i32"),
            Self::I64 => f.write_str("i64"),
            Self::F32 => f.write_str("f32"),
            Self::F64 => f.write_str("f64"),
            Self::V128 => f.write_str("v128"),
            Self::Ref(ty) => ty.fmt(f),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefType {
    pub nullable: bool,
    pub heap: HeapType,
}

impl fmt::Display for RefType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.nullable {
            write!(f, "(ref null {})", self.heap)
        } else {
            write!(f, "(ref {})", self.heap)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HeapType {
    Any,
    Eq,
    I31,
    Struct,
    Array,
    None,
    Func,
    NoFunc,
    Extern,
    NoExtern,
    Exn,
    NoExn,
    Concrete(TypeId),
}

impl fmt::Display for HeapType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Any => f.write_str("any"),
            Self::Eq => f.write_str("eq"),
            Self::I31 => f.write_str("i31"),
            Self::Struct => f.write_str("struct"),
            Self::Array => f.write_str("array"),
            Self::None => f.write_str("none"),
            Self::Func => f.write_str("func"),
            Self::NoFunc => f.write_str("nofunc"),
            Self::Extern => f.write_str("extern"),
            Self::NoExtern => f.write_str("noextern"),
            Self::Exn => f.write_str("exn"),
            Self::NoExn => f.write_str("noexn"),
            Self::Concrete(id) => write!(f, "{id}"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageType {
    I8,
    I16,
    Value(ValueType),
}

impl StorageType {
    /// The Core operand-stack type used to read or initialize this storage.
    pub fn stack_type(&self) -> ValueType {
        match self {
            Self::I8 | Self::I16 => ValueType::I32,
            Self::Value(ty) => ty.clone(),
        }
    }

    /// Whether Core's default value exists for this storage type.
    pub fn is_defaultable(&self) -> bool {
        !matches!(self, Self::Value(ValueType::Ref(reference)) if !reference.nullable)
    }

    /// Whether this storage type is accepted by the signed and unsigned GC
    /// field/array access operators.
    pub fn is_numeric_or_vector(&self) -> bool {
        match self {
            Self::I8 | Self::I16 => true,
            Self::Value(ty) => !matches!(ty, ValueType::Ref(_)),
        }
    }

    /// Whether a value in this storage type can be copied into `expected` by
    /// Core GC's storage-subtyping rules.
    pub fn is_subtype_of(&self, types: &[TypeDefinition], expected: &Self) -> bool {
        match (self, expected) {
            (Self::I8, Self::I8) | (Self::I16, Self::I16) => true,
            (Self::Value(actual), Self::Value(expected)) => {
                is_value_subtype(types, actual, expected)
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FieldType {
    pub storage: StorageType,
    pub mutable: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FunctionType {
    pub params: Vec<ValueType>,
    pub results: Vec<ValueType>,
}

impl fmt::Display for FunctionType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("func")?;
        if !self.params.is_empty() {
            f.write_str(" (param")?;
            for ty in &self.params {
                write!(f, " {ty}")?;
            }
            f.write_str(")")?;
        }
        if !self.results.is_empty() {
            f.write_str(" (result")?;
            for ty in &self.results {
                write!(f, " {ty}")?;
            }
            f.write_str(")")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompositeType {
    Function(FunctionType),
    Struct(Vec<FieldType>),
    Array(FieldType),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TypeDefinition {
    /// The earlier module type declaration that is canonically equivalent to
    /// this one, or `None` when this definition represents its equivalence
    /// class.
    ///
    /// This preserves every original module type index while recording the
    /// structural equivalence computed during Core validation. It is distinct
    /// from the explicitly declared nominal [`Self::supertype`] edge.
    pub canonical_alias: Option<TypeId>,
    pub final_: bool,
    pub supertype: Option<TypeId>,
    pub composite: CompositeType,
    pub source: SourceInfo,
}

// This is part of Core Wasm's validation limits. Keep it explicit here because
// `wasmparser` does not publicly export its internal limits module, while the
// owned IR verifier must reject forged hierarchies that could not be decoded.
const MAX_NOMINAL_SUBTYPE_DEPTH: usize = 63;

/// Returns whether `actual` is a subtype of `expected` in `types`.
///
/// The nominal edges in `types` are expected to have already passed module
/// validation. This query is nevertheless cycle-safe so that it can also be
/// used while verifying hand-constructed IR.
pub fn is_value_subtype(
    types: &[TypeDefinition],
    actual: &ValueType,
    expected: &ValueType,
) -> bool {
    match (actual, expected) {
        (ValueType::Ref(actual), ValueType::Ref(expected)) => {
            is_ref_subtype(types, actual, expected)
        }
        _ => actual == expected,
    }
}

/// Returns whether two value types denote the same canonical Core type.
pub fn are_value_types_equivalent(
    types: &[TypeDefinition],
    left: &ValueType,
    right: &ValueType,
) -> bool {
    is_value_subtype(types, left, right) && is_value_subtype(types, right, left)
}

/// Returns whether `actual` is a reference subtype of `expected` in `types`.
pub fn is_ref_subtype(types: &[TypeDefinition], actual: &RefType, expected: &RefType) -> bool {
    (!actual.nullable || expected.nullable) && is_heap_subtype(types, &actual.heap, &expected.heap)
}

/// Returns whether `actual` is a heap subtype of `expected` in `types`.
pub fn is_heap_subtype(types: &[TypeDefinition], actual: &HeapType, expected: &HeapType) -> bool {
    if actual == expected {
        return true;
    }

    match actual {
        HeapType::None => match expected {
            HeapType::Any | HeapType::Eq | HeapType::I31 | HeapType::Struct | HeapType::Array => {
                true
            }
            HeapType::Concrete(id) => types.get(id.index()).is_some_and(|definition| {
                !matches!(definition.composite, CompositeType::Function(_))
            }),
            _ => false,
        },
        HeapType::I31 => matches!(expected, HeapType::Eq | HeapType::Any),
        HeapType::Struct | HeapType::Array => matches!(expected, HeapType::Eq | HeapType::Any),
        HeapType::Eq => matches!(expected, HeapType::Any),
        HeapType::NoFunc => match expected {
            HeapType::Func => true,
            HeapType::Concrete(id) => is_function_type(types, *id),
            _ => false,
        },
        HeapType::NoExtern => matches!(expected, HeapType::Extern),
        HeapType::NoExn => matches!(expected, HeapType::Exn),
        HeapType::Concrete(actual) => match expected {
            HeapType::Concrete(expected) => is_nominal_type_subtype(types, *actual, *expected),
            HeapType::Func => is_function_type(types, *actual),
            HeapType::Struct => types
                .get(actual.index())
                .is_some_and(|definition| matches!(definition.composite, CompositeType::Struct(_))),
            HeapType::Array => types
                .get(actual.index())
                .is_some_and(|definition| matches!(definition.composite, CompositeType::Array(_))),
            HeapType::Eq | HeapType::Any => types.get(actual.index()).is_some_and(|definition| {
                !matches!(definition.composite, CompositeType::Function(_))
            }),
            _ => false,
        },
        HeapType::Any | HeapType::Func | HeapType::Extern | HeapType::Exn => false,
    }
}

/// Returns whether `actual` reaches `expected` through nominal supertype edges.
pub fn is_nominal_type_subtype(types: &[TypeDefinition], actual: TypeId, expected: TypeId) -> bool {
    let Some(expected) = canonical_type_id(types, expected) else {
        return false;
    };
    let Some(mut cursor) = canonical_type_id(types, actual) else {
        return false;
    };
    let mut visited = BTreeSet::new();
    while visited.insert(cursor) {
        if cursor == expected {
            return true;
        }
        let Some(supertype) = types
            .get(cursor.index())
            .and_then(|definition| definition.supertype)
        else {
            return false;
        };
        let Some(canonical_supertype) = canonical_type_id(types, supertype) else {
            return false;
        };
        cursor = canonical_supertype;
    }
    false
}

/// Returns whether a composite type structurally matches a declared
/// supertype.
///
/// Core Wasm requires every individual nominal subtype edge to satisfy these
/// structural rules. Nominal reference subtyping is still used within the
/// composite types, which is what permits recursive structures to refine
/// references to themselves.
fn composite_type_is_declared_subtype(
    types: &[TypeDefinition],
    actual: &CompositeType,
    expected: &CompositeType,
) -> bool {
    match (actual, expected) {
        (CompositeType::Function(actual), CompositeType::Function(expected)) => {
            function_type_is_declared_subtype(types, actual, expected)
        }
        (CompositeType::Struct(actual), CompositeType::Struct(expected)) => {
            actual.len() >= expected.len()
                && actual
                    .iter()
                    .zip(expected)
                    .all(|(actual, expected)| field_type_is_subtype(types, actual, expected))
        }
        (CompositeType::Array(actual), CompositeType::Array(expected)) => {
            field_type_is_subtype(types, actual, expected)
        }
        _ => false,
    }
}

fn function_type_is_declared_subtype(
    types: &[TypeDefinition],
    actual: &FunctionType,
    expected: &FunctionType,
) -> bool {
    actual.params.len() == expected.params.len()
        && actual.results.len() == expected.results.len()
        // Function parameters are contravariant.
        && actual
            .params
            .iter()
            .zip(&expected.params)
            .all(|(actual, expected)| is_value_subtype(types, expected, actual))
        // Function results are covariant.
        && actual
            .results
            .iter()
            .zip(&expected.results)
            .all(|(actual, expected)| is_value_subtype(types, actual, expected))
}

fn field_type_is_subtype(
    types: &[TypeDefinition],
    actual: &FieldType,
    expected: &FieldType,
) -> bool {
    if !storage_type_is_subtype(types, &actual.storage, &expected.storage) {
        return false;
    }

    match (actual.mutable, expected.mutable) {
        // Immutable fields are covariant.
        (false, false) => true,
        // Mutable fields are invariant.
        (true, true) => storage_type_is_subtype(types, &expected.storage, &actual.storage),
        _ => false,
    }
}

fn storage_type_is_subtype(
    types: &[TypeDefinition],
    actual: &StorageType,
    expected: &StorageType,
) -> bool {
    match (actual, expected) {
        (StorageType::I8, StorageType::I8) | (StorageType::I16, StorageType::I16) => true,
        (StorageType::Value(actual), StorageType::Value(expected)) => {
            is_value_subtype(types, actual, expected)
        }
        _ => false,
    }
}

/// Resolves a module type index to its canonical equivalence representative.
///
/// Invalid or chained aliases return `None`. Canonical aliases are deliberately
/// one hop so subtype queries remain deterministic and cycle-safe even for
/// hand-constructed IR that has not passed [`Program::verify`].
pub fn canonical_type_id(types: &[TypeDefinition], id: TypeId) -> Option<TypeId> {
    let definition = types.get(id.index())?;
    let Some(representative) = definition.canonical_alias else {
        return Some(id);
    };
    if representative.index() >= id.index() {
        return None;
    }
    let representative_definition = types.get(representative.index())?;
    if representative_definition.canonical_alias.is_some() {
        return None;
    }
    Some(representative)
}

/// Whether two type indices denote the same Core type: each is a nominal
/// subtype of the other.
pub fn are_type_ids_equivalent(types: &[TypeDefinition], left: TypeId, right: TypeId) -> bool {
    is_nominal_type_subtype(types, left, right) && is_nominal_type_subtype(types, right, left)
}

/// Whether two tag indices may denote one tag instance at run time.
///
/// A tag defined by the module is a fresh instance, so it aliases only
/// itself. Two imported tags may be satisfied by the same instance whenever
/// their declared types are equivalent, and nothing in the module can tell
/// them apart, so a throw of one may be caught by a clause naming the other.
/// Compiled modules carry wasmparser's canonical type aliases; a hand-built
/// program that omits the alias between structurally equal types is treated
/// as non-aliasing.
pub fn tags_may_alias(types: &[TypeDefinition], tags: &[Tag], left: TagId, right: TagId) -> bool {
    if left == right {
        return true;
    }
    let (Some(left), Some(right)) = (tags.get(left.index()), tags.get(right.index())) else {
        return false;
    };
    matches!(left.origin, EntityOrigin::Imported(_))
        && matches!(right.origin, EntityOrigin::Imported(_))
        && are_type_ids_equivalent(types, left.ty.signature, right.ty.signature)
}

/// How one catch clause relates to a statically known thrown tag.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClauseMatch {
    /// The clause always catches the exception.
    Definite,
    /// The clause catches the exception when its imported tag turns out to
    /// be the thrown instance.
    Possible,
    /// The clause never catches the exception.
    Never,
}

pub fn known_throw_clause_match(
    types: &[TypeDefinition],
    tags: &[Tag],
    catch: &CatchClause,
    thrown: TagId,
) -> ClauseMatch {
    match catch.kind {
        CatchKind::CatchAll | CatchKind::CatchAllRef => ClauseMatch::Definite,
        CatchKind::Catch | CatchKind::CatchRef => match catch.tag {
            Some(tag) if tag == thrown => ClauseMatch::Definite,
            Some(tag) if tags_may_alias(types, tags, tag, thrown) => ClauseMatch::Possible,
            _ => ClauseMatch::Never,
        },
    }
}

fn canonical_type_definitions_match(
    types: &[TypeDefinition],
    left: &TypeDefinition,
    right: &TypeDefinition,
) -> bool {
    left.final_ == right.final_
        && canonical_supertypes_match(types, left.supertype, right.supertype)
        && canonical_composite_types_match(types, &left.composite, &right.composite)
}

fn canonical_supertypes_match(
    types: &[TypeDefinition],
    left: Option<TypeId>,
    right: Option<TypeId>,
) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => match (
            canonical_type_id(types, left),
            canonical_type_id(types, right),
        ) {
            (Some(left), Some(right)) => left == right,
            _ => false,
        },
        _ => false,
    }
}

fn canonical_composite_types_match(
    types: &[TypeDefinition],
    left: &CompositeType,
    right: &CompositeType,
) -> bool {
    match (left, right) {
        (CompositeType::Function(left), CompositeType::Function(right)) => {
            canonical_value_types_match(types, &left.params, &right.params)
                && canonical_value_types_match(types, &left.results, &right.results)
        }
        (CompositeType::Struct(left), CompositeType::Struct(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| canonical_field_types_match(types, left, right))
        }
        (CompositeType::Array(left), CompositeType::Array(right)) => {
            canonical_field_types_match(types, left, right)
        }
        _ => false,
    }
}

fn canonical_field_types_match(
    types: &[TypeDefinition],
    left: &FieldType,
    right: &FieldType,
) -> bool {
    left.mutable == right.mutable
        && match (&left.storage, &right.storage) {
            (StorageType::I8, StorageType::I8) | (StorageType::I16, StorageType::I16) => true,
            (StorageType::Value(left), StorageType::Value(right)) => {
                canonical_value_type_matches(types, left, right)
            }
            _ => false,
        }
}

fn canonical_value_types_match(
    types: &[TypeDefinition],
    left: &[ValueType],
    right: &[ValueType],
) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| canonical_value_type_matches(types, left, right))
}

fn canonical_value_type_matches(
    types: &[TypeDefinition],
    left: &ValueType,
    right: &ValueType,
) -> bool {
    match (left, right) {
        (ValueType::Ref(left), ValueType::Ref(right)) => {
            left.nullable == right.nullable
                && canonical_heap_type_matches(types, &left.heap, &right.heap)
        }
        _ => left == right,
    }
}

fn canonical_heap_type_matches(
    types: &[TypeDefinition],
    left: &HeapType,
    right: &HeapType,
) -> bool {
    match (left, right) {
        (HeapType::Concrete(left), HeapType::Concrete(right)) => {
            match (
                canonical_type_id(types, *left),
                canonical_type_id(types, *right),
            ) {
                (Some(left), Some(right)) => left == right,
                _ => false,
            }
        }
        _ => left == right,
    }
}

fn is_function_type(types: &[TypeDefinition], id: TypeId) -> bool {
    types
        .get(id.index())
        .is_some_and(|definition| matches!(definition.composite, CompositeType::Function(_)))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecGroup {
    pub types: Vec<TypeId>,
    pub source: SourceInfo,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AddressType {
    I32,
    I64,
}

impl AddressType {
    pub const fn value_type(self) -> ValueType {
        match self {
            Self::I32 => ValueType::I32,
            Self::I64 => ValueType::I64,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    pub min: u64,
    pub max: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TableType {
    pub element: RefType,
    pub limits: Limits,
    pub address_type: AddressType,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MemoryType {
    pub limits: Limits,
    pub address_type: AddressType,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalType {
    pub value: ValueType,
    pub mutable: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TagType {
    pub signature: TypeId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Immediate {
    U32(u32),
    U64(u64),
    S32(i32),
    S64(i64),
    F32(u32),
    F64(u64),
    V128([u8; 16]),
    Lane(u8),
    Bytes(Vec<u8>),
    Type(TypeId),
    Function(FunctionId),
    Table(TableId),
    Memory(MemoryId),
    Global(GlobalId),
    Tag(TagId),
    Element(ElementId),
    Data(DataId),
    Local(LocalId),
    Region(RegionId),
    ValueType(ValueType),
    HeapType(HeapType),
    MemoryArgument(MemoryArgument),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MemoryArgument {
    pub memory: MemoryId,
    pub offset: u64,
    pub alignment_log2: u8,
}

/// The semantic namespace containing an operation.
///
/// Core operators have an owned, machine-checkable identity derived from
/// `wasmparser`'s operator inventory. Synthetic operators are Wedge-specific
/// operations introduced while lowering or transforming the IR.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationKind {
    Core(CoreOpcode),
    Synthetic,
}

/// A typed semantic operation.
///
/// `mnemonic` is the canonical Core WebAssembly text mnemonic for a
/// [`OperationKind::Core`] operation and a stable Wedge name for a synthetic
/// one. Immediates are structured and entity references are strongly typed.
/// The signature is instantiated for this occurrence (for example, for a
/// typed `select` or a call) and is checked by [`Program::verify`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Operation {
    pub kind: OperationKind,
    /// Borrowed from the opcode table for Core operations and owned only
    /// by synthetic ones.
    pub mnemonic: Cow<'static, str>,
    pub immediates: Vec<Immediate>,
    pub signature: FunctionType,
}

impl Operation {
    pub fn new(
        mnemonic: impl Into<String>,
        params: Vec<ValueType>,
        results: Vec<ValueType>,
    ) -> Self {
        let mnemonic = mnemonic.into();
        let (kind, mnemonic) = match CoreOpcode::from_mnemonic(&mnemonic) {
            Some(opcode) => (
                OperationKind::Core(opcode),
                Cow::Borrowed(opcode.mnemonic()),
            ),
            None => (OperationKind::Synthetic, Cow::Owned(mnemonic)),
        };
        Self {
            kind,
            mnemonic,
            immediates: Vec::new(),
            signature: FunctionType { params, results },
        }
    }

    /// Construct an operation with a standardized Core Wasm identity.
    pub fn core(opcode: CoreOpcode, params: Vec<ValueType>, results: Vec<ValueType>) -> Self {
        Self {
            kind: OperationKind::Core(opcode),
            mnemonic: Cow::Borrowed(opcode.mnemonic()),
            immediates: Vec::new(),
            signature: FunctionType { params, results },
        }
    }

    /// Construct a compiler-specific operation.
    ///
    /// [`Program::verify`] rejects canonical Core mnemonics in this namespace,
    /// so a synthetic operation cannot impersonate a standardized operator.
    pub fn synthetic(
        mnemonic: impl Into<String>,
        params: Vec<ValueType>,
        results: Vec<ValueType>,
    ) -> Self {
        Self {
            kind: OperationKind::Synthetic,
            mnemonic: Cow::Owned(mnemonic.into()),
            immediates: Vec::new(),
            signature: FunctionType { params, results },
        }
    }

    pub fn with_immediates(mut self, immediates: Vec<Immediate>) -> Self {
        self.immediates = immediates;
        self
    }

    pub fn mnemonic(&self) -> &str {
        &self.mnemonic
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConstInstruction {
    pub operation: Operation,
    pub source: SourceInfo,
}

/// A validated constant expression in stack form.
///
/// Keeping the original operation sequence preserves extended-constant
/// semantics and source order. The verifier independently stack-types it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConstExpr {
    pub instructions: Vec<ConstInstruction>,
    /// The exact type left on the expression's stack.
    pub result_type: ValueType,
    pub source: SourceInfo,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntityOrigin {
    Imported(ImportId),
    Defined,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Import {
    pub module: String,
    pub name: String,
    pub item: ImportItem,
    pub source: SourceInfo,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImportItem {
    Function(FunctionId),
    Table(TableId),
    Memory(MemoryId),
    Global(GlobalId),
    Tag(TagId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Function {
    /// Original function-index-space index, retained for diagnostics.
    pub wasm_index: u32,
    pub ty: TypeId,
    pub origin: EntityOrigin,
    /// All WebAssembly locals in local-index order, including parameters.
    pub locals: Vec<ValueType>,
    pub body: Option<FunctionBody>,
    pub source: SourceInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Table {
    pub ty: TableType,
    pub origin: EntityOrigin,
    pub initializer: Option<ConstExpr>,
    pub source: SourceInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Memory {
    pub ty: MemoryType,
    pub origin: EntityOrigin,
    pub source: SourceInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Global {
    pub ty: GlobalType,
    pub origin: EntityOrigin,
    pub initializer: Option<ConstExpr>,
    pub source: SourceInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Tag {
    pub ty: TagType,
    pub origin: EntityOrigin,
    pub source: SourceInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Element {
    pub ty: RefType,
    pub mode: ElementMode,
    pub items: Vec<ElementItem>,
    pub source: SourceInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ElementMode {
    Passive,
    Declarative,
    Active { table: TableId, offset: ConstExpr },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ElementItem {
    Function(FunctionId),
    Expression(ConstExpr),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataSegment {
    pub mode: DataMode,
    pub bytes: Vec<u8>,
    pub source: SourceInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataMode {
    Passive,
    Active { memory: MemoryId, offset: ConstExpr },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExportKind {
    Function,
    Table,
    Memory,
    Global,
    Tag,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExportItem {
    Function(FunctionId),
    Table(TableId),
    Memory(MemoryId),
    Global(GlobalId),
    Tag(TagId),
}

impl ExportItem {
    pub const fn kind(self) -> ExportKind {
        match self {
            Self::Function(_) => ExportKind::Function,
            Self::Table(_) => ExportKind::Table,
            Self::Memory(_) => ExportKind::Memory,
            Self::Global(_) => ExportKind::Global,
            Self::Tag(_) => ExportKind::Tag,
        }
    }

    pub const fn index(self) -> u32 {
        match self {
            Self::Function(id) => id.0,
            Self::Table(id) => id.0,
            Self::Memory(id) => id.0,
            Self::Global(id) => id.0,
            Self::Tag(id) => id.0,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Export {
    pub name: String,
    pub item: ExportItem,
    pub source: SourceInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CustomSection {
    pub name: String,
    pub data: Vec<u8>,
    pub source: SourceInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Producer {
    pub field: String,
    pub name: String,
    pub version: String,
}

/// Decoded standard metadata plus opaque custom-section retention.
///
/// The frontend decodes the module, function, and local names of a `name`
/// section and every `producers` field; it retains any other custom section,
/// and a standard one it cannot decode, as raw bytes in `custom_sections`.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModuleMetadata {
    pub module_name: Option<String>,
    pub function_names: BTreeMap<FunctionId, String>,
    pub local_names: BTreeMap<(FunctionId, LocalId), String>,
    pub producers: Vec<Producer>,
    pub custom_sections: Vec<CustomSection>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValueDefinition {
    pub id: ValueId,
    pub ty: ValueType,
}

impl ValueDefinition {
    pub const fn new(id: ValueId, ty: ValueType) -> Self {
        Self { id, ty }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectAccess {
    Read,
    Write,
    ReadWrite,
}

impl EffectAccess {
    pub const fn writes(self) -> bool {
        matches!(self, Self::Write | Self::ReadWrite)
    }

    /// Whether this access is no stronger than `other`.
    pub const fn is_within(self, other: Self) -> bool {
        matches!(
            (self, other),
            (_, Self::ReadWrite) | (Self::Read, Self::Read) | (Self::Write, Self::Write)
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectResource {
    Memory(MemoryId),
    Table(TableId),
    Global(GlobalId),
    /// Immutable bytes plus the live/dropped state of one data segment.
    DataSegment(DataId),
    /// Immutable items plus the live/dropped state of one element segment.
    ElementSegment(ElementId),
    /// Every managed object, as one resource: any GC write conflicts with
    /// any GC read or write until a later analysis disambiguates objects.
    GcHeap,
    /// Opaque external or unanalyzed-callee state, which may alias every
    /// other resource.
    ///
    /// A write to it is a full barrier: no access may be reordered across
    /// it. A pass with an interprocedural summary may replace it with the
    /// precise resources it proves, since stored effects may be narrowed.
    Host,
}

impl EffectResource {
    /// Whether two resources may name overlapping state.
    pub fn may_alias(self, other: Self) -> bool {
        self == other || matches!(self, Self::Host) || matches!(other, Self::Host)
    }

    /// Whether a canonical effect on this resource accounts for a stored
    /// effect on `other`.
    pub fn covers(self, other: Self) -> bool {
        self == other || matches!(self, Self::Host)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Effect {
    pub resource: EffectResource,
    pub access: EffectAccess,
}

impl Effect {
    /// Whether two accesses may not be reordered: their resources may alias
    /// and at least one of them writes.
    pub fn conflicts_with(self, other: Self) -> bool {
        self.resource.may_alias(other.resource) && (self.access.writes() || other.access.writes())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TrapCode {
    Unreachable,
    IntegerDivideByZero,
    IntegerOverflow,
    InvalidConversionToInteger,
    MemoryOutOfBounds,
    TableOutOfBounds,
    IndirectCallTypeMismatch,
    NullReference,
    NullFunctionReference,
    BadArrayElement,
    AllocationFailure,
    StackOverflow,
    Other(String),
}

/// A path fact about one argument slot of a conditional edge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Refinement {
    pub slot: u32,
    /// The type the argument is known to have on this edge, which the target
    /// parameter may assume.
    pub proven: ValueType,
}

impl fmt::Display for Refinement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.slot, self.proven)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Edge {
    pub target: BlockId,
    pub arguments: Vec<ValueId>,
    /// Argument slots whose types are refined by the containing conditional
    /// branch's predicate on this particular edge, each with the type proven
    /// on this path.
    ///
    /// The argument remains the original SSA value. Its target block
    /// parameter is the path-local SSA definition with the refined type. The
    /// fact is self-describing so consumers never re-derive it; verification
    /// permits it only on an edge of [`TerminatorKind::Branch`] whose
    /// condition is defined by a dominating `ref.is_null` or `ref.test` of
    /// the same value, requires the stored type to be implied by that
    /// predicate's outcome, and requires it to be a subtype of the target
    /// parameter.
    pub refinements: Vec<Refinement>,
}

impl Edge {
    pub fn new(target: BlockId, arguments: Vec<ValueId>) -> Self {
        Self {
            target,
            arguments,
            refinements: Vec::new(),
        }
    }

    pub fn with_refinement(mut self, slot: u32, proven: ValueType) -> Self {
        self.refinements.push(Refinement { slot, proven });
        self
    }

    pub fn refinement(&self, slot: usize) -> Option<&Refinement> {
        self.refinements
            .iter()
            .find(|refinement| refinement.slot as usize == slot)
    }
}

/// The provenance of one argument delivered along an exceptional edge.
///
/// Unlike an ordinary CFG edge, an exceptional edge can produce values that
/// have no definition on the throwing path: tag payload fields and the caught
/// exception reference are materialized by exception dispatch itself. Keeping
/// that provenance explicit avoids inventing ordinary SSA definitions for
/// values which exist only on one exceptional successor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExceptionalArgument {
    /// An ordinary SSA value, including the local-state snapshot at the throw
    /// point and known payload values from an explicit `throw`.
    Value(ValueId),
    /// A dynamically caught tagged payload field.
    CaughtPayload { index: u32, ty: ValueType },
    /// The non-null exception reference produced by a `_ref` catch clause.
    CaughtException,
}

/// One ordered catch arm in a terminator's exceptional dispatch table.
///
/// `target` is the block the arm transfers to and is the control-flow
/// authority. The referenced `try_table` region and clause are retained
/// source structure: they determine the catch kind and tag, and the verifier
/// cross-checks the clause's target against `target`. `arguments` correspond
/// one-for-one with the target's parameters: catch payload provenance comes
/// first, followed by ordinary SSA values for any local parameters introduced
/// by sealed SSA.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExceptionalEdge {
    pub handler: RegionId,
    pub clause: u32,
    pub target: BlockId,
    pub arguments: Vec<ExceptionalArgument>,
}

impl ExceptionalEdge {
    pub fn new(
        handler: RegionId,
        clause: u32,
        target: BlockId,
        arguments: Vec<ExceptionalArgument>,
    ) -> Self {
        Self {
            handler,
            clause,
            target,
            arguments,
        }
    }
}

/// Ordered in-function catch routing for one exceptional point.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExceptionRouting {
    pub arms: Vec<ExceptionalEdge>,
    /// Whether an exception which matches none of `arms` escapes the function.
    pub escapes: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExceptionEffect {
    None,
    /// The operation may throw a WebAssembly exception.
    ///
    /// An instruction's exception always escapes the function. An operation
    /// whose exception can reach an in-function handler is lowered as a
    /// [`TerminatorKind::Invoke`] terminator, which carries the routing on its
    /// [`Terminator`].
    MayThrow,
}

impl Default for ExceptionEffect {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Effects {
    pub accesses: Vec<Effect>,
    pub traps: Vec<TrapCode>,
    pub exception: ExceptionEffect,
    pub allocates: bool,
    /// The result is one of several implementation-defined values, as for
    /// relaxed SIMD. This is not a state effect and takes no part in
    /// [`Effects::conflicts_with`]; it tells constant folding and any
    /// consumer that requires reproducible execution that the operation's
    /// value is not pinned by the IR.
    pub nondeterministic: bool,
}

impl Effects {
    pub const fn pure() -> Self {
        Self {
            accesses: Vec::new(),
            traps: Vec::new(),
            exception: ExceptionEffect::None,
            allocates: false,
            nondeterministic: false,
        }
    }

    pub fn is_pure(&self) -> bool {
        !self.has_state_effects() && self.exception == ExceptionEffect::None
    }

    /// Whether anything but the exception flag is set.
    pub fn has_state_effects(&self) -> bool {
        !self.accesses.is_empty()
            || !self.traps.is_empty()
            || self.allocates
            || self.nondeterministic
    }

    /// Whether these effects write opaque host state, across which no access
    /// may be reordered.
    pub fn is_barrier(&self) -> bool {
        self.accesses
            .iter()
            .any(|effect| matches!(effect.resource, EffectResource::Host) && effect.access.writes())
    }

    /// Whether two effect sets may not be reordered with respect to each
    /// other: a pair of accesses to aliasing resources with at least one
    /// writer, or an allocation on one side against opaque host state on the
    /// other. Traps, exceptions, and nondeterminism are control facts that the
    /// CFG carries and take no part here.
    pub fn conflicts_with(&self, other: &Effects) -> bool {
        let touches_host = |effects: &Effects| {
            effects
                .accesses
                .iter()
                .any(|effect| matches!(effect.resource, EffectResource::Host))
        };
        self.accesses.iter().any(|left| {
            other
                .accesses
                .iter()
                .any(|right| left.conflicts_with(*right))
        }) || (self.allocates && touches_host(other))
            || (other.allocates && touches_host(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Instruction {
    pub id: InstructionId,
    pub operation: Operation,
    pub operands: Vec<ValueId>,
    /// Values produced on normal completion.
    pub results: Vec<ValueDefinition>,
    pub effects: Effects,
    pub source: SourceInfo,
}

impl Instruction {
    pub fn new(
        id: InstructionId,
        operation: Operation,
        operands: Vec<ValueId>,
        results: Vec<ValueDefinition>,
        source: SourceInfo,
    ) -> Self {
        Self {
            id,
            operation,
            operands,
            results,
            effects: Effects::pure(),
            source,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Callee {
    Direct(FunctionId),
    Indirect {
        ty: TypeId,
        table: TableId,
        index: ValueId,
    },
    Reference {
        ty: TypeId,
        reference: ValueId,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminatorKind {
    Jump(Edge),
    Branch {
        condition: ValueId,
        then_edge: Edge,
        else_edge: Edge,
    },
    Switch {
        selector: ValueId,
        targets: Vec<Edge>,
        default: Edge,
    },
    /// An operation whose exception can reach an in-function handler.
    ///
    /// The operation ends its block at the precise throw point. Its results
    /// are the leading parameters of `normal`'s target, so `normal.arguments`
    /// supply only the parameters after that prefix, and the exceptional arms
    /// live in the containing [`Terminator`]'s routing. `effects` are the
    /// operation's stored effects, verified against the canonical ones like
    /// an instruction's.
    Invoke {
        operation: Operation,
        operands: Vec<ValueId>,
        effects: Effects,
        normal: Edge,
    },
    Return {
        values: Vec<ValueId>,
    },
    TailCall {
        callee: Callee,
        arguments: Vec<ValueId>,
    },
    Throw {
        tag: TagId,
        arguments: Vec<ValueId>,
    },
    ThrowRef {
        exception: ValueId,
    },
    Unreachable {
        trap: TrapCode,
    },
}

impl TerminatorKind {
    /// The ordinary edges in their fixed order: the jump or invoke
    /// continuation, `then` before `else`, switch cases before the default.
    pub fn edges(&self) -> impl DoubleEndedIterator<Item = &Edge> {
        let (first, cases, last) = match self {
            Self::Jump(edge) => (Some(edge), &[][..], None),
            Self::Invoke { normal, .. } => (Some(normal), &[][..], None),
            Self::Branch {
                then_edge,
                else_edge,
                ..
            } => (Some(then_edge), &[][..], Some(else_edge)),
            Self::Switch {
                targets, default, ..
            } => (None, targets.as_slice(), Some(default)),
            Self::Return { .. }
            | Self::TailCall { .. }
            | Self::Throw { .. }
            | Self::ThrowRef { .. }
            | Self::Unreachable { .. } => (None, &[][..], None),
        };
        first.into_iter().chain(cases).chain(last)
    }

    /// [`Self::edges`] with mutable access, in the same order.
    pub fn edges_mut(&mut self) -> impl DoubleEndedIterator<Item = &mut Edge> {
        let (first, cases, last) = match self {
            Self::Jump(edge) => (Some(edge), &mut [][..], None),
            Self::Invoke { normal, .. } => (Some(normal), &mut [][..], None),
            Self::Branch {
                then_edge,
                else_edge,
                ..
            } => (Some(then_edge), &mut [][..], Some(else_edge)),
            Self::Switch {
                targets, default, ..
            } => (None, targets.as_mut_slice(), Some(default)),
            Self::Return { .. }
            | Self::TailCall { .. }
            | Self::Throw { .. }
            | Self::ThrowRef { .. }
            | Self::Unreachable { .. } => (None, &mut [][..], None),
        };
        first.into_iter().chain(cases).chain(last)
    }

    /// The targets of [`Self::edges`], one per edge occurrence.
    pub fn targets(&self) -> impl DoubleEndedIterator<Item = BlockId> + '_ {
        self.edges().map(|edge| edge.target)
    }

    /// The number of target parameters that precede every edge's arguments:
    /// an invoke's results lead its continuation's parameters, so its normal
    /// edge supplies only the parameters after them.
    pub fn leading_parameters(&self) -> usize {
        match self {
            Self::Invoke { operation, .. } => operation.signature.results.len(),
            _ => 0,
        }
    }
}

impl TerminatorKind {
    /// Every value the terminator reads, in a fixed order: the condition,
    /// selector, operands, callee, or returned and thrown values first, then
    /// the arguments of each edge in [`Self::edges`] order.
    pub fn for_each_use(&self, mut f: impl FnMut(ValueId)) {
        match self {
            Self::Jump(_) | Self::Unreachable { .. } => {}
            Self::Branch { condition, .. } => f(*condition),
            Self::Switch { selector, .. } => f(*selector),
            Self::Invoke { operands, .. } => operands.iter().copied().for_each(&mut f),
            Self::Return { values } => values.iter().copied().for_each(&mut f),
            Self::TailCall { callee, arguments } => {
                match callee {
                    Callee::Direct(_) => {}
                    Callee::Indirect { index, .. } => f(*index),
                    Callee::Reference { reference, .. } => f(*reference),
                }
                arguments.iter().copied().for_each(&mut f);
            }
            Self::Throw { arguments, .. } => arguments.iter().copied().for_each(&mut f),
            Self::ThrowRef { exception } => f(*exception),
        }
        for edge in self.edges() {
            edge.arguments.iter().copied().for_each(&mut f);
        }
    }

    /// [`Self::for_each_use`] with mutable access, in the same order, so a
    /// pass can rename every value the terminator reads.
    pub fn for_each_use_mut(&mut self, mut f: impl FnMut(&mut ValueId)) {
        match self {
            Self::Jump(_) | Self::Unreachable { .. } => {}
            Self::Branch { condition, .. } => f(condition),
            Self::Switch { selector, .. } => f(selector),
            Self::Invoke { operands, .. } => operands.iter_mut().for_each(&mut f),
            Self::Return { values } => values.iter_mut().for_each(&mut f),
            Self::TailCall { callee, arguments } => {
                match callee {
                    Callee::Direct(_) => {}
                    Callee::Indirect { index, .. } => f(index),
                    Callee::Reference { reference, .. } => f(reference),
                }
                arguments.iter_mut().for_each(&mut f);
            }
            Self::Throw { arguments, .. } => arguments.iter_mut().for_each(&mut f),
            Self::ThrowRef { exception } => f(exception),
        }
        for edge in self.edges_mut() {
            edge.arguments.iter_mut().for_each(&mut f);
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Terminator {
    pub kind: TerminatorKind,
    /// Exceptional dispatch for `invoke`, `throw`, `throw_ref`, and tail
    /// calls; absent for non-throwing terminators. An invoke always has at
    /// least one arm, and tail calls always carry an escape-only route because
    /// their caller, not this function, observes an exception.
    pub exception: Option<ExceptionRouting>,
    pub source: SourceInfo,
}

impl Terminator {
    pub fn new(kind: TerminatorKind, source: SourceInfo) -> Self {
        let exception = matches!(
            &kind,
            TerminatorKind::Invoke { .. }
                | TerminatorKind::TailCall { .. }
                | TerminatorKind::Throw { .. }
                | TerminatorKind::ThrowRef { .. }
        )
        .then(|| ExceptionRouting {
            arms: Vec::new(),
            escapes: true,
        });
        Self {
            kind,
            exception,
            source,
        }
    }

    pub fn with_exception_routing(mut self, routing: ExceptionRouting) -> Self {
        self.exception = Some(routing);
        self
    }

    /// The in-function exceptional arms, empty for a non-throwing terminator.
    pub fn exceptional_arms(&self) -> &[ExceptionalEdge] {
        self.exception
            .as_ref()
            .map_or(&[], |routing| routing.arms.as_slice())
    }

    pub fn return_(values: Vec<ValueId>, source: SourceInfo) -> Self {
        Self::new(TerminatorKind::Return { values }, source)
    }
}

impl Terminator {
    /// Every value the terminator reads: those of its kind, then the
    /// ordinary SSA values its exceptional arms deliver.
    pub fn for_each_use(&self, mut f: impl FnMut(ValueId)) {
        self.kind.for_each_use(&mut f);
        for arm in self.exceptional_arms() {
            for argument in &arm.arguments {
                if let ExceptionalArgument::Value(value) = argument {
                    f(*value);
                }
            }
        }
    }

    /// [`Self::for_each_use`] with mutable access, in the same order.
    pub fn for_each_use_mut(&mut self, mut f: impl FnMut(&mut ValueId)) {
        self.kind.for_each_use_mut(&mut f);
        if let Some(routing) = &mut self.exception {
            for arm in &mut routing.arms {
                for argument in &mut arm.arguments {
                    if let ExceptionalArgument::Value(value) = argument {
                        f(value);
                    }
                }
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Block {
    pub id: BlockId,
    /// The innermost structured region containing this block.
    ///
    /// Region membership is transitive through [`Region::parent`], so a block
    /// also belongs to every ancestor of this region.
    pub region: RegionId,
    pub parameters: Vec<ValueDefinition>,
    pub instructions: Vec<Instruction>,
    /// Every block always has exactly one terminator.
    pub terminator: Terminator,
    pub source: SourceInfo,
}

impl Block {
    /// Every value the block reads: each instruction's operands in order,
    /// then the terminator's uses.
    pub fn for_each_use(&self, mut f: impl FnMut(ValueId)) {
        for instruction in &self.instructions {
            instruction.operands.iter().copied().for_each(&mut f);
        }
        self.terminator.for_each_use(&mut f);
    }

    /// [`Self::for_each_use`] with mutable access, in the same order.
    pub fn for_each_use_mut(&mut self, mut f: impl FnMut(&mut ValueId)) {
        for instruction in &mut self.instructions {
            instruction.operands.iter_mut().for_each(&mut f);
        }
        self.terminator.for_each_use_mut(&mut f);
    }

    /// Every value the block defines: its parameters, then each
    /// instruction's results in order.
    pub fn definitions(&self) -> impl Iterator<Item = &ValueDefinition> {
        self.parameters.iter().chain(
            self.instructions
                .iter()
                .flat_map(|instruction| instruction.results.iter()),
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatchKind {
    Catch,
    CatchRef,
    CatchAll,
    CatchAllRef,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CatchClause {
    pub kind: CatchKind,
    pub tag: Option<TagId>,
    pub target: BlockId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegionKind {
    Function,
    Block,
    Loop,
    IfThen,
    IfElse,
    TryTable { catches: Vec<CatchClause> },
    Catch,
    CompilerGenerated,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Region {
    pub id: RegionId,
    pub parent: Option<RegionId>,
    pub kind: RegionKind,
    /// The region's source entry. The block may be owned by this region or a
    /// nested child region, but never by an unrelated region.
    pub entry: BlockId,
    pub source: SourceInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FunctionBody {
    /// The unique CFG entry. Its parameters define the function parameters in
    /// signature order, and no normal or exceptional edge may target it.
    pub entry: BlockId,
    pub root_region: RegionId,
    pub blocks: Vec<Block>,
    pub regions: Vec<Region>,
}

impl FunctionBody {
    /// Resolves a block by id. The frontend and the editing operations of
    /// [`crate::edit`] store blocks at their index, so that position is
    /// tried before a scan.
    #[inline(always)]
    pub fn block(&self, id: BlockId) -> Option<&Block> {
        self.blocks.get(self.block_index(id)?)
    }

    pub fn block_mut(&mut self, id: BlockId) -> Option<&mut Block> {
        let index = self.block_index(id)?;
        self.blocks.get_mut(index)
    }

    /// The position of the block `id` in [`Self::blocks`].
    #[inline(always)]
    pub fn block_index(&self, id: BlockId) -> Option<usize> {
        if self
            .blocks
            .get(id.index())
            .is_some_and(|block| block.id == id)
        {
            return Some(id.index());
        }
        self.blocks.iter().position(|block| block.id == id)
    }

    /// Resolves a region by id, likewise.
    pub fn region(&self, id: RegionId) -> Option<&Region> {
        self.regions
            .get(id.index())
            .filter(|region| region.id == id)
            .or_else(|| self.regions.iter().find(|region| region.id == id))
    }

    /// Every value the body defines, block by block.
    pub fn definitions(&self) -> impl Iterator<Item = &ValueDefinition> {
        self.blocks.iter().flat_map(Block::definitions)
    }
}

/// The first complete compiler artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Program {
    /// Core binary-format version (`1` for current standard modules).
    pub wasm_version: u16,
    pub language: LanguageProfile,
    pub rec_groups: Vec<RecGroup>,
    pub types: Vec<TypeDefinition>,
    /// Entity vectors are in their respective WebAssembly index-space order,
    /// with imports before definitions.
    pub functions: Vec<Function>,
    pub tables: Vec<Table>,
    pub memories: Vec<Memory>,
    pub globals: Vec<Global>,
    pub tags: Vec<Tag>,
    pub elements: Vec<Element>,
    pub data: Vec<DataSegment>,
    pub imports: Vec<Import>,
    pub exports: Vec<Export>,
    pub start: Option<FunctionId>,
    pub metadata: ModuleMetadata,
    pub source: SourceInfo,
}

/// Preferred semantic name; `Program` remains the public compiler artifact.
pub type Module = Program;

impl Program {
    /// Whether two tag indices may denote one tag instance at run time; see
    /// [`tags_may_alias`].
    pub fn tags_may_alias(&self, left: TagId, right: TagId) -> bool {
        tags_may_alias(&self.types, &self.tags, left, right)
    }

    pub fn new(wasm_version: u16) -> Self {
        Self {
            wasm_version,
            language: LanguageProfile::Wasm3,
            rec_groups: Vec::new(),
            types: Vec::new(),
            functions: Vec::new(),
            tables: Vec::new(),
            memories: Vec::new(),
            globals: Vec::new(),
            tags: Vec::new(),
            elements: Vec::new(),
            data: Vec::new(),
            imports: Vec::new(),
            exports: Vec::new(),
            start: None,
            metadata: ModuleMetadata::default(),
            source: SourceInfo::synthetic(),
        }
    }

    pub fn import_count(&self) -> usize {
        self.imports.len()
    }

    /// The function's `name` section name, when the module carries one.
    pub fn function_name(&self, function: FunctionId) -> Option<&str> {
        self.metadata
            .function_names
            .get(&function)
            .map(String::as_str)
    }

    /// Every function called `name`, whether by its `name` section entry or
    /// by a function export, in index order without duplicates.
    pub fn functions_named(&self, name: &str) -> Vec<FunctionId> {
        let mut found: Vec<FunctionId> = self
            .metadata
            .function_names
            .iter()
            .filter(|(_, candidate)| candidate.as_str() == name)
            .map(|(function, _)| *function)
            .chain(self.exports.iter().filter_map(|export| match export.item {
                ExportItem::Function(function) if export.name == name => Some(function),
                _ => None,
            }))
            .collect();
        found.sort_unstable();
        found.dedup();
        found
    }

    /// One function printed exactly as it appears in the program's
    /// [`fmt::Display`] output, or `None` for an out-of-range identifier.
    pub fn function_display(&self, function: FunctionId) -> Option<FunctionDisplay<'_>> {
        self.functions
            .get(function.index())
            .map(|_| FunctionDisplay {
                program: self,
                function,
            })
    }

    pub fn imported_function_count(&self) -> usize {
        self.functions
            .iter()
            .filter(|function| matches!(function.origin, EntityOrigin::Imported(_)))
            .count()
    }

    /// Check Wedge-owned entity references and every function's typed SSA CFG.
    ///
    /// This is not a second binary Core WebAssembly validator.
    /// [`crate::Compiler`] delegates decoding and source-language validation to
    /// `wasmparser`. This verifier checks the owned declaration, operation,
    /// effect, SSA, and CFG invariants that lowering and later IR transforms
    /// must preserve, including defensive checks for hand-constructed IR.
    pub fn verify(&self) -> Result<(), VerifyErrors> {
        Verifier::new(self).run()
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct VerifyLocation {
    pub function: Option<FunctionId>,
    pub block: Option<BlockId>,
    pub instruction: Option<InstructionId>,
}

impl VerifyLocation {
    const fn module() -> Self {
        Self {
            function: None,
            block: None,
            instruction: None,
        }
    }

    const fn function(function: FunctionId) -> Self {
        Self {
            function: Some(function),
            block: None,
            instruction: None,
        }
    }

    const fn block(function: FunctionId, block: BlockId) -> Self {
        Self {
            function: Some(function),
            block: Some(block),
            instruction: None,
        }
    }

    const fn instruction(function: FunctionId, block: BlockId, instruction: InstructionId) -> Self {
        Self {
            function: Some(function),
            block: Some(block),
            instruction: Some(instruction),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifyError {
    pub location: VerifyLocation,
    pub message: String,
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("IR verification failed")?;
        if let Some(function) = self.location.function {
            write!(f, " in {function}")?;
        }
        if let Some(block) = self.location.block {
            write!(f, "/{block}")?;
        }
        if let Some(instruction) = self.location.instruction {
            write!(f, "/{instruction}")?;
        }
        write!(f, ": {}", self.message)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifyErrors(pub Vec<VerifyError>);

impl fmt::Display for VerifyErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, error) in self.0.iter().enumerate() {
            if index != 0 {
                f.write_str("\n")?;
            }
            error.fmt(f)?;
        }
        Ok(())
    }
}

impl std::error::Error for VerifyErrors {}

struct Verifier<'module> {
    module: &'module Program,
    errors: Vec<VerifyError>,
}

impl<'module> Verifier<'module> {
    fn new(module: &'module Program) -> Self {
        Self {
            module,
            errors: Vec::new(),
        }
    }

    fn run(mut self) -> Result<(), VerifyErrors> {
        if let Err(detail) = crate::core_schema::validate_operation_inventory() {
            self.error(
                VerifyLocation::module(),
                format!("Wedge's Core operation inventory is incomplete: {detail}"),
            );
            return Err(VerifyErrors(self.errors));
        }
        self.verify_source(self.module.source, VerifyLocation::module(), &"module");
        self.verify_types();
        self.verify_imports();
        self.verify_tables();
        self.verify_memories();
        self.verify_globals();
        self.verify_tags();
        self.verify_elements();
        self.verify_data();
        self.verify_exports_and_start();
        self.verify_metadata();
        self.verify_functions();

        if self.errors.is_empty() {
            Ok(())
        } else {
            Err(VerifyErrors(self.errors))
        }
    }

    fn error(&mut self, location: VerifyLocation, message: impl Into<String>) {
        self.errors.push(VerifyError {
            location,
            message: message.into(),
        });
    }

    fn verify_source(
        &mut self,
        source: SourceInfo,
        location: VerifyLocation,
        owner: &dyn fmt::Display,
    ) {
        if let Some(span) = source.byte_span {
            if !span.is_valid() {
                self.error(
                    location,
                    format!(
                        "{owner} has reversed byte span {}..{}",
                        span.start, span.end
                    ),
                );
            }
        }
    }

    fn valid_type(&self, id: TypeId) -> bool {
        id.index() < self.module.types.len()
    }

    fn valid_function(&self, id: FunctionId) -> bool {
        id.index() < self.module.functions.len()
    }

    fn valid_table(&self, id: TableId) -> bool {
        id.index() < self.module.tables.len()
    }

    fn valid_memory(&self, id: MemoryId) -> bool {
        id.index() < self.module.memories.len()
    }

    fn valid_global(&self, id: GlobalId) -> bool {
        id.index() < self.module.globals.len()
    }

    fn valid_tag(&self, id: TagId) -> bool {
        id.index() < self.module.tags.len()
    }

    fn valid_element(&self, id: ElementId) -> bool {
        id.index() < self.module.elements.len()
    }

    fn valid_data(&self, id: DataId) -> bool {
        id.index() < self.module.data.len()
    }

    fn verify_types(&mut self) {
        let mut grouped = BTreeMap::new();
        let mut flattened_type_count = 0usize;
        for index in 0..self.module.rec_groups.len() {
            let id = RecGroupId(index as u32);
            let group = self.module.rec_groups[index].clone();
            self.verify_source(group.source, VerifyLocation::module(), &id.to_string());
            for ty in group.types {
                let expected = TypeId(flattened_type_count as u32);
                if ty != expected {
                    self.error(
                        VerifyLocation::module(),
                        format!(
                            "{id} has {ty} at flattened position {flattened_type_count}, expected {expected}"
                        ),
                    );
                }
                flattened_type_count += 1;
                if !self.valid_type(ty) {
                    self.error(
                        VerifyLocation::module(),
                        format!("{id} references missing {ty}"),
                    );
                } else if grouped.contains_key(&ty) {
                    self.error(
                        VerifyLocation::module(),
                        format!("{ty} occurs in more than one recursive type group"),
                    );
                } else {
                    grouped.insert(ty, id);
                }
            }
        }
        if flattened_type_count != self.module.types.len() {
            self.error(
                VerifyLocation::module(),
                format!(
                    "recursive type groups contain {flattened_type_count} type entries, expected {}",
                    self.module.types.len()
                ),
            );
        }
        for index in 0..self.module.rec_groups.len() {
            let id = RecGroupId(index as u32);
            let group = &self.module.rec_groups[index];
            let aliases = group
                .types
                .iter()
                .filter_map(|ty| self.module.types.get(ty.index()))
                .map(|definition| definition.canonical_alias)
                .collect::<Vec<_>>();
            let alias_count = aliases.iter().filter(|alias| alias.is_some()).count();
            if alias_count == 0 {
                continue;
            }
            if alias_count != aliases.len() {
                self.error(
                    VerifyLocation::module(),
                    format!("{id} mixes canonical aliases with new type representatives"),
                );
                continue;
            }

            let representatives = aliases.into_iter().flatten().collect::<Vec<_>>();
            let Some(target) = representatives
                .first()
                .and_then(|representative| grouped.get(representative))
                .copied()
            else {
                // Missing representatives are diagnosed on their individual
                // type definitions below.
                continue;
            };
            let target_types = &self.module.rec_groups[target.index()].types;
            if target.index() >= id.index() || representatives.as_slice() != target_types.as_slice()
            {
                self.error(
                    VerifyLocation::module(),
                    format!(
                        "{id} canonical representatives do not reproduce an earlier recursive type group"
                    ),
                );
            }
        }
        let mut subtype_depths: Vec<usize> = Vec::with_capacity(self.module.types.len());
        for index in 0..self.module.types.len() {
            let id = TypeId(index as u32);
            let group = grouped.get(&id).copied();
            if group.is_none() {
                self.error(
                    VerifyLocation::module(),
                    format!("{id} does not belong to a recursive type group"),
                );
            }
            let definition = self.module.types[index].clone();
            self.verify_source(definition.source, VerifyLocation::module(), &id.to_string());
            if let Some(canonical) = definition.canonical_alias {
                if !self.valid_type(canonical) {
                    self.error(
                        VerifyLocation::module(),
                        format!("{id} has missing canonical representative {canonical}"),
                    );
                } else if canonical.index() >= id.index() {
                    self.error(
                        VerifyLocation::module(),
                        format!(
                            "{id} canonical representative {canonical} is not an earlier module type"
                        ),
                    );
                } else if self.module.types[canonical.index()]
                    .canonical_alias
                    .is_some()
                {
                    self.error(
                        VerifyLocation::module(),
                        format!("{id} canonical alias {canonical} does not name a representative"),
                    );
                } else if !canonical_type_definitions_match(
                    &self.module.types,
                    &definition,
                    &self.module.types[canonical.index()],
                ) {
                    self.error(
                        VerifyLocation::module(),
                        format!(
                            "{id} does not match canonical representative {canonical} structurally"
                        ),
                    );
                }
            }
            let mut subtype_depth = 0usize;
            if let Some(supertype) = definition.supertype {
                if !self.valid_type(supertype) {
                    self.error(
                        VerifyLocation::module(),
                        format!("{id} has missing supertype {supertype}"),
                    );
                } else {
                    let supertype_definition = &self.module.types[supertype.index()];
                    if supertype.index() >= id.index() {
                        self.error(
                            VerifyLocation::module(),
                            format!("{id} supertype {supertype} is not an earlier module type"),
                        );
                    } else {
                        subtype_depth = subtype_depths[supertype.index()].saturating_add(1);
                        if subtype_depth > MAX_NOMINAL_SUBTYPE_DEPTH {
                            self.error(
                                VerifyLocation::module(),
                                format!(
                                    "{id} subtype hierarchy depth {subtype_depth} exceeds maximum {MAX_NOMINAL_SUBTYPE_DEPTH}"
                                ),
                            );
                        }
                    }
                    if supertype_definition.final_ {
                        self.error(
                            VerifyLocation::module(),
                            format!("{id} cannot extend final supertype {supertype}"),
                        );
                    }
                    if !composite_type_is_declared_subtype(
                        &self.module.types,
                        &definition.composite,
                        &supertype_definition.composite,
                    ) {
                        self.error(
                            VerifyLocation::module(),
                            format!(
                                "{id} composite type does not match declared supertype {supertype}"
                            ),
                        );
                    }
                }
            }
            subtype_depths.push(subtype_depth);
            if let Some(group) = group {
                self.verify_type_reference_scopes(id, group, &definition.composite, &grouped);
            }
            match &definition.composite {
                CompositeType::Function(signature) => {
                    self.verify_signature(signature, VerifyLocation::module(), &id.to_string());
                }
                CompositeType::Struct(fields) => {
                    for field in fields {
                        self.verify_storage_type(
                            &field.storage,
                            VerifyLocation::module(),
                            &id.to_string(),
                        );
                    }
                }
                CompositeType::Array(field) => self.verify_storage_type(
                    &field.storage,
                    VerifyLocation::module(),
                    &id.to_string(),
                ),
            }
        }

        // Supertype edges are nominal and must form a forest. Report each
        // cycle once, in deterministic type-index order.
        let mut checked = BTreeSet::new();
        for index in 0..self.module.types.len() {
            let start = TypeId(index as u32);
            if checked.contains(&start) {
                continue;
            }

            let mut path = Vec::new();
            let mut positions = BTreeMap::new();
            let mut cursor = start;
            loop {
                if checked.contains(&cursor) || !self.valid_type(cursor) {
                    break;
                }
                if let Some(&cycle_start) = positions.get(&cursor) {
                    let mut cycle = path[cycle_start..]
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>();
                    cycle.push(cursor.to_string());
                    self.error(
                        VerifyLocation::module(),
                        format!("supertype cycle: {}", cycle.join(" -> ")),
                    );
                    break;
                }

                positions.insert(cursor, path.len());
                path.push(cursor);
                let Some(supertype) = self.module.types[cursor.index()].supertype else {
                    break;
                };
                cursor = supertype;
            }
            checked.extend(path);
        }
    }

    fn verify_type_reference_scopes(
        &mut self,
        owner: TypeId,
        owner_group: RecGroupId,
        composite: &CompositeType,
        groups: &BTreeMap<TypeId, RecGroupId>,
    ) {
        match composite {
            CompositeType::Function(signature) => {
                for ty in signature.params.iter().chain(&signature.results) {
                    self.verify_type_reference_scope(owner, owner_group, ty, groups);
                }
            }
            CompositeType::Struct(fields) => {
                for field in fields {
                    self.verify_storage_type_reference_scope(
                        owner,
                        owner_group,
                        &field.storage,
                        groups,
                    );
                }
            }
            CompositeType::Array(field) => {
                self.verify_storage_type_reference_scope(owner, owner_group, &field.storage, groups)
            }
        }
    }

    fn verify_storage_type_reference_scope(
        &mut self,
        owner: TypeId,
        owner_group: RecGroupId,
        storage: &StorageType,
        groups: &BTreeMap<TypeId, RecGroupId>,
    ) {
        if let StorageType::Value(ty) = storage {
            self.verify_type_reference_scope(owner, owner_group, ty, groups);
        }
    }

    fn verify_type_reference_scope(
        &mut self,
        owner: TypeId,
        owner_group: RecGroupId,
        ty: &ValueType,
        groups: &BTreeMap<TypeId, RecGroupId>,
    ) {
        let ValueType::Ref(RefType {
            heap: HeapType::Concrete(referenced),
            ..
        }) = ty
        else {
            return;
        };
        let Some(referenced_group) = groups.get(referenced).copied() else {
            return;
        };
        if referenced_group.index() > owner_group.index() {
            self.error(
                VerifyLocation::module(),
                format!(
                    "{owner} references {referenced} in later recursive type group {referenced_group}"
                ),
            );
        }
    }

    fn verify_storage_type(
        &mut self,
        ty: &StorageType,
        location: VerifyLocation,
        owner: &dyn fmt::Display,
    ) {
        if let StorageType::Value(ty) = ty {
            self.verify_value_type(ty, location, owner);
        }
    }

    fn verify_signature(
        &mut self,
        signature: &FunctionType,
        location: VerifyLocation,
        owner: &dyn fmt::Display,
    ) {
        for ty in signature.params.iter().chain(&signature.results) {
            self.verify_value_type(ty, location, owner);
        }
    }

    fn verify_value_type(
        &mut self,
        ty: &ValueType,
        location: VerifyLocation,
        owner: &dyn fmt::Display,
    ) {
        if let ValueType::Ref(reference) = ty {
            self.verify_heap_type(&reference.heap, location, owner);
        }
    }

    fn verify_heap_type(
        &mut self,
        ty: &HeapType,
        location: VerifyLocation,
        owner: &dyn fmt::Display,
    ) {
        if let HeapType::Concrete(id) = ty {
            if !self.valid_type(*id) {
                self.error(location, format!("{owner} references missing heap {id}"));
            }
        }
    }

    fn verify_imports(&mut self) {
        for index in 0..self.module.imports.len() {
            let id = ImportId(index as u32);
            let import = self.module.imports[index].clone();
            self.verify_source(import.source, VerifyLocation::module(), &id.to_string());
            let valid = match import.item {
                ImportItem::Function(entity) => self
                    .module
                    .functions
                    .get(entity.index())
                    .is_some_and(|item| item.origin == EntityOrigin::Imported(id)),
                ImportItem::Table(entity) => self
                    .module
                    .tables
                    .get(entity.index())
                    .is_some_and(|item| item.origin == EntityOrigin::Imported(id)),
                ImportItem::Memory(entity) => self
                    .module
                    .memories
                    .get(entity.index())
                    .is_some_and(|item| item.origin == EntityOrigin::Imported(id)),
                ImportItem::Global(entity) => self
                    .module
                    .globals
                    .get(entity.index())
                    .is_some_and(|item| item.origin == EntityOrigin::Imported(id)),
                ImportItem::Tag(entity) => self
                    .module
                    .tags
                    .get(entity.index())
                    .is_some_and(|item| item.origin == EntityOrigin::Imported(id)),
            };
            if !valid {
                self.error(
                    VerifyLocation::module(),
                    format!("{id} does not point to an entity imported by it"),
                );
            }
        }
    }

    fn verify_origin(
        &mut self,
        origin: EntityOrigin,
        expected: ImportItem,
        owner: &dyn fmt::Display,
    ) {
        if let EntityOrigin::Imported(import) = origin {
            match self.module.imports.get(import.index()) {
                Some(item) if item.item == expected => {}
                Some(_) => self.error(
                    VerifyLocation::module(),
                    format!("{owner} points at mismatched {import}"),
                ),
                None => self.error(
                    VerifyLocation::module(),
                    format!("{owner} points at missing {import}"),
                ),
            }
        }
    }

    fn verify_tables(&mut self) {
        let available_globals = self
            .module
            .globals
            .iter()
            .take_while(|global| matches!(global.origin, EntityOrigin::Imported(_)))
            .count();
        for index in 0..self.module.tables.len() {
            let id = TableId(index as u32);
            let table = self.module.tables[index].clone();
            self.verify_source(table.source, VerifyLocation::module(), &id.to_string());
            self.verify_origin(table.origin, ImportItem::Table(id), &id.to_string());
            self.verify_heap_type(
                &table.ty.element.heap,
                VerifyLocation::module(),
                &id.to_string(),
            );
            self.verify_limits(table.ty.limits, VerifyLocation::module(), &id.to_string());
            match (table.origin, table.initializer) {
                (EntityOrigin::Imported(_), Some(_)) => self.error(
                    VerifyLocation::module(),
                    format!("imported {id} has an initializer"),
                ),
                (_, Some(initializer)) => {
                    self.verify_const_expr(
                        &initializer,
                        Some(&ValueType::Ref(table.ty.element)),
                        &id.to_string(),
                        available_globals,
                    );
                }
                _ => {}
            }
        }
    }

    fn verify_memories(&mut self) {
        for index in 0..self.module.memories.len() {
            let id = MemoryId(index as u32);
            let memory = self.module.memories[index].clone();
            self.verify_source(memory.source, VerifyLocation::module(), &id.to_string());
            self.verify_origin(memory.origin, ImportItem::Memory(id), &id.to_string());
            self.verify_limits(memory.ty.limits, VerifyLocation::module(), &id.to_string());
        }
    }

    fn verify_limits(
        &mut self,
        limits: Limits,
        location: VerifyLocation,
        owner: &dyn fmt::Display,
    ) {
        if limits.max.is_some_and(|max| limits.min > max) {
            self.error(location, format!("{owner} has minimum larger than maximum"));
        }
    }

    fn verify_globals(&mut self) {
        for index in 0..self.module.globals.len() {
            let id = GlobalId(index as u32);
            let global = self.module.globals[index].clone();
            self.verify_source(global.source, VerifyLocation::module(), &id.to_string());
            self.verify_origin(global.origin, ImportItem::Global(id), &id.to_string());
            self.verify_value_type(&global.ty.value, VerifyLocation::module(), &id.to_string());
            match (global.origin, global.initializer) {
                (EntityOrigin::Imported(_), Some(_)) => self.error(
                    VerifyLocation::module(),
                    format!("imported {id} has an initializer"),
                ),
                (EntityOrigin::Defined, None) => self.error(
                    VerifyLocation::module(),
                    format!("defined {id} has no initializer"),
                ),
                (_, Some(initializer)) => {
                    self.verify_const_expr(
                        &initializer,
                        Some(&global.ty.value),
                        &id.to_string(),
                        index,
                    );
                }
                _ => {}
            }
        }
    }

    fn verify_tags(&mut self) {
        for index in 0..self.module.tags.len() {
            let id = TagId(index as u32);
            let tag = self.module.tags[index].clone();
            self.verify_source(tag.source, VerifyLocation::module(), &id.to_string());
            self.verify_origin(tag.origin, ImportItem::Tag(id), &id.to_string());
            match self.function_type(tag.ty.signature) {
                Some(signature) if signature.results.is_empty() => {}
                Some(_) => self.error(
                    VerifyLocation::module(),
                    format!("{id} signature must not return values"),
                ),
                None => self.error(
                    VerifyLocation::module(),
                    format!(
                        "{id} has non-function or missing signature {}",
                        tag.ty.signature
                    ),
                ),
            }
        }
    }

    fn verify_elements(&mut self) {
        for index in 0..self.module.elements.len() {
            let id = ElementId(index as u32);
            let element = self.module.elements[index].clone();
            self.verify_source(element.source, VerifyLocation::module(), &id.to_string());
            self.verify_heap_type(&element.ty.heap, VerifyLocation::module(), &id.to_string());
            if let ElementMode::Active { table, offset } = &element.mode {
                match self.module.tables.get(table.index()) {
                    Some(table_definition) => {
                        if !is_ref_subtype(
                            &self.module.types,
                            &element.ty,
                            &table_definition.ty.element,
                        ) {
                            self.error(
                                VerifyLocation::module(),
                                format!(
                                    "{id} has element type {}, which is not a subtype of {table}'s {}",
                                    element.ty, table_definition.ty.element
                                ),
                            );
                        }
                        self.verify_const_expr(
                            offset,
                            Some(&table_definition.ty.address_type.value_type()),
                            &id.to_string(),
                            self.module.globals.len(),
                        );
                    }
                    None => self.error(
                        VerifyLocation::module(),
                        format!("{id} targets missing {table}"),
                    ),
                }
            }
            for item in element.items {
                match item {
                    ElementItem::Function(function) => {
                        let function_type = self
                            .module
                            .functions
                            .get(function.index())
                            .map(|function| function.ty);
                        if function_type.is_none() {
                            self.error(
                                VerifyLocation::module(),
                                format!("{id} references missing {function}"),
                            );
                        } else if function_type.is_some_and(|ty| {
                            self.function_type(ty).is_some()
                                && !is_ref_subtype(
                                    &self.module.types,
                                    &RefType {
                                        nullable: false,
                                        heap: HeapType::Concrete(ty),
                                    },
                                    &element.ty,
                                )
                        }) {
                            self.error(
                                VerifyLocation::module(),
                                format!(
                                    "{id} cannot store {function} in element type {}",
                                    element.ty
                                ),
                            );
                        }
                    }
                    ElementItem::Expression(expression) => self.verify_const_expr(
                        &expression,
                        Some(&ValueType::Ref(element.ty.clone())),
                        &id.to_string(),
                        self.module.globals.len(),
                    ),
                }
            }
        }
    }

    fn verify_data(&mut self) {
        for index in 0..self.module.data.len() {
            let id = DataId(index as u32);
            let (source, mode) = {
                let data = &self.module.data[index];
                (data.source, data.mode.clone())
            };
            self.verify_source(source, VerifyLocation::module(), &id.to_string());
            if let DataMode::Active { memory, offset } = mode {
                match self.module.memories.get(memory.index()) {
                    Some(memory_definition) => self.verify_const_expr(
                        &offset,
                        Some(&memory_definition.ty.address_type.value_type()),
                        &id.to_string(),
                        self.module.globals.len(),
                    ),
                    None => self.error(
                        VerifyLocation::module(),
                        format!("{id} targets missing {memory}"),
                    ),
                }
            }
        }
    }

    fn verify_exports_and_start(&mut self) {
        let mut names = BTreeSet::new();
        for export in &self.module.exports {
            self.verify_source(
                export.source,
                VerifyLocation::module(),
                &format!("export {:?}", export.name),
            );
            if !names.insert(export.name.as_str()) {
                self.error(
                    VerifyLocation::module(),
                    format!("duplicate export name {:?}", export.name),
                );
            }
            let valid = match export.item {
                ExportItem::Function(id) => self.valid_function(id),
                ExportItem::Table(id) => self.valid_table(id),
                ExportItem::Memory(id) => self.valid_memory(id),
                ExportItem::Global(id) => self.valid_global(id),
                ExportItem::Tag(id) => self.valid_tag(id),
            };
            if !valid {
                self.error(
                    VerifyLocation::module(),
                    format!("export {:?} references a missing entity", export.name),
                );
            }
        }
        if let Some(start) = self.module.start {
            match self
                .module
                .functions
                .get(start.index())
                .and_then(|function| self.function_type(function.ty))
            {
                Some(signature) if signature.params.is_empty() && signature.results.is_empty() => {}
                Some(_) => self.error(
                    VerifyLocation::module(),
                    format!("start {start} must have type [] -> []"),
                ),
                None => self.error(
                    VerifyLocation::module(),
                    format!("start references missing or ill-typed {start}"),
                ),
            }
        }
    }

    fn verify_metadata(&mut self) {
        let function_names: Vec<_> = self
            .module
            .metadata
            .function_names
            .keys()
            .copied()
            .collect();
        for function in function_names {
            if !self.valid_function(function) {
                self.error(
                    VerifyLocation::module(),
                    format!("name metadata references missing {function}"),
                );
            }
        }
        let local_names: Vec<_> = self.module.metadata.local_names.keys().copied().collect();
        for (function, local) in local_names {
            match self.module.functions.get(function.index()) {
                Some(definition) if local.index() < definition.locals.len() => {}
                Some(_) => self.error(
                    VerifyLocation::module(),
                    format!("local name metadata references missing {function}/{local}"),
                ),
                None => self.error(
                    VerifyLocation::module(),
                    format!("local name metadata references missing {function}"),
                ),
            }
        }
        for index in 0..self.module.metadata.custom_sections.len() {
            let (source, owner) = {
                let section = &self.module.metadata.custom_sections[index];
                (section.source, format!("custom section {:?}", section.name))
            };
            self.verify_source(source, VerifyLocation::module(), &owner);
        }
    }

    fn verify_functions(&mut self) {
        let module = self.module;
        for (index, function) in module.functions.iter().enumerate() {
            let id = FunctionId(index as u32);
            let location = VerifyLocation::function(id);
            self.verify_source(function.source, location, &id.to_string());
            if function.wasm_index != id.0 {
                self.error(
                    location,
                    format!(
                        "{id} retains wasm index {}, expected {}",
                        function.wasm_index, id.0
                    ),
                );
            }
            self.verify_origin(function.origin, ImportItem::Function(id), &id.to_string());
            let Some(signature) = self.function_type(function.ty) else {
                self.error(
                    location,
                    format!("{id} has non-function or missing type {}", function.ty),
                );
                continue;
            };
            for ty in &function.locals {
                self.verify_value_type(ty, location, &id.to_string());
            }
            if function.locals.len() < signature.params.len()
                || function.locals[..signature.params.len()] != signature.params[..]
            {
                self.error(
                    location,
                    format!("{id} locals do not begin with its parameter types"),
                );
            }
            match (function.origin, &function.body) {
                (EntityOrigin::Imported(_), Some(_)) => {
                    self.error(location, format!("imported {id} has a body"));
                }
                (EntityOrigin::Defined, None) => {
                    self.error(location, format!("defined {id} has no body"));
                }
                (_, Some(body)) => self.verify_function_body(id, signature, &function.locals, body),
                _ => {}
            }
        }
    }

    fn function_type(&self, id: TypeId) -> Option<&'module FunctionType> {
        let module: &'module Program = self.module;
        match &module.types.get(id.index())?.composite {
            CompositeType::Function(signature) => Some(signature),
            _ => None,
        }
    }

    fn verify_const_expr(
        &mut self,
        expression: &ConstExpr,
        expected: Option<&ValueType>,
        owner: &dyn fmt::Display,
        available_globals: usize,
    ) {
        let location = VerifyLocation::module();
        self.verify_source(expression.source, location, owner);
        self.verify_value_type(&expression.result_type, location, owner);
        let mut stack = Vec::new();
        for instruction in &expression.instructions {
            self.verify_source(instruction.source, location, owner);
            self.verify_operation(&instruction.operation, location, owner, None);
            if !matches!(
                instruction.operation.kind,
                OperationKind::Core(opcode) if opcode.is_const_expression()
            ) {
                self.error(
                    location,
                    format!(
                        "{owner} constant expression contains non-constant operation {}",
                        instruction.operation.mnemonic
                    ),
                );
            }
            if instruction.operation.kind == OperationKind::Core(CoreOpcode::GlobalGet) {
                let valid = matches!(
                    instruction.operation.immediates.as_slice(),
                    [Immediate::Global(global)]
                        if global.index() < available_globals
                            && self.module.globals.get(global.index()).is_some_and(|definition| {
                                !definition.ty.mutable
                            })
                );
                if !valid {
                    self.error(
                        location,
                        format!(
                            "{owner} constant expression global.get must reference exactly one prior immutable global"
                        ),
                    );
                }
            }
            let params = &instruction.operation.signature.params;
            if stack.len() < params.len() {
                self.error(
                    location,
                    format!(
                        "{owner} constant expression stack underflow at {}",
                        instruction.operation.mnemonic
                    ),
                );
                stack.clear();
            } else {
                let actual = stack.split_off(stack.len() - params.len());
                if actual.len() != params.len()
                    || !actual.iter().zip(params).all(|(actual, expected)| {
                        is_value_subtype(&self.module.types, actual, expected)
                    })
                {
                    self.error(
                        location,
                        format!(
                            "{owner} constant expression passes {actual:?} to {} expecting {params:?}",
                            instruction.operation.mnemonic
                        ),
                    );
                }
            }
            stack.extend(instruction.operation.signature.results.iter().cloned());
        }
        if stack.len() != 1
            || !are_value_types_equivalent(&self.module.types, &stack[0], &expression.result_type)
        {
            self.error(
                location,
                format!(
                    "{owner} constant expression leaves {stack:?}, expected {:?}",
                    expression.result_type
                ),
            );
        }
        if let Some(expected) = expected {
            if !is_value_subtype(&self.module.types, &expression.result_type, expected) {
                self.error(
                    location,
                    format!(
                        "{owner} constant expression has type {}, expected {}",
                        expression.result_type, expected
                    ),
                );
            }
        }
    }

    fn verify_operation(
        &mut self,
        operation: &Operation,
        location: VerifyLocation,
        owner: &dyn fmt::Display,
        local_count: Option<usize>,
    ) {
        if operation.mnemonic.is_empty() {
            self.error(location, format!("{owner} has an empty operation mnemonic"));
        }
        match operation.kind {
            OperationKind::Core(opcode) => {
                let canonical = opcode.mnemonic();
                if operation.mnemonic != canonical {
                    self.error(
                        location,
                        format!(
                            "{owner} identifies core opcode {canonical}, but uses mnemonic {}",
                            operation.mnemonic
                        ),
                    );
                }
                if !opcode.is_standard_wasm3() {
                    self.error(
                        location,
                        format!(
                            "{owner} uses out-of-profile core opcode {canonical} ({:?})",
                            opcode.proposal()
                        ),
                    );
                }
                if let Err(detail) = crate::core_schema::validate_operation(self.module, operation)
                {
                    self.error(
                        location,
                        format!("{owner} has an invalid Core schema: {detail}"),
                    );
                }
            }
            OperationKind::Synthetic => {
                if let Some(opcode) = CoreOpcode::from_mnemonic(&operation.mnemonic) {
                    self.error(
                        location,
                        format!(
                            "{owner} uses core mnemonic {} with synthetic operation identity; expected {:?}",
                            operation.mnemonic, opcode
                        ),
                    );
                }
                match operation.mnemonic() {
                    "wedge.refine_non_null" | "wedge.refine_reference" => self.error(
                        location,
                        format!(
                            "{owner} uses obsolete path-independent reference refinement {}; refinements must be attached to a conditional edge",
                            operation.mnemonic
                        ),
                    ),
                    _ => {}
                }
            }
        }
        self.verify_signature(&operation.signature, location, owner);
        for immediate in &operation.immediates {
            match immediate {
                Immediate::Type(id) if !self.valid_type(*id) => {
                    self.error(location, format!("{owner} references missing {id}"));
                }
                Immediate::Function(id) if !self.valid_function(*id) => {
                    self.error(location, format!("{owner} references missing {id}"));
                }
                Immediate::Table(id) if !self.valid_table(*id) => {
                    self.error(location, format!("{owner} references missing {id}"));
                }
                Immediate::Memory(id) if !self.valid_memory(*id) => {
                    self.error(location, format!("{owner} references missing {id}"));
                }
                Immediate::Global(id) if !self.valid_global(*id) => {
                    self.error(location, format!("{owner} references missing {id}"));
                }
                Immediate::Tag(id) if !self.valid_tag(*id) => {
                    self.error(location, format!("{owner} references missing {id}"));
                }
                Immediate::Element(id) if !self.valid_element(*id) => {
                    self.error(location, format!("{owner} references missing {id}"));
                }
                Immediate::Data(id) if !self.valid_data(*id) => {
                    self.error(location, format!("{owner} references missing {id}"));
                }
                Immediate::Local(id) if local_count.is_some_and(|count| id.index() >= count) => {
                    self.error(location, format!("{owner} references missing {id}"));
                }
                Immediate::ValueType(ty) => self.verify_value_type(ty, location, owner),
                Immediate::HeapType(ty) => self.verify_heap_type(ty, location, owner),
                Immediate::MemoryArgument(argument) if !self.valid_memory(argument.memory) => {
                    self.error(
                        location,
                        format!("{owner} references missing {}", argument.memory),
                    );
                }
                _ => {}
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum DefinitionPosition {
    Parameter,
    Instruction(usize),
}

/// Every value definition of one function body, keyed by id. Never iterated,
/// so diagnostics do not depend on its order.
type Definitions = HashMap<ValueId, DefinitionSite>;

/// Blocks of one function body indexed by id, borrowed for verification.
type BlockIndex<'m> = BTreeMap<BlockId, &'m Block>;
/// Regions of one function body indexed by id, borrowed for verification.
type RegionIndex<'m> = BTreeMap<RegionId, &'m Region>;

struct DefinitionSite {
    block: BlockId,
    position: DefinitionPosition,
    ty: ValueType,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BranchOutcome {
    True,
    False,
}

#[derive(Clone, Copy, Debug)]
struct ConditionalEdge {
    condition: ValueId,
    outcome: BranchOutcome,
}

#[derive(Clone, Copy)]
enum ExceptionOrigin<'a> {
    Dynamic,
    Known {
        tag: TagId,
        arguments: &'a [ValueId],
    },
}

impl<'module> Verifier<'module> {
    fn verify_function_body(
        &mut self,
        function: FunctionId,
        signature: &FunctionType,
        locals: &[ValueType],
        body: &'module FunctionBody,
    ) {
        let entry = body.entry;
        let root_region = body.root_region;
        let function_location = VerifyLocation::function(function);
        let mut blocks: BlockIndex<'module> = BTreeMap::new();
        for block in &body.blocks {
            if blocks.insert(block.id, block).is_some() {
                self.error(
                    function_location,
                    format!("duplicate block identifier {}", block.id),
                );
            }
        }
        let mut regions: RegionIndex<'module> = BTreeMap::new();
        for region in &body.regions {
            if regions.insert(region.id, region).is_some() {
                self.error(
                    function_location,
                    format!("duplicate region identifier {}", region.id),
                );
            }
        }
        let cfg = ControlFlowGraph::from_indexed(entry, &blocks, &regions);

        if !blocks.contains_key(&entry) {
            self.error(
                function_location,
                format!("entry references missing {entry}"),
            );
        }
        self.verify_regions(function, entry, root_region, &blocks, &regions);
        self.verify_function_entry(function, signature, entry, &blocks, &regions, &cfg);

        let mut definitions = Definitions::new();
        let mut instruction_ids = HashSet::new();
        for block in blocks.values() {
            let block_location = VerifyLocation::block(function, block.id);
            self.verify_source(block.source, block_location, &block.id.to_string());
            if !regions.contains_key(&block.region) {
                self.error(
                    block_location,
                    format!("{} references missing {}", block.id, block.region),
                );
            }
            for parameter in &block.parameters {
                self.verify_value_type(&parameter.ty, block_location, &parameter.id.to_string());
                let site = DefinitionSite {
                    block: block.id,
                    position: DefinitionPosition::Parameter,
                    ty: parameter.ty.clone(),
                };
                if definitions.insert(parameter.id, site).is_some() {
                    self.error(
                        block_location,
                        format!("{} is defined more than once", parameter.id),
                    );
                }
            }
            for (position, instruction) in block.instructions.iter().enumerate() {
                let location = VerifyLocation::instruction(function, block.id, instruction.id);
                if !instruction_ids.insert(instruction.id) {
                    self.error(
                        location,
                        format!("{} is used by more than one instruction", instruction.id),
                    );
                }
                for result in &instruction.results {
                    self.verify_value_type(&result.ty, location, &result.id.to_string());
                    let site = DefinitionSite {
                        block: block.id,
                        position: DefinitionPosition::Instruction(position),
                        ty: result.ty.clone(),
                    };
                    if definitions.insert(result.id, site).is_some() {
                        self.error(location, format!("{} is defined more than once", result.id));
                    }
                }
            }
        }

        let dominators = cfg.dominators();

        for block in blocks.values() {
            for (position, instruction) in block.instructions.iter().enumerate() {
                self.verify_instruction(
                    function,
                    block,
                    position,
                    instruction,
                    locals,
                    &regions,
                    &definitions,
                    &dominators,
                );
            }
            self.verify_terminator(
                function,
                signature,
                block,
                locals,
                &blocks,
                &regions,
                &definitions,
                &dominators,
            );
        }
    }

    fn verify_regions(
        &mut self,
        function: FunctionId,
        function_entry: BlockId,
        root_region: RegionId,
        blocks: &BlockIndex<'_>,
        regions: &RegionIndex<'_>,
    ) {
        let location = VerifyLocation::function(function);
        match regions.get(&root_region) {
            Some(region)
                if region.parent.is_none() && matches!(region.kind, RegionKind::Function) => {}
            Some(_) => self.error(
                location,
                format!("root {root_region} is not a parentless function region"),
            ),
            None => self.error(location, format!("missing root {root_region}")),
        }
        if let Some(root) = regions.get(&root_region) {
            if root.entry != function_entry {
                self.error(
                    location,
                    format!(
                        "root {root_region} entry {} does not match function body entry {function_entry}",
                        root.entry
                    ),
                );
            }
        }

        let mut resolved = BTreeSet::new();
        for region in regions.values() {
            self.verify_source(region.source, location, &region.id.to_string());
            if matches!(region.kind, RegionKind::Function) && region.id != root_region {
                self.error(
                    location,
                    format!("non-root {} is also a function region", region.id),
                );
            }
            match blocks.get(&region.entry) {
                Some(entry) if !region_contains(regions, region.id, entry.region) => {
                    self.error(
                        location,
                        format!(
                            "{} entry {} is owned by unrelated {}",
                            region.id, region.entry, entry.region
                        ),
                    );
                }
                Some(_) => {}
                None => {
                    self.error(
                        location,
                        format!("{} has missing entry {}", region.id, region.entry),
                    );
                }
            }
            if let Some(parent) = region.parent {
                if !regions.contains_key(&parent) {
                    self.error(
                        location,
                        format!("{} has missing parent {parent}", region.id),
                    );
                }
            } else if region.id != root_region {
                self.error(location, format!("non-root {} has no parent", region.id));
            }
            if let RegionKind::TryTable { catches } = &region.kind {
                for catch in catches {
                    let target_types = blocks.get(&catch.target).map(|target| {
                        target
                            .parameters
                            .iter()
                            .map(|parameter| parameter.ty.clone())
                            .collect::<Vec<_>>()
                    });
                    if target_types.is_none() {
                        self.error(
                            location,
                            format!("{} catch targets missing {}", region.id, catch.target),
                        );
                    }

                    let mut caught_types = match catch.kind {
                        CatchKind::Catch | CatchKind::CatchRef => match catch.tag {
                            Some(tag) if self.valid_tag(tag) => {
                                let signature = self.module.tags[tag.index()].ty.signature;
                                self.function_type(signature)
                                    .map(|signature| signature.params.clone())
                            }
                            Some(tag) => {
                                self.error(
                                    location,
                                    format!("{} catch references missing {tag}", region.id),
                                );
                                None
                            }
                            None => {
                                self.error(
                                    location,
                                    format!("{} tagged catch has no tag", region.id),
                                );
                                None
                            }
                        },
                        CatchKind::CatchAll | CatchKind::CatchAllRef => {
                            if catch.tag.is_some() {
                                self.error(
                                    location,
                                    format!("{} catch_all unexpectedly has a tag", region.id),
                                );
                            }
                            Some(Vec::new())
                        }
                    };
                    if matches!(catch.kind, CatchKind::CatchRef | CatchKind::CatchAllRef) {
                        if let Some(types) = &mut caught_types {
                            types.push(ValueType::Ref(RefType {
                                nullable: false,
                                heap: HeapType::Exn,
                            }));
                        }
                    }
                    if let (Some(caught_types), Some(target_types)) = (caught_types, target_types) {
                        // Sealed SSA may append local merge parameters after
                        // the catch payload prefix. The structured catch only
                        // owns and constrains that prefix.
                        if caught_types.len() > target_types.len()
                            || !caught_types
                                .iter()
                                .zip(&target_types)
                                .all(|(actual, expected)| {
                                    is_value_subtype(&self.module.types, actual, expected)
                                })
                        {
                            self.error(
                                location,
                                format!(
                                    "{} {:?} produces {caught_types:?}, but target {} accepts {target_types:?}",
                                    region.id, catch.kind, catch.target
                                ),
                            );
                        }
                    }
                }
            }

            // A chain already known to end at the root, or at a missing
            // parent reported above, is not walked again, which keeps deep
            // nesting linear.
            let mut path = BTreeSet::new();
            let mut cursor = Some(region.id);
            let mut cyclic = false;
            while let Some(current) = cursor {
                if resolved.contains(&current) {
                    break;
                }
                if !path.insert(current) {
                    self.error(location, format!("region parent cycle includes {current}"));
                    cyclic = true;
                    break;
                }
                cursor = regions.get(&current).and_then(|item| item.parent);
            }
            if !cyclic {
                resolved.extend(path);
            }
        }
    }

    fn verify_function_entry(
        &mut self,
        function: FunctionId,
        signature: &FunctionType,
        entry: BlockId,
        blocks: &BlockIndex<'_>,
        regions: &RegionIndex<'_>,
        cfg: &ControlFlowGraph<'_>,
    ) {
        let Some(entry_block) = blocks.get(&entry) else {
            return;
        };
        let location = VerifyLocation::block(function, entry);

        if entry_block.parameters.len() != signature.params.len() {
            self.error(
                location,
                format!(
                    "function entry {entry} defines {} parameters, but the function signature has {}",
                    entry_block.parameters.len(),
                    signature.params.len()
                ),
            );
        }
        for (index, (parameter, expected)) in entry_block
            .parameters
            .iter()
            .zip(&signature.params)
            .enumerate()
        {
            if parameter.ty != *expected {
                self.error(
                    location,
                    format!(
                        "function entry {entry} parameter {index} is {}, expected {expected}",
                        parameter.ty
                    ),
                );
            }
        }

        let mut ordinary_sources = BTreeSet::new();
        for edge in cfg.incoming_edges(entry) {
            if !edge.kind.is_exceptional() {
                ordinary_sources.insert(edge.source);
                continue;
            }
            self.error(
                location,
                format!(
                    "function entry {entry} has an incoming exceptional edge from {} terminator",
                    edge.source
                ),
            );
        }
        for source in ordinary_sources {
            self.error(
                location,
                format!("function entry {entry} has an incoming CFG edge from {source}"),
            );
        }

        for region in regions.values() {
            if let RegionKind::TryTable { catches } = &region.kind {
                for (index, catch) in catches.iter().enumerate() {
                    if catch.target == entry {
                        self.error(
                            location,
                            format!(
                                "function entry {entry} has an incoming unwind edge from {} catch {index}",
                                region.id
                            ),
                        );
                    }
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn verify_instruction(
        &mut self,
        function: FunctionId,
        block: &Block,
        position: usize,
        instruction: &Instruction,
        locals: &[ValueType],
        regions: &RegionIndex<'_>,
        definitions: &Definitions,
        dominators: &Dominators,
    ) {
        let location = VerifyLocation::instruction(function, block.id, instruction.id);
        self.verify_source(instruction.source, location, &instruction.id);
        self.verify_operation_site(
            &instruction.operation,
            &instruction.operands,
            &instruction.effects,
            block.id,
            position,
            location,
            locals,
            regions,
            definitions,
            dominators,
            &instruction.id,
        );
        let expected_results = &instruction.operation.signature.results;
        if instruction.results.len() != expected_results.len() {
            self.error(
                location,
                format!(
                    "{} defines {} results, but {} expects {}",
                    instruction.id,
                    instruction.results.len(),
                    instruction.operation.mnemonic,
                    expected_results.len()
                ),
            );
        }
        for (result, expected) in instruction.results.iter().zip(expected_results) {
            if !are_value_types_equivalent(&self.module.types, &result.ty, expected) {
                self.error(
                    location,
                    format!(
                        "{} defines {} as {}, expected {}",
                        instruction.id, result.id, result.ty, expected
                    ),
                );
            }
        }
    }

    /// The checks shared by every carrier of an operation, its operands, and
    /// its stored effects: an instruction, or an invoke terminator.
    #[allow(clippy::too_many_arguments)]
    fn verify_operation_site(
        &mut self,
        operation: &Operation,
        operands: &[ValueId],
        effects: &Effects,
        block: BlockId,
        position: usize,
        location: VerifyLocation,
        locals: &[ValueType],
        regions: &RegionIndex<'_>,
        definitions: &Definitions,
        dominators: &Dominators,
        owner: &dyn fmt::Display,
    ) {
        self.verify_operation(operation, location, owner, Some(locals.len()));

        let expected_params = &operation.signature.params;
        if operands.len() != expected_params.len() {
            self.error(
                location,
                format!(
                    "{owner} has {} operands, but {} expects {}",
                    operands.len(),
                    operation.mnemonic,
                    expected_params.len()
                ),
            );
        }
        for (operand, expected) in operands.iter().zip(expected_params) {
            self.verify_use(*operand, block, position, location, definitions, dominators);
            if definitions.get(operand).is_some_and(|definition| {
                !is_value_subtype(&self.module.types, &definition.ty, expected)
            }) {
                self.error(
                    location,
                    format!(
                        "{owner} passes {operand} as {}, expected {expected}",
                        definitions
                            .get(operand)
                            .map(|definition| definition.ty.to_string())
                            .unwrap_or_else(|| "<missing>".to_owned()),
                    ),
                );
            }
        }

        // Canonical Core-operation effects are conservative upper bounds. A
        // later pass may narrow stored effects to a subset it has proven, but
        // never widen them, so malformed hand-built IR cannot make a trapping
        // or effectful operation look safe to reorder. Ordered exception
        // routes and their local-state snapshots are the sole augmentation.
        if matches!(operation.kind, OperationKind::Core(_)) {
            let canonical = crate::semantics::effects_for_operation(operation);
            self.verify_effects(effects, &canonical, location, owner, operation.mnemonic());
        }
        self.verify_effect_resources(effects, location, owner);
        self.verify_region_immediates(operation, regions, location, owner);
    }

    fn verify_effect_resources(
        &mut self,
        effects: &Effects,
        location: VerifyLocation,
        owner: &dyn fmt::Display,
    ) {
        for effect in &effects.accesses {
            let valid = match effect.resource {
                EffectResource::Memory(id) => self.valid_memory(id),
                EffectResource::Table(id) => self.valid_table(id),
                EffectResource::Global(id) => self.valid_global(id),
                EffectResource::DataSegment(id) => self.valid_data(id),
                EffectResource::ElementSegment(id) => self.valid_element(id),
                EffectResource::GcHeap | EffectResource::Host => true,
            };
            if !valid {
                self.error(
                    location,
                    format!("{owner} has an effect on a missing resource"),
                );
            }
        }
    }

    fn verify_region_immediates(
        &mut self,
        operation: &Operation,
        regions: &RegionIndex<'_>,
        location: VerifyLocation,
        owner: &dyn fmt::Display,
    ) {
        for immediate in &operation.immediates {
            if let Immediate::Region(region) = immediate {
                if !regions.contains_key(region) {
                    self.error(location, format!("{owner} references missing {region}"));
                }
            }
        }
    }

    /// Every stored effect must be covered by the canonical effects of the
    /// same operation: accesses on covered resources at no greater strength,
    /// a subset of the traps, and no flag the canonical form lacks.
    fn verify_effects(
        &mut self,
        stored: &Effects,
        canonical: &Effects,
        location: VerifyLocation,
        owner: &dyn fmt::Display,
        mnemonic: &str,
    ) {
        let mut seen = Vec::new();
        for effect in &stored.accesses {
            if seen.contains(&effect.resource) {
                self.error(
                    location,
                    format!(
                        "{owner} lists {} more than once in its accesses",
                        effect.resource
                    ),
                );
            }
            seen.push(effect.resource);
            let covered = canonical.accesses.iter().any(|candidate| {
                candidate.resource.covers(effect.resource)
                    && effect.access.is_within(candidate.access)
            });
            if !covered {
                self.error(
                    location,
                    format!(
                        "{owner} stores {}:{}, but {mnemonic} canonically has {}",
                        effect.access,
                        effect.resource,
                        describe_accesses(&canonical.accesses)
                    ),
                );
            }
        }
        for trap in &stored.traps {
            if !canonical.traps.contains(trap) {
                self.error(
                    location,
                    format!(
                        "{owner} stores trap:{trap}, but {mnemonic} canonically has {}",
                        describe_traps(&canonical.traps)
                    ),
                );
            }
        }
        if stored.allocates && !canonical.allocates {
            self.error(
                location,
                format!(
                    "{owner} stores allocates=true, but {mnemonic} canonically has allocates=false"
                ),
            );
        }
        let stored_may_throw = stored.exception == ExceptionEffect::MayThrow;
        let canonical_may_throw = canonical.exception == ExceptionEffect::MayThrow;
        if stored_may_throw && !canonical_may_throw {
            self.error(
                location,
                format!(
                    "{owner} stores may-throw=true, but {mnemonic} canonically has may-throw=false"
                ),
            );
        }
        if stored.nondeterministic && !canonical.nondeterministic {
            self.error(
                location,
                format!(
                    "{owner} stores nondeterministic=true, but {mnemonic} canonically has nondeterministic=false"
                ),
            );
        }
    }

    fn verify_terminator(
        &mut self,
        function: FunctionId,
        signature: &FunctionType,
        block: &Block,
        locals: &[ValueType],
        blocks: &BlockIndex<'_>,
        regions: &RegionIndex<'_>,
        definitions: &Definitions,
        dominators: &Dominators,
    ) {
        let location = VerifyLocation::block(function, block.id);
        self.verify_source(block.terminator.source, location, &"terminator");
        let position = block.instructions.len();
        let leading = block.terminator.kind.leading_parameters();
        match (&block.terminator.kind, &block.terminator.exception) {
            (TerminatorKind::Invoke { .. }, Some(routing)) => {
                if routing.arms.is_empty() {
                    self.error(
                        location,
                        "invoke has no in-function exception route; a purely escaping operation must be an ordinary instruction",
                    );
                }
                self.verify_exception_routing(
                    function,
                    block,
                    position,
                    routing,
                    ExceptionOrigin::Dynamic,
                    location,
                    blocks,
                    regions,
                    definitions,
                    dominators,
                );
            }
            (TerminatorKind::TailCall { .. }, Some(routing)) => {
                if !routing.arms.is_empty() || !routing.escapes {
                    self.error(
                        location,
                        "tail call must use an escape-only exception route",
                    );
                }
            }
            (TerminatorKind::Throw { tag, arguments }, Some(routing)) => {
                self.verify_exception_routing(
                    function,
                    block,
                    position,
                    routing,
                    ExceptionOrigin::Known {
                        tag: *tag,
                        arguments,
                    },
                    location,
                    blocks,
                    regions,
                    definitions,
                    dominators,
                );
            }
            (TerminatorKind::ThrowRef { .. }, Some(routing)) => {
                self.verify_exception_routing(
                    function,
                    block,
                    position,
                    routing,
                    ExceptionOrigin::Dynamic,
                    location,
                    blocks,
                    regions,
                    definitions,
                    dominators,
                );
            }
            (
                TerminatorKind::Invoke { .. }
                | TerminatorKind::TailCall { .. }
                | TerminatorKind::Throw { .. }
                | TerminatorKind::ThrowRef { .. },
                None,
            ) => self.error(location, "exceptional terminator has no exception route"),
            (_, Some(_)) => self.error(location, "non-throwing terminator has exception routing"),
            (_, None) => {}
        }
        match &block.terminator.kind {
            TerminatorKind::Jump(edge) => self.verify_edge(
                block,
                position,
                edge,
                None,
                location,
                blocks,
                definitions,
                dominators,
                leading,
            ),
            TerminatorKind::Invoke {
                operation,
                operands,
                effects,
                normal,
            } => {
                self.verify_operation_site(
                    operation,
                    operands,
                    effects,
                    block.id,
                    position,
                    location,
                    locals,
                    regions,
                    definitions,
                    dominators,
                    &"invoke",
                );
                if effects.exception == ExceptionEffect::None {
                    self.error(
                        location,
                        format!("invoke wraps {}, which cannot throw", operation.mnemonic),
                    );
                }
                let results = &operation.signature.results;
                if let Some(target) = blocks.get(&normal.target) {
                    if target.parameters.len() < results.len() {
                        self.error(
                            location,
                            format!(
                                "invoke continuation {} declares {} parameters, but {} produces {} results",
                                normal.target,
                                target.parameters.len(),
                                operation.mnemonic,
                                results.len()
                            ),
                        );
                    }
                    for (index, (parameter, expected)) in
                        target.parameters.iter().zip(results).enumerate()
                    {
                        if !are_value_types_equivalent(&self.module.types, &parameter.ty, expected)
                        {
                            self.error(
                                location,
                                format!(
                                    "invoke continuation {} parameter {index} is {}, expected {} result {expected}",
                                    normal.target, parameter.ty, operation.mnemonic
                                ),
                            );
                        }
                    }
                }
                self.verify_edge(
                    block,
                    position,
                    normal,
                    None,
                    location,
                    blocks,
                    definitions,
                    dominators,
                    leading,
                );
            }
            TerminatorKind::Branch {
                condition,
                then_edge,
                else_edge,
            } => {
                self.verify_typed_use(
                    *condition,
                    &ValueType::I32,
                    block.id,
                    position,
                    location,
                    definitions,
                    dominators,
                    &"branch condition",
                );
                for (edge, outcome) in [
                    (then_edge, BranchOutcome::True),
                    (else_edge, BranchOutcome::False),
                ] {
                    self.verify_edge(
                        block,
                        position,
                        edge,
                        Some(ConditionalEdge {
                            condition: *condition,
                            outcome,
                        }),
                        location,
                        blocks,
                        definitions,
                        dominators,
                        leading,
                    );
                }
            }
            TerminatorKind::Switch {
                selector,
                targets,
                default,
            } => {
                self.verify_typed_use(
                    *selector,
                    &ValueType::I32,
                    block.id,
                    position,
                    location,
                    definitions,
                    dominators,
                    &"switch selector",
                );
                for edge in targets.iter().chain(std::iter::once(default)) {
                    self.verify_edge(
                        block,
                        position,
                        edge,
                        None,
                        location,
                        blocks,
                        definitions,
                        dominators,
                        leading,
                    );
                }
            }
            TerminatorKind::Return { values } => self.verify_value_list(
                values,
                &signature.results,
                block.id,
                position,
                location,
                definitions,
                dominators,
                &"return",
            ),
            TerminatorKind::TailCall { callee, arguments } => {
                let callee_signature = self.verify_callee(
                    function,
                    block.id,
                    position,
                    callee,
                    location,
                    definitions,
                    dominators,
                );
                if let Some(callee_signature) = callee_signature {
                    self.verify_value_list(
                        arguments,
                        &callee_signature.params,
                        block.id,
                        position,
                        location,
                        definitions,
                        dominators,
                        &"tail call",
                    );
                    if callee_signature.results.len() != signature.results.len()
                        || !callee_signature.results.iter().zip(&signature.results).all(
                            |(actual, expected)| {
                                is_value_subtype(&self.module.types, actual, expected)
                            },
                        )
                    {
                        self.error(
                            location,
                            format!(
                                "tail call returns {:?}, current function returns {:?}",
                                callee_signature.results, signature.results
                            ),
                        );
                    }
                }
            }
            TerminatorKind::Throw { tag, arguments } => {
                let tag_signature = self
                    .module
                    .tags
                    .get(tag.index())
                    .and_then(|definition| self.function_type(definition.ty.signature))
                    .cloned();
                match tag_signature {
                    Some(tag_signature) => self.verify_value_list(
                        arguments,
                        &tag_signature.params,
                        block.id,
                        position,
                        location,
                        definitions,
                        dominators,
                        &"throw",
                    ),
                    None => self.error(location, format!("throw references missing {tag}")),
                }
            }
            TerminatorKind::ThrowRef { exception } => {
                self.verify_use(
                    *exception,
                    block.id,
                    position,
                    location,
                    definitions,
                    dominators,
                );
                if let Some(definition) = definitions.get(exception) {
                    let expected = ValueType::Ref(RefType {
                        nullable: true,
                        heap: HeapType::Exn,
                    });
                    if !is_value_subtype(&self.module.types, &definition.ty, &expected) {
                        self.error(
                            location,
                            format!(
                                "throw_ref operand {exception} has type {}, expected {expected}",
                                definition.ty
                            ),
                        );
                    }
                }
            }
            TerminatorKind::Unreachable { .. } => {}
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn verify_callee(
        &mut self,
        _function: FunctionId,
        block: BlockId,
        position: usize,
        callee: &Callee,
        location: VerifyLocation,
        definitions: &Definitions,
        dominators: &Dominators,
    ) -> Option<FunctionType> {
        let ty = match callee {
            Callee::Direct(function) => match self.module.functions.get(function.index()) {
                Some(function) => function.ty,
                None => {
                    self.error(location, format!("tail call references missing {function}"));
                    return None;
                }
            },
            Callee::Indirect { ty, table, index } => {
                let table_type = self
                    .module
                    .tables
                    .get(table.index())
                    .map(|table| table.ty.clone());
                match table_type {
                    Some(table_type) => {
                        let expected = table_type.address_type.value_type();
                        self.verify_typed_use(
                            *index,
                            &expected,
                            block,
                            position,
                            location,
                            definitions,
                            dominators,
                            &"indirect-call table index",
                        );
                        if !is_heap_subtype(
                            &self.module.types,
                            &table_type.element.heap,
                            &HeapType::Func,
                        ) {
                            self.error(
                                location,
                                format!(
                                    "indirect tail call uses {table} with element type {}, expected a subtype of funcref",
                                    table_type.element
                                ),
                            );
                        }
                    }
                    None => self.error(location, format!("tail call references missing {table}")),
                }
                *ty
            }
            Callee::Reference { ty, reference } => {
                self.verify_use(
                    *reference,
                    block,
                    position,
                    location,
                    definitions,
                    dominators,
                );
                if self.function_type(*ty).is_some() {
                    let expected = ValueType::Ref(RefType {
                        nullable: true,
                        heap: HeapType::Concrete(*ty),
                    });
                    if let Some(definition) = definitions.get(reference) {
                        if !is_value_subtype(&self.module.types, &definition.ty, &expected) {
                            self.error(
                                location,
                                format!(
                                    "call_ref callee {reference} has type {}, expected {expected}",
                                    definition.ty
                                ),
                            );
                        }
                    }
                }
                *ty
            }
        };
        match self.function_type(ty) {
            Some(signature) => Some(signature.clone()),
            None => {
                self.error(
                    location,
                    format!("tail call has missing or non-function {ty}"),
                );
                None
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn verify_exception_routing(
        &mut self,
        _function: FunctionId,
        block: &Block,
        position: usize,
        routing: &ExceptionRouting,
        origin: ExceptionOrigin<'_>,
        location: VerifyLocation,
        blocks: &BlockIndex<'_>,
        regions: &RegionIndex<'_>,
        definitions: &Definitions,
        dominators: &Dominators,
    ) {
        let known_tag = match origin {
            ExceptionOrigin::Known { tag, .. } => Some(tag),
            ExceptionOrigin::Dynamic => None,
        };
        let (expected_arms, expected_escape) =
            expected_exception_routing(self.module, block.region, regions, origin);
        let actual_arms: Vec<_> = routing
            .arms
            .iter()
            .map(|arm| (arm.handler, arm.clause))
            .collect();
        if actual_arms != expected_arms {
            let mut message = format!(
                "exception routes are {actual_arms:?}, expected lexical routes {expected_arms:?}"
            );
            for &(handler, clause) in &expected_arms {
                let (Some(thrown), Some(caught)) = (
                    known_tag,
                    regions.get(&handler).and_then(|region| match &region.kind {
                        RegionKind::TryTable { catches } => {
                            catches.get(clause as usize).and_then(|catch| catch.tag)
                        }
                        _ => None,
                    }),
                ) else {
                    continue;
                };
                if caught != thrown && self.module.tags_may_alias(caught, thrown) {
                    message.push_str(&format!(
                        "; {handler}#{clause} catches {caught}, which may alias thrown {thrown} (both imported with equivalent types)"
                    ));
                }
            }
            self.error(location, message);
        }
        if routing.escapes != expected_escape {
            self.error(
                location,
                format!(
                    "exception route escapes={}, expected escapes={expected_escape}",
                    routing.escapes
                ),
            );
        }

        for arm in &routing.arms {
            let Some(handler) = regions.get(&arm.handler) else {
                self.error(
                    location,
                    format!("exception route names missing {}", arm.handler),
                );
                self.verify_orphan_exceptional_arguments(
                    block.id,
                    position,
                    &arm.arguments,
                    location,
                    definitions,
                    dominators,
                );
                continue;
            };
            let RegionKind::TryTable { catches } = &handler.kind else {
                self.error(
                    location,
                    format!("exception route handler {} is not a try_table", arm.handler),
                );
                self.verify_orphan_exceptional_arguments(
                    block.id,
                    position,
                    &arm.arguments,
                    location,
                    definitions,
                    dominators,
                );
                continue;
            };
            let Some(catch) = catches.get(arm.clause as usize) else {
                self.error(
                    location,
                    format!(
                        "exception route references missing clause {}#{}",
                        arm.handler, arm.clause
                    ),
                );
                self.verify_orphan_exceptional_arguments(
                    block.id,
                    position,
                    &arm.arguments,
                    location,
                    definitions,
                    dominators,
                );
                continue;
            };
            if !region_contains(regions, arm.handler, block.region) {
                self.error(
                    location,
                    format!(
                        "exception route {}#{} is not an enclosing handler of {}",
                        arm.handler, arm.clause, block.id
                    ),
                );
            }
            if arm.target != catch.target {
                self.error(
                    location,
                    format!(
                        "exception route {}#{} targets {}, but the clause targets {}",
                        arm.handler, arm.clause, arm.target, catch.target
                    ),
                );
            }
            let Some(target) = blocks.get(&arm.target) else {
                self.error(
                    location,
                    format!("exception route targets missing {}", arm.target),
                );
                self.verify_orphan_exceptional_arguments(
                    block.id,
                    position,
                    &arm.arguments,
                    location,
                    definitions,
                    dominators,
                );
                continue;
            };
            let Some((tag_payload, payload)) = self.catch_payload_types(catch) else {
                continue;
            };
            let owner = format!(
                "exception route {}#{} to {}",
                arm.handler, arm.clause, catch.target
            );
            if arm.arguments.len() != target.parameters.len() {
                self.error(
                    location,
                    format!(
                        "{owner} supplies {} arguments, expected {}",
                        arm.arguments.len(),
                        target.parameters.len()
                    ),
                );
            }

            for (index, argument) in arm.arguments.iter().enumerate() {
                let parameter = target.parameters.get(index);
                if index < payload.len() {
                    let expected_payload = &payload[index];
                    if let Some(parameter) = parameter {
                        if !is_value_subtype(&self.module.types, expected_payload, &parameter.ty) {
                            self.error(
                                location,
                                format!(
                                    "{owner} payload {index} has type {expected_payload}, but target parameter is {}",
                                    parameter.ty
                                ),
                            );
                        }
                    }
                    match argument {
                        ExceptionalArgument::CaughtPayload { index: field, ty } => {
                            if !matches!(origin, ExceptionOrigin::Dynamic) {
                                self.error(
                                    location,
                                    format!(
                                        "{owner} uses dynamic payload provenance for a known throw"
                                    ),
                                );
                            }
                            if index >= tag_payload || *field as usize != index {
                                self.error(
                                    location,
                                    format!(
                                        "{owner} payload slot {index} names caught field {field}"
                                    ),
                                );
                            }
                            self.verify_value_type(ty, location, &"caught payload");
                            if !are_value_types_equivalent(&self.module.types, ty, expected_payload)
                            {
                                self.error(
                                    location,
                                    format!(
                                        "{owner} caught field {field} stores type {ty}, expected {expected_payload}"
                                    ),
                                );
                            }
                        }
                        ExceptionalArgument::CaughtException => {
                            if index != tag_payload
                                || !matches!(
                                    catch.kind,
                                    CatchKind::CatchRef | CatchKind::CatchAllRef
                                )
                            {
                                self.error(
                                    location,
                                    format!(
                                        "{owner} has an exception reference in payload slot {index}"
                                    ),
                                );
                            }
                        }
                        ExceptionalArgument::Value(value) => {
                            let valid_known_payload = match origin {
                                ExceptionOrigin::Known { arguments, .. } => {
                                    index < tag_payload && arguments.get(index) == Some(value)
                                }
                                ExceptionOrigin::Dynamic => false,
                            };
                            if !valid_known_payload {
                                self.error(
                                    location,
                                    format!(
                                        "{owner} uses ordinary {value} for synthesized payload slot {index}"
                                    ),
                                );
                            }
                            if let Some(parameter) = parameter {
                                self.verify_typed_use(
                                    *value,
                                    &parameter.ty,
                                    block.id,
                                    position,
                                    location,
                                    definitions,
                                    dominators,
                                    &owner,
                                );
                            } else {
                                self.verify_use(
                                    *value,
                                    block.id,
                                    position,
                                    location,
                                    definitions,
                                    dominators,
                                );
                            }
                        }
                    }
                } else {
                    match (argument, parameter) {
                        (ExceptionalArgument::Value(value), Some(parameter)) => {
                            self.verify_typed_use(
                                *value,
                                &parameter.ty,
                                block.id,
                                position,
                                location,
                                definitions,
                                dominators,
                                &owner,
                            );
                        }
                        (ExceptionalArgument::Value(value), None) => self.verify_use(
                            *value,
                            block.id,
                            position,
                            location,
                            definitions,
                            dominators,
                        ),
                        _ => self.error(
                            location,
                            format!("{owner} local slot {index} is not an ordinary SSA value"),
                        ),
                    }
                }
            }
        }
    }

    fn catch_payload_types(&mut self, catch: &CatchClause) -> Option<(usize, Vec<ValueType>)> {
        let mut payload = match catch.kind {
            CatchKind::Catch | CatchKind::CatchRef => {
                let tag = catch.tag?;
                let signature = self
                    .module
                    .tags
                    .get(tag.index())
                    .and_then(|definition| self.function_type(definition.ty.signature))?;
                signature.params.clone()
            }
            CatchKind::CatchAll | CatchKind::CatchAllRef => Vec::new(),
        };
        let tag_payload = payload.len();
        if matches!(catch.kind, CatchKind::CatchRef | CatchKind::CatchAllRef) {
            payload.push(ValueType::Ref(RefType {
                nullable: false,
                heap: HeapType::Exn,
            }));
        }
        Some((tag_payload, payload))
    }

    fn verify_orphan_exceptional_arguments(
        &mut self,
        block: BlockId,
        position: usize,
        arguments: &[ExceptionalArgument],
        location: VerifyLocation,
        definitions: &Definitions,
        dominators: &Dominators,
    ) {
        for argument in arguments {
            if let ExceptionalArgument::Value(value) = argument {
                self.verify_use(*value, block, position, location, definitions, dominators);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn verify_edge(
        &mut self,
        source: &Block,
        position: usize,
        edge: &Edge,
        conditional: Option<ConditionalEdge>,
        location: VerifyLocation,
        blocks: &BlockIndex<'_>,
        definitions: &Definitions,
        dominators: &Dominators,
        leading_parameters: usize,
    ) {
        let owner = format!("edge to {}", edge.target);
        let mut refined_slots = BTreeMap::new();
        let mut previous = None;
        for refinement in &edge.refinements {
            let slot = refinement.slot;
            if slot as usize >= edge.arguments.len() {
                self.error(
                    location,
                    format!(
                        "{owner} refines missing argument slot {slot}; only {} arguments are present",
                        edge.arguments.len()
                    ),
                );
            }
            if refined_slots.insert(slot as usize, refinement).is_some() {
                self.error(
                    location,
                    format!("{owner} refines argument slot {slot} more than once"),
                );
            } else if previous.is_some_and(|previous| previous >= slot) {
                self.error(
                    location,
                    format!("{owner} refined argument slots are not strictly increasing"),
                );
            }
            previous = Some(slot);
            self.verify_value_type(&refinement.proven, location, &owner);
        }
        if conditional.is_none() && !edge.refinements.is_empty() {
            self.error(
                location,
                format!("{owner} carries conditional refinements on a non-branch edge"),
            );
        }

        let target = blocks.get(&edge.target);
        if target.is_none() {
            self.error(location, format!("edge targets missing {}", edge.target));
        }
        let expected_arguments =
            target.map(|target| target.parameters.len().saturating_sub(leading_parameters));
        if expected_arguments.is_some_and(|expected| edge.arguments.len() != expected) {
            self.error(
                location,
                format!(
                    "{owner} supplies {} values, expected {}",
                    edge.arguments.len(),
                    expected_arguments.unwrap_or(0)
                ),
            );
        }
        for (index, argument) in edge.arguments.iter().enumerate() {
            let parameter =
                target.and_then(|target| target.parameters.get(leading_parameters + index));
            if let Some(refinement) = refined_slots.get(&index) {
                self.verify_use(
                    *argument,
                    source.id,
                    position,
                    location,
                    definitions,
                    dominators,
                );
                let Some(conditional) = conditional else {
                    continue;
                };
                let proven = &refinement.proven;
                match conditional_reference_refinement(
                    &self.module.types,
                    blocks,
                    *argument,
                    conditional,
                    definitions,
                ) {
                    Ok(predicate_proven) => {
                        if !is_value_subtype(&self.module.types, &predicate_proven, proven) {
                            self.error(
                                location,
                                format!(
                                    "{owner} refined argument slot {index} claims {proven}, but its predicate only proves {predicate_proven}"
                                ),
                            );
                        }
                        if let Some(parameter) = parameter {
                            if !is_value_subtype(&self.module.types, proven, &parameter.ty) {
                                self.error(
                                    location,
                                    format!(
                                        "{owner} refined argument slot {index} is proven as {proven}, which is not a subtype of target parameter {}",
                                        parameter.ty
                                    ),
                                );
                            }
                        }
                    }
                    Err(detail) => self.error(
                        location,
                        format!(
                            "{owner} cannot refine argument slot {index} from {argument}: {detail}"
                        ),
                    ),
                }
            } else if let Some(parameter) = parameter {
                self.verify_typed_use(
                    *argument,
                    &parameter.ty,
                    source.id,
                    position,
                    location,
                    definitions,
                    dominators,
                    &owner,
                );
            } else {
                self.verify_use(
                    *argument,
                    source.id,
                    position,
                    location,
                    definitions,
                    dominators,
                );
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn verify_value_list(
        &mut self,
        values: &[ValueId],
        expected: &[ValueType],
        block: BlockId,
        position: usize,
        location: VerifyLocation,
        definitions: &Definitions,
        dominators: &Dominators,
        owner: &dyn fmt::Display,
    ) {
        if values.len() != expected.len() {
            self.error(
                location,
                format!(
                    "{owner} supplies {} values, expected {}",
                    values.len(),
                    expected.len()
                ),
            );
        }
        for (value, expected) in values.iter().zip(expected) {
            self.verify_typed_use(
                *value,
                expected,
                block,
                position,
                location,
                definitions,
                dominators,
                owner,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn verify_typed_use(
        &mut self,
        value: ValueId,
        expected: &ValueType,
        block: BlockId,
        position: usize,
        location: VerifyLocation,
        definitions: &Definitions,
        dominators: &Dominators,
        owner: &dyn fmt::Display,
    ) {
        self.verify_use(value, block, position, location, definitions, dominators);
        if let Some(definition) = definitions.get(&value) {
            if !is_value_subtype(&self.module.types, &definition.ty, expected) {
                self.error(
                    location,
                    format!(
                        "{owner} uses {value} as {}, expected {expected}",
                        definition.ty
                    ),
                );
            }
        }
    }

    fn verify_use(
        &mut self,
        value: ValueId,
        block: BlockId,
        position: usize,
        location: VerifyLocation,
        definitions: &Definitions,
        dominators: &Dominators,
    ) {
        let Some(definition) = definitions.get(&value) else {
            self.error(location, format!("use of undefined {value}"));
            return;
        };
        if definition.block == block {
            if let DefinitionPosition::Instruction(definition_position) = definition.position {
                if definition_position >= position {
                    self.error(location, format!("{value} is used before its definition"));
                }
            }
        } else if !dominators.dominates(definition.block, block) {
            self.error(
                location,
                format!(
                    "{value} from {} does not dominate its use in {block}",
                    definition.block
                ),
            );
        }
    }
}

/// The type a conditional edge's predicate proves for `argument`.
///
/// The predicate is the condition's defining instruction wherever it lives;
/// dominance of the condition over the branch is verified with the branch's
/// other uses, so a predicate hoisted into a dominating block still justifies
/// the refinement.
fn conditional_reference_refinement(
    types: &[TypeDefinition],
    blocks: &BlockIndex<'_>,
    argument: ValueId,
    conditional: ConditionalEdge,
    definitions: &Definitions,
) -> Result<ValueType, String> {
    let condition_definition = definitions
        .get(&conditional.condition)
        .ok_or_else(|| format!("condition {} is undefined", conditional.condition))?;
    let DefinitionPosition::Instruction(position) = condition_definition.position else {
        return Err(format!(
            "condition {} is a block parameter, not a reference predicate",
            conditional.condition
        ));
    };
    let defining_block = blocks.get(&condition_definition.block).ok_or_else(|| {
        format!(
            "condition {} is defined in missing {}",
            conditional.condition, condition_definition.block
        )
    })?;
    let instruction = defining_block.instructions.get(position).ok_or_else(|| {
        format!(
            "condition {} has an invalid definition position",
            conditional.condition
        )
    })?;
    if instruction.operands.as_slice() != [argument] {
        return Err(format!(
            "condition {} does not test the refined argument",
            conditional.condition
        ));
    }
    match instruction.results.as_slice() {
        [result] if result.id == conditional.condition && result.ty == ValueType::I32 => {}
        _ => {
            return Err(format!(
                "condition {} is not the sole i32 result of its predicate",
                conditional.condition
            ));
        }
    }
    if instruction.operation.signature.results.as_slice() != [ValueType::I32] {
        return Err("reference predicate does not have the exact result signature [i32]".into());
    }

    let argument_type = &definitions
        .get(&argument)
        .ok_or_else(|| format!("refined argument {argument} is undefined"))?
        .ty;
    let ValueType::Ref(actual) = argument_type else {
        return Err(format!(
            "refined argument has non-reference type {argument_type}"
        ));
    };

    match instruction.operation.kind {
        OperationKind::Core(CoreOpcode::RefIsNull) => {
            if !instruction.operation.immediates.is_empty() {
                return Err("ref.is_null predicate has unexpected immediates".into());
            }
            let [ValueType::Ref(accepted)] = instruction.operation.signature.params.as_slice()
            else {
                return Err("ref.is_null predicate does not have one reference parameter".into());
            };
            if !is_ref_subtype(types, actual, accepted) {
                return Err(format!(
                    "ref.is_null tests {actual}, which is not accepted by {accepted}"
                ));
            }
            if conditional.outcome == BranchOutcome::True {
                return Err("the true edge of ref.is_null does not prove non-nullness".into());
            }
            Ok(ValueType::Ref(RefType {
                nullable: false,
                heap: actual.heap.clone(),
            }))
        }
        OperationKind::Core(
            opcode @ (CoreOpcode::RefTestNonNull | CoreOpcode::RefTestNullable),
        ) => {
            let [ValueType::Ref(from)] = instruction.operation.signature.params.as_slice() else {
                return Err("ref.test predicate does not have one reference parameter".into());
            };
            let [Immediate::HeapType(heap)] = instruction.operation.immediates.as_slice() else {
                return Err(
                    "ref.test predicate does not have exactly one heap-type immediate".into(),
                );
            };
            if !is_ref_subtype(types, actual, from) {
                return Err(format!(
                    "ref.test operand type {actual} is not a subtype of declared input {from}"
                ));
            }
            let to = RefType {
                nullable: opcode == CoreOpcode::RefTestNullable,
                heap: heap.clone(),
            };
            if !is_ref_subtype(types, &to, from) {
                return Err(format!(
                    "ref.test target {to} is not a subtype of declared input {from}"
                ));
            }
            let proven = match conditional.outcome {
                BranchOutcome::True => to,
                BranchOutcome::False => RefType {
                    nullable: if to.nullable { false } else { from.nullable },
                    heap: from.heap.clone(),
                },
            };
            Ok(ValueType::Ref(proven))
        }
        _ => Err(format!(
            "condition {} is not produced by ref.is_null or ref.test",
            conditional.condition
        )),
    }
}

fn describe_accesses(accesses: &[Effect]) -> String {
    if accesses.is_empty() {
        return "no accesses".to_owned();
    }
    let items: Vec<String> = accesses
        .iter()
        .map(|effect| format!("{}:{}", effect.access, effect.resource))
        .collect();
    format!("[{}]", items.join(", "))
}

fn describe_traps(traps: &[TrapCode]) -> String {
    if traps.is_empty() {
        return "no traps".to_owned();
    }
    let items: Vec<String> = traps.iter().map(TrapCode::to_string).collect();
    format!("[{}]", items.join(", "))
}

fn region_contains(
    regions: &RegionIndex<'_>,
    ancestor: RegionId,
    mut descendant: RegionId,
) -> bool {
    let mut visited = BTreeSet::new();
    while visited.insert(descendant) {
        if descendant == ancestor {
            return true;
        }
        let Some(parent) = regions.get(&descendant).and_then(|region| region.parent) else {
            return false;
        };
        descendant = parent;
    }
    false
}

fn expected_exception_routing(
    module: &Program,
    mut region: RegionId,
    regions: &RegionIndex<'_>,
    origin: ExceptionOrigin<'_>,
) -> (Vec<(RegionId, u32)>, bool) {
    let mut handlers = Vec::new();
    let mut visited = BTreeSet::new();
    while visited.insert(region) {
        let Some(definition) = regions.get(&region) else {
            break;
        };
        if let RegionKind::TryTable { catches } = &definition.kind {
            handlers.push((region, catches.as_slice()));
        }
        let Some(parent) = definition.parent else {
            break;
        };
        region = parent;
    }
    let known = match origin {
        ExceptionOrigin::Dynamic => None,
        ExceptionOrigin::Known { tag, .. } => Some(tag),
    };
    lexical_exception_arms(&module.types, &module.tags, handlers, known)
}

/// The in-function arms an exception raised inside `handlers` (innermost
/// first, each a `try_table` region with its clauses) can reach, and whether
/// it can escape past all of them.
///
/// A throw of a `known` tag stops at the first clause that definitely catches
/// it and keeps every earlier clause that possibly does; an exception of
/// unknown tag keeps every clause up to and including the first `catch_all`.
pub fn lexical_exception_arms<'a>(
    types: &[TypeDefinition],
    tags: &[Tag],
    handlers: impl IntoIterator<Item = (RegionId, &'a [CatchClause])>,
    known: Option<TagId>,
) -> (Vec<(RegionId, u32)>, bool) {
    let mut arms = Vec::new();
    for (region, catches) in handlers {
        for (index, catch) in catches.iter().enumerate() {
            let matched = match known {
                Some(tag) => known_throw_clause_match(types, tags, catch, tag),
                None if matches!(catch.kind, CatchKind::CatchAll | CatchKind::CatchAllRef) => {
                    ClauseMatch::Definite
                }
                None => ClauseMatch::Possible,
            };
            match matched {
                ClauseMatch::Definite => {
                    arms.push((region, index as u32));
                    return (arms, false);
                }
                ClauseMatch::Possible => arms.push((region, index as u32)),
                ClauseMatch::Never => {}
            }
        }
    }
    (arms, true)
}

impl fmt::Display for StorageType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::I8 => f.write_str("i8"),
            Self::I16 => f.write_str("i16"),
            Self::Value(ty) => ty.fmt(f),
        }
    }
}

impl fmt::Display for FieldType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.mutable {
            write!(f, "(mut {})", self.storage)
        } else {
            self.storage.fmt(f)
        }
    }
}

impl fmt::Display for TypeDefinition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(canonical) = self.canonical_alias {
            write!(f, "canonical({canonical}) ")?;
        }
        if self.final_ {
            f.write_str("final ")?;
        }
        if let Some(supertype) = self.supertype {
            write!(f, "sub {supertype} ")?;
        }
        match &self.composite {
            CompositeType::Function(signature) => signature.fmt(f),
            CompositeType::Struct(fields) => {
                f.write_str("struct")?;
                for field in fields {
                    write!(f, " (field {field})")?;
                }
                Ok(())
            }
            CompositeType::Array(field) => write!(f, "array (field {field})"),
        }
    }
}

impl fmt::Display for AddressType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::I32 => f.write_str("i32"),
            Self::I64 => f.write_str("i64"),
        }
    }
}

impl fmt::Display for Immediate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::U32(value) => write!(f, "u32={value}"),
            Self::U64(value) => write!(f, "u64={value}"),
            Self::S32(value) => write!(f, "s32={value}"),
            Self::S64(value) => write!(f, "s64={value}"),
            Self::F32(bits) => write!(f, "f32=0x{bits:08x}"),
            Self::F64(bits) => write!(f, "f64=0x{bits:016x}"),
            Self::V128(bytes) => {
                f.write_str("v128=0x")?;
                fmt_hex(f, bytes)
            }
            Self::Lane(lane) => write!(f, "lane={lane}"),
            Self::Bytes(bytes) => {
                f.write_str("bytes=0x")?;
                fmt_hex(f, bytes)
            }
            Self::Type(id) => write!(f, "type={id}"),
            Self::Function(id) => write!(f, "function={id}"),
            Self::Table(id) => write!(f, "table={id}"),
            Self::Memory(id) => write!(f, "memory={id}"),
            Self::Global(id) => write!(f, "global={id}"),
            Self::Tag(id) => write!(f, "tag={id}"),
            Self::Element(id) => write!(f, "element={id}"),
            Self::Data(id) => write!(f, "data={id}"),
            Self::Local(id) => write!(f, "local={id}"),
            Self::Region(id) => write!(f, "region={id}"),
            Self::ValueType(ty) => write!(f, "value-type={ty}"),
            Self::HeapType(ty) => write!(f, "heap-type={ty}"),
            Self::MemoryArgument(argument) => write!(
                f,
                "memarg(memory={},offset={},align={})",
                argument.memory, argument.offset, argument.alignment_log2
            ),
        }
    }
}

impl fmt::Display for Operation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.mnemonic)?;
        if !self.immediates.is_empty() {
            f.write_str("<")?;
            for (index, immediate) in self.immediates.iter().enumerate() {
                if index != 0 {
                    f.write_str(", ")?;
                }
                immediate.fmt(f)?;
            }
            f.write_str(">")?;
        }
        Ok(())
    }
}

impl fmt::Display for EffectResource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Memory(id) => write!(f, "{id}"),
            Self::Table(id) => write!(f, "{id}"),
            Self::Global(id) => write!(f, "{id}"),
            Self::DataSegment(id) => write!(f, "{id}"),
            Self::ElementSegment(id) => write!(f, "{id}"),
            Self::GcHeap => f.write_str("gc-heap"),
            Self::Host => f.write_str("host"),
        }
    }
}

impl fmt::Display for EffectAccess {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read => f.write_str("read"),
            Self::Write => f.write_str("write"),
            Self::ReadWrite => f.write_str("read-write"),
        }
    }
}

impl fmt::Display for TrapCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable => f.write_str("unreachable"),
            Self::IntegerDivideByZero => f.write_str("integer-divide-by-zero"),
            Self::IntegerOverflow => f.write_str("integer-overflow"),
            Self::InvalidConversionToInteger => f.write_str("invalid-conversion-to-integer"),
            Self::MemoryOutOfBounds => f.write_str("memory-out-of-bounds"),
            Self::TableOutOfBounds => f.write_str("table-out-of-bounds"),
            Self::IndirectCallTypeMismatch => f.write_str("indirect-call-type-mismatch"),
            Self::NullReference => f.write_str("null-reference"),
            Self::NullFunctionReference => f.write_str("null-function-reference"),
            Self::BadArrayElement => f.write_str("bad-array-element"),
            Self::AllocationFailure => f.write_str("allocation-failure"),
            Self::StackOverflow => f.write_str("stack-overflow"),
            Self::Other(name) => f.write_str(name),
        }
    }
}

impl fmt::Display for RegionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Function => f.write_str("function"),
            Self::Block => f.write_str("block"),
            Self::Loop => f.write_str("loop"),
            Self::IfThen => f.write_str("if-then"),
            Self::IfElse => f.write_str("if-else"),
            Self::TryTable { catches } => {
                f.write_str("try-table[")?;
                for (index, catch) in catches.iter().enumerate() {
                    if index != 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{:?}", catch.kind)?;
                    if let Some(tag) = catch.tag {
                        write!(f, "({tag})")?;
                    }
                    write!(f, " -> {}", catch.target)?;
                }
                f.write_str("]")
            }
            Self::Catch => f.write_str("catch"),
            Self::CompilerGenerated => f.write_str("compiler-generated"),
        }
    }
}

impl fmt::Display for EntityOrigin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Imported(id) => write!(f, "imported({id})"),
            Self::Defined => f.write_str("defined"),
        }
    }
}

impl fmt::Display for ImportItem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Function(id) => write!(f, "function {id}"),
            Self::Table(id) => write!(f, "table {id}"),
            Self::Memory(id) => write!(f, "memory {id}"),
            Self::Global(id) => write!(f, "global {id}"),
            Self::Tag(id) => write!(f, "tag {id}"),
        }
    }
}

impl fmt::Display for ExportItem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Function(id) => write!(f, "function {id}"),
            Self::Table(id) => write!(f, "table {id}"),
            Self::Memory(id) => write!(f, "memory {id}"),
            Self::Global(id) => write!(f, "global {id}"),
            Self::Tag(id) => write!(f, "tag {id}"),
        }
    }
}

impl fmt::Display for Program {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            f,
            "wedge.module binary-version={} language={} {{",
            self.wasm_version, self.language
        )?;

        for (index, group) in self.rec_groups.iter().enumerate() {
            write!(f, "  rec rec{index} = [")?;
            for (position, ty) in group.types.iter().enumerate() {
                if position != 0 {
                    f.write_str(", ")?;
                }
                write!(f, "{ty}")?;
            }
            f.write_str("]")?;
            fmt_source(f, group.source)?;
            writeln!(f)?;
        }
        for (index, definition) in self.types.iter().enumerate() {
            write!(f, "  type type{index} = {definition}")?;
            fmt_source(f, definition.source)?;
            writeln!(f)?;
        }
        for (index, import) in self.imports.iter().enumerate() {
            write!(
                f,
                "  import import{index} {:?}.{:?} = {}",
                import.module, import.name, import.item
            )?;
            fmt_source(f, import.source)?;
            writeln!(f)?;
        }
        for (index, table) in self.tables.iter().enumerate() {
            write!(
                f,
                "  table table{index} : {} {} {}..",
                table.ty.element, table.ty.address_type, table.ty.limits.min
            )?;
            match table.ty.limits.max {
                Some(max) => write!(f, "{max}")?,
                None => f.write_str("*")?,
            }
            write!(f, " {}", table.origin)?;
            if let Some(initializer) = &table.initializer {
                f.write_str(" init=")?;
                fmt_const_expr(f, initializer)?;
            }
            fmt_source(f, table.source)?;
            writeln!(f)?;
        }
        for (index, memory) in self.memories.iter().enumerate() {
            write!(
                f,
                "  memory memory{index} : {} {}..",
                memory.ty.address_type, memory.ty.limits.min
            )?;
            match memory.ty.limits.max {
                Some(max) => write!(f, "{max}")?,
                None => f.write_str("*")?,
            }
            write!(f, " {}", memory.origin)?;
            fmt_source(f, memory.source)?;
            writeln!(f)?;
        }
        for (index, global) in self.globals.iter().enumerate() {
            write!(f, "  global global{index} : ")?;
            if global.ty.mutable {
                write!(f, "(mut {})", global.ty.value)?;
            } else {
                write!(f, "{}", global.ty.value)?;
            }
            write!(f, " {}", global.origin)?;
            if let Some(initializer) = &global.initializer {
                f.write_str(" init=")?;
                fmt_const_expr(f, initializer)?;
            }
            fmt_source(f, global.source)?;
            writeln!(f)?;
        }
        for (index, tag) in self.tags.iter().enumerate() {
            write!(f, "  tag tag{index} : {} {}", tag.ty.signature, tag.origin)?;
            fmt_source(f, tag.source)?;
            writeln!(f)?;
        }
        for (index, function) in self.functions.iter().enumerate() {
            let id = FunctionId(index as u32);
            fmt_function(f, id, function, self.function_name(id))?;
        }
        for (index, element) in self.elements.iter().enumerate() {
            write!(f, "  element elem{index} : {} ", element.ty)?;
            match &element.mode {
                ElementMode::Passive => f.write_str("passive")?,
                ElementMode::Declarative => f.write_str("declarative")?,
                ElementMode::Active { table, offset } => {
                    write!(f, "active {table} at ")?;
                    fmt_const_expr(f, offset)?;
                }
            }
            f.write_str(" [")?;
            for (position, item) in element.items.iter().enumerate() {
                if position != 0 {
                    f.write_str(", ")?;
                }
                match item {
                    ElementItem::Function(function) => write!(f, "{function}")?,
                    ElementItem::Expression(expression) => fmt_const_expr(f, expression)?,
                }
            }
            f.write_str("]")?;
            fmt_source(f, element.source)?;
            writeln!(f)?;
        }
        for (index, data) in self.data.iter().enumerate() {
            write!(f, "  data data{index} ")?;
            match &data.mode {
                DataMode::Passive => f.write_str("passive")?,
                DataMode::Active { memory, offset } => {
                    write!(f, "active {memory} at ")?;
                    fmt_const_expr(f, offset)?;
                }
            }
            f.write_str(" = 0x")?;
            fmt_hex(f, &data.bytes)?;
            fmt_source(f, data.source)?;
            writeln!(f)?;
        }
        for export in &self.exports {
            write!(f, "  export {:?} = {}", export.name, export.item)?;
            fmt_source(f, export.source)?;
            writeln!(f)?;
        }
        if let Some(start) = self.start {
            writeln!(f, "  start {start}")?;
        }
        if let Some(name) = &self.metadata.module_name {
            writeln!(f, "  name module = {name:?}")?;
        }
        for (function, name) in &self.metadata.function_names {
            writeln!(f, "  name {function} = {name:?}")?;
        }
        for ((function, local), name) in &self.metadata.local_names {
            writeln!(f, "  name {function}/{local} = {name:?}")?;
        }
        for producer in &self.metadata.producers {
            writeln!(
                f,
                "  producer {:?} {:?} {:?}",
                producer.field, producer.name, producer.version
            )?;
        }
        for section in &self.metadata.custom_sections {
            write!(f, "  custom {:?} = 0x", section.name)?;
            fmt_hex(f, &section.data)?;
            fmt_source(f, section.source)?;
            writeln!(f)?;
        }
        f.write_str("}\n")
    }
}

/// See [`Program::function_display`].
#[derive(Clone, Copy, Debug)]
pub struct FunctionDisplay<'program> {
    program: &'program Program,
    function: FunctionId,
}

impl fmt::Display for FunctionDisplay<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let function = &self.program.functions[self.function.index()];
        let name = self.program.function_name(self.function);
        fmt_function(f, self.function, function, name)
    }
}

fn fmt_function(
    f: &mut fmt::Formatter<'_>,
    id: FunctionId,
    function: &Function,
    name: Option<&str>,
) -> fmt::Result {
    write!(
        f,
        "  func {id} wasm-index={} : {} {}",
        function.wasm_index, function.ty, function.origin
    )?;
    if let Some(name) = name {
        write!(f, " name={name:?}")?;
    }
    fmt_source(f, function.source)?;
    let Some(body) = &function.body else {
        return f.write_str("\n");
    };
    f.write_str(" {\n")?;
    if !function.locals.is_empty() {
        f.write_str("    locals")?;
        for (index, ty) in function.locals.iter().enumerate() {
            write!(f, " local{index}:{ty}")?;
        }
        f.write_str("\n")?;
    }
    writeln!(f, "    cfg entry={} root={}", body.entry, body.root_region)?;
    for region in &body.regions {
        write!(f, "    region {} {} parent=", region.id, region.kind)?;
        match region.parent {
            Some(parent) => write!(f, "{parent}")?,
            None => f.write_str("-")?,
        }
        write!(f, " entry={}", region.entry)?;
        fmt_source(f, region.source)?;
        writeln!(f)?;
    }
    for block in &body.blocks {
        write!(f, "    {}(", block.id)?;
        for (index, parameter) in block.parameters.iter().enumerate() {
            if index != 0 {
                f.write_str(", ")?;
            }
            write!(f, "{}: {}", parameter.id, parameter.ty)?;
        }
        write!(f, ") [{}]", block.region)?;
        fmt_source(f, block.source)?;
        f.write_str(":\n")?;
        for instruction in &block.instructions {
            f.write_str("      ")?;
            if !instruction.results.is_empty() {
                for (index, result) in instruction.results.iter().enumerate() {
                    if index != 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{}: {}", result.id, result.ty)?;
                }
                f.write_str(" = ")?;
            }
            fmt::Display::fmt(&instruction.operation, f)?;
            f.write_str("(")?;
            for (index, operand) in instruction.operands.iter().enumerate() {
                if index != 0 {
                    f.write_str(", ")?;
                }
                write!(f, "{operand}")?;
            }
            write!(f, ") ; {}", instruction.id)?;
            fmt_effects(f, &instruction.effects)?;
            fmt_source(f, instruction.source)?;
            writeln!(f)?;
        }
        f.write_str("      ")?;
        fmt_terminator(f, body, &block.terminator.kind)?;
        if let Some(routing) = &block.terminator.exception {
            f.write_str(" ")?;
            fmt_exception_routing(f, routing)?;
        }
        fmt_source(f, block.terminator.source)?;
        writeln!(f)?;
    }
    f.write_str("  }\n")
}

fn fmt_terminator(
    f: &mut fmt::Formatter<'_>,
    body: &FunctionBody,
    terminator: &TerminatorKind,
) -> fmt::Result {
    match terminator {
        TerminatorKind::Jump(edge) => {
            f.write_str("jump ")?;
            fmt_edge(f, edge)
        }
        TerminatorKind::Invoke {
            operation,
            operands,
            effects,
            normal,
        } => {
            f.write_str("invoke ")?;
            fmt::Display::fmt(operation, f)?;
            f.write_str("(")?;
            for (index, operand) in operands.iter().enumerate() {
                if index != 0 {
                    f.write_str(", ")?;
                }
                write!(f, "{operand}")?;
            }
            write!(f, ") -> {}(", normal.target)?;
            let results = terminator.leading_parameters();
            let leading = body.block(normal.target).map_or(&[][..], |block| {
                &block.parameters[..block.parameters.len().min(results)]
            });
            for (index, parameter) in leading.iter().enumerate() {
                if index != 0 {
                    f.write_str(", ")?;
                }
                write!(f, "{}: {}", parameter.id, parameter.ty)?;
            }
            if !normal.arguments.is_empty() {
                f.write_str("; ")?;
                for (index, argument) in normal.arguments.iter().enumerate() {
                    if index != 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{argument}")?;
                }
            }
            f.write_str(")")?;
            fmt_effects_of_kind(f, effects, false)
        }
        TerminatorKind::Branch {
            condition,
            then_edge,
            else_edge,
        } => {
            write!(f, "branch {condition}, ")?;
            fmt_edge(f, then_edge)?;
            f.write_str(", ")?;
            fmt_edge(f, else_edge)
        }
        TerminatorKind::Switch {
            selector,
            targets,
            default,
        } => {
            write!(f, "switch {selector} [")?;
            for (index, edge) in targets.iter().enumerate() {
                if index != 0 {
                    f.write_str(", ")?;
                }
                fmt_edge(f, edge)?;
            }
            f.write_str("] default ")?;
            fmt_edge(f, default)
        }
        TerminatorKind::Return { values } => {
            f.write_str("return")?;
            for value in values {
                write!(f, " {value}")?;
            }
            Ok(())
        }
        TerminatorKind::TailCall { callee, arguments } => {
            f.write_str("tail-call ")?;
            match callee {
                Callee::Direct(function) => write!(f, "{function}")?,
                Callee::Indirect { ty, table, index } => {
                    write!(f, "indirect({ty}, {table}, {index})")?;
                }
                Callee::Reference { ty, reference } => {
                    write!(f, "reference({ty}, {reference})")?;
                }
            }
            f.write_str("(")?;
            for (index, argument) in arguments.iter().enumerate() {
                if index != 0 {
                    f.write_str(", ")?;
                }
                write!(f, "{argument}")?;
            }
            f.write_str(")")
        }
        TerminatorKind::Throw { tag, arguments } => {
            write!(f, "throw {tag}(")?;
            for (index, argument) in arguments.iter().enumerate() {
                if index != 0 {
                    f.write_str(", ")?;
                }
                write!(f, "{argument}")?;
            }
            f.write_str(")")
        }
        TerminatorKind::ThrowRef { exception } => write!(f, "throw-ref {exception}"),
        TerminatorKind::Unreachable { trap } => write!(f, "unreachable [{trap}]"),
    }
}

fn fmt_edge(f: &mut fmt::Formatter<'_>, edge: &Edge) -> fmt::Result {
    write!(f, "{}(", edge.target)?;
    for (index, argument) in edge.arguments.iter().enumerate() {
        if index != 0 {
            f.write_str(", ")?;
        }
        if let Some(refinement) = edge.refinement(index) {
            write!(f, "refine({argument} as {})", refinement.proven)?;
        } else {
            write!(f, "{argument}")?;
        }
    }
    f.write_str(")")
}

fn fmt_effects(f: &mut fmt::Formatter<'_>, effects: &Effects) -> fmt::Result {
    fmt_effects_of_kind(f, effects, true)
}

/// Prints an effects clause; `with_exception` is false for an invoke, whose
/// routing is printed by its terminator instead.
fn fmt_effects_of_kind(
    f: &mut fmt::Formatter<'_>,
    effects: &Effects,
    with_exception: bool,
) -> fmt::Result {
    if effects.is_pure() || (!with_exception && !effects.has_state_effects()) {
        return Ok(());
    }
    f.write_str(" effects[")?;
    let mut needs_separator = false;
    for effect in &effects.accesses {
        if needs_separator {
            f.write_str(", ")?;
        }
        write!(f, "{}:{}", effect.access, effect.resource)?;
        needs_separator = true;
    }
    for trap in &effects.traps {
        if needs_separator {
            f.write_str(", ")?;
        }
        write!(f, "trap:{trap}")?;
        needs_separator = true;
    }
    if effects.allocates {
        if needs_separator {
            f.write_str(", ")?;
        }
        f.write_str("allocates")?;
        needs_separator = true;
    }
    if effects.nondeterministic {
        if needs_separator {
            f.write_str(", ")?;
        }
        f.write_str("nondeterministic")?;
        needs_separator = true;
    }
    if with_exception && effects.exception == ExceptionEffect::MayThrow {
        if needs_separator {
            f.write_str(", ")?;
        }
        f.write_str("throws[escape]")?;
    }
    f.write_str("]")
}

fn fmt_exception_routing(f: &mut fmt::Formatter<'_>, routing: &ExceptionRouting) -> fmt::Result {
    f.write_str("throws[")?;
    for (arm_index, arm) in routing.arms.iter().enumerate() {
        if arm_index != 0 {
            f.write_str(", ")?;
        }
        write!(f, "{}#{} -> {}(", arm.handler, arm.clause, arm.target)?;
        for (argument_index, argument) in arm.arguments.iter().enumerate() {
            if argument_index != 0 {
                f.write_str(", ")?;
            }
            match argument {
                ExceptionalArgument::Value(value) => write!(f, "{value}")?,
                ExceptionalArgument::CaughtPayload { index, ty } => {
                    write!(f, "caught[{index}]:{ty}")?;
                }
                ExceptionalArgument::CaughtException => f.write_str("caught-exn")?,
            }
        }
        f.write_str(")")?;
    }
    if routing.escapes {
        if !routing.arms.is_empty() {
            f.write_str(", ")?;
        }
        f.write_str("escape")?;
    }
    f.write_str("]")
}

fn fmt_const_expr(f: &mut fmt::Formatter<'_>, expression: &ConstExpr) -> fmt::Result {
    f.write_str("const[")?;
    for (index, instruction) in expression.instructions.iter().enumerate() {
        if index != 0 {
            f.write_str("; ")?;
        }
        fmt::Display::fmt(&instruction.operation, f)?;
    }
    write!(f, "]:{}", expression.result_type)
}

fn fmt_source(f: &mut fmt::Formatter<'_>, source: SourceInfo) -> fmt::Result {
    if source.byte_span.is_none() && source.ordinal.is_none() {
        return Ok(());
    }
    f.write_str(" @")?;
    if let Some(span) = source.byte_span {
        write!(f, "bytes={}..{}", span.start, span.end)?;
        if source.ordinal.is_some() {
            f.write_str(",")?;
        }
    }
    if let Some(ordinal) = source.ordinal {
        write!(f, "op={ordinal}")?;
    }
    Ok(())
}

fn fmt_hex(f: &mut fmt::Formatter<'_>, bytes: &[u8]) -> fmt::Result {
    for byte in bytes {
        write!(f, "{byte:02x}")?;
    }
    Ok(())
}
