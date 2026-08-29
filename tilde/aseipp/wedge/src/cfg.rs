// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Target-independent control-flow analysis for Wedge's semantic Wasm IR.
//!
//! A [`ControlFlowGraph`] is an immutable, borrowed snapshot. It treats the
//! body as a directed multigraph: two branch arms or switch cases which name
//! the same block remain distinct edge occurrences. This is required both by
//! Wedge's edge-local refinement facts and by conventional SSA backends whose
//! parallel successor edges can carry different block arguments.
//!
//! In-function edges and exits are intentionally separate. Returns, tail
//! calls, traps, and escaping exceptions do not invent synthetic [`BlockId`]s,
//! but their explicit inventory lets post-dominance select a documented exit
//! policy. No target layout, ABI, register, or block-packing policy belongs in
//! this module.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::OnceLock;

use crate::ir::{
    Block, BlockId, Edge as IrEdge, ExceptionEffect, ExceptionalEdge, FunctionBody, InstructionId,
    Region, RegionId, TerminatorKind, TrapCode,
};

/// The snapshot-local identity of one in-function edge occurrence.
///
/// IDs are deterministic for one body snapshot, but become invalid when the
/// body is mutated and the graph is rebuilt. They are deliberately not IR
/// entity identifiers.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EdgeId(u32);

impl EdgeId {
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

impl fmt::Display for EdgeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "edge{}", self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BranchDirection {
    True,
    False,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EdgeClass {
    Normal,
    Exceptional,
}

/// The semantic origin of one in-function edge occurrence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EdgeKind {
    Jump,
    Branch(BranchDirection),
    SwitchCase {
        index: u32,
    },
    SwitchDefault,
    /// The normal continuation of an invoke terminator.
    InvokeNormal,
    /// One arm of a terminator's exceptional routing.
    Exceptional {
        arm: u32,
        handler: RegionId,
        clause: u32,
    },
}

impl EdgeKind {
    pub const fn class(self) -> EdgeClass {
        if self.is_exceptional() {
            EdgeClass::Exceptional
        } else {
            EdgeClass::Normal
        }
    }

    pub const fn is_exceptional(self) -> bool {
        matches!(self, Self::Exceptional { .. })
    }
}

/// Topology for one edge occurrence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Edge {
    pub id: EdgeId,
    pub source: BlockId,
    pub target: BlockId,
    pub kind: EdgeKind,
}

/// The authoritative IR payload attached to one edge occurrence.
///
/// Ordinary and exceptional arguments remain distinct because caught payloads
/// and exception references are produced by dispatch rather than ordinary SSA
/// definitions. Consumers which pair arguments with target parameters must
/// also check arity instead of silently truncating with `zip`.
#[derive(Clone, Copy, Debug)]
pub enum EdgeSite<'body> {
    Ordinary(&'body IrEdge),
    Exceptional(&'body ExceptionalEdge),
}

impl<'body> EdgeSite<'body> {
    pub const fn ordinary(self) -> Option<&'body IrEdge> {
        match self {
            Self::Ordinary(edge) => Some(edge),
            Self::Exceptional(_) => None,
        }
    }

    pub const fn exceptional(self) -> Option<&'body ExceptionalEdge> {
        match self {
            Self::Ordinary(_) => None,
            Self::Exceptional(edge) => Some(edge),
        }
    }

    pub fn argument_count(self) -> usize {
        match self {
            Self::Ordinary(edge) => edge.arguments.len(),
            Self::Exceptional(edge) => edge.arguments.len(),
        }
    }
}

/// The snapshot-local identity of one function exit occurrence.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ExitId(u32);

impl ExitId {
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

impl fmt::Display for ExitId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "exit{}", self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitOrigin {
    Instruction {
        instruction: InstructionId,
        position: u32,
    },
    Terminator,
}

/// The semantic reason control can leave a function.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExitKind {
    Return,
    TailCall,
    Trap(TrapCode),
    ExceptionEscape,
}

/// One distinct way control can leave the function.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Exit {
    pub id: ExitId,
    pub source: BlockId,
    pub origin: ExitOrigin,
    pub kind: ExitKind,
}

/// Which exits terminate paths for post-dominance.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ExitPolicy {
    /// Every semantically observable exit: normal completion, tail transfer,
    /// traps, and escaping exceptions.
    #[default]
    Semantic,
    /// Only successful return or tail transfer. This graph-only view is useful
    /// for layout, but is not sufficient for speculation or motion across
    /// potentially trapping or throwing operations.
    NormalCompletion,
}

