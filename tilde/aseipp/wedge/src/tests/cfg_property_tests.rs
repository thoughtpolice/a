// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Generative contracts for Wedge's typed SSA control-flow graph.
//!
//! These properties deliberately use graph oracles that are independent of
//! the verifier's implementation. Generators are bounded and rejection-free so
//! a derandomized run spends its whole case budget on accepted cases, and
//! failures print their context before Hegel shrinks them.

use std::collections::BTreeSet;

use hegel::{TestCase, generators as gs};
use wedge::ir::*;
use wedge::opcode::CoreOpcode;

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

macro_rules! property_panic {
    ($($message:tt)*) => {{
        eprintln!($($message)*);
        panic!("property failed after printing its diagnostic");
    }};
}

macro_rules! property_assert {
    ($condition:expr, $($message:tt)*) => {{
        if !$condition {
            property_panic!($($message)*);
        }
    }};
}

fn source() -> SourceInfo {
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
        source: source(),
    }
}

fn program_with_body(
    signature: FunctionType,
    entry: BlockId,
    root: RegionId,
    blocks: Vec<Block>,
    regions: Vec<Region>,
) -> Program {
    let locals = signature.params.clone();
    let mut program = Program::new(1);
    program.rec_groups.push(RecGroup {
        types: vec![TypeId(0)],
        source: source(),
    });
    program.types.push(TypeDefinition {
        canonical_alias: None,
        final_: true,
        supertype: None,
        composite: CompositeType::Function(signature),
        source: source(),
    });
    program.functions.push(Function {
        wasm_index: 0,
        ty: TypeId(0),
        origin: EntityOrigin::Defined,
        locals,
        body: Some(FunctionBody {
            entry,
            root_region: root,
            blocks,
            regions,
        }),
        source: source(),
    });
    program
}

fn body(program: &Program) -> &FunctionBody {
    program.functions[0]
        .body
        .as_ref()
        .expect("generated function body")
}

fn body_mut(program: &mut Program) -> &mut FunctionBody {
    program.functions[0]
        .body
        .as_mut()
        .expect("generated function body")
}

fn block_mut(program: &mut Program, id: BlockId) -> &mut Block {
    body_mut(program)
        .blocks
        .iter_mut()
        .find(|block| block.id == id)
        .unwrap_or_else(|| panic!("missing generated {id}"))
}

fn return_block(id: BlockId, region: RegionId, parameters: Vec<ValueDefinition>) -> Block {
    Block {
        id,
        region,
        parameters,
        instructions: Vec::new(),
        terminator: Terminator::return_(Vec::new(), source()),
        source: source(),
    }
}

fn i32_const(instruction: u32, value: u32, immediate: i32) -> Instruction {
    Instruction::new(
        InstructionId(instruction),
        Operation::core(CoreOpcode::I32Const, vec![], vec![ValueType::I32])
            .with_immediates(vec![Immediate::S32(immediate)]),
        vec![],
        vec![ValueDefinition::new(ValueId(value), ValueType::I32)],
        source(),
    )
}

fn i64_const(instruction: u32, value: u32, immediate: i64) -> Instruction {
    Instruction::new(
        InstructionId(instruction),
        Operation::core(CoreOpcode::I64Const, vec![], vec![ValueType::I64])
            .with_immediates(vec![Immediate::S64(immediate)]),
        vec![],
        vec![ValueDefinition::new(ValueId(value), ValueType::I64)],
        source(),
    )
}

fn drop_i32(instruction: u32, value: ValueId) -> Instruction {
    Instruction::new(
        InstructionId(instruction),
        Operation::core(CoreOpcode::Drop, vec![ValueType::I32], vec![]),
        vec![value],
        vec![],
        source(),
    )
}

fn verify(program: &Program) -> Result<(), String> {
    program.verify().map_err(|errors| errors.to_string())
}

fn assert_valid(program: &Program, subject: &str) {
    if let Err(error) = verify(program) {
        property_panic!("valid {subject} was rejected:\n{error}\n{program:#?}");
    }
}

fn assert_error_contains(program: &Program, subject: &str, fragments: &[&str]) {
    let error = match verify(program) {
        Ok(()) => property_panic!("invalid {subject} was accepted:\n{program:#?}"),
        Err(error) => error,
    };
    property_assert!(
        fragments.iter().all(|fragment| error.contains(fragment)),
        "{subject} lacked diagnostic fragments {fragments:?}:\n{error}\n{program:#?}"
    );
}

#[derive(Clone, Debug)]
struct Graph {
    successors: Vec<Vec<usize>>,
}

impl Graph {
    fn draw(tc: &TestCase) -> Self {
        let block_count = tc.draw(gs::integers::<usize>().min_value(1).max_value(16));
        let mut successors = vec![Vec::new(); block_count];
        if block_count == 1 {
            return Self { successors };
        }

        for source in 0..block_count {
            let mut targets = BTreeSet::new();
            if source + 1 < block_count {
                targets.insert(source + 1);
            }
            let chord_count = tc.draw(gs::integers::<usize>().max_value(3));
            for _ in 0..chord_count {
                targets.insert(
                    tc.draw(
                        gs::integers::<usize>()
                            .min_value(1)
                            .max_value(block_count - 1),
                    ),
                );
            }
            successors[source] = targets.into_iter().collect();
        }
        Self { successors }
    }

    fn block_count(&self) -> usize {
        self.successors.len()
    }

