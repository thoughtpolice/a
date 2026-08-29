// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Contract tests for Wedge's milestone-1 owned IR.
//!
//! Keep these builders deliberately explicit. They serve as executable examples
//! of the invariants that later frontend and optimization passes must preserve.

use wedge::ir::*;
use wedge::opcode::CoreOpcode;

fn synthetic() -> SourceInfo {
    SourceInfo::synthetic()
}

fn function_type(params: Vec<ValueType>, results: Vec<ValueType>) -> FunctionType {
    FunctionType { params, results }
}

fn root_region(entry: BlockId) -> Region {
    Region {
        id: RegionId(0),
        parent: None,
        kind: RegionKind::Function,
        entry,
        source: synthetic(),
    }
}

fn return_block(
    id: BlockId,
    region: RegionId,
    parameters: Vec<ValueDefinition>,
    values: Vec<ValueId>,
) -> Block {
    Block {
        id,
        region,
        parameters,
        instructions: Vec::new(),
        terminator: Terminator::return_(values, synthetic()),
        source: synthetic(),
    }
}

fn body(blocks: Vec<Block>, regions: Vec<Region>) -> FunctionBody {
    FunctionBody {
        entry: BlockId(0),
        root_region: RegionId(0),
        blocks,
        regions,
    }
}

fn module_with_function(signature: FunctionType, body: FunctionBody) -> Program {
    let locals = signature.params.clone();
    let mut module = Program::new(1);
    module.rec_groups.push(RecGroup {
        types: vec![TypeId(0)],
        source: synthetic(),
    });
    module.types.push(TypeDefinition {
        canonical_alias: None,
        final_: true,
        supertype: None,
        composite: CompositeType::Function(signature),
        source: synthetic(),
    });
    module.functions.push(Function {
        wasm_index: 0,
        ty: TypeId(0),
        origin: EntityOrigin::Defined,
        locals,
        body: Some(body),
        source: synthetic(),
    });
    module
}

fn minimal_module() -> Program {
    module_with_function(
        function_type(vec![], vec![]),
        body(
            vec![return_block(BlockId(0), RegionId(0), vec![], vec![])],
            vec![root_region(BlockId(0))],
        ),
    )
}

fn i32_const(instruction: u32, value: u32, immediate: i32) -> Instruction {
    Instruction::new(
        InstructionId(instruction),
        Operation::new("i32.const", vec![], vec![ValueType::I32])
            .with_immediates(vec![Immediate::S32(immediate)]),
        vec![],
        vec![ValueDefinition::new(ValueId(value), ValueType::I32)],
        synthetic(),
    )
}

fn i64_const(instruction: u32, value: u32, immediate: i64) -> Instruction {
    Instruction::new(
        InstructionId(instruction),
        Operation::new("i64.const", vec![], vec![ValueType::I64])
            .with_immediates(vec![Immediate::S64(immediate)]),
        vec![],
        vec![ValueDefinition::new(ValueId(value), ValueType::I64)],
        synthetic(),
    )
}

fn typed_return_module() -> Program {
    let mut entry = return_block(BlockId(0), RegionId(0), vec![], vec![ValueId(0)]);
    entry.instructions.push(i32_const(0, 0, 42));
    module_with_function(
        function_type(vec![], vec![ValueType::I32]),
        body(vec![entry], vec![root_region(BlockId(0))]),
    )
}

fn parameterized_module() -> Program {
    module_with_function(
        function_type(vec![ValueType::I32, ValueType::I64], vec![ValueType::I32]),
        body(
            vec![return_block(
                BlockId(0),
                RegionId(0),
                vec![
                    ValueDefinition::new(ValueId(0), ValueType::I32),
                    ValueDefinition::new(ValueId(1), ValueType::I64),
                ],
                vec![ValueId(0)],
            )],
            vec![root_region(BlockId(0))],
        ),
    )
}

