// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! End-to-end contracts for structured WebAssembly control-flow lowering.

use std::collections::{BTreeMap, BTreeSet};

use wedge::Compiler;
use wedge::ir::{
    Block, BlockId, Edge, ExportItem, Function, FunctionBody, Immediate, Program, Region,
    RegionKind, TerminatorKind, ValueId, ValueType,
};
mod fixture_support;

use fixture_support::{block, compile_fixture, exported_function};

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn body<'a>(program: &'a Program, name: &str) -> &'a FunctionBody {
    exported_function(program, name)
        .body
        .as_ref()
        .unwrap_or_else(|| panic!("exported function {name:?} has no body"))
}

fn region<'a>(body: &'a FunctionBody, block: &Block) -> &'a Region {
    body.regions
        .iter()
        .find(|region| region.id == block.region)
        .unwrap_or_else(|| panic!("missing {}", block.region))
}

fn outgoing_edges(terminator: &TerminatorKind) -> Vec<&Edge> {
    terminator.edges().collect()
}

fn incoming_edges(body: &FunctionBody, target: BlockId) -> Vec<(BlockId, &Edge)> {
    body.blocks
        .iter()
        .flat_map(|source| {
            outgoing_edges(&source.terminator.kind)
                .into_iter()
                .filter(move |edge| edge.target == target)
                .map(move |edge| (source.id, edge))
        })
        .collect()
}

fn reachable_blocks(body: &FunctionBody) -> BTreeSet<BlockId> {
    let mut reachable = BTreeSet::new();
    let mut pending = vec![body.entry];
    while let Some(id) = pending.pop() {
        if !reachable.insert(id) {
            continue;
        }
        pending.extend(
            outgoing_edges(&block(body, id).terminator.kind)
                .into_iter()
                .map(|edge| edge.target),
        );
    }
    reachable
}

fn block_is_within_region(body: &FunctionBody, block_id: BlockId, ancestor: &Region) -> bool {
    let mut region_id = Some(block(body, block_id).region);
    while let Some(id) = region_id {
        if id == ancestor.id {
            return true;
        }
        region_id = body.regions[id.index()].parent;
    }
    false
}

fn continuation_for_region<'a>(body: &'a FunctionBody, construct: &Region) -> &'a Block {
    let parent = construct.parent.expect("structured region parent");
    body.blocks
        .iter()
        .find(|candidate| {
            candidate.region == parent
                && incoming_edges(body, candidate.id)
                    .iter()
                    .any(|(source, _)| block_is_within_region(body, *source, construct))
        })
        .unwrap_or_else(|| panic!("missing continuation for {}", construct.id))
}

fn i32_constants(body: &FunctionBody) -> BTreeMap<ValueId, i32> {
    body.blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| {
            match (
                instruction.operation.mnemonic(),
                instruction.operation.immediates.as_slice(),
                instruction.results.as_slice(),
            ) {
                ("i32.const", [Immediate::S32(value)], [result]) => Some((result.id, *value)),
                _ => None,
            }
        })
        .collect()
}

#[test]
fn block_result_and_br_if_become_typed_edges() {
    let program = compile_fixture("control_flow");
    let body = body(&program, "choose");
    let branch_block = body
        .blocks
        .iter()
        .find(|block| matches!(block.terminator.kind, TerminatorKind::Branch { .. }))
        .expect("br_if block");
    let (then_edge, else_edge) = match &branch_block.terminator.kind {
        TerminatorKind::Branch {
            then_edge,
            else_edge,
            ..
        } => (then_edge, else_edge),
        _ => unreachable!(),
    };

    assert_eq!(region(body, branch_block).kind, RegionKind::Block);
    assert_eq!(then_edge.arguments.len(), 1);
    assert!(else_edge.arguments.is_empty());

    let join = block(body, then_edge.target);
    assert_eq!(join.region, body.root_region);
    assert_eq!(join.parameters.len(), 1);
    assert_eq!(join.parameters[0].ty, ValueType::I32);
    let incoming = incoming_edges(body, join.id);
    assert_eq!(incoming.len(), 2);
    assert!(incoming.iter().all(|(_, edge)| edge.arguments.len() == 1));
    assert_eq!(
        incoming
            .iter()
            .map(|(_, edge)| edge.arguments[0])
            .collect::<BTreeSet<_>>()
            .len(),
        2,
        "the taken and fallthrough paths produce distinct block results"
    );
    assert!(matches!(
        &join.terminator.kind,
        TerminatorKind::Return { values } if values == &[join.parameters[0].id]
    ));
}

