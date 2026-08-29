// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Editing function bodies.
//!
//! A [`FunctionBody`] is plain data, so a pass may rewrite it directly. The
//! operations here are the ones every pass needs and the ones that have to
//! keep several parts of the body consistent at once: renaming a value at
//! every use, removing a block parameter together with the argument each
//! predecessor delivers to it, and removing blocks together with the regions
//! they were the entry of. They maintain two conventions the frontend
//! establishes and the interpreter relies on: blocks and regions are stored
//! at their index, so a removal renumbers what remains, and every edge,
//! arm, clause, and region reference resolves. Types, dominance, and
//! effects are the caller's responsibility; [`crate::ir::Program::verify`]
//! is the check.

use std::collections::{BTreeMap, BTreeSet};

use crate::ir::{
    BlockId, ExceptionalArgument, FunctionBody, Immediate, InstructionId, Operation, RegionId,
    RegionKind, TerminatorKind, ValueDefinition, ValueId,
};

/// Why an edit was not applied. The body is left as it was.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EditError {
    #[error("no {0}")]
    MissingBlock(BlockId),
    #[error("{block} has no parameter {slot}")]
    MissingParameter { block: BlockId, slot: usize },
    #[error("{block} parameter {slot} takes a result of the invoke in {from}")]
    InvokeResult {
        block: BlockId,
        slot: usize,
        from: BlockId,
    },
    #[error("the edge from {from} refines {block} parameter {slot}")]
    RefinedParameter {
        block: BlockId,
        slot: usize,
        from: BlockId,
    },
    #[error("{block} parameter {slot} takes caught exception state from {from}")]
    CaughtState {
        block: BlockId,
        slot: usize,
        from: BlockId,
    },
    #[error(
        "{block} is the target of a catch clause of {region}, whose payload its parameters take"
    )]
    ClauseTarget { block: BlockId, region: RegionId },
    #[error("the entry {0} cannot be removed")]
    EntryRemoved(BlockId),
    #[error("{from} still targets removed {block}")]
    StillTargeted { block: BlockId, from: BlockId },
    #[error("{region} clause {clause} still targets removed {block}")]
    ClauseTargets {
        region: RegionId,
        clause: u32,
        block: BlockId,
    },
    #[error("{block} still references removed {region}")]
    RegionReferenced { block: BlockId, region: RegionId },
}

impl FunctionBody {
    /// One past the largest value id the body defines: the first id a pass
    /// may give a new definition.
    pub fn next_value_id(&self) -> ValueId {
        ValueId(
            self.definitions()
                .map(|definition| definition.id.0 + 1)
                .max()
                .unwrap_or(0),
        )
    }

    /// One past the largest instruction id in the body.
    pub fn next_instruction_id(&self) -> InstructionId {
        InstructionId(
            self.blocks
                .iter()
                .flat_map(|block| block.instructions.iter())
                .map(|instruction| instruction.id.0 + 1)
                .max()
                .unwrap_or(0),
        )
    }

    /// Every value the body reads, block by block.
    pub fn for_each_use(&self, mut f: impl FnMut(ValueId)) {
        for block in &self.blocks {
            block.for_each_use(&mut f);
        }
    }

    /// [`Self::for_each_use`] with mutable access, in the same order.
    pub fn for_each_use_mut(&mut self, mut f: impl FnMut(&mut ValueId)) {
        for block in &mut self.blocks {
            block.for_each_use_mut(&mut f);
        }
    }

    /// How many times each value is read, indexed by value id up to
    /// [`Self::next_value_id`].
    pub fn use_counts(&self) -> Vec<u32> {
        let mut counts = vec![0; self.next_value_id().index()];
        self.for_each_use(|value| {
            if let Some(count) = counts.get_mut(value.index()) {
                *count += 1;
            }
        });
        counts
    }

    /// Replaces every value the body reads with `rename` of it. Definitions
    /// are untouched, so renaming a value to another leaves its definition
    /// unused.
    pub fn rename_values(&mut self, mut rename: impl FnMut(ValueId) -> ValueId) {
        self.for_each_use_mut(|value| *value = rename(*value));
    }

    /// Replaces every use of `old` with `new`.
    pub fn replace_uses(&mut self, old: ValueId, new: ValueId) {
        self.rename_values(|value| if value == old { new } else { value });
    }

