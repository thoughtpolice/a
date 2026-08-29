// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Conservative semantic effects for Core WebAssembly operations and exits.
//!
//! This module is deliberately independent of binary decoding and CFG
//! construction. It classifies already typed, owned IR objects, so the same
//! defaults can be reused by the frontend and later IR passes. The result is
//! a conservative upper bound: a pass may narrow the effects stored on an
//! instruction to a subset it has proven, and the verifier rejects any
//! widening. Terminator effects are derived rather than stored, keeping their
//! semantic description canonical.

use crate::ir;
use crate::opcode::{CoreOpcode, CoreProposal};

/// Derive the conservative default effects of one semantic operation.
///
/// Structured control transfers retain their effects in CFG terminators. A
/// synthetic operation defaults to pure and must opt into any Wedge-specific
/// effects at its construction site. Out-of-profile parser operations are
/// opaque here as a defense in depth; the IR verifier rejects them outright.
pub fn effects_for_operation(operation: &ir::Operation) -> ir::Effects {
    let ir::OperationKind::Core(opcode) = operation.kind else {
        return ir::Effects::pure();
    };
    if !opcode.is_standard_wasm3() {
        let mut effects = EffectBuilder::default();
        effects.access(ir::EffectResource::Host, ir::EffectAccess::ReadWrite);
        effects.trap(ir::TrapCode::Other("out-of-profile-operation".to_owned()));
        return effects.finish();
    }

    let mut effects = EffectBuilder::default();
    classify_numeric_traps(opcode, &mut effects);
    classify_memory(operation, opcode, &mut effects);
    classify_tables(operation, opcode, &mut effects);
    classify_globals(operation, opcode, &mut effects);
    classify_calls(operation, opcode, &mut effects);
    classify_gc(opcode, &mut effects);
    classify_reference_traps(opcode, &mut effects);
    classify_segment_state(operation, opcode, &mut effects);

    match opcode {
        CoreOpcode::Unreachable => effects.trap(ir::TrapCode::Unreachable),
        CoreOpcode::Throw | CoreOpcode::ThrowRef => effects.may_throw(),
        _ => {}
    }
    if opcode.proposal() == CoreProposal::RelaxedSimd {
        effects.nondeterministic();
    }

    effects.finish()
}

/// Derive the authoritative effects of one CFG terminator.
///
/// Ordinary CFG transfers and returns are pure. Calls and exceptional exits
/// are conservatively classified without relying on mutable effect metadata
/// attached to the terminator. An invoke reports the stored effects of the
/// operation it wraps, which the verifier holds to the same narrowing rule as
/// an instruction's.
pub fn effects_for_terminator(terminator: &ir::TerminatorKind) -> ir::Effects {
    let mut effects = EffectBuilder::default();
    match terminator {
        ir::TerminatorKind::Invoke { effects, .. } => return effects.clone(),
        ir::TerminatorKind::Jump(_)
        | ir::TerminatorKind::Branch { .. }
        | ir::TerminatorKind::Switch { .. }
        | ir::TerminatorKind::Return { .. } => {}
        ir::TerminatorKind::TailCall { callee, .. } => {
            classify_call_base(&mut effects);
            match callee {
                ir::Callee::Direct(_) => {}
                ir::Callee::Indirect { table, .. } => {
                    effects.access(ir::EffectResource::Table(*table), ir::EffectAccess::Read);
                    classify_indirect_call_traps(&mut effects);
                }
                ir::Callee::Reference { .. } => classify_reference_call_traps(&mut effects),
            }
        }
        ir::TerminatorKind::Throw { .. } => effects.may_throw(),
        ir::TerminatorKind::ThrowRef { .. } => {
            effects.may_throw();
            effects.trap(ir::TrapCode::NullReference);
        }
        ir::TerminatorKind::Unreachable { trap } => effects.trap(trap.clone()),
    }
    effects.finish()
}