impl ExitPolicy {
    fn includes(self, exit: &Exit) -> bool {
        match self {
            Self::Semantic => true,
            Self::NormalCompletion => {
                matches!(exit.kind, ExitKind::Return | ExitKind::TailCall)
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum BuildError {
    #[error("duplicate block identifier {0}")]
    DuplicateBlock(BlockId),
    #[error("duplicate region identifier {0}")]
    DuplicateRegion(RegionId),
    #[error("CFG entry references missing {0}")]
    MissingEntry(BlockId),
    #[error("edge from {block} targets missing {target}")]
    MissingTarget { block: BlockId, target: BlockId },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuildErrors(Vec<BuildError>);

impl BuildErrors {
    pub fn errors(&self) -> &[BuildError] {
        &self.0
    }

    pub fn into_errors(self) -> Vec<BuildError> {
        self.0
    }
}

impl fmt::Display for BuildErrors {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, error) in self.0.iter().enumerate() {
            if index != 0 {
                formatter.write_str("\n")?;
            }
            error.fmt(formatter)?;
        }
        Ok(())
    }
}

impl std::error::Error for BuildErrors {}

/// A deterministic, borrowed multigraph over one [`FunctionBody`].
pub struct ControlFlowGraph<'body> {
    entry: BlockId,
    blocks: Vec<BlockId>,
    block_set: BTreeSet<BlockId>,
    block_definitions: BTreeMap<BlockId, &'body Block>,
    region_definitions: BTreeMap<RegionId, &'body Region>,
    edges: Vec<Edge>,
    sites: Vec<EdgeSite<'body>>,
    outgoing: BTreeMap<BlockId, Vec<EdgeId>>,
    incoming: BTreeMap<BlockId, Vec<EdgeId>>,
    unique_successors: BTreeMap<BlockId, Vec<BlockId>>,
    unique_predecessors: BTreeMap<BlockId, Vec<BlockId>>,
    exits: Vec<Exit>,
    exits_by_source: BTreeMap<BlockId, Vec<ExitId>>,
    reachable: BTreeSet<BlockId>,
    reverse_postorder: Vec<BlockId>,
    dominators: OnceLock<Dominators>,
}

impl fmt::Debug for ControlFlowGraph<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ControlFlowGraph")
            .field("entry", &self.entry)
            .field("blocks", &self.blocks)
            .field("edges", &self.edges)
            .field("exits", &self.exits)
            .finish_non_exhaustive()
    }
}

impl<'body> ControlFlowGraph<'body> {
    /// Build a strict graph snapshot.
    ///
    /// The body need not have been through [`crate::ir::Program::verify`], so
    /// this constructor rejects malformed identifiers and unresolved edge
    /// targets instead of panicking or silently dropping them. It does not
    /// replace full IR verification: SSA, types, effects, and exception-route
    /// legality must be verified before semantic analyses or backends rely on
    /// this snapshot.
    pub fn new(body: &'body FunctionBody) -> Result<Self, BuildErrors> {
        let mut errors = Vec::new();
        let mut blocks = BTreeMap::new();
        for block in &body.blocks {
            if blocks.insert(block.id, block).is_some() {
                errors.push(BuildError::DuplicateBlock(block.id));
            }
        }
        let mut regions = BTreeMap::new();
        for region in &body.regions {
            if regions.insert(region.id, region).is_some() {
                errors.push(BuildError::DuplicateRegion(region.id));
            }
        }
        if !blocks.contains_key(&body.entry) {
            errors.push(BuildError::MissingEntry(body.entry));
        }

        let (graph, errors) = Self::build(body.entry, blocks, regions, errors);
        if errors.is_empty() {
            Ok(graph)
        } else {
            Err(BuildErrors(errors))
        }
    }

    /// Build the portion of a graph which the IR verifier has already indexed
    /// and is in the process of diagnosing.
    ///
    /// Unlike [`Self::new`], this diagnostic-only path can retain unresolved
    /// edge occurrences in the occurrence inventory. Topology algorithms
    /// exclude those occurrences from their resolved block adjacency.
    pub(crate) fn from_indexed(
        entry: BlockId,
        blocks: &BTreeMap<BlockId, &'body Block>,
        regions: &BTreeMap<RegionId, &'body Region>,
    ) -> Self {
        Self::build(entry, blocks.clone(), regions.clone(), Vec::new()).0
    }

