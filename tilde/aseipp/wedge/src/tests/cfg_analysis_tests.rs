// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Contract tests for target-independent control-flow analysis.

use std::collections::BTreeSet;

use wedge::cfg::{
    BranchDirection, BuildError, ControlFlowGraph, EdgeClass, EdgeKind, EdgeSite, ExitKind,
    ExitOrigin, ExitPolicy, PostDominatorNode,
};
use wedge::ir::{
    Block, BlockId, Callee, CatchClause, CatchKind, Edge as IrEdge, Effects, ExceptionEffect,
    ExceptionRouting, ExceptionalArgument, ExceptionalEdge, FunctionBody, FunctionId, Instruction,
    InstructionId, Operation, Region, RegionId, RegionKind, SourceInfo, TagId, Terminator,
    TerminatorKind, TrapCode, ValueId, ValueType,
};

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn source() -> SourceInfo {
    SourceInfo::synthetic()
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

fn try_region(id: RegionId, entry: BlockId, catches: Vec<CatchClause>) -> Region {
    Region {
        id,
        parent: Some(RegionId(0)),
        kind: RegionKind::TryTable { catches },
        entry,
        source: source(),
    }
}

fn block(id: BlockId, region: RegionId, kind: TerminatorKind) -> Block {
    Block {
        id,
        region,
        parameters: Vec::new(),
        instructions: Vec::new(),
        terminator: Terminator::new(kind, source()),
        source: source(),
    }
}

fn return_block(id: BlockId) -> Block {
    block(
        id,
        RegionId(0),
        TerminatorKind::Return { values: Vec::new() },
    )
}

fn body(entry: BlockId, blocks: Vec<Block>) -> FunctionBody {
    FunctionBody {
        entry,
        root_region: RegionId(0),
        blocks,
        regions: vec![root_region(entry)],
    }
}

fn body_with_regions(entry: BlockId, blocks: Vec<Block>, regions: Vec<Region>) -> FunctionBody {
    FunctionBody {
        entry,
        root_region: RegionId(0),
        blocks,
        regions,
    }
}

fn jump_block(id: BlockId, target: BlockId) -> Block {
    block(
        id,
        RegionId(0),
        TerminatorKind::Jump(IrEdge::new(target, Vec::new())),
    )
}

fn branch_block(id: BlockId, then_target: BlockId, else_target: BlockId) -> Block {
    block(
        id,
        RegionId(0),
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: IrEdge::new(then_target, Vec::new()),
            else_edge: IrEdge::new(else_target, Vec::new()),
        },
    )
}

fn routed_throw(handler: RegionId, clause: u32, target: BlockId) -> Terminator {
    Terminator::new(
        TerminatorKind::Throw {
            tag: TagId(0),
            arguments: Vec::new(),
        },
        source(),
    )
    .with_exception_routing(ExceptionRouting {
        arms: vec![ExceptionalEdge::new(handler, clause, target, Vec::new())],
        escapes: false,
    })
}

fn routed_invoke(normal: BlockId, arms: Vec<ExceptionalEdge>) -> Terminator {
    Terminator::new(
        TerminatorKind::Invoke {
            operation: Operation::synthetic("wedge.test_throwing", Vec::new(), Vec::new()),
            operands: Vec::new(),
            effects: Effects {
                exception: ExceptionEffect::MayThrow,
                ..Effects::pure()
            },
            normal: IrEdge::new(normal, Vec::new()),
        },
        source(),
    )
    .with_exception_routing(ExceptionRouting {
        arms,
        escapes: false,
    })
}

fn build_errors(body: &FunctionBody) -> Vec<BuildError> {
    ControlFlowGraph::new(body)
        .expect_err("malformed CFG should fail strict construction")
        .into_errors()
}

#[test]
fn strict_construction_rejects_duplicate_block_identifiers() {
    let entry = BlockId(7);
    let malformed = body(entry, vec![return_block(entry), return_block(entry)]);

    assert_eq!(
        build_errors(&malformed),
        vec![BuildError::DuplicateBlock(entry)]
    );
}

#[test]
fn strict_construction_rejects_duplicate_region_identifiers() {
    let entry = BlockId(7);
    let malformed = body_with_regions(
        entry,
        vec![return_block(entry)],
        vec![root_region(entry), root_region(entry)],
    );

    assert_eq!(
        build_errors(&malformed),
        vec![BuildError::DuplicateRegion(RegionId(0))]
    );
}

#[test]
fn strict_construction_rejects_a_missing_entry() {
    let missing = BlockId(99);
    let malformed = body(missing, vec![return_block(BlockId(7))]);

    assert_eq!(
        build_errors(&malformed),
        vec![BuildError::MissingEntry(missing)]
    );
}

#[test]
fn strict_construction_rejects_a_missing_ordinary_target() {
    let source_block = BlockId(7);
    let missing = BlockId(99);
    let malformed = body(source_block, vec![jump_block(source_block, missing)]);

    assert_eq!(
        build_errors(&malformed),
        vec![BuildError::MissingTarget {
            block: source_block,
            target: missing,
        }]
    );
}