#[derive(Default)]
struct EffectBuilder {
    effects: ir::Effects,
}

impl EffectBuilder {
    fn access(&mut self, resource: ir::EffectResource, access: ir::EffectAccess) {
        if let Some(existing) = self
            .effects
            .accesses
            .iter_mut()
            .find(|effect| effect.resource == resource)
        {
            existing.access = merge_accesses(existing.access, access);
        } else {
            self.effects.accesses.push(ir::Effect { resource, access });
        }
    }

    fn trap(&mut self, trap: ir::TrapCode) {
        if !self.effects.traps.contains(&trap) {
            self.effects.traps.push(trap);
        }
    }

    fn may_throw(&mut self) {
        self.effects.exception = ir::ExceptionEffect::MayThrow;
    }

    fn allocates(&mut self) {
        self.effects.allocates = true;
    }

    fn nondeterministic(&mut self) {
        self.effects.nondeterministic = true;
    }

    fn finish(self) -> ir::Effects {
        self.effects
    }
}

fn merge_accesses(left: ir::EffectAccess, right: ir::EffectAccess) -> ir::EffectAccess {
    if left == right {
        left
    } else {
        ir::EffectAccess::ReadWrite
    }
}

fn classify_numeric_traps(opcode: CoreOpcode, effects: &mut EffectBuilder) {
    match opcode {
        CoreOpcode::I32DivS | CoreOpcode::I64DivS => {
            effects.trap(ir::TrapCode::IntegerDivideByZero);
            effects.trap(ir::TrapCode::IntegerOverflow);
        }
        CoreOpcode::I32DivU
        | CoreOpcode::I64DivU
        | CoreOpcode::I32RemS
        | CoreOpcode::I32RemU
        | CoreOpcode::I64RemS
        | CoreOpcode::I64RemU => effects.trap(ir::TrapCode::IntegerDivideByZero),
        CoreOpcode::I32TruncF32S
        | CoreOpcode::I32TruncF32U
        | CoreOpcode::I32TruncF64S
        | CoreOpcode::I32TruncF64U
        | CoreOpcode::I64TruncF32S
        | CoreOpcode::I64TruncF32U
        | CoreOpcode::I64TruncF64S
        | CoreOpcode::I64TruncF64U => {
            effects.trap(ir::TrapCode::InvalidConversionToInteger);
            effects.trap(ir::TrapCode::IntegerOverflow);
        }
        _ => {}
    }
}

fn classify_memory(operation: &ir::Operation, opcode: CoreOpcode, effects: &mut EffectBuilder) {
    if is_memory_load(opcode) {
        for memory in memory_ids(operation) {
            effects.access(ir::EffectResource::Memory(memory), ir::EffectAccess::Read);
        }
        effects.trap(ir::TrapCode::MemoryOutOfBounds);
        return;
    }
    if is_memory_store(opcode) {
        for memory in memory_ids(operation) {
            effects.access(ir::EffectResource::Memory(memory), ir::EffectAccess::Write);
        }
        effects.trap(ir::TrapCode::MemoryOutOfBounds);
        return;
    }

    match opcode {
        CoreOpcode::MemorySize => {
            for memory in memory_ids(operation) {
                effects.access(ir::EffectResource::Memory(memory), ir::EffectAccess::Read);
            }
        }
        CoreOpcode::MemoryGrow => {
            for memory in memory_ids(operation) {
                effects.access(
                    ir::EffectResource::Memory(memory),
                    ir::EffectAccess::ReadWrite,
                );
            }
            effects.allocates();
        }
        CoreOpcode::MemoryFill => {
            for memory in memory_ids(operation) {
                effects.access(ir::EffectResource::Memory(memory), ir::EffectAccess::Write);
            }
            effects.trap(ir::TrapCode::MemoryOutOfBounds);
        }
        CoreOpcode::MemoryInit => {
            for memory in memory_ids(operation) {
                effects.access(ir::EffectResource::Memory(memory), ir::EffectAccess::Write);
            }
            effects.trap(ir::TrapCode::MemoryOutOfBounds);
        }
        CoreOpcode::MemoryCopy => {
            classify_memory_copy(operation, effects);
            effects.trap(ir::TrapCode::MemoryOutOfBounds);
        }
        _ => {}
    }
}

