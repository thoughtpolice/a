// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Forged-IR tests for module-contextual Core operation schemas.

mod core_operation_test_support;

use core_operation_test_support::{
    ARRAY_TYPE, CALLEE_TYPE, EMPTY_FUNCTION_TYPE, PACKED_ARRAY_TYPE, REF_ARRAY_TYPE, STRUCT_TYPE,
    assert_schema_error, assert_valid_operation, memory_argument, operation_program, reference,
    source,
};
use wedge::ir::*;
use wedge::opcode::CoreOpcode;

fn operation(opcode: CoreOpcode, params: &[ValueType], results: &[ValueType]) -> Operation {
    Operation::core(opcode, params.to_vec(), results.to_vec())
}

fn concrete(nullable: bool, ty: TypeId) -> ValueType {
    reference(nullable, HeapType::Concrete(ty))
}

fn assert_program_valid(program: Program, subject: &str) {
    program
        .verify()
        .unwrap_or_else(|error| panic!("valid {subject} was rejected:\n{error}"));
}

fn assert_program_schema_error(program: Program, fragments: &[&str]) {
    let errors = program
        .verify()
        .expect_err("forged contextual Core operation should fail verification");
    let operation_location = VerifyLocation {
        function: Some(FunctionId(1)),
        block: Some(BlockId(0)),
        instruction: Some(InstructionId(0)),
    };
    assert!(
        errors
            .0
            .iter()
            .all(|error| error.location == operation_location),
        "test scaffold produced a diagnostic outside the forged operation:\n{errors}"
    );
    assert!(
        errors.0.iter().any(|error| {
            error.message.contains("invalid Core schema")
                && fragments
                    .iter()
                    .all(|fragment| error.message.contains(fragment))
        }),
        "expected a Core-schema diagnostic containing {fragments:?}:\n{errors}"
    );
}

#[test]
fn direct_calls_use_the_referenced_function_signature_and_accept_subtypes() {
    let struct_ref = concrete(false, STRUCT_TYPE);
    assert_valid_operation(
        operation(CoreOpcode::Call, &[struct_ref], &[ValueType::I32])
            .with_immediates(vec![Immediate::Function(FunctionId(0))]),
    );

    assert_schema_error(
        operation(CoreOpcode::Call, &[ValueType::I64], &[ValueType::I32])
            .with_immediates(vec![Immediate::Function(FunctionId(0))]),
        &["call", "parameter 0", "expected a subtype", "any"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::Call,
            &[reference(true, HeapType::Any)],
            &[ValueType::F32],
        )
        .with_immediates(vec![Immediate::Function(FunctionId(0))]),
        &["call", "result 0", "expected i32"],
    );
}

#[test]
fn indirect_calls_append_the_selected_tables_address_type() {
    assert_valid_operation(
        operation(
            CoreOpcode::CallIndirect,
            &[concrete(false, STRUCT_TYPE), ValueType::I32],
            &[ValueType::I32],
        )
        .with_immediates(vec![
            Immediate::Type(CALLEE_TYPE),
            Immediate::Table(TableId(0)),
        ]),
    );

    assert_schema_error(
        operation(
            CoreOpcode::CallIndirect,
            &[reference(true, HeapType::Any), ValueType::I64],
            &[ValueType::I32],
        )
        .with_immediates(vec![
            Immediate::Type(CALLEE_TYPE),
            Immediate::Table(TableId(0)),
        ]),
        &["call_indirect", "parameter 1", "expected a subtype of i32"],
    );
}

#[test]
fn indirect_calls_require_a_function_type_and_funcref_table() {
    assert_schema_error(
        operation(CoreOpcode::CallIndirect, &[ValueType::I32], &[]).with_immediates(vec![
            Immediate::Type(STRUCT_TYPE),
            Immediate::Table(TableId(0)),
        ]),
        &["call_indirect", "requires type0 to be a function type"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::CallIndirect,
            &[reference(true, HeapType::Any), ValueType::I64],
            &[ValueType::I32],
        )
        .with_immediates(vec![
            Immediate::Type(CALLEE_TYPE),
            Immediate::Table(TableId(1)),
        ]),
        &["call_indirect", "not a subtype of funcref"],
    );
}

#[test]
fn call_ref_accepts_a_nominal_subtype_of_the_immediate_function_type() {
    let subtype_ref = concrete(false, EMPTY_FUNCTION_TYPE);
    let call = operation(
        CoreOpcode::CallRef,
        &[concrete(false, STRUCT_TYPE), subtype_ref],
        &[ValueType::I32],
    )
    .with_immediates(vec![Immediate::Type(CALLEE_TYPE)]);
    let mut program = operation_program(call);
    program.types[CALLEE_TYPE.index()].final_ = false;
    program.types[EMPTY_FUNCTION_TYPE.index()] = TypeDefinition {
        canonical_alias: None,
        final_: true,
        supertype: Some(CALLEE_TYPE),
        composite: CompositeType::Function(FunctionType {
            params: vec![reference(true, HeapType::Any)],
            results: vec![ValueType::I32],
        }),
        source: source(),
    };
    assert_program_valid(program, "call_ref with a nominal callee subtype");
}

#[test]
fn call_ref_rejects_a_reference_from_an_unrelated_hierarchy() {
    assert_schema_error(
        operation(
            CoreOpcode::CallRef,
            &[
                reference(true, HeapType::Any),
                reference(true, HeapType::Extern),
            ],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(CALLEE_TYPE)]),
        &["call_ref", "parameter 1", "expected a subtype", "type4"],
    );
}

