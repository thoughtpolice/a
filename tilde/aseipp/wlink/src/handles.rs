// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The resource handle table of a linked program.
//!
//! The canonical ABI gives every component instance a table of handles: an
//! `own` handle carries the representation of a resource until it is dropped
//! or passed on, and a `borrow` handle lends one for the duration of a call.
//! In a static link, one table in a synthesized memory serves every frame:
//! each entry records the frame that owns it, so a handle is only valid for
//! the frame it was handed to, exactly as a table per instance would arrange.
//!
//! The table is an array of fixed-size entries after a small header, with
//! freed entries threaded through an intrusive free list. Index 0 is never
//! handed out. Three shared functions maintain it, and the resource
//! built-ins and the adapters are ordinary code over those functions.
//!
//! A call that lends borrowed handles into a frame other than the resource's
//! implementor has a scope: an entry of the table that counts the borrows
//! outstanding, which must reach zero before the call returns. Handles that
//! are lent out count their lenders and cannot be dropped or passed on while
//! lent.
//!
//! A borrow lent to the host from a word of the caller's memory, inside a
//! list or a spilled parameter record, is remembered in a lender record: an
//! entry naming the handle and the word it came from, chained through the
//! records of the same call. The word holds the representation while the
//! host runs; walking the chain afterwards puts the handle back, returns the
//! lend, and frees the record.

use wasm_encoder::{Function, Instruction, MemArg};

use crate::types::CoreType;

/// Header word: the highest index handed out so far.
pub const LENGTH: u32 = 0;
/// Header word: the head of the free list, or 0.
pub const FREE_HEAD: u32 = 4;
/// Where entry 0 starts; the header is padded out to it.
pub const ENTRY_BASE: u32 = 32;
pub const ENTRY_SIZE: u32 = 24;

/// Entry field: the resource's word, or 0 for a free entry.
pub const RT: u32 = 0;
/// Entry field: the representation; for a scope its outstanding borrows;
/// for a lender record the handle lent.
pub const REP: u32 = 4;
/// Entry field: the frame the handle belongs to; for a lender record the
/// address of the word the handle was lent from.
pub const OWNER: u32 = 8;
/// Entry field: 1 for an `own` handle, 0 for a `borrow`.
pub const OWN: u32 = 12;
/// Entry field: how many calls currently lend the handle out.
pub const LENDS: u32 = 16;
/// Entry field: for a borrow, the scope entry it belongs to; for a lender
/// record the next record of its chain, or 0.
pub const SCOPE: u32 = 20;

/// The resource word of a scope entry, which no resource has.
pub const SCOPE_RT: i32 = -1;
/// The resource word of a lender record, likewise.
pub const LENDER_RT: i32 = -2;

/// The word a resource's entries carry; 0 marks a free entry.
pub fn rt_word(resource: u32) -> i32 {
    resource as i32 + 1
}

/// The indices of the table's memory and maintenance functions.
#[derive(Clone, Copy, Debug)]
pub struct Runtime {
    pub memory: u32,
    /// `add(rt, rep, owner, own, scope) -> index`
    pub add: u32,
    /// `get(rt, owner, index) -> address`, trapping unless the entry is a
    /// live handle of that resource belonging to that frame.
    pub get: u32,
    /// `free(index)`
    pub free: u32,
}

/// A synthesized core function.
pub struct Synthesized {
    pub params: Vec<CoreType>,
    pub results: Vec<CoreType>,
    pub body: Function,
}

fn memarg(memory: u32, offset: u32) -> MemArg {
    MemArg {
        offset: u64::from(offset),
        align: 2,
        memory_index: memory,
    }
}

/// Emits `address = ENTRY_BASE + ENTRY_SIZE * index` for the index on the
/// stack.
fn entry_address(code: &mut Vec<Instruction<'static>>) {
    code.push(Instruction::I32Const(ENTRY_SIZE as i32));
    code.push(Instruction::I32Mul);
    code.push(Instruction::I32Const(ENTRY_BASE as i32));
    code.push(Instruction::I32Add);
}

