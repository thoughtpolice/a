// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Independent generative oracles for the public control-flow analysis API.
//!
//! Every Hegel generator is bounded and rejection-free so a derandomized run
//! spends its whole case budget on accepted cases. Assertions print the
//! complete generated graph before panicking; Hegel then shrinks the failure.

use std::collections::BTreeSet;

use hegel::{TestCase, generators as gs};
use wedge::cfg::{
    BranchDirection, ControlFlowGraph, EdgeKind as CfgEdgeKind, EdgeSite, ExitKind, ExitOrigin,
    ExitPolicy, PostDominatorNode,
};
use wedge::ir::{
    Block, BlockId, Edge, Effects, FunctionBody, Immediate, Instruction, InstructionId, Operation,
    Refinement, Region, RegionId, RegionKind, SourceInfo, Terminator, TerminatorKind, TrapCode,
    ValueDefinition, ValueId, ValueType,
};
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

macro_rules! property_assert_eq {
    ($left:expr, $right:expr, $($message:tt)*) => {{
        let left = $left;
        let right = $right;
        if left != right {
            eprintln!($($message)*);
            eprintln!("left: {left:#?}\nright: {right:#?}");
            panic!("property equality failed after printing its diagnostic");
        }
    }};
}

fn source() -> SourceInfo {
    SourceInfo::synthetic()
}

fn selector_value(block: usize) -> ValueId {
    ValueId((block * 32) as u32)
}

fn edge_argument_value(block: usize, occurrence: usize) -> ValueId {
    ValueId((block * 32 + occurrence + 1) as u32)
}

fn block_parameter_value(block: usize) -> ValueId {
    ValueId(10_000 + block as u32)
}