#[test]
fn global_get_and_set_derive_the_global_value_type() {
    assert_valid_operation(
        operation(CoreOpcode::GlobalGet, &[], &[ValueType::I32])
            .with_immediates(vec![Immediate::Global(GlobalId(0))]),
    );
    assert_valid_operation(
        operation(
            CoreOpcode::GlobalSet,
            &[reference(false, HeapType::NoExtern)],
            &[],
        )
        .with_immediates(vec![Immediate::Global(GlobalId(1))]),
    );

    assert_schema_error(
        operation(CoreOpcode::GlobalGet, &[], &[ValueType::I64])
            .with_immediates(vec![Immediate::Global(GlobalId(0))]),
        &["global.get", "result 0", "expected i32"],
    );
}

#[test]
fn global_set_requires_mutability_and_a_value_subtype() {
    assert_schema_error(
        operation(CoreOpcode::GlobalSet, &[ValueType::I32], &[])
            .with_immediates(vec![Immediate::Global(GlobalId(0))]),
        &["global.set", "immutable global"],
    );
    assert_schema_error(
        operation(CoreOpcode::GlobalSet, &[ValueType::I32], &[])
            .with_immediates(vec![Immediate::Global(GlobalId(1))]),
        &["global.set", "parameter 0", "expected a subtype", "extern"],
    );
}

#[test]
fn scalar_memory_natural_alignment_limits_are_exhaustive() {
    let cases = [
        (CoreOpcode::I32Load, ValueType::I32, 2, false),
        (CoreOpcode::I64Load, ValueType::I64, 3, false),
        (CoreOpcode::F32Load, ValueType::F32, 2, false),
        (CoreOpcode::F64Load, ValueType::F64, 3, false),
        (CoreOpcode::I32Load8S, ValueType::I32, 0, false),
        (CoreOpcode::I32Load8U, ValueType::I32, 0, false),
        (CoreOpcode::I32Load16S, ValueType::I32, 1, false),
        (CoreOpcode::I32Load16U, ValueType::I32, 1, false),
        (CoreOpcode::I64Load8S, ValueType::I64, 0, false),
        (CoreOpcode::I64Load8U, ValueType::I64, 0, false),
        (CoreOpcode::I64Load16S, ValueType::I64, 1, false),
        (CoreOpcode::I64Load16U, ValueType::I64, 1, false),
        (CoreOpcode::I64Load32S, ValueType::I64, 2, false),
        (CoreOpcode::I64Load32U, ValueType::I64, 2, false),
        (CoreOpcode::I32Store, ValueType::I32, 2, true),
        (CoreOpcode::I64Store, ValueType::I64, 3, true),
        (CoreOpcode::F32Store, ValueType::F32, 2, true),
        (CoreOpcode::F64Store, ValueType::F64, 3, true),
        (CoreOpcode::I32Store8, ValueType::I32, 0, true),
        (CoreOpcode::I32Store16, ValueType::I32, 1, true),
        (CoreOpcode::I64Store8, ValueType::I64, 0, true),
        (CoreOpcode::I64Store16, ValueType::I64, 1, true),
        (CoreOpcode::I64Store32, ValueType::I64, 2, true),
    ];

    for (opcode, value, natural, store) in cases {
        let (params, results) = if store {
            (vec![ValueType::I32, value], vec![])
        } else {
            (vec![ValueType::I32], vec![value])
        };
        assert_valid_operation(
            operation(opcode, &params, &results).with_immediates(vec![memory_argument(
                MemoryId(0),
                0,
                natural,
            )]),
        );
        assert_schema_error(
            operation(opcode, &params, &results).with_immediates(vec![memory_argument(
                MemoryId(0),
                0,
                natural + 1,
            )]),
            &["alignment", "exceeds natural alignment"],
        );
    }
}

#[test]
fn non_lane_simd_memory_alignment_limits_are_exhaustive() {
    let cases = [
        (CoreOpcode::V128Load, 4, false),
        (CoreOpcode::V128Load8x8S, 3, false),
        (CoreOpcode::V128Load8x8U, 3, false),
        (CoreOpcode::V128Load16x4S, 3, false),
        (CoreOpcode::V128Load16x4U, 3, false),
        (CoreOpcode::V128Load32x2S, 3, false),
        (CoreOpcode::V128Load32x2U, 3, false),
        (CoreOpcode::V128Load8Splat, 0, false),
        (CoreOpcode::V128Load16Splat, 1, false),
        (CoreOpcode::V128Load32Splat, 2, false),
        (CoreOpcode::V128Load64Splat, 3, false),
        (CoreOpcode::V128Load32Zero, 2, false),
        (CoreOpcode::V128Load64Zero, 3, false),
        (CoreOpcode::V128Store, 4, true),
    ];

    for (opcode, natural, store) in cases {
        let (params, results) = if store {
            (vec![ValueType::I32, ValueType::V128], vec![])
        } else {
            (vec![ValueType::I32], vec![ValueType::V128])
        };
        assert_valid_operation(
            operation(opcode, &params, &results).with_immediates(vec![memory_argument(
                MemoryId(0),
                0,
                natural,
            )]),
        );
        assert_schema_error(
            operation(opcode, &params, &results).with_immediates(vec![memory_argument(
                MemoryId(0),
                0,
                natural + 1,
            )]),
            &["alignment", "exceeds natural alignment"],
        );
    }
}