fn trap_if(code: &mut Vec<Instruction<'static>>) {
    code.push(Instruction::If(wasm_encoder::BlockType::Empty));
    code.push(Instruction::Unreachable);
    code.push(Instruction::End);
}

fn function(locals: &[(u32, wasm_encoder::ValType)], code: Vec<Instruction<'static>>) -> Function {
    let mut body = Function::new(locals.iter().copied());
    for instruction in &code {
        body.instruction(instruction);
    }
    body.instruction(&Instruction::End);
    body
}

/// `add(rt, rep, owner, own, scope) -> index`: pops the free list or grows
/// the table, growing the memory by a page when it is full.
pub fn add(runtime: Runtime) -> Synthesized {
    const RT_ARG: u32 = 0;
    const REP_ARG: u32 = 1;
    const OWNER_ARG: u32 = 2;
    const OWN_ARG: u32 = 3;
    const SCOPE_ARG: u32 = 4;
    const INDEX: u32 = 5;
    const ADDRESS: u32 = 6;
    let memory = runtime.memory;
    let mut code = Vec::new();
    code.push(Instruction::I32Const(0));
    code.push(Instruction::I32Load(memarg(memory, FREE_HEAD)));
    code.push(Instruction::LocalTee(INDEX));
    code.push(Instruction::If(wasm_encoder::BlockType::Empty));
    // Unlink the head of the free list; a free entry's rep is the next one.
    code.push(Instruction::I32Const(0));
    code.push(Instruction::LocalGet(INDEX));
    entry_address(&mut code);
    code.push(Instruction::I32Load(memarg(memory, REP)));
    code.push(Instruction::I32Store(memarg(memory, FREE_HEAD)));
    code.push(Instruction::Else);
    code.push(Instruction::I32Const(0));
    code.push(Instruction::I32Load(memarg(memory, LENGTH)));
    code.push(Instruction::I32Const(1));
    code.push(Instruction::I32Add);
    code.push(Instruction::LocalTee(INDEX));
    // The table must hold the new entry: grow by a page when it would not.
    code.push(Instruction::I32Const(1));
    code.push(Instruction::I32Add);
    entry_address(&mut code);
    code.push(Instruction::MemorySize(memory));
    code.push(Instruction::I32Const(16));
    code.push(Instruction::I32Shl);
    code.push(Instruction::I32GtU);
    code.push(Instruction::If(wasm_encoder::BlockType::Empty));
    code.push(Instruction::I32Const(1));
    code.push(Instruction::MemoryGrow(memory));
    code.push(Instruction::I32Const(-1));
    code.push(Instruction::I32Eq);
    trap_if(&mut code);
    code.push(Instruction::End);
    code.push(Instruction::I32Const(0));
    code.push(Instruction::LocalGet(INDEX));
    code.push(Instruction::I32Store(memarg(memory, LENGTH)));
    code.push(Instruction::End);
    code.push(Instruction::LocalGet(INDEX));
    entry_address(&mut code);
    code.push(Instruction::LocalSet(ADDRESS));
    for (field, arg) in [
        (RT, RT_ARG),
        (REP, REP_ARG),
        (OWNER, OWNER_ARG),
        (OWN, OWN_ARG),
        (SCOPE, SCOPE_ARG),
    ] {
        code.push(Instruction::LocalGet(ADDRESS));
        code.push(Instruction::LocalGet(arg));
        code.push(Instruction::I32Store(memarg(memory, field)));
    }
    code.push(Instruction::LocalGet(ADDRESS));
    code.push(Instruction::I32Const(0));
    code.push(Instruction::I32Store(memarg(memory, LENDS)));
    code.push(Instruction::LocalGet(INDEX));
    Synthesized {
        params: vec![CoreType::I32; 5],
        results: vec![CoreType::I32],
        body: function(&[(2, wasm_encoder::ValType::I32)], code),
    }
}