    fn build(
        entry: BlockId,
        blocks: BTreeMap<BlockId, &'body Block>,
        regions: BTreeMap<RegionId, &'body Region>,
        mut errors: Vec<BuildError>,
    ) -> (Self, Vec<BuildError>) {
        let block_ids = blocks.keys().copied().collect::<Vec<_>>();
        let block_set = block_ids.iter().copied().collect::<BTreeSet<_>>();
        let mut graph = Self {
            entry,
            blocks: block_ids,
            block_set,
            block_definitions: BTreeMap::new(),
            region_definitions: BTreeMap::new(),
            edges: Vec::new(),
            sites: Vec::new(),
            outgoing: BTreeMap::new(),
            incoming: BTreeMap::new(),
            unique_successors: BTreeMap::new(),
            unique_predecessors: BTreeMap::new(),
            exits: Vec::new(),
            exits_by_source: BTreeMap::new(),
            reachable: BTreeSet::new(),
            reverse_postorder: Vec::new(),
            dominators: OnceLock::new(),
        };
        for block in &graph.blocks {
            graph.outgoing.insert(*block, Vec::new());
            graph.incoming.insert(*block, Vec::new());
            graph.unique_successors.insert(*block, Vec::new());
            graph.unique_predecessors.insert(*block, Vec::new());
            graph.exits_by_source.insert(*block, Vec::new());
        }

        for (&source, block) in &blocks {
            match &block.terminator.kind {
                TerminatorKind::Jump(edge) => {
                    graph.push_ordinary_edge(source, edge, EdgeKind::Jump, &mut errors);
                }
                TerminatorKind::Invoke { normal, .. } => {
                    graph.push_ordinary_edge(source, normal, EdgeKind::InvokeNormal, &mut errors);
                }
                TerminatorKind::Branch {
                    then_edge,
                    else_edge,
                    ..
                } => {
                    graph.push_ordinary_edge(
                        source,
                        then_edge,
                        EdgeKind::Branch(BranchDirection::True),
                        &mut errors,
                    );
                    graph.push_ordinary_edge(
                        source,
                        else_edge,
                        EdgeKind::Branch(BranchDirection::False),
                        &mut errors,
                    );
                }
                TerminatorKind::Switch {
                    targets, default, ..
                } => {
                    for (index, edge) in targets.iter().enumerate() {
                        graph.push_ordinary_edge(
                            source,
                            edge,
                            EdgeKind::SwitchCase {
                                index: index as u32,
                            },
                            &mut errors,
                        );
                    }
                    graph.push_ordinary_edge(source, default, EdgeKind::SwitchDefault, &mut errors);
                }
                TerminatorKind::Return { .. }
                | TerminatorKind::TailCall { .. }
                | TerminatorKind::Throw { .. }
                | TerminatorKind::ThrowRef { .. }
                | TerminatorKind::Unreachable { .. } => {}
            }
            if let Some(routing) = &block.terminator.exception {
                graph.push_exception_routing(source, routing, &mut errors);
            }

            for (position, instruction) in block.instructions.iter().enumerate() {
                let origin = ExitOrigin::Instruction {
                    instruction: instruction.id,
                    position: position as u32,
                };
                for trap in &instruction.effects.traps {
                    graph.push_exit(source, origin, ExitKind::Trap(trap.clone()));
                }
                if instruction.effects.exception == ExceptionEffect::MayThrow {
                    graph.push_exit(source, origin, ExitKind::ExceptionEscape);
                }
            }

            match &block.terminator.kind {
                TerminatorKind::Return { .. } => {
                    graph.push_exit(source, ExitOrigin::Terminator, ExitKind::Return);
                }
                TerminatorKind::TailCall { .. } => {
                    graph.push_exit(source, ExitOrigin::Terminator, ExitKind::TailCall);
                }
                TerminatorKind::Jump(_)
                | TerminatorKind::Invoke { .. }
                | TerminatorKind::Branch { .. }
                | TerminatorKind::Switch { .. }
                | TerminatorKind::Throw { .. }
                | TerminatorKind::ThrowRef { .. }
                | TerminatorKind::Unreachable { .. } => {}
            }
            let terminator_effects =
                crate::semantics::effects_for_terminator(&block.terminator.kind);
            for trap in terminator_effects.traps {
                graph.push_exit(source, ExitOrigin::Terminator, ExitKind::Trap(trap));
            }
            if block
                .terminator
                .exception
                .as_ref()
                .is_some_and(|routing| routing.escapes)
            {
                graph.push_exit(source, ExitOrigin::Terminator, ExitKind::ExceptionEscape);
            }
        }

        graph.block_definitions = blocks;
        graph.region_definitions = regions;
        graph.rebuild_unique_adjacency();
        graph.reverse_postorder = graph.compute_reverse_postorder();
        graph.reachable = graph.reverse_postorder.iter().copied().collect();
        (graph, errors)
    }

    fn push_ordinary_edge(
        &mut self,
        source: BlockId,
        edge: &'body IrEdge,
        kind: EdgeKind,
        errors: &mut Vec<BuildError>,
    ) -> EdgeId {
        if !self.block_set.contains(&edge.target) {
            errors.push(BuildError::MissingTarget {
                block: source,
                target: edge.target,
            });
        }
        self.push_edge(source, edge.target, kind, EdgeSite::Ordinary(edge))
    }