    /// Removes the parameters of `block` at `slots` and the argument each
    /// ordinary edge and exceptional arm delivers to them, returning the
    /// removed definitions in slot order. A slot that takes an invoke's
    /// result, that an edge refines, or that dispatch fills with caught
    /// exception state cannot be removed: those arguments have no
    /// substitute. Nor can any parameter of a block a catch clause names,
    /// whose leading parameters are the clause's payload whether or not a
    /// route delivers it.
    pub fn remove_parameters(
        &mut self,
        block: BlockId,
        slots: &BTreeSet<usize>,
    ) -> Result<Vec<ValueDefinition>, EditError> {
        let index = self
            .block_index(block)
            .ok_or(EditError::MissingBlock(block))?;
        let count = self.blocks[index].parameters.len();
        if let Some(&slot) = slots.iter().find(|&&slot| slot >= count) {
            return Err(EditError::MissingParameter { block, slot });
        }
        for region in &self.regions {
            if let RegionKind::TryTable { catches } = &region.kind {
                if catches.iter().any(|catch| catch.target == block) {
                    return Err(EditError::ClauseTarget {
                        block,
                        region: region.id,
                    });
                }
            }
        }
        for source in &self.blocks {
            let leading = source.terminator.kind.leading_parameters();
            for edge in source.terminator.kind.edges() {
                if edge.target != block {
                    continue;
                }
                for &slot in slots {
                    if slot < leading {
                        return Err(EditError::InvokeResult {
                            block,
                            slot,
                            from: source.id,
                        });
                    }
                    if edge.refinement(slot - leading).is_some() {
                        return Err(EditError::RefinedParameter {
                            block,
                            slot,
                            from: source.id,
                        });
                    }
                }
            }
            for arm in source.terminator.exceptional_arms() {
                if arm.target != block {
                    continue;
                }
                for &slot in slots {
                    if !matches!(arm.arguments.get(slot), Some(ExceptionalArgument::Value(_))) {
                        return Err(EditError::CaughtState {
                            block,
                            slot,
                            from: source.id,
                        });
                    }
                }
            }
        }

        for source in &mut self.blocks {
            let leading = source.terminator.kind.leading_parameters();
            for edge in source.terminator.kind.edges_mut() {
                if edge.target != block {
                    continue;
                }
                let mut argument = leading;
                edge.arguments.retain(|_| {
                    let keep = !slots.contains(&argument);
                    argument += 1;
                    keep
                });
                for refinement in &mut edge.refinements {
                    let removed_below = slots
                        .iter()
                        .filter(|&&slot| {
                            slot >= leading && slot - leading < refinement.slot as usize
                        })
                        .count();
                    refinement.slot -= removed_below as u32;
                }
            }
            if let Some(routing) = &mut source.terminator.exception {
                for arm in &mut routing.arms {
                    if arm.target != block {
                        continue;
                    }
                    let mut argument = 0;
                    arm.arguments.retain(|_| {
                        let keep = !slots.contains(&argument);
                        argument += 1;
                        keep
                    });
                }
            }
        }
        let mut slot = 0;
        let mut removed = Vec::new();
        let parameters = std::mem::take(&mut self.blocks[index].parameters);
        for parameter in parameters {
            if slots.contains(&slot) {
                removed.push(parameter);
            } else {
                self.blocks[index].parameters.push(parameter);
            }
            slot += 1;
        }
        Ok(removed)
    }

    /// The blocks reachable from the entry along ordinary edges and
    /// exceptional arms.
    pub fn reachable_blocks(&self) -> BTreeSet<BlockId> {
        let mut reachable = BTreeSet::new();
        self.reach(std::iter::once(self.entry), &mut reachable);
        reachable
    }

    /// Adds to `reached` every block reachable from `roots`.
    fn reach(&self, roots: impl IntoIterator<Item = BlockId>, reached: &mut BTreeSet<BlockId>) {
        let mut stack: Vec<BlockId> = roots.into_iter().collect();
        while let Some(id) = stack.pop() {
            if !reached.insert(id) {
                continue;
            }
            let Some(block) = self.block(id) else {
                continue;
            };
            stack.extend(block.terminator.kind.targets());
            stack.extend(
                block
                    .terminator
                    .exceptional_arms()
                    .iter()
                    .map(|arm| arm.target),
            );
        }
    }

