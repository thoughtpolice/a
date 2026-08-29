// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the operation and terminator semantic-effects classifiers.
//!
use wedge::ir::{
    BlockId, Callee, DataId, Edge, Effect, EffectAccess, EffectResource, ElementId,
    ExceptionEffect, FunctionId, GlobalId, Immediate, MemoryArgument, MemoryId, Operation,
    OperationKind, TableId, TagId, TerminatorKind, TrapCode, TypeId, ValueId,
};
use wedge::opcode::{CoreOpcode, CoreProposal};
use wedge::semantics::{effects_for_operation, effects_for_terminator};

fn operation(opcode: CoreOpcode) -> Operation {
    Operation::core(opcode, vec![], vec![])
}

fn assert_access(effects: &wedge::ir::Effects, resource: EffectResource, access: EffectAccess) {
    assert!(
        effects.accesses.contains(&Effect { resource, access }),
        "missing {access:?} access to {resource:?} in {effects:?}"
    );
}

fn assert_trap(effects: &wedge::ir::Effects, trap: TrapCode) {
    assert!(
        effects.traps.contains(&trap),
        "missing {trap:?} in {effects:?}"
    );
}

#[test]
fn ordinary_arithmetic_is_pure() {
    assert!(effects_for_operation(&operation(CoreOpcode::I32Add)).is_pure());
    assert!(effects_for_operation(&operation(CoreOpcode::F64Mul)).is_pure());
    assert!(effects_for_operation(&operation(CoreOpcode::I8x16Add)).is_pure());
}

#[test]
fn scalar_and_simd_memory_operations_track_the_selected_memory() {
    let load = operation(CoreOpcode::I64Load).with_immediates(vec![Immediate::MemoryArgument(
        MemoryArgument {
            memory: MemoryId(3),
            offset: 16,
            alignment_log2: 3,
        },
    )]);
    let load_effects = effects_for_operation(&load);
    assert_access(
        &load_effects,
        EffectResource::Memory(MemoryId(3)),
        EffectAccess::Read,
    );
    assert_trap(&load_effects, TrapCode::MemoryOutOfBounds);

    let store =
        operation(CoreOpcode::V128Store64Lane).with_immediates(vec![Immediate::MemoryArgument(
            MemoryArgument {
                memory: MemoryId(5),
                offset: 0,
                alignment_log2: 3,
            },
        )]);
    let store_effects = effects_for_operation(&store);
    assert_access(
        &store_effects,
        EffectResource::Memory(MemoryId(5)),
        EffectAccess::Write,
    );
    assert_trap(&store_effects, TrapCode::MemoryOutOfBounds);
}

#[test]
fn cross_memory_copy_tracks_destination_and_source_separately() {
    let copy = operation(CoreOpcode::MemoryCopy).with_immediates(vec![
        Immediate::Memory(MemoryId(2)),
        Immediate::Memory(MemoryId(7)),
    ]);
    let effects = effects_for_operation(&copy);
    assert_access(
        &effects,
        EffectResource::Memory(MemoryId(2)),
        EffectAccess::Write,
    );
    assert_access(
        &effects,
        EffectResource::Memory(MemoryId(7)),
        EffectAccess::Read,
    );
    assert_trap(&effects, TrapCode::MemoryOutOfBounds);
}

#[test]
fn same_memory_copy_merges_to_read_write() {
    let copy =
        operation(CoreOpcode::MemoryCopy).with_immediates(vec![Immediate::Memory(MemoryId(4))]);
    let effects = effects_for_operation(&copy);
    assert_eq!(
        effects.accesses,
        vec![Effect {
            resource: EffectResource::Memory(MemoryId(4)),
            access: EffectAccess::ReadWrite,
        }]
    );
}

