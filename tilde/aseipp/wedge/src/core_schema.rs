// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fail-closed schemas for owned Core WebAssembly operations.
//!
//! `wasmparser` owns the operator inventory and [`CoreOpcode`] exposes each
//! variant's ordered parser field names. This module is the single mapping
//! from those fields to Wedge's owned [`Immediate`] representation. Keeping
//! that mapping separate from lowering lets the IR verifier reject forged
//! operations with missing, extra, reordered, or incorrectly typed
//! immediates. It also coordinates the context-independent numeric/SIMD and
//! module-contextual typed schemas, requiring every standard ordinary opcode
//! to belong to exactly one of them.

use std::sync::OnceLock;

use crate::ir::{Immediate, Operation, OperationKind, Program};
use crate::opcode::CoreOpcode;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OperatorPlacement {
    Instruction,
    StructuredControl,
    LocalSsa,
    Terminator,
}

impl OperatorPlacement {
    const fn description(self) -> &'static str {
        match self {
            Self::Instruction => "ordinary instruction",
            Self::StructuredControl => "structured-control operator",
            Self::LocalSsa => "local SSA action",
            Self::Terminator => "CFG terminator",
        }
    }
}

/// Classify operators which the frontend consumes while constructing the CFG
/// rather than retaining as ordinary instructions.
const fn operator_placement(opcode: CoreOpcode) -> OperatorPlacement {
    use CoreOpcode::*;

    match opcode {
        Block | Loop | If | Else | End | TryTable | Try | Catch | Delegate | CatchAll => {
            OperatorPlacement::StructuredControl
        }
        LocalGet | LocalSet | LocalTee => OperatorPlacement::LocalSsa,
        Unreachable | Br | BrIf | BrTable | Return | ReturnCall | ReturnCallIndirect
        | ReturnCallRef | Throw | ThrowRef | BrOnNull | BrOnNonNull | BrOnCast | BrOnCastFail
        | BrOnCastDescEq | BrOnCastDescEqFail | Rethrow | Suspend | Resume | ResumeThrow
        | ResumeThrowRef | Switch => OperatorPlacement::Terminator,
        _ => OperatorPlacement::Instruction,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ImmediateKind {
    U32,
    S32,
    S64,
    F32,
    F64,
    V128,
    Lane,
    Bytes,
    Bytes16,
    Type,
    Function,
    Table,
    Memory,
    Global,
    Tag,
    Element,
    Data,
    Local,
    ValueType,
    HeapType,
    MemoryArgument,
}

impl ImmediateKind {
    const fn description(self) -> &'static str {
        match self {
            Self::U32 => "an unsigned 32-bit integer",
            Self::S32 => "a signed 32-bit integer",
            Self::S64 => "a signed 64-bit integer",
            Self::F32 => "raw f32 bits",
            Self::F64 => "raw f64 bits",
            Self::V128 => "a v128 constant",
            Self::Lane => "a SIMD lane index",
            Self::Bytes => "an opaque byte string",
            Self::Bytes16 => "exactly 16 bytes",
            Self::Type => "a type reference",
            Self::Function => "a function reference",
            Self::Table => "a table reference",
            Self::Memory => "a memory reference",
            Self::Global => "a global reference",
            Self::Tag => "a tag reference",
            Self::Element => "an element-segment reference",
            Self::Data => "a data-segment reference",
            Self::Local => "a local reference",
            Self::ValueType => "a value type",
            Self::HeapType => "a heap type",
            Self::MemoryArgument => "a memory argument",
        }
    }

    fn matches(self, immediate: &Immediate) -> bool {
        match (self, immediate) {
            (Self::U32, Immediate::U32(_))
            | (Self::S32, Immediate::S32(_))
            | (Self::S64, Immediate::S64(_))
            | (Self::F32, Immediate::F32(_))
            | (Self::F64, Immediate::F64(_))
            | (Self::V128, Immediate::V128(_))
            | (Self::Lane, Immediate::Lane(_))
            | (Self::Bytes, Immediate::Bytes(_))
            | (Self::Type, Immediate::Type(_))
            | (Self::Function, Immediate::Function(_))
            | (Self::Table, Immediate::Table(_))
            | (Self::Memory, Immediate::Memory(_))
            | (Self::Global, Immediate::Global(_))
            | (Self::Tag, Immediate::Tag(_))
            | (Self::Element, Immediate::Element(_))
            | (Self::Data, Immediate::Data(_))
            | (Self::Local, Immediate::Local(_))
            | (Self::ValueType, Immediate::ValueType(_))
            | (Self::HeapType, Immediate::HeapType(_))
            | (Self::MemoryArgument, Immediate::MemoryArgument(_)) => true,
            (Self::Bytes16, Immediate::Bytes(bytes)) => bytes.len() == 16,
            _ => false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FieldShape {
    One(ImmediateKind),
    /// `Vec<ValType>` is flattened as a `U32` count followed by that many
    /// `ValueType` immediates.
    CountedValueTypes,
}

fn constant_value_kind(opcode: CoreOpcode) -> Option<ImmediateKind> {
    Some(match opcode {
        CoreOpcode::I32Const => ImmediateKind::S32,
        CoreOpcode::I64Const => ImmediateKind::S64,
        CoreOpcode::F32Const => ImmediateKind::F32,
        CoreOpcode::F64Const => ImmediateKind::F64,
        CoreOpcode::V128Const => ImmediateKind::V128,
        _ => return None,
    })
}

/// Translate every field name present in `wasmparser` 0.258's operator
/// inventory. Returning `None` is deliberately an error, not a generic `U32`
/// fallback: a dependency update cannot silently weaken IR verification.
fn field_shape(opcode: CoreOpcode, field: &str) -> Option<FieldShape> {
    use FieldShape::{CountedValueTypes, One};
    use ImmediateKind::*;

    Some(match field {
        "value" => One(constant_value_kind(opcode)?),
        "function_index" => One(Function),
        "local_index" => One(Local),
        "global_index" => One(Global),
        "tag_index" | "tag" => One(Tag),
        "elem_index" | "array_elem_index" | "array_elem_index_dst" | "array_elem_index_src" => {
            One(Element)
        }
        "data_index" | "array_data_index" | "array_data_index_dst" | "array_data_index_src" => {
            One(Data)
        }
        "table" | "table_index" | "dst_table" | "src_table" => One(Table),
        "mem" | "dst_mem" | "src_mem" => One(Memory),
        "type_index"
        | "struct_type_index"
        | "array_type_index"
        | "array_type_index_dst"
        | "array_type_index_src"
        | "cont_type_index" => One(Type),
        "relative_depth" | "field_index" | "array_size" | "argument_index" | "result_index" => {
            One(U32)
        }
        "lane" => One(Lane),
        "lanes" => One(Bytes16),
        "memarg" => One(MemoryArgument),
        "ty" => One(ValueType),
        "tys" => CountedValueTypes,
        "hty" => One(HeapType),
        "from_ref_type" | "to_ref_type" => One(ValueType),
        // These borrowed or structured parser fields are debug-encoded by
        // `AppendImmediate`. Standard operators carrying them are classified
        // above as non-instructions and therefore cannot enter operation IR.
        // Ordering and resume tables only occur in rejected proposals.
        "blockty" | "targets" | "try_table" | "ordering" | "resume_table" => One(Bytes),
        _ => return None,
    })
}

fn validate_schema_inventory_uncached() -> Result<(), String> {
    for &opcode in CoreOpcode::ALL {
        for &field in opcode.immediate_fields() {
            if field_shape(opcode, field).is_none() {
                return Err(format!(
                    "Core operator {} has unmapped wasmparser immediate field `{field}`",
                    opcode.parser_name()
                ));
            }
        }
    }
    Ok(())
}

/// Check that every field in the pinned parser inventory has an explicit
/// owned-IR mapping. The result is cached because operation verification calls
/// this before checking an individual layout.
pub(crate) fn validate_schema_inventory() -> Result<(), String> {
    static RESULT: OnceLock<Result<(), String>> = OnceLock::new();
    RESULT
        .get_or_init(validate_schema_inventory_uncached)
        .clone()
}

fn validate_operation_inventory_uncached() -> Result<(), String> {
    validate_schema_inventory()?;
    let empty_module = Program::new(1);
    for &opcode in CoreOpcode::ALL {
        let probe = Operation::core(opcode, Vec::new(), Vec::new());
        let numeric = crate::core_numeric::validate(&probe).is_some();
        let contextual = crate::core_context::validate(&empty_module, &probe).is_some();
        if !opcode.is_standard_wasm3() {
            if numeric || contextual {
                return Err(format!(
                    "out-of-profile Core operator {} has an ordinary semantic schema",
                    opcode.mnemonic()
                ));
            }
            continue;
        }

        let ordinary = operator_placement(opcode) == OperatorPlacement::Instruction;
        match (ordinary, numeric, contextual) {
            (true, true, false) | (true, false, true) | (false, false, false) => {}
            (true, false, false) => {
                return Err(format!(
                    "standard ordinary Core operator {} has no semantic schema",
                    opcode.mnemonic()
                ));
            }
            (true, true, true) => {
                return Err(format!(
                    "standard ordinary Core operator {} has overlapping semantic schemas",
                    opcode.mnemonic()
                ));
            }
            (false, _, _) => {
                return Err(format!(
                    "non-instruction Core operator {} has an ordinary semantic schema",
                    opcode.mnemonic()
                ));
            }
        }
    }
    Ok(())
}

/// Check every parser-derived Core opcode against Wedge's fail-closed
/// placement, immediate, and typed-operation inventories.
///
/// This is invoked even for modules without function bodies. A newly added
/// standard opcode therefore cannot silently acquire ordinary-operation
/// semantics from a wildcard fallback after a `wasmparser` update.
pub(crate) fn validate_operation_inventory() -> Result<(), String> {
    static RESULT: OnceLock<Result<(), String>> = OnceLock::new();
    RESULT
        .get_or_init(validate_operation_inventory_uncached)
        .clone()
}

fn actual_kind(immediate: &Immediate) -> &'static str {
    match immediate {
        Immediate::U32(_) => "an unsigned 32-bit integer",
        Immediate::U64(_) => "an unsigned 64-bit integer",
        Immediate::S32(_) => "a signed 32-bit integer",
        Immediate::S64(_) => "a signed 64-bit integer",
        Immediate::F32(_) => "raw f32 bits",
        Immediate::F64(_) => "raw f64 bits",
        Immediate::V128(_) => "a v128 constant",
        Immediate::Lane(_) => "a SIMD lane index",
        Immediate::Bytes(_) => "a byte string",
        Immediate::Type(_) => "a type reference",
        Immediate::Function(_) => "a function reference",
        Immediate::Table(_) => "a table reference",
        Immediate::Memory(_) => "a memory reference",
        Immediate::Global(_) => "a global reference",
        Immediate::Tag(_) => "a tag reference",
        Immediate::Element(_) => "an element-segment reference",
        Immediate::Data(_) => "a data-segment reference",
        Immediate::Local(_) => "a local reference",
        Immediate::Region(_) => "a region reference",
        Immediate::ValueType(_) => "a value type",
        Immediate::HeapType(_) => "a heap type",
        Immediate::MemoryArgument(_) => "a memory argument",
    }
}

fn consume_one(
    opcode: CoreOpcode,
    field: &str,
    expected: ImmediateKind,
    immediates: &[Immediate],
    cursor: &mut usize,
) -> Result<(), String> {
    let Some(actual) = immediates.get(*cursor) else {
        return Err(format!(
            "Core operator {} is missing immediate {} for field `{field}` (expected {})",
            opcode.mnemonic(),
            *cursor,
            expected.description()
        ));
    };
    if !expected.matches(actual) {
        return Err(format!(
            "Core operator {} immediate {} for field `{field}` must be {}, found {}",
            opcode.mnemonic(),
            *cursor,
            expected.description(),
            actual_kind(actual)
        ));
    }
    *cursor += 1;
    Ok(())
}

/// Validate an operation's exact immediate count, order, and owned kinds.
///
/// Synthetic operations have compiler-defined schemas and are intentionally
/// ignored here. Core control/local/terminator opcodes are rejected because
/// their information belongs in Wedge's CFG and SSA structures instead.
pub(crate) fn validate_immediate_layout(operation: &Operation) -> Result<(), String> {
    let OperationKind::Core(opcode) = operation.kind else {
        return Ok(());
    };

    validate_schema_inventory()?;

    let placement = operator_placement(opcode);
    if placement != OperatorPlacement::Instruction {
        return Err(format!(
            "Core operator {} is a {} and cannot be represented as an ordinary IR operation",
            opcode.mnemonic(),
            placement.description()
        ));
    }

    let mut cursor = 0;
    for &field in opcode.immediate_fields() {
        let shape = field_shape(opcode, field).ok_or_else(|| {
            format!(
                "Core operator {} has unmapped wasmparser immediate field `{field}`",
                opcode.parser_name()
            )
        })?;
        match shape {
            FieldShape::One(expected) => {
                consume_one(opcode, field, expected, &operation.immediates, &mut cursor)?;
            }
            FieldShape::CountedValueTypes => {
                let count_index = cursor;
                consume_one(
                    opcode,
                    field,
                    ImmediateKind::U32,
                    &operation.immediates,
                    &mut cursor,
                )?;
                let Immediate::U32(count) = &operation.immediates[count_index] else {
                    unreachable!("consume_one checked the counted value-type length")
                };
                for _ in 0..*count {
                    consume_one(
                        opcode,
                        field,
                        ImmediateKind::ValueType,
                        &operation.immediates,
                        &mut cursor,
                    )?;
                }
            }
        }
    }

    if cursor != operation.immediates.len() {
        return Err(format!(
            "Core operator {} has {} unexpected immediate(s) starting at index {cursor}",
            opcode.mnemonic(),
            operation.immediates.len() - cursor
        ));
    }
    Ok(())
}

/// Validate the complete schema of one ordinary Core operation.
///
/// Mechanical immediate layout is checked before any contextual lookup, then
/// exactly one typed schema family must claim the opcode. Synthetic operations
/// have compiler-owned contracts and are outside this Core layer.
pub(crate) fn validate_operation(module: &Program, operation: &Operation) -> Result<(), String> {
    let OperationKind::Core(opcode) = operation.kind else {
        return Ok(());
    };

    validate_immediate_layout(operation)?;
    if !opcode.is_standard_wasm3() {
        return Ok(());
    }

    if let Some(result) = crate::core_numeric::validate(operation) {
        return result;
    }
    if let Some(result) = crate::core_context::validate(module, operation) {
        return result;
    }
    Err(format!(
        "Core operator {} has no ordinary typed-operation schema",
        opcode.mnemonic()
    ))
}