#[test]
fn every_simd_lane_memory_operation_checks_its_lane_bound() {
    let cases = [
        (CoreOpcode::V128Load8Lane, 0, 16, true),
        (CoreOpcode::V128Load16Lane, 1, 8, true),
        (CoreOpcode::V128Load32Lane, 2, 4, true),
        (CoreOpcode::V128Load64Lane, 3, 2, true),
        (CoreOpcode::V128Store8Lane, 0, 16, false),
        (CoreOpcode::V128Store16Lane, 1, 8, false),
        (CoreOpcode::V128Store32Lane, 2, 4, false),
        (CoreOpcode::V128Store64Lane, 3, 2, false),
    ];

    for (opcode, natural, lanes, load) in cases {
        let results = if load { vec![ValueType::V128] } else { vec![] };
        let valid = operation(opcode, &[ValueType::I32, ValueType::V128], &results)
            .with_immediates(vec![
                memory_argument(MemoryId(0), 0, natural),
                Immediate::Lane(lanes - 1),
            ]);
        assert_valid_operation(valid);

        let invalid = operation(opcode, &[ValueType::I32, ValueType::V128], &results)
            .with_immediates(vec![
                memory_argument(MemoryId(0), 0, natural),
                Immediate::Lane(lanes),
            ]);
        assert_schema_error(
            invalid,
            &["lane", "out of range", &format!("{lanes} lanes")],
        );
    }
}

#[test]
fn every_simd_lane_memory_operation_checks_natural_alignment() {
    let cases = [
        (CoreOpcode::V128Load8Lane, 0, true),
        (CoreOpcode::V128Load16Lane, 1, true),
        (CoreOpcode::V128Load32Lane, 2, true),
        (CoreOpcode::V128Load64Lane, 3, true),
        (CoreOpcode::V128Store8Lane, 0, false),
        (CoreOpcode::V128Store16Lane, 1, false),
        (CoreOpcode::V128Store32Lane, 2, false),
        (CoreOpcode::V128Store64Lane, 3, false),
    ];

    for (opcode, natural, load) in cases {
        let results = if load { vec![ValueType::V128] } else { vec![] };
        assert_schema_error(
            operation(opcode, &[ValueType::I32, ValueType::V128], &results).with_immediates(vec![
                memory_argument(MemoryId(0), 0, natural + 1),
                Immediate::Lane(0),
            ]),
            &["alignment", "exceeds natural alignment"],
        );
    }
}

#[test]
fn memory_arguments_derive_address_width_and_constrain_memory32_offsets() {
    assert_valid_operation(
        operation(CoreOpcode::I32Load, &[ValueType::I64], &[ValueType::I32])
            .with_immediates(vec![memory_argument(MemoryId(1), u64::MAX, 2)]),
    );
    assert_schema_error(
        operation(CoreOpcode::I32Load, &[ValueType::I32], &[ValueType::I32]).with_immediates(vec![
            memory_argument(MemoryId(0), u64::from(u32::MAX) + 1, 2),
        ]),
        &["offset", "does not fit", "32-bit memory"],
    );
    assert_schema_error(
        operation(CoreOpcode::I32Load, &[ValueType::I32], &[ValueType::I32])
            .with_immediates(vec![memory_argument(MemoryId(1), 0, 2)]),
        &["parameter 0", "expected a subtype of i64"],
    );
}

#[test]
fn memory_size_and_grow_follow_the_referenced_memory_width() {
    for (memory, address) in [(MemoryId(0), ValueType::I32), (MemoryId(1), ValueType::I64)] {
        assert_valid_operation(
            operation(CoreOpcode::MemorySize, &[], std::slice::from_ref(&address))
                .with_immediates(vec![Immediate::Memory(memory)]),
        );
        assert_valid_operation(
            operation(
                CoreOpcode::MemoryGrow,
                std::slice::from_ref(&address),
                std::slice::from_ref(&address),
            )
            .with_immediates(vec![Immediate::Memory(memory)]),
        );
    }
}

#[test]
fn memory_init_and_fill_keep_i32_byte_values_but_use_the_memory_address_width() {
    assert_valid_operation(
        operation(
            CoreOpcode::MemoryInit,
            &[ValueType::I64, ValueType::I32, ValueType::I32],
            &[],
        )
        .with_immediates(vec![
            Immediate::Data(DataId(0)),
            Immediate::Memory(MemoryId(1)),
        ]),
    );
    assert_valid_operation(
        operation(
            CoreOpcode::MemoryFill,
            &[ValueType::I64, ValueType::I32, ValueType::I64],
            &[],
        )
        .with_immediates(vec![Immediate::Memory(MemoryId(1))]),
    );
    assert_schema_error(
        operation(
            CoreOpcode::MemoryInit,
            &[ValueType::I64, ValueType::I64, ValueType::I32],
            &[],
        )
        .with_immediates(vec![
            Immediate::Data(DataId(0)),
            Immediate::Memory(MemoryId(1)),
        ]),
        &["memory.init", "parameter 1", "expected a subtype of i32"],
    );
}

#[test]
fn memory_copy_uses_each_memory_width_and_the_smaller_width_for_length() {
    for (destination, source, params) in [
        (
            MemoryId(0),
            MemoryId(1),
            vec![ValueType::I32, ValueType::I64, ValueType::I32],
        ),
        (
            MemoryId(1),
            MemoryId(0),
            vec![ValueType::I64, ValueType::I32, ValueType::I32],
        ),
        (
            MemoryId(1),
            MemoryId(1),
            vec![ValueType::I64, ValueType::I64, ValueType::I64],
        ),
    ] {
        assert_valid_operation(
            operation(CoreOpcode::MemoryCopy, &params, &[]).with_immediates(vec![
                Immediate::Memory(destination),
                Immediate::Memory(source),
            ]),
        );
    }

    assert_schema_error(
        operation(
            CoreOpcode::MemoryCopy,
            &[ValueType::I64, ValueType::I64, ValueType::I32],
            &[],
        )
        .with_immediates(vec![
            Immediate::Memory(MemoryId(1)),
            Immediate::Memory(MemoryId(1)),
        ]),
        &["memory.copy", "parameter 2", "expected a subtype of i64"],
    );
}

