// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The canonical cleanup of a lowered program: constant folding, and the
//! removal of the control flow and definitions folding leaves redundant.
//!
//! Each round of [`simplify_body`] runs these steps, and rounds repeat
//! until one changes nothing:
//!
//! 1. Constant folding. An instruction whose operands are all constants
//!    and whose operation needs nothing but them, a numeric or vector
//!    operator or a `select`, becomes the constant [`crate::interp`]
//!    evaluates it to, so a folded value is by construction the value the
//!    reference interpreter would have computed. An operation that would
//!    trap is left to trap at run time, and one the IR marks
//!    nondeterministic is left alone. A `select` whose condition is known
//!    forwards the chosen operand to its uses.
//! 2. Branch resolution. A conditional branch on a constant, and a switch
//!    on one, become a jump along the taken edge. A taken edge that carries
//!    a refinement is kept as a branch: the refined parameter's type is
//!    justified by the predicate, and a jump cannot carry that fact.
//! 3. Jump threading. An edge into a block that has no instructions and
//!    only jumps on is redirected to where the chain of such blocks ends,
//!    with the arguments and refinements it carried substituted through.
//!    A block whose parameters are used beyond its own jump stays, since
//!    the blocks it dominates depend on those definitions, and so does a
//!    block a `try_table` region begins with, since its blocks route
//!    exceptions to that region. A cycle of empty blocks is an infinite
//!    loop and is left alone, as is an invoke's continuation edge, whose
//!    leading arguments are results.
//! 4. Unreachable block removal, after each of the two steps above. A
//!    catch clause whose target went with them is dead source structure
//!    and goes too; see [`FunctionBody::remove_unreachable_blocks`].
//! 5. Parameter simplification. A block parameter that every predecessor
//!    passes the same value, itself aside, is replaced by that value; one
//!    that every predecessor passes a constant of the same value becomes
//!    that constant at the top of its block. Parameters that take invoke
//!    results, refined arguments, or caught exception state stay, and so
//!    do those of a block a catch clause names, which the clause's payload
//!    types fix.
//! 6. Block merging. A block whose one predecessor jumps to it, and to
//!    nothing else, is appended to that predecessor. Regions are retained
//!    source structure, so the merge must leave them resolving: a block a
//!    catch clause names or a `try_table` region begins stays, a plain
//!    region whose entry is merged away goes with it, and the two blocks
//!    must sit under the same `try_table` regions so an exceptional
//!    terminator keeps its lexical routing.
//! 7. Dead instruction removal. An instruction none of whose results is
//!    used goes when its effects are at most reads: no write, trap,
//!    allocation, or exception.
//!
//! Every step preserves the meaning of every function under the reference
//! interpreter, which the simplification tests check on generated modules
//! before and after, and [`crate::ir::Program::verify`] accepts the result
//! whenever it accepted the input.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::edit::EditError;
use crate::interp::{self, Value};
use crate::ir::{
    BlockId, Edge, Effects, ExceptionEffect, ExceptionalArgument, FunctionBody, Immediate,
    Instruction, InstructionId, Operation, OperationKind, Program, Refinement, RegionId,
    RegionKind, SourceInfo, Terminator, TerminatorKind, TrapCode, ValueDefinition, ValueId,
    ValueType,
};
use crate::opcode::CoreOpcode;

/// How much one run of the pass changed.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Statistics {
    /// Instructions replaced by a constant, including the constants
    /// materialized for parameters every predecessor passed the same
    /// constant.
    pub instructions_folded: usize,
    /// Values whose uses were redirected to another value: the operand a
    /// known `select` chose, and parameters every predecessor passed the
    /// same value.
    pub values_forwarded: usize,
    /// Branches and switches turned into jumps.
    pub branches_resolved: usize,
    /// Edges redirected past empty blocks.
    pub edges_threaded: usize,
    pub parameters_removed: usize,
    pub blocks_merged: usize,
    pub blocks_removed: usize,
    pub instructions_removed: usize,
    /// Rounds that changed something.
    pub rounds: usize,
}

impl Statistics {
    pub fn changed(&self) -> bool {
        *self != Self::default()
    }