    fn reaches_avoiding(&self, target: usize, removed: Option<usize>) -> bool {
        if removed == Some(0) {
            return false;
        }
        let mut visited = BTreeSet::new();
        let mut pending = vec![0];
        while let Some(block) = pending.pop() {
            if removed == Some(block) || !visited.insert(block) {
                continue;
            }
            if block == target {
                return true;
            }
            pending.extend(
                self.successors[block]
                    .iter()
                    .copied()
                    .filter(|next| removed != Some(*next)),
            );
        }
        false
    }

    fn dominates(&self, definition: usize, use_block: usize) -> bool {
        self.reaches_avoiding(use_block, None)
            && (definition == use_block || !self.reaches_avoiding(use_block, Some(definition)))
    }

    fn program(&self, use_site: Option<(usize, usize)>) -> Program {
        let blocks = self
            .successors
            .iter()
            .enumerate()
            .map(|(index, successors)| {
                let id = BlockId(index as u32);
                let value = ValueId(index as u32);
                let mut block = return_block(id, RegionId(0), Vec::new());
                block
                    .instructions
                    .push(i32_const(index as u32 * 2, value.0, index as i32));
                if use_site.is_some_and(|(_, use_block)| use_block == index) {
                    let definition = use_site.expect("checked generated use site").0;
                    block
                        .instructions
                        .push(drop_i32(index as u32 * 2 + 1, ValueId(definition as u32)));
                }
                block.terminator = graph_terminator(value, successors);
                block
            })
            .collect();
        program_with_body(
            function_type(vec![], vec![]),
            BlockId(0),
            RegionId(0),
            blocks,
            vec![root_region(BlockId(0))],
        )
    }
}

fn graph_terminator(selector: ValueId, successors: &[usize]) -> Terminator {
    let edge = |target| Edge::new(BlockId(target as u32), Vec::new());
    let kind = match successors {
        [] => TerminatorKind::Return { values: Vec::new() },
        [target] => TerminatorKind::Jump(edge(*target)),
        [then_target, else_target] => TerminatorKind::Branch {
            condition: selector,
            then_edge: edge(*then_target),
            else_edge: edge(*else_target),
        },
        [targets @ .., default] => TerminatorKind::Switch {
            selector,
            targets: targets.iter().map(|target| edge(*target)).collect(),
            default: edge(*default),
        },
    };
    Terminator::new(kind, source())
}

#[hegel::test(test_cases = 750, derandomize = true, database = None)]
fn generated_cfg_dominance_matches_path_avoidance_oracle(tc: TestCase) {
    let graph = Graph::draw(&tc);
    let baseline = graph.program(None);
    assert_valid(&baseline, "generated reachable CFG baseline");

    let mut reordered = baseline.clone();
    let blocks = &mut body_mut(&mut reordered).blocks;
    if tc.draw(gs::booleans()) {
        blocks.reverse();
    } else {
        let rotation = tc.draw(gs::integers::<usize>().max_value(blocks.len() - 1));
        blocks.rotate_left(rotation);
    }
    assert_valid(&reordered, "storage-reordered generated CFG");

    let definition = tc.draw(gs::integers::<usize>().max_value(graph.block_count() - 1));
    let use_block = tc.draw(gs::integers::<usize>().max_value(graph.block_count() - 1));
    let candidate = graph.program(Some((definition, use_block)));
    let expected = graph.dominates(definition, use_block);
    let result = verify(&candidate);
    if expected {
        property_assert!(
            result.is_ok(),
            "dominating value was rejected: definition=block{definition}, use=block{use_block}, graph={graph:?}\n{result:?}"
        );
    } else {
        let error = match result {
            Ok(()) => property_panic!(
                "non-dominating value was accepted: definition=block{definition}, use=block{use_block}, graph={graph:?}"
            ),
            Err(error) => error,
        };
        property_assert!(
            error.contains("does not dominate its use"),
            "non-dominating use lacked its diagnostic: definition=block{definition}, use=block{use_block}, graph={graph:?}\n{error}"
        );
    }
}

#[hegel::test(test_cases = 500, derandomize = true, database = None)]
fn same_block_definition_order_matches_instruction_position(tc: TestCase) {
    let definition_count = tc.draw(gs::integers::<usize>().min_value(1).max_value(32));
    let definition = tc.draw(gs::integers::<usize>().max_value(definition_count - 1));
    let use_position = tc.draw(gs::integers::<usize>().max_value(definition_count));
    let mut instructions = (0..definition_count)
        .map(|index| i32_const(index as u32, index as u32, index as i32))
        .collect::<Vec<_>>();
    instructions.insert(use_position, drop_i32(10_000, ValueId(definition as u32)));
    let mut entry = return_block(BlockId(0), RegionId(0), Vec::new());
    entry.instructions = instructions;
    let program = program_with_body(
        function_type(vec![], vec![]),
        BlockId(0),
        RegionId(0),
        vec![entry],
        vec![root_region(BlockId(0))],
    );
    let expected = use_position > definition;
    let result = verify(&program);
    if expected {
        property_assert!(
            result.is_ok(),
            "same-block use after its definition was rejected: definition={definition}, use_position={use_position}\n{result:?}"
        );
    } else {
        let error = match result {
            Ok(()) => property_panic!(
                "same-block use before its definition was accepted: definition={definition}, use_position={use_position}"
            ),
            Err(error) => error,
        };
        property_assert!(
            error.contains("is used before its definition"),
            "same-block order failure lacked its diagnostic: definition={definition}, use_position={use_position}\n{error}"
        );
    }
}

#[derive(Clone, Copy, Debug)]
enum EdgeForm {
    Jump,
    Branch,
    Switch { targets: usize },
}

