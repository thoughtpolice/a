// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Context-independent schemas for Core numeric and vector operations.
//!
//! The parser inventory records arity, but not operand and result types. This
//! module closes that gap for scalar numeric operations and non-memory SIMD
//! operations. Memory operations remain contextual because their address type
//! depends on the referenced memory.

use crate::ir::{Immediate, Operation, OperationKind, ValueType};
use crate::opcode::CoreOpcode;

#[derive(Clone, Copy, Debug)]
enum PrimitiveType {
    I32,
    I64,
    F32,
    F64,
    V128,
}

impl PrimitiveType {
    const fn matches(self, actual: &ValueType) -> bool {
        matches!(
            (self, actual),
            (Self::I32, ValueType::I32)
                | (Self::I64, ValueType::I64)
                | (Self::F32, ValueType::F32)
                | (Self::F64, ValueType::F64)
                | (Self::V128, ValueType::V128)
        )
    }

    const fn name(self) -> &'static str {
        match self {
            Self::I32 => "i32",
            Self::I64 => "i64",
            Self::F32 => "f32",
            Self::F64 => "f64",
            Self::V128 => "v128",
        }
    }
}

const EMPTY: &[PrimitiveType] = &[];
const I32: &[PrimitiveType] = &[PrimitiveType::I32];
const I64: &[PrimitiveType] = &[PrimitiveType::I64];
const F32: &[PrimitiveType] = &[PrimitiveType::F32];
const F64: &[PrimitiveType] = &[PrimitiveType::F64];
const V128: &[PrimitiveType] = &[PrimitiveType::V128];
const I32_I32: &[PrimitiveType] = &[PrimitiveType::I32, PrimitiveType::I32];
const I64_I64: &[PrimitiveType] = &[PrimitiveType::I64, PrimitiveType::I64];
const F32_F32: &[PrimitiveType] = &[PrimitiveType::F32, PrimitiveType::F32];
const F64_F64: &[PrimitiveType] = &[PrimitiveType::F64, PrimitiveType::F64];
const V128_V128: &[PrimitiveType] = &[PrimitiveType::V128, PrimitiveType::V128];
const V128_I32: &[PrimitiveType] = &[PrimitiveType::V128, PrimitiveType::I32];
const V128_I64: &[PrimitiveType] = &[PrimitiveType::V128, PrimitiveType::I64];
const V128_F32: &[PrimitiveType] = &[PrimitiveType::V128, PrimitiveType::F32];
const V128_F64: &[PrimitiveType] = &[PrimitiveType::V128, PrimitiveType::F64];
const V128_V128_V128: &[PrimitiveType] = &[
    PrimitiveType::V128,
    PrimitiveType::V128,
    PrimitiveType::V128,
];

#[derive(Clone, Copy, Debug)]
enum ImmediateConstraint {
    None,
    Lane { exclusive_max: u8 },
    Shuffle,
}

#[derive(Clone, Copy, Debug)]
struct Schema {
    params: &'static [PrimitiveType],
    results: &'static [PrimitiveType],
    immediate: ImmediateConstraint,
}

const fn fixed(params: &'static [PrimitiveType], results: &'static [PrimitiveType]) -> Schema {
    Schema {
        params,
        results,
        immediate: ImmediateConstraint::None,
    }
}

const fn lane(
    params: &'static [PrimitiveType],
    results: &'static [PrimitiveType],
    exclusive_max: u8,
) -> Schema {
    Schema {
        params,
        results,
        immediate: ImmediateConstraint::Lane { exclusive_max },
    }
}

const fn shuffle() -> Schema {
    Schema {
        params: V128_V128,
        results: V128,
        immediate: ImmediateConstraint::Shuffle,
    }
}

/// Validate a scalar-numeric or non-memory SIMD operation.
///
/// `None` means that this module does not own the opcode's schema. A returned
/// result is always definitive; recognized opcodes fail closed.
pub(crate) fn validate(operation: &Operation) -> Option<Result<(), String>> {
    let OperationKind::Core(opcode) = operation.kind else {
        return None;
    };
    let schema = schema(opcode)?;
    Some(validate_schema(operation, opcode, schema))
}