    fn add(&mut self, other: &Self) {
        self.instructions_folded += other.instructions_folded;
        self.values_forwarded += other.values_forwarded;
        self.branches_resolved += other.branches_resolved;
        self.edges_threaded += other.edges_threaded;
        self.parameters_removed += other.parameters_removed;
        self.blocks_merged += other.blocks_merged;
        self.blocks_removed += other.blocks_removed;
        self.instructions_removed += other.instructions_removed;
        self.rounds += other.rounds;
    }
}

impl fmt::Display for Statistics {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "folded {} instructions, forwarded {} values, resolved {} branches, threaded {} edges, \
             removed {} parameters, merged {} blocks, removed {} blocks and {} instructions in {} rounds",
            self.instructions_folded,
            self.values_forwarded,
            self.branches_resolved,
            self.edges_threaded,
            self.parameters_removed,
            self.blocks_merged,
            self.blocks_removed,
            self.instructions_removed,
            self.rounds
        )
    }
}

/// Rounds after which a body is left as it is, so a body that keeps
/// exposing new work (an empty block a removed instruction leaves behind,
/// say) cannot run the pass forever. Every intermediate state is valid.
const MAX_ROUNDS: usize = 32;

/// Simplifies every function body of `program`.
pub fn simplify(program: &mut Program) -> Result<Statistics, EditError> {
    let mut statistics = Statistics::default();
    for function in &mut program.functions {
        if let Some(body) = &mut function.body {
            statistics.add(&simplify_body(body)?);
        }
    }
    Ok(statistics)
}

/// Simplifies one function body until a round changes nothing.
pub fn simplify_body(body: &mut FunctionBody) -> Result<Statistics, EditError> {
    let mut total = Statistics::default();
    let mut next_instruction = body.next_instruction_id().0;
    for _ in 0..MAX_ROUNDS {
        let mut round = Statistics::default();
        fold_constants(body, &mut round);
        resolve_constant_branches(body, &mut round);
        round.blocks_removed += body.remove_unreachable_blocks()?;
        thread_jumps(body, &mut round);
        round.blocks_removed += body.remove_unreachable_blocks()?;
        simplify_parameters(body, &mut next_instruction, &mut round)?;
        merge_blocks(body, &mut round)?;
        remove_dead_instructions(body, &mut round);
        if !round.changed() {
            break;
        }
        round.rounds = 1;
        total.add(&round);
    }
    Ok(total)
}

/// The instruction that defines `value` as a constant, if the value has a
/// constant instruction form. References have none: `ref.null` needs a
/// heap type the value does not carry.
fn constant_operation(value: &Value) -> Option<Operation> {
    use CoreOpcode::*;
    Some(match value {
        Value::I32(bits) => Operation::core(I32Const, vec![], vec![ValueType::I32])
            .with_immediates(vec![Immediate::S32(*bits as i32)]),
        Value::I64(bits) => Operation::core(I64Const, vec![], vec![ValueType::I64])
            .with_immediates(vec![Immediate::S64(*bits as i64)]),
        Value::F32(bits) => Operation::core(F32Const, vec![], vec![ValueType::F32])
            .with_immediates(vec![Immediate::F32(*bits)]),
        Value::F64(bits) => Operation::core(F64Const, vec![], vec![ValueType::F64])
            .with_immediates(vec![Immediate::F64(*bits)]),
        Value::V128(bytes) => Operation::core(V128Const, vec![], vec![ValueType::V128])
            .with_immediates(vec![Immediate::V128(*bytes)]),
        Value::Ref(_) => return None,
    })
}

/// The value of every constant instruction, indexed by the value it defines.
fn known_constants(body: &FunctionBody) -> Vec<Option<Value>> {
    let mut constants = vec![None; body.next_value_id().index()];
    for instruction in body
        .blocks
        .iter()
        .flat_map(|block| block.instructions.iter())
    {
        let [result] = instruction.results.as_slice() else {
            continue;
        };
        if !instruction.operands.is_empty() || instruction.effects.nondeterministic {
            continue;
        }
        if let Ok(Some(value)) = interp::evaluate_pure(&instruction.operation, &[]) {
            if let Some(slot) = constants.get_mut(result.id.index()) {
                *slot = Some(value);
            }
        }
    }
    constants
}

/// Follows `renames` from `value` to a value that is not itself renamed.
fn resolve(renames: &BTreeMap<ValueId, ValueId>, mut value: ValueId) -> ValueId {
    for _ in 0..renames.len() {
        match renames.get(&value) {
            Some(next) => value = *next,
            None => break,
        }
    }
    value
}

