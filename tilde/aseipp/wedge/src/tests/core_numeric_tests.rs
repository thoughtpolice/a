// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Forged-IR tests for scalar and non-memory SIMD operation schemas.

mod core_operation_test_support;

use core_operation_test_support::{assert_schema_error, assert_valid_operation};
use wedge::ir::{Immediate, Operation, ValueType};
use wedge::opcode::CoreOpcode;

fn operation(opcode: CoreOpcode, params: &[ValueType], results: &[ValueType]) -> Operation {
    Operation::core(opcode, params.to_vec(), results.to_vec())
}

#[test]
fn accepts_representative_scalar_numeric_schema_families() {
    let cases = [
        operation(CoreOpcode::I32Eqz, &[ValueType::I32], &[ValueType::I32]),
        operation(CoreOpcode::I64Clz, &[ValueType::I64], &[ValueType::I64]),
        operation(
            CoreOpcode::I32LtU,
            &[ValueType::I32, ValueType::I32],
            &[ValueType::I32],
        ),
        operation(
            CoreOpcode::F64Ge,
            &[ValueType::F64, ValueType::F64],
            &[ValueType::I32],
        ),
        operation(
            CoreOpcode::I64Rotr,
            &[ValueType::I64, ValueType::I64],
            &[ValueType::I64],
        ),
        operation(
            CoreOpcode::F32Copysign,
            &[ValueType::F32, ValueType::F32],
            &[ValueType::F32],
        ),
        operation(
            CoreOpcode::I32TruncSatF64U,
            &[ValueType::F64],
            &[ValueType::I32],
        ),
        operation(
            CoreOpcode::I64ReinterpretF64,
            &[ValueType::F64],
            &[ValueType::I64],
        ),
        operation(
            CoreOpcode::F32ConvertI64S,
            &[ValueType::I64],
            &[ValueType::F32],
        ),
        operation(
            CoreOpcode::F64PromoteF32,
            &[ValueType::F32],
            &[ValueType::F64],
        ),
        operation(
            CoreOpcode::I32Extend16S,
            &[ValueType::I32],
            &[ValueType::I32],
        ),
    ];

    for operation in cases {
        assert_valid_operation(operation);
    }
}

#[test]
fn rejects_wrong_scalar_operand_and_result_types() {
    let cases = [
        operation(
            CoreOpcode::I32Add,
            &[ValueType::F32, ValueType::I32],
            &[ValueType::I32],
        ),
        operation(
            CoreOpcode::I64Eq,
            &[ValueType::I64, ValueType::I64],
            &[ValueType::I64],
        ),
        operation(CoreOpcode::F32Sqrt, &[ValueType::F64], &[ValueType::F32]),
        operation(CoreOpcode::I32WrapI64, &[ValueType::I32], &[ValueType::I32]),
        operation(
            CoreOpcode::F64ReinterpretI64,
            &[ValueType::I64],
            &[ValueType::F32],
        ),
    ];

    for operation in cases {
        assert_schema_error(operation, &["has signature", "expected"]);
    }
}

#[test]
fn validates_all_scalar_constant_result_types() {
    let valid = [
        operation(CoreOpcode::I32Const, &[], &[ValueType::I32])
            .with_immediates(vec![Immediate::S32(-1)]),
        operation(CoreOpcode::I64Const, &[], &[ValueType::I64])
            .with_immediates(vec![Immediate::S64(-1)]),
        operation(CoreOpcode::F32Const, &[], &[ValueType::F32])
            .with_immediates(vec![Immediate::F32(0)]),
        operation(CoreOpcode::F64Const, &[], &[ValueType::F64])
            .with_immediates(vec![Immediate::F64(0)]),
    ];
    for operation in valid {
        assert_valid_operation(operation);
    }

    assert_schema_error(
        operation(CoreOpcode::I32Const, &[], &[ValueType::F32])
            .with_immediates(vec![Immediate::S32(0)]),
        &["i32.const", "expected", "i32"],
    );
}