#[test]
fn br_table_preserves_duplicate_targets_and_arguments() {
    let program = compile_fixture("control_flow");
    let body = body(&program, "dispatch");
    let switch = body
        .blocks
        .iter()
        .find_map(|block| match &block.terminator.kind {
            TerminatorKind::Switch {
                targets, default, ..
            } => Some((targets, default)),
            _ => None,
        })
        .expect("br_table switch");

    assert_eq!(switch.0.len(), 1);
    assert_eq!(switch.0[0].target, switch.1.target);
    assert_eq!(switch.0[0].arguments, switch.1.arguments);
    assert_eq!(switch.1.arguments.len(), 1);

    let target = block(body, switch.1.target);
    assert_eq!(target.parameters.len(), 1);
    assert_eq!(target.parameters[0].ty, ValueType::I32);
    assert_eq!(incoming_edges(body, target.id).len(), 2);
}

#[test]
fn typed_loop_uses_parameters_for_its_label_and_results_for_its_exit() {
    let program = compile_fixture("structured_control");
    let body = body(&program, "typed_loop");
    let loop_region = body
        .regions
        .iter()
        .find(|region| region.kind == RegionKind::Loop)
        .expect("loop region");
    let header = block(body, loop_region.entry);

    assert_eq!(
        header
            .parameters
            .iter()
            .map(|parameter| parameter.ty.clone())
            .collect::<Vec<_>>(),
        [ValueType::I32, ValueType::I32]
    );
    let incoming = incoming_edges(body, header.id);
    assert_eq!(incoming.len(), 2, "entry edge plus loop backedge");
    assert!(
        incoming
            .iter()
            .all(|(_, edge)| edge.arguments.len() == header.parameters.len())
    );

    let (backedge, fallthrough) = match &header.terminator.kind {
        TerminatorKind::Branch {
            then_edge,
            else_edge,
            ..
        } => (then_edge, else_edge),
        other => panic!("loop header should end in br_if, found {other:?}"),
    };
    assert_eq!(backedge.target, header.id);
    assert_eq!(
        backedge.arguments,
        header
            .parameters
            .iter()
            .map(|parameter| parameter.id)
            .collect::<Vec<_>>()
    );
    assert_ne!(fallthrough.target, header.id);

    let return_block = body
        .blocks
        .iter()
        .find(|block| matches!(block.terminator.kind, TerminatorKind::Return { .. }))
        .expect("normal loop continuation");
    assert_eq!(return_block.parameters.len(), 1);
    assert_eq!(return_block.parameters[0].ty, ValueType::I32);
}

#[test]
fn explicit_if_else_has_sibling_regions_and_one_typed_join() {
    let program = compile_fixture("structured_control");
    let body = body(&program, "if_else");
    let then_region = body
        .regions
        .iter()
        .find(|region| region.kind == RegionKind::IfThen)
        .expect("then region");
    let else_region = body
        .regions
        .iter()
        .find(|region| region.kind == RegionKind::IfElse)
        .expect("else region");
    assert_eq!(then_region.parent, else_region.parent);

    let entry = block(body, body.entry);
    match &entry.terminator.kind {
        TerminatorKind::Branch {
            then_edge,
            else_edge,
            ..
        } => {
            assert_eq!(then_edge.target, then_region.entry);
            assert_eq!(else_edge.target, else_region.entry);
        }
        other => panic!("if should lower to a branch, found {other:?}"),
    }

    let join = body
        .blocks
        .iter()
        .find(|block| incoming_edges(body, block.id).len() == 2 && block.parameters.len() == 1)
        .expect("if result join");
    assert_eq!(join.parameters[0].ty, ValueType::I32);
    assert!(matches!(
        join.terminator.kind,
        TerminatorKind::Return { .. }
    ));
}