fn i32_const(instruction: InstructionId, value: ValueId, immediate: i32) -> Instruction {
    Instruction::new(
        instruction,
        Operation::core(CoreOpcode::I32Const, vec![], vec![ValueType::I32])
            .with_immediates(vec![Immediate::S32(immediate)]),
        vec![],
        vec![ValueDefinition::new(value, ValueType::I32)],
        source(),
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OracleEdge {
    source: BlockId,
    target: BlockId,
    kind: CfgEdgeKind,
    argument: ValueId,
}

/// A bounded directed multigraph. Block zero is the entry, and generated edges
/// never target it so the resulting body also observes Wedge's entry contract.
#[derive(Clone, Debug)]
struct Graph {
    successors: Vec<Vec<usize>>,
}

impl Graph {
    fn draw(tc: &TestCase) -> Self {
        let block_count = tc.draw(gs::integers::<usize>().min_value(1).max_value(12));
        let mut successors = vec![Vec::new(); block_count];
        if block_count == 1 {
            return Self { successors };
        }

        for targets in &mut successors {
            let occurrence_count = tc.draw(gs::integers::<usize>().max_value(4));
            for _ in 0..occurrence_count {
                targets.push(
                    tc.draw(
                        gs::integers::<usize>()
                            .min_value(1)
                            .max_value(block_count - 1),
                    ),
                );
            }
        }

        // Guarantee that every nontrivial generated body exercises a parallel
        // edge. A separately drawn chord keeps sparse and dense topologies in
        // the stream without filtering any cases.
        let duplicate_source = tc.draw(gs::integers::<usize>().max_value(block_count - 1));
        let duplicate_target = tc.draw(
            gs::integers::<usize>()
                .min_value(1)
                .max_value(block_count - 1),
        );
        successors[duplicate_source].push(duplicate_target);
        successors[duplicate_source].push(duplicate_target);

        let chord_source = tc.draw(gs::integers::<usize>().max_value(block_count - 1));
        let chord_target = tc.draw(
            gs::integers::<usize>()
                .min_value(1)
                .max_value(block_count - 1),
        );
        successors[chord_source].push(chord_target);
        Self { successors }
    }

    fn draw_exit_reaching(tc: &TestCase) -> Self {
        let block_count = tc.draw(gs::integers::<usize>().min_value(1).max_value(12));
        let mut successors = vec![Vec::new(); block_count];
        for (source, targets) in successors
            .iter_mut()
            .enumerate()
            .take(block_count.saturating_sub(1))
        {
            // The forward spine makes every block reachable and makes every
            // path terminate at the sole return. Extra forward chords can be
            // duplicates but cannot introduce an infinite path.
            targets.push(source + 1);
            let chord_count = tc.draw(gs::integers::<usize>().max_value(3));
            for _ in 0..chord_count {
                targets.push(
                    tc.draw(
                        gs::integers::<usize>()
                            .min_value(source + 1)
                            .max_value(block_count - 1),
                    ),
                );
            }
        }
        Self { successors }
    }

    fn block_count(&self) -> usize {
        self.successors.len()
    }

    fn body(&self) -> FunctionBody {
        let blocks = self
            .successors
            .iter()
            .enumerate()
            .map(|(block_index, successors)| {
                let id = BlockId(block_index as u32);
                let mut instructions = Vec::with_capacity(successors.len() + 1);
                instructions.push(i32_const(
                    InstructionId((block_index * 32) as u32),
                    selector_value(block_index),
                    block_index as i32,
                ));
                for occurrence in 0..successors.len() {
                    instructions.push(i32_const(
                        InstructionId((block_index * 32 + occurrence + 1) as u32),
                        edge_argument_value(block_index, occurrence),
                        occurrence as i32,
                    ));
                }
                let parameters = (block_index != 0)
                    .then(|| {
                        ValueDefinition::new(block_parameter_value(block_index), ValueType::I32)
                    })
                    .into_iter()
                    .collect();
                Block {
                    id,
                    region: RegionId(0),
                    parameters,
                    instructions,
                    terminator: self.terminator(block_index),
                    source: source(),
                }
            })
            .collect();
        FunctionBody {
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
        }
    }

    fn terminator(&self, source_block: usize) -> Terminator {
        let successors = &self.successors[source_block];
        let edge = |occurrence: usize, target: usize| {
            Edge::new(
                BlockId(target as u32),
                vec![edge_argument_value(source_block, occurrence)],
            )
        };
        let kind = match successors.as_slice() {
            [] => TerminatorKind::Return { values: vec![] },
            [target] => TerminatorKind::Jump(edge(0, *target)),
            [then_target, else_target] => TerminatorKind::Branch {
                condition: selector_value(source_block),
                then_edge: edge(0, *then_target),
                else_edge: edge(1, *else_target),
            },
            [cases @ .., default] => TerminatorKind::Switch {
                selector: selector_value(source_block),
                targets: cases
                    .iter()
                    .enumerate()
                    .map(|(index, target)| edge(index, *target))
                    .collect(),
                default: edge(successors.len() - 1, *default),
            },
        };
        Terminator::new(kind, source())
    }

    fn expected_kind(successor_count: usize, occurrence: usize) -> CfgEdgeKind {
        match successor_count {
            0 => property_panic!(
                "attempted to classify an edge occurrence for an empty successor list"
            ),
            1 => CfgEdgeKind::Jump,
            2 if occurrence == 0 => CfgEdgeKind::Branch(BranchDirection::True),
            2 => CfgEdgeKind::Branch(BranchDirection::False),
            count if occurrence + 1 == count => CfgEdgeKind::SwitchDefault,
            _ => CfgEdgeKind::SwitchCase {
                index: occurrence as u32,
            },
        }
    }

    fn expected_edges(&self) -> Vec<OracleEdge> {
        self.successors
            .iter()
            .enumerate()
            .flat_map(|(source, targets)| {
                targets
                    .iter()
                    .copied()
                    .enumerate()
                    .map(move |(occurrence, target)| OracleEdge {
                        source: BlockId(source as u32),
                        target: BlockId(target as u32),
                        kind: Self::expected_kind(targets.len(), occurrence),
                        argument: edge_argument_value(source, occurrence),
                    })
            })
            .collect()
    }

    fn unique_successors(&self, source: usize) -> Vec<usize> {
        let mut seen = BTreeSet::new();
        self.successors[source]
            .iter()
            .copied()
            .filter(|target| seen.insert(*target))
            .collect()
    }

    fn reachable_from_avoiding(&self, start: usize, removed: Option<usize>) -> BTreeSet<usize> {
        if removed == Some(start) {
            return BTreeSet::new();
        }
        let mut reachable = BTreeSet::new();
        let mut pending = vec![start];
        while let Some(block) = pending.pop() {
            if removed == Some(block) || !reachable.insert(block) {
                continue;
            }
            pending.extend(
                self.successors[block]
                    .iter()
                    .copied()
                    .filter(|successor| removed != Some(*successor)),
            );
        }
        reachable
    }

    fn reaches(&self, source: usize, target: usize) -> bool {
        self.reachable_from_avoiding(source, None).contains(&target)
    }

    fn entry_reachable(&self) -> BTreeSet<usize> {
        self.reachable_from_avoiding(0, None)
    }

    /// Path-removal dominance oracle, independent of the production
    /// immediate-dominator-tree algorithm.
    fn dominates(&self, dominator: usize, block: usize) -> bool {
        let reachable = self.entry_reachable();
        reachable.contains(&block)
            && (dominator == block
                || !self
                    .reachable_from_avoiding(0, Some(dominator))
                    .contains(&block))
    }

    fn immediate_dominator(&self, block: usize) -> Option<usize> {
        if block == 0 || !self.dominates(block, block) {
            return None;
        }
        let strict = (0..self.block_count())
            .filter(|candidate| *candidate != block && self.dominates(*candidate, block))
            .collect::<Vec<_>>();
        strict.iter().copied().find(|candidate| {
            strict
                .iter()
                .all(|other| other == candidate || self.dominates(*other, *candidate))
        })
    }

    fn reverse_postorder(&self) -> Vec<usize> {
        fn visit(
            graph: &Graph,
            block: usize,
            visited: &mut BTreeSet<usize>,
            postorder: &mut Vec<usize>,
        ) {
            if !visited.insert(block) {
                return;
            }
            for successor in graph.unique_successors(block) {
                visit(graph, successor, visited, postorder);
            }
            postorder.push(block);
        }

        let mut visited = BTreeSet::new();
        let mut postorder = Vec::new();
        visit(self, 0, &mut visited, &mut postorder);
        postorder.reverse();
        postorder
    }

    fn components(&self) -> Vec<Vec<BlockId>> {
        let mut assigned = BTreeSet::new();
        let mut components = Vec::new();
        for root in 0..self.block_count() {
            if assigned.contains(&root) {
                continue;
            }
            let component = (0..self.block_count())
                .filter(|candidate| {
                    self.reaches(root, *candidate) && self.reaches(*candidate, root)
                })
                .collect::<Vec<_>>();
            assigned.extend(component.iter().copied());
            components.push(
                component
                    .into_iter()
                    .map(|block| BlockId(block as u32))
                    .collect(),
            );
        }
        components.sort();
        components
    }

    fn reaches_selected_exit_avoiding(
        &self,
        start: usize,
        removed: Option<usize>,
        selected_exit_sources: &BTreeSet<usize>,
    ) -> bool {
        if removed == Some(start) {
            return false;
        }
        let mut visited = BTreeSet::new();
        let mut pending = vec![start];
        while let Some(block) = pending.pop() {
            if removed == Some(block) || !visited.insert(block) {
                continue;
            }
            if selected_exit_sources.contains(&block) {
                return true;
            }
            pending.extend(
                self.successors[block]
                    .iter()
                    .copied()
                    .filter(|successor| removed != Some(*successor)),
            );
        }
        false
    }

    /// A path-removal oracle for the documented finite-selected-exit
    /// post-dominance relation. Infinite paths are deliberately irrelevant:
    /// only the existence of a finite path to a selected exit can disprove a
    /// candidate.
    fn postdominator_sets_for_exits(
        &self,
        selected_exit_sources: &BTreeSet<usize>,
    ) -> Vec<Option<BTreeSet<usize>>> {
        let entry_reachable = self.entry_reachable();
        (0..self.block_count())
            .map(|block| {
                if !entry_reachable.contains(&block)
                    || !self.reaches_selected_exit_avoiding(block, None, selected_exit_sources)
                {
                    return None;
                }
                Some(
                    (0..self.block_count())
                        .filter(|candidate| {
                            *candidate == block
                                || !self.reaches_selected_exit_avoiding(
                                    block,
                                    Some(*candidate),
                                    selected_exit_sources,
                                )
                        })
                        .collect(),
                )
            })
            .collect()
    }

    fn immediate_postdominator_from_sets(
        &self,
        block: usize,
        sets: &[Option<BTreeSet<usize>>],
    ) -> Option<usize> {
        let relations = sets.get(block)?.as_ref()?;
        let strict = relations
            .iter()
            .copied()
            .filter(|candidate| *candidate != block)
            .collect::<Vec<_>>();
        strict.iter().copied().find(|candidate| {
            strict.iter().all(|other| {
                other == candidate
                    || sets
                        .get(*candidate)
                        .and_then(Option::as_ref)
                        .is_some_and(|candidate_set| candidate_set.contains(other))
            })
        })
    }

    fn immediate_postdominator_node_from_sets(
        &self,
        block: usize,
        sets: &[Option<BTreeSet<usize>>],
    ) -> Option<PostDominatorNode> {
        sets.get(block)?.as_ref()?;
        Some(
            self.immediate_postdominator_from_sets(block, sets)
                .map(|candidate| PostDominatorNode::Block(BlockId(candidate as u32)))
                .unwrap_or(PostDominatorNode::VirtualExit),
        )
    }

    fn postdominates_sole_exit(&self, postdominator: usize, block: usize) -> bool {
        let exit = self.block_count() - 1;
        postdominator == block
            || !self
                .reachable_from_avoiding(block, Some(postdominator))
                .contains(&exit)
    }

    fn immediate_postdominator(&self, block: usize) -> Option<usize> {
        let strict = (0..self.block_count())
            .filter(|candidate| {
                *candidate != block && self.postdominates_sole_exit(*candidate, block)
            })
            .collect::<Vec<_>>();
        strict.iter().copied().find(|candidate| {
            strict
                .iter()
                .all(|other| other == candidate || self.postdominates_sole_exit(*other, *candidate))
        })
    }
}

/// A graph with two reachable normal exits, a reachable cycle, and direct trap
/// exits on blocks which also have normal successors.
#[derive(Clone, Debug)]
struct CyclicExitGraph {
    graph: Graph,
    side_exit_blocks: BTreeSet<usize>,
}

impl CyclicExitGraph {
    fn draw(tc: &TestCase) -> Self {
        let block_count = tc.draw(gs::integers::<usize>().min_value(5).max_value(12));
        let mut successors = vec![Vec::new(); block_count];
        for (source, targets) in successors.iter_mut().enumerate().take(block_count - 2) {
            if matches!(source, 1 | 2) {
                continue;
            }
            let occurrence_count = tc.draw(gs::integers::<usize>().max_value(3));
            for _ in 0..occurrence_count {
                targets.push(
                    tc.draw(
                        gs::integers::<usize>()
                            .min_value(1)
                            .max_value(block_count - 1),
                    ),
                );
            }
        }

        // Blocks 1 and 2 form a reachable cycle with a finite path to the
        // penultimate return. The entry also reaches the final return, so both
        // policies always select at least two reachable normal exits.
        successors[0].extend([1, block_count - 1]);
        successors[1].push(2);
        successors[2].extend([1, block_count - 2]);

        let second_side_exit = tc.draw(gs::integers::<usize>().min_value(1).max_value(2));
        Self {
            graph: Graph { successors },
            side_exit_blocks: BTreeSet::from([0, second_side_exit]),
        }
    }

    fn body(&self) -> FunctionBody {
        let mut body = self.graph.body();
        for block_index in &self.side_exit_blocks {
            let mut instruction = Instruction::new(
                InstructionId((*block_index * 32 + 31) as u32),
                Operation::synthetic("wedge.test_postdom_side_exit", vec![], vec![]),
                vec![],
                vec![],
                source(),
            );
            instruction.effects = Effects {
                traps: vec![TrapCode::MemoryOutOfBounds],
                ..Effects::pure()
            };
            body.blocks[*block_index].instructions.push(instruction);
        }
        body
    }

    fn selected_exit_sources(&self, policy: ExitPolicy) -> BTreeSet<usize> {
        let entry_reachable = self.graph.entry_reachable();
        let mut selected = self
            .graph
            .successors
            .iter()
            .enumerate()
            .filter(|(block, successors)| successors.is_empty() && entry_reachable.contains(block))
            .map(|(block, _)| block)
            .collect::<BTreeSet<_>>();
        if policy == ExitPolicy::Semantic {
            selected.extend(
                self.side_exit_blocks
                    .iter()
                    .copied()
                    .filter(|block| entry_reachable.contains(block)),
            );
        }
        selected
    }
}

fn policy_selects_exit(policy: ExitPolicy, kind: &ExitKind) -> bool {
    match policy {
        ExitPolicy::Semantic => true,
        ExitPolicy::NormalCompletion => matches!(kind, ExitKind::Return | ExitKind::TailCall),
    }
}

fn build_cfg<'body>(body: &'body FunctionBody, oracle: &Graph) -> ControlFlowGraph<'body> {
    match ControlFlowGraph::new(body) {
        Ok(graph) => graph,
        Err(errors) => property_panic!(
            "well-formed generated graph was rejected:\n{errors}\n{oracle:#?}\n{body:#?}"
        ),
    }
}