fn diamond_module() -> Program {
    let mut entry = return_block(BlockId(0), RegionId(0), vec![], vec![]);
    entry.instructions.push(i32_const(0, 0, 1));
    entry.terminator = Terminator::new(
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: Edge::new(BlockId(1), vec![]),
            else_edge: Edge::new(BlockId(2), vec![]),
        },
        synthetic(),
    );

    let mut then_block = return_block(BlockId(1), RegionId(0), vec![], vec![]);
    then_block.instructions.push(i32_const(1, 1, 11));
    then_block.terminator = Terminator::new(
        TerminatorKind::Jump(Edge::new(BlockId(3), vec![ValueId(1)])),
        synthetic(),
    );

    let mut else_block = return_block(BlockId(2), RegionId(0), vec![], vec![]);
    else_block.instructions.push(i32_const(2, 2, 22));
    else_block.terminator = Terminator::new(
        TerminatorKind::Jump(Edge::new(BlockId(3), vec![ValueId(2)])),
        synthetic(),
    );

    let merge = return_block(
        BlockId(3),
        RegionId(0),
        vec![ValueDefinition::new(ValueId(3), ValueType::I32)],
        vec![ValueId(3)],
    );

    module_with_function(
        function_type(vec![], vec![ValueType::I32]),
        body(
            vec![entry, then_block, else_block, merge],
            vec![root_region(BlockId(0))],
        ),
    )
}

fn loop_module() -> Program {
    let mut entry = return_block(BlockId(0), RegionId(0), vec![], vec![]);
    entry.instructions.push(i32_const(0, 0, 7));
    entry.terminator = Terminator::new(
        TerminatorKind::Jump(Edge::new(BlockId(1), vec![ValueId(0)])),
        synthetic(),
    );

    let mut loop_block = return_block(
        BlockId(1),
        RegionId(1),
        vec![ValueDefinition::new(ValueId(1), ValueType::I32)],
        vec![],
    );
    loop_block.instructions.push(i32_const(1, 2, 0));
    loop_block.terminator = Terminator::new(
        TerminatorKind::Branch {
            condition: ValueId(2),
            then_edge: Edge::new(BlockId(1), vec![ValueId(1)]),
            else_edge: Edge::new(BlockId(2), vec![ValueId(1)]),
        },
        synthetic(),
    );

    let exit = return_block(
        BlockId(2),
        RegionId(0),
        vec![ValueDefinition::new(ValueId(3), ValueType::I32)],
        vec![ValueId(3)],
    );
    let loop_region = Region {
        id: RegionId(1),
        parent: Some(RegionId(0)),
        kind: RegionKind::Loop,
        entry: BlockId(1),
        source: synthetic(),
    };

    module_with_function(
        function_type(vec![], vec![ValueType::I32]),
        body(
            vec![entry, loop_block, exit],
            vec![root_region(BlockId(0)), loop_region],
        ),
    )
}

fn verification_error(module: &Program) -> String {
    module
        .verify()
        .expect_err("malformed test IR unexpectedly verified")
        .to_string()
}

#[test]
fn accepts_minimal_function() {
    minimal_module().verify().unwrap();
}

#[test]
fn accepts_typed_return() {
    typed_return_module().verify().unwrap();
}

#[test]
fn accepts_function_parameters_defined_by_entry_block_parameters() {
    parameterized_module().verify().unwrap();
}

#[test]
fn accepts_region_entry_owned_by_a_nested_region() {
    let mut module = minimal_module();
    let body = module.functions[0].body.as_mut().unwrap();
    body.blocks
        .push(return_block(BlockId(1), RegionId(2), vec![], vec![]));
    body.regions.extend([
        Region {
            id: RegionId(1),
            parent: Some(RegionId(0)),
            kind: RegionKind::Block,
            entry: BlockId(1),
            source: synthetic(),
        },
        Region {
            id: RegionId(2),
            parent: Some(RegionId(1)),
            kind: RegionKind::Block,
            entry: BlockId(1),
            source: synthetic(),
        },
    ]);

    module.verify().unwrap();
}

#[test]
fn accepts_diamond_with_block_parameter_merge() {
    diamond_module().verify().unwrap();
}

#[test]
fn accepts_loop_with_block_parameter_backedge() {
    loop_module().verify().unwrap();
}