/// `get(rt, owner, index) -> address`.
pub fn get(runtime: Runtime) -> Synthesized {
    const RT_ARG: u32 = 0;
    const OWNER_ARG: u32 = 1;
    const INDEX: u32 = 2;
    const ADDRESS: u32 = 3;
    let memory = runtime.memory;
    let mut code = Vec::new();
    // Index 0 is reserved, and nothing beyond the length was handed out.
    code.push(Instruction::LocalGet(INDEX));
    code.push(Instruction::I32Eqz);
    trap_if(&mut code);
    code.push(Instruction::LocalGet(INDEX));
    code.push(Instruction::I32Const(0));
    code.push(Instruction::I32Load(memarg(memory, LENGTH)));
    code.push(Instruction::I32GtU);
    trap_if(&mut code);
    code.push(Instruction::LocalGet(INDEX));
    entry_address(&mut code);
    code.push(Instruction::LocalTee(ADDRESS));
    code.push(Instruction::I32Load(memarg(memory, RT)));
    code.push(Instruction::LocalGet(RT_ARG));
    code.push(Instruction::I32Ne);
    trap_if(&mut code);
    code.push(Instruction::LocalGet(ADDRESS));
    code.push(Instruction::I32Load(memarg(memory, OWNER)));
    code.push(Instruction::LocalGet(OWNER_ARG));
    code.push(Instruction::I32Ne);
    trap_if(&mut code);
    code.push(Instruction::LocalGet(ADDRESS));
    Synthesized {
        params: vec![CoreType::I32; 3],
        results: vec![CoreType::I32],
        body: function(&[(1, wasm_encoder::ValType::I32)], code),
    }
}

/// `free(index)`: returns an entry to the free list.
pub fn free(runtime: Runtime) -> Synthesized {
    const INDEX: u32 = 0;
    const ADDRESS: u32 = 1;
    let memory = runtime.memory;
    let mut code = Vec::new();
    code.push(Instruction::LocalGet(INDEX));
    entry_address(&mut code);
    code.push(Instruction::LocalTee(ADDRESS));
    code.push(Instruction::I32Const(0));
    code.push(Instruction::I32Store(memarg(memory, RT)));
    code.push(Instruction::LocalGet(ADDRESS));
    code.push(Instruction::I32Const(0));
    code.push(Instruction::I32Load(memarg(memory, FREE_HEAD)));
    code.push(Instruction::I32Store(memarg(memory, REP)));
    code.push(Instruction::I32Const(0));
    code.push(Instruction::LocalGet(INDEX));
    code.push(Instruction::I32Store(memarg(memory, FREE_HEAD)));
    Synthesized {
        params: vec![CoreType::I32],
        results: Vec::new(),
        body: function(&[(1, wasm_encoder::ValType::I32)], code),
    }
}

/// Scratch locals the inline handle sequences use. All hold `i32`.
#[derive(Clone, Copy, Debug)]
pub struct Scratch {
    pub handle: u32,
    pub address: u32,
    pub rep: u32,
}

/// The inline sequences over the table, appended to a function body. Each
/// takes its handle or representation from the stack and leaves its result
/// there.
pub struct Ops<'a> {
    pub runtime: Runtime,
    pub code: &'a mut Vec<Instruction<'static>>,
    pub scratch: Scratch,
}

