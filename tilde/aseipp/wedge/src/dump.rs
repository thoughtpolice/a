// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Stable, target-neutral diagnostic views of Wedge IR.
//!
//! These dumps are intended for humans and FileCheck tests. They expose
//! semantic CFG facts and shared analyses without choosing an EDGE, RISC-V,
//! LLVM, ABI, layout, or instruction-selection representation.

use std::collections::BTreeMap;
use std::fmt;

use crate::cfg::{
    BranchDirection, ControlFlowGraph, EdgeKind, EdgeSite, ExitKind, ExitOrigin, ExitPolicy,
    PostDominatorNode,
};
use crate::ir::{ExceptionalArgument, ExportItem, FunctionId, Program};

/// A deterministic CFG and analysis dump for a verified [`Program`].
///
/// The optional function filter uses the module's function index space. An
/// imported function or an out-of-range ID simply contributes no CFG body.
/// Each header carries the function's `name` section name when it has one.
#[derive(Clone, Copy, Debug)]
pub struct CfgDump<'program> {
    program: &'program Program,
    function: Option<FunctionId>,
}

impl<'program> CfgDump<'program> {
    pub const fn new(program: &'program Program) -> Self {
        Self {
            program,
            function: None,
        }
    }

    pub const fn function(mut self, function: FunctionId) -> Self {
        self.function = Some(function);
        self
    }
}

impl fmt::Display for CfgDump<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(formatter, "wedge.cfg-analysis {{")?;
        for (index, function) in self.program.functions.iter().enumerate() {
            let id = FunctionId(index as u32);
            if self.function.is_some_and(|selected| selected != id) {
                continue;
            }
            let Some(body) = &function.body else {
                continue;
            };
            let graph = ControlFlowGraph::new(body).map_err(|_| fmt::Error)?;
            let dominators = graph.dominators();
            let semantic_postdominators = graph.post_dominators(ExitPolicy::Semantic);
            let normal_postdominators = graph.post_dominators(ExitPolicy::NormalCompletion);
            let components = graph.strongly_connected_components();
            let loops = graph.natural_loops();
            let rpo_positions = graph
                .reverse_postorder()
                .iter()
                .enumerate()
                .map(|(position, block)| (*block, position))
                .collect::<BTreeMap<_, _>>();

            write!(formatter, "  func {id}")?;
            if let Some(name) = self.program.function_name(id) {
                write!(formatter, " name={name:?}")?;
            }
            formatter.write_str(" exports=[")?;
            let mut first_export = true;
            for export in &self.program.exports {
                if export.item == ExportItem::Function(id) {
                    if !first_export {
                        formatter.write_str(", ")?;
                    }
                    write!(formatter, "{:?}", export.name)?;
                    first_export = false;
                }
            }
            writeln!(
                formatter,
                "] entry={} root={} {{",
                body.entry, body.root_region
            )?;

            let mut regions = body.regions.iter().collect::<Vec<_>>();
            regions.sort_unstable_by_key(|region| region.id);
            for region in regions {
                write!(
                    formatter,
                    "    region {} kind={} parent=",
                    region.id, region.kind
                )?;
                match region.parent {
                    Some(parent) => write!(formatter, "{parent}")?,
                    None => formatter.write_str("none")?,
                }
                writeln!(formatter, " entry={}", region.entry)?;
            }

            write!(formatter, "    reachable=")?;
            fmt_list(formatter, graph.reachable_blocks().iter())?;
            writeln!(formatter)?;
            write!(formatter, "    rpo=")?;
            fmt_list(formatter, graph.reverse_postorder().iter())?;
            writeln!(formatter)?;

            for block_id in graph.blocks() {
                let block = graph.block(block_id).ok_or(fmt::Error)?;
                write!(
                    formatter,
                    "    block {block_id} region={} params=[",
                    block.region
                )?;
                for (index, parameter) in block.parameters.iter().enumerate() {
                    if index != 0 {
                        formatter.write_str(", ")?;
                    }
                    write!(formatter, "{}:{}", parameter.id, parameter.ty)?;
                }
                write!(
                    formatter,
                    "] reachable={} rpo=",
                    graph.is_reachable(block_id)
                )?;
                match rpo_positions.get(&block_id) {
                    Some(position) => write!(formatter, "{position}")?,
                    None => formatter.write_str("none")?,
                }
                formatter.write_str(" idom=")?;
                fmt_optional(formatter, dominators.immediate_dominator(block_id))?;
                formatter.write_str(" ipdom-semantic=")?;
                fmt_postdominator(
                    formatter,
                    semantic_postdominators.immediate_postdominator_node(block_id),
                )?;
                formatter.write_str(" ipdom-normal=")?;
                fmt_postdominator(
                    formatter,
                    normal_postdominators.immediate_postdominator_node(block_id),
                )?;
                formatter.write_str(" scc=")?;
                match components.component(block_id) {
                    Some(component) => {
                        write!(formatter, "scc{}", component.index())?;
                        write!(formatter, " cyclic={}", components.is_cyclic(component))?;
                    }
                    None => formatter.write_str("none cyclic=false")?,
                }
                formatter.write_str(" incoming=")?;
                fmt_list(formatter, graph.incoming_edge_ids(block_id).iter())?;
                formatter.write_str(" outgoing=")?;
                fmt_list(formatter, graph.outgoing_edge_ids(block_id).iter())?;
                writeln!(formatter)?;
            }

            for edge in graph.edges() {
                write!(
                    formatter,
                    "    edge {} {} -> {} kind=",
                    edge.id, edge.source, edge.target
                )?;
                fmt_edge_kind(formatter, edge.kind)?;
                match graph.edge_site(edge.id).ok_or(fmt::Error)? {
                    EdgeSite::Ordinary(site) => {
                        formatter.write_str(" args=")?;
                        fmt_list(formatter, site.arguments.iter())?;
                        formatter.write_str(" refined=")?;
                        fmt_list(formatter, site.refinements.iter())?;
                    }
                    EdgeSite::Exceptional(site) => {
                        formatter.write_str(" args=[")?;
                        for (index, argument) in site.arguments.iter().enumerate() {
                            if index != 0 {
                                formatter.write_str(", ")?;
                            }
                            fmt_exceptional_argument(formatter, argument)?;
                        }
                        formatter.write_str("]")?;
                    }
                }
                writeln!(formatter)?;
            }

            for exit in graph.exits() {
                write!(formatter, "    exit {} {} kind=", exit.id, exit.source)?;
                match &exit.kind {
                    ExitKind::Return => formatter.write_str("return")?,
                    ExitKind::TailCall => formatter.write_str("tail-call")?,
                    ExitKind::Trap(trap) => write!(formatter, "trap({trap})")?,
                    ExitKind::ExceptionEscape => formatter.write_str("exception-escape")?,
                }
                formatter.write_str(" origin=")?;
                match exit.origin {
                    ExitOrigin::Instruction {
                        instruction,
                        position,
                    } => write!(formatter, "instruction({instruction}@{position})")?,
                    ExitOrigin::Terminator => formatter.write_str("terminator")?,
                }
                writeln!(formatter)?;
            }

            for natural_loop in loops {
                write!(formatter, "    loop header={} blocks=", natural_loop.header)?;
                fmt_list(formatter, natural_loop.blocks.iter())?;
                formatter.write_str(" backedges=")?;
                fmt_list(formatter, natural_loop.back_edges.iter())?;
                writeln!(formatter)?;
            }
            writeln!(formatter, "  }}")?;
        }
        formatter.write_str("}\n")
    }
}