#[test]
fn rejects_missing_cfg_identifiers() {
    let mut module = minimal_module();
    let body = module.functions[0].body.as_mut().unwrap();
    body.entry = BlockId(90);
    body.root_region = RegionId(91);
    body.blocks[0].region = RegionId(92);

    let error = verification_error(&module);
    assert!(
        error.contains("entry references missing block90"),
        "{error}"
    );
    assert!(error.contains("missing root region91"), "{error}");
    assert!(error.contains("references missing region92"), "{error}");
}

#[test]
fn rejects_function_entry_parameter_arity_mismatch() {
    let mut module = parameterized_module();
    module.functions[0].body.as_mut().unwrap().blocks[0]
        .parameters
        .pop();

    let error = verification_error(&module);
    assert!(
        error.contains(
            "function entry block0 defines 1 parameters, but the function signature has 2"
        ),
        "{error}"
    );
}

#[test]
fn rejects_extra_function_entry_parameter() {
    let mut module = parameterized_module();
    module.functions[0].body.as_mut().unwrap().blocks[0]
        .parameters
        .push(ValueDefinition::new(ValueId(2), ValueType::F32));

    let error = verification_error(&module);
    assert!(
        error.contains(
            "function entry block0 defines 3 parameters, but the function signature has 2"
        ),
        "{error}"
    );
}

#[test]
fn rejects_function_entry_parameter_type_or_order_mismatch() {
    let mut module = parameterized_module();
    let parameters = &mut module.functions[0].body.as_mut().unwrap().blocks[0].parameters;
    parameters[0].ty = ValueType::I64;
    parameters[1].ty = ValueType::I32;

    let error = verification_error(&module);
    assert!(
        error.contains("function entry block0 parameter 0 is i64, expected i32"),
        "{error}"
    );
    assert!(
        error.contains("function entry block0 parameter 1 is i32, expected i64"),
        "{error}"
    );
}

#[test]
fn rejects_root_region_entry_different_from_function_entry() {
    let mut module = minimal_module();
    let body = module.functions[0].body.as_mut().unwrap();
    body.blocks
        .push(return_block(BlockId(1), RegionId(0), vec![], vec![]));
    body.regions[0].entry = BlockId(1);

    let error = verification_error(&module);
    assert!(
        error.contains("root region0 entry block1 does not match function body entry block0"),
        "{error}"
    );
}

#[test]
fn rejects_cfg_edge_into_function_entry() {
    let mut module = minimal_module();
    let body = module.functions[0].body.as_mut().unwrap();
    let mut predecessor = return_block(BlockId(1), RegionId(0), vec![], vec![]);
    predecessor.terminator = Terminator::new(
        TerminatorKind::Jump(Edge::new(BlockId(0), vec![])),
        synthetic(),
    );
    body.blocks.push(predecessor);

    let error = verification_error(&module);
    assert!(
        error.contains("function entry block0 has an incoming CFG edge from block1"),
        "{error}"
    );
}

#[test]
fn rejects_exceptional_edge_into_function_entry() {
    let mut module = minimal_module();
    let body = module.functions[0].body.as_mut().unwrap();
    let mut predecessor = return_block(BlockId(1), RegionId(1), vec![], vec![]);
    let operation = Operation::new("call", vec![], vec![]);
    predecessor.terminator = Terminator::new(
        TerminatorKind::Invoke {
            effects: wedge::semantics::effects_for_operation(&operation),
            operation,
            operands: vec![],
            normal: Edge::new(BlockId(2), vec![]),
        },
        synthetic(),
    )
    .with_exception_routing(ExceptionRouting {
        arms: vec![ExceptionalEdge::new(RegionId(1), 0, BlockId(0), vec![])],
        escapes: false,
    });
    body.blocks.push(predecessor);
    body.blocks
        .push(return_block(BlockId(2), RegionId(1), vec![], vec![]));
    body.regions.push(Region {
        id: RegionId(1),
        parent: Some(RegionId(0)),
        kind: RegionKind::TryTable {
            catches: vec![CatchClause {
                kind: CatchKind::CatchAll,
                tag: None,
                target: BlockId(0),
            }],
        },
        entry: BlockId(1),
        source: synthetic(),
    });

    let error = verification_error(&module);
    assert!(
        error.contains(
            "function entry block0 has an incoming exceptional edge from block1 terminator"
        ),
        "{error}"
    );
}