    fn push_exception_routing(
        &mut self,
        source: BlockId,
        routing: &'body crate::ir::ExceptionRouting,
        errors: &mut Vec<BuildError>,
    ) {
        for (arm_index, arm) in routing.arms.iter().enumerate() {
            if !self.block_set.contains(&arm.target) {
                errors.push(BuildError::MissingTarget {
                    block: source,
                    target: arm.target,
                });
            }
            self.push_edge(
                source,
                arm.target,
                EdgeKind::Exceptional {
                    arm: arm_index as u32,
                    handler: arm.handler,
                    clause: arm.clause,
                },
                EdgeSite::Exceptional(arm),
            );
        }
    }

    fn push_edge(
        &mut self,
        source: BlockId,
        target: BlockId,
        kind: EdgeKind,
        site: EdgeSite<'body>,
    ) -> EdgeId {
        let id = EdgeId(self.edges.len() as u32);
        self.edges.push(Edge {
            id,
            source,
            target,
            kind,
        });
        self.sites.push(site);
        self.outgoing.entry(source).or_default().push(id);
        self.incoming.entry(target).or_default().push(id);
        id
    }

    fn push_exit(&mut self, source: BlockId, origin: ExitOrigin, kind: ExitKind) {
        let id = ExitId(self.exits.len() as u32);
        self.exits.push(Exit {
            id,
            source,
            origin,
            kind,
        });
        self.exits_by_source.entry(source).or_default().push(id);
    }

    fn rebuild_unique_adjacency(&mut self) {
        let mut successor_pairs = BTreeSet::new();
        let mut predecessor_pairs = BTreeSet::new();
        for edge in &self.edges {
            if !self.block_set.contains(&edge.source) || !self.block_set.contains(&edge.target) {
                continue;
            }
            if successor_pairs.insert((edge.source, edge.target)) {
                self.unique_successors
                    .entry(edge.source)
                    .or_default()
                    .push(edge.target);
            }
            if predecessor_pairs.insert((edge.target, edge.source)) {
                self.unique_predecessors
                    .entry(edge.target)
                    .or_default()
                    .push(edge.source);
            }
        }
    }

    pub const fn entry(&self) -> BlockId {
        self.entry
    }