fn classify_memory_copy(operation: &ir::Operation, effects: &mut EffectBuilder) {
    let memories = memory_ids(operation);
    if memories.len() == 1 {
        effects.access(
            ir::EffectResource::Memory(memories[0]),
            ir::EffectAccess::ReadWrite,
        );
        return;
    }
    if let Some((&destination, sources)) = memories.split_first() {
        effects.access(
            ir::EffectResource::Memory(destination),
            ir::EffectAccess::Write,
        );
        for &source in sources {
            effects.access(ir::EffectResource::Memory(source), ir::EffectAccess::Read);
        }
    }
}

fn classify_tables(operation: &ir::Operation, opcode: CoreOpcode, effects: &mut EffectBuilder) {
    let access = match opcode {
        CoreOpcode::TableGet | CoreOpcode::TableSize => Some(ir::EffectAccess::Read),
        CoreOpcode::TableSet | CoreOpcode::TableFill | CoreOpcode::TableInit => {
            Some(ir::EffectAccess::Write)
        }
        CoreOpcode::TableGrow => {
            effects.allocates();
            Some(ir::EffectAccess::ReadWrite)
        }
        _ => None,
    };
    if let Some(access) = access {
        for table in table_ids(operation) {
            effects.access(ir::EffectResource::Table(table), access);
        }
    }

    match opcode {
        CoreOpcode::TableGet
        | CoreOpcode::TableSet
        | CoreOpcode::TableFill
        | CoreOpcode::TableInit => effects.trap(ir::TrapCode::TableOutOfBounds),
        CoreOpcode::TableCopy => {
            let tables = table_ids(operation);
            if tables.len() == 1 {
                effects.access(
                    ir::EffectResource::Table(tables[0]),
                    ir::EffectAccess::ReadWrite,
                );
            } else if let Some((&destination, sources)) = tables.split_first() {
                effects.access(
                    ir::EffectResource::Table(destination),
                    ir::EffectAccess::Write,
                );
                for &source in sources {
                    effects.access(ir::EffectResource::Table(source), ir::EffectAccess::Read);
                }
            }
            effects.trap(ir::TrapCode::TableOutOfBounds);
        }
        _ => {}
    }
}

fn classify_globals(operation: &ir::Operation, opcode: CoreOpcode, effects: &mut EffectBuilder) {
    let access = match opcode {
        CoreOpcode::GlobalGet => ir::EffectAccess::Read,
        CoreOpcode::GlobalSet => ir::EffectAccess::Write,
        _ => return,
    };
    for global in global_ids(operation) {
        effects.access(ir::EffectResource::Global(global), access);
    }
}

fn classify_calls(operation: &ir::Operation, opcode: CoreOpcode, effects: &mut EffectBuilder) {
    if !matches!(
        opcode,
        CoreOpcode::Call
            | CoreOpcode::CallIndirect
            | CoreOpcode::CallRef
            | CoreOpcode::ReturnCall
            | CoreOpcode::ReturnCallIndirect
            | CoreOpcode::ReturnCallRef
    ) {
        return;
    }

    classify_call_base(effects);

    match opcode {
        CoreOpcode::CallIndirect | CoreOpcode::ReturnCallIndirect => {
            for table in table_ids(operation) {
                effects.access(ir::EffectResource::Table(table), ir::EffectAccess::Read);
            }
            classify_indirect_call_traps(effects);
        }
        CoreOpcode::CallRef | CoreOpcode::ReturnCallRef => {
            classify_reference_call_traps(effects);
        }
        _ => {}
    }
}