fn fold_constants(body: &mut FunctionBody, statistics: &mut Statistics) {
    let mut constants: Vec<Option<Value>> = vec![None; body.next_value_id().index()];
    let mut forwarded: BTreeMap<ValueId, ValueId> = BTreeMap::new();
    let mut operands = Vec::new();
    for id in body.reverse_postorder() {
        let Some(block) = body.block_mut(id) else {
            continue;
        };
        for instruction in &mut block.instructions {
            let [result] = instruction.results.as_slice() else {
                continue;
            };
            let result = result.id;
            if instruction.effects.nondeterministic {
                continue;
            }
            if let (
                OperationKind::Core(CoreOpcode::Select | CoreOpcode::TypedSelect),
                [on_true, on_false, condition],
            ) = (instruction.operation.kind, instruction.operands.as_slice())
            {
                if let Some(Some(Value::I32(condition))) = constants.get(condition.index()) {
                    let chosen = if *condition != 0 { *on_true } else { *on_false };
                    forwarded.insert(result, chosen);
                    if let Some(value) = constants.get(chosen.index()).cloned().flatten() {
                        constants[result.index()] = Some(value);
                    }
                    statistics.values_forwarded += 1;
                    continue;
                }
            }
            operands.clear();
            let known = instruction.operands.iter().all(|operand| {
                match constants.get(operand.index()).cloned().flatten() {
                    Some(value) => {
                        operands.push(value);
                        true
                    }
                    None => false,
                }
            });
            if !known {
                continue;
            }
            let Ok(Some(value)) = interp::evaluate_pure(&instruction.operation, &operands) else {
                continue;
            };
            if !instruction.operands.is_empty() {
                let Some(operation) = constant_operation(&value) else {
                    continue;
                };
                instruction.operation = operation;
                instruction.operands.clear();
                instruction.effects = Effects::pure();
                statistics.instructions_folded += 1;
            }
            if let Some(slot) = constants.get_mut(result.index()) {
                *slot = Some(value);
            }
        }
    }
    if !forwarded.is_empty() {
        body.rename_values(|value| resolve(&forwarded, value));
    }
}

fn resolve_constant_branches(body: &mut FunctionBody, statistics: &mut Statistics) {
    let constants = known_constants(body);
    let constant = |value: ValueId| match constants.get(value.index()) {
        Some(Some(Value::I32(bits))) => Some(*bits),
        _ => None,
    };
    for block in &mut body.blocks {
        let taken = match &block.terminator.kind {
            TerminatorKind::Branch {
                condition,
                then_edge,
                else_edge,
            } => {
                let Some(condition) = constant(*condition) else {
                    continue;
                };
                let edge = if condition != 0 { then_edge } else { else_edge };
                if !edge.refinements.is_empty() {
                    continue;
                }
                edge.clone()
            }
            TerminatorKind::Switch {
                selector,
                targets,
                default,
            } => {
                let Some(selector) = constant(*selector) else {
                    continue;
                };
                targets.get(selector as usize).unwrap_or(default).clone()
            }
            _ => continue,
        };
        block.terminator.kind = TerminatorKind::Jump(taken);
        statistics.branches_resolved += 1;
    }
}

/// An empty block that only jumps on: where to, with what, and the
/// parameters the arguments may name.
struct Forwarding {
    target: Edge,
    parameters: Vec<ValueId>,
}