    /// Unique block identifiers in deterministic identifier order.
    pub fn blocks(&self) -> impl DoubleEndedIterator<Item = BlockId> + ExactSizeIterator + '_ {
        self.blocks.iter().copied()
    }

    pub fn contains_block(&self, block: BlockId) -> bool {
        self.block_set.contains(&block)
    }

    /// Resolve a block without rebuilding an index over the borrowed body.
    pub fn block(&self, block: BlockId) -> Option<&'body Block> {
        self.block_definitions.get(&block).copied()
    }

    /// Resolve a structured source region used by an exceptional edge.
    pub fn region(&self, region: RegionId) -> Option<&'body Region> {
        self.region_definitions.get(&region).copied()
    }

    /// All in-function edge occurrences in deterministic order.
    pub fn edges(&self) -> impl DoubleEndedIterator<Item = &Edge> + ExactSizeIterator + '_ {
        self.edges.iter()
    }

    pub fn edge(&self, id: EdgeId) -> Option<&Edge> {
        self.edges.get(id.index())
    }

    pub fn edge_site(&self, id: EdgeId) -> Option<EdgeSite<'body>> {
        self.sites.get(id.index()).copied()
    }

    pub fn outgoing_edge_ids(&self, block: BlockId) -> &[EdgeId] {
        self.outgoing.get(&block).map_or(&[], Vec::as_slice)
    }

    pub fn incoming_edge_ids(&self, block: BlockId) -> &[EdgeId] {
        self.incoming.get(&block).map_or(&[], Vec::as_slice)
    }

    pub fn outgoing_edges(
        &self,
        block: BlockId,
    ) -> impl DoubleEndedIterator<Item = &Edge> + ExactSizeIterator + '_ {
        self.outgoing_edge_ids(block)
            .iter()
            .map(|id| &self.edges[id.index()])
    }

    pub fn incoming_edges(
        &self,
        block: BlockId,
    ) -> impl DoubleEndedIterator<Item = &Edge> + ExactSizeIterator + '_ {
        self.incoming_edge_ids(block)
            .iter()
            .map(|id| &self.edges[id.index()])
    }

    /// Successor blocks with one item per edge occurrence.
    pub fn successor_blocks(&self, block: BlockId) -> impl Iterator<Item = BlockId> + '_ {
        self.outgoing_edges(block).map(|edge| edge.target)
    }

    /// Predecessor blocks with one item per edge occurrence.
    pub fn predecessor_blocks(&self, block: BlockId) -> impl Iterator<Item = BlockId> + '_ {
        self.incoming_edges(block).map(|edge| edge.source)
    }

    /// Deduplicated successors, ordered by their first edge occurrence.
    pub fn unique_successor_blocks(&self, block: BlockId) -> &[BlockId] {
        self.unique_successors
            .get(&block)
            .map_or(&[], Vec::as_slice)
    }

    /// Deduplicated predecessors, ordered by their first edge occurrence.
    pub fn unique_predecessor_blocks(&self, block: BlockId) -> &[BlockId] {
        self.unique_predecessors
            .get(&block)
            .map_or(&[], Vec::as_slice)
    }

    pub fn exits(&self) -> impl DoubleEndedIterator<Item = &Exit> + ExactSizeIterator + '_ {
        self.exits.iter()
    }

    pub fn exit(&self, id: ExitId) -> Option<&Exit> {
        self.exits.get(id.index())
    }

    pub fn exits_from(
        &self,
        block: BlockId,
    ) -> impl DoubleEndedIterator<Item = &Exit> + ExactSizeIterator + '_ {
        self.exits_by_source(block)
            .iter()
            .map(|id| &self.exits[id.index()])
    }

    pub fn exit_ids_from(&self, block: BlockId) -> &[ExitId] {
        self.exits_by_source(block)
    }

    fn exits_by_source(&self, block: BlockId) -> &[ExitId] {
        self.exits_by_source.get(&block).map_or(&[], Vec::as_slice)
    }

    pub fn is_reachable(&self, block: BlockId) -> bool {
        self.reachable.contains(&block)
    }

    /// Entry-reachable blocks as a set, excluding every unreachable component.
    pub fn reachable_blocks(&self) -> &BTreeSet<BlockId> {
        &self.reachable
    }

    /// Entry-rooted reverse postorder. The entry is first when it exists.
    pub fn reverse_postorder(&self) -> &[BlockId] {
        &self.reverse_postorder
    }

    fn compute_reverse_postorder(&self) -> Vec<BlockId> {
        if !self.block_set.contains(&self.entry) {
            return Vec::new();
        }

        let mut visited = BTreeSet::from([self.entry]);
        let mut stack = vec![(self.entry, 0usize)];
        let mut postorder = Vec::new();
        while let Some((block, next_index)) = stack.last_mut() {
            let successors = self
                .unique_successors
                .get(block)
                .map_or(&[][..], Vec::as_slice);
            if *next_index < successors.len() {
                let successor = successors[*next_index];
                *next_index += 1;
                if visited.insert(successor) {
                    stack.push((successor, 0));
                }
            } else {
                postorder.push(*block);
                stack.pop();
            }
        }
        postorder.reverse();
        postorder
    }

    /// Entry-rooted dominance, computed once per graph on first use.
    pub fn dominators(&self) -> &Dominators {
        self.dominators.get_or_init(|| Dominators::compute(self))
    }

    /// Compute post-dominance over paths which reach one of `policy`'s exits.
    ///
    /// Entry-reachable blocks without a finite path to a selected exit have no
    /// post-dominance relation, including with themselves. Unreachable blocks
    /// and infinite paths which never reach a selected exit are outside this
    /// finite-exit relation.
    pub fn post_dominators(&self, policy: ExitPolicy) -> PostDominators {
        PostDominators::compute(self, policy)
    }

    /// Strongly connected components across all stored blocks, including
    /// components unreachable from the function entry.
    pub fn strongly_connected_components(&self) -> StronglyConnectedComponents {
        StronglyConnectedComponents::compute(self)
    }

    /// Discover reducible natural loops from dominance backedges.
    ///
    /// Irreducible cycles are represented by
    /// [`Self::strongly_connected_components`] but intentionally are not
    /// mislabeled as natural loops.
    pub fn natural_loops(&self) -> Vec<NaturalLoop> {
        let dominators = self.dominators();
        let mut by_header: BTreeMap<BlockId, NaturalLoop> = BTreeMap::new();
        for edge in &self.edges {
            if !self.block_set.contains(&edge.target)
                || !dominators.dominates(edge.target, edge.source)
            {
                continue;
            }
            let natural_loop = by_header.entry(edge.target).or_insert_with(|| NaturalLoop {
                header: edge.target,
                blocks: BTreeSet::from([edge.target]),
                back_edges: Vec::new(),
            });
            natural_loop.back_edges.push(edge.id);
            if natural_loop.blocks.insert(edge.source) && edge.source != edge.target {
                let mut pending = vec![edge.source];
                while let Some(block) = pending.pop() {
                    for predecessor in self.unique_predecessor_blocks(block) {
                        if dominators.dominates(edge.target, *predecessor)
                            && natural_loop.blocks.insert(*predecessor)
                            && *predecessor != edge.target
                        {
                            pending.push(*predecessor);
                        }
                    }
                }
            }
        }
        by_header.into_values().collect()
    }
}

#[derive(Clone, Debug)]
pub struct Dominators {
    entry: BlockId,
    immediate: BTreeMap<BlockId, BlockId>,
    intervals: BTreeMap<BlockId, TreeInterval>,
}