    /// Removes `removed` from the body, along with every region whose
    /// entry is among them. Nothing that survives may still name a removed
    /// block or region, except that a surviving block or region inside a
    /// removed region moves to its nearest surviving ancestor. The
    /// remaining blocks and regions are renumbered to their positions.
    pub fn remove_blocks(&mut self, removed: &BTreeSet<BlockId>) -> Result<(), EditError> {
        if removed.is_empty() {
            return Ok(());
        }
        if removed.contains(&self.entry) {
            return Err(EditError::EntryRemoved(self.entry));
        }
        let dead_regions: BTreeSet<RegionId> = self
            .regions
            .iter()
            .filter(|region| removed.contains(&region.entry))
            .map(|region| region.id)
            .collect();

        for block in self
            .blocks
            .iter()
            .filter(|block| !removed.contains(&block.id))
        {
            for target in block.terminator.kind.targets() {
                if removed.contains(&target) {
                    return Err(EditError::StillTargeted {
                        block: target,
                        from: block.id,
                    });
                }
            }
            for arm in block.terminator.exceptional_arms() {
                if removed.contains(&arm.target) {
                    return Err(EditError::StillTargeted {
                        block: arm.target,
                        from: block.id,
                    });
                }
                if dead_regions.contains(&arm.handler) {
                    return Err(EditError::RegionReferenced {
                        block: block.id,
                        region: arm.handler,
                    });
                }
            }
            let operations = block
                .instructions
                .iter()
                .map(|instruction| &instruction.operation)
                .chain(match &block.terminator.kind {
                    TerminatorKind::Invoke { operation, .. } => Some(operation),
                    _ => None,
                });
            for operation in operations {
                for immediate in &operation.immediates {
                    if let Immediate::Region(region) = immediate {
                        if dead_regions.contains(region) {
                            return Err(EditError::RegionReferenced {
                                block: block.id,
                                region: *region,
                            });
                        }
                    }
                }
            }
        }
        for region in self
            .regions
            .iter()
            .filter(|region| !dead_regions.contains(&region.id))
        {
            if let RegionKind::TryTable { catches } = &region.kind {
                for (clause, catch) in catches.iter().enumerate() {
                    if removed.contains(&catch.target) {
                        return Err(EditError::ClauseTargets {
                            region: region.id,
                            clause: clause as u32,
                            block: catch.target,
                        });
                    }
                }
            }
        }

        let parents: BTreeMap<RegionId, Option<RegionId>> = self
            .regions
            .iter()
            .map(|region| (region.id, region.parent))
            .collect();
        let surviving_ancestor = |mut region: RegionId| -> RegionId {
            while dead_regions.contains(&region) {
                match parents.get(&region).copied().flatten() {
                    Some(parent) => region = parent,
                    None => break,
                }
            }
            region
        };

        self.blocks.retain(|block| !removed.contains(&block.id));
        self.regions
            .retain(|region| !dead_regions.contains(&region.id));
        let block_ids: BTreeMap<BlockId, BlockId> = self
            .blocks
            .iter()
            .enumerate()
            .map(|(index, block)| (block.id, BlockId(index as u32)))
            .collect();
        let region_ids: BTreeMap<RegionId, RegionId> = self
            .regions
            .iter()
            .enumerate()
            .map(|(index, region)| (region.id, RegionId(index as u32)))
            .collect();
        let new_block = |id: BlockId| block_ids.get(&id).copied().unwrap_or(id);
        let new_region = |id: RegionId| {
            region_ids
                .get(&surviving_ancestor(id))
                .copied()
                .unwrap_or(id)
        };

        self.entry = new_block(self.entry);
        self.root_region = new_region(self.root_region);
        for block in &mut self.blocks {
            block.id = new_block(block.id);
            block.region = new_region(block.region);
            for edge in block.terminator.kind.edges_mut() {
                edge.target = new_block(edge.target);
            }
            if let Some(routing) = &mut block.terminator.exception {
                for arm in &mut routing.arms {
                    arm.target = new_block(arm.target);
                    arm.handler = new_region(arm.handler);
                }
            }
            for instruction in &mut block.instructions {
                renumber_region_immediates(&mut instruction.operation, new_region);
            }
            if let TerminatorKind::Invoke { operation, .. } = &mut block.terminator.kind {
                renumber_region_immediates(operation, new_region);
            }
        }
        for region in &mut self.regions {
            region.id = new_region(region.id);
            region.parent = region.parent.map(new_region);
            region.entry = new_block(region.entry);
            if let RegionKind::TryTable { catches } = &mut region.kind {
                for catch in catches {
                    catch.target = new_block(catch.target);
                }
            }
        }
        Ok(())
    }