#[test]
fn memory_and_table_growth_may_allocate_without_trapping_on_failure() {
    let memory_grow =
        operation(CoreOpcode::MemoryGrow).with_immediates(vec![Immediate::Memory(MemoryId(2))]);
    let memory_effects = effects_for_operation(&memory_grow);
    assert_access(
        &memory_effects,
        EffectResource::Memory(MemoryId(2)),
        EffectAccess::ReadWrite,
    );
    assert!(memory_effects.allocates);
    assert!(!memory_effects.traps.contains(&TrapCode::AllocationFailure));

    let table_grow =
        operation(CoreOpcode::TableGrow).with_immediates(vec![Immediate::Table(TableId(3))]);
    let table_effects = effects_for_operation(&table_grow);
    assert_access(
        &table_effects,
        EffectResource::Table(TableId(3)),
        EffectAccess::ReadWrite,
    );
    assert!(table_effects.allocates);
    assert!(!table_effects.traps.contains(&TrapCode::AllocationFailure));
}

#[test]
fn globals_are_precisely_read_or_written() {
    let get =
        operation(CoreOpcode::GlobalGet).with_immediates(vec![Immediate::Global(GlobalId(9))]);
    assert_access(
        &effects_for_operation(&get),
        EffectResource::Global(GlobalId(9)),
        EffectAccess::Read,
    );

    let set =
        operation(CoreOpcode::GlobalSet).with_immediates(vec![Immediate::Global(GlobalId(9))]);
    assert_access(
        &effects_for_operation(&set),
        EffectResource::Global(GlobalId(9)),
        EffectAccess::Write,
    );
}

#[test]
fn table_accesses_and_bulk_operations_track_bounds() {
    let get = operation(CoreOpcode::TableGet).with_immediates(vec![Immediate::Table(TableId(2))]);
    let get_effects = effects_for_operation(&get);
    assert_access(
        &get_effects,
        EffectResource::Table(TableId(2)),
        EffectAccess::Read,
    );
    assert_trap(&get_effects, TrapCode::TableOutOfBounds);

    let copy = operation(CoreOpcode::TableCopy).with_immediates(vec![
        Immediate::Table(TableId(4)),
        Immediate::Table(TableId(6)),
    ]);
    let copy_effects = effects_for_operation(&copy);
    assert_access(
        &copy_effects,
        EffectResource::Table(TableId(4)),
        EffectAccess::Write,
    );
    assert_access(
        &copy_effects,
        EffectResource::Table(TableId(6)),
        EffectAccess::Read,
    );
    assert_trap(&copy_effects, TrapCode::TableOutOfBounds);
}

#[test]
fn direct_calls_are_opaque_and_may_throw() {
    let effects = effects_for_operation(&operation(CoreOpcode::Call));
    assert_access(&effects, EffectResource::Host, EffectAccess::ReadWrite);
    assert_eq!(effects.exception, ExceptionEffect::MayThrow);
    assert_trap(&effects, TrapCode::StackOverflow);
    assert_trap(&effects, TrapCode::Other("callee-trap".to_owned()));
    assert!(effects.allocates);
}

#[test]
fn indirect_calls_include_table_dispatch_failures() {
    let call =
        operation(CoreOpcode::CallIndirect).with_immediates(vec![Immediate::Table(TableId(3))]);
    let effects = effects_for_operation(&call);
    assert_access(
        &effects,
        EffectResource::Table(TableId(3)),
        EffectAccess::Read,
    );
    assert_access(&effects, EffectResource::Host, EffectAccess::ReadWrite);
    assert_trap(&effects, TrapCode::TableOutOfBounds);
    assert_trap(&effects, TrapCode::NullFunctionReference);
    assert_trap(&effects, TrapCode::IndirectCallTypeMismatch);
    assert!(matches!(effects.exception, ExceptionEffect::MayThrow));
}

#[test]
fn integer_division_and_remainder_have_distinct_trap_sets() {
    let signed_div = effects_for_operation(&operation(CoreOpcode::I32DivS));
    assert_trap(&signed_div, TrapCode::IntegerDivideByZero);
    assert_trap(&signed_div, TrapCode::IntegerOverflow);

    let remainder = effects_for_operation(&operation(CoreOpcode::I64RemS));
    assert_trap(&remainder, TrapCode::IntegerDivideByZero);
    assert!(!remainder.traps.contains(&TrapCode::IntegerOverflow));
}