impl Ops<'_> {
    fn emit(&mut self, instruction: Instruction<'static>) {
        self.code.push(instruction);
    }

    fn load(&mut self, field: u32) {
        self.emit(Instruction::I32Load(memarg(self.runtime.memory, field)));
    }

    fn store(&mut self, field: u32) {
        self.emit(Instruction::I32Store(memarg(self.runtime.memory, field)));
    }

    /// `handle -> address` for a live handle of `rt` owned by `owner`.
    fn get(&mut self, rt: u32, owner: u32) {
        self.emit(Instruction::LocalSet(self.scratch.handle));
        self.emit(Instruction::I32Const(rt_word(rt)));
        self.emit(Instruction::I32Const(owner as i32));
        self.emit(Instruction::LocalGet(self.scratch.handle));
        self.emit(Instruction::Call(self.runtime.get));
        self.emit(Instruction::LocalSet(self.scratch.address));
    }

    /// Adds `field` of the entry at the scratch address by `delta`.
    fn adjust(&mut self, field: u32, delta: i32) {
        self.emit(Instruction::LocalGet(self.scratch.address));
        self.emit(Instruction::LocalGet(self.scratch.address));
        self.load(field);
        self.emit(Instruction::I32Const(delta));
        self.emit(Instruction::I32Add);
        self.store(field);
    }

    /// Traps when `field` of the entry at the scratch address is nonzero,
    /// or zero under `Instruction::I32Eqz`.
    fn trap_if_field(&mut self, field: u32, condition: Option<Instruction<'static>>) {
        self.emit(Instruction::LocalGet(self.scratch.address));
        self.load(field);
        if let Some(condition) = condition {
            self.emit(condition);
        }
        trap_if(self.code);
    }

    /// `rep -> handle`: a new `own` handle of `rt` for `owner`.
    pub fn lower_own(&mut self, rt: u32, owner: u32) {
        self.emit(Instruction::LocalSet(self.scratch.rep));
        self.emit(Instruction::I32Const(rt_word(rt)));
        self.emit(Instruction::LocalGet(self.scratch.rep));
        self.emit(Instruction::I32Const(owner as i32));
        self.emit(Instruction::I32Const(1));
        self.emit(Instruction::I32Const(0));
        self.emit(Instruction::Call(self.runtime.add));
    }

    /// `handle -> rep`, removing the `own` handle from the table. Traps on a
    /// borrow or a handle that is lent out.
    pub fn lift_own(&mut self, rt: u32, owner: u32) {
        self.get(rt, owner);
        self.trap_if_field(OWN, Some(Instruction::I32Eqz));
        self.trap_if_field(LENDS, None);
        self.emit(Instruction::LocalGet(self.scratch.address));
        self.load(REP);
        self.emit(Instruction::LocalSet(self.scratch.rep));
        self.emit(Instruction::LocalGet(self.scratch.handle));
        self.emit(Instruction::Call(self.runtime.free));
        self.emit(Instruction::LocalGet(self.scratch.rep));
    }

    /// `handle -> rep`, lending the handle for the duration of a call.
    pub fn lift_borrow(&mut self, rt: u32, owner: u32) {
        self.get(rt, owner);
        self.adjust(LENDS, 1);
        self.emit(Instruction::LocalGet(self.scratch.address));
        self.load(REP);
    }

    /// `handle -> ()`: the call the handle was lent for has returned.
    pub fn unlend(&mut self, rt: u32, owner: u32) {
        self.get(rt, owner);
        self.adjust(LENDS, -1);
    }

    /// `rep -> handle`: a `borrow` handle of `rt` for `owner`, counted
    /// against the scope whose entry address is in the `scope` local.
    pub fn lower_borrow(&mut self, rt: u32, owner: u32, scope: u32, scope_address: u32) {
        self.emit(Instruction::LocalSet(self.scratch.rep));
        self.emit(Instruction::I32Const(rt_word(rt)));
        self.emit(Instruction::LocalGet(self.scratch.rep));
        self.emit(Instruction::I32Const(owner as i32));
        self.emit(Instruction::I32Const(0));
        self.emit(Instruction::LocalGet(scope));
        self.emit(Instruction::Call(self.runtime.add));
        self.emit(Instruction::LocalGet(scope_address));
        self.emit(Instruction::LocalGet(scope_address));
        self.load(REP);
        self.emit(Instruction::I32Const(1));
        self.emit(Instruction::I32Add);
        self.store(REP);
    }

    /// Opens a scope, leaving its index and entry address in the locals.
    pub fn open_scope(&mut self, scope: u32, scope_address: u32) {
        self.emit(Instruction::I32Const(SCOPE_RT));
        for _ in 0..4 {
            self.emit(Instruction::I32Const(0));
        }
        self.emit(Instruction::Call(self.runtime.add));
        self.emit(Instruction::LocalTee(scope));
        entry_address(self.code);
        self.emit(Instruction::LocalSet(scope_address));
    }

    /// Closes a scope, trapping while any of its borrows is outstanding.
    pub fn close_scope(&mut self, scope: u32, scope_address: u32) {
        self.emit(Instruction::LocalGet(scope_address));
        self.load(REP);
        trap_if(self.code);
        self.emit(Instruction::LocalGet(scope));
        self.emit(Instruction::Call(self.runtime.free));
    }

    /// Pushes a lender record for the borrow [`Self::lift_borrow`] just
    /// lifted, whose handle its `get` left in the scratch `handle` local,
    /// lent from the word `offset` bytes past the address in the `base`
    /// local; `head` holds the chain and receives the record.
    pub fn push_lender(&mut self, head: u32, base: u32, offset: u32) {
        self.emit(Instruction::I32Const(LENDER_RT));
        self.emit(Instruction::LocalGet(self.scratch.handle));
        self.emit(Instruction::LocalGet(base));
        self.emit(Instruction::I32Const(offset as i32));
        self.emit(Instruction::I32Add);
        self.emit(Instruction::I32Const(0));
        self.emit(Instruction::LocalGet(head));
        self.emit(Instruction::Call(self.runtime.add));
        self.emit(Instruction::LocalSet(head));
    }

    /// Pops every lender record on the chain in `head`: puts the handle
    /// back into the word of `memory` it was lent from, returns the lend,
    /// and frees the record, leaving the chain empty. A lent entry cannot
    /// have been freed meanwhile, since dropping or moving a handle traps
    /// while it is lent, so the entry is found from the handle without the
    /// checks of `get`; a lend count already at zero traps all the same.
    pub fn return_lenders(&mut self, head: u32, memory: u32) {
        let record = self.scratch.rep;
        let next = self.scratch.handle;
        self.emit(Instruction::Block(wasm_encoder::BlockType::Empty));
        self.emit(Instruction::Loop(wasm_encoder::BlockType::Empty));
        self.emit(Instruction::LocalGet(head));
        self.emit(Instruction::I32Eqz);
        self.emit(Instruction::BrIf(1));
        self.emit(Instruction::LocalGet(head));
        entry_address(self.code);
        self.emit(Instruction::LocalSet(record));
        self.emit(Instruction::LocalGet(record));
        self.load(SCOPE);
        self.emit(Instruction::LocalSet(next));
        self.emit(Instruction::LocalGet(record));
        self.load(OWNER);
        self.emit(Instruction::LocalGet(record));
        self.load(REP);
        self.emit(Instruction::I32Store(memarg(memory, 0)));
        self.emit(Instruction::LocalGet(record));
        self.load(REP);
        entry_address(self.code);
        self.emit(Instruction::LocalSet(self.scratch.address));
        self.trap_if_field(LENDS, Some(Instruction::I32Eqz));
        self.adjust(LENDS, -1);
        self.emit(Instruction::LocalGet(head));
        self.emit(Instruction::Call(self.runtime.free));
        self.emit(Instruction::LocalGet(next));
        self.emit(Instruction::LocalSet(head));
        self.emit(Instruction::Br(0));
        self.emit(Instruction::End);
        self.emit(Instruction::End);
    }
}