#[test]
fn rejects_try_table_catch_edge_into_function_entry() {
    let mut module = minimal_module();
    let body = module.functions[0].body.as_mut().unwrap();
    body.blocks
        .push(return_block(BlockId(1), RegionId(1), vec![], vec![]));
    body.regions.push(Region {
        id: RegionId(1),
        parent: Some(RegionId(0)),
        kind: RegionKind::TryTable {
            catches: vec![CatchClause {
                kind: CatchKind::CatchAll,
                tag: None,
                target: BlockId(0),
            }],
        },
        entry: BlockId(1),
        source: synthetic(),
    });

    let error = verification_error(&module);
    assert!(
        error.contains("function entry block0 has an incoming unwind edge from region1 catch 0"),
        "{error}"
    );
}

#[test]
fn rejects_region_entry_owned_by_an_unrelated_region() {
    let mut module = minimal_module();
    let body = module.functions[0].body.as_mut().unwrap();
    body.blocks
        .push(return_block(BlockId(1), RegionId(2), vec![], vec![]));
    body.regions.extend([
        Region {
            id: RegionId(1),
            parent: Some(RegionId(0)),
            kind: RegionKind::Block,
            entry: BlockId(1),
            source: synthetic(),
        },
        Region {
            id: RegionId(2),
            parent: Some(RegionId(0)),
            kind: RegionKind::Block,
            entry: BlockId(1),
            source: synthetic(),
        },
    ]);

    let error = verification_error(&module);
    assert!(
        error.contains("region1 entry block1 is owned by unrelated region2"),
        "{error}"
    );
}

#[test]
fn rejects_missing_module_entity_identifier() {
    let mut module = minimal_module();
    module.exports.push(Export {
        name: "ghost".into(),
        item: ExportItem::Function(FunctionId(99)),
        source: synthetic(),
    });

    let error = verification_error(&module);
    assert!(
        error.contains("export \"ghost\" references a missing entity"),
        "{error}"
    );
}

#[test]
fn rejects_undefined_operand() {
    let mut module = minimal_module();
    let block = &mut module.functions[0].body.as_mut().unwrap().blocks[0];
    block.instructions.push(Instruction::new(
        InstructionId(0),
        Operation::new("drop", vec![ValueType::I32], vec![]),
        vec![ValueId(404)],
        vec![],
        synthetic(),
    ));

    let error = verification_error(&module);
    assert!(error.contains("use of undefined %404"), "{error}");
}

#[test]
fn rejects_use_before_definition_in_a_block() {
    let mut module = minimal_module();
    let block = &mut module.functions[0].body.as_mut().unwrap().blocks[0];
    block.instructions.push(Instruction::new(
        InstructionId(0),
        Operation::new("drop", vec![ValueType::I32], vec![]),
        vec![ValueId(1)],
        vec![],
        synthetic(),
    ));
    block.instructions.push(i32_const(1, 1, 7));

    let error = verification_error(&module);
    assert!(
        error.contains("%1 is used before its definition"),
        "{error}"
    );
}

#[test]
fn rejects_non_dominating_value_use() {
    let mut module = diamond_module();
    let merge = &mut module.functions[0].body.as_mut().unwrap().blocks[3];
    merge.parameters.clear();
    merge.terminator = Terminator::return_(vec![ValueId(1)], synthetic());
    for predecessor in [1_usize, 2] {
        module.functions[0].body.as_mut().unwrap().blocks[predecessor].terminator = Terminator::new(
            TerminatorKind::Jump(Edge::new(BlockId(3), vec![])),
            synthetic(),
        );
    }

    let error = verification_error(&module);
    assert!(
        error.contains("%1 from block1 does not dominate its use in block3"),
        "{error}"
    );
}