#[test]
fn strict_construction_rejects_a_missing_exception_target() {
    let source_block = BlockId(7);
    let missing = BlockId(99);
    let handler = RegionId(5);
    let mut throwing = return_block(source_block);
    throwing.region = handler;
    throwing.terminator = routed_throw(handler, 0, missing);
    let malformed = body_with_regions(
        source_block,
        vec![throwing],
        vec![
            root_region(source_block),
            try_region(
                handler,
                source_block,
                vec![CatchClause {
                    kind: CatchKind::CatchAll,
                    tag: None,
                    target: missing,
                }],
            ),
        ],
    );

    assert_eq!(
        build_errors(&malformed),
        vec![BuildError::MissingTarget {
            block: source_block,
            target: missing,
        }]
    );
}

#[test]
fn strict_construction_aggregates_errors_in_deterministic_order() {
    let missing_entry = BlockId(999);
    let duplicate = BlockId(7);
    let exceptional_source = BlockId(8);
    let missing_target = BlockId(99);
    let missing_catch_target = BlockId(98);
    let duplicate_replacement = jump_block(duplicate, missing_target);
    let mut throwing = return_block(exceptional_source);
    throwing.terminator = routed_throw(RegionId(55), 0, missing_catch_target);
    let malformed = body_with_regions(
        missing_entry,
        vec![return_block(duplicate), duplicate_replacement, throwing],
        vec![root_region(missing_entry), root_region(missing_entry)],
    );

    assert_eq!(
        build_errors(&malformed),
        vec![
            BuildError::DuplicateBlock(duplicate),
            BuildError::DuplicateRegion(RegionId(0)),
            BuildError::MissingEntry(missing_entry),
            BuildError::MissingTarget {
                block: duplicate,
                target: missing_target,
            },
            BuildError::MissingTarget {
                block: exceptional_source,
                target: missing_catch_target,
            },
        ]
    );
}

#[test]
fn sparse_identifiers_and_storage_reordering_do_not_change_the_graph() {
    let entry = BlockId(10);
    let left = BlockId(55);
    let right = BlockId(90);
    let entry_block = block(
        entry,
        RegionId(0),
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: IrEdge::new(right, Vec::new()),
            else_edge: IrEdge::new(left, Vec::new()),
        },
    );
    let left_block = return_block(left);
    let right_block = return_block(right);
    let ordered = body(
        entry,
        vec![entry_block.clone(), left_block.clone(), right_block.clone()],
    );
    let reordered = body(entry, vec![right_block, entry_block, left_block]);

    let ordered_graph = ControlFlowGraph::new(&ordered).expect("ordered sparse CFG");
    let reordered_graph = ControlFlowGraph::new(&reordered).expect("reordered sparse CFG");
    let project = |graph: &ControlFlowGraph<'_>| {
        graph
            .edges()
            .map(|edge| (edge.source, edge.target, edge.kind))
            .collect::<Vec<_>>()
    };

    assert_eq!(
        ordered_graph.blocks().collect::<Vec<_>>(),
        vec![entry, left, right]
    );
    assert_eq!(project(&ordered_graph), project(&reordered_graph));
    assert_eq!(
        ordered_graph.reverse_postorder(),
        reordered_graph.reverse_postorder()
    );
    assert_eq!(
        ordered_graph.reachable_blocks(),
        reordered_graph.reachable_blocks()
    );
}

#[test]
fn sparse_reordered_try_table_regions_resolve_the_same_exception_edge() {
    let entry = BlockId(10);
    let catch_target = BlockId(90);
    let handler = RegionId(55);
    let mut throwing = return_block(entry);
    throwing.region = handler;
    throwing.terminator = routed_throw(handler, 0, catch_target);
    let catches = vec![CatchClause {
        kind: CatchKind::CatchAll,
        tag: None,
        target: catch_target,
    }];
    let ordered = body_with_regions(
        entry,
        vec![throwing.clone(), return_block(catch_target)],
        vec![
            root_region(entry),
            try_region(handler, entry, catches.clone()),
        ],
    );
    let reordered = body_with_regions(
        entry,
        vec![return_block(catch_target), throwing],
        vec![try_region(handler, entry, catches), root_region(entry)],
    );

    let ordered_graph = ControlFlowGraph::new(&ordered).expect("ordered sparse EH CFG");
    let reordered_graph = ControlFlowGraph::new(&reordered).expect("reordered sparse EH CFG");
    let project_edges = |graph: &ControlFlowGraph<'_>| {
        graph
            .edges()
            .map(|edge| (edge.id.index(), edge.source, edge.target, edge.kind))
            .collect::<Vec<_>>()
    };
    let project_exits = |graph: &ControlFlowGraph<'_>| {
        graph
            .exits()
            .map(|exit| (exit.id.index(), exit.source, exit.origin, exit.kind.clone()))
            .collect::<Vec<_>>()
    };

    assert_eq!(
        project_edges(&ordered_graph),
        project_edges(&reordered_graph)
    );
    assert_eq!(
        project_exits(&ordered_graph),
        project_exits(&reordered_graph)
    );
    assert_eq!(
        ordered_graph.reverse_postorder(),
        reordered_graph.reverse_postorder()
    );
    assert_eq!(
        ordered_graph.reachable_blocks(),
        reordered_graph.reachable_blocks()
    );
    let ordered_edges = ordered_graph.edges().collect::<Vec<_>>();
    let [edge] = ordered_edges.as_slice() else {
        panic!("caught throw should have exactly one edge: {ordered_edges:?}");
    };
    assert_eq!(
        edge.kind,
        EdgeKind::Exceptional {
            arm: 0,
            handler,
            clause: 0,
        }
    );
    let routing = ordered
        .blocks
        .iter()
        .find(|block| block.id == entry)
        .and_then(|block| block.terminator.exception.as_ref())
        .expect("ordered throw routing");
    assert!(std::ptr::eq(
        ordered_graph
            .edge_site(edge.id)
            .and_then(EdgeSite::exceptional)
            .expect("terminator exception edge site"),
        &routing.arms[0],
    ));
    assert_eq!(edge.target, catch_target);

    let ordered_dominators = ordered_graph.dominators();
    let reordered_dominators = reordered_graph.dominators();
    assert_eq!(
        ordered_dominators.collect_dominators(catch_target),
        reordered_dominators.collect_dominators(catch_target)
    );
    assert_eq!(
        ordered_dominators.immediate_dominator(catch_target),
        Some(entry)
    );
    for policy in [ExitPolicy::Semantic, ExitPolicy::NormalCompletion] {
        let ordered_postdominators = ordered_graph.post_dominators(policy);
        let reordered_postdominators = reordered_graph.post_dominators(policy);
        assert_eq!(
            ordered_postdominators.collect_postdominators(entry),
            reordered_postdominators.collect_postdominators(entry)
        );
        assert_eq!(
            ordered_postdominators.immediate_postdominator(entry),
            Some(catch_target)
        );
        assert_eq!(
            ordered_postdominators.immediate_postdominator_node(entry),
            Some(PostDominatorNode::Block(catch_target))
        );
        assert_eq!(
            ordered_postdominators.immediate_postdominator_node(catch_target),
            Some(PostDominatorNode::VirtualExit)
        );
    }
}

