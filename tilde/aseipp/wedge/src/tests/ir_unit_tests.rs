// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use wedge::ir::*;
use wedge::opcode::CoreOpcode;

fn source() -> SourceInfo {
    SourceInfo::synthetic()
}

fn operation(mnemonic: &str, params: Vec<ValueType>, results: Vec<ValueType>) -> Operation {
    Operation::new(mnemonic, params, results)
}

fn constant(id: InstructionId, value: ValueId, integer: i32) -> Instruction {
    Instruction::new(
        id,
        operation("i32.const", vec![], vec![ValueType::I32])
            .with_immediates(vec![Immediate::S32(integer)]),
        vec![],
        vec![ValueDefinition::new(value, ValueType::I32)],
        source(),
    )
}

fn block(
    id: BlockId,
    parameters: Vec<ValueDefinition>,
    instructions: Vec<Instruction>,
    terminator: TerminatorKind,
) -> Block {
    Block {
        id,
        region: RegionId(0),
        parameters,
        instructions,
        terminator: Terminator::new(terminator, source()),
        source: source(),
    }
}

fn program_with_blocks(results: Vec<ValueType>, blocks: Vec<Block>) -> Program {
    let mut program = Program::new(1);
    program.types.push(TypeDefinition {
        canonical_alias: None,
        final_: true,
        supertype: None,
        composite: CompositeType::Function(FunctionType {
            params: vec![],
            results,
        }),
        source: source(),
    });
    program.rec_groups.push(RecGroup {
        types: vec![TypeId(0)],
        source: source(),
    });
    program.functions.push(Function {
        wasm_index: 0,
        ty: TypeId(0),
        origin: EntityOrigin::Defined,
        locals: vec![],
        body: Some(FunctionBody {
            entry: BlockId(0),
            root_region: RegionId(0),
            blocks,
            regions: vec![Region {
                id: RegionId(0),
                parent: None,
                kind: RegionKind::Function,
                entry: BlockId(0),
                source: source(),
            }],
        }),
        source: source(),
    });
    program
}

fn valid_program() -> Program {
    program_with_blocks(
        vec![ValueType::I32],
        vec![block(
            BlockId(0),
            vec![],
            vec![constant(InstructionId(0), ValueId(0), 42)],
            TerminatorKind::Return {
                values: vec![ValueId(0)],
            },
        )],
    )
}

fn reference_type(nullable: bool, heap: HeapType) -> ValueType {
    ValueType::Ref(RefType { nullable, heap })
}

fn valid_null_edge_refinement_program() -> Program {
    let nullable = reference_type(true, HeapType::Extern);
    let non_null_type = reference_type(false, HeapType::Extern);
    let reference = Instruction::new(
        InstructionId(0),
        Operation::core(CoreOpcode::RefNull, vec![], vec![nullable.clone()])
            .with_immediates(vec![Immediate::HeapType(HeapType::Extern)]),
        vec![],
        vec![ValueDefinition::new(ValueId(0), nullable.clone())],
        source(),
    );
    let mut predicate = Instruction::new(
        InstructionId(1),
        Operation::core(CoreOpcode::RefIsNull, vec![nullable], vec![ValueType::I32]),
        vec![ValueId(0)],
        vec![ValueDefinition::new(ValueId(1), ValueType::I32)],
        source(),
    );
    predicate.effects = wedge::semantics::effects_for_operation(&predicate.operation);
    let entry = block(
        BlockId(0),
        vec![],
        vec![reference, predicate],
        TerminatorKind::Branch {
            condition: ValueId(1),
            then_edge: Edge::new(BlockId(1), vec![]),
            else_edge: Edge::new(BlockId(2), vec![ValueId(0)])
                .with_refinement(0, non_null_type.clone()),
        },
    );
    let null = block(
        BlockId(1),
        vec![],
        vec![],
        TerminatorKind::Unreachable {
            trap: TrapCode::Unreachable,
        },
    );
    let non_null_block = block(
        BlockId(2),
        vec![ValueDefinition::new(ValueId(2), non_null_type.clone())],
        vec![],
        TerminatorKind::Return {
            values: vec![ValueId(2)],
        },
    );
    program_with_blocks(vec![non_null_type], vec![entry, null, non_null_block])
}

fn valid_cast_edge_refinement_program() -> Program {
    let from = reference_type(true, HeapType::Any);
    let cast = reference_type(true, HeapType::Eq);
    let difference = reference_type(false, HeapType::Any);
    let reference = Instruction::new(
        InstructionId(0),
        Operation::core(CoreOpcode::RefNull, vec![], vec![from.clone()])
            .with_immediates(vec![Immediate::HeapType(HeapType::Any)]),
        vec![],
        vec![ValueDefinition::new(ValueId(0), from.clone())],
        source(),
    );
    let mut predicate = Instruction::new(
        InstructionId(1),
        Operation::core(
            CoreOpcode::RefTestNullable,
            vec![from],
            vec![ValueType::I32],
        )
        .with_immediates(vec![Immediate::HeapType(HeapType::Eq)]),
        vec![ValueId(0)],
        vec![ValueDefinition::new(ValueId(1), ValueType::I32)],
        source(),
    );
    predicate.effects = wedge::semantics::effects_for_operation(&predicate.operation);
    let entry = block(
        BlockId(0),
        vec![],
        vec![reference, predicate],
        TerminatorKind::Branch {
            condition: ValueId(1),
            then_edge: Edge::new(BlockId(1), vec![ValueId(0)]).with_refinement(0, cast.clone()),
            else_edge: Edge::new(BlockId(2), vec![ValueId(0)])
                .with_refinement(0, difference.clone()),
        },
    );
    let success = block(
        BlockId(1),
        vec![ValueDefinition::new(ValueId(2), cast)],
        vec![],
        TerminatorKind::Unreachable {
            trap: TrapCode::Unreachable,
        },
    );
    let failure = block(
        BlockId(2),
        vec![ValueDefinition::new(ValueId(3), difference)],
        vec![],
        TerminatorKind::Unreachable {
            trap: TrapCode::Unreachable,
        },
    );
    program_with_blocks(vec![], vec![entry, success, failure])
}

fn verification_text(program: &Program) -> String {
    program
        .verify()
        .expect_err("IR must be rejected")
        .to_string()
}