#[test]
fn rejects_branch_argument_arity_mismatch() {
    let mut module = diamond_module();
    module.functions[0].body.as_mut().unwrap().blocks[1].terminator = Terminator::new(
        TerminatorKind::Jump(Edge::new(BlockId(3), vec![])),
        synthetic(),
    );

    let error = verification_error(&module);
    assert!(
        error.contains("edge to block3 supplies 0 values, expected 1"),
        "{error}"
    );
}

#[test]
fn rejects_branch_argument_type_mismatch() {
    let mut module = diamond_module();
    module.functions[0].body.as_mut().unwrap().blocks[1].instructions[0] = i64_const(1, 1, 11);

    let error = verification_error(&module);
    assert!(
        error.contains("edge to block3 uses %1 as i64, expected i32"),
        "{error}"
    );
}

#[test]
fn rejects_non_i32_branch_condition() {
    let mut module = diamond_module();
    module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0] = i64_const(0, 0, 1);

    let error = verification_error(&module);
    assert!(
        error.contains("branch condition uses %0 as i64, expected i32"),
        "{error}"
    );
}

#[test]
fn rejects_return_arity_mismatch() {
    let mut module = typed_return_module();
    module.functions[0].body.as_mut().unwrap().blocks[0].terminator =
        Terminator::return_(vec![], synthetic());

    let error = verification_error(&module);
    assert!(
        error.contains("return supplies 0 values, expected 1"),
        "{error}"
    );
}

#[test]
fn rejects_return_type_mismatch() {
    let mut module = typed_return_module();
    module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0] = i64_const(0, 0, 42);

    let error = verification_error(&module);
    assert!(
        error.contains("return uses %0 as i64, expected i32"),
        "{error}"
    );
}

#[test]
fn rejects_duplicate_block_identifier() {
    let mut module = minimal_module();
    let duplicate = module.functions[0].body.as_ref().unwrap().blocks[0].clone();
    module.functions[0]
        .body
        .as_mut()
        .unwrap()
        .blocks
        .push(duplicate);

    let error = verification_error(&module);
    assert!(
        error.contains("duplicate block identifier block0"),
        "{error}"
    );
}

#[test]
fn rejects_duplicate_region_identifier() {
    let mut module = minimal_module();
    let duplicate = module.functions[0].body.as_ref().unwrap().regions[0].clone();
    module.functions[0]
        .body
        .as_mut()
        .unwrap()
        .regions
        .push(duplicate);

    let error = verification_error(&module);
    assert!(
        error.contains("duplicate region identifier region0"),
        "{error}"
    );
}

#[test]
fn rejects_duplicate_instruction_identifier() {
    let mut module = typed_return_module();
    module.functions[0].body.as_mut().unwrap().blocks[0]
        .instructions
        .push(Instruction::new(
            InstructionId(0),
            Operation::new("nop", vec![], vec![]),
            vec![],
            vec![],
            synthetic(),
        ));

    let error = verification_error(&module);
    assert!(
        error.contains("inst0 is used by more than one instruction"),
        "{error}"
    );
}

#[test]
fn rejects_duplicate_value_identifier() {
    let mut module = typed_return_module();
    module.functions[0].body.as_mut().unwrap().blocks[0]
        .instructions
        .push(i32_const(1, 0, 43));

    let error = verification_error(&module);
    assert!(error.contains("%0 is defined more than once"), "{error}");
}

#[test]
fn rejects_missing_region_parent() {
    let mut module = loop_module();
    module.functions[0].body.as_mut().unwrap().regions[1].parent = Some(RegionId(99));

    let error = verification_error(&module);
    assert!(
        error.contains("region1 has missing parent region99"),
        "{error}"
    );
}

#[test]
fn rejects_region_parent_cycle() {
    let mut module = minimal_module();
    let body = module.functions[0].body.as_mut().unwrap();
    body.regions.extend([
        Region {
            id: RegionId(1),
            parent: Some(RegionId(2)),
            kind: RegionKind::Block,
            entry: BlockId(0),
            source: synthetic(),
        },
        Region {
            id: RegionId(2),
            parent: Some(RegionId(1)),
            kind: RegionKind::Block,
            entry: BlockId(0),
            source: synthetic(),
        },
    ]);

    let error = verification_error(&module);
    assert!(error.contains("region parent cycle includes"), "{error}");
}