#[test]
fn parallel_branch_edges_keep_distinct_sites_and_unique_adjacency() {
    let entry = BlockId(10);
    let target = BlockId(90);
    let entry_block = block(
        entry,
        RegionId(0),
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: IrEdge::new(target, vec![ValueId(1)]).with_refinement(0, ValueType::I32),
            else_edge: IrEdge::new(target, vec![ValueId(2)]),
        },
    );
    let function = body(entry, vec![return_block(target), entry_block]);
    let graph = ControlFlowGraph::new(&function).expect("parallel branch CFG");
    let edges = graph.outgoing_edges(entry).collect::<Vec<_>>();

    assert_eq!(edges.len(), 2);
    assert_eq!(edges[0].kind, EdgeKind::Branch(BranchDirection::True));
    assert_eq!(edges[1].kind, EdgeKind::Branch(BranchDirection::False));
    assert_eq!(
        graph.successor_blocks(entry).collect::<Vec<_>>(),
        vec![target, target]
    );
    assert_eq!(graph.unique_successor_blocks(entry), &[target]);
    assert_eq!(
        graph.predecessor_blocks(target).collect::<Vec<_>>(),
        vec![entry, entry]
    );
    assert_eq!(graph.unique_predecessor_blocks(target), &[entry]);

    let then_site = graph
        .edge_site(edges[0].id)
        .and_then(EdgeSite::ordinary)
        .expect("then-edge payload");
    let else_site = graph
        .edge_site(edges[1].id)
        .and_then(EdgeSite::ordinary)
        .expect("else-edge payload");
    let TerminatorKind::Branch {
        then_edge,
        else_edge,
        ..
    } = &graph.block(entry).expect("entry block").terminator.kind
    else {
        panic!("entry should end in a branch")
    };
    assert_eq!(edges[0].kind.class(), EdgeClass::Normal);
    assert_eq!(edges[1].kind.class(), EdgeClass::Normal);
    assert!(std::ptr::eq(then_site, then_edge));
    assert!(std::ptr::eq(else_site, else_edge));
    assert_eq!(then_site.arguments, vec![ValueId(1)]);
    assert_eq!(then_site.refinements.len(), 1);
    assert_eq!(then_site.refinements[0].slot, 0);
    assert_eq!(else_site.arguments, vec![ValueId(2)]);
    assert!(else_site.refinements.is_empty());
}

#[test]
fn repeated_switch_targets_keep_case_and_default_occurrences() {
    let entry = BlockId(10);
    let repeated = BlockId(90);
    let other = BlockId(80);
    let entry_block = block(
        entry,
        RegionId(0),
        TerminatorKind::Switch {
            selector: ValueId(0),
            targets: vec![
                IrEdge::new(repeated, vec![ValueId(1)]),
                IrEdge::new(repeated, vec![ValueId(2)]),
                IrEdge::new(other, vec![ValueId(3)]),
            ],
            default: IrEdge::new(repeated, vec![ValueId(4)]),
        },
    );
    let function = body(
        entry,
        vec![return_block(other), entry_block, return_block(repeated)],
    );
    let graph = ControlFlowGraph::new(&function).expect("parallel switch CFG");
    let edges = graph.outgoing_edges(entry).collect::<Vec<_>>();

    assert_eq!(
        edges.iter().map(|edge| edge.kind).collect::<Vec<_>>(),
        vec![
            EdgeKind::SwitchCase { index: 0 },
            EdgeKind::SwitchCase { index: 1 },
            EdgeKind::SwitchCase { index: 2 },
            EdgeKind::SwitchDefault,
        ]
    );
    assert_eq!(
        graph.successor_blocks(entry).collect::<Vec<_>>(),
        vec![repeated, repeated, other, repeated]
    );
    assert_eq!(graph.unique_successor_blocks(entry), &[repeated, other]);
    assert_eq!(graph.incoming_edges(repeated).count(), 3);
    assert_eq!(graph.unique_predecessor_blocks(repeated), &[entry]);
    let TerminatorKind::Switch {
        targets, default, ..
    } = &graph.block(entry).expect("switch block").terminator.kind
    else {
        panic!("entry should end in a switch")
    };
    for (edge, target) in edges[..targets.len()].iter().zip(targets) {
        assert!(std::ptr::eq(
            graph
                .edge_site(edge.id)
                .and_then(EdgeSite::ordinary)
                .expect("switch case edge site"),
            target,
        ));
    }
    assert!(std::ptr::eq(
        graph
            .edge_site(edges[targets.len()].id)
            .and_then(EdgeSite::ordinary)
            .expect("switch default edge site"),
        default,
    ));
    assert_eq!(
        edges
            .iter()
            .map(|edge| {
                graph
                    .edge_site(edge.id)
                    .expect("switch edge payload")
                    .argument_count()
            })
            .collect::<Vec<_>>(),
        vec![1, 1, 1, 1]
    );
}