    /// Removes every block no path from the entry reaches, and the regions
    /// those blocks were the entry of. A catch clause naming a removed
    /// block is dropped from its `try_table` region, and the arms that name
    /// the region's later clauses are renumbered: no surviving arm can
    /// route to such a clause, since an arm's target is reachable. Returns
    /// how many blocks went.
    pub fn remove_unreachable_blocks(&mut self) -> Result<usize, EditError> {
        let live = self.reachable_blocks();
        let removed: BTreeSet<BlockId> = self
            .blocks
            .iter()
            .map(|block| block.id)
            .filter(|id| !live.contains(id))
            .collect();
        if removed.is_empty() {
            return Ok(0);
        }
        // Clause indices before and after the dead clauses of each region
        // are dropped.
        let mut renumbered: BTreeMap<RegionId, Vec<Option<u32>>> = BTreeMap::new();
        for region in &self.regions {
            let RegionKind::TryTable { catches } = &region.kind else {
                continue;
            };
            if catches.iter().all(|catch| live.contains(&catch.target)) {
                continue;
            }
            let mut kept = 0;
            let map = catches
                .iter()
                .map(|catch| {
                    live.contains(&catch.target).then(|| {
                        kept += 1;
                        kept - 1
                    })
                })
                .collect();
            renumbered.insert(region.id, map);
        }
        for block in self.blocks.iter().filter(|block| live.contains(&block.id)) {
            for arm in block.terminator.exceptional_arms() {
                let dropped = renumbered
                    .get(&arm.handler)
                    .is_some_and(|map| map.get(arm.clause as usize) == Some(&None));
                if dropped {
                    return Err(EditError::ClauseTargets {
                        region: arm.handler,
                        clause: arm.clause,
                        block: arm.target,
                    });
                }
            }
        }
        for region in &mut self.regions {
            let Some(map) = renumbered.get(&region.id) else {
                continue;
            };
            if let RegionKind::TryTable { catches } = &mut region.kind {
                let mut index = 0;
                catches.retain(|_| {
                    let keep = map[index].is_some();
                    index += 1;
                    keep
                });
            }
        }
        for block in &mut self.blocks {
            if let Some(routing) = &mut block.terminator.exception {
                for arm in &mut routing.arms {
                    if let Some(Some(clause)) = renumbered
                        .get(&arm.handler)
                        .and_then(|map| map.get(arm.clause as usize))
                    {
                        arm.clause = *clause;
                    }
                }
            }
        }
        self.remove_blocks(&removed)?;
        Ok(removed.len())
    }

    /// The blocks in reverse postorder from the entry over ordinary edges
    /// and exceptional arms: every block after the blocks that dominate it.
    /// Unreachable blocks are absent.
    pub fn reverse_postorder(&self) -> Vec<BlockId> {
        let mut order = Vec::new();
        let mut visited = BTreeSet::new();
        let mut stack: Vec<(BlockId, bool)> = vec![(self.entry, false)];
        while let Some((id, finished)) = stack.pop() {
            if finished {
                order.push(id);
                continue;
            }
            if !visited.insert(id) {
                continue;
            }
            stack.push((id, true));
            let Some(block) = self.block(id) else {
                continue;
            };
            let successors = block.terminator.kind.targets().chain(
                block
                    .terminator
                    .exceptional_arms()
                    .iter()
                    .map(|arm| arm.target),
            );
            for successor in successors.collect::<Vec<_>>().into_iter().rev() {
                if !visited.contains(&successor) {
                    stack.push((successor, false));
                }
            }
        }
        order.reverse();
        order
    }
}

fn renumber_region_immediates(
    operation: &mut Operation,
    new_region: impl Fn(RegionId) -> RegionId,
) {
    for immediate in &mut operation.immediates {
        if let Immediate::Region(region) = immediate {
            *region = new_region(*region);
        }
    }
}