#[test]
fn only_trapping_float_to_integer_conversion_gets_a_trap() {
    let trapping = effects_for_operation(&operation(CoreOpcode::I64TruncF32U));
    assert_trap(&trapping, TrapCode::InvalidConversionToInteger);
    assert_trap(&trapping, TrapCode::IntegerOverflow);

    let saturating = effects_for_operation(&operation(CoreOpcode::I64TruncSatF32U));
    assert!(saturating.traps.is_empty());
}

#[test]
fn gc_construction_records_heap_write_allocation_and_failure() {
    let effects = effects_for_operation(&operation(CoreOpcode::StructNew));
    assert_access(&effects, EffectResource::GcHeap, EffectAccess::Write);
    assert!(effects.allocates);
    assert_trap(&effects, TrapCode::AllocationFailure);
}

#[test]
fn gc_reads_writes_and_bounds_are_not_treated_as_pure() {
    let get = effects_for_operation(&operation(CoreOpcode::StructGet));
    assert_access(&get, EffectResource::GcHeap, EffectAccess::Read);
    assert_trap(&get, TrapCode::NullReference);

    let copy = effects_for_operation(&operation(CoreOpcode::ArrayCopy));
    assert_access(&copy, EffectResource::GcHeap, EffectAccess::ReadWrite);
    assert_trap(&copy, TrapCode::NullReference);
    assert_trap(&copy, TrapCode::BadArrayElement);
}

#[test]
fn reference_refinement_traps_remain_explicit() {
    let as_non_null = effects_for_operation(&operation(CoreOpcode::RefAsNonNull));
    assert_trap(&as_non_null, TrapCode::NullReference);

    let cast = effects_for_operation(&operation(CoreOpcode::RefCastNonNull));
    assert_trap(&cast, TrapCode::Other("cast-failure".to_owned()));

    for opcode in [CoreOpcode::I31GetS, CoreOpcode::I31GetU] {
        assert_trap(
            &effects_for_operation(&operation(opcode)),
            TrapCode::NullReference,
        );
    }
}

#[test]
fn segment_consumers_and_drop_operations_track_the_exact_segment() {
    let memory_init = operation(CoreOpcode::MemoryInit).with_immediates(vec![
        Immediate::Data(DataId(3)),
        Immediate::Memory(MemoryId(1)),
    ]);
    let init_effects = effects_for_operation(&memory_init);
    assert_access(
        &init_effects,
        EffectResource::DataSegment(DataId(3)),
        EffectAccess::Read,
    );
    assert!(
        !init_effects
            .accesses
            .iter()
            .any(|effect| effect.resource == EffectResource::Host)
    );

    let data_drop =
        operation(CoreOpcode::DataDrop).with_immediates(vec![Immediate::Data(DataId(3))]);
    let drop_effects = effects_for_operation(&data_drop);
    assert_access(
        &drop_effects,
        EffectResource::DataSegment(DataId(3)),
        EffectAccess::Write,
    );

    let table_init = operation(CoreOpcode::TableInit).with_immediates(vec![
        Immediate::Element(ElementId(5)),
        Immediate::Table(TableId(2)),
    ]);
    let table_effects = effects_for_operation(&table_init);
    assert_access(
        &table_effects,
        EffectResource::ElementSegment(ElementId(5)),
        EffectAccess::Read,
    );

    let elem_drop =
        operation(CoreOpcode::ElemDrop).with_immediates(vec![Immediate::Element(ElementId(5))]);
    let elem_drop_effects = effects_for_operation(&elem_drop);
    assert_access(
        &elem_drop_effects,
        EffectResource::ElementSegment(ElementId(5)),
        EffectAccess::Write,
    );
}

#[test]
fn missing_segment_immediates_do_not_fabricate_segment_zero_effects() {
    let data_drop = effects_for_operation(&operation(CoreOpcode::DataDrop));
    assert!(
        !data_drop
            .accesses
            .iter()
            .any(|effect| { matches!(effect.resource, EffectResource::DataSegment(_)) })
    );

    let elem_drop = effects_for_operation(&operation(CoreOpcode::ElemDrop));
    assert!(
        !elem_drop
            .accesses
            .iter()
            .any(|effect| { matches!(effect.resource, EffectResource::ElementSegment(_)) })
    );
}