#[test]
fn parallel_exception_arms_retain_arm_and_payload_sites() {
    let entry = BlockId(10);
    let normal = BlockId(80);
    let handler_block = BlockId(90);
    let handler = RegionId(5);
    let mut entry_block = jump_block(entry, normal);
    entry_block.region = handler;
    entry_block.terminator = routed_invoke(
        normal,
        vec![
            ExceptionalEdge::new(
                handler,
                0,
                handler_block,
                vec![ExceptionalArgument::Value(ValueId(1))],
            ),
            ExceptionalEdge::new(
                handler,
                0,
                handler_block,
                vec![ExceptionalArgument::Value(ValueId(2))],
            ),
        ],
    );
    let function = body_with_regions(
        entry,
        vec![
            entry_block,
            return_block(normal),
            return_block(handler_block),
        ],
        vec![
            root_region(entry),
            try_region(
                handler,
                entry,
                vec![CatchClause {
                    kind: CatchKind::CatchAll,
                    tag: None,
                    target: handler_block,
                }],
            ),
        ],
    );
    let graph = ControlFlowGraph::new(&function).expect("parallel exceptional CFG");
    let edges = graph.outgoing_edges(entry).collect::<Vec<_>>();

    assert_eq!(graph.block(entry).map(|block| block.id), Some(entry));
    assert!(graph.block(BlockId(999)).is_none());
    assert_eq!(graph.region(handler).map(|region| region.id), Some(handler));
    assert!(graph.region(RegionId(999)).is_none());
    assert_eq!(edges.len(), 3);
    assert_eq!(edges[0].kind, EdgeKind::InvokeNormal);
    assert_eq!(edges[0].kind.class(), EdgeClass::Normal);
    let source_block = graph.block(entry).expect("invoking source block");
    let TerminatorKind::Invoke {
        normal: normal_site,
        ..
    } = &source_block.terminator.kind
    else {
        panic!("invoking source should have a normal continuation")
    };
    assert!(std::ptr::eq(
        graph
            .edge_site(edges[0].id)
            .and_then(EdgeSite::ordinary)
            .expect("normal continuation edge site"),
        normal_site,
    ));
    let routing = source_block
        .terminator
        .exception
        .as_ref()
        .expect("source terminator should have exceptional routing");
    for (index, edge) in edges[1..].iter().enumerate() {
        assert_eq!(
            edge.kind,
            EdgeKind::Exceptional {
                arm: index as u32,
                handler,
                clause: 0,
            }
        );
        assert_eq!(edge.kind.class(), EdgeClass::Exceptional);
        let site = graph.edge_site(edge.id).expect("exceptional edge site");
        assert!(std::ptr::eq(
            site.exceptional().expect("exceptional edge site"),
            &routing.arms[index],
        ));
        assert_eq!(site.argument_count(), 1);
    }
    assert_eq!(graph.incoming_edges(handler_block).count(), 2);
    assert_eq!(
        graph.unique_successor_blocks(entry),
        &[normal, handler_block]
    );
}

#[test]
fn unreachable_components_have_no_entry_rooted_dominance_relation() {
    let entry = BlockId(10);
    let live = BlockId(20);
    let dead_predecessor = BlockId(70);
    let dead_root = BlockId(80);
    let function = body(
        entry,
        vec![
            jump_block(dead_root, dead_predecessor),
            jump_block(dead_predecessor, live),
            return_block(live),
            jump_block(entry, live),
        ],
    );
    let graph = ControlFlowGraph::new(&function).expect("CFG with dead component");
    let dominators = graph.dominators();

    assert_eq!(graph.reverse_postorder(), &[entry, live]);
    assert!(dominators.is_reachable(entry));
    assert!(dominators.is_reachable(live));
    assert!(!dominators.is_reachable(dead_root));
    assert!(!dominators.is_reachable(dead_predecessor));
    assert!(dominators.dominates(entry, live));
    assert_eq!(dominators.immediate_dominator(live), Some(entry));
    assert!(!dominators.dominates(dead_root, dead_root));
    assert!(!dominators.dominates(dead_root, dead_predecessor));
    assert!(!dominators.dominates(entry, dead_root));
    assert_eq!(
        graph.unique_predecessor_blocks(live),
        &[entry, dead_predecessor]
    );
}