fn fmt_list<'item, Item>(
    formatter: &mut fmt::Formatter<'_>,
    items: impl IntoIterator<Item = &'item Item>,
) -> fmt::Result
where
    Item: fmt::Display + 'item,
{
    formatter.write_str("[")?;
    for (index, item) in items.into_iter().enumerate() {
        if index != 0 {
            formatter.write_str(", ")?;
        }
        item.fmt(formatter)?;
    }
    formatter.write_str("]")
}

fn fmt_optional<Item: fmt::Display>(
    formatter: &mut fmt::Formatter<'_>,
    item: Option<Item>,
) -> fmt::Result {
    match item {
        Some(item) => item.fmt(formatter),
        None => formatter.write_str("none"),
    }
}

fn fmt_postdominator(
    formatter: &mut fmt::Formatter<'_>,
    node: Option<PostDominatorNode>,
) -> fmt::Result {
    match node {
        Some(PostDominatorNode::VirtualExit) => formatter.write_str("virtual-exit"),
        Some(PostDominatorNode::Block(block)) => fmt::Display::fmt(&block, formatter),
        None => formatter.write_str("none"),
    }
}

fn fmt_edge_kind(formatter: &mut fmt::Formatter<'_>, kind: EdgeKind) -> fmt::Result {
    match kind {
        EdgeKind::Jump => formatter.write_str("jump"),
        EdgeKind::Branch(BranchDirection::True) => formatter.write_str("branch.true"),
        EdgeKind::Branch(BranchDirection::False) => formatter.write_str("branch.false"),
        EdgeKind::SwitchCase { index } => write!(formatter, "switch.case[{index}]"),
        EdgeKind::SwitchDefault => formatter.write_str("switch.default"),
        EdgeKind::InvokeNormal => formatter.write_str("invoke.normal"),
        EdgeKind::Exceptional {
            arm,
            handler,
            clause,
        } => write!(
            formatter,
            "exception arm={arm} handler={handler} clause={clause}"
        ),
    }
}

fn fmt_exceptional_argument(
    formatter: &mut fmt::Formatter<'_>,
    argument: &ExceptionalArgument,
) -> fmt::Result {
    match argument {
        ExceptionalArgument::Value(value) => write!(formatter, "value({value})"),
        ExceptionalArgument::CaughtPayload { index, ty } => {
            write!(formatter, "caught-payload({index}:{ty})")
        }
        ExceptionalArgument::CaughtException => formatter.write_str("caught-exception"),
    }
}