#[test]
fn rejects_out_of_profile_opcode_artifacts_and_forged_schemas() {
    let mut out_of_profile = valid_program();
    out_of_profile.functions[0]
        .body
        .as_mut()
        .expect("defined function")
        .blocks[0]
        .instructions[0]
        .operation = Operation::core(CoreOpcode::TypedSelectMulti, vec![], vec![ValueType::I32]);
    let error = verification_text(&out_of_profile);
    assert!(
        error.contains("uses out-of-profile core opcode select"),
        "{error}"
    );

    let mut wrong_arity = valid_program();
    wrong_arity.functions[0]
        .body
        .as_mut()
        .expect("defined function")
        .blocks[0]
        .instructions[0]
        .operation = Operation::core(CoreOpcode::I32Add, vec![], vec![ValueType::I32]);
    let error = verification_text(&wrong_arity);
    assert!(
        error.contains("invalid Core schema: Core operator i32.add has signature"),
        "{error}"
    );
}

#[test]
fn shared_subtype_queries_cover_nullability_nominal_types_and_bottoms() {
    let types = vec![
        TypeDefinition {
            canonical_alias: None,
            final_: false,
            supertype: None,
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: Some(TypeId(0)),
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Function(FunctionType::default()),
            source: source(),
        },
    ];
    let precise_struct = RefType {
        nullable: false,
        heap: HeapType::Concrete(TypeId(1)),
    };
    let nullable_base = RefType {
        nullable: true,
        heap: HeapType::Concrete(TypeId(0)),
    };

    assert!(is_ref_subtype(&types, &precise_struct, &nullable_base));
    assert!(is_value_subtype(
        &types,
        &ValueType::Ref(precise_struct.clone()),
        &ValueType::Ref(nullable_base.clone()),
    ));
    assert!(!is_ref_subtype(&types, &nullable_base, &precise_struct));
    assert!(is_nominal_type_subtype(&types, TypeId(1), TypeId(0)));
    assert!(!is_nominal_type_subtype(&types, TypeId(0), TypeId(1)));
    assert!(is_heap_subtype(
        &types,
        &HeapType::None,
        &HeapType::Concrete(TypeId(0))
    ));
    assert!(!is_heap_subtype(
        &types,
        &HeapType::None,
        &HeapType::Concrete(TypeId(2))
    ));
    assert!(is_heap_subtype(
        &types,
        &HeapType::NoFunc,
        &HeapType::Concrete(TypeId(2))
    ));

    let cyclic = vec![
        TypeDefinition {
            canonical_alias: None,
            final_: false,
            supertype: Some(TypeId(1)),
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: false,
            supertype: Some(TypeId(0)),
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
    ];
    assert!(!is_nominal_type_subtype(&cyclic, TypeId(0), TypeId(99)));
}

#[test]
fn canonical_equivalence_is_cycle_safe_and_does_not_infer_nominal_aliases() {
    let types = vec![
        TypeDefinition {
            canonical_alias: None,
            final_: false,
            supertype: None,
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: Some(TypeId(0)),
            final_: false,
            supertype: None,
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: false,
            supertype: None,
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: Some(TypeId(0)),
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
    ];

    assert_eq!(canonical_type_id(&types, TypeId(1)), Some(TypeId(0)));
    assert!(is_nominal_type_subtype(&types, TypeId(0), TypeId(1)));
    assert!(is_nominal_type_subtype(&types, TypeId(1), TypeId(0)));
    assert!(is_nominal_type_subtype(&types, TypeId(3), TypeId(1)));
    assert!(!is_nominal_type_subtype(&types, TypeId(2), TypeId(0)));
    assert!(!is_nominal_type_subtype(&types, TypeId(0), TypeId(2)));

    let cyclic_aliases = vec![
        TypeDefinition {
            canonical_alias: Some(TypeId(1)),
            final_: true,
            supertype: None,
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: Some(TypeId(0)),
            final_: true,
            supertype: None,
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
    ];
    assert_eq!(canonical_type_id(&cyclic_aliases, TypeId(0)), None);
    assert!(!is_nominal_type_subtype(
        &cyclic_aliases,
        TypeId(0),
        TypeId(1)
    ));
}

#[test]
fn accepts_a_canonical_alias_for_an_instruction_result_type() {
    let canonical_result = reference_type(false, HeapType::Concrete(TypeId(0)));
    let alias_result = reference_type(false, HeapType::Concrete(TypeId(1)));
    let operation = Operation::core(
        CoreOpcode::StructNew,
        vec![],
        vec![canonical_result.clone()],
    )
    .with_immediates(vec![Immediate::Type(TypeId(0))]);
    let mut instruction = Instruction::new(
        InstructionId(0),
        operation,
        vec![],
        vec![ValueDefinition::new(ValueId(0), alias_result)],
        source(),
    );
    instruction.effects = wedge::semantics::effects_for_operation(&instruction.operation);

    let empty_struct = CompositeType::Struct(vec![]);
    let mut program = Program::new(1);
    program.types = vec![
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: empty_struct.clone(),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: Some(TypeId(0)),
            final_: true,
            supertype: None,
            composite: empty_struct,
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Function(FunctionType {
                params: vec![],
                results: vec![canonical_result],
            }),
            source: source(),
        },
    ];
    program.rec_groups = (0..3)
        .map(|index| RecGroup {
            types: vec![TypeId(index)],
            source: source(),
        })
        .collect();
    program.functions.push(Function {
        wasm_index: 0,
        ty: TypeId(2),
        origin: EntityOrigin::Defined,
        locals: vec![],
        body: Some(FunctionBody {
            entry: BlockId(0),
            root_region: RegionId(0),
            blocks: vec![block(
                BlockId(0),
                vec![],
                vec![instruction],
                TerminatorKind::Return {
                    values: vec![ValueId(0)],
                },
            )],
            regions: vec![Region {
                id: RegionId(0),
                parent: None,
                kind: RegionKind::Function,
                entry: BlockId(0),
                source: source(),
            }],
        }),
        source: source(),
    });

    program
        .verify()
        .expect("canonical aliases are valid instruction result annotations");
}

#[test]
fn rejects_a_proper_subtype_as_an_instruction_result_annotation() {
    let any = reference_type(true, HeapType::Any);
    let eq = reference_type(true, HeapType::Eq);
    let mut program = valid_program();
    let CompositeType::Function(function_type) = &mut program.types[0].composite else {
        unreachable!("valid_program has a function type")
    };
    function_type.results = vec![any.clone()];
    let instruction = &mut program.functions[0]
        .body
        .as_mut()
        .expect("defined function")
        .blocks[0]
        .instructions[0];
    instruction.operation = Operation::synthetic("wedge.test_result", vec![], vec![any]);
    instruction.results[0].ty = eq;

    let error = verification_text(&program);
    assert!(
        error.contains("defines %0 as (ref null eq), expected (ref null any)"),
        "{error}"
    );
}

#[test]
fn accepts_a_canonical_alias_for_a_constant_expression_result() {
    let mut program = valid_program();
    let canonical_function = program.types[0].composite.clone();
    program.types.push(TypeDefinition {
        canonical_alias: Some(TypeId(0)),
        final_: true,
        supertype: None,
        composite: canonical_function,
        source: source(),
    });
    program.rec_groups.push(RecGroup {
        types: vec![TypeId(1)],
        source: source(),
    });

    let canonical_ref = reference_type(false, HeapType::Concrete(TypeId(0)));
    let alias_ref = reference_type(false, HeapType::Concrete(TypeId(1)));
    program.globals.push(Global {
        ty: GlobalType {
            value: alias_ref.clone(),
            mutable: false,
        },
        origin: EntityOrigin::Defined,
        initializer: Some(ConstExpr {
            instructions: vec![ConstInstruction {
                operation: Operation::core(CoreOpcode::RefFunc, vec![], vec![canonical_ref])
                    .with_immediates(vec![Immediate::Function(FunctionId(0))]),
                source: source(),
            }],
            result_type: alias_ref,
            source: source(),
        }),
        source: source(),
    });

    program
        .verify()
        .expect("canonical aliases are valid constant-expression result types");
}

#[test]
fn rejects_a_non_equivalent_constant_expression_stack_result() {
    let mut program = valid_program();
    let any = reference_type(true, HeapType::Any);
    let eq = reference_type(true, HeapType::Eq);
    program.globals.push(Global {
        ty: GlobalType {
            value: any.clone(),
            mutable: false,
        },
        origin: EntityOrigin::Defined,
        initializer: Some(ConstExpr {
            instructions: vec![ConstInstruction {
                operation: Operation::core(CoreOpcode::RefNull, vec![], vec![eq])
                    .with_immediates(vec![Immediate::HeapType(HeapType::Eq)]),
                source: source(),
            }],
            result_type: any,
            source: source(),
        }),
        source: source(),
    });

    let error = verification_text(&program);
    assert!(error.contains("constant expression leaves"), "{error}");
}

#[test]
fn verifies_equivalent_recursive_types_without_erasing_module_indices() {
    let recursive_ref = |id| {
        StorageType::Value(ValueType::Ref(RefType {
            nullable: true,
            heap: HeapType::Concrete(id),
        }))
    };
    let mut program = Program::new(1);
    program.types = vec![
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Struct(vec![FieldType {
                storage: recursive_ref(TypeId(1)),
                mutable: false,
            }]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Struct(vec![FieldType {
                storage: recursive_ref(TypeId(0)),
                mutable: false,
            }]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: Some(TypeId(0)),
            final_: true,
            supertype: None,
            composite: CompositeType::Struct(vec![FieldType {
                storage: recursive_ref(TypeId(3)),
                mutable: false,
            }]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: Some(TypeId(1)),
            final_: true,
            supertype: None,
            composite: CompositeType::Struct(vec![FieldType {
                storage: recursive_ref(TypeId(2)),
                mutable: false,
            }]),
            source: source(),
        },
    ];
    program.rec_groups = vec![
        RecGroup {
            types: vec![TypeId(0), TypeId(1)],
            source: source(),
        },
        RecGroup {
            types: vec![TypeId(2), TypeId(3)],
            source: source(),
        },
    ];

    program
        .verify()
        .expect("canonically equivalent recursive types are valid");
    assert!(is_nominal_type_subtype(
        &program.types,
        TypeId(0),
        TypeId(2)
    ));
    assert!(is_nominal_type_subtype(
        &program.types,
        TypeId(3),
        TypeId(1)
    ));
    assert!(is_nominal_type_subtype(
        &program.types,
        TypeId(2),
        TypeId(0)
    ));
}

#[test]
fn rejects_invalid_canonical_type_equivalence_claims() {
    let verify_alias = |alias, composite| {
        let mut program = valid_program();
        program.types.push(TypeDefinition {
            canonical_alias: alias,
            final_: true,
            supertype: None,
            composite,
            source: source(),
        });
        program.rec_groups.push(RecGroup {
            types: vec![TypeId(1)],
            source: source(),
        });
        verification_text(&program)
    };

    let missing = verify_alias(
        Some(TypeId(99)),
        CompositeType::Function(FunctionType {
            params: vec![],
            results: vec![ValueType::I32],
        }),
    );
    assert!(
        missing.contains("missing canonical representative type99"),
        "{missing}"
    );

    let mismatch = verify_alias(Some(TypeId(0)), CompositeType::Struct(vec![]));
    assert!(
        mismatch.contains("does not match canonical representative type0 structurally"),
        "{mismatch}"
    );

    let mut chained = valid_program();
    let equivalent = chained.types[0].composite.clone();
    chained.types.push(TypeDefinition {
        canonical_alias: Some(TypeId(2)),
        final_: true,
        supertype: None,
        composite: equivalent.clone(),
        source: source(),
    });
    chained.types.push(TypeDefinition {
        canonical_alias: Some(TypeId(1)),
        final_: true,
        supertype: None,
        composite: equivalent,
        source: source(),
    });
    chained.rec_groups.extend([
        RecGroup {
            types: vec![TypeId(1)],
            source: source(),
        },
        RecGroup {
            types: vec![TypeId(2)],
            source: source(),
        },
    ]);
    let error = verification_text(&chained);
    assert!(error.contains("is not an earlier module type"), "{error}");
    assert!(error.contains("does not name a representative"), "{error}");

    let mut mixed_group = valid_program();
    let equivalent = mixed_group.types[0].composite.clone();
    mixed_group.types.extend([
        TypeDefinition {
            canonical_alias: Some(TypeId(0)),
            final_: true,
            supertype: None,
            composite: equivalent,
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
    ]);
    mixed_group.rec_groups.push(RecGroup {
        types: vec![TypeId(1), TypeId(2)],
        source: source(),
    });
    let error = verification_text(&mixed_group);
    assert!(
        error.contains("mixes canonical aliases with new type representatives"),
        "{error}"
    );
}

#[test]
fn verifies_a_well_typed_single_block_function() {
    valid_program().verify().expect("valid SSA CFG");
}

#[test]
fn verifies_reference_refinements_as_conditional_edge_facts() {
    valid_null_edge_refinement_program()
        .verify()
        .expect("valid ref.is_null false-edge refinement");
    valid_cast_edge_refinement_program()
        .verify()
        .expect("valid ref.test refinements on both outcomes");
}

#[test]
fn rejects_conditional_refinements_on_unconditional_edges() {
    let mut program = valid_null_edge_refinement_program();
    let body = program.functions[0].body.as_mut().expect("defined body");
    let TerminatorKind::Branch { else_edge, .. } = &body.blocks[0].terminator.kind else {
        unreachable!()
    };
    body.blocks[0].terminator = Terminator::new(TerminatorKind::Jump(else_edge.clone()), source());

    let error = verification_text(&program);
    assert!(
        error.contains("carries conditional refinements on a non-branch edge"),
        "{error}"
    );
}

#[test]
fn rejects_duplicate_unsorted_and_out_of_range_refined_argument_slots() {
    let mut program = valid_null_edge_refinement_program();
    let body = program.functions[0].body.as_mut().expect("defined body");
    let TerminatorKind::Branch { else_edge, .. } = &mut body.blocks[0].terminator.kind else {
        unreachable!()
    };
    let proven = else_edge.refinements[0].proven.clone();
    else_edge.refinements = [1, 0, 0]
        .into_iter()
        .map(|slot| Refinement {
            slot,
            proven: proven.clone(),
        })
        .collect();

    let error = verification_text(&program);
    assert!(error.contains("argument slot 0 more than once"), "{error}");
    assert!(
        error.contains("refined argument slots are not strictly increasing"),
        "{error}"
    );
    assert!(error.contains("refines missing argument slot 1"), "{error}");
}

#[test]
fn rejects_non_null_refinement_on_the_true_ref_is_null_edge() {
    let mut program = valid_null_edge_refinement_program();
    let body = program.functions[0].body.as_mut().expect("defined body");
    let TerminatorKind::Branch {
        then_edge,
        else_edge,
        ..
    } = &mut body.blocks[0].terminator.kind
    else {
        unreachable!()
    };
    *then_edge = Edge::new(BlockId(2), vec![ValueId(0)])
        .with_refinement(0, reference_type(false, HeapType::Extern));
    *else_edge = Edge::new(BlockId(1), vec![]);

    let error = verification_text(&program);
    assert!(
        error.contains("true edge of ref.is_null does not prove non-nullness"),
        "{error}"
    );
}

#[test]
fn rejects_a_refinement_not_tied_to_the_predicate_operand() {
    let mut program = valid_null_edge_refinement_program();
    let body = program.functions[0].body.as_mut().expect("defined body");
    let TerminatorKind::Branch { else_edge, .. } = &mut body.blocks[0].terminator.kind else {
        unreachable!()
    };
    else_edge.arguments[0] = ValueId(1);

    let error = verification_text(&program);
    assert!(
        error.contains("does not test the refined argument"),
        "{error}"
    );
}

#[test]
fn rejects_a_refinement_from_an_unrecognized_branch_predicate() {
    let mut program = valid_null_edge_refinement_program();
    let body = program.functions[0].body.as_mut().expect("defined body");
    body.blocks[0].instructions[1].operation = Operation::core(
        CoreOpcode::I32Eqz,
        vec![reference_type(true, HeapType::Extern)],
        vec![ValueType::I32],
    );

    let error = verification_text(&program);
    assert!(
        error.contains("is not produced by ref.is_null or ref.test"),
        "{error}"
    );
}

#[test]
fn rejects_forged_ref_test_predicate_schemas() {
    let mut missing_immediate = valid_cast_edge_refinement_program();
    missing_immediate.functions[0]
        .body
        .as_mut()
        .expect("defined body")
        .blocks[0]
        .instructions[1]
        .operation
        .immediates
        .clear();
    let error = verification_text(&missing_immediate);
    assert!(
        error.contains("does not have exactly one heap-type immediate"),
        "{error}"
    );

    let mut wrong_result = valid_cast_edge_refinement_program();
    wrong_result.functions[0]
        .body
        .as_mut()
        .expect("defined body")
        .blocks[0]
        .instructions[1]
        .operation
        .signature
        .results = vec![ValueType::I64];
    let error = verification_text(&wrong_result);
    assert!(
        error.contains("does not have the exact result signature [i32]"),
        "{error}"
    );

    let mut unrelated_hierarchy = valid_cast_edge_refinement_program();
    unrelated_hierarchy.functions[0]
        .body
        .as_mut()
        .expect("defined body")
        .blocks[0]
        .instructions[1]
        .operation
        .signature
        .params = vec![reference_type(true, HeapType::Extern)];
    let error = verification_text(&unrelated_hierarchy);
    assert!(
        error.contains("is not a subtype of declared input"),
        "{error}"
    );
}

#[test]
fn rejects_a_target_parameter_narrower_than_the_proven_path_type() {
    let mut program = valid_cast_edge_refinement_program();
    program.functions[0]
        .body
        .as_mut()
        .expect("defined body")
        .blocks[2]
        .parameters[0]
        .ty = reference_type(false, HeapType::Eq);

    let error = verification_text(&program);
    assert!(
        error.contains(
            "is proven as (ref any), which is not a subtype of target parameter (ref eq)"
        ),
        "{error}"
    );
}

#[test]
fn verifies_a_diamond_using_typed_block_parameters() {
    let entry = block(
        BlockId(0),
        vec![],
        vec![
            constant(InstructionId(0), ValueId(0), 1),
            constant(InstructionId(1), ValueId(1), 7),
        ],
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: Edge::new(BlockId(1), vec![ValueId(1)]),
            else_edge: Edge::new(BlockId(2), vec![ValueId(1)]),
        },
    );
    let then_block = block(
        BlockId(1),
        vec![ValueDefinition::new(ValueId(2), ValueType::I32)],
        vec![],
        TerminatorKind::Jump(Edge::new(BlockId(3), vec![ValueId(2)])),
    );
    let else_block = block(
        BlockId(2),
        vec![ValueDefinition::new(ValueId(3), ValueType::I32)],
        vec![],
        TerminatorKind::Jump(Edge::new(BlockId(3), vec![ValueId(3)])),
    );
    let merge = block(
        BlockId(3),
        vec![ValueDefinition::new(ValueId(4), ValueType::I32)],
        vec![],
        TerminatorKind::Return {
            values: vec![ValueId(4)],
        },
    );
    program_with_blocks(
        vec![ValueType::I32],
        vec![entry, then_block, else_block, merge],
    )
    .verify()
    .expect("valid diamond");
}

#[test]
fn verifies_a_loop_with_a_loop_carried_block_parameter() {
    let entry = block(
        BlockId(0),
        vec![],
        vec![constant(InstructionId(0), ValueId(0), 0)],
        TerminatorKind::Jump(Edge::new(BlockId(1), vec![ValueId(0)])),
    );
    let loop_block = block(
        BlockId(1),
        vec![ValueDefinition::new(ValueId(1), ValueType::I32)],
        vec![constant(InstructionId(1), ValueId(2), 1)],
        TerminatorKind::Branch {
            condition: ValueId(2),
            then_edge: Edge::new(BlockId(1), vec![ValueId(1)]),
            else_edge: Edge::new(BlockId(2), vec![ValueId(1)]),
        },
    );
    let exit = block(
        BlockId(2),
        vec![ValueDefinition::new(ValueId(3), ValueType::I32)],
        vec![],
        TerminatorKind::Return {
            values: vec![ValueId(3)],
        },
    );
    program_with_blocks(vec![ValueType::I32], vec![entry, loop_block, exit])
        .verify()
        .expect("valid loop");
}

#[test]
fn rejects_an_undefined_value() {
    let mut program = valid_program();
    program.functions[0].body.as_mut().unwrap().blocks[0].terminator =
        Terminator::return_(vec![ValueId(99)], source());
    assert!(verification_text(&program).contains("use of undefined %99"));
}

#[test]
fn rejects_a_same_block_use_before_definition() {
    let use_before_definition = Instruction::new(
        InstructionId(0),
        operation("identity", vec![ValueType::I32], vec![ValueType::I32]),
        vec![ValueId(1)],
        vec![ValueDefinition::new(ValueId(0), ValueType::I32)],
        source(),
    );
    let program = program_with_blocks(
        vec![ValueType::I32],
        vec![block(
            BlockId(0),
            vec![],
            vec![
                use_before_definition,
                constant(InstructionId(1), ValueId(1), 1),
            ],
            TerminatorKind::Return {
                values: vec![ValueId(0)],
            },
        )],
    );
    assert!(verification_text(&program).contains("%1 is used before its definition"));
}

#[test]
fn rejects_a_non_dominating_definition() {
    let entry = block(
        BlockId(0),
        vec![],
        vec![constant(InstructionId(0), ValueId(0), 1)],
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: Edge::new(BlockId(1), vec![]),
            else_edge: Edge::new(BlockId(2), vec![]),
        },
    );
    let then_block = block(
        BlockId(1),
        vec![],
        vec![constant(InstructionId(1), ValueId(1), 7)],
        TerminatorKind::Jump(Edge::new(BlockId(3), vec![])),
    );
    let else_block = block(
        BlockId(2),
        vec![],
        vec![],
        TerminatorKind::Jump(Edge::new(BlockId(3), vec![])),
    );
    let merge = block(
        BlockId(3),
        vec![],
        vec![],
        TerminatorKind::Return {
            values: vec![ValueId(1)],
        },
    );
    let program = program_with_blocks(
        vec![ValueType::I32],
        vec![entry, then_block, else_block, merge],
    );
    assert!(verification_text(&program).contains("does not dominate"));
}

#[test]
fn rejects_wrong_edge_arity() {
    let entry = block(
        BlockId(0),
        vec![],
        vec![],
        TerminatorKind::Jump(Edge::new(BlockId(1), vec![])),
    );
    let exit = block(
        BlockId(1),
        vec![ValueDefinition::new(ValueId(0), ValueType::I32)],
        vec![],
        TerminatorKind::Return {
            values: vec![ValueId(0)],
        },
    );
    let program = program_with_blocks(vec![ValueType::I32], vec![entry, exit]);
    assert!(verification_text(&program).contains("edge to block1 supplies 0 values, expected 1"));
}

#[test]
fn rejects_wrong_edge_argument_type() {
    let entry = block(
        BlockId(0),
        vec![],
        vec![constant(InstructionId(0), ValueId(0), 1)],
        TerminatorKind::Jump(Edge::new(BlockId(1), vec![ValueId(0)])),
    );
    let exit = block(
        BlockId(1),
        vec![ValueDefinition::new(ValueId(1), ValueType::I64)],
        vec![],
        TerminatorKind::Return { values: vec![] },
    );
    let program = program_with_blocks(vec![], vec![entry, exit]);
    assert!(verification_text(&program).contains("edge to block1 uses %0 as i32, expected i64"));
}

#[test]
fn rejects_wrong_return_type() {
    let program = program_with_blocks(
        vec![ValueType::I64],
        vec![block(
            BlockId(0),
            vec![],
            vec![constant(InstructionId(0), ValueId(0), 42)],
            TerminatorKind::Return {
                values: vec![ValueId(0)],
            },
        )],
    );
    assert!(verification_text(&program).contains("return uses %0 as i32, expected i64"));
}

#[test]
fn rejects_an_invalid_region_reference() {
    let mut program = valid_program();
    program.functions[0].body.as_mut().unwrap().blocks[0].region = RegionId(99);
    assert!(verification_text(&program).contains("references missing region99"));
}

#[test]
fn rejects_a_reversed_source_span() {
    let mut program = valid_program();
    program.source = SourceInfo {
        byte_span: Some(ByteSpan::new(9, 2)),
        ordinal: None,
    };
    assert!(verification_text(&program).contains("reversed byte span 9..2"));
}

#[test]
fn rejects_an_instruction_result_type_mismatch() {
    let mut program = valid_program();
    program.functions[0].body.as_mut().unwrap().blocks[0].instructions[0].results[0].ty =
        ValueType::I64;
    assert!(verification_text(&program).contains("defines %0 as i64, expected i32"));
}

#[test]
fn accepts_reference_subtypes_at_typed_uses() {
    let funcref = ValueType::Ref(RefType {
        nullable: true,
        heap: HeapType::Func,
    });
    let concrete = ValueType::Ref(RefType {
        nullable: false,
        heap: HeapType::Concrete(TypeId(0)),
    });
    let reference = Instruction::new(
        InstructionId(0),
        operation("ref.func", vec![], vec![concrete.clone()])
            .with_immediates(vec![Immediate::Function(FunctionId(0))]),
        vec![],
        vec![ValueDefinition::new(ValueId(0), concrete)],
        source(),
    );
    let program = program_with_blocks(
        vec![funcref],
        vec![block(
            BlockId(0),
            vec![],
            vec![reference],
            TerminatorKind::Return {
                values: vec![ValueId(0)],
            },
        )],
    );

    program
        .verify()
        .expect("concrete function ref is a funcref");
}

#[test]
fn rejects_nullable_reference_where_non_null_is_required() {
    let nullable = ValueType::Ref(RefType {
        nullable: true,
        heap: HeapType::Func,
    });
    let non_null = ValueType::Ref(RefType {
        nullable: false,
        heap: HeapType::Func,
    });
    let reference = Instruction::new(
        InstructionId(0),
        operation("ref.null func", vec![], vec![nullable.clone()]),
        vec![],
        vec![ValueDefinition::new(ValueId(0), nullable)],
        source(),
    );
    let program = program_with_blocks(
        vec![non_null],
        vec![block(
            BlockId(0),
            vec![],
            vec![reference],
            TerminatorKind::Return {
                values: vec![ValueId(0)],
            },
        )],
    );

    let error = verification_text(&program);
    assert!(
        error.contains("return uses %0 as (ref null func)"),
        "{error}"
    );
}

#[test]
fn rejects_legacy_path_independent_reference_refinement_instructions() {
    let input = ValueType::Ref(RefType {
        nullable: true,
        heap: HeapType::Extern,
    });
    let invalid_result = ValueType::Ref(RefType {
        nullable: false,
        heap: HeapType::Func,
    });
    let reference = Instruction::new(
        InstructionId(0),
        Operation::core(CoreOpcode::RefNull, vec![], vec![input.clone()])
            .with_immediates(vec![Immediate::HeapType(HeapType::Extern)]),
        vec![],
        vec![ValueDefinition::new(ValueId(0), input.clone())],
        source(),
    );
    let refinement = Instruction::new(
        InstructionId(1),
        Operation::synthetic(
            "wedge.refine_reference",
            vec![input],
            vec![invalid_result.clone()],
        ),
        vec![ValueId(0)],
        vec![ValueDefinition::new(ValueId(1), invalid_result.clone())],
        source(),
    );
    let program = program_with_blocks(
        vec![invalid_result],
        vec![block(
            BlockId(0),
            vec![],
            vec![reference, refinement],
            TerminatorKind::Return {
                values: vec![ValueId(1)],
            },
        )],
    );

    let error = verification_text(&program);
    assert!(
        error.contains("uses obsolete path-independent reference refinement"),
        "{error}"
    );
}

#[test]
fn distinguishes_precise_const_expr_results_from_contextual_types() {
    let mut program = valid_program();
    let funcref = RefType {
        nullable: true,
        heap: HeapType::Func,
    };
    let concrete = ValueType::Ref(RefType {
        nullable: false,
        heap: HeapType::Concrete(TypeId(0)),
    });
    program.tables.push(Table {
        ty: TableType {
            element: funcref.clone(),
            limits: Limits {
                min: 1,
                max: Some(1),
            },
            address_type: AddressType::I32,
        },
        origin: EntityOrigin::Defined,
        initializer: Some(ConstExpr {
            instructions: vec![ConstInstruction {
                operation: operation("ref.func", vec![], vec![concrete.clone()])
                    .with_immediates(vec![Immediate::Function(FunctionId(0))]),
                source: source(),
            }],
            result_type: concrete,
            source: source(),
        }),
        source: source(),
    });

    program
        .verify()
        .expect("constant expression stack result may refine its context");

    program.tables[0]
        .initializer
        .as_mut()
        .expect("table initializer")
        .result_type = ValueType::Ref(funcref);
    let error = verification_text(&program);
    assert!(error.contains("constant expression leaves"), "{error}");
}

#[test]
fn rejects_a_non_constant_operator_in_a_constant_expression() {
    let mut program = valid_program();
    program.globals.push(Global {
        ty: GlobalType {
            value: ValueType::I32,
            mutable: false,
        },
        origin: EntityOrigin::Defined,
        initializer: Some(ConstExpr {
            instructions: vec![
                ConstInstruction {
                    operation: Operation::core(CoreOpcode::I32Const, vec![], vec![ValueType::I32])
                        .with_immediates(vec![Immediate::S32(1)]),
                    source: source(),
                },
                ConstInstruction {
                    operation: Operation::core(
                        CoreOpcode::I32Clz,
                        vec![ValueType::I32],
                        vec![ValueType::I32],
                    ),
                    source: source(),
                },
            ],
            result_type: ValueType::I32,
            source: source(),
        }),
        source: source(),
    });

    let error = verification_text(&program);
    assert!(
        error.contains("constant expression contains non-constant operation i32.clz"),
        "{error}"
    );
}

#[test]
fn constant_global_get_requires_a_prior_immutable_global() {
    let mut program = valid_program();
    program.globals.push(Global {
        ty: GlobalType {
            value: ValueType::I32,
            mutable: false,
        },
        origin: EntityOrigin::Defined,
        initializer: Some(ConstExpr {
            instructions: vec![ConstInstruction {
                operation: Operation::core(CoreOpcode::GlobalGet, vec![], vec![ValueType::I32])
                    .with_immediates(vec![Immediate::Global(GlobalId(0))]),
                source: source(),
            }],
            result_type: ValueType::I32,
            source: source(),
        }),
        source: source(),
    });

    let error = verification_text(&program);
    assert!(
        error.contains("global.get must reference exactly one prior immutable global"),
        "{error}"
    );

    program.globals[0].initializer = Some(ConstExpr {
        instructions: vec![ConstInstruction {
            operation: Operation::core(CoreOpcode::I32Const, vec![], vec![ValueType::I32])
                .with_immediates(vec![Immediate::S32(7)]),
            source: source(),
        }],
        result_type: ValueType::I32,
        source: source(),
    });
    program.globals.push(Global {
        ty: GlobalType {
            value: ValueType::I32,
            mutable: false,
        },
        origin: EntityOrigin::Defined,
        initializer: Some(ConstExpr {
            instructions: vec![ConstInstruction {
                operation: Operation::core(CoreOpcode::GlobalGet, vec![], vec![ValueType::I32])
                    .with_immediates(vec![Immediate::Global(GlobalId(0))]),
                source: source(),
            }],
            result_type: ValueType::I32,
            source: source(),
        }),
        source: source(),
    });
    program
        .verify()
        .expect("a later initializer may read a prior immutable global");
}

#[test]
fn rejects_forged_constant_operator_schemas() {
    fn initializer(instructions: Vec<Operation>, result_type: ValueType) -> ConstExpr {
        ConstExpr {
            instructions: instructions
                .into_iter()
                .map(|operation| ConstInstruction {
                    operation,
                    source: source(),
                })
                .collect(),
            result_type,
            source: source(),
        }
    }

    fn defined_global(value: ValueType, initializer: ConstExpr) -> Global {
        Global {
            ty: GlobalType {
                value,
                mutable: false,
            },
            origin: EntityOrigin::Defined,
            initializer: Some(initializer),
            source: source(),
        }
    }

    fn concrete_ref(ty: TypeId) -> ValueType {
        ValueType::Ref(RefType {
            nullable: false,
            heap: HeapType::Concrete(ty),
        })
    }

    let mut program = valid_program();
    program.types.extend([
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Struct(vec![FieldType {
                storage: StorageType::Value(ValueType::I64),
                mutable: false,
            }]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Struct(vec![FieldType {
                storage: StorageType::Value(concrete_ref(TypeId(0))),
                mutable: false,
            }]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Array(FieldType {
                storage: StorageType::Value(ValueType::I32),
                mutable: true,
            }),
            source: source(),
        },
    ]);
    program.rec_groups.extend([
        RecGroup {
            types: vec![TypeId(1)],
            source: source(),
        },
        RecGroup {
            types: vec![TypeId(2)],
            source: source(),
        },
        RecGroup {
            types: vec![TypeId(3)],
            source: source(),
        },
    ]);

    program.globals.extend([
        defined_global(
            ValueType::I64,
            initializer(
                vec![
                    Operation::core(CoreOpcode::I64Const, vec![], vec![ValueType::I64])
                        .with_immediates(vec![Immediate::S64(4)]),
                ],
                ValueType::I64,
            ),
        ),
        // The immediate names an i64 global, but the self-declared operation
        // signature lies and lets the surrounding stack check see i32.
        defined_global(
            ValueType::I32,
            initializer(
                vec![
                    Operation::core(CoreOpcode::GlobalGet, vec![], vec![ValueType::I32])
                        .with_immediates(vec![Immediate::Global(GlobalId(0))]),
                ],
                ValueType::I32,
            ),
        ),
        // The named struct field is i64, not the operation's claimed i32.
        defined_global(
            concrete_ref(TypeId(1)),
            initializer(
                vec![
                    Operation::core(CoreOpcode::I32Const, vec![], vec![ValueType::I32])
                        .with_immediates(vec![Immediate::S32(1)]),
                    Operation::core(
                        CoreOpcode::StructNew,
                        vec![ValueType::I32],
                        vec![concrete_ref(TypeId(1))],
                    )
                    .with_immediates(vec![Immediate::Type(TypeId(1))]),
                ],
                concrete_ref(TypeId(1)),
            ),
        ),
        // Default construction is invalid for a non-null reference field.
        defined_global(
            concrete_ref(TypeId(2)),
            initializer(
                vec![
                    Operation::core(
                        CoreOpcode::StructNewDefault,
                        vec![],
                        vec![concrete_ref(TypeId(2))],
                    )
                    .with_immediates(vec![Immediate::Type(TypeId(2))]),
                ],
                concrete_ref(TypeId(2)),
            ),
        ),
        // The immediate requests two fixed elements, but the signature claims
        // and consumes only one.
        defined_global(
            concrete_ref(TypeId(3)),
            initializer(
                vec![
                    Operation::core(CoreOpcode::I32Const, vec![], vec![ValueType::I32])
                        .with_immediates(vec![Immediate::S32(2)]),
                    Operation::core(
                        CoreOpcode::ArrayNewFixed,
                        vec![ValueType::I32],
                        vec![concrete_ref(TypeId(3))],
                    )
                    .with_immediates(vec![Immediate::Type(TypeId(3)), Immediate::U32(2)]),
                ],
                concrete_ref(TypeId(3)),
            ),
        ),
        // Reference conversions preserve operand nullability.
        defined_global(
            ValueType::Ref(RefType {
                nullable: false,
                heap: HeapType::Any,
            }),
            initializer(
                vec![
                    Operation::core(
                        CoreOpcode::RefNull,
                        vec![],
                        vec![ValueType::Ref(RefType {
                            nullable: true,
                            heap: HeapType::Extern,
                        })],
                    )
                    .with_immediates(vec![Immediate::HeapType(HeapType::Extern)]),
                    Operation::core(
                        CoreOpcode::AnyConvertExtern,
                        vec![ValueType::Ref(RefType {
                            nullable: true,
                            heap: HeapType::Extern,
                        })],
                        vec![ValueType::Ref(RefType {
                            nullable: false,
                            heap: HeapType::Any,
                        })],
                    ),
                ],
                ValueType::Ref(RefType {
                    nullable: false,
                    heap: HeapType::Any,
                }),
            ),
        ),
    ]);

    let error = verification_text(&program);
    for opcode in [
        "global.get",
        "struct.new",
        "struct.new_default",
        "array.new_fixed",
        "any.convert_extern",
    ] {
        assert!(
            error.contains(&format!("invalid Core schema: Core operator {opcode}")),
            "missing {opcode} schema diagnostic:\n{error}"
        );
    }
}

#[test]
fn rejects_a_supertype_cycle() {
    let mut program = valid_program();
    program.types.extend([
        TypeDefinition {
            canonical_alias: None,
            final_: false,
            supertype: Some(TypeId(2)),
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: false,
            supertype: Some(TypeId(1)),
            composite: CompositeType::Struct(vec![]),
            source: source(),
        },
    ]);
    program.rec_groups.push(RecGroup {
        types: vec![TypeId(1), TypeId(2)],
        source: source(),
    });

    let error = verification_text(&program);
    assert!(
        error.contains("supertype cycle: type1 -> type2 -> type1"),
        "{error}"
    );
}

#[test]
fn call_ref_requires_a_subtype_of_its_concrete_function_type() {
    let externref = ValueType::Ref(RefType {
        nullable: true,
        heap: HeapType::Extern,
    });
    let reference = Instruction::new(
        InstructionId(0),
        operation("ref.null extern", vec![], vec![externref.clone()]),
        vec![],
        vec![ValueDefinition::new(ValueId(0), externref)],
        source(),
    );
    let program = program_with_blocks(
        vec![],
        vec![block(
            BlockId(0),
            vec![],
            vec![reference],
            TerminatorKind::TailCall {
                callee: Callee::Reference {
                    ty: TypeId(0),
                    reference: ValueId(0),
                },
                arguments: vec![],
            },
        )],
    );

    let error = verification_text(&program);
    assert!(error.contains("call_ref callee %0 has type"), "{error}");
}

#[test]
fn call_ref_accepts_a_nominal_function_subtype() {
    let concrete_subtype = ValueType::Ref(RefType {
        nullable: false,
        heap: HeapType::Concrete(TypeId(1)),
    });
    let reference = Instruction::new(
        InstructionId(0),
        operation("ref.func", vec![], vec![concrete_subtype.clone()])
            .with_immediates(vec![Immediate::Function(FunctionId(0))]),
        vec![],
        vec![ValueDefinition::new(ValueId(0), concrete_subtype)],
        source(),
    );
    let mut program = program_with_blocks(
        vec![],
        vec![block(
            BlockId(0),
            vec![],
            vec![reference],
            TerminatorKind::TailCall {
                callee: Callee::Reference {
                    ty: TypeId(0),
                    reference: ValueId(0),
                },
                arguments: vec![],
            },
        )],
    );
    program.types[0].final_ = false;
    program.types.push(TypeDefinition {
        canonical_alias: None,
        final_: true,
        supertype: Some(TypeId(0)),
        composite: CompositeType::Function(FunctionType::default()),
        source: source(),
    });
    program.rec_groups.push(RecGroup {
        types: vec![TypeId(1)],
        source: source(),
    });
    // `ref.func` names the containing function itself, whose nominal type is
    // the subtype while the tail call expects its declared supertype.
    program.functions[0].ty = TypeId(1);

    program.verify().expect("nominal call_ref subtype");
}

#[test]
fn throw_ref_requires_an_exception_reference() {
    let externref = ValueType::Ref(RefType {
        nullable: true,
        heap: HeapType::Extern,
    });
    let reference = Instruction::new(
        InstructionId(0),
        operation("ref.null extern", vec![], vec![externref.clone()]),
        vec![],
        vec![ValueDefinition::new(ValueId(0), externref)],
        source(),
    );
    let program = program_with_blocks(
        vec![],
        vec![block(
            BlockId(0),
            vec![],
            vec![reference],
            TerminatorKind::ThrowRef {
                exception: ValueId(0),
            },
        )],
    );

    let error = verification_text(&program);
    assert!(error.contains("throw_ref operand %0 has type"), "{error}");
}

#[test]
fn printer_is_deterministic_and_has_a_stable_text_form() {
    let program = valid_program();
    let first = program.to_string();
    let second = program.to_string();
    assert_eq!(first, second);
    assert_eq!(
        first,
        concat!(
            "wedge.module binary-version=1 language=wasm-3.0 {\n",
            "  rec rec0 = [type0]\n",
            "  type type0 = final func (result i32)\n",
            "  func func0 wasm-index=0 : type0 defined {\n",
            "    cfg entry=block0 root=region0\n",
            "    region region0 function parent=- entry=block0\n",
            "    block0() [region0]:\n",
            "      %0: i32 = i32.const<s32=42>() ; inst0\n",
            "      return %0\n",
            "  }\n",
            "}\n",
        )
    );
}

#[test]
fn accepts_a_refinement_justified_by_a_hoisted_predicate() {
    let mut program = valid_null_edge_refinement_program();
    let body = program.functions[0].body.as_mut().expect("defined body");
    let hoisted = std::mem::take(&mut body.blocks[0].instructions);
    body.blocks.push(block(
        BlockId(3),
        vec![],
        hoisted,
        TerminatorKind::Jump(Edge::new(BlockId(0), vec![])),
    ));
    body.entry = BlockId(3);
    body.regions[0].entry = BlockId(3);
    program
        .verify()
        .expect("a predicate in a dominating block still justifies the refinement");
}

#[test]
fn rejects_a_refinement_whose_predicate_does_not_dominate_the_branch() {
    let mut program = valid_null_edge_refinement_program();
    let body = program.functions[0].body.as_mut().expect("defined body");
    let predicate = body.blocks[0].instructions.remove(1);
    body.blocks[1].instructions.push(predicate);

    let error = verification_text(&program);
    assert!(error.contains("does not dominate"), "{error}");
}

#[test]
fn accepts_a_stored_refinement_weaker_than_the_predicate_proves() {
    let mut program = valid_cast_edge_refinement_program();
    let body = program.functions[0].body.as_mut().expect("defined body");
    let TerminatorKind::Branch { then_edge, .. } = &mut body.blocks[0].terminator.kind else {
        unreachable!()
    };
    then_edge.refinements[0].proven = reference_type(true, HeapType::Any);
    body.blocks[1].parameters[0].ty = reference_type(true, HeapType::Any);
    program
        .verify()
        .expect("a proven fact may be stored at a supertype");
}

#[test]
fn rejects_a_stored_refinement_stronger_than_the_predicate_proves() {
    let mut program = valid_cast_edge_refinement_program();
    let body = program.functions[0].body.as_mut().expect("defined body");
    let TerminatorKind::Branch { then_edge, .. } = &mut body.blocks[0].terminator.kind else {
        unreachable!()
    };
    then_edge.refinements[0].proven = reference_type(false, HeapType::Eq);
    body.blocks[1].parameters[0].ty = reference_type(false, HeapType::Eq);

    let error = verification_text(&program);
    assert!(
        error.contains("claims (ref eq), but its predicate only proves (ref null eq)"),
        "{error}"
    );
}