fn canonical_components(graph: &ControlFlowGraph<'_>) -> Vec<Vec<BlockId>> {
    let mut components = graph
        .strongly_connected_components()
        .components()
        .map(|(_, blocks)| blocks.to_vec())
        .collect::<Vec<_>>();
    for component in &mut components {
        component.sort_unstable();
    }
    components.sort();
    components
}

#[derive(Debug, Eq, PartialEq)]
struct AnalysisSnapshot {
    blocks: Vec<BlockId>,
    edges: Vec<(
        usize,
        BlockId,
        BlockId,
        CfgEdgeKind,
        Vec<ValueId>,
        Vec<Refinement>,
    )>,
    outgoing: Vec<(BlockId, Vec<usize>)>,
    incoming: Vec<(BlockId, Vec<usize>)>,
    unique_successors: Vec<(BlockId, Vec<BlockId>)>,
    unique_predecessors: Vec<(BlockId, Vec<BlockId>)>,
    exits: Vec<(usize, BlockId, ExitOrigin, ExitKind)>,
    reachable: BTreeSet<BlockId>,
    reverse_postorder: Vec<BlockId>,
    dominators: Vec<(BlockId, Option<BTreeSet<BlockId>>, Option<BlockId>)>,
    postdominators: Vec<(
        BlockId,
        Option<BTreeSet<BlockId>>,
        Option<BlockId>,
        Option<PostDominatorNode>,
    )>,
    components: Vec<Vec<BlockId>>,
}