#[test]
fn reachable_nested_constructs_preserve_region_hierarchy_and_typed_joins() {
    let program = compile_fixture("structured_control");
    let body = body(&program, "nested_reachable");
    assert_eq!(reachable_blocks(body).len(), body.blocks.len());

    let outer = body
        .regions
        .iter()
        .find(|region| region.kind == RegionKind::Block)
        .expect("reachable outer block region");
    let then_region = body
        .regions
        .iter()
        .find(|region| region.kind == RegionKind::IfThen)
        .expect("reachable nested then region");
    let else_region = body
        .regions
        .iter()
        .find(|region| region.kind == RegionKind::IfElse)
        .expect("reachable nested else region");
    assert_eq!(outer.parent, Some(body.root_region));
    assert_eq!(then_region.parent, Some(outer.id));
    assert_eq!(else_region.parent, Some(outer.id));

    let inner_join = body
        .blocks
        .iter()
        .find(|block| {
            block.region == outer.id
                && block.parameters.len() == 1
                && incoming_edges(body, block.id).len() == 2
        })
        .expect("typed join inside the outer block");
    assert_eq!(inner_join.parameters[0].ty, ValueType::I32);
    let inner_incoming = incoming_edges(body, inner_join.id);
    assert_eq!(inner_incoming.len(), 2);
    assert_eq!(
        inner_incoming
            .iter()
            .map(|(source, _)| block(body, *source).region)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([then_region.id, else_region.id])
    );
    assert!(
        inner_incoming
            .iter()
            .all(|(_, edge)| edge.arguments.len() == 1)
    );

    let outer_join = body
        .blocks
        .iter()
        .find(|block| {
            block.region == body.root_region
                && block.parameters.len() == 1
                && incoming_edges(body, block.id)
                    .iter()
                    .any(|(source, _)| block_is_within_region(body, *source, outer))
        })
        .expect("typed continuation outside the outer block");
    assert_eq!(outer_join.parameters[0].ty, ValueType::I32);
    let outer_incoming = incoming_edges(body, outer_join.id);
    assert_eq!(outer_incoming.len(), 1);
    assert_eq!(outer_incoming[0].0, inner_join.id);
    assert_eq!(outer_incoming[0].1.arguments.len(), 1);
    let TerminatorKind::Return { values } = &outer_join.terminator.kind else {
        panic!("outer continuation must return");
    };
    assert_eq!(values, &[outer_join.parameters[0].id]);
}

#[test]
fn omitted_else_is_an_explicit_identity_path() {
    let program = compile_fixture("structured_control");
    let body = body(&program, "implicit_else");
    let entry = block(body, body.entry);
    let (then_edge, else_edge) = match &entry.terminator.kind {
        TerminatorKind::Branch {
            then_edge,
            else_edge,
            ..
        } => (then_edge, else_edge),
        other => panic!("if should lower to a branch, found {other:?}"),
    };

    assert_eq!(then_edge.arguments.len(), 1);
    assert_eq!(then_edge.arguments, else_edge.arguments);
    let then_block = block(body, then_edge.target);
    let else_block = block(body, else_edge.target);
    assert_eq!(then_block.parameters.len(), 1);
    assert_eq!(else_block.parameters.len(), 1);
    assert!(then_block.instructions.is_empty());
    assert!(else_block.instructions.is_empty());
    assert_eq!(region(body, then_block).kind, RegionKind::IfThen);
    assert_eq!(region(body, else_block).kind, RegionKind::IfElse);

    let then_target = outgoing_edges(&then_block.terminator.kind)[0].target;
    let else_target = outgoing_edges(&else_block.terminator.kind)[0].target;
    assert_eq!(then_target, else_target);
}

#[test]
fn branch_to_the_function_label_uses_a_typed_return_bridge() {
    let program = compile_fixture("structured_control");
    let body = body(&program, "function_branch");
    let entry = block(body, body.entry);
    let edge = match &entry.terminator.kind {
        TerminatorKind::Jump(edge) => edge,
        other => panic!("function-label branch should be a jump, found {other:?}"),
    };
    let bridge = block(body, edge.target);

    assert_eq!(edge.arguments.len(), 1);
    assert_eq!(bridge.parameters.len(), 1);
    assert_eq!(bridge.parameters[0].ty, ValueType::I32);
    assert_eq!(bridge.region, body.root_region);
    assert!(bridge.source.byte_span.is_none());
    assert!(bridge.source.ordinal.is_none());
    assert!(matches!(
        &bridge.terminator.kind,
        TerminatorKind::Return { values } if values == &[bridge.parameters[0].id]
    ));
}