#[test]
fn deep_sparse_chain_uses_compact_iterative_dominator_trees() {
    const BLOCK_COUNT: usize = 4_096;

    let ids = (0..BLOCK_COUNT)
        .map(|index| BlockId(10 + index as u32 * 17))
        .collect::<Vec<_>>();
    let mut blocks = ids
        .windows(2)
        .map(|pair| jump_block(pair[0], pair[1]))
        .collect::<Vec<_>>();
    blocks.push(return_block(ids[BLOCK_COUNT - 1]));
    blocks.reverse();

    let function = body(ids[0], blocks);
    let graph = ControlFlowGraph::new(&function).expect("deep sparse chain CFG");
    assert_eq!(graph.reverse_postorder().len(), BLOCK_COUNT);
    assert_eq!(graph.reverse_postorder().first(), Some(&ids[0]));
    assert_eq!(graph.reverse_postorder().last(), ids.last());

    let dominators = graph.dominators();
    assert!(dominators.dominates(ids[0], ids[BLOCK_COUNT - 1]));
    assert_eq!(
        dominators.immediate_dominator(ids[BLOCK_COUNT - 1]),
        Some(ids[BLOCK_COUNT - 2])
    );
    assert_eq!(
        dominators
            .collect_dominators(ids[BLOCK_COUNT - 1])
            .expect("reachable tail")
            .len(),
        BLOCK_COUNT
    );

    let postdominators = graph.post_dominators(ExitPolicy::Semantic);
    assert!(postdominators.postdominates(ids[BLOCK_COUNT - 1], ids[0]));
    assert_eq!(postdominators.immediate_postdominator(ids[0]), Some(ids[1]));
    assert_eq!(
        postdominators
            .collect_postdominators(ids[0])
            .expect("entry reaches return")
            .len(),
        BLOCK_COUNT
    );
    assert_eq!(
        postdominators.immediate_postdominator_node(ids[BLOCK_COUNT - 1]),
        Some(PostDominatorNode::VirtualExit)
    );
}

#[test]
fn absent_block_queries_are_total_and_empty() {
    let entry = BlockId(10);
    let absent = BlockId(999);
    let function = body(entry, vec![return_block(entry)]);
    let graph = ControlFlowGraph::new(&function).expect("single-block CFG");

    assert!(!graph.contains_block(absent));
    assert!(graph.outgoing_edge_ids(absent).is_empty());
    assert!(graph.incoming_edge_ids(absent).is_empty());
    assert_eq!(graph.outgoing_edges(absent).count(), 0);
    assert_eq!(graph.incoming_edges(absent).count(), 0);
    assert_eq!(graph.successor_blocks(absent).count(), 0);
    assert_eq!(graph.predecessor_blocks(absent).count(), 0);
    assert!(graph.unique_successor_blocks(absent).is_empty());
    assert!(graph.unique_predecessor_blocks(absent).is_empty());
    assert!(graph.exit_ids_from(absent).is_empty());
    assert_eq!(graph.exits_from(absent).count(), 0);
    assert!(!graph.is_reachable(absent));

    let dominators = graph.dominators();
    assert!(!dominators.is_reachable(absent));
    assert!(!dominators.dominates(entry, absent));
    assert!(!dominators.dominates(absent, absent));
    assert_eq!(dominators.collect_dominators(absent), None);
    assert_eq!(dominators.immediate_dominator(absent), None);

    for policy in [ExitPolicy::Semantic, ExitPolicy::NormalCompletion] {
        let postdominators = graph.post_dominators(policy);
        assert!(!postdominators.can_reach_exit(absent));
        assert!(!postdominators.postdominates(entry, absent));
        assert!(!postdominators.postdominates(absent, absent));
        assert_eq!(postdominators.collect_postdominators(absent), None);
        assert_eq!(postdominators.immediate_postdominator(absent), None);
        assert_eq!(postdominators.immediate_postdominator_node(absent), None);
    }

    let components = graph.strongly_connected_components();
    assert_eq!(components.component(absent), None);
    assert!(!components.same_component(entry, absent));
    assert!(!components.same_component(absent, absent));
}

#[test]
fn exit_inventory_retains_every_semantically_distinct_exit() {
    let returned = BlockId(10);
    let tail_called = BlockId(20);
    let trapped = BlockId(30);
    let thrown = BlockId(40);
    let tail_call = block(
        tail_called,
        RegionId(0),
        TerminatorKind::TailCall {
            callee: Callee::Direct(FunctionId(0)),
            arguments: Vec::new(),
        },
    );
    let unreachable = block(
        trapped,
        RegionId(0),
        TerminatorKind::Unreachable {
            trap: TrapCode::IntegerOverflow,
        },
    );
    let throw_ref = block(
        thrown,
        RegionId(0),
        TerminatorKind::ThrowRef {
            exception: ValueId(0),
        },
    );
    let function = body(
        returned,
        vec![return_block(returned), tail_call, unreachable, throw_ref],
    );
    let graph = ControlFlowGraph::new(&function).expect("exit inventory CFG");

    assert_eq!(
        graph
            .exits_from(returned)
            .map(|exit| exit.kind.clone())
            .collect::<Vec<_>>(),
        vec![ExitKind::Return]
    );
    assert!(
        graph
            .exits_from(tail_called)
            .any(|exit| exit.kind == ExitKind::TailCall)
    );
    assert!(
        graph
            .exits_from(tail_called)
            .any(|exit| matches!(&exit.kind, ExitKind::Trap(TrapCode::StackOverflow)))
    );
    assert!(
        graph
            .exits_from(tail_called)
            .any(|exit| exit.kind == ExitKind::ExceptionEscape)
    );
    assert!(graph.exits_from(trapped).any(|exit| {
        exit.kind == ExitKind::Trap(TrapCode::IntegerOverflow)
            && exit.origin == ExitOrigin::Terminator
    }));
    assert!(
        graph
            .exits_from(thrown)
            .any(|exit| matches!(&exit.kind, ExitKind::Trap(TrapCode::NullReference)))
    );
    assert!(
        graph
            .exits_from(thrown)
            .any(|exit| exit.kind == ExitKind::ExceptionEscape)
    );
    for (index, exit) in graph.exits().enumerate() {
        assert_eq!(exit.id.index(), index);
    }
}