#[test]
fn data_drop_checks_its_segment_and_has_an_empty_signature() {
    assert_valid_operation(
        operation(CoreOpcode::DataDrop, &[], &[]).with_immediates(vec![Immediate::Data(DataId(0))]),
    );
    assert_schema_error(
        operation(CoreOpcode::DataDrop, &[], &[]).with_immediates(vec![Immediate::Data(DataId(7))]),
        &["data.drop", "missing data7"],
    );
}

#[test]
fn table_operations_follow_table32_and_table64_types() {
    let externref = reference(true, HeapType::Extern);
    let cases = [
        operation(
            CoreOpcode::TableGet,
            &[ValueType::I32],
            &[reference(true, HeapType::Func)],
        )
        .with_immediates(vec![Immediate::Table(TableId(0))]),
        operation(
            CoreOpcode::TableSet,
            &[ValueType::I64, externref.clone()],
            &[],
        )
        .with_immediates(vec![Immediate::Table(TableId(1))]),
        operation(
            CoreOpcode::TableGrow,
            &[externref.clone(), ValueType::I64],
            &[ValueType::I64],
        )
        .with_immediates(vec![Immediate::Table(TableId(1))]),
        operation(CoreOpcode::TableSize, &[], &[ValueType::I64])
            .with_immediates(vec![Immediate::Table(TableId(1))]),
        operation(
            CoreOpcode::TableFill,
            &[ValueType::I64, externref, ValueType::I64],
            &[],
        )
        .with_immediates(vec![Immediate::Table(TableId(1))]),
    ];
    for operation in cases {
        assert_valid_operation(operation);
    }

    assert_schema_error(
        operation(
            CoreOpcode::TableGet,
            &[ValueType::I32],
            &[reference(true, HeapType::Extern)],
        )
        .with_immediates(vec![Immediate::Table(TableId(1))]),
        &["table.get", "parameter 0", "expected a subtype of i64"],
    );
}

#[test]
fn table_init_requires_segment_covariance_and_uses_i32_source_coordinates() {
    assert_valid_operation(
        operation(
            CoreOpcode::TableInit,
            &[ValueType::I32, ValueType::I32, ValueType::I32],
            &[],
        )
        .with_immediates(vec![
            Immediate::Element(ElementId(0)),
            Immediate::Table(TableId(0)),
        ]),
    );
    assert_schema_error(
        operation(
            CoreOpcode::TableInit,
            &[ValueType::I32, ValueType::I32, ValueType::I32],
            &[],
        )
        .with_immediates(vec![
            Immediate::Element(ElementId(1)),
            Immediate::Table(TableId(0)),
        ]),
        &["table.init", "element segment type", "not a subtype"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::TableInit,
            &[ValueType::I64, ValueType::I64, ValueType::I32],
            &[],
        )
        .with_immediates(vec![
            Immediate::Element(ElementId(1)),
            Immediate::Table(TableId(1)),
        ]),
        &["table.init", "parameter 1", "expected a subtype of i32"],
    );
}

#[test]
fn table_init_accepts_a_narrower_nominal_segment_type() {
    let table_init = operation(
        CoreOpcode::TableInit,
        &[ValueType::I64, ValueType::I32, ValueType::I32],
        &[],
    )
    .with_immediates(vec![
        Immediate::Element(ElementId(1)),
        Immediate::Table(TableId(1)),
    ]);
    let mut program = operation_program(table_init);
    program.tables[1].ty.element = RefType {
        nullable: true,
        heap: HeapType::Any,
    };
    program.elements[1].ty = RefType {
        nullable: false,
        heap: HeapType::Concrete(STRUCT_TYPE),
    };
    assert_program_valid(program, "covariant table.init");
}

#[test]
fn table_copy_checks_element_variance_and_mixed_address_widths() {
    let table_copy = operation(
        CoreOpcode::TableCopy,
        &[ValueType::I32, ValueType::I64, ValueType::I32],
        &[],
    )
    .with_immediates(vec![
        Immediate::Table(TableId(0)),
        Immediate::Table(TableId(1)),
    ]);
    let mut program = operation_program(table_copy);
    program.tables[0].ty.element = RefType {
        nullable: true,
        heap: HeapType::Any,
    };
    program.tables[1].ty.element = RefType {
        nullable: false,
        heap: HeapType::Concrete(STRUCT_TYPE),
    };
    assert_program_valid(program, "covariant mixed-width table.copy");

    assert_schema_error(
        operation(
            CoreOpcode::TableCopy,
            &[ValueType::I32, ValueType::I64, ValueType::I32],
            &[],
        )
        .with_immediates(vec![
            Immediate::Table(TableId(0)),
            Immediate::Table(TableId(1)),
        ]),
        &["table.copy", "source table element type", "not a subtype"],
    );
}

#[test]
fn elem_drop_checks_its_segment_and_has_an_empty_signature() {
    assert_valid_operation(
        operation(CoreOpcode::ElemDrop, &[], &[])
            .with_immediates(vec![Immediate::Element(ElementId(0))]),
    );
    assert_schema_error(
        operation(CoreOpcode::ElemDrop, &[], &[])
            .with_immediates(vec![Immediate::Element(ElementId(9))]),
        &["elem.drop", "missing elem9"],
    );
}

#[test]
fn untyped_and_typed_select_preserve_their_distinct_type_rules() {
    assert_valid_operation(operation(
        CoreOpcode::Select,
        &[ValueType::V128, ValueType::V128, ValueType::I32],
        &[ValueType::V128],
    ));
    assert_schema_error(
        operation(
            CoreOpcode::Select,
            &[
                reference(true, HeapType::Any),
                reference(true, HeapType::Any),
                ValueType::I32,
            ],
            &[reference(true, HeapType::Any)],
        ),
        &["select", "requires a numeric or vector"],
    );

    let anyref = reference(true, HeapType::Any);
    assert_valid_operation(
        operation(
            CoreOpcode::TypedSelect,
            &[
                concrete(false, STRUCT_TYPE),
                concrete(false, ARRAY_TYPE),
                ValueType::I32,
            ],
            std::slice::from_ref(&anyref),
        )
        .with_immediates(vec![Immediate::ValueType(anyref)]),
    );
}