#[test]
fn accepts_every_non_memory_simd_signature_shape() {
    let cases = [
        operation(CoreOpcode::V128Const, &[], &[ValueType::V128])
            .with_immediates(vec![Immediate::V128([0; 16])]),
        operation(
            CoreOpcode::I8x16Splat,
            &[ValueType::I32],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::I64x2Splat,
            &[ValueType::I64],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::F32x4Splat,
            &[ValueType::F32],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::F64x2Splat,
            &[ValueType::F64],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::F32x4ExtractLane,
            &[ValueType::V128],
            &[ValueType::F32],
        )
        .with_immediates(vec![Immediate::Lane(0)]),
        operation(
            CoreOpcode::F64x2ExtractLane,
            &[ValueType::V128],
            &[ValueType::F64],
        )
        .with_immediates(vec![Immediate::Lane(0)]),
        operation(
            CoreOpcode::I64x2ReplaceLane,
            &[ValueType::V128, ValueType::I64],
            &[ValueType::V128],
        )
        .with_immediates(vec![Immediate::Lane(0)]),
        operation(
            CoreOpcode::I8x16Popcnt,
            &[ValueType::V128],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::I32x4Add,
            &[ValueType::V128, ValueType::V128],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::I64x2Bitmask,
            &[ValueType::V128],
            &[ValueType::I32],
        ),
        operation(
            CoreOpcode::I16x8ShrS,
            &[ValueType::V128, ValueType::I32],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::V128Bitselect,
            &[ValueType::V128, ValueType::V128, ValueType::V128],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::F32x4RelaxedMadd,
            &[ValueType::V128, ValueType::V128, ValueType::V128],
            &[ValueType::V128],
        ),
    ];

    for operation in cases {
        assert_valid_operation(operation);
    }
}

#[test]
fn rejects_wrong_simd_scalar_and_vector_positions() {
    let cases = [
        operation(
            CoreOpcode::I8x16Splat,
            &[ValueType::I64],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::I64x2Splat,
            &[ValueType::I32],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::V128AnyTrue,
            &[ValueType::I32],
            &[ValueType::I32],
        ),
        operation(
            CoreOpcode::I8x16Shl,
            &[ValueType::V128, ValueType::I64],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::F64x2RelaxedNmadd,
            &[ValueType::V128, ValueType::V128, ValueType::F64],
            &[ValueType::V128],
        ),
    ];

    for operation in cases {
        assert_schema_error(operation, &["has signature", "expected"]);
    }
}

fn lane_operation(opcode: CoreOpcode, scalar: ValueType, lane: u8, replace: bool) -> Operation {
    let params = if replace {
        vec![ValueType::V128, scalar.clone()]
    } else {
        vec![ValueType::V128]
    };
    let results = if replace {
        vec![ValueType::V128]
    } else {
        vec![scalar]
    };
    Operation::core(opcode, params, results).with_immediates(vec![Immediate::Lane(lane)])
}

#[test]
fn enforces_each_simd_lane_shape_boundary() {
    let cases = [
        (CoreOpcode::I8x16ExtractLaneS, ValueType::I32, 16, false),
        (CoreOpcode::I8x16ExtractLaneU, ValueType::I32, 16, false),
        (CoreOpcode::I8x16ReplaceLane, ValueType::I32, 16, true),
        (CoreOpcode::I16x8ExtractLaneS, ValueType::I32, 8, false),
        (CoreOpcode::I16x8ExtractLaneU, ValueType::I32, 8, false),
        (CoreOpcode::I16x8ReplaceLane, ValueType::I32, 8, true),
        (CoreOpcode::I32x4ExtractLane, ValueType::I32, 4, false),
        (CoreOpcode::I32x4ReplaceLane, ValueType::I32, 4, true),
        (CoreOpcode::F32x4ReplaceLane, ValueType::F32, 4, true),
        (CoreOpcode::F32x4ExtractLane, ValueType::F32, 4, false),
        (CoreOpcode::I64x2ExtractLane, ValueType::I64, 2, false),
        (CoreOpcode::I64x2ReplaceLane, ValueType::I64, 2, true),
        (CoreOpcode::F64x2ExtractLane, ValueType::F64, 2, false),
        (CoreOpcode::F64x2ReplaceLane, ValueType::F64, 2, true),
    ];

    for (opcode, scalar, bound, replace) in cases {
        assert_valid_operation(lane_operation(opcode, scalar.clone(), bound - 1, replace));
        assert_schema_error(
            lane_operation(opcode, scalar, bound, replace),
            &["lane", "out of bounds", "below"],
        );
    }
}

#[test]
fn validates_every_shuffle_selector_not_just_the_vector_length() {
    let shuffle = |lanes| {
        operation(
            CoreOpcode::I8x16Shuffle,
            &[ValueType::V128, ValueType::V128],
            &[ValueType::V128],
        )
        .with_immediates(vec![Immediate::Bytes(lanes)])
    };

    assert_valid_operation(shuffle(vec![31; 16]));
    for bad_lane in [32, 127, 255] {
        let mut lanes = vec![0; 16];
        lanes[9] = bad_lane;
        assert_schema_error(
            shuffle(lanes),
            &["shuffle lane 9", "source index", "below 32"],
        );
    }
}