#[test]
fn synthetic_operations_default_to_explicitly_pure() {
    let operation = Operation::synthetic("wedge.identity", vec![], vec![]);
    assert_eq!(operation.kind, OperationKind::Synthetic);
    assert!(effects_for_operation(&operation).is_pure());
}

#[test]
fn out_of_profile_operations_are_opaque_in_defense_in_depth() {
    let effects = effects_for_operation(&operation(CoreOpcode::I32AtomicLoad));
    assert_access(&effects, EffectResource::Host, EffectAccess::ReadWrite);
    assert_trap(
        &effects,
        TrapCode::Other("out-of-profile-operation".to_owned()),
    );
}

#[test]
fn ordinary_cfg_transfers_and_returns_are_pure() {
    let edge = || Edge::new(BlockId(1), vec![ValueId(2)]);
    for terminator in [
        TerminatorKind::Jump(edge()),
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: edge(),
            else_edge: edge(),
        },
        TerminatorKind::Switch {
            selector: ValueId(0),
            targets: vec![edge()],
            default: edge(),
        },
        TerminatorKind::Return {
            values: vec![ValueId(2)],
        },
    ] {
        assert!(
            effects_for_terminator(&terminator).is_pure(),
            "{terminator:?}"
        );
    }
}

#[test]
fn direct_tail_calls_have_the_same_conservative_call_base_as_calls() {
    let terminator = TerminatorKind::TailCall {
        callee: Callee::Direct(FunctionId(4)),
        arguments: vec![ValueId(0)],
    };
    let effects = effects_for_terminator(&terminator);
    assert_access(&effects, EffectResource::Host, EffectAccess::ReadWrite);
    assert!(effects.allocates);
    assert!(matches!(effects.exception, ExceptionEffect::MayThrow));
    assert_trap(&effects, TrapCode::StackOverflow);
    assert_trap(&effects, TrapCode::Other("callee-trap".to_owned()));
}

#[test]
fn indirect_tail_calls_include_their_table_dispatch_effects() {
    let terminator = TerminatorKind::TailCall {
        callee: Callee::Indirect {
            ty: TypeId(2),
            table: TableId(5),
            index: ValueId(8),
        },
        arguments: vec![ValueId(0)],
    };
    let effects = effects_for_terminator(&terminator);
    assert_access(&effects, EffectResource::Host, EffectAccess::ReadWrite);
    assert_access(
        &effects,
        EffectResource::Table(TableId(5)),
        EffectAccess::Read,
    );
    assert_trap(&effects, TrapCode::TableOutOfBounds);
    assert_trap(&effects, TrapCode::NullFunctionReference);
    assert_trap(&effects, TrapCode::IndirectCallTypeMismatch);
}

#[test]
fn reference_tail_calls_retain_the_null_callee_trap() {
    let terminator = TerminatorKind::TailCall {
        callee: Callee::Reference {
            ty: TypeId(1),
            reference: ValueId(7),
        },
        arguments: vec![],
    };
    let effects = effects_for_terminator(&terminator);
    assert_access(&effects, EffectResource::Host, EffectAccess::ReadWrite);
    assert_trap(&effects, TrapCode::NullFunctionReference);
    assert!(!effects.traps.contains(&TrapCode::TableOutOfBounds));
    assert!(!effects.traps.contains(&TrapCode::IndirectCallTypeMismatch));
}

#[test]
fn throw_terminators_are_exceptional_and_throw_ref_can_trap_on_null() {
    let throw = TerminatorKind::Throw {
        tag: TagId(3),
        arguments: vec![ValueId(0)],
    };
    let throw_effects = effects_for_terminator(&throw);
    assert!(matches!(throw_effects.exception, ExceptionEffect::MayThrow));
    assert!(throw_effects.traps.is_empty());

    let throw_ref = TerminatorKind::ThrowRef {
        exception: ValueId(4),
    };
    let throw_ref_effects = effects_for_terminator(&throw_ref);
    assert!(matches!(
        throw_ref_effects.exception,
        ExceptionEffect::MayThrow
    ));
    assert_trap(&throw_ref_effects, TrapCode::NullReference);
}

