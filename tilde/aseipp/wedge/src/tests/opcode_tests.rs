// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use wasmparser::Operator;
use wedge::ir::{
    ConstExpr, ConstInstruction, EntityOrigin, Global, GlobalType, Operation, OperationKind,
    Program, SourceInfo, ValueType,
};
use wedge::opcode::{CoreOpcode, CoreProposal};

fn program_with_initializer(operation: Operation) -> Program {
    let mut program = Program::new(1);
    program.globals.push(Global {
        ty: GlobalType {
            value: ValueType::I32,
            mutable: false,
        },
        origin: EntityOrigin::Defined,
        initializer: Some(ConstExpr {
            instructions: vec![ConstInstruction {
                operation,
                source: SourceInfo::synthetic(),
            }],
            result_type: ValueType::I32,
            source: SourceInfo::synthetic(),
        }),
        source: SourceInfo::synthetic(),
    });
    program
}

fn verification_error(operation: Operation) -> String {
    program_with_initializer(operation)
        .verify()
        .expect_err("malformed operation identity should be rejected")
        .to_string()
}

#[test]
fn owns_parser_operator_identity_without_its_immediates() {
    let operator = Operator::I32Const { value: 42 };
    assert_eq!(
        CoreOpcode::from_operator(&operator),
        Some(CoreOpcode::I32Const)
    );
}

#[test]
fn exposes_complete_pinned_inventory_arity_metadata() {
    let mut fixed_arities = BTreeMap::<(usize, usize), usize>::new();
    let mut custom_arities = 0;
    for &opcode in CoreOpcode::ALL {
        match opcode.fixed_arity() {
            Some(arity) => *fixed_arities.entry(arity).or_default() += 1,
            None => custom_arities += 1,
        }
    }

    assert_eq!(CoreOpcode::ALL.len(), 627);
    assert_eq!(custom_arities, 37);
    assert_eq!(
        fixed_arities,
        BTreeMap::from([
            ((0, 0), 6),
            ((0, 1), 13),
            ((1, 0), 5),
            ((1, 1), 204),
            ((2, 0), 26),
            ((2, 1), 290),
            ((2, 2), 2),
            ((3, 0), 8),
            ((3, 1), 29),
            ((4, 0), 3),
            ((4, 1), 1),
            ((4, 2), 2),
            ((5, 0), 1),
        ])
    );
}

#[test]
fn distinguishes_fixed_and_context_dependent_arities() {
    let fixed = [
        (CoreOpcode::Nop, (0, 0)),
        (CoreOpcode::I32Add, (2, 1)),
        (CoreOpcode::Select, (3, 1)),
        (CoreOpcode::MemoryInit, (3, 0)),
        (CoreOpcode::ArrayCopy, (5, 0)),
        (CoreOpcode::I64Add128, (4, 2)),
    ];
    for (opcode, arity) in fixed {
        assert_eq!(opcode.fixed_arity(), Some(arity), "{opcode:?}");
    }

    for opcode in [
        CoreOpcode::Block,
        CoreOpcode::Call,
        CoreOpcode::StructNew,
        CoreOpcode::TryTable,
        CoreOpcode::TypedSelectMulti,
    ] {
        assert_eq!(opcode.fixed_arity(), None, "{opcode:?}");
    }
}

#[test]
fn exposes_ordered_parser_immediate_fields() {
    assert!(CoreOpcode::I32Add.immediate_fields().is_empty());
    assert_eq!(CoreOpcode::Call.immediate_fields(), ["function_index"]);
    assert_eq!(
        CoreOpcode::CallIndirect.immediate_fields(),
        ["type_index", "table_index"]
    );
    assert_eq!(CoreOpcode::I32Load.immediate_fields(), ["memarg"]);
    assert_eq!(
        CoreOpcode::ArrayNewData.immediate_fields(),
        ["array_type_index", "array_data_index"]
    );
    assert_eq!(
        CoreOpcode::BrOnCast.immediate_fields(),
        ["relative_depth", "from_ref_type", "to_ref_type"]
    );
}