fn thread_jumps(body: &mut FunctionBody, statistics: &mut Statistics) {
    // A block the retained structure names cannot be bypassed: an edge
    // threaded past a `try_table` entry would leave the region's blocks
    // routing exceptions to a region whose entry nothing reaches.
    let mut pinned: BTreeSet<BlockId> = BTreeSet::new();
    let referenced_regions: BTreeSet<RegionId> = body
        .blocks
        .iter()
        .flat_map(|block| {
            block
                .instructions
                .iter()
                .map(|instruction| &instruction.operation)
                .chain(match &block.terminator.kind {
                    TerminatorKind::Invoke { operation, .. } => Some(operation),
                    _ => None,
                })
        })
        .flat_map(|operation| operation.immediates.iter())
        .filter_map(|immediate| match immediate {
            Immediate::Region(region) => Some(*region),
            _ => None,
        })
        .collect();
    for region in &body.regions {
        if matches!(
            region.kind,
            RegionKind::TryTable { .. } | RegionKind::Function
        ) || referenced_regions.contains(&region.id)
        {
            pinned.insert(region.entry);
        }
    }
    // A parameter the block's own jump does not merely pass on is used by
    // a block it dominates; an edge threaded past the definition would
    // leave that use undefined.
    let uses = body.use_counts();
    let forwardings: BTreeMap<_, _> = body
        .blocks
        .iter()
        .filter(|block| {
            block.id != body.entry && block.instructions.is_empty() && !pinned.contains(&block.id)
        })
        .filter_map(|block| match &block.terminator {
            Terminator {
                kind: TerminatorKind::Jump(edge),
                exception: None,
                ..
            } if edge.target != block.id
                && block.parameters.iter().all(|parameter| {
                    let passed_on = edge
                        .arguments
                        .iter()
                        .filter(|argument| **argument == parameter.id)
                        .count();
                    uses.get(parameter.id.index()).copied().unwrap_or(0) as usize == passed_on
                }) =>
            {
                Some((
                    block.id,
                    Forwarding {
                        target: edge.clone(),
                        parameters: block
                            .parameters
                            .iter()
                            .map(|parameter| parameter.id)
                            .collect(),
                    },
                ))
            }
            _ => None,
        })
        .collect();
    if forwardings.is_empty() {
        return;
    }
    for block in &mut body.blocks {
        if matches!(block.terminator.kind, TerminatorKind::Invoke { .. }) {
            continue;
        }
        for edge in block.terminator.kind.edges_mut() {
            if let Some(threaded) = thread_edge(&forwardings, edge) {
                *edge = threaded;
                statistics.edges_threaded += 1;
            }
        }
    }
}

/// Where `edge` ends up after every empty block along its way, or `None`
/// when it already ends outside them or the way is a cycle.
fn thread_edge(forwardings: &BTreeMap<BlockId, Forwarding>, edge: &Edge) -> Option<Edge> {
    let mut visited = BTreeSet::new();
    let mut current = edge.clone();
    while let Some(forwarding) = forwardings.get(&current.target) {
        if !visited.insert(current.target) {
            return None;
        }
        let slot = |value: ValueId| {
            forwarding
                .parameters
                .iter()
                .position(|parameter| *parameter == value)
        };
        let arguments: Vec<ValueId> = forwarding
            .target
            .arguments
            .iter()
            .map(|argument| match slot(*argument) {
                Some(index) => current.arguments[index],
                None => *argument,
            })
            .collect();
        let mut refinements: Vec<Refinement> = current
            .refinements
            .iter()
            .flat_map(|refinement| {
                let parameter = forwarding.parameters[refinement.slot as usize];
                forwarding
                    .target
                    .arguments
                    .iter()
                    .enumerate()
                    .filter(move |(_, argument)| **argument == parameter)
                    .map(move |(index, _)| Refinement {
                        slot: index as u32,
                        proven: refinement.proven.clone(),
                    })
            })
            .collect();
        refinements.sort_by_key(|refinement| refinement.slot);
        current = Edge {
            target: forwarding.target.target,
            arguments,
            refinements,
        };
    }
    (!visited.is_empty()).then_some(current)
}

/// What one predecessor site delivers to a block's parameters.
enum Incoming {
    Ordinary {
        leading: usize,
        arguments: Vec<ValueId>,
        refined: BTreeSet<usize>,
    },
    Exceptional {
        arguments: Vec<ExceptionalArgument>,
    },
}