fn draw_value_types(tc: &TestCase) -> Vec<ValueType> {
    let count = tc.draw(gs::integers::<usize>().max_value(12));
    (0..count)
        .map(|_| {
            if tc.draw(gs::booleans()) {
                ValueType::I32
            } else {
                ValueType::I64
            }
        })
        .collect()
}

fn draw_edge_form(tc: &TestCase) -> EdgeForm {
    match tc.draw(gs::integers::<u8>().max_value(2)) {
        0 => EdgeForm::Jump,
        1 => EdgeForm::Branch,
        2 => EdgeForm::Switch {
            targets: tc.draw(gs::integers::<usize>().max_value(4)),
        },
        _ => unreachable!(),
    }
}

fn typed_edge_program(types: &[ValueType], form: EdgeForm) -> Program {
    let mut entry = return_block(BlockId(0), RegionId(0), Vec::new());
    entry.instructions.push(i32_const(0, 0, 0));
    entry.instructions.push(i64_const(1, 1, 0));

    let mut arguments = Vec::with_capacity(types.len());
    for (index, ty) in types.iter().enumerate() {
        let instruction = index as u32 + 2;
        let value = index as u32 + 2;
        entry.instructions.push(match ty {
            ValueType::I32 => i32_const(instruction, value, index as i32),
            ValueType::I64 => i64_const(instruction, value, index as i64),
            _ => unreachable!(),
        });
        arguments.push(ValueId(value));
    }

    let edge = || Edge::new(BlockId(1), arguments.clone());
    entry.terminator = Terminator::new(
        match form {
            EdgeForm::Jump => TerminatorKind::Jump(edge()),
            EdgeForm::Branch => TerminatorKind::Branch {
                condition: ValueId(0),
                then_edge: edge(),
                else_edge: edge(),
            },
            EdgeForm::Switch { targets } => TerminatorKind::Switch {
                selector: ValueId(0),
                targets: (0..targets).map(|_| edge()).collect(),
                default: edge(),
            },
        },
        source(),
    );

    let target = return_block(
        BlockId(1),
        RegionId(0),
        types
            .iter()
            .enumerate()
            .map(|(index, ty)| ValueDefinition::new(ValueId(1_000 + index as u32), ty.clone()))
            .collect(),
    );
    let mut dead = return_block(BlockId(2), RegionId(0), Vec::new());
    dead.instructions.push(i32_const(100, 2_000, 0));
    dead.instructions.push(i64_const(101, 2_001, 0));

    program_with_body(
        function_type(vec![], vec![]),
        BlockId(0),
        RegionId(0),
        vec![entry, target, dead],
        vec![root_region(BlockId(0))],
    )
}

fn edge_count(kind: &TerminatorKind) -> usize {
    match kind {
        TerminatorKind::Jump(_) => 1,
        TerminatorKind::Branch { .. } => 2,
        TerminatorKind::Switch { targets, .. } => targets.len() + 1,
        _ => 0,
    }
}

fn edge_mut(kind: &mut TerminatorKind, index: usize) -> &mut Edge {
    match kind {
        TerminatorKind::Jump(edge) => {
            assert_eq!(index, 0, "invalid generated jump edge");
            edge
        }
        TerminatorKind::Branch {
            then_edge,
            else_edge,
            ..
        } => match index {
            0 => then_edge,
            1 => else_edge,
            _ => panic!("invalid generated branch edge {index}"),
        },
        TerminatorKind::Switch {
            targets, default, ..
        } => {
            if index < targets.len() {
                &mut targets[index]
            } else if index == targets.len() {
                default
            } else {
                panic!("invalid generated switch edge {index}")
            }
        }
        _ => panic!("generated terminator has no edge {index}"),
    }
}

#[hegel::test(test_cases = 750, derandomize = true, database = None)]
fn every_edge_form_rejects_one_argument_or_target_mutation(tc: TestCase) {
    let types = draw_value_types(&tc);
    let form = draw_edge_form(&tc);
    let mut program = typed_edge_program(&types, form);
    assert_valid(&program, "typed edge baseline");

    let count = edge_count(&body(&program).blocks[0].terminator.kind);
    let selected_edge = tc.draw(gs::integers::<usize>().max_value(count - 1));
    let slot =
        (!types.is_empty()).then(|| tc.draw(gs::integers::<usize>().max_value(types.len() - 1)));
    let mutation = tc.draw(gs::integers::<u8>().max_value(5));
    let edge = edge_mut(
        &mut block_mut(&mut program, BlockId(0)).terminator.kind,
        selected_edge,
    );
    let expected = match mutation {
        0 => {
            if let Some(slot) = slot {
                edge.arguments.remove(slot);
            } else {
                edge.arguments.push(ValueId(0));
            }
            format!(
                "edge to {} supplies {} values, expected {}",
                edge.target,
                edge.arguments.len(),
                types.len()
            )
        }
        1 => {
            let position = tc.draw(gs::integers::<usize>().max_value(edge.arguments.len()));
            edge.arguments.insert(position, ValueId(0));
            format!(
                "edge to {} supplies {} values, expected {}",
                edge.target,
                edge.arguments.len(),
                types.len()
            )
        }
        2 => {
            if let Some(slot) = slot {
                let (value, actual) = if types[slot] == ValueType::I32 {
                    (ValueId(1), ValueType::I64)
                } else {
                    (ValueId(0), ValueType::I32)
                };
                edge.arguments[slot] = value;
                format!(
                    "edge to {} uses {value} as {actual}, expected {}",
                    edge.target, types[slot]
                )
            } else {
                edge.arguments.push(ValueId(0));
                format!("edge to {} supplies 1 values, expected 0", edge.target)
            }
        }
        3 => {
            if let Some(slot) = slot {
                edge.arguments[slot] = ValueId(u32::MAX);
            } else {
                edge.arguments.push(ValueId(u32::MAX));
            }
            format!("use of undefined {}", ValueId(u32::MAX))
        }
        4 => {
            edge.target = BlockId(u32::MAX);
            format!("edge targets missing {}", BlockId(u32::MAX))
        }
        5 => {
            let value = if let Some(slot) = slot {
                let value = if types[slot] == ValueType::I32 {
                    ValueId(2_000)
                } else {
                    ValueId(2_001)
                };
                edge.arguments[slot] = value;
                value
            } else {
                let value = ValueId(2_000);
                edge.arguments.push(value);
                value
            };
            format!("{value} from block2 does not dominate its use in block0")
        }
        _ => unreachable!(),
    };
    assert_error_contains(
        &program,
        &format!("{form:?} edge mutation {mutation}"),
        &[&expected],
    );
}