fn snapshot(graph: &ControlFlowGraph<'_>, oracle: &Graph) -> AnalysisSnapshot {
    let blocks = graph.blocks().collect::<Vec<_>>();
    let edges = graph
        .edges()
        .map(|edge| {
            let site = match graph.edge_site(edge.id) {
                Some(EdgeSite::Ordinary(site)) => site,
                Some(EdgeSite::Exceptional(_)) => property_panic!(
                    "ordinary generated graph produced exceptional {}:\n{oracle:#?}",
                    edge.id
                ),
                None => property_panic!(
                    "generated graph has no payload for {}:\n{oracle:#?}",
                    edge.id
                ),
            };
            (
                edge.id.index(),
                edge.source,
                edge.target,
                edge.kind,
                site.arguments.clone(),
                site.refinements.clone(),
            )
        })
        .collect();
    let outgoing = blocks
        .iter()
        .map(|block| {
            (
                *block,
                graph
                    .outgoing_edge_ids(*block)
                    .iter()
                    .map(|edge| edge.index())
                    .collect(),
            )
        })
        .collect();
    let incoming = blocks
        .iter()
        .map(|block| {
            (
                *block,
                graph
                    .incoming_edge_ids(*block)
                    .iter()
                    .map(|edge| edge.index())
                    .collect(),
            )
        })
        .collect();
    let unique_successors = blocks
        .iter()
        .map(|block| (*block, graph.unique_successor_blocks(*block).to_vec()))
        .collect();
    let unique_predecessors = blocks
        .iter()
        .map(|block| (*block, graph.unique_predecessor_blocks(*block).to_vec()))
        .collect();
    let exits = graph
        .exits()
        .map(|exit| (exit.id.index(), exit.source, exit.origin, exit.kind.clone()))
        .collect();
    let dominator_tree = graph.dominators();
    let dominators = blocks
        .iter()
        .map(|block| {
            (
                *block,
                dominator_tree.collect_dominators(*block),
                dominator_tree.immediate_dominator(*block),
            )
        })
        .collect();
    let postdominator_tree = graph.post_dominators(ExitPolicy::Semantic);
    let postdominators = blocks
        .iter()
        .map(|block| {
            (
                *block,
                postdominator_tree.collect_postdominators(*block),
                postdominator_tree.immediate_postdominator(*block),
                postdominator_tree.immediate_postdominator_node(*block),
            )
        })
        .collect();
    AnalysisSnapshot {
        blocks,
        edges,
        outgoing,
        incoming,
        unique_successors,
        unique_predecessors,
        exits,
        reachable: graph.reachable_blocks().clone(),
        reverse_postorder: graph.reverse_postorder().to_vec(),
        dominators,
        postdominators,
        components: canonical_components(graph),
    }
}