fn simplify_parameters(
    body: &mut FunctionBody,
    next_instruction: &mut u32,
    statistics: &mut Statistics,
) -> Result<(), EditError> {
    let reachable = body.reachable_blocks();
    let constants = known_constants(body);
    let mut incoming: BTreeMap<BlockId, Vec<Incoming>> = BTreeMap::new();
    for block in &body.blocks {
        let leading = block.terminator.kind.leading_parameters();
        for edge in block.terminator.kind.edges() {
            incoming
                .entry(edge.target)
                .or_default()
                .push(Incoming::Ordinary {
                    leading,
                    arguments: edge.arguments.clone(),
                    refined: edge
                        .refinements
                        .iter()
                        .map(|refinement| refinement.slot as usize)
                        .collect(),
                });
        }
        for arm in block.terminator.exceptional_arms() {
            incoming
                .entry(arm.target)
                .or_default()
                .push(Incoming::Exceptional {
                    arguments: arm.arguments.clone(),
                });
        }
    }

    let clause_targets: BTreeSet<BlockId> = body
        .regions
        .iter()
        .filter_map(|region| match &region.kind {
            RegionKind::TryTable { catches } => Some(catches),
            _ => None,
        })
        .flatten()
        .map(|catch| catch.target)
        .collect();
    let mut renames = BTreeMap::new();
    let mut removals = Vec::new();
    let mut materialized: Vec<(BlockId, ValueDefinition, Value)> = Vec::new();
    for block in &body.blocks {
        if block.id == body.entry
            || !reachable.contains(&block.id)
            || clause_targets.contains(&block.id)
        {
            continue;
        }
        let Some(sites) = incoming.get(&block.id) else {
            continue;
        };
        let mut slots = BTreeSet::new();
        for (slot, parameter) in block.parameters.iter().enumerate() {
            let mut values = BTreeSet::new();
            let mut fixed = false;
            for site in sites {
                let value = match site {
                    Incoming::Ordinary {
                        leading,
                        arguments,
                        refined,
                    } => {
                        if slot < *leading || refined.contains(&(slot - leading)) {
                            fixed = true;
                            break;
                        }
                        arguments.get(slot - leading).copied()
                    }
                    Incoming::Exceptional { arguments } => match arguments.get(slot) {
                        Some(ExceptionalArgument::Value(value)) => Some(*value),
                        _ => {
                            fixed = true;
                            break;
                        }
                    },
                };
                match value {
                    Some(value) if value != parameter.id => {
                        values.insert(value);
                    }
                    Some(_) => {}
                    None => {
                        fixed = true;
                        break;
                    }
                }
            }
            if fixed || values.is_empty() {
                continue;
            }
            if values.len() == 1 {
                renames.insert(parameter.id, *values.first().expect("one value"));
                slots.insert(slot);
                statistics.values_forwarded += 1;
                continue;
            }
            let mut shared: Option<Value> = None;
            let all_same =
                values.iter().all(
                    |value| match constants.get(value.index()).cloned().flatten() {
                        Some(value) => match &shared {
                            None => {
                                shared = Some(value);
                                true
                            }
                            Some(existing) => *existing == value,
                        },
                        None => false,
                    },
                );
            if let Some(value) = shared.filter(|_| all_same) {
                if constant_operation(&value).is_some() {
                    materialized.push((block.id, parameter.clone(), value));
                    slots.insert(slot);
                }
            }
        }
        if !slots.is_empty() {
            removals.push((block.id, slots));
        }
    }

    for (block, slots) in removals {
        body.remove_parameters(block, &slots)?;
        statistics.parameters_removed += slots.len();
    }
    for (block, definition, value) in materialized {
        let operation = constant_operation(&value).expect("checked when selected");
        let Some(block) = body.block_mut(block) else {
            continue;
        };
        block.instructions.insert(
            0,
            Instruction::new(
                InstructionId(*next_instruction),
                operation,
                Vec::new(),
                vec![definition],
                block.source,
            ),
        );
        *next_instruction += 1;
        statistics.instructions_folded += 1;
    }
    if !renames.is_empty() {
        body.rename_values(|value| resolve(&renames, value));
    }
    Ok(())
}

/// The `try_table` regions enclosing `region`, innermost first: what the
/// verifier derives an exceptional terminator's routing from.
fn handler_context(body: &FunctionBody, region: RegionId) -> Vec<RegionId> {
    let mut context = Vec::new();
    let mut current = Some(region);
    let mut steps = 0;
    while let Some(id) = current {
        let Some(region) = body.region(id) else {
            break;
        };
        if matches!(region.kind, RegionKind::TryTable { .. }) {
            context.push(id);
        }
        current = region.parent;
        steps += 1;
        if steps > body.regions.len() {
            break;
        }
    }
    context
}