#[test]
fn post_dominance_exit_policy_distinguishes_side_exits_from_normal_completion() {
    let entry = BlockId(10);
    let returned = BlockId(20);
    let mut entry_block = jump_block(entry, returned);
    let mut effectful = Instruction::new(
        InstructionId(12),
        Operation::synthetic("wedge.test_side_exit", Vec::new(), Vec::new()),
        Vec::new(),
        Vec::new(),
        source(),
    );
    effectful.effects = Effects {
        accesses: Vec::new(),
        traps: vec![TrapCode::MemoryOutOfBounds],
        exception: ExceptionEffect::MayThrow,
        allocates: false,
        nondeterministic: false,
    };
    entry_block.instructions.push(effectful);
    let function = body(entry, vec![entry_block, return_block(returned)]);
    let graph = ControlFlowGraph::new(&function).expect("side-exit CFG");

    assert_eq!(
        graph
            .exits_from(entry)
            .map(|exit| (exit.origin, exit.kind.clone()))
            .collect::<Vec<_>>(),
        vec![
            (
                ExitOrigin::Instruction {
                    instruction: InstructionId(12),
                    position: 0,
                },
                ExitKind::Trap(TrapCode::MemoryOutOfBounds),
            ),
            (
                ExitOrigin::Instruction {
                    instruction: InstructionId(12),
                    position: 0,
                },
                ExitKind::ExceptionEscape,
            ),
        ]
    );

    let semantic = graph.post_dominators(ExitPolicy::Semantic);
    assert!(semantic.can_reach_exit(entry));
    assert!(!semantic.postdominates(returned, entry));
    assert_eq!(semantic.immediate_postdominator(entry), None);
    assert_eq!(
        semantic.immediate_postdominator_node(entry),
        Some(PostDominatorNode::VirtualExit)
    );
    assert_eq!(
        semantic.immediate_postdominator_node(returned),
        Some(PostDominatorNode::VirtualExit)
    );

    let normal = graph.post_dominators(ExitPolicy::NormalCompletion);
    assert!(normal.can_reach_exit(entry));
    assert!(normal.postdominates(returned, entry));
    assert_eq!(normal.immediate_postdominator(entry), Some(returned));
    assert_eq!(
        normal.immediate_postdominator_node(entry),
        Some(PostDominatorNode::Block(returned))
    );
    assert_eq!(
        normal.immediate_postdominator_node(returned),
        Some(PostDominatorNode::VirtualExit)
    );
}

#[test]
fn blocks_without_a_selected_exit_have_no_post_dominance_relation() {
    let entry = BlockId(10);
    let function = body(
        entry,
        vec![block(
            entry,
            RegionId(0),
            TerminatorKind::Unreachable {
                trap: TrapCode::Unreachable,
            },
        )],
    );
    let graph = ControlFlowGraph::new(&function).expect("trap-only CFG");

    let semantic = graph.post_dominators(ExitPolicy::Semantic);
    assert!(semantic.can_reach_exit(entry));
    assert!(semantic.postdominates(entry, entry));
    assert_eq!(
        semantic.immediate_postdominator_node(entry),
        Some(PostDominatorNode::VirtualExit)
    );

    let normal = graph.post_dominators(ExitPolicy::NormalCompletion);
    assert!(!normal.can_reach_exit(entry));
    assert!(!normal.postdominates(entry, entry));
    assert_eq!(normal.collect_postdominators(entry), None);
    assert_eq!(normal.immediate_postdominator_node(entry), None);
}

#[test]
fn virtual_exit_immediately_postdominates_selected_exits_and_a_multi_exit_fork() {
    let entry = BlockId(10);
    let left_return = BlockId(20);
    let right_return = BlockId(30);
    let function = body(
        entry,
        vec![
            branch_block(entry, left_return, right_return),
            return_block(left_return),
            return_block(right_return),
        ],
    );
    let graph = ControlFlowGraph::new(&function).expect("two-return CFG");

    for policy in [ExitPolicy::Semantic, ExitPolicy::NormalCompletion] {
        let postdominators = graph.post_dominators(policy);
        assert_eq!(
            postdominators.immediate_postdominator_node(entry),
            Some(PostDominatorNode::VirtualExit)
        );
        assert_eq!(
            postdominators.immediate_postdominator_node(left_return),
            Some(PostDominatorNode::VirtualExit)
        );
        assert_eq!(
            postdominators.immediate_postdominator_node(right_return),
            Some(PostDominatorNode::VirtualExit)
        );
        assert_eq!(postdominators.immediate_postdominator(entry), None);
    }
}