impl Dominators {
    fn compute(graph: &ControlFlowGraph<'_>) -> Self {
        if !graph.block_set.contains(&graph.entry) {
            return Self {
                entry: graph.entry,
                immediate: BTreeMap::new(),
                intervals: BTreeMap::new(),
            };
        }
        let forest = semi_nca(graph.entry, |block| {
            graph.unique_successor_blocks(block).iter().copied()
        });
        Self {
            entry: graph.entry,
            immediate: forest.immediate().collect(),
            intervals: forest.intervals(),
        }
    }

    pub const fn entry(&self) -> BlockId {
        self.entry
    }

    pub fn is_reachable(&self, block: BlockId) -> bool {
        self.intervals.contains_key(&block)
    }

    pub fn dominates(&self, dominator: BlockId, block: BlockId) -> bool {
        tree_contains(&self.intervals, dominator, block)
    }

    pub fn strictly_dominates(&self, dominator: BlockId, block: BlockId) -> bool {
        dominator != block && self.dominates(dominator, block)
    }

    /// Materialize the block and all of its dominator-tree ancestors.
    ///
    /// The analysis itself stores only the linear-size immediate-dominator
    /// tree. Call this when an owned set is more convenient than point or
    /// immediate-dominator queries.
    pub fn collect_dominators(&self, block: BlockId) -> Option<BTreeSet<BlockId>> {
        if !self.is_reachable(block) {
            return None;
        }
        let mut result = BTreeSet::new();
        let mut current = block;
        result.insert(current);
        while let Some(parent) = self.immediate.get(&current).copied() {
            result.insert(parent);
            current = parent;
        }
        Some(result)
    }

    pub fn immediate_dominator(&self, block: BlockId) -> Option<BlockId> {
        self.immediate.get(&block).copied()
    }
}

/// A node in the post-dominator tree.
///
/// The virtual exit joins all exits selected by an [`ExitPolicy`]. Keeping it
/// explicit distinguishes "immediately post-dominated by the joined exit"
/// from "not in the finite-exit post-dominator tree".
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum PostDominatorNode {
    VirtualExit,
    Block(BlockId),
}

#[derive(Clone, Debug)]
pub struct PostDominators {
    policy: ExitPolicy,
    immediate: BTreeMap<BlockId, PostDominatorNode>,
    intervals: BTreeMap<PostDominatorNode, TreeInterval>,
}

impl PostDominators {
    fn compute(graph: &ControlFlowGraph<'_>, policy: ExitPolicy) -> Self {
        let selected_exit_sources = graph
            .exits()
            .filter(|exit| policy.includes(exit) && graph.is_reachable(exit.source))
            .map(|exit| exit.source)
            .collect::<BTreeSet<_>>();
        let root = PostDominatorNode::VirtualExit;
        let forest = semi_nca(root, |node| match node {
            PostDominatorNode::VirtualExit => selected_exit_sources
                .iter()
                .copied()
                .map(PostDominatorNode::Block)
                .collect::<Vec<_>>(),
            PostDominatorNode::Block(block) => graph
                .unique_predecessor_blocks(block)
                .iter()
                .copied()
                .filter(|predecessor| graph.is_reachable(*predecessor))
                .map(PostDominatorNode::Block)
                .collect(),
        });
        let immediate = forest
            .immediate()
            .filter_map(|(node, parent)| match node {
                PostDominatorNode::VirtualExit => None,
                PostDominatorNode::Block(block) => Some((block, parent)),
            })
            .collect();
        Self {
            policy,
            immediate,
            intervals: forest.intervals(),
        }
    }

    pub const fn policy(&self) -> ExitPolicy {
        self.policy
    }

    /// Whether an entry-reachable block belongs to the finite-exit tree.
    pub fn can_reach_exit(&self, block: BlockId) -> bool {
        self.intervals
            .contains_key(&PostDominatorNode::Block(block))
    }

    pub fn postdominates(&self, postdominator: BlockId, block: BlockId) -> bool {
        tree_contains(
            &self.intervals,
            PostDominatorNode::Block(postdominator),
            PostDominatorNode::Block(block),
        )
    }

    pub fn strictly_postdominates(&self, postdominator: BlockId, block: BlockId) -> bool {
        postdominator != block && self.postdominates(postdominator, block)
    }

    /// Materialize the block and its block-valued post-dominator ancestors.
    ///
    /// [`PostDominatorNode::VirtualExit`] is omitted from the returned set;
    /// use [`Self::immediate_postdominator_node`] when that distinction is
    /// important.
    pub fn collect_postdominators(&self, block: BlockId) -> Option<BTreeSet<BlockId>> {
        if !self.can_reach_exit(block) {
            return None;
        }
        let mut result = BTreeSet::new();
        let mut current = block;
        result.insert(current);
        while let Some(parent) = self.immediate.get(&current).copied() {
            match parent {
                PostDominatorNode::Block(parent) => {
                    result.insert(parent);
                    current = parent;
                }
                PostDominatorNode::VirtualExit => break,
            }
        }
        Some(result)
    }