#[hegel::test(test_cases = 800, derandomize = true, database = None)]
fn multigraph_edge_inventory_matches_occurrence_oracle(tc: TestCase) {
    let oracle = Graph::draw(&tc);
    let body = oracle.body();
    let graph = build_cfg(&body, &oracle);
    let expected_edges = oracle.expected_edges();

    property_assert_eq!(
        graph.edges().len(),
        expected_edges.len(),
        "edge occurrence count disagrees with oracle:\n{oracle:#?}"
    );
    for (index, (actual, expected)) in graph.edges().zip(&expected_edges).enumerate() {
        property_assert_eq!(
            actual.id.index(),
            index,
            "edge IDs are not contiguous in canonical occurrence order:\n{oracle:#?}"
        );
        property_assert_eq!(
            (actual.source, actual.target, actual.kind),
            (expected.source, expected.target, expected.kind),
            "edge {index} topology or occurrence kind disagrees with oracle:\n{oracle:#?}"
        );
        property_assert_eq!(
            graph.edge(actual.id),
            Some(actual),
            "edge lookup failed for edge {index}:\n{oracle:#?}"
        );
        let site = match graph.edge_site(actual.id) {
            Some(EdgeSite::Ordinary(site)) => site,
            Some(EdgeSite::Exceptional(_)) => {
                property_panic!("ordinary edge {index} was classified as exceptional:\n{oracle:#?}")
            }
            None => property_panic!("edge {index} has no borrowed IR site:\n{oracle:#?}"),
        };
        property_assert_eq!(
            site.arguments.as_slice(),
            &[expected.argument],
            "edge {index} lost its occurrence-local argument:\n{oracle:#?}"
        );
        property_assert!(
            site.refinements.is_empty(),
            "edge {index} acquired a spurious refinement:\n{oracle:#?}"
        );
    }

    for source in 0..oracle.block_count() {
        let source_id = BlockId(source as u32);
        let expected = &oracle.successors[source];
        property_assert_eq!(
            graph.successor_blocks(source_id).collect::<Vec<_>>(),
            expected
                .iter()
                .map(|target| BlockId(*target as u32))
                .collect::<Vec<_>>(),
            "outgoing multiplicity/order disagrees for {source_id}:\n{oracle:#?}"
        );
        let expected_unique = oracle
            .unique_successors(source)
            .into_iter()
            .map(|target| BlockId(target as u32))
            .collect::<Vec<_>>();
        property_assert_eq!(
            graph.unique_successor_blocks(source_id),
            expected_unique.as_slice(),
            "deduplicated successors disagree for {source_id}:\n{oracle:#?}"
        );
    }

    for target in 0..oracle.block_count() {
        let target_id = BlockId(target as u32);
        let expected_predecessors = expected_edges
            .iter()
            .filter(|edge| edge.target == target_id)
            .map(|edge| edge.source)
            .collect::<Vec<_>>();
        property_assert_eq!(
            graph.predecessor_blocks(target_id).collect::<Vec<_>>(),
            expected_predecessors,
            "incoming multiplicity/order disagrees for {target_id}:\n{oracle:#?}"
        );
        let mut seen = BTreeSet::new();
        let unique = expected_edges
            .iter()
            .filter(|edge| edge.target == target_id)
            .map(|edge| edge.source)
            .filter(|source| seen.insert(*source))
            .collect::<Vec<_>>();
        property_assert_eq!(
            graph.unique_predecessor_blocks(target_id),
            unique.as_slice(),
            "deduplicated predecessors disagree for {target_id}:\n{oracle:#?}"
        );
    }
}