#[test]
fn recognizes_every_owned_opcode_mnemonic() {
    for &opcode in CoreOpcode::ALL {
        let mnemonic = opcode.mnemonic();
        let representative = CoreOpcode::from_mnemonic(&mnemonic)
            .unwrap_or_else(|| panic!("did not recognize {mnemonic}"));
        assert_eq!(representative.mnemonic(), mnemonic);
    }
}

#[test]
fn records_exactly_the_intentional_standard_text_mnemonic_collisions() {
    let mut by_mnemonic = BTreeMap::<String, Vec<CoreOpcode>>::new();
    for &opcode in CoreOpcode::ALL {
        if opcode.is_standard_wasm3() {
            by_mnemonic
                .entry(opcode.mnemonic().to_owned())
                .or_default()
                .push(opcode);
        }
    }
    let collisions: Vec<_> = by_mnemonic
        .into_iter()
        .filter(|(_, opcodes)| opcodes.len() > 1)
        .collect();

    assert_eq!(
        collisions,
        vec![
            (
                "ref.cast".to_owned(),
                vec![CoreOpcode::RefCastNonNull, CoreOpcode::RefCastNullable],
            ),
            (
                "ref.test".to_owned(),
                vec![CoreOpcode::RefTestNonNull, CoreOpcode::RefTestNullable],
            ),
            (
                "select".to_owned(),
                vec![CoreOpcode::Select, CoreOpcode::TypedSelect],
            ),
        ]
    );
}

#[test]
fn resolves_shared_text_mnemonics_to_the_first_parser_variant() {
    assert_eq!(
        CoreOpcode::from_mnemonic("select"),
        Some(CoreOpcode::Select)
    );
    assert_eq!(
        CoreOpcode::from_mnemonic("ref.test"),
        Some(CoreOpcode::RefTestNonNull)
    );
    assert_eq!(
        CoreOpcode::from_mnemonic("ref.cast"),
        Some(CoreOpcode::RefCastNonNull)
    );
}

#[test]
fn rejects_noncanonical_mnemonic_spellings() {
    assert_eq!(CoreOpcode::from_mnemonic("I32.ADD"), None);
    assert_eq!(CoreOpcode::from_mnemonic(" i32.add"), None);
    assert_eq!(CoreOpcode::from_mnemonic("i32.add "), None);
    assert_eq!(CoreOpcode::from_mnemonic("wedge.identity"), None);
}

#[test]
fn identifies_the_complete_standard_constant_expression_subset() {
    for opcode in [
        CoreOpcode::I32Const,
        CoreOpcode::I64Const,
        CoreOpcode::F32Const,
        CoreOpcode::F64Const,
        CoreOpcode::V128Const,
        CoreOpcode::RefNull,
        CoreOpcode::RefFunc,
        CoreOpcode::GlobalGet,
        CoreOpcode::I32Add,
        CoreOpcode::I32Sub,
        CoreOpcode::I32Mul,
        CoreOpcode::I64Add,
        CoreOpcode::I64Sub,
        CoreOpcode::I64Mul,
        CoreOpcode::StructNew,
        CoreOpcode::StructNewDefault,
        CoreOpcode::ArrayNew,
        CoreOpcode::ArrayNewDefault,
        CoreOpcode::ArrayNewFixed,
        CoreOpcode::RefI31,
        CoreOpcode::ExternConvertAny,
        CoreOpcode::AnyConvertExtern,
    ] {
        assert!(opcode.is_const_expression(), "{opcode} should be constant");
    }

    for opcode in [
        CoreOpcode::I32Clz,
        CoreOpcode::I32DivS,
        CoreOpcode::RefIsNull,
        CoreOpcode::StructGet,
        CoreOpcode::Call,
    ] {
        assert!(
            !opcode.is_const_expression(),
            "{opcode} must not be accepted in a constant expression"
        );
    }
}