fn validate_schema(
    operation: &Operation,
    opcode: CoreOpcode,
    schema: Schema,
) -> Result<(), String> {
    if !type_list_matches(&operation.signature.params, schema.params)
        || !type_list_matches(&operation.signature.results, schema.results)
    {
        return Err(format!(
            "Core operator {} has signature {}, expected {}",
            opcode.mnemonic(),
            operation.signature,
            format_signature(schema.params, schema.results),
        ));
    }

    match schema.immediate {
        ImmediateConstraint::None => Ok(()),
        ImmediateConstraint::Lane { exclusive_max } => {
            let [Immediate::Lane(actual)] = operation.immediates.as_slice() else {
                return Err(format!(
                    "Core operator {} must have exactly one SIMD lane immediate",
                    opcode.mnemonic()
                ));
            };
            if *actual >= exclusive_max {
                return Err(format!(
                    "Core operator {} lane {actual} is out of bounds; expected a lane below {exclusive_max}",
                    opcode.mnemonic()
                ));
            }
            Ok(())
        }
        ImmediateConstraint::Shuffle => {
            let [Immediate::Bytes(lanes)] = operation.immediates.as_slice() else {
                return Err(format!(
                    "Core operator {} must have exactly one SIMD shuffle immediate",
                    opcode.mnemonic()
                ));
            };
            if lanes.len() != 16 {
                return Err(format!(
                    "Core operator {} shuffle has {} lanes, expected 16",
                    opcode.mnemonic(),
                    lanes.len()
                ));
            }
            if let Some((index, lane)) = lanes.iter().enumerate().find(|(_, lane)| **lane >= 32) {
                return Err(format!(
                    "Core operator {} shuffle lane {index} has source index {lane}, expected an index below 32",
                    opcode.mnemonic()
                ));
            }
            Ok(())
        }
    }
}

fn type_list_matches(actual: &[ValueType], expected: &[PrimitiveType]) -> bool {
    actual.len() == expected.len()
        && actual
            .iter()
            .zip(expected)
            .all(|(actual, expected)| expected.matches(actual))
}

fn format_signature(params: &[PrimitiveType], results: &[PrimitiveType]) -> String {
    let mut output = String::from("func");
    if !params.is_empty() {
        output.push_str(" (param");
        for ty in params {
            output.push(' ');
            output.push_str(ty.name());
        }
        output.push(')');
    }
    if !results.is_empty() {
        output.push_str(" (result");
        for ty in results {
            output.push(' ');
            output.push_str(ty.name());
        }
        output.push(')');
    }
    output
}