fn mutate_selector(program: &mut Program, mutation: u8) -> String {
    let kind = &mut block_mut(program, BlockId(0)).terminator.kind;
    let (selector, owner) = match kind {
        TerminatorKind::Branch { condition, .. } => (condition, "branch condition"),
        TerminatorKind::Switch { selector, .. } => (selector, "switch selector"),
        _ => unreachable!("generated selector mutation needs a branch or switch"),
    };
    match mutation {
        0 => {
            *selector = ValueId(1);
            format!("{owner} uses %1 as i64, expected i32")
        }
        1 => {
            *selector = ValueId(u32::MAX);
            format!("use of undefined {}", ValueId(u32::MAX))
        }
        2 => {
            *selector = ValueId(2_000);
            "%2000 from block2 does not dominate its use in block0".to_owned()
        }
        _ => unreachable!("invalid generated selector mutation {mutation}"),
    }
}

fn assert_selector_mutation(form: EdgeForm, mutation: u8, subject: &str) {
    let mut program = typed_edge_program(&[], form);
    assert_valid(&program, "selector mutation baseline");
    let expected = mutate_selector(&mut program, mutation);
    assert_error_contains(&program, subject, &[&expected]);
}

#[hegel::test(test_cases = 300, derandomize = true, database = None)]
fn branch_and_switch_selectors_reject_type_availability_and_identity_mutations(tc: TestCase) {
    let form = if tc.draw(gs::booleans()) {
        EdgeForm::Branch
    } else {
        EdgeForm::Switch {
            targets: tc.draw(gs::integers::<usize>().max_value(4)),
        }
    };
    let mutation = tc.draw(gs::integers::<u8>().max_value(2));
    assert_selector_mutation(
        form,
        mutation,
        &format!("{form:?} selector mutation {mutation}"),
    );
}

#[test]
fn every_branch_and_switch_selector_mutation_has_a_targeted_diagnostic() {
    for form in [EdgeForm::Branch, EdgeForm::Switch { targets: 3 }] {
        for mutation in 0..=2 {
            assert_selector_mutation(
                form,
                mutation,
                &format!("exhaustive {form:?} selector mutation {mutation}"),
            );
        }
    }
}

fn const_for_type(instruction: u32, value: u32, ty: &ValueType, immediate: usize) -> Instruction {
    match ty {
        ValueType::I32 => i32_const(instruction, value, immediate as i32),
        ValueType::I64 => i64_const(instruction, value, immediate as i64),
        _ => unreachable!("the typed-flow generator only draws integer types"),
    }
}

fn definitions(first: u32, types: &[ValueType]) -> Vec<ValueDefinition> {
    types
        .iter()
        .enumerate()
        .map(|(slot, ty)| ValueDefinition::new(ValueId(first + slot as u32), ty.clone()))
        .collect()
}

fn typed_flow_program(
    types: &[ValueType],
    then_uses_local: &[bool],
    else_uses_local: &[bool],
) -> Program {
    let mut entry = return_block(BlockId(0), RegionId(0), Vec::new());
    entry.instructions.push(i32_const(0, 0, 1));
    entry.instructions.push(i64_const(1, 1, 1));
    for (slot, ty) in types.iter().enumerate() {
        entry
            .instructions
            .push(const_for_type(10 + slot as u32, 10 + slot as u32, ty, slot));
    }
    let initial = (0..types.len())
        .map(|slot| ValueId(10 + slot as u32))
        .collect::<Vec<_>>();
    entry.terminator = Terminator::new(
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: Edge::new(BlockId(1), initial.clone()),
            else_edge: Edge::new(BlockId(2), initial),
        },
        source(),
    );

    let mut then_block = return_block(BlockId(1), RegionId(0), definitions(100, types));
    let mut else_block = return_block(BlockId(2), RegionId(0), definitions(300, types));
    for (slot, ty) in types.iter().enumerate() {
        then_block.instructions.push(const_for_type(
            100 + slot as u32,
            200 + slot as u32,
            ty,
            slot + 100,
        ));
        else_block.instructions.push(const_for_type(
            200 + slot as u32,
            400 + slot as u32,
            ty,
            slot + 200,
        ));
    }
    let arm_arguments = |parameters: u32, locals: u32, use_local: &[bool]| {
        use_local
            .iter()
            .enumerate()
            .map(|(slot, use_local)| {
                ValueId(if *use_local { locals } else { parameters } + slot as u32)
            })
            .collect()
    };
    then_block.terminator = Terminator::new(
        TerminatorKind::Jump(Edge::new(
            BlockId(3),
            arm_arguments(100, 200, then_uses_local),
        )),
        source(),
    );
    else_block.terminator = Terminator::new(
        TerminatorKind::Jump(Edge::new(
            BlockId(3),
            arm_arguments(300, 400, else_uses_local),
        )),
        source(),
    );

    let mut join = return_block(BlockId(3), RegionId(0), definitions(500, types));
    join.terminator = Terminator::new(
        TerminatorKind::Jump(Edge::new(
            BlockId(4),
            (0..types.len())
                .map(|slot| ValueId(500 + slot as u32))
                .collect(),
        )),
        source(),
    );

    let mut loop_header = return_block(BlockId(4), RegionId(0), definitions(600, types));
    loop_header.instructions.push(i32_const(300, 900, 1));
    for (slot, ty) in types.iter().enumerate() {
        loop_header.instructions.push(const_for_type(
            310 + slot as u32,
            800 + slot as u32,
            ty,
            slot + 300,
        ));
    }
    let backedge_arguments = (0..types.len())
        .map(|slot| ValueId(800 + slot as u32))
        .collect::<Vec<_>>();
    let exit_arguments = (0..types.len())
        .map(|slot| ValueId(600 + slot as u32))
        .collect::<Vec<_>>();
    loop_header.terminator = Terminator::new(
        TerminatorKind::Branch {
            condition: ValueId(900),
            then_edge: Edge::new(BlockId(4), backedge_arguments),
            else_edge: Edge::new(BlockId(5), exit_arguments),
        },
        source(),
    );
    let exit = return_block(BlockId(5), RegionId(0), definitions(700, types));

    program_with_body(
        function_type(vec![], vec![]),
        BlockId(0),
        RegionId(0),
        vec![entry, then_block, else_block, join, loop_header, exit],
        vec![root_region(BlockId(0))],
    )
}