#[test]
fn unreachable_terminators_preserve_their_carried_trap() {
    for trap in [
        TrapCode::Unreachable,
        TrapCode::IntegerOverflow,
        TrapCode::Other("compiler-inserted-guard".to_owned()),
    ] {
        let terminator = TerminatorKind::Unreachable { trap: trap.clone() };
        let effects = effects_for_terminator(&terminator);
        assert_eq!(effects.traps, [trap]);
        assert!(effects.accesses.is_empty());
        assert!(!effects.allocates);
        assert_eq!(effects.exception, ExceptionEffect::None);
    }
}

#[test]
fn relaxed_simd_operations_are_nondeterministic_and_nothing_else_is() {
    let mut relaxed = 0;
    for &opcode in CoreOpcode::ALL {
        if !opcode.is_standard_wasm3() {
            continue;
        }
        let effects = effects_for_operation(&operation(opcode));
        let expected = opcode.proposal() == CoreProposal::RelaxedSimd;
        assert_eq!(
            effects.nondeterministic,
            expected,
            "{}",
            opcode.parser_name()
        );
        if expected {
            relaxed += 1;
            assert!(!effects.is_pure(), "{}", opcode.parser_name());
        }
    }
    assert_eq!(relaxed, 20, "the relaxed SIMD inventory changed");
}

#[test]
fn access_conflicts_follow_the_documented_resource_rules() {
    use EffectAccess::{Read, ReadWrite, Write};
    use EffectResource::{DataSegment, GcHeap, Global, Host, Memory, Table};
    let effect = |resource, access| Effect { resource, access };
    let cases = [
        (
            effect(Memory(MemoryId(0)), Read),
            effect(Memory(MemoryId(0)), Read),
            false,
        ),
        (
            effect(Memory(MemoryId(0)), Read),
            effect(Memory(MemoryId(0)), Write),
            true,
        ),
        (
            effect(Memory(MemoryId(0)), Write),
            effect(Memory(MemoryId(0)), Write),
            true,
        ),
        (
            effect(Memory(MemoryId(0)), Read),
            effect(Memory(MemoryId(1)), Write),
            false,
        ),
        (
            effect(Memory(MemoryId(0)), Read),
            effect(Host, ReadWrite),
            true,
        ),
        (effect(Host, Read), effect(Memory(MemoryId(0)), Read), false),
        (effect(Host, Read), effect(Memory(MemoryId(0)), Write), true),
        (effect(GcHeap, Read), effect(GcHeap, Write), true),
        (
            effect(GcHeap, Read),
            effect(Memory(MemoryId(0)), Write),
            false,
        ),
        (
            effect(Table(TableId(0)), Read),
            effect(Table(TableId(0)), Write),
            true,
        ),
        (
            effect(DataSegment(DataId(0)), Read),
            effect(DataSegment(DataId(0)), Write),
            true,
        ),
        (
            effect(Global(GlobalId(1)), Write),
            effect(Global(GlobalId(2)), Write),
            false,
        ),
    ];
    for (left, right, expected) in cases {
        assert_eq!(
            left.conflicts_with(right),
            expected,
            "{left:?} vs {right:?}"
        );
        assert_eq!(
            right.conflicts_with(left),
            expected,
            "{right:?} vs {left:?}"
        );
    }
}

#[test]
fn effect_sets_conflict_through_aliasing_writers_and_host_barriers() {
    let call = effects_for_operation(&operation(CoreOpcode::Call));
    let load = effects_for_operation(&operation(CoreOpcode::I32Load));
    let allocation = effects_for_operation(&operation(CoreOpcode::StructNew));
    let add = effects_for_operation(&operation(CoreOpcode::I32Add));
    let relaxed = effects_for_operation(&operation(CoreOpcode::F32x4RelaxedMadd));

    assert!(call.conflicts_with(&load) && load.conflicts_with(&call));
    assert!(
        allocation.conflicts_with(&call) && call.conflicts_with(&allocation),
        "an allocation cannot move across opaque host state"
    );
    assert!(!allocation.conflicts_with(&load));
    assert!(!add.conflicts_with(&load) && !load.conflicts_with(&add));
    assert!(!relaxed.conflicts_with(&load) && !relaxed.conflicts_with(&call));

    assert!(call.is_barrier());
    assert!(!load.is_barrier());
    assert!(!add.is_barrier());
    assert!(!relaxed.is_barrier());
}