    /// The immediate relation including the synthetic join of selected exits.
    pub fn immediate_postdominator_node(&self, block: BlockId) -> Option<PostDominatorNode> {
        self.immediate.get(&block).copied()
    }

    /// The immediate block post-dominator, if it is not the virtual exit.
    pub fn immediate_postdominator(&self, block: BlockId) -> Option<BlockId> {
        match self.immediate_postdominator_node(block) {
            Some(PostDominatorNode::Block(block)) => Some(block),
            Some(PostDominatorNode::VirtualExit) | None => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct TreeInterval {
    start: usize,
    end: usize,
}

fn tree_contains<Node: Ord>(
    intervals: &BTreeMap<Node, TreeInterval>,
    ancestor: Node,
    node: Node,
) -> bool {
    intervals
        .get(&ancestor)
        .zip(intervals.get(&node))
        .is_some_and(|(ancestor, node)| ancestor.start <= node.start && node.end <= ancestor.end)
}

/// Immediate dominators of every node reachable from a root, computed with the
/// semi-NCA variant of Lengauer-Tarjan over a dense DFS preorder.
struct DominatorForest<Node> {
    /// Nodes in DFS preorder; index 0 is the root.
    preorder: Vec<Node>,
    /// The immediate dominator of `preorder[i]` as a preorder index; the root
    /// is its own.
    idom: Vec<u32>,
}

impl<Node: Copy + Ord> DominatorForest<Node> {
    /// Every node but the root with its immediate dominator.
    fn immediate(&self) -> impl Iterator<Item = (Node, Node)> + '_ {
        self.preorder
            .iter()
            .zip(&self.idom)
            .skip(1)
            .map(|(&node, &idom)| (node, self.preorder[idom as usize]))
    }

    /// Euler-tour intervals of the dominator tree, so that ancestry is an
    /// interval containment test.
    fn intervals(&self) -> BTreeMap<Node, TreeInterval> {
        let count = self.preorder.len();
        // Children in CSR form: `offsets[i]..offsets[i + 1]` of `children` are
        // the children of preorder node `i`.
        let mut offsets = vec![0usize; count + 1];
        for &idom in self.idom.iter().skip(1) {
            offsets[idom as usize + 1] += 1;
        }
        for index in 0..count {
            offsets[index + 1] += offsets[index];
        }
        let mut next_child = offsets.clone();
        let mut children = vec![0u32; offsets[count]];
        for (node, &idom) in self.idom.iter().enumerate().skip(1) {
            children[next_child[idom as usize]] = node as u32;
            next_child[idom as usize] += 1;
        }

        let mut intervals = vec![TreeInterval { start: 0, end: 0 }; count];
        let mut next = 0usize;
        let mut pending = vec![(0u32, false)];
        while let Some((node, exiting)) = pending.pop() {
            let node = node as usize;
            if exiting {
                intervals[node].end = next;
                continue;
            }
            intervals[node].start = next;
            next += 1;
            pending.push((node as u32, true));
            let node_children = &children[offsets[node]..offsets[node + 1]];
            pending.extend(node_children.iter().rev().map(|&child| (child, false)));
        }
        self.preorder.iter().copied().zip(intervals).collect()
    }
}

fn semi_nca<Node, Successors, Iter>(root: Node, mut successors: Successors) -> DominatorForest<Node>
where
    Node: Copy + Ord,
    Successors: FnMut(Node) -> Iter,
    Iter: IntoIterator<Item = Node>,
{
    let mut number = BTreeMap::from([(root, 0u32)]);
    let mut preorder = vec![root];
    let mut parent = vec![0u32];
    // Edges as (source, target) preorder indices; every target is numbered by
    // the time its edge is recorded.
    let mut edges = Vec::new();
    let mut pending = vec![(0u32, successors(root).into_iter())];
    while let Some((source, targets)) = pending.last_mut() {
        let Some(target) = targets.next() else {
            pending.pop();
            continue;
        };
        let source = *source;
        let index = match number.get(&target) {
            Some(&index) => index,
            None => {
                let index = preorder.len() as u32;
                number.insert(target, index);
                preorder.push(target);
                parent.push(source);
                pending.push((index, successors(target).into_iter()));
                index
            }
        };
        edges.push((source, index));
    }
    let count = preorder.len();
    let mut predecessors = vec![Vec::new(); count];
    for (source, target) in edges {
        predecessors[target as usize].push(source);
    }

    // Semidominators in reverse preorder. `ancestor` holds the path-compressed
    // forest links; `parent` stays the spanning tree for the final step.
    let mut semi: Vec<u32> = (0..count as u32).collect();
    let mut label: Vec<u32> = (0..count as u32).collect();
    let mut ancestor = parent.clone();
    let mut path = Vec::new();
    for node in (1..count as u32).rev() {
        let last_linked = node + 1;
        let mut best = parent[node as usize];
        for &predecessor in &predecessors[node as usize] {
            let representative = eval_semi(
                predecessor,
                last_linked,
                &mut ancestor,
                &mut label,
                &semi,
                &mut path,
            );
            best = best.min(semi[representative as usize]);
        }
        semi[node as usize] = best;
    }

    // The immediate dominator is the nearest common ancestor of the spanning
    // tree parent and the semidominator; earlier nodes are already final.
    let mut idom = parent;
    for node in 1..count {
        let mut candidate = idom[node];
        while candidate > semi[node] {
            candidate = idom[candidate as usize];
        }
        idom[node] = candidate;
    }
    DominatorForest { preorder, idom }
}

/// The node with the smallest semidominator on the forest path from `node` up
/// to, but excluding, the first unlinked ancestor, compressing that path.
fn eval_semi(
    node: u32,
    last_linked: u32,
    ancestor: &mut [u32],
    label: &mut [u32],
    semi: &[u32],
    path: &mut Vec<u32>,
) -> u32 {
    if ancestor[node as usize] < last_linked {
        return label[node as usize];
    }
    path.clear();
    let mut top = node;
    while ancestor[top as usize] >= last_linked {
        path.push(top);
        top = ancestor[top as usize];
    }
    let root_link = ancestor[top as usize];
    let mut best = label[top as usize];
    for &visited in path.iter().rev() {
        ancestor[visited as usize] = root_link;
        if semi[best as usize] < semi[label[visited as usize] as usize] {
            label[visited as usize] = best;
        } else {
            best = label[visited as usize];
        }
    }
    label[node as usize]
}

/// The snapshot-local identity of one strongly connected component.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ComponentId(u32);

impl ComponentId {
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

#[derive(Clone, Debug)]
pub struct StronglyConnectedComponents {
    components: Vec<Vec<BlockId>>,
    component_of: BTreeMap<BlockId, ComponentId>,
    cyclic: BTreeSet<ComponentId>,
}

impl StronglyConnectedComponents {
    fn compute(graph: &ControlFlowGraph<'_>) -> Self {
        let mut visited = BTreeSet::new();
        let mut finish_order = Vec::new();
        for root in graph.blocks() {
            if !visited.insert(root) {
                continue;
            }
            let mut stack = vec![(root, 0usize)];
            while let Some((block, next_index)) = stack.last_mut() {
                let successors = graph.unique_successor_blocks(*block);
                if *next_index < successors.len() {
                    let successor = successors[*next_index];
                    *next_index += 1;
                    if visited.insert(successor) {
                        stack.push((successor, 0));
                    }
                } else {
                    finish_order.push(*block);
                    stack.pop();
                }
            }
        }

        let mut assigned = BTreeSet::new();
        let mut components = Vec::new();
        while let Some(root) = finish_order.pop() {
            if !assigned.insert(root) {
                continue;
            }
            let mut component = Vec::new();
            let mut pending = vec![root];
            while let Some(block) = pending.pop() {
                component.push(block);
                for predecessor in graph.unique_predecessor_blocks(block) {
                    if assigned.insert(*predecessor) {
                        pending.push(*predecessor);
                    }
                }
            }
            component.sort_unstable();
            components.push(component);
        }

        let mut component_of = BTreeMap::new();
        let mut cyclic = BTreeSet::new();
        for (index, component) in components.iter().enumerate() {
            let id = ComponentId(index as u32);
            for block in component {
                component_of.insert(*block, id);
            }
            if component.len() > 1
                || component.first().is_some_and(|block| {
                    graph
                        .successor_blocks(*block)
                        .any(|successor| successor == *block)
                })
            {
                cyclic.insert(id);
            }
        }
        Self {
            components,
            component_of,
            cyclic,
        }
    }

    pub fn components(&self) -> impl Iterator<Item = (ComponentId, &[BlockId])> {
        self.components
            .iter()
            .enumerate()
            .map(|(index, blocks)| (ComponentId(index as u32), blocks.as_slice()))
    }

    pub fn component(&self, block: BlockId) -> Option<ComponentId> {
        self.component_of.get(&block).copied()
    }

    pub fn blocks(&self, component: ComponentId) -> Option<&[BlockId]> {
        self.components.get(component.index()).map(Vec::as_slice)
    }

    pub fn same_component(&self, left: BlockId, right: BlockId) -> bool {
        self.component(left)
            .zip(self.component(right))
            .is_some_and(|(left, right)| left == right)
    }

    pub fn is_cyclic(&self, component: ComponentId) -> bool {
        self.cyclic.contains(&component)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NaturalLoop {
    pub header: BlockId,
    pub blocks: BTreeSet<BlockId>,
    pub back_edges: Vec<EdgeId>,
}