#[test]
fn reference_nullity_operations_relate_input_and_result_types() {
    assert_valid_operation(
        operation(
            CoreOpcode::RefNull,
            &[],
            &[reference(true, HeapType::Struct)],
        )
        .with_immediates(vec![Immediate::HeapType(HeapType::Struct)]),
    );
    assert_valid_operation(operation(
        CoreOpcode::RefIsNull,
        &[reference(false, HeapType::Exn)],
        &[ValueType::I32],
    ));
    assert_valid_operation(operation(
        CoreOpcode::RefAsNonNull,
        &[concrete(true, STRUCT_TYPE)],
        &[concrete(false, STRUCT_TYPE)],
    ));

    assert_schema_error(
        operation(
            CoreOpcode::RefNull,
            &[],
            &[reference(false, HeapType::Struct)],
        )
        .with_immediates(vec![Immediate::HeapType(HeapType::Struct)]),
        &["ref.null", "result 0", "expected", "ref null struct"],
    );
    assert_schema_error(
        operation(CoreOpcode::RefIsNull, &[ValueType::I32], &[ValueType::I32]),
        &["ref.is_null", "operand must be a reference"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::RefAsNonNull,
            &[concrete(true, STRUCT_TYPE)],
            &[concrete(true, STRUCT_TYPE)],
        ),
        &[
            "ref.as_non_null",
            "result has type",
            "expected",
            "ref type0",
        ],
    );
}

#[test]
fn ref_eq_and_i31_operations_enforce_the_eq_hierarchy() {
    assert_valid_operation(operation(
        CoreOpcode::RefEq,
        &[concrete(true, STRUCT_TYPE), concrete(true, ARRAY_TYPE)],
        &[ValueType::I32],
    ));
    assert_valid_operation(operation(
        CoreOpcode::RefI31,
        &[ValueType::I32],
        &[reference(false, HeapType::I31)],
    ));
    assert_valid_operation(operation(
        CoreOpcode::I31GetU,
        &[reference(true, HeapType::I31)],
        &[ValueType::I32],
    ));

    assert_schema_error(
        operation(
            CoreOpcode::RefEq,
            &[
                reference(true, HeapType::Extern),
                reference(true, HeapType::Eq),
            ],
            &[ValueType::I32],
        ),
        &["ref.eq", "parameter 0", "expected a subtype", "eq"],
    );
}

#[test]
fn reference_conversions_preserve_operand_nullability() {
    for (opcode, input, output) in [
        (
            CoreOpcode::AnyConvertExtern,
            HeapType::Extern,
            HeapType::Any,
        ),
        (
            CoreOpcode::ExternConvertAny,
            HeapType::Any,
            HeapType::Extern,
        ),
    ] {
        assert_valid_operation(operation(
            opcode,
            &[reference(false, input.clone())],
            &[reference(false, output.clone())],
        ));
        assert_valid_operation(operation(
            opcode,
            &[reference(true, input.clone())],
            &[reference(true, output.clone())],
        ));
        assert_schema_error(
            operation(
                opcode,
                &[reference(false, input)],
                &[reference(true, output)],
            ),
            &["result has type", "expected"],
        );
    }
}

#[test]
fn reference_tests_and_casts_use_the_target_hierarchy_and_nullability() {
    assert_valid_operation(
        operation(
            CoreOpcode::RefTestNullable,
            &[concrete(true, ARRAY_TYPE)],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::HeapType(HeapType::Concrete(STRUCT_TYPE))]),
    );
    assert_valid_operation(
        operation(
            CoreOpcode::RefCastNonNull,
            &[concrete(true, ARRAY_TYPE)],
            &[concrete(false, STRUCT_TYPE)],
        )
        .with_immediates(vec![Immediate::HeapType(HeapType::Concrete(STRUCT_TYPE))]),
    );

    assert_schema_error(
        operation(
            CoreOpcode::RefTestNonNull,
            &[reference(true, HeapType::Extern)],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::HeapType(HeapType::Struct)]),
        &["ref.test", "parameter 0", "expected a subtype", "any"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::RefCastNullable,
            &[concrete(true, ARRAY_TYPE)],
            &[concrete(true, ARRAY_TYPE)],
        )
        .with_immediates(vec![Immediate::HeapType(HeapType::Concrete(STRUCT_TYPE))]),
        &["ref.cast", "result 0", "expected", "type0"],
    );
}

#[test]
fn ref_func_derives_a_non_null_concrete_function_reference() {
    assert_valid_operation(
        operation(CoreOpcode::RefFunc, &[], &[concrete(false, CALLEE_TYPE)])
            .with_immediates(vec![Immediate::Function(FunctionId(0))]),
    );
    assert_schema_error(
        operation(CoreOpcode::RefFunc, &[], &[reference(true, HeapType::Func)])
            .with_immediates(vec![Immediate::Function(FunctionId(0))]),
        &["ref.func", "result 0", "expected", "type4"],
    );
}

#[test]
fn ref_func_ir_verification_does_not_reapply_the_source_declaration_set() {
    let operation = operation(CoreOpcode::RefFunc, &[], &[concrete(false, CALLEE_TYPE)])
        .with_immediates(vec![Immediate::Function(FunctionId(0))]);
    let program = operation_program(operation);

    // The forged IR retains neither an export nor an element item that could
    // have declared this source-level function reference. Source validation is
    // wasmparser's job; the owned-IR contract is function identity and type.
    assert!(program.exports.is_empty());
    assert!(
        program
            .elements
            .iter()
            .all(|element| element.items.is_empty())
    );
    assert_program_valid(
        program,
        "ref.func without a retained source declaration set",
    );
}