#[test]
fn nested_dead_control_has_no_reachable_phantom_edges() {
    let program = compile_fixture("structured_control");
    let body = body(&program, "nested_dead");
    let reachable = reachable_blocks(body);
    let dead: Vec<_> = body
        .blocks
        .iter()
        .filter(|block| !reachable.contains(&block.id))
        .collect();

    assert!(
        dead.len() >= 3,
        "nested dead syntax should remain attributable"
    );
    assert!(
        dead.iter()
            .all(|block| matches!(block.terminator.kind, TerminatorKind::Unreachable { .. }))
    );
    assert!(
        dead.iter()
            .all(|block| outgoing_edges(&block.terminator.kind).is_empty())
    );

    let loop_region = body
        .regions
        .iter()
        .find(|region| region.kind == RegionKind::Loop)
        .expect("dead nested loop region");
    let inner_block = body
        .regions
        .iter()
        .find(|region| Some(region.id) == loop_region.parent)
        .expect("loop parent region");
    let outer_block = body
        .regions
        .iter()
        .find(|region| Some(region.id) == inner_block.parent)
        .expect("nested block parent region");
    assert_eq!(inner_block.kind, RegionKind::Block);
    assert_eq!(outer_block.kind, RegionKind::Block);
    assert_eq!(outer_block.parent, Some(body.root_region));
}

#[test]
fn values_below_a_block_height_dominate_its_continuation() {
    let program = compile_fixture("structured_control");
    let body = body(&program, "branch_prefix");
    let definitions: BTreeMap<_, _> =
        body.blocks
            .iter()
            .flat_map(|block| {
                block.instructions.iter().flat_map(move |instruction| {
                    instruction.results.iter().map(move |result| {
                        (result.id, (block.id, instruction.operation.mnemonic()))
                    })
                })
            })
            .collect();
    let (add_block, add) = body
        .blocks
        .iter()
        .find_map(|block| {
            block
                .instructions
                .iter()
                .find(|instruction| instruction.operation.mnemonic == "i32.add")
                .map(|instruction| (block, instruction))
        })
        .expect("i32.add after block");

    assert_eq!(add.operands.len(), 2);
    assert_eq!(definitions[&add.operands[0]].0, body.entry);
    assert_eq!(definitions[&add.operands[0]].1, "i32.const");
    assert_eq!(definitions[&add.operands[1]].0, add_block.id);
    assert_eq!(definitions[&add.operands[1]].1, "i32.const");
}

#[test]
fn structured_results_precede_local_ssa_parameters_on_a_shared_join() {
    let program = compile_fixture("structured_control");
    let body = body(&program, "mixed_join");
    let constants = i32_constants(body);
    let join = body
        .blocks
        .iter()
        .find(|block| {
            matches!(block.terminator.kind, TerminatorKind::Return { .. })
                && block.parameters.len() == 2
        })
        .expect("mixed structured/local join");
    let incoming = incoming_edges(body, join.id);

    assert_eq!(incoming.len(), 2);
    assert!(incoming.iter().all(|(_, edge)| edge.arguments.len() == 2));
    assert_eq!(
        incoming
            .iter()
            .map(|(_, edge)| constants[&edge.arguments[0]])
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([10, 20]),
        "first argument is the WebAssembly block result"
    );
    assert_eq!(
        incoming
            .iter()
            .map(|(_, edge)| constants[&edge.arguments[1]])
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([1, 2]),
        "second argument is the local SSA merge"
    );
    assert!(matches!(
        &join.terminator.kind,
        TerminatorKind::Return { values }
            if values == &join.parameters.iter().map(|parameter| parameter.id).collect::<Vec<_>>()
    ));
}

#[test]
fn structured_continuations_begin_at_their_closing_end_boundary() {
    let program = compile_fixture("structured_control");
    for (function, kind) in [
        ("branch_prefix", RegionKind::Block),
        ("typed_loop", RegionKind::Loop),
        ("if_else", RegionKind::IfElse),
    ] {
        let body = body(&program, function);
        let construct = body
            .regions
            .iter()
            .find(|region| region.kind == kind)
            .unwrap_or_else(|| panic!("missing {kind:?} region in {function}"));
        let continuation = continuation_for_region(body, construct);
        let construct_span = construct.source.byte_span.expect("construct source span");
        let continuation_span = continuation
            .source
            .byte_span
            .expect("continuation source span");

        assert_eq!(
            continuation_span.start, construct_span.end,
            "{function} continuation starts before its closing end"
        );
        assert!(
            continuation_span.is_valid(),
            "{function} continuation source span is reversed"
        );
    }
}