fn merge_blocks(body: &mut FunctionBody, statistics: &mut Statistics) -> Result<(), EditError> {
    let mut pinned: BTreeSet<BlockId> = BTreeSet::new();
    pinned.insert(body.entry);
    let mut referenced_regions: BTreeSet<RegionId> = BTreeSet::new();
    for block in &body.blocks {
        let operations = block
            .instructions
            .iter()
            .map(|instruction| &instruction.operation)
            .chain(match &block.terminator.kind {
                TerminatorKind::Invoke { operation, .. } => Some(operation),
                _ => None,
            });
        for immediate in operations.flat_map(|operation| operation.immediates.iter()) {
            if let Immediate::Region(region) = immediate {
                referenced_regions.insert(*region);
            }
        }
    }
    for region in &body.regions {
        match &region.kind {
            RegionKind::TryTable { catches } => {
                pinned.insert(region.entry);
                pinned.extend(catches.iter().map(|catch| catch.target));
            }
            RegionKind::Function => {
                pinned.insert(region.entry);
            }
            _ => {
                if referenced_regions.contains(&region.id) {
                    pinned.insert(region.entry);
                }
            }
        }
    }
    let mut incoming: BTreeMap<BlockId, usize> = BTreeMap::new();
    for block in &body.blocks {
        for target in block.terminator.kind.targets() {
            *incoming.entry(target).or_default() += 1;
        }
        for arm in block.terminator.exceptional_arms() {
            *incoming.entry(arm.target).or_default() += 1;
        }
    }

    let mut removed = BTreeSet::new();
    let mut renames = BTreeMap::new();
    for index in 0..body.blocks.len() {
        loop {
            let source = body.blocks[index].id;
            if removed.contains(&source) {
                break;
            }
            let target = match &body.blocks[index].terminator {
                Terminator {
                    kind: TerminatorKind::Jump(edge),
                    exception: None,
                    ..
                } => edge.target,
                _ => break,
            };
            if target == source || pinned.contains(&target) || incoming.get(&target) != Some(&1) {
                break;
            }
            let Some(target_index) = body.block_index(target) else {
                break;
            };
            let source_region = body.blocks[index].region;
            let target_region = body.blocks[target_index].region;
            if source_region != target_region
                && handler_context(body, source_region) != handler_context(body, target_region)
            {
                break;
            }
            let TerminatorKind::Jump(edge) = &body.blocks[index].terminator.kind else {
                break;
            };
            for (parameter, argument) in body.blocks[target_index]
                .parameters
                .iter()
                .zip(edge.arguments.clone())
            {
                renames.insert(parameter.id, argument);
            }
            let instructions = std::mem::take(&mut body.blocks[target_index].instructions);
            let terminator = std::mem::replace(
                &mut body.blocks[target_index].terminator,
                Terminator::new(
                    TerminatorKind::Unreachable {
                        trap: TrapCode::Unreachable,
                    },
                    SourceInfo::synthetic(),
                ),
            );
            body.blocks[target_index].parameters.clear();
            let source_block = &mut body.blocks[index];
            source_block.instructions.extend(instructions);
            source_block.terminator = terminator;
            removed.insert(target);
            statistics.blocks_merged += 1;
        }
    }
    if !renames.is_empty() {
        body.rename_values(|value| resolve(&renames, value));
    }
    if !removed.is_empty() {
        body.remove_blocks(&removed)?;
        statistics.blocks_removed += removed.len();
    }
    Ok(())
}

/// Whether an instruction with these effects may go when its results are
/// unused: it reads at most, and neither traps, allocates, nor throws.
fn removable(effects: &Effects) -> bool {
    effects
        .accesses
        .iter()
        .all(|effect| !effect.access.writes())
        && effects.traps.is_empty()
        && !effects.allocates
        && effects.exception == ExceptionEffect::None
}

fn remove_dead_instructions(body: &mut FunctionBody, statistics: &mut Statistics) {
    let mut counts = body.use_counts();
    for block in &mut body.blocks {
        let mut index = block.instructions.len();
        while index > 0 {
            index -= 1;
            let instruction = &block.instructions[index];
            let unused = instruction
                .results
                .iter()
                .all(|result| counts.get(result.id.index()).copied().unwrap_or(0) == 0);
            if !unused || !removable(&instruction.effects) {
                continue;
            }
            for operand in &instruction.operands {
                if let Some(count) = counts.get_mut(operand.index()) {
                    *count -= 1;
                }
            }
            block.instructions.remove(index);
            statistics.instructions_removed += 1;
        }
    }
}