#[hegel::test(test_cases = 800, derandomize = true, database = None)]
fn reachability_dominance_and_idom_match_path_oracles(tc: TestCase) {
    let oracle = Graph::draw(&tc);
    let body = oracle.body();
    let graph = build_cfg(&body, &oracle);
    let dominators = graph.dominators();
    let reachable = oracle.entry_reachable();
    let expected_reachable = reachable
        .iter()
        .map(|block| BlockId(*block as u32))
        .collect::<BTreeSet<_>>();

    property_assert_eq!(
        graph.reachable_blocks(),
        &expected_reachable,
        "entry reachability disagrees with graph-search oracle:\n{oracle:#?}"
    );
    let expected_rpo = oracle
        .reverse_postorder()
        .into_iter()
        .map(|block| BlockId(block as u32))
        .collect::<Vec<_>>();
    property_assert_eq!(
        graph.reverse_postorder(),
        expected_rpo.as_slice(),
        "reverse postorder disagrees with recursive DFS oracle:\n{oracle:#?}"
    );

    for block in 0..oracle.block_count() {
        let block_id = BlockId(block as u32);
        property_assert_eq!(
            graph.is_reachable(block_id),
            reachable.contains(&block),
            "single-block reachability disagrees for {block_id}:\n{oracle:#?}"
        );
        property_assert_eq!(
            dominators.is_reachable(block_id),
            reachable.contains(&block),
            "dominator reachability disagrees for {block_id}:\n{oracle:#?}"
        );

        let expected_set = reachable.contains(&block).then(|| {
            (0..oracle.block_count())
                .filter(|candidate| oracle.dominates(*candidate, block))
                .map(|candidate| BlockId(candidate as u32))
                .collect::<BTreeSet<_>>()
        });
        property_assert_eq!(
            dominators.collect_dominators(block_id),
            expected_set,
            "dominator set disagrees for {block_id}:\n{oracle:#?}"
        );
        property_assert_eq!(
            dominators.immediate_dominator(block_id),
            oracle
                .immediate_dominator(block)
                .map(|candidate| BlockId(candidate as u32)),
            "immediate dominator disagrees for {block_id}:\n{oracle:#?}"
        );

        for candidate in 0..oracle.block_count() {
            let candidate_id = BlockId(candidate as u32);
            property_assert_eq!(
                dominators.dominates(candidate_id, block_id),
                oracle.dominates(candidate, block),
                "all-pairs dominance disagrees for {candidate_id} -> {block_id}:\n{oracle:#?}"
            );
            property_assert_eq!(
                dominators.strictly_dominates(candidate_id, block_id),
                candidate != block && oracle.dominates(candidate, block),
                "strict dominance disagrees for {candidate_id} -> {block_id}:\n{oracle:#?}"
            );
        }
    }
}

#[hegel::test(test_cases = 700, derandomize = true, database = None)]
fn sccs_match_mutual_reachability_oracle(tc: TestCase) {
    let oracle = Graph::draw(&tc);
    let body = oracle.body();
    let graph = build_cfg(&body, &oracle);
    let components = graph.strongly_connected_components();

    property_assert_eq!(
        canonical_components(&graph),
        oracle.components(),
        "SCC partition disagrees with mutual-reachability oracle:\n{oracle:#?}"
    );
    for left in 0..oracle.block_count() {
        let left_id = BlockId(left as u32);
        let component = match components.component(left_id) {
            Some(component) => component,
            None => property_panic!("{left_id} has no SCC assignment:\n{oracle:#?}"),
        };
        let expected_blocks = (0..oracle.block_count())
            .filter(|right| oracle.reaches(left, *right) && oracle.reaches(*right, left))
            .map(|right| BlockId(right as u32))
            .collect::<Vec<_>>();
        property_assert_eq!(
            components.blocks(component),
            Some(expected_blocks.as_slice()),
            "SCC members disagree for {left_id}:\n{oracle:#?}"
        );
        let expected_cyclic = expected_blocks.len() > 1
            || oracle.successors[left]
                .iter()
                .any(|successor| *successor == left);
        property_assert_eq!(
            components.is_cyclic(component),
            expected_cyclic,
            "SCC cyclicity disagrees for {left_id}:\n{oracle:#?}"
        );

        for right in 0..oracle.block_count() {
            let right_id = BlockId(right as u32);
            property_assert_eq!(
                components.same_component(left_id, right_id),
                oracle.reaches(left, right) && oracle.reaches(right, left),
                "SCC relation disagrees for {left_id} and {right_id}:\n{oracle:#?}"
            );
        }
    }
}