#[test]
fn struct_construction_uses_every_field_and_checks_defaultability() {
    let result = concrete(false, STRUCT_TYPE);
    assert_valid_operation(
        operation(
            CoreOpcode::StructNew,
            &[ValueType::I32, ValueType::I32],
            std::slice::from_ref(&result),
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE)]),
    );
    assert_valid_operation(
        operation(
            CoreOpcode::StructNewDefault,
            &[],
            std::slice::from_ref(&result),
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE)]),
    );
    assert_schema_error(
        operation(
            CoreOpcode::StructNew,
            &[ValueType::I32],
            std::slice::from_ref(&result),
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE)]),
        &["struct.new", "expected 2 -> 1"],
    );

    let struct_default = operation(
        CoreOpcode::StructNewDefault,
        &[],
        std::slice::from_ref(&result),
    )
    .with_immediates(vec![Immediate::Type(STRUCT_TYPE)]);
    let mut program = operation_program(struct_default);
    let CompositeType::Struct(fields) = &mut program.types[STRUCT_TYPE.index()].composite else {
        unreachable!()
    };
    fields[0].storage = StorageType::Value(reference(false, HeapType::Extern));
    assert_program_schema_error(program, &["struct.new_default", "non-defaultable field"]);
}

#[test]
fn struct_operations_require_a_struct_type_and_valid_field_index() {
    assert_schema_error(
        operation(
            CoreOpcode::StructNew,
            &[ValueType::I32],
            &[concrete(false, ARRAY_TYPE)],
        )
        .with_immediates(vec![Immediate::Type(ARRAY_TYPE)]),
        &["struct.new", "requires type1 to be a struct type"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::StructGet,
            &[concrete(true, STRUCT_TYPE)],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE), Immediate::U32(9)]),
        &["struct.get", "field index 9", "out of range"],
    );
}

#[test]
fn struct_get_variants_distinguish_packed_and_unpacked_fields() {
    assert_valid_operation(
        operation(
            CoreOpcode::StructGet,
            &[concrete(true, STRUCT_TYPE)],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE), Immediate::U32(0)]),
    );
    for opcode in [CoreOpcode::StructGetS, CoreOpcode::StructGetU] {
        assert_valid_operation(
            operation(opcode, &[concrete(true, STRUCT_TYPE)], &[ValueType::I32])
                .with_immediates(vec![Immediate::Type(STRUCT_TYPE), Immediate::U32(1)]),
        );
    }

    assert_schema_error(
        operation(
            CoreOpcode::StructGet,
            &[concrete(true, STRUCT_TYPE)],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE), Immediate::U32(1)]),
        &["struct.get", "cannot read a packed field"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::StructGetS,
            &[concrete(true, STRUCT_TYPE)],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE), Immediate::U32(0)]),
        &["struct.get_s", "requires a packed field"],
    );
}

#[test]
fn struct_set_requires_a_mutable_field_and_its_storage_stack_type() {
    assert_valid_operation(
        operation(
            CoreOpcode::StructSet,
            &[concrete(true, STRUCT_TYPE), ValueType::I32],
            &[],
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE), Immediate::U32(1)]),
    );
    assert_schema_error(
        operation(
            CoreOpcode::StructSet,
            &[concrete(true, STRUCT_TYPE), ValueType::I32],
            &[],
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE), Immediate::U32(0)]),
        &["struct.set", "immutable field"],
    );
}

#[test]
fn array_constructors_derive_element_and_result_types() {
    let result = concrete(false, ARRAY_TYPE);
    let cases = [
        operation(
            CoreOpcode::ArrayNew,
            &[ValueType::I32, ValueType::I32],
            std::slice::from_ref(&result),
        )
        .with_immediates(vec![Immediate::Type(ARRAY_TYPE)]),
        operation(
            CoreOpcode::ArrayNewDefault,
            &[ValueType::I32],
            std::slice::from_ref(&result),
        )
        .with_immediates(vec![Immediate::Type(ARRAY_TYPE)]),
        operation(
            CoreOpcode::ArrayNewFixed,
            &[ValueType::I32, ValueType::I32],
            std::slice::from_ref(&result),
        )
        .with_immediates(vec![Immediate::Type(ARRAY_TYPE), Immediate::U32(2)]),
        operation(
            CoreOpcode::ArrayNewData,
            &[ValueType::I32, ValueType::I32],
            std::slice::from_ref(&result),
        )
        .with_immediates(vec![
            Immediate::Type(ARRAY_TYPE),
            Immediate::Data(DataId(0)),
        ]),
        operation(
            CoreOpcode::ArrayNewElem,
            &[ValueType::I32, ValueType::I32],
            &[concrete(false, REF_ARRAY_TYPE)],
        )
        .with_immediates(vec![
            Immediate::Type(REF_ARRAY_TYPE),
            Immediate::Element(ElementId(1)),
        ]),
    ];
    for operation in cases {
        assert_valid_operation(operation);
    }
}

#[test]
fn array_constructors_check_kind_fixed_length_and_defaultability() {
    assert_schema_error(
        operation(
            CoreOpcode::ArrayNew,
            &[ValueType::I32, ValueType::I32],
            &[concrete(false, STRUCT_TYPE)],
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE)]),
        &["array.new", "requires type0 to be an array type"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::ArrayNewFixed,
            &[ValueType::I32],
            &[concrete(false, ARRAY_TYPE)],
        )
        .with_immediates(vec![Immediate::Type(ARRAY_TYPE), Immediate::U32(2)]),
        &[
            "array.new_fixed",
            "1 parameters",
            "element-count immediate is 2",
        ],
    );

    let array_default = operation(
        CoreOpcode::ArrayNewDefault,
        &[ValueType::I32],
        &[concrete(false, REF_ARRAY_TYPE)],
    )
    .with_immediates(vec![Immediate::Type(REF_ARRAY_TYPE)]);
    let mut program = operation_program(array_default);
    let CompositeType::Array(field) = &mut program.types[REF_ARRAY_TYPE.index()].composite else {
        unreachable!()
    };
    field.storage = StorageType::Value(reference(false, HeapType::Extern));
    assert_program_schema_error(program, &["array.new_default", "non-defaultable element"]);
}