const BUILTIN_SCRATCH: Scratch = Scratch {
    handle: 1,
    address: 2,
    rep: 3,
};

fn builtin_locals() -> [(u32, wasm_encoder::ValType); 1] {
    [(4, wasm_encoder::ValType::I32)]
}

/// `canon resource.new`: `rep -> handle` in the implementing frame.
pub fn resource_new(runtime: Runtime, frame: u32, resource: u32) -> Synthesized {
    let mut code = vec![Instruction::LocalGet(0)];
    Ops {
        runtime,
        code: &mut code,
        scratch: BUILTIN_SCRATCH,
    }
    .lower_own(resource, frame);
    Synthesized {
        params: vec![CoreType::I32],
        results: vec![CoreType::I32],
        body: function(&builtin_locals(), code),
    }
}

/// `canon resource.rep`: `handle -> rep` in the implementing frame.
pub fn resource_rep(runtime: Runtime, frame: u32, resource: u32) -> Synthesized {
    let mut code = vec![Instruction::LocalGet(0)];
    let mut ops = Ops {
        runtime,
        code: &mut code,
        scratch: BUILTIN_SCRATCH,
    };
    ops.get(resource, frame);
    ops.emit(Instruction::LocalGet(BUILTIN_SCRATCH.address));
    ops.load(REP);
    Synthesized {
        params: vec![CoreType::I32],
        results: vec![CoreType::I32],
        body: function(&builtin_locals(), code),
    }
}