fn schema(opcode: CoreOpcode) -> Option<Schema> {
    use CoreOpcode::*;

    Some(match opcode {
        // Scalar constants.
        I32Const => fixed(EMPTY, I32),
        I64Const => fixed(EMPTY, I64),
        F32Const => fixed(EMPTY, F32),
        F64Const => fixed(EMPTY, F64),

        // Scalar unary operations and equality-to-zero tests.
        I32Eqz | I32Clz | I32Ctz | I32Popcnt | I32Extend8S | I32Extend16S => fixed(I32, I32),
        I64Clz | I64Ctz | I64Popcnt | I64Extend8S | I64Extend16S | I64Extend32S => fixed(I64, I64),
        I64Eqz | I32WrapI64 => fixed(I64, I32),
        F32Abs | F32Neg | F32Ceil | F32Floor | F32Trunc | F32Nearest | F32Sqrt => fixed(F32, F32),
        F64Abs | F64Neg | F64Ceil | F64Floor | F64Trunc | F64Nearest | F64Sqrt => fixed(F64, F64),

        // Scalar comparisons.
        I32Eq | I32Ne | I32LtS | I32LtU | I32GtS | I32GtU | I32LeS | I32LeU | I32GeS | I32GeU => {
            fixed(I32_I32, I32)
        }
        I64Eq | I64Ne | I64LtS | I64LtU | I64GtS | I64GtU | I64LeS | I64LeU | I64GeS | I64GeU => {
            fixed(I64_I64, I32)
        }
        F32Eq | F32Ne | F32Lt | F32Gt | F32Le | F32Ge => fixed(F32_F32, I32),
        F64Eq | F64Ne | F64Lt | F64Gt | F64Le | F64Ge => fixed(F64_F64, I32),

        // Scalar arithmetic and bitwise operations.
        I32Add | I32Sub | I32Mul | I32DivS | I32DivU | I32RemS | I32RemU | I32And | I32Or
        | I32Xor | I32Shl | I32ShrS | I32ShrU | I32Rotl | I32Rotr => fixed(I32_I32, I32),
        I64Add | I64Sub | I64Mul | I64DivS | I64DivU | I64RemS | I64RemU | I64And | I64Or
        | I64Xor | I64Shl | I64ShrS | I64ShrU | I64Rotl | I64Rotr => fixed(I64_I64, I64),
        F32Add | F32Sub | F32Mul | F32Div | F32Min | F32Max | F32Copysign => fixed(F32_F32, F32),
        F64Add | F64Sub | F64Mul | F64Div | F64Min | F64Max | F64Copysign => fixed(F64_F64, F64),

        // Scalar conversions and reinterpretations.
        I32TruncF32S | I32TruncF32U | I32TruncSatF32S | I32TruncSatF32U | I32ReinterpretF32 => {
            fixed(F32, I32)
        }
        I32TruncF64S | I32TruncF64U | I32TruncSatF64S | I32TruncSatF64U => fixed(F64, I32),
        I64ExtendI32S | I64ExtendI32U => fixed(I32, I64),
        I64TruncF32S | I64TruncF32U | I64TruncSatF32S | I64TruncSatF32U => fixed(F32, I64),
        I64TruncF64S | I64TruncF64U | I64TruncSatF64S | I64TruncSatF64U | I64ReinterpretF64 => {
            fixed(F64, I64)
        }
        F32ConvertI32S | F32ConvertI32U | F32ReinterpretI32 => fixed(I32, F32),
        F32ConvertI64S | F32ConvertI64U => fixed(I64, F32),
        F32DemoteF64 => fixed(F64, F32),
        F64ConvertI32S | F64ConvertI32U => fixed(I32, F64),
        F64ConvertI64S | F64ConvertI64U | F64ReinterpretI64 => fixed(I64, F64),
        F64PromoteF32 => fixed(F32, F64),

        // Vector constants and scalar splats.
        V128Const => fixed(EMPTY, V128),
        I8x16Splat | I16x8Splat | I32x4Splat => fixed(I32, V128),
        I64x2Splat => fixed(I64, V128),
        F32x4Splat => fixed(F32, V128),
        F64x2Splat => fixed(F64, V128),

        // Lane extraction and replacement. Bounds are exclusive.
        I8x16ExtractLaneS | I8x16ExtractLaneU => lane(V128, I32, 16),
        I16x8ExtractLaneS | I16x8ExtractLaneU => lane(V128, I32, 8),
        I32x4ExtractLane => lane(V128, I32, 4),
        I64x2ExtractLane => lane(V128, I64, 2),
        F32x4ExtractLane => lane(V128, F32, 4),
        F64x2ExtractLane => lane(V128, F64, 2),
        I8x16ReplaceLane => lane(V128_I32, V128, 16),
        I16x8ReplaceLane => lane(V128_I32, V128, 8),
        I32x4ReplaceLane => lane(V128_I32, V128, 4),
        I64x2ReplaceLane => lane(V128_I64, V128, 2),
        F32x4ReplaceLane => lane(V128_F32, V128, 4),
        F64x2ReplaceLane => lane(V128_F64, V128, 2),
        I8x16Shuffle => shuffle(),

        // Vector tests returning a scalar.
        V128AnyTrue | I8x16AllTrue | I8x16Bitmask | I16x8AllTrue | I16x8Bitmask | I32x4AllTrue
        | I32x4Bitmask | I64x2AllTrue | I64x2Bitmask => fixed(V128, I32),

        // Vector shifts use a scalar shift count.
        I8x16Shl | I8x16ShrS | I8x16ShrU | I16x8Shl | I16x8ShrS | I16x8ShrU | I32x4Shl
        | I32x4ShrS | I32x4ShrU | I64x2Shl | I64x2ShrS | I64x2ShrU => fixed(V128_I32, V128),

        // Vector unary arithmetic, widening, pairwise addition, and
        // vector-to-vector conversions. Lane interpretations do not change
        // the Core value type: all have v128 -> v128 signatures.
        V128Not
        | I8x16Abs
        | I8x16Neg
        | I8x16Popcnt
        | I16x8Abs
        | I16x8Neg
        | I32x4Abs
        | I32x4Neg
        | I64x2Abs
        | I64x2Neg
        | I16x8ExtendLowI8x16S
        | I16x8ExtendHighI8x16S
        | I16x8ExtendLowI8x16U
        | I16x8ExtendHighI8x16U
        | I32x4ExtendLowI16x8S
        | I32x4ExtendHighI16x8S
        | I32x4ExtendLowI16x8U
        | I32x4ExtendHighI16x8U
        | I64x2ExtendLowI32x4S
        | I64x2ExtendHighI32x4S
        | I64x2ExtendLowI32x4U
        | I64x2ExtendHighI32x4U
        | I16x8ExtAddPairwiseI8x16S
        | I16x8ExtAddPairwiseI8x16U
        | I32x4ExtAddPairwiseI16x8S
        | I32x4ExtAddPairwiseI16x8U
        | F32x4Ceil
        | F32x4Floor
        | F32x4Trunc
        | F32x4Nearest
        | F32x4Abs
        | F32x4Neg
        | F32x4Sqrt
        | F64x2Ceil
        | F64x2Floor
        | F64x2Trunc
        | F64x2Nearest
        | F64x2Abs
        | F64x2Neg
        | F64x2Sqrt
        | I32x4TruncSatF32x4S
        | I32x4TruncSatF32x4U
        | F32x4ConvertI32x4S
        | F32x4ConvertI32x4U
        | I32x4TruncSatF64x2SZero
        | I32x4TruncSatF64x2UZero
        | F64x2ConvertLowI32x4S
        | F64x2ConvertLowI32x4U
        | F32x4DemoteF64x2Zero
        | F64x2PromoteLowF32x4
        | I32x4RelaxedTruncF32x4S
        | I32x4RelaxedTruncF32x4U
        | I32x4RelaxedTruncF64x2SZero
        | I32x4RelaxedTruncF64x2UZero => fixed(V128, V128),

        // Vector binary comparisons, bitwise operations, arithmetic,
        // narrowing, widening multiplication, swizzles, and relaxed binary
        // operations all have v128, v128 -> v128 signatures.
        I8x16Eq
        | I8x16Ne
        | I8x16LtS
        | I8x16LtU
        | I8x16GtS
        | I8x16GtU
        | I8x16LeS
        | I8x16LeU
        | I8x16GeS
        | I8x16GeU
        | I16x8Eq
        | I16x8Ne
        | I16x8LtS
        | I16x8LtU
        | I16x8GtS
        | I16x8GtU
        | I16x8LeS
        | I16x8LeU
        | I16x8GeS
        | I16x8GeU
        | I32x4Eq
        | I32x4Ne
        | I32x4LtS
        | I32x4LtU
        | I32x4GtS
        | I32x4GtU
        | I32x4LeS
        | I32x4LeU
        | I32x4GeS
        | I32x4GeU
        | I64x2Eq
        | I64x2Ne
        | I64x2LtS
        | I64x2GtS
        | I64x2LeS
        | I64x2GeS
        | F32x4Eq
        | F32x4Ne
        | F32x4Lt
        | F32x4Gt
        | F32x4Le
        | F32x4Ge
        | F64x2Eq
        | F64x2Ne
        | F64x2Lt
        | F64x2Gt
        | F64x2Le
        | F64x2Ge
        | V128And
        | V128AndNot
        | V128Or
        | V128Xor
        | I8x16Swizzle
        | I8x16RelaxedSwizzle
        | I8x16Add
        | I8x16AddSatS
        | I8x16AddSatU
        | I8x16Sub
        | I8x16SubSatS
        | I8x16SubSatU
        | I8x16MinS
        | I8x16MinU
        | I8x16MaxS
        | I8x16MaxU
        | I8x16AvgrU
        | I16x8Add
        | I16x8AddSatS
        | I16x8AddSatU
        | I16x8Sub
        | I16x8SubSatS
        | I16x8SubSatU
        | I16x8Mul
        | I16x8MinS
        | I16x8MinU
        | I16x8MaxS
        | I16x8MaxU
        | I16x8AvgrU
        | I16x8Q15MulrSatS
        | I32x4Add
        | I32x4Sub
        | I32x4Mul
        | I32x4MinS
        | I32x4MinU
        | I32x4MaxS
        | I32x4MaxU
        | I32x4DotI16x8S
        | I64x2Add
        | I64x2Sub
        | I64x2Mul
        | I8x16NarrowI16x8S
        | I8x16NarrowI16x8U
        | I16x8NarrowI32x4S
        | I16x8NarrowI32x4U
        | I16x8ExtMulLowI8x16S
        | I16x8ExtMulHighI8x16S
        | I16x8ExtMulLowI8x16U
        | I16x8ExtMulHighI8x16U
        | I32x4ExtMulLowI16x8S
        | I32x4ExtMulHighI16x8S
        | I32x4ExtMulLowI16x8U
        | I32x4ExtMulHighI16x8U
        | I64x2ExtMulLowI32x4S
        | I64x2ExtMulHighI32x4S
        | I64x2ExtMulLowI32x4U
        | I64x2ExtMulHighI32x4U
        | F32x4Add
        | F32x4Sub
        | F32x4Mul
        | F32x4Div
        | F32x4Min
        | F32x4Max
        | F32x4PMin
        | F32x4PMax
        | F64x2Add
        | F64x2Sub
        | F64x2Mul
        | F64x2Div
        | F64x2Min
        | F64x2Max
        | F64x2PMin
        | F64x2PMax
        | F32x4RelaxedMin
        | F32x4RelaxedMax
        | F64x2RelaxedMin
        | F64x2RelaxedMax
        | I16x8RelaxedQ15mulrS
        | I16x8RelaxedDotI8x16I7x16S => fixed(V128_V128, V128),

        // Vector ternary selection, fused arithmetic, and relaxed dot-add.
        V128Bitselect
        | F32x4RelaxedMadd
        | F32x4RelaxedNmadd
        | F64x2RelaxedMadd
        | F64x2RelaxedNmadd
        | I8x16RelaxedLaneselect
        | I16x8RelaxedLaneselect
        | I32x4RelaxedLaneselect
        | I64x2RelaxedLaneselect
        | I32x4RelaxedDotI8x16I7x16AddS => fixed(V128_V128_V128, V128),

        _ => return None,
    })
}