#[test]
fn classifies_compatible_operation_construction() {
    assert_eq!(
        Operation::new(
            "i32.add",
            vec![ValueType::I32, ValueType::I32],
            vec![ValueType::I32]
        )
        .kind,
        OperationKind::Core(CoreOpcode::I32Add)
    );
    assert_eq!(
        Operation::new("wedge.identity", vec![ValueType::I32], vec![ValueType::I32]).kind,
        OperationKind::Synthetic
    );

    let operation = Operation::core(CoreOpcode::I64Const, vec![], vec![ValueType::I64]);
    assert_eq!(operation.kind, OperationKind::Core(CoreOpcode::I64Const));
    assert_eq!(operation.mnemonic, "i64.const");
}

#[test]
fn verifier_rejects_a_core_identity_mnemonic_disagreement() {
    let mut operation = Operation::core(CoreOpcode::I32Const, vec![], vec![ValueType::I32]);
    operation.mnemonic = "i64.const".into();

    let error = verification_error(operation);
    assert!(
        error.contains("identifies core opcode i32.const, but uses mnemonic i64.const"),
        "{error}"
    );
}

#[test]
fn verifier_rejects_a_synthetic_operation_using_a_core_mnemonic() {
    let operation = Operation::synthetic("i32.const", vec![], vec![ValueType::I32]);
    let error = verification_error(operation);
    assert!(
        error.contains("uses core mnemonic i32.const with synthetic operation identity"),
        "{error}"
    );
}

#[test]
fn verifier_rejects_out_of_profile_core_operations() {
    let operation = Operation::core(CoreOpcode::I32AtomicLoad, vec![], vec![ValueType::I32]);
    let error = verification_error(operation);
    assert!(
        error.contains("uses out-of-profile core opcode i32.atomic_load (Threads)"),
        "{error}"
    );
}

#[test]
fn renders_canonical_scalar_and_control_mnemonics() {
    let cases = [
        (CoreOpcode::LocalGet, "local.get"),
        (CoreOpcode::I32TruncSatF64U, "i32.trunc_sat_f64_u"),
        (CoreOpcode::CallIndirect, "call_indirect"),
        (CoreOpcode::BrOnCast, "br_on_cast"),
        (CoreOpcode::MemoryCopy, "memory.copy"),
        (CoreOpcode::StructGetS, "struct.get_s"),
    ];
    for (opcode, expected) in cases {
        assert_eq!(opcode.mnemonic(), expected);
        assert_eq!(opcode.to_string(), expected);
    }
}

#[test]
fn renders_simd_and_relaxed_simd_mnemonics() {
    assert_eq!(CoreOpcode::V128Load8Lane.mnemonic(), "v128.load8_lane");
    assert_eq!(CoreOpcode::I8x16Shuffle.mnemonic(), "i8x16.shuffle");
    assert_eq!(
        CoreOpcode::I8x16RelaxedSwizzle.mnemonic(),
        "i8x16.relaxed_swizzle"
    );
}