fn classify_call_base(effects: &mut EffectBuilder) {
    effects.access(ir::EffectResource::Host, ir::EffectAccess::ReadWrite);
    effects.may_throw();
    effects.allocates();
    effects.trap(ir::TrapCode::StackOverflow);
    effects.trap(ir::TrapCode::Other("callee-trap".to_owned()));
}

fn classify_indirect_call_traps(effects: &mut EffectBuilder) {
    effects.trap(ir::TrapCode::TableOutOfBounds);
    effects.trap(ir::TrapCode::NullFunctionReference);
    effects.trap(ir::TrapCode::IndirectCallTypeMismatch);
}

fn classify_reference_call_traps(effects: &mut EffectBuilder) {
    effects.trap(ir::TrapCode::NullFunctionReference);
}

fn classify_gc(opcode: CoreOpcode, effects: &mut EffectBuilder) {
    match opcode {
        CoreOpcode::StructNew
        | CoreOpcode::StructNewDefault
        | CoreOpcode::ArrayNew
        | CoreOpcode::ArrayNewDefault
        | CoreOpcode::ArrayNewFixed
        | CoreOpcode::ArrayNewData
        | CoreOpcode::ArrayNewElem => {
            effects.access(ir::EffectResource::GcHeap, ir::EffectAccess::Write);
            effects.allocates();
            effects.trap(ir::TrapCode::AllocationFailure);
        }
        CoreOpcode::StructGet | CoreOpcode::StructGetS | CoreOpcode::StructGetU => {
            effects.access(ir::EffectResource::GcHeap, ir::EffectAccess::Read);
            effects.trap(ir::TrapCode::NullReference);
        }
        CoreOpcode::StructSet => {
            effects.access(ir::EffectResource::GcHeap, ir::EffectAccess::Write);
            effects.trap(ir::TrapCode::NullReference);
        }
        CoreOpcode::ArrayGet
        | CoreOpcode::ArrayGetS
        | CoreOpcode::ArrayGetU
        | CoreOpcode::ArrayLen => {
            effects.access(ir::EffectResource::GcHeap, ir::EffectAccess::Read);
            effects.trap(ir::TrapCode::NullReference);
            if !matches!(opcode, CoreOpcode::ArrayLen) {
                effects.trap(ir::TrapCode::BadArrayElement);
            }
        }
        CoreOpcode::ArraySet
        | CoreOpcode::ArrayFill
        | CoreOpcode::ArrayInitData
        | CoreOpcode::ArrayInitElem => {
            effects.access(ir::EffectResource::GcHeap, ir::EffectAccess::Write);
            effects.trap(ir::TrapCode::NullReference);
            effects.trap(ir::TrapCode::BadArrayElement);
        }
        CoreOpcode::ArrayCopy => {
            effects.access(ir::EffectResource::GcHeap, ir::EffectAccess::ReadWrite);
            effects.trap(ir::TrapCode::NullReference);
            effects.trap(ir::TrapCode::BadArrayElement);
        }
        CoreOpcode::RefTestNonNull
        | CoreOpcode::RefTestNullable
        | CoreOpcode::RefCastNonNull
        | CoreOpcode::RefCastNullable
        | CoreOpcode::BrOnCast
        | CoreOpcode::BrOnCastFail => {
            effects.access(ir::EffectResource::GcHeap, ir::EffectAccess::Read);
        }
        _ => {}
    }

    if matches!(opcode, CoreOpcode::ArrayNewData | CoreOpcode::ArrayNewElem) {
        effects.trap(ir::TrapCode::BadArrayElement);
    }
}

fn classify_reference_traps(opcode: CoreOpcode, effects: &mut EffectBuilder) {
    match opcode {
        CoreOpcode::RefAsNonNull | CoreOpcode::I31GetS | CoreOpcode::I31GetU => {
            effects.trap(ir::TrapCode::NullReference);
        }
        CoreOpcode::RefCastNonNull | CoreOpcode::RefCastNullable => {
            effects.trap(ir::TrapCode::Other("cast-failure".to_owned()));
        }
        CoreOpcode::ThrowRef => effects.trap(ir::TrapCode::NullReference),
        _ => {}
    }
}