fn typed_flow_edge_mut(program: &mut Program, edge_kind: u8) -> &mut Edge {
    let block = match edge_kind {
        0 => BlockId(1),
        1 => BlockId(2),
        2 => BlockId(3),
        3 => BlockId(4),
        _ => unreachable!("invalid generated typed-flow edge {edge_kind}"),
    };
    match &mut block_mut(program, block).terminator.kind {
        TerminatorKind::Jump(edge) => edge,
        TerminatorKind::Branch { then_edge, .. } if edge_kind == 3 => then_edge,
        _ => unreachable!("generated typed-flow block has the wrong terminator"),
    }
}

fn mutate_typed_flow_edge(
    program: &mut Program,
    types: &[ValueType],
    edge_kind: u8,
    slot: usize,
    mutation: u8,
) -> String {
    let edge = typed_flow_edge_mut(program, edge_kind);
    match mutation {
        0 => {
            let wrong = if types[slot] == ValueType::I32 {
                ValueId(1)
            } else {
                ValueId(0)
            };
            let actual = if types[slot] == ValueType::I32 {
                ValueType::I64
            } else {
                ValueType::I32
            };
            edge.arguments[slot] = wrong;
            format!(
                "edge to {} uses {wrong} as {actual}, expected {}",
                edge.target, types[slot]
            )
        }
        1 => {
            edge.arguments.remove(slot);
            format!(
                "edge to {} supplies {} values, expected {}",
                edge.target,
                types.len() - 1,
                types.len()
            )
        }
        2 => {
            edge.arguments[slot] = ValueId(u32::MAX);
            format!("use of undefined {}", ValueId(u32::MAX))
        }
        3 => {
            edge.arguments[slot] = ValueId(
                match edge_kind {
                    0 => 400,
                    1 | 2 => 200,
                    3 => 700,
                    _ => unreachable!(),
                } + slot as u32,
            );
            "does not dominate its use".to_owned()
        }
        _ => unreachable!("invalid generated typed-flow mutation {mutation}"),
    }
}

#[hegel::test(test_cases = 600, derandomize = true, database = None)]
fn typed_block_parameters_survive_diamonds_and_loop_backedges(tc: TestCase) {
    let types = {
        let count = tc.draw(gs::integers::<usize>().min_value(1).max_value(4));
        (0..count)
            .map(|_| {
                if tc.draw(gs::booleans()) {
                    ValueType::I32
                } else {
                    ValueType::I64
                }
            })
            .collect::<Vec<_>>()
    };
    let then_uses_local = (0..types.len())
        .map(|_| tc.draw(gs::booleans()))
        .collect::<Vec<_>>();
    let else_uses_local = (0..types.len())
        .map(|_| tc.draw(gs::booleans()))
        .collect::<Vec<_>>();
    let mut program = typed_flow_program(&types, &then_uses_local, &else_uses_local);
    assert_valid(&program, "typed diamond and loop baseline");

    let edge_kind = tc.draw(gs::integers::<u8>().max_value(3));
    let slot = tc.draw(gs::integers::<usize>().max_value(types.len() - 1));
    let mutation = tc.draw(gs::integers::<u8>().max_value(3));
    let expected = mutate_typed_flow_edge(&mut program, &types, edge_kind, slot, mutation);
    assert_error_contains(
        &program,
        &format!("typed-flow edge {edge_kind} mutation {mutation} at slot {slot}"),
        &[&expected],
    );
}

#[test]
fn every_typed_flow_edge_mutation_has_a_targeted_diagnostic() {
    let types = [ValueType::I32, ValueType::I64];
    for edge_kind in 0..=3 {
        for mutation in 0..=3 {
            let mut program = typed_flow_program(&types, &[false, true], &[true, false]);
            let expected = mutate_typed_flow_edge(&mut program, &types, edge_kind, 1, mutation);
            assert_error_contains(
                &program,
                &format!("exhaustive typed-flow edge {edge_kind} mutation {mutation}"),
                &[&expected],
            );
        }
    }
}