#[test]
fn irreducible_cycles_are_sccs_but_not_natural_loops() {
    let entry = BlockId(10);
    let left = BlockId(20);
    let right = BlockId(30);
    let join = BlockId(40);
    let entry_block = block(
        entry,
        RegionId(0),
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: IrEdge::new(left, Vec::new()),
            else_edge: IrEdge::new(right, Vec::new()),
        },
    );
    let join_block = block(
        join,
        RegionId(0),
        TerminatorKind::Branch {
            condition: ValueId(1),
            then_edge: IrEdge::new(left, Vec::new()),
            else_edge: IrEdge::new(right, Vec::new()),
        },
    );
    let function = body(
        entry,
        vec![
            entry_block,
            jump_block(left, join),
            jump_block(right, join),
            join_block,
        ],
    );
    let graph = ControlFlowGraph::new(&function).expect("irreducible CFG");
    let components = graph.strongly_connected_components();
    let cycle = components.component(left).expect("cycle component");

    assert!(components.same_component(left, right));
    assert!(components.same_component(left, join));
    assert!(!components.same_component(entry, left));
    assert_eq!(components.blocks(cycle), Some(&[left, right, join][..]));
    assert!(components.is_cyclic(cycle));
    assert!(graph.natural_loops().is_empty());
}

#[test]
fn dominance_backedges_form_reducible_natural_loops() {
    let entry = BlockId(10);
    let header = BlockId(20);
    let loop_body = BlockId(30);
    let exit = BlockId(40);
    let header_block = block(
        header,
        RegionId(0),
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: IrEdge::new(loop_body, Vec::new()),
            else_edge: IrEdge::new(exit, Vec::new()),
        },
    );
    let function = body(
        entry,
        vec![
            return_block(exit),
            jump_block(loop_body, header),
            jump_block(entry, header),
            header_block,
        ],
    );
    let graph = ControlFlowGraph::new(&function).expect("reducible CFG");
    let loops = graph.natural_loops();

    assert_eq!(loops.len(), 1);
    assert_eq!(loops[0].header, header);
    assert_eq!(
        loops[0].blocks.iter().copied().collect::<Vec<_>>(),
        vec![header, loop_body]
    );
    assert_eq!(loops[0].back_edges.len(), 1);
    let back_edge = graph
        .edge(loops[0].back_edges[0])
        .expect("natural-loop backedge");
    assert_eq!((back_edge.source, back_edge.target), (loop_body, header));
}