#[hegel::test(test_cases = 600, derandomize = true, database = None)]
fn analysis_is_invariant_under_body_storage_order(tc: TestCase) {
    let oracle = Graph::draw(&tc);
    let body = oracle.body();
    let baseline_graph = build_cfg(&body, &oracle);
    let baseline = snapshot(&baseline_graph, &oracle);

    let mut reordered = body.clone();
    for upper in (1..reordered.blocks.len()).rev() {
        let other = tc.draw(gs::integers::<usize>().max_value(upper));
        reordered.blocks.swap(upper, other);
    }
    if tc.draw(gs::booleans()) {
        reordered.blocks.reverse();
    }
    reordered.regions.reverse();
    let reordered_graph = build_cfg(&reordered, &oracle);
    let actual = snapshot(&reordered_graph, &oracle);

    property_assert_eq!(
        actual,
        baseline,
        "analysis changed when FunctionBody storage order changed:\n{oracle:#?}\n{reordered:#?}"
    );
}

#[hegel::test(test_cases = 650, derandomize = true, database = None)]
fn postdominance_matches_path_removal_on_exit_reaching_dags(tc: TestCase) {
    let oracle = Graph::draw_exit_reaching(&tc);
    let body = oracle.body();
    let graph = build_cfg(&body, &oracle);
    let semantic = graph.post_dominators(ExitPolicy::Semantic);
    let normal = graph.post_dominators(ExitPolicy::NormalCompletion);
    let exit = BlockId((oracle.block_count() - 1) as u32);

    property_assert_eq!(
        graph
            .exits()
            .map(|item| (item.source, item.origin, item.kind.clone()))
            .collect::<Vec<_>>(),
        vec![(exit, ExitOrigin::Terminator, ExitKind::Return)],
        "exit-reaching DAG did not retain its sole return exit:\n{oracle:#?}"
    );
    for block in 0..oracle.block_count() {
        let block_id = BlockId(block as u32);
        property_assert!(
            semantic.can_reach_exit(block_id) && normal.can_reach_exit(block_id),
            "{block_id} unexpectedly cannot reach the generated exit:\n{oracle:#?}"
        );
        let expected_set = (0..oracle.block_count())
            .filter(|candidate| oracle.postdominates_sole_exit(*candidate, block))
            .map(|candidate| BlockId(candidate as u32))
            .collect::<BTreeSet<_>>();
        property_assert_eq!(
            semantic.collect_postdominators(block_id),
            Some(expected_set.clone()),
            "semantic postdominator set disagrees for {block_id}:\n{oracle:#?}"
        );
        property_assert_eq!(
            normal.collect_postdominators(block_id),
            Some(expected_set),
            "normal-completion postdominator set disagrees for {block_id}:\n{oracle:#?}"
        );
        let expected_immediate = oracle
            .immediate_postdominator(block)
            .map(|candidate| BlockId(candidate as u32));
        let expected_immediate_node = Some(
            expected_immediate
                .map(PostDominatorNode::Block)
                .unwrap_or(PostDominatorNode::VirtualExit),
        );
        property_assert_eq!(
            semantic.immediate_postdominator(block_id),
            expected_immediate,
            "semantic immediate postdominator disagrees for {block_id}:\n{oracle:#?}"
        );
        property_assert_eq!(
            normal.immediate_postdominator(block_id),
            expected_immediate,
            "normal immediate postdominator disagrees for {block_id}:\n{oracle:#?}"
        );
        property_assert_eq!(
            semantic.immediate_postdominator_node(block_id),
            expected_immediate_node,
            "semantic immediate postdominator node disagrees for {block_id}:\n{oracle:#?}"
        );
        property_assert_eq!(
            normal.immediate_postdominator_node(block_id),
            expected_immediate_node,
            "normal immediate postdominator node disagrees for {block_id}:\n{oracle:#?}"
        );

        for candidate in 0..oracle.block_count() {
            let candidate_id = BlockId(candidate as u32);
            let expected = oracle.postdominates_sole_exit(candidate, block);
            property_assert_eq!(
                semantic.postdominates(candidate_id, block_id),
                expected,
                "semantic postdominance disagrees for {candidate_id} -> {block_id}:\n{oracle:#?}"
            );
            property_assert_eq!(
                normal.postdominates(candidate_id, block_id),
                expected,
                "normal postdominance disagrees for {candidate_id} -> {block_id}:\n{oracle:#?}"
            );
        }
    }
}