fn nested_linear_program(block_count: usize) -> Program {
    let mut blocks = Vec::with_capacity(block_count);
    let mut regions = Vec::with_capacity(block_count);
    for index in 0..block_count {
        let id = BlockId(index as u32);
        let region = RegionId(index as u32);
        let mut block = return_block(id, region, Vec::new());
        block
            .instructions
            .push(i32_const(index as u32, index as u32, index as i32));
        if index + 1 < block_count {
            block.terminator = Terminator::new(
                TerminatorKind::Jump(Edge::new(BlockId(index as u32 + 1), Vec::new())),
                source(),
            );
        }
        blocks.push(block);
        regions.push(if index == 0 {
            root_region(BlockId(0))
        } else {
            Region {
                id: region,
                parent: Some(RegionId(index as u32 - 1)),
                kind: RegionKind::CompilerGenerated,
                entry: id,
                source: source(),
            }
        });
    }
    program_with_body(
        function_type(vec![], vec![]),
        BlockId(0),
        RegionId(0),
        blocks,
        regions,
    )
}

fn apply_identifier_mutation(
    program: &mut Program,
    mutation: u8,
    selected_block: usize,
    selected_region: usize,
) -> &'static str {
    let generated = body_mut(program);
    match mutation {
        0 => {
            generated.blocks.last_mut().expect("generated block").id = BlockId(0);
            "duplicate block identifier"
        }
        1 => {
            generated.regions.last_mut().expect("generated region").id = RegionId(0);
            "duplicate region identifier"
        }
        2 => {
            generated
                .blocks
                .last_mut()
                .expect("generated block")
                .instructions[0]
                .id = InstructionId(0);
            "used by more than one instruction"
        }
        3 => {
            generated
                .blocks
                .last_mut()
                .expect("generated block")
                .instructions[0]
                .results[0]
                .id = ValueId(0);
            "is defined more than once"
        }
        4 => {
            let TerminatorKind::Jump(edge) = &mut generated.blocks[selected_block].terminator.kind
            else {
                unreachable!()
            };
            edge.target = BlockId(u32::MAX);
            "edge targets missing"
        }
        5 => {
            generated.blocks[selected_block].region = RegionId(u32::MAX);
            "references missing region"
        }
        6 => {
            generated.regions[selected_region].parent = Some(RegionId(u32::MAX));
            "has missing parent"
        }
        7 => {
            generated.regions[selected_region].parent = Some(RegionId(selected_region as u32));
            "region parent cycle"
        }
        8 => {
            let instruction = &mut generated.blocks[selected_block].instructions[0];
            instruction.operation = Operation::core(CoreOpcode::Drop, vec![ValueType::I32], vec![]);
            instruction.operands = vec![ValueId(u32::MAX)];
            instruction.results.clear();
            "use of undefined"
        }
        9 => {
            generated.entry = BlockId(u32::MAX);
            "entry references missing block4294967295"
        }
        10 => {
            generated.root_region = RegionId(u32::MAX);
            "missing root region4294967295"
        }
        11 => {
            generated.regions[0].entry = BlockId(1);
            "root region0 entry block1 does not match function body entry block0"
        }
        12 => {
            generated.regions[selected_region].parent = None;
            "has no parent"
        }
        13 => {
            generated.regions[selected_region].kind = RegionKind::Function;
            "is also a function region"
        }
        14 => {
            generated
                .blocks
                .last_mut()
                .expect("generated block")
                .terminator = Terminator::new(
                TerminatorKind::Jump(Edge::new(BlockId(0), Vec::new())),
                source(),
            );
            "function entry block0 has an incoming CFG edge"
        }
        _ => unreachable!(),
    }
}

#[hegel::test(test_cases = 600, derandomize = true, database = None)]
fn cfg_entity_mutations_fail_closed_with_targeted_diagnostics(tc: TestCase) {
    let block_count = tc.draw(gs::integers::<usize>().min_value(2).max_value(20));
    let mutation = tc.draw(gs::integers::<u8>().max_value(14));
    let selected_block = match mutation {
        4 => tc.draw(gs::integers::<usize>().max_value(block_count - 2)),
        _ => tc.draw(gs::integers::<usize>().max_value(block_count - 1)),
    };
    let selected_region = tc.draw(
        gs::integers::<usize>()
            .min_value(1)
            .max_value(block_count - 1),
    );
    let mut program = nested_linear_program(block_count);
    assert_valid(&program, "nested linear identifier baseline");
    let expected =
        apply_identifier_mutation(&mut program, mutation, selected_block, selected_region);
    assert_error_contains(
        &program,
        &format!("CFG entity mutation {mutation}"),
        &[expected],
    );
}

#[test]
fn every_cfg_entity_mutation_has_a_targeted_diagnostic() {
    for mutation in 0..=14 {
        let mut program = nested_linear_program(4);
        let expected = apply_identifier_mutation(&mut program, mutation, 1, 2);
        assert_error_contains(
            &program,
            &format!("exhaustive CFG entity mutation {mutation}"),
            &[expected],
        );
    }
}

fn draw_region_parents(tc: &TestCase) -> Vec<Option<usize>> {
    let region_count = tc.draw(gs::integers::<usize>().min_value(2).max_value(24));
    let mut parents = Vec::with_capacity(region_count);
    parents.push(None);
    for region in 1..region_count {
        parents.push(Some(tc.draw(gs::integers::<usize>().max_value(region - 1))));
    }
    parents
}