#[test]
fn natural_loop_unions_multiple_latches_and_retains_every_backedge() {
    let entry = BlockId(10);
    let header = BlockId(20);
    let loop_body = BlockId(30);
    let first_latch = BlockId(40);
    let second_latch = BlockId(50);
    let exit = BlockId(60);
    let function = body(
        entry,
        vec![
            jump_block(entry, header),
            branch_block(header, loop_body, exit),
            branch_block(loop_body, first_latch, second_latch),
            jump_block(first_latch, header),
            jump_block(second_latch, header),
            return_block(exit),
        ],
    );
    let graph = ControlFlowGraph::new(&function).expect("two-latch natural loop CFG");
    let loops = graph.natural_loops();
    let [natural_loop] = loops.as_slice() else {
        panic!("two latches should form one natural loop: {loops:?}");
    };

    assert_eq!(natural_loop.header, header);
    assert_eq!(
        natural_loop.blocks,
        BTreeSet::from([header, loop_body, first_latch, second_latch])
    );
    assert_eq!(natural_loop.back_edges.len(), 2);
    let back_sources = natural_loop
        .back_edges
        .iter()
        .map(|edge| graph.edge(*edge).expect("latch backedge"))
        .map(|edge| {
            assert_eq!(edge.target, header);
            edge.source
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(back_sources, BTreeSet::from([first_latch, second_latch]));

    let components = graph.strongly_connected_components();
    for block in [loop_body, first_latch, second_latch] {
        assert!(components.same_component(header, block));
    }
    assert!(!components.same_component(header, exit));
}

#[test]
fn nested_natural_loops_have_distinct_headers_and_nested_block_sets() {
    let entry = BlockId(10);
    let outer_header = BlockId(20);
    let inner_header = BlockId(30);
    let inner_body = BlockId(40);
    let after_inner = BlockId(50);
    let outer_latch = BlockId(60);
    let exit = BlockId(70);
    let function = body(
        entry,
        vec![
            jump_block(entry, outer_header),
            branch_block(outer_header, inner_header, exit),
            branch_block(inner_header, inner_body, after_inner),
            jump_block(inner_body, inner_header),
            jump_block(after_inner, outer_latch),
            jump_block(outer_latch, outer_header),
            return_block(exit),
        ],
    );
    let graph = ControlFlowGraph::new(&function).expect("nested natural-loop CFG");
    let loops = graph.natural_loops();
    assert_eq!(loops.len(), 2);
    let inner = loops
        .iter()
        .find(|natural_loop| natural_loop.header == inner_header)
        .expect("inner natural loop");
    let outer = loops
        .iter()
        .find(|natural_loop| natural_loop.header == outer_header)
        .expect("outer natural loop");

    assert_eq!(inner.blocks, BTreeSet::from([inner_header, inner_body]));
    assert_eq!(inner.back_edges.len(), 1);
    assert_eq!(
        outer.blocks,
        BTreeSet::from([
            outer_header,
            inner_header,
            inner_body,
            after_inner,
            outer_latch,
        ])
    );
    assert_eq!(outer.back_edges.len(), 1);
    assert!(inner.blocks.is_subset(&outer.blocks));
    assert_eq!(
        graph
            .edge(inner.back_edges[0])
            .map(|edge| (edge.source, edge.target)),
        Some((inner_body, inner_header))
    );
    assert_eq!(
        graph
            .edge(outer.back_edges[0])
            .map(|edge| (edge.source, edge.target)),
        Some((outer_latch, outer_header))
    );
}

#[test]
fn catch_declarations_do_not_create_phantom_cfg_edges() {
    let entry = BlockId(10);
    let catch_target = BlockId(90);
    let handler = RegionId(5);
    let function = body_with_regions(
        entry,
        vec![return_block(entry), return_block(catch_target)],
        vec![
            root_region(entry),
            try_region(
                handler,
                entry,
                vec![CatchClause {
                    kind: CatchKind::CatchAll,
                    tag: None,
                    target: catch_target,
                }],
            ),
        ],
    );
    let graph = ControlFlowGraph::new(&function).expect("uninstantiated catch declaration");

    assert_eq!(graph.edges().count(), 0);
    assert_eq!(graph.incoming_edges(catch_target).count(), 0);
    assert!(graph.unique_predecessor_blocks(catch_target).is_empty());
    assert!(!graph.is_reachable(catch_target));
}

#[test]
fn wide_join_from_a_long_conditional_chain_is_near_linear() {
    // Every chain block branches to one join, so the join's predecessors sit
    // at every depth of the dominator tree. The iterative intersection walked
    // that chain once per predecessor; semi-NCA does not.
    const CHAIN: usize = 20_000;
    let join = BlockId(CHAIN as u32);
    let chain = (0..CHAIN as u32).map(BlockId).collect::<Vec<_>>();
    let mut blocks = chain
        .windows(2)
        .map(|pair| branch_block(pair[0], join, pair[1]))
        .collect::<Vec<_>>();
    blocks.push(jump_block(chain[CHAIN - 1], join));
    blocks.push(return_block(join));
    let function = body(chain[0], blocks);
    let graph = ControlFlowGraph::new(&function).expect("wide join CFG");

    let dominators = graph.dominators();
    let postdominators = graph.post_dominators(ExitPolicy::Semantic);

    assert_eq!(dominators.immediate_dominator(join), Some(chain[0]));
    for pair in chain.windows(2) {
        assert_eq!(dominators.immediate_dominator(pair[1]), Some(pair[0]));
    }
    assert_eq!(
        dominators
            .collect_dominators(chain[CHAIN - 1])
            .expect("reachable tail")
            .len(),
        CHAIN
    );
    for &block in &chain {
        assert_eq!(postdominators.immediate_postdominator(block), Some(join));
    }
    assert_eq!(
        postdominators.immediate_postdominator_node(join),
        Some(PostDominatorNode::VirtualExit)
    );
}

#[test]
fn irreducible_cycles_and_cross_edges_match_the_path_removal_oracle() {
    // Two irreducible cycles (1 <-> 2 entered from both sides, 3 <-> 5), a
    // cross edge 4 -> 1, and a shared exit 7.
    let successors: [&[u32]; 8] = [
        &[1, 2],
        &[2, 3],
        &[1, 4],
        &[5, 7],
        &[5, 1],
        &[3, 6],
        &[7],
        &[],
    ];
    let blocks = successors
        .iter()
        .enumerate()
        .map(|(id, targets)| {
            let id = BlockId(id as u32);
            match *targets {
                [] => return_block(id),
                [only] => jump_block(id, BlockId(*only)),
                [first, second] => branch_block(id, BlockId(*first), BlockId(*second)),
                _ => unreachable!("at most two successors"),
            }
        })
        .collect::<Vec<_>>();
    let function = body(BlockId(0), blocks);
    let graph = ControlFlowGraph::new(&function).expect("irreducible CFG");

    let reachable_avoiding = |avoid: BlockId| {
        let mut seen = BTreeSet::new();
        let mut pending = vec![BlockId(0)];
        while let Some(block) = pending.pop() {
            if block == avoid || !seen.insert(block) {
                continue;
            }
            pending.extend(successors[block.index()].iter().map(|id| BlockId(*id)));
        }
        seen
    };
    let dominators = graph.dominators();
    for dominator in (0..8).map(BlockId) {
        let avoiding = reachable_avoiding(dominator);
        for block in (0..8).map(BlockId) {
            let expected = block == dominator || !avoiding.contains(&block);
            assert_eq!(
                dominators.dominates(dominator, block),
                expected,
                "{dominator} dominates {block}"
            );
        }
    }
    for (block, idom) in [(1, 0), (2, 0), (3, 0), (4, 2), (5, 0), (6, 5), (7, 0)] {
        assert_eq!(
            dominators.immediate_dominator(BlockId(block)),
            Some(BlockId(idom)),
            "immediate dominator of block{block}"
        );
    }

    let postdominators = graph.post_dominators(ExitPolicy::Semantic);
    for block in (0..7).map(BlockId) {
        assert_eq!(
            postdominators.immediate_postdominator(block),
            Some(BlockId(7)),
            "immediate post-dominator of {block}"
        );
    }
    assert_eq!(
        postdominators.immediate_postdominator_node(BlockId(7)),
        Some(PostDominatorNode::VirtualExit)
    );
    assert!(
        graph.natural_loops().is_empty(),
        "irreducible cycles are not natural loops"
    );
}