#[test]
fn array_data_and_element_constructors_check_storage_and_segment_types() {
    assert_schema_error(
        operation(
            CoreOpcode::ArrayNewData,
            &[ValueType::I32, ValueType::I32],
            &[concrete(false, REF_ARRAY_TYPE)],
        )
        .with_immediates(vec![
            Immediate::Type(REF_ARRAY_TYPE),
            Immediate::Data(DataId(0)),
        ]),
        &["array.new_data", "numeric or vector element type"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::ArrayNewElem,
            &[ValueType::I32, ValueType::I32],
            &[concrete(false, ARRAY_TYPE)],
        )
        .with_immediates(vec![
            Immediate::Type(ARRAY_TYPE),
            Immediate::Element(ElementId(0)),
        ]),
        &["array.new_elem", "reference element type"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::ArrayNewElem,
            &[ValueType::I32, ValueType::I32],
            &[concrete(false, REF_ARRAY_TYPE)],
        )
        .with_immediates(vec![
            Immediate::Type(REF_ARRAY_TYPE),
            Immediate::Element(ElementId(0)),
        ]),
        &["array.new_elem", "element segment type", "not a subtype"],
    );
}

#[test]
fn array_get_variants_distinguish_packed_and_unpacked_elements() {
    assert_valid_operation(
        operation(
            CoreOpcode::ArrayGet,
            &[concrete(true, ARRAY_TYPE), ValueType::I32],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(ARRAY_TYPE)]),
    );
    for opcode in [CoreOpcode::ArrayGetS, CoreOpcode::ArrayGetU] {
        assert_valid_operation(
            operation(
                opcode,
                &[concrete(true, PACKED_ARRAY_TYPE), ValueType::I32],
                &[ValueType::I32],
            )
            .with_immediates(vec![Immediate::Type(PACKED_ARRAY_TYPE)]),
        );
    }
    assert_schema_error(
        operation(
            CoreOpcode::ArrayGet,
            &[concrete(true, PACKED_ARRAY_TYPE), ValueType::I32],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(PACKED_ARRAY_TYPE)]),
        &["array.get", "cannot read a packed element"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::ArrayGetU,
            &[concrete(true, ARRAY_TYPE), ValueType::I32],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(ARRAY_TYPE)]),
        &["array.get_u", "requires packed elements"],
    );
}

#[test]
fn array_set_and_fill_require_mutable_elements() {
    let set = operation(
        CoreOpcode::ArraySet,
        &[concrete(true, ARRAY_TYPE), ValueType::I32, ValueType::I32],
        &[],
    )
    .with_immediates(vec![Immediate::Type(ARRAY_TYPE)]);
    let fill = operation(
        CoreOpcode::ArrayFill,
        &[
            concrete(true, ARRAY_TYPE),
            ValueType::I32,
            ValueType::I32,
            ValueType::I32,
        ],
        &[],
    )
    .with_immediates(vec![Immediate::Type(ARRAY_TYPE)]);
    assert_valid_operation(set.clone());
    assert_valid_operation(fill.clone());

    for operation in [set, fill] {
        let mnemonic = operation.mnemonic.clone();
        let mut program = operation_program(operation);
        let CompositeType::Array(field) = &mut program.types[ARRAY_TYPE.index()].composite else {
            unreachable!()
        };
        field.mutable = false;
        assert_program_schema_error(program, &[&mnemonic, "immutable elements"]);
    }
}

#[test]
fn array_len_accepts_the_abstract_array_hierarchy_only() {
    assert_valid_operation(operation(
        CoreOpcode::ArrayLen,
        &[concrete(false, ARRAY_TYPE)],
        &[ValueType::I32],
    ));
    assert_schema_error(
        operation(
            CoreOpcode::ArrayLen,
            &[concrete(true, STRUCT_TYPE)],
            &[ValueType::I32],
        ),
        &["array.len", "parameter 0", "expected a subtype", "array"],
    );
}

#[test]
fn array_copy_checks_destination_mutability_and_storage_covariance() {
    let copy = operation(
        CoreOpcode::ArrayCopy,
        &[
            concrete(true, ARRAY_TYPE),
            ValueType::I32,
            concrete(true, ARRAY_TYPE),
            ValueType::I32,
            ValueType::I32,
        ],
        &[],
    )
    .with_immediates(vec![
        Immediate::Type(ARRAY_TYPE),
        Immediate::Type(ARRAY_TYPE),
    ]);
    assert_valid_operation(copy.clone());

    assert_schema_error(
        operation(
            CoreOpcode::ArrayCopy,
            &[
                concrete(true, ARRAY_TYPE),
                ValueType::I32,
                concrete(true, PACKED_ARRAY_TYPE),
                ValueType::I32,
                ValueType::I32,
            ],
            &[],
        )
        .with_immediates(vec![
            Immediate::Type(ARRAY_TYPE),
            Immediate::Type(PACKED_ARRAY_TYPE),
        ]),
        &["array.copy", "source element type", "not compatible"],
    );

    let mut program = operation_program(copy);
    let CompositeType::Array(field) = &mut program.types[ARRAY_TYPE.index()].composite else {
        unreachable!()
    };
    field.mutable = false;
    assert_program_schema_error(
        program,
        &["array.copy", "destination elements are immutable"],
    );
}