#[test]
fn rejects_reversed_source_span() {
    let mut module = typed_return_module();
    module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0].source =
        SourceInfo::new(ByteSpan::new(19, 7), 3);

    let error = verification_error(&module);
    assert!(
        error.contains("inst0 has reversed byte span 19..7"),
        "{error}"
    );
}

#[test]
fn retains_effect_trap_and_exception_descriptors() {
    let mut module = diamond_module();
    module.memories.push(Memory {
        ty: MemoryType {
            limits: Limits {
                min: 1,
                max: Some(2),
            },
            address_type: AddressType::I32,
        },
        origin: EntityOrigin::Defined,
        source: synthetic(),
    });
    let try_region = Region {
        id: RegionId(1),
        parent: Some(RegionId(0)),
        kind: RegionKind::TryTable {
            catches: vec![CatchClause {
                kind: CatchKind::CatchAll,
                tag: None,
                target: BlockId(2),
            }],
        },
        entry: BlockId(0),
        source: synthetic(),
    };
    let catch_region = Region {
        id: RegionId(2),
        parent: Some(RegionId(0)),
        kind: RegionKind::Catch,
        entry: BlockId(2),
        source: synthetic(),
    };
    let body = module.functions[0].body.as_mut().unwrap();
    body.regions.extend([try_region, catch_region]);
    body.blocks[0].region = RegionId(1);
    body.blocks[2].region = RegionId(2);
    let producer = body.blocks[0].instructions.remove(0);
    let result = producer.results[0].clone();
    let invoke = Terminator::new(
        TerminatorKind::Invoke {
            operation: Operation::synthetic("wedge.effectful_test", vec![], vec![ValueType::I32]),
            operands: vec![],
            effects: Effects {
                accesses: vec![Effect {
                    resource: EffectResource::Memory(MemoryId(0)),
                    access: EffectAccess::ReadWrite,
                }],
                traps: vec![TrapCode::MemoryOutOfBounds],
                exception: ExceptionEffect::MayThrow,
                allocates: true,
                nondeterministic: false,
            },
            normal: Edge::new(BlockId(4), vec![]),
        },
        synthetic(),
    )
    .with_exception_routing(ExceptionRouting {
        arms: vec![ExceptionalEdge::new(RegionId(1), 0, BlockId(2), vec![])],
        escapes: false,
    });
    let normal_terminator = std::mem::replace(&mut body.blocks[0].terminator, invoke);
    body.blocks.push(Block {
        id: BlockId(4),
        region: RegionId(1),
        parameters: vec![result],
        instructions: vec![],
        terminator: normal_terminator,
        source: synthetic(),
    });

    module.verify().unwrap();
    let printed = module.to_string();
    assert!(printed.contains("read-write:memory0"), "{printed}");
    assert!(printed.contains("trap:memory-out-of-bounds"), "{printed}");
    assert!(printed.contains("allocates"), "{printed}");
    assert!(printed.contains("-> block4(%0: i32)"), "{printed}");
    assert!(
        printed.contains("throws[region1#0 -> block2()]"),
        "{printed}"
    );
}

fn memory_size_module() -> Program {
    let mut module = typed_return_module();
    module.memories.push(Memory {
        ty: MemoryType {
            limits: Limits {
                min: 1,
                max: Some(2),
            },
            address_type: AddressType::I32,
        },
        origin: EntityOrigin::Defined,
        source: synthetic(),
    });
    let instruction = &mut module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0];
    instruction.operation = Operation::core(CoreOpcode::MemorySize, vec![], vec![ValueType::I32])
        .with_immediates(vec![Immediate::Memory(MemoryId(0))]);
    instruction.effects = wedge::semantics::effects_for_operation(&instruction.operation);
    module
}