#[test]
fn standard_operation_purity_is_derivable_from_its_parser_schema() {
    // An operator naming a module entity in an immediate touches state; the
    // listed exceptions are the operators whose effects are traps or
    // reference tests rather than entity accesses, and `ref.func`, whose
    // function immediate names no mutable state.
    const ENTITY_FIELDS: &[&str] = &[
        "memarg",
        "mem",
        "dst_mem",
        "src_mem",
        "table",
        "table_index",
        "dst_table",
        "src_table",
        "global_index",
        "data_index",
        "elem_index",
        "array_data_index",
        "array_data_index_dst",
        "array_data_index_src",
        "array_elem_index",
        "array_elem_index_dst",
        "array_elem_index_src",
        "tag_index",
        "tag",
        "struct_type_index",
        "array_type_index",
        "array_type_index_dst",
        "array_type_index_src",
        "function_index",
        "type_index",
    ];
    const PURE_DESPITE_ENTITY: &[CoreOpcode] = &[CoreOpcode::RefFunc];
    const IMPURE_WITHOUT_ENTITY: &[CoreOpcode] = &[
        CoreOpcode::I32DivS,
        CoreOpcode::I32DivU,
        CoreOpcode::I32RemS,
        CoreOpcode::I32RemU,
        CoreOpcode::I64DivS,
        CoreOpcode::I64DivU,
        CoreOpcode::I64RemS,
        CoreOpcode::I64RemU,
        CoreOpcode::I32TruncF32S,
        CoreOpcode::I32TruncF32U,
        CoreOpcode::I32TruncF64S,
        CoreOpcode::I32TruncF64U,
        CoreOpcode::I64TruncF32S,
        CoreOpcode::I64TruncF32U,
        CoreOpcode::I64TruncF64S,
        CoreOpcode::I64TruncF64U,
        CoreOpcode::RefAsNonNull,
        CoreOpcode::I31GetS,
        CoreOpcode::I31GetU,
        CoreOpcode::RefTestNonNull,
        CoreOpcode::RefTestNullable,
        CoreOpcode::RefCastNonNull,
        CoreOpcode::RefCastNullable,
        CoreOpcode::BrOnCast,
        CoreOpcode::BrOnCastFail,
        CoreOpcode::ArrayLen,
        CoreOpcode::Unreachable,
        CoreOpcode::ThrowRef,
    ];
    for &opcode in CoreOpcode::ALL {
        if !opcode.is_standard_wasm3() {
            continue;
        }
        let touches_entity = opcode
            .immediate_fields()
            .iter()
            .any(|field| ENTITY_FIELDS.contains(field));
        let expected_pure = opcode.proposal() != CoreProposal::RelaxedSimd
            && !IMPURE_WITHOUT_ENTITY.contains(&opcode)
            && (!touches_entity || PURE_DESPITE_ENTITY.contains(&opcode));
        // Segment classification never fabricates segment 0, so name one.
        let immediates: Vec<Immediate> = opcode
            .immediate_fields()
            .iter()
            .filter_map(|field| match *field {
                "data_index"
                | "array_data_index"
                | "array_data_index_dst"
                | "array_data_index_src" => Some(Immediate::Data(DataId(0))),
                "elem_index"
                | "array_elem_index"
                | "array_elem_index_dst"
                | "array_elem_index_src" => Some(Immediate::Element(ElementId(0))),
                _ => None,
            })
            .collect();
        let actual_pure =
            effects_for_operation(&operation(opcode).with_immediates(immediates)).is_pure();
        assert_eq!(
            actual_pure,
            expected_pure,
            "{} (touches an entity: {touches_entity})",
            opcode.parser_name()
        );
    }
}