#[hegel::test(test_cases = 700, derandomize = true, database = None)]
fn cyclic_multi_exit_postdominance_matches_finite_path_oracle(tc: TestCase) {
    let oracle = CyclicExitGraph::draw(&tc);
    let body = oracle.body();
    let graph = build_cfg(&body, &oracle.graph);

    property_assert!(
        graph
            .strongly_connected_components()
            .same_component(BlockId(1), BlockId(2)),
        "generated postdom graph lost its required cycle:\n{oracle:#?}"
    );
    for policy in [ExitPolicy::Semantic, ExitPolicy::NormalCompletion] {
        let selected_exit_sources = oracle.selected_exit_sources(policy);
        let actual_exit_sources = graph
            .exits()
            .filter(|exit| graph.is_reachable(exit.source))
            .filter(|exit| policy_selects_exit(policy, &exit.kind))
            .map(|exit| exit.source)
            .collect::<BTreeSet<_>>();
        let expected_exit_sources = selected_exit_sources
            .iter()
            .map(|block| BlockId(*block as u32))
            .collect::<BTreeSet<_>>();
        property_assert_eq!(
            actual_exit_sources,
            expected_exit_sources,
            "selected exit sources disagree for {policy:?}:\n{oracle:#?}"
        );
        property_assert!(
            selected_exit_sources.len() >= 2,
            "generated graph has fewer than two selected exits for {policy:?}:\n{oracle:#?}"
        );

        let postdominators = graph.post_dominators(policy);
        let expected_sets = oracle
            .graph
            .postdominator_sets_for_exits(&selected_exit_sources);
        for block in 0..oracle.graph.block_count() {
            let block_id = BlockId(block as u32);
            let expected_set = expected_sets[block].as_ref();
            property_assert_eq!(
                postdominators.can_reach_exit(block_id),
                expected_set.is_some(),
                "finite selected-exit reachability disagrees for {block_id} under {policy:?}:\n{oracle:#?}"
            );

            let expected_block_ids = expected_set.map(|set| {
                set.iter()
                    .map(|candidate| BlockId(*candidate as u32))
                    .collect::<BTreeSet<_>>()
            });
            property_assert_eq!(
                postdominators.collect_postdominators(block_id),
                expected_block_ids,
                "postdominator set disagrees for {block_id} under {policy:?}:\n{oracle:#?}"
            );
            let expected_immediate = oracle
                .graph
                .immediate_postdominator_from_sets(block, &expected_sets)
                .map(|candidate| BlockId(candidate as u32));
            property_assert_eq!(
                postdominators.immediate_postdominator(block_id),
                expected_immediate,
                "immediate postdominator disagrees for {block_id} under {policy:?}:\n{oracle:#?}"
            );
            property_assert_eq!(
                postdominators.immediate_postdominator_node(block_id),
                oracle
                    .graph
                    .immediate_postdominator_node_from_sets(block, &expected_sets),
                "immediate postdominator node disagrees for {block_id} under {policy:?}:\n{oracle:#?}"
            );

            for candidate in 0..oracle.graph.block_count() {
                let candidate_id = BlockId(candidate as u32);
                let expected = expected_set.is_some_and(|set| set.contains(&candidate));
                property_assert_eq!(
                    postdominators.postdominates(candidate_id, block_id),
                    expected,
                    "postdominance disagrees for {candidate_id} -> {block_id} under {policy:?}:\n{oracle:#?}"
                );
                property_assert_eq!(
                    postdominators.strictly_postdominates(candidate_id, block_id),
                    candidate != block && expected,
                    "strict postdominance disagrees for {candidate_id} -> {block_id} under {policy:?}:\n{oracle:#?}"
                );
            }
        }

        for source in &selected_exit_sources {
            let source_id = BlockId(*source as u32);
            property_assert_eq!(
                postdominators.immediate_postdominator_node(source_id),
                Some(PostDominatorNode::VirtualExit),
                "selected exit source {source_id} did not point directly to the virtual exit under {policy:?}:\n{oracle:#?}"
            );
        }

        if policy == ExitPolicy::NormalCompletion {
            property_assert!(
                postdominators.postdominates(BlockId(2), BlockId(1)),
                "the finite exit path through the generated cycle lost block2 as a postdominator:\n{oracle:#?}"
            );
            property_assert_eq!(
                postdominators.immediate_postdominator(BlockId(1)),
                Some(BlockId(2)),
                "infinite looping paths incorrectly affected finite-exit immediate postdominance:\n{oracle:#?}"
            );
        }
    }
}