#[test]
fn rejects_widened_stored_core_effects() {
    let mutations: [fn(&mut Effects); 4] = [
        |effects| {
            effects.accesses.push(Effect {
                resource: EffectResource::Host,
                access: EffectAccess::Read,
            });
        },
        |effects| effects.traps.push(TrapCode::Unreachable),
        |effects| effects.allocates = true,
        |effects| effects.nondeterministic = true,
    ];
    let expected = [
        "stores read:host, but i32.const canonically has no accesses",
        "stores trap:unreachable, but i32.const canonically has no traps",
        "stores allocates=true, but i32.const canonically has allocates=false",
        "stores nondeterministic=true, but i32.const canonically has nondeterministic=false",
    ];
    for (mutate, expected) in mutations.into_iter().zip(expected) {
        let mut module = typed_return_module();
        mutate(&mut module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0].effects);
        let error = verification_error(&module);
        assert!(error.contains(expected), "{error}");
    }

    let stronger = [
        (
            Effect {
                resource: EffectResource::Memory(MemoryId(0)),
                access: EffectAccess::ReadWrite,
            },
            "stores read-write:memory0, but memory.size canonically has",
        ),
        (
            Effect {
                resource: EffectResource::Memory(MemoryId(1)),
                access: EffectAccess::Read,
            },
            "stores read:memory1, but memory.size canonically has",
        ),
    ];
    for (effect, expected) in stronger {
        let mut module = memory_size_module();
        module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0]
            .effects
            .accesses = vec![effect];
        let error = verification_error(&module);
        assert!(error.contains(expected), "{error}");
    }

    let mut module = memory_size_module();
    let effects = &mut module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0].effects;
    let duplicate = effects.accesses[0];
    effects.accesses.push(duplicate);
    let error = verification_error(&module);
    assert!(
        error.contains("lists memory0 more than once in its accesses"),
        "{error}"
    );
}

#[test]
fn rejects_a_stored_may_throw_on_a_non_throwing_core_operation() {
    let mut module = typed_return_module();
    module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0]
        .effects
        .exception = ExceptionEffect::MayThrow;
    let error = verification_error(&module);
    assert!(
        error.contains("stores may-throw=true, but i32.const canonically has may-throw=false"),
        "{error}"
    );
}

#[test]
fn accepts_narrowed_stored_core_effects() {
    // A call proven not to throw and not to touch any state keeps pure
    // stored effects, and a memory.size proven irrelevant drops its read.
    let mut module = typed_return_module();
    let instruction = &mut module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0];
    instruction.operation = Operation::core(CoreOpcode::Call, vec![], vec![ValueType::I32])
        .with_immediates(vec![Immediate::Function(FunctionId(0))]);
    instruction.effects = Effects::pure();
    module.verify().unwrap();

    let mut module = memory_size_module();
    let effects = &mut module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0].effects;
    assert!(
        !effects.accesses.is_empty(),
        "memory.size canonically reads its memory"
    );
    effects.accesses.clear();
    module.verify().unwrap();

    let mut module = memory_size_module();
    let block = &mut module.functions[0].body.as_mut().unwrap().blocks[0];
    block.instructions.insert(0, i32_const(1, 1, 1));
    let instruction = &mut block.instructions[1];
    instruction.operation = Operation::core(
        CoreOpcode::MemoryGrow,
        vec![ValueType::I32],
        vec![ValueType::I32],
    )
    .with_immediates(vec![Immediate::Memory(MemoryId(0))]);
    instruction.operands = vec![ValueId(1)];
    let canonical = wedge::semantics::effects_for_operation(&instruction.operation);
    instruction.effects = Effects {
        accesses: canonical
            .accesses
            .iter()
            .map(|effect| Effect {
                resource: effect.resource,
                access: EffectAccess::Read,
            })
            .collect(),
        traps: Vec::new(),
        exception: ExceptionEffect::None,
        allocates: false,
        nondeterministic: false,
    };
    module.verify().unwrap();
}