fn region_tree_program(parents: &[Option<usize>]) -> Program {
    let blocks = parents
        .iter()
        .enumerate()
        .map(|(index, _)| return_block(BlockId(index as u32), RegionId(index as u32), Vec::new()))
        .collect();
    let regions = parents
        .iter()
        .enumerate()
        .map(|(index, parent)| {
            if index == 0 {
                root_region(BlockId(0))
            } else {
                Region {
                    id: RegionId(index as u32),
                    parent: parent.map(|parent| RegionId(parent as u32)),
                    kind: RegionKind::CompilerGenerated,
                    entry: BlockId(index as u32),
                    source: source(),
                }
            }
        })
        .collect();
    program_with_body(
        function_type(vec![], vec![]),
        BlockId(0),
        RegionId(0),
        blocks,
        regions,
    )
}

fn region_contains_oracle(parents: &[Option<usize>], ancestor: usize, mut owner: usize) -> bool {
    loop {
        if owner == ancestor {
            return true;
        }
        let Some(parent) = parents[owner] else {
            return false;
        };
        owner = parent;
    }
}

#[hegel::test(test_cases = 600, derandomize = true, database = None)]
fn generated_region_entry_ownership_matches_parent_tree_oracle(tc: TestCase) {
    let parents = draw_region_parents(&tc);
    let mut program = region_tree_program(&parents);
    assert_valid(&program, "generated region tree baseline");

    let mut reordered = program.clone();
    body_mut(&mut reordered).blocks.reverse();
    body_mut(&mut reordered).regions.reverse();
    assert_valid(&reordered, "storage-reordered region tree");

    let region = tc.draw(
        gs::integers::<usize>()
            .min_value(1)
            .max_value(parents.len() - 1),
    );
    let owner = tc.draw(gs::integers::<usize>().max_value(parents.len() - 1));
    body_mut(&mut program).regions[region].entry = BlockId(owner as u32);
    let expected = region_contains_oracle(&parents, region, owner);
    let result = verify(&program);
    if expected {
        property_assert!(
            result.is_ok(),
            "descendant-owned region entry was rejected: region={region}, owner={owner}, parents={parents:?}\n{result:?}"
        );
    } else {
        let error = match result {
            Ok(()) => property_panic!(
                "unrelated region entry owner was accepted: region={region}, owner={owner}, parents={parents:?}"
            ),
            Err(error) => error,
        };
        property_assert!(
            error.contains("is owned by unrelated"),
            "unrelated region entry lacked its diagnostic: region={region}, owner={owner}, parents={parents:?}\n{error}"
        );
    }
}

fn unreachable_parameter_chain(block_count: usize) -> Program {
    let mut blocks = vec![return_block(BlockId(0), RegionId(0), Vec::new())];
    for offset in 0..block_count {
        let index = offset + 1;
        let parameter = (offset > 0)
            .then(|| ValueDefinition::new(ValueId(2_000 + index as u32), ValueType::I32));
        let mut block = return_block(
            BlockId(index as u32),
            RegionId(0),
            parameter.iter().cloned().collect(),
        );
        if let Some(parameter) = parameter {
            block
                .instructions
                .push(drop_i32(2_000 + index as u32, parameter.id));
        }
        let local = ValueId(1_000 + index as u32);
        block
            .instructions
            .push(i32_const(1_000 + index as u32, local.0, index as i32));
        if offset + 1 < block_count {
            block.terminator = Terminator::new(
                TerminatorKind::Jump(Edge::new(BlockId(index as u32 + 1), vec![local])),
                source(),
            );
        }
        blocks.push(block);
    }
    program_with_body(
        function_type(vec![], vec![]),
        BlockId(0),
        RegionId(0),
        blocks,
        vec![root_region(BlockId(0))],
    )
}

#[hegel::test(test_cases = 400, derandomize = true, database = None)]
fn unreachable_components_require_explicit_block_parameters(tc: TestCase) {
    let block_count = tc.draw(gs::integers::<usize>().min_value(2).max_value(20));
    let mut program = unreachable_parameter_chain(block_count);
    assert_valid(&program, "unreachable block-parameter chain");

    let use_block = tc.draw(gs::integers::<usize>().min_value(2).max_value(block_count));
    let candidate = tc.draw(
        gs::integers::<usize>()
            .min_value(1)
            .max_value(block_count - 1),
    );
    let definition_block = if candidate >= use_block {
        candidate + 1
    } else {
        candidate
    };
    let replacement = ValueId(1_000 + definition_block as u32);
    let target = block_mut(&mut program, BlockId(use_block as u32));
    target.instructions[0].operands[0] = replacement;
    assert_error_contains(
        &program,
        &format!(
            "cross-block value in unreachable component from block{definition_block} to block{use_block}"
        ),
        &["does not dominate its use"],
    );
}

fn reachable_merge_with_dead_predecessors(dead_predecessors: usize) -> Program {
    let mut entry = return_block(BlockId(0), RegionId(0), Vec::new());
    entry.instructions.push(i32_const(0, 0, 0));
    entry.terminator = Terminator::new(
        TerminatorKind::Jump(Edge::new(BlockId(1), Vec::new())),
        source(),
    );

    let mut merge = return_block(BlockId(1), RegionId(0), Vec::new());
    merge.instructions.push(drop_i32(1, ValueId(0)));
    let mut blocks = vec![entry, merge];
    for offset in 0..dead_predecessors {
        let block = 2 + offset as u32;
        let value = 1_000 + offset as u32;
        let mut dead = return_block(BlockId(block), RegionId(0), Vec::new());
        dead.instructions
            .push(i32_const(100 + offset as u32, value, offset as i32));
        dead.terminator = Terminator::new(
            TerminatorKind::Jump(Edge::new(BlockId(1), Vec::new())),
            source(),
        );
        blocks.push(dead);
    }
    program_with_body(
        function_type(vec![], vec![]),
        BlockId(0),
        RegionId(0),
        blocks,
        vec![root_region(BlockId(0))],
    )
}