#[test]
fn array_init_data_checks_mutability_and_numeric_storage() {
    let array_init_data = operation(
        CoreOpcode::ArrayInitData,
        &[
            concrete(true, ARRAY_TYPE),
            ValueType::I32,
            ValueType::I32,
            ValueType::I32,
        ],
        &[],
    )
    .with_immediates(vec![
        Immediate::Type(ARRAY_TYPE),
        Immediate::Data(DataId(0)),
    ]);
    assert_valid_operation(array_init_data.clone());

    let mut immutable = operation_program(array_init_data);
    let CompositeType::Array(field) = &mut immutable.types[ARRAY_TYPE.index()].composite else {
        unreachable!()
    };
    field.mutable = false;
    assert_program_schema_error(immutable, &["array.init_data", "immutable elements"]);

    assert_schema_error(
        operation(
            CoreOpcode::ArrayInitData,
            &[
                concrete(true, REF_ARRAY_TYPE),
                ValueType::I32,
                ValueType::I32,
                ValueType::I32,
            ],
            &[],
        )
        .with_immediates(vec![
            Immediate::Type(REF_ARRAY_TYPE),
            Immediate::Data(DataId(0)),
        ]),
        &["array.init_data", "numeric or vector element type"],
    );
}

#[test]
fn array_init_elem_checks_mutability_reference_storage_and_segment_covariance() {
    let valid = operation(
        CoreOpcode::ArrayInitElem,
        &[
            concrete(true, REF_ARRAY_TYPE),
            ValueType::I32,
            ValueType::I32,
            ValueType::I32,
        ],
        &[],
    )
    .with_immediates(vec![
        Immediate::Type(REF_ARRAY_TYPE),
        Immediate::Element(ElementId(1)),
    ]);
    assert_valid_operation(valid.clone());

    let mut immutable = operation_program(valid);
    let CompositeType::Array(field) = &mut immutable.types[REF_ARRAY_TYPE.index()].composite else {
        unreachable!()
    };
    field.mutable = false;
    assert_program_schema_error(immutable, &["array.init_elem", "immutable elements"]);

    assert_schema_error(
        operation(
            CoreOpcode::ArrayInitElem,
            &[
                concrete(true, ARRAY_TYPE),
                ValueType::I32,
                ValueType::I32,
                ValueType::I32,
            ],
            &[],
        )
        .with_immediates(vec![
            Immediate::Type(ARRAY_TYPE),
            Immediate::Element(ElementId(0)),
        ]),
        &["array.init_elem", "reference element type"],
    );
    assert_schema_error(
        operation(
            CoreOpcode::ArrayInitElem,
            &[
                concrete(true, REF_ARRAY_TYPE),
                ValueType::I32,
                ValueType::I32,
                ValueType::I32,
            ],
            &[],
        )
        .with_immediates(vec![
            Immediate::Type(REF_ARRAY_TYPE),
            Immediate::Element(ElementId(0)),
        ]),
        &["array.init_elem", "element segment type", "not a subtype"],
    );
}

#[test]
fn contextual_entity_lookups_are_safe_for_forged_indices() {
    let cases = [
        operation(CoreOpcode::Call, &[], &[])
            .with_immediates(vec![Immediate::Function(FunctionId(99))]),
        operation(CoreOpcode::GlobalGet, &[], &[ValueType::I32])
            .with_immediates(vec![Immediate::Global(GlobalId(99))]),
        operation(CoreOpcode::MemorySize, &[], &[ValueType::I32])
            .with_immediates(vec![Immediate::Memory(MemoryId(99))]),
        operation(CoreOpcode::TableSize, &[], &[ValueType::I32])
            .with_immediates(vec![Immediate::Table(TableId(99))]),
    ];
    for operation in cases {
        assert_schema_error(operation, &["references missing"]);
    }
}

#[test]
fn contextual_schema_diagnostics_use_the_canonical_opcode_identity() {
    let mut forged = operation(CoreOpcode::Call, &[], &[])
        .with_immediates(vec![Immediate::Function(FunctionId(99))]);
    forged.mnemonic = "forged.call".into();

    let error = operation_program(forged)
        .verify()
        .expect_err("the forged call must fail verification")
        .to_string();
    assert!(
        error.contains("identifies core opcode call, but uses mnemonic forged.call"),
        "{error}"
    );
    assert!(
        error.contains("invalid Core schema: Core operator call references missing func99"),
        "{error}"
    );
    assert!(!error.contains("Core operator forged.call"), "{error}");
}

#[test]
fn drop_and_nop_have_their_exact_contextual_signatures() {
    assert_valid_operation(operation(CoreOpcode::Nop, &[], &[]));
    assert_valid_operation(operation(
        CoreOpcode::Drop,
        &[concrete(true, STRUCT_TYPE)],
        &[],
    ));
    assert_schema_error(
        operation(CoreOpcode::Nop, &[ValueType::I32], &[]),
        &["nop", "expected 0 -> 0"],
    );
    assert_schema_error(
        operation(CoreOpcode::Drop, &[], &[]),
        &["drop", "expected 1 -> 0"],
    );
}

#[test]
fn an_empty_function_type_remains_available_to_contextual_call_tests() {
    assert_valid_operation(
        operation(CoreOpcode::CallIndirect, &[ValueType::I32], &[]).with_immediates(vec![
            Immediate::Type(EMPTY_FUNCTION_TYPE),
            Immediate::Table(TableId(0)),
        ]),
    );
    assert_valid_operation(
        operation(
            CoreOpcode::CallRef,
            &[concrete(false, EMPTY_FUNCTION_TYPE)],
            &[],
        )
        .with_immediates(vec![Immediate::Type(EMPTY_FUNCTION_TYPE)]),
    );
}