#[test]
fn renders_every_nonmechanical_standard_text_mnemonic() {
    let cases = [
        (CoreOpcode::RefTestNonNull, "ref.test"),
        (CoreOpcode::RefTestNullable, "ref.test"),
        (CoreOpcode::RefCastNonNull, "ref.cast"),
        (CoreOpcode::RefCastNullable, "ref.cast"),
        (CoreOpcode::TypedSelect, "select"),
        (CoreOpcode::TypedSelectMulti, "select"),
        (CoreOpcode::V128AndNot, "v128.andnot"),
        (
            CoreOpcode::I16x8ExtAddPairwiseI8x16S,
            "i16x8.extadd_pairwise_i8x16_s",
        ),
        (
            CoreOpcode::I16x8ExtAddPairwiseI8x16U,
            "i16x8.extadd_pairwise_i8x16_u",
        ),
        (CoreOpcode::I16x8Q15MulrSatS, "i16x8.q15mulr_sat_s"),
        (CoreOpcode::I16x8ExtMulLowI8x16S, "i16x8.extmul_low_i8x16_s"),
        (
            CoreOpcode::I16x8ExtMulHighI8x16S,
            "i16x8.extmul_high_i8x16_s",
        ),
        (CoreOpcode::I16x8ExtMulLowI8x16U, "i16x8.extmul_low_i8x16_u"),
        (
            CoreOpcode::I16x8ExtMulHighI8x16U,
            "i16x8.extmul_high_i8x16_u",
        ),
        (
            CoreOpcode::I32x4ExtAddPairwiseI16x8S,
            "i32x4.extadd_pairwise_i16x8_s",
        ),
        (
            CoreOpcode::I32x4ExtAddPairwiseI16x8U,
            "i32x4.extadd_pairwise_i16x8_u",
        ),
        (CoreOpcode::I32x4ExtMulLowI16x8S, "i32x4.extmul_low_i16x8_s"),
        (
            CoreOpcode::I32x4ExtMulHighI16x8S,
            "i32x4.extmul_high_i16x8_s",
        ),
        (CoreOpcode::I32x4ExtMulLowI16x8U, "i32x4.extmul_low_i16x8_u"),
        (
            CoreOpcode::I32x4ExtMulHighI16x8U,
            "i32x4.extmul_high_i16x8_u",
        ),
        (CoreOpcode::I64x2ExtMulLowI32x4S, "i64x2.extmul_low_i32x4_s"),
        (
            CoreOpcode::I64x2ExtMulHighI32x4S,
            "i64x2.extmul_high_i32x4_s",
        ),
        (CoreOpcode::I64x2ExtMulLowI32x4U, "i64x2.extmul_low_i32x4_u"),
        (
            CoreOpcode::I64x2ExtMulHighI32x4U,
            "i64x2.extmul_high_i32x4_u",
        ),
        (CoreOpcode::F32x4PMin, "f32x4.pmin"),
        (CoreOpcode::F32x4PMax, "f32x4.pmax"),
        (CoreOpcode::F64x2PMin, "f64x2.pmin"),
        (CoreOpcode::F64x2PMax, "f64x2.pmax"),
    ];

    for (opcode, expected) in cases {
        assert_eq!(opcode.mnemonic(), expected, "{opcode:?}");
    }
}

#[test]
fn classifies_standard_wasm3_operator_families() {
    for opcode in [
        CoreOpcode::I32Add,
        CoreOpcode::I32Extend8S,
        CoreOpcode::StructNew,
        CoreOpcode::I32TruncSatF32S,
        CoreOpcode::MemoryInit,
        CoreOpcode::RefNull,
        CoreOpcode::ReturnCall,
        CoreOpcode::I32x4Add,
        CoreOpcode::F32x4RelaxedMadd,
        CoreOpcode::TryTable,
        CoreOpcode::CallRef,
    ] {
        assert!(
            opcode.is_standard_wasm3(),
            "{opcode:?} should be in the Core Wasm 3 profile"
        );
    }
}

#[test]
fn excludes_multi_result_select_from_the_standard_profile() {
    assert!(CoreOpcode::TypedSelectMulti.proposal().is_standard_wasm3());
    assert!(!CoreOpcode::TypedSelectMulti.is_standard_wasm3());
    assert_eq!(CoreOpcode::TypedSelectMulti.mnemonic(), "select");
}

#[test]
fn identifies_out_of_scope_parser_extensions() {
    let cases = [
        (CoreOpcode::I32AtomicLoad, CoreProposal::Threads),
        (CoreOpcode::Try, CoreProposal::LegacyExceptions),
        (CoreOpcode::ContNew, CoreProposal::StackSwitching),
        (CoreOpcode::I64Add128, CoreProposal::WideArithmetic),
        (CoreOpcode::MemoryDiscard, CoreProposal::MemoryControl),
        (CoreOpcode::StructNewDesc, CoreProposal::CustomDescriptors),
    ];
    for (opcode, proposal) in cases {
        assert_eq!(opcode.proposal(), proposal);
        assert!(!opcode.is_standard_wasm3());
    }
}

#[test]
fn the_inventory_is_indexed_by_discriminant_and_names_every_opcode() {
    // `mnemonic()` looks its table up by discriminant, which is only sound
    // while `ALL` lists the variants in declaration order.
    for (index, &opcode) in CoreOpcode::ALL.iter().enumerate() {
        assert_eq!(opcode as usize, index, "{}", opcode.parser_name());
        assert_eq!(opcode.to_string(), opcode.mnemonic());
        assert!(!opcode.mnemonic().is_empty(), "{}", opcode.parser_name());
    }
}