#[hegel::test(test_cases = 400, derandomize = true, database = None)]
fn unreachable_predecessors_do_not_pollute_reachable_dominance(tc: TestCase) {
    let dead_predecessors = tc.draw(gs::integers::<usize>().min_value(1).max_value(16));
    let selected = tc.draw(gs::integers::<usize>().max_value(dead_predecessors - 1));
    let mut program = reachable_merge_with_dead_predecessors(dead_predecessors);
    assert_valid(
        &program,
        "reachable definition at a merge with dead predecessors",
    );

    body_mut(&mut program).blocks.reverse();
    assert_valid(&program, "storage-reordered merge with dead predecessors");
    block_mut(&mut program, BlockId(1)).instructions[0].operands[0] =
        ValueId(1_000 + selected as u32);
    assert_error_contains(
        &program,
        &format!("dead predecessor {selected} value used by the reachable merge"),
        &["does not dominate its use"],
    );
}

fn reference(nullable: bool, heap: HeapType) -> ValueType {
    ValueType::Ref(RefType { nullable, heap })
}

fn draw_refinement_heap(tc: &TestCase) -> HeapType {
    match tc.draw(gs::integers::<u8>().max_value(7)) {
        0 => HeapType::Any,
        1 => HeapType::Eq,
        2 => HeapType::I31,
        3 => HeapType::Struct,
        4 => HeapType::Array,
        5 => HeapType::Func,
        6 => HeapType::Extern,
        7 => HeapType::Exn,
        _ => unreachable!(),
    }
}

fn ref_is_null_program(heap: HeapType) -> Program {
    let nullable = reference(true, heap.clone());
    let non_null = reference(false, heap);
    let mut entry = return_block(
        BlockId(0),
        RegionId(0),
        vec![ValueDefinition::new(ValueId(0), nullable.clone())],
    );
    entry.instructions.push(Instruction::new(
        InstructionId(0),
        Operation::core(
            CoreOpcode::RefIsNull,
            vec![nullable.clone()],
            vec![ValueType::I32],
        ),
        vec![ValueId(0)],
        vec![ValueDefinition::new(ValueId(1), ValueType::I32)],
        source(),
    ));
    entry.terminator = Terminator::new(
        TerminatorKind::Branch {
            condition: ValueId(1),
            then_edge: Edge::new(BlockId(1), vec![ValueId(0)]),
            else_edge: Edge::new(BlockId(2), vec![ValueId(0)]).with_refinement(0, non_null.clone()),
        },
        source(),
    );
    let then_block = return_block(
        BlockId(1),
        RegionId(0),
        vec![ValueDefinition::new(ValueId(2), nullable.clone())],
    );
    let else_block = return_block(
        BlockId(2),
        RegionId(0),
        vec![ValueDefinition::new(ValueId(3), non_null)],
    );
    program_with_body(
        function_type(vec![nullable], vec![]),
        BlockId(0),
        RegionId(0),
        vec![entry, then_block, else_block],
        vec![root_region(BlockId(0))],
    )
}

#[hegel::test(test_cases = 500, derandomize = true, database = None)]
fn ref_is_null_refinement_is_confined_to_the_false_edge(tc: TestCase) {
    let heap = draw_refinement_heap(&tc);
    let mutation = tc.draw(gs::integers::<u8>().max_value(4));
    let mut program = ref_is_null_program(heap.clone());
    assert_valid(&program, "ref.is_null false-edge refinement baseline");

    let entry = block_mut(&mut program, BlockId(0));
    let expected = match mutation {
        0 => {
            let TerminatorKind::Branch {
                then_edge,
                else_edge,
                ..
            } = &mut entry.terminator.kind
            else {
                unreachable!()
            };
            then_edge.refinements.push(else_edge.refinements[0].clone());
            else_edge.refinements.clear();
            "true edge of ref.is_null does not prove non-nullness"
        }
        1 => {
            let TerminatorKind::Branch { else_edge, .. } = &mut entry.terminator.kind else {
                unreachable!()
            };
            else_edge.refinements.clear();
            "expected (ref"
        }
        2 => {
            let TerminatorKind::Branch { else_edge, .. } = &mut entry.terminator.kind else {
                unreachable!()
            };
            let proven = else_edge.refinements[0].proven.clone();
            else_edge.refinements.push(Refinement { slot: 1, proven });
            "refines missing argument slot 1"
        }
        3 => {
            let TerminatorKind::Branch { else_edge, .. } = &mut entry.terminator.kind else {
                unreachable!()
            };
            let proven = else_edge.refinements[0].proven.clone();
            else_edge.refinements.push(Refinement { slot: 0, proven });
            "refines argument slot 0 more than once"
        }
        4 => {
            let TerminatorKind::Branch { else_edge, .. } = &entry.terminator.kind else {
                unreachable!()
            };
            entry.terminator = Terminator::new(TerminatorKind::Jump(else_edge.clone()), source());
            "carries conditional refinements on a non-branch edge"
        }
        _ => unreachable!(),
    };
    assert_error_contains(
        &program,
        &format!("ref.is_null refinement mutation {mutation} for {heap}"),
        &[expected],
    );
}