/// `canon resource.drop`: removes the handle; an `own` handle's
/// representation goes to the destructor, a `borrow` is returned to its
/// scope. Traps while the handle is lent out.
pub fn resource_drop(
    runtime: Runtime,
    frame: u32,
    resource: u32,
    dtor: Option<u32>,
) -> Synthesized {
    const OWN_FLAG: u32 = 4;
    let mut code = vec![Instruction::LocalGet(0)];
    let mut ops = Ops {
        runtime,
        code: &mut code,
        scratch: BUILTIN_SCRATCH,
    };
    ops.get(resource, frame);
    ops.trap_if_field(LENDS, None);
    ops.emit(Instruction::LocalGet(BUILTIN_SCRATCH.address));
    ops.load(OWN);
    ops.emit(Instruction::LocalSet(OWN_FLAG));
    ops.emit(Instruction::LocalGet(BUILTIN_SCRATCH.address));
    ops.load(REP);
    ops.emit(Instruction::LocalSet(BUILTIN_SCRATCH.rep));
    // A borrow's scope entry address, computed before the entry is freed.
    ops.emit(Instruction::LocalGet(BUILTIN_SCRATCH.address));
    ops.load(SCOPE);
    entry_address(ops.code);
    ops.emit(Instruction::LocalSet(BUILTIN_SCRATCH.address));
    ops.emit(Instruction::LocalGet(BUILTIN_SCRATCH.handle));
    ops.emit(Instruction::Call(runtime.free));
    ops.emit(Instruction::LocalGet(OWN_FLAG));
    ops.emit(Instruction::If(wasm_encoder::BlockType::Empty));
    if let Some(dtor) = dtor {
        ops.emit(Instruction::LocalGet(BUILTIN_SCRATCH.rep));
        ops.emit(Instruction::Call(dtor));
    }
    ops.emit(Instruction::Else);
    ops.adjust(REP, -1);
    ops.emit(Instruction::End);
    Synthesized {
        params: vec![CoreType::I32],
        results: Vec::new(),
        body: function(&[(5, wasm_encoder::ValType::I32)], code),
    }
}

/// The destructor the host calls for a resource the package exports:
/// `rep -> ()`.
pub fn host_facing_drop(dtor: Option<u32>) -> Synthesized {
    let mut code = Vec::new();
    if let Some(dtor) = dtor {
        code.push(Instruction::LocalGet(0));
        code.push(Instruction::Call(dtor));
    }
    Synthesized {
        params: vec![CoreType::I32],
        results: Vec::new(),
        body: function(&[], code),
    }
}