fn classify_segment_state(
    operation: &ir::Operation,
    opcode: CoreOpcode,
    effects: &mut EffectBuilder,
) {
    let data_access = match opcode {
        CoreOpcode::MemoryInit | CoreOpcode::ArrayNewData | CoreOpcode::ArrayInitData => {
            Some(ir::EffectAccess::Read)
        }
        CoreOpcode::DataDrop => Some(ir::EffectAccess::Write),
        _ => None,
    };
    if let Some(access) = data_access {
        for data in data_ids(operation) {
            effects.access(ir::EffectResource::DataSegment(data), access);
        }
    }

    let element_access = match opcode {
        CoreOpcode::TableInit | CoreOpcode::ArrayNewElem | CoreOpcode::ArrayInitElem => {
            Some(ir::EffectAccess::Read)
        }
        CoreOpcode::ElemDrop => Some(ir::EffectAccess::Write),
        _ => None,
    };
    if let Some(access) = element_access {
        for element in element_ids(operation) {
            effects.access(ir::EffectResource::ElementSegment(element), access);
        }
    }
}

fn is_memory_load(opcode: CoreOpcode) -> bool {
    let parser_name = opcode.parser_name();
    ["I32Load", "I64Load", "F32Load", "F64Load", "V128Load"]
        .iter()
        .any(|prefix| parser_name.starts_with(prefix))
}

fn is_memory_store(opcode: CoreOpcode) -> bool {
    let parser_name = opcode.parser_name();
    ["I32Store", "I64Store", "F32Store", "F64Store", "V128Store"]
        .iter()
        .any(|prefix| parser_name.starts_with(prefix))
}

fn memory_ids(operation: &ir::Operation) -> Vec<ir::MemoryId> {
    let mut memories = Vec::new();
    for immediate in &operation.immediates {
        let memory = match immediate {
            ir::Immediate::Memory(memory) => Some(*memory),
            ir::Immediate::MemoryArgument(argument) => Some(argument.memory),
            _ => None,
        };
        if let Some(memory) = memory {
            if !memories.contains(&memory) {
                memories.push(memory);
            }
        }
    }
    if memories.is_empty() {
        memories.push(ir::MemoryId(0));
    }
    memories
}

fn table_ids(operation: &ir::Operation) -> Vec<ir::TableId> {
    let mut tables = Vec::new();
    for immediate in &operation.immediates {
        if let ir::Immediate::Table(table) = immediate {
            if !tables.contains(table) {
                tables.push(*table);
            }
        }
    }
    if tables.is_empty() {
        tables.push(ir::TableId(0));
    }
    tables
}

fn global_ids(operation: &ir::Operation) -> Vec<ir::GlobalId> {
    let mut globals = Vec::new();
    for immediate in &operation.immediates {
        if let ir::Immediate::Global(global) = immediate {
            if !globals.contains(global) {
                globals.push(*global);
            }
        }
    }
    if globals.is_empty() {
        globals.push(ir::GlobalId(0));
    }
    globals
}

fn data_ids(operation: &ir::Operation) -> Vec<ir::DataId> {
    let mut data = Vec::new();
    for immediate in &operation.immediates {
        if let ir::Immediate::Data(id) = immediate {
            if !data.contains(id) {
                data.push(*id);
            }
        }
    }
    data
}

fn element_ids(operation: &ir::Operation) -> Vec<ir::ElementId> {
    let mut elements = Vec::new();
    for immediate in &operation.immediates {
        if let ir::Immediate::Element(id) = immediate {
            if !elements.contains(id) {
                elements.push(*id);
            }
        }
    }
    elements
}