#[test]
fn permits_exceptional_escape_metadata_on_canonically_throwing_core_operations() {
    let mut module = diamond_module();
    let instruction = &mut module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0];
    instruction.operation = Operation::core(CoreOpcode::Call, vec![], vec![ValueType::I32])
        .with_immediates(vec![Immediate::Function(FunctionId(0))]);
    instruction.effects = wedge::semantics::effects_for_operation(&instruction.operation);
    instruction.effects.exception = ExceptionEffect::MayThrow;

    module.verify().unwrap();
}

#[test]
fn rejects_an_effect_on_a_missing_segment_resource() {
    let mut module = typed_return_module();
    module.functions[0].body.as_mut().unwrap().blocks[0].instructions[0]
        .effects
        .accesses = vec![Effect {
        resource: EffectResource::DataSegment(DataId(0)),
        access: EffectAccess::Read,
    }];

    let error = verification_error(&module);
    assert!(error.contains("effect on a missing resource"), "{error}");
}

#[test]
fn verifies_a_wide_join_from_a_long_conditional_chain() {
    // Every chain block branches to one join, the shape of a long guard
    // sequence with a shared exit. Verification computes dominance over it,
    // which used to be quadratic in the chain length and time out here.
    const CHAIN: u32 = 20_000;
    let join = BlockId(CHAIN);
    let mut blocks = Vec::with_capacity(CHAIN as usize + 1);
    for index in 0..CHAIN {
        let kind = if index + 1 == CHAIN {
            TerminatorKind::Jump(Edge::new(join, vec![]))
        } else {
            TerminatorKind::Branch {
                condition: ValueId(0),
                then_edge: Edge::new(join, vec![]),
                else_edge: Edge::new(BlockId(index + 1), vec![]),
            }
        };
        let mut block = Block {
            id: BlockId(index),
            region: RegionId(0),
            parameters: vec![],
            instructions: vec![],
            terminator: Terminator::new(kind, synthetic()),
            source: synthetic(),
        };
        if index == 0 {
            block.instructions.push(i32_const(0, 0, 1));
        }
        blocks.push(block);
    }
    blocks.push(return_block(join, RegionId(0), vec![], vec![]));
    let module = module_with_function(
        function_type(vec![], vec![]),
        body(blocks, vec![root_region(BlockId(0))]),
    );

    module
        .verify()
        .unwrap_or_else(|errors| panic!("the chain verifies:\n{errors}"));
}

#[test]
fn accepts_sparse_hand_built_identifiers() {
    let mut entry = return_block(BlockId(0), RegionId(0), vec![], vec![ValueId(1_000_000)]);
    entry.instructions.push(i32_const(7, 7, 8));
    entry.instructions.push(i32_const(1_000_000, 1_000_000, 9));
    let module = module_with_function(
        function_type(vec![], vec![ValueType::I32]),
        body(vec![entry], vec![root_region(BlockId(0))]),
    );
    module.verify().expect("sparse identifiers verify");
}

#[test]
fn rejects_duplicate_sparse_identifiers() {
    let mut entry = return_block(BlockId(0), RegionId(0), vec![], vec![ValueId(1_000_000)]);
    entry.instructions.push(i32_const(1_000_000, 1_000_000, 8));
    entry.instructions.push(i32_const(1_000_001, 1_000_000, 9));
    let module = module_with_function(
        function_type(vec![], vec![ValueType::I32]),
        body(vec![entry], vec![root_region(BlockId(0))]),
    );
    let error = verification_error(&module);
    assert!(
        error.contains("%1000000 is defined more than once"),
        "{error}"
    );

    let mut entry = return_block(BlockId(0), RegionId(0), vec![], vec![ValueId(1_000_000)]);
    entry.instructions.push(i32_const(1_000_000, 1_000_000, 8));
    entry.instructions.push(i32_const(1_000_000, 1_000_001, 9));
    let module = module_with_function(
        function_type(vec![], vec![ValueType::I32]),
        body(vec![entry], vec![root_region(BlockId(0))]),
    );
    let error = verification_error(&module);
    assert!(
        error.contains("inst1000000 is used by more than one instruction"),
        "{error}"
    );
}
