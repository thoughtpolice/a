// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fused adapters, import trampolines, and export wrappers.
//!
//! When one instance lowers a function that another instance lifted, the
//! runtime is expected to synthesize a function that converts between the two
//! core ABIs. In a static link that function is ordinary code in the output
//! module. The adapter takes the caller's flat arguments, copies every string
//! or list into the callee's memory through the callee's `realloc`, moves
//! every resource handle from the caller's table to the callee's, calls the
//! callee, converts any result back the same way through the caller's
//! `realloc` and table, and finally invokes the callee's `post-return` so it
//! can release the result. Values are converted by walking their types, so
//! strings, lists, and handles are handled wherever they appear: as
//! parameters, inside records, inside the payloads of variants, as list
//! elements, or in a result. Parameter lists and results too large for the
//! flat ABI are spilled through memory as the canonical ABI specifies.
//!
//! The same walk adapts the package's edges once handles are involved. A
//! host import receives the caller's flat arguments with each handle
//! replaced by the resource's representation, and the results the host
//! produces are lowered into the caller's table. A host-facing export is
//! wrapped so the host passes and receives representations while the
//! component sees handles. Strings and lists at those edges stay in the
//! component's memory, which the host reads and writes directly; a handle
//! inside one of them, or in a parameter record that spilled, is rewritten
//! there to its representation for the duration of the call, and a borrow
//! lent that way is put back and returned through the handle table's
//! lender chain once the host returns.
//!
//! In a link with the async runtime, the ends of streams and futures move
//! between frames as handles do, and a synchronously typed call into a
//! frame that uses the runtime runs as a thread of its own: the adapter
//! saves the caller's thread, runs the callee with a fresh one, and puts
//! the caller's back. The async calls themselves are `tasks.rs`'s.

use anyhow::{Result, bail};
use wasm_encoder::{BlockType, Function, Instruction, MemArg, ValType as WasmType};

use crate::component::StringEncoding;
use crate::handles::{Ops, Runtime, Scratch};
use crate::tasks::AsyncRuntime;
use crate::types::{
    self, CoreType, FuncType, Layout, MAX_FLAT_PARAMS, MAX_FLAT_RESULTS, ValType, align_to,
    alignment, contains_borrows, contains_handles, contains_handles_in_memory, contains_pointers,
    discriminant_size, flat_types, layout, params_record, record_fields, size, variant_cases,
};

/// One side of a call: a frame of the linked program, or the host.
#[derive(Clone, Copy, Debug)]
pub struct Party {
    /// The frame whose handle table the side's handles live in; `None` for
    /// the host, which deals in representations.
    pub frame: Option<u32>,
    pub memory: Option<u32>,
    pub realloc: Option<u32>,
    pub encoding: StringEncoding,
}

/// Which edge of the linked program an adapter stands on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Boundary {
    /// A lowered import bound to a lifted export of another frame.
    Fused,
    /// A lowered import the host implements.
    Import,
    /// A lifted export the host calls.
    Export,
}

/// What an adapter needs to know about a resource type.
#[derive(Clone, Copy, Debug)]
pub struct ResourceInfo {
    /// The frame that implements it, which receives borrowed handles as
    /// bare representations.
    pub owner: Option<u32>,
}

/// The handle table of the linked program.
#[derive(Clone, Copy, Debug)]
pub struct Handles<'a> {
    pub runtime: Runtime,
    pub resources: &'a [ResourceInfo],
}

/// The core indices an adapter is generated against.
#[derive(Clone, Copy, Debug)]
pub struct Environment<'a> {
    pub boundary: Boundary,
    pub callee: u32,
    pub caller: Party,
    pub target: Party,
    pub post_return: Option<u32>,
    pub handles: Option<Handles<'a>>,
    /// The async runtime, in a link that has one.
    pub runtime: Option<&'a AsyncRuntime>,
    /// For a synchronously typed call into a frame that uses the async
    /// runtime, that frame: the callee runs as a fresh thread that may not
    /// block.
    pub context: Option<u32>,
    /// For the host's call of an async function lifted synchronously, the
    /// callee's frame: the call is a task, which waits for backpressure to
    /// enter and holds the frame's lock while it runs.
    pub task: Option<u32>,
}

/// A generated adapter.
pub struct Emitted {
    pub params: Vec<CoreType>,
    pub results: Vec<CoreType>,
    pub body: Function,
}

/// Whether a lowered call of `ty` can be bound directly to the lifted core
/// function: both sides then share one flat signature and no value touches
/// memory or a handle table.
pub fn is_passthrough(ty: &FuncType) -> bool {
    let params = layout(&params_record(&ty.params));
    let result = ty.result.as_ref().map(layout);
    let spills = params.flat.len() > MAX_FLAT_PARAMS
        || result
            .as_ref()
            .is_some_and(|result| result.flat.len() > MAX_FLAT_RESULTS);
    let touches = |layout: &Layout| layout.pointers || layout.handles;
    !spills && !touches(&params) && !result.as_ref().is_some_and(touches)
}

/// Whether the package's edge for `ty` needs an adapter: a host import or
/// export whose values carry handles.
pub fn edge_needs_adapter(ty: &FuncType) -> bool {
    ty.params.iter().any(|(_, param)| contains_handles(param))
        || ty.result.as_ref().is_some_and(contains_handles)
}

/// The core signature of a lowered import that nothing satisfies, which is
/// the signature the host is expected to implement.
pub fn import_signature(ty: &FuncType) -> types::Signature {
    types::lower_signature(ty)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Direction {
    /// Parameters: from the caller into the callee.
    ToCallee,
    /// Results: from the callee back to the caller.
    ToCaller,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Memory {
    /// Strings and lists are copied from `src` into `dst` through `realloc`.
    Transfer { src: u32, dst: u32, realloc: u32 },
    /// Values stay where they are in `memory`; only handles are rewritten.
    InPlace(u32),
    /// Values stay where they are in `memory`, handles become the
    /// representations the host takes, and each borrow is pushed on the
    /// lender chain in the `head` local, which puts the handle back and
    /// returns the lend after the call.
    Lend { memory: u32, head: u32 },
    /// Nothing in memory is touched.
    Untouched,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Visit {
    Convert {
        direction: Direction,
        memory: Memory,
    },
    /// The call returned: every borrowed handle the caller lent is returned
    /// to it. `memory` is the caller's, through which borrows inside lists
    /// are read again; `None` when those were lent through the lender chain,
    /// which has returned them already, so lists are left alone.
    Unlend { memory: Option<u32> },
}

impl Visit {
    /// Whether a value of `ty` has anything to do under this visit.
    fn applies(self, ty: &ValType) -> bool {
        match self {
            Visit::Convert {
                memory: Memory::Transfer { .. },
                ..
            } => contains_pointers(ty) || contains_handles(ty),
            Visit::Convert { .. } => contains_handles(ty),
            Visit::Unlend { .. } => contains_borrows(ty),
        }
    }

    /// The memories a value is read from and written to.
    fn memories(self) -> Option<(u32, u32)> {
        match self {
            Visit::Convert {
                memory: Memory::Transfer { src, dst, .. },
                ..
            } => Some((src, dst)),
            Visit::Convert {
                memory: Memory::InPlace(memory) | Memory::Lend { memory, .. },
                ..
            } => Some((memory, memory)),
            Visit::Convert {
                memory: Memory::Untouched,
                ..
            } => None,
            Visit::Unlend { memory } => memory.map(|memory| (memory, memory)),
        }
    }
}

/// A flat value's local and the type of that local, which inside a variant
/// payload may be wider than the value.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Slot {
    pub(crate) local: u32,
    pub(crate) ty: CoreType,
}

pub(crate) struct Emitter<'e, 'a> {
    pub(crate) env: &'e Environment<'a>,
    name: &'e str,
    pub(crate) code: Vec<Instruction<'static>>,
    param_count: u32,
    locals: Vec<WasmType>,
    scratch: Scratch,
    tmp_ptr: u32,
    tmp_len: u32,
    tmp_dst: u32,
    /// The open scope's index and entry address locals: an adapter's own
    /// scope, or the callee's task for an async call.
    pub(crate) scope: Option<(u32, u32)>,
    /// For an async call, the local holding its subtask, which records
    /// every borrow the caller lends until the call resolves.
    pub(crate) lend_to: Option<u32>,
}

impl<'e, 'a> Emitter<'e, 'a> {
    pub(crate) fn new(env: &'e Environment<'a>, name: &'e str, param_count: u32) -> Self {
        let mut emitter = Emitter {
            env,
            name,
            code: Vec::new(),
            param_count,
            locals: Vec::new(),
            scratch: Scratch {
                handle: 0,
                address: 0,
                rep: 0,
            },
            tmp_ptr: 0,
            tmp_len: 0,
            tmp_dst: 0,
            scope: None,
            lend_to: None,
        };
        emitter.tmp_ptr = emitter.local(WasmType::I32);
        emitter.tmp_len = emitter.local(WasmType::I32);
        emitter.tmp_dst = emitter.local(WasmType::I32);
        emitter.scratch = Scratch {
            handle: emitter.local(WasmType::I32),
            address: emitter.local(WasmType::I32),
            rep: emitter.local(WasmType::I32),
        };
        emitter
    }

    pub(crate) fn local(&mut self, ty: WasmType) -> u32 {
        self.locals.push(ty);
        self.param_count + self.locals.len() as u32 - 1
    }

    pub(crate) fn emit(&mut self, instruction: Instruction<'static>) {
        self.code.push(instruction);
    }

    pub(crate) fn get(&mut self, local: u32) {
        self.emit(Instruction::LocalGet(local));
    }

    pub(crate) fn set(&mut self, local: u32) {
        self.emit(Instruction::LocalSet(local));
    }

    fn runtime(&self) -> &'a AsyncRuntime {
        self.env
            .runtime
            .expect("streams, futures and threads only occur in a link with the async runtime")
    }

    pub(crate) fn call_runtime(&mut self, name: &str) {
        let index = self.runtime().func(name);
        self.emit(Instruction::Call(index));
    }

    /// Saves the current thread into fresh locals, returning them for
    /// [`Self::restore_thread`].
    pub(crate) fn save_thread(&mut self) -> [u32; 4] {
        let globals = self.runtime().thread_globals();
        let mut saved = [0; 4];
        for (slot, global) in saved.iter_mut().zip(globals) {
            *slot = self.local(WasmType::I32);
            self.emit(Instruction::GlobalGet(global));
            self.set(*slot);
        }
        saved
    }

    pub(crate) fn restore_thread(&mut self, saved: [u32; 4]) {
        let globals = self.runtime().thread_globals();
        for (slot, global) in saved.into_iter().zip(globals) {
            self.get(slot);
            self.emit(Instruction::GlobalSet(global));
        }
    }

    /// Starts a fresh thread of a synchronously typed call into `frame`: no
    /// task, empty thread-local storage, and no blocking.
    pub(crate) fn fresh_sync_thread(&mut self, frame: u32) {
        let [task, ctx0, ctx1, sync_frame] = self.runtime().thread_globals();
        for global in [task, ctx0, ctx1] {
            self.emit(Instruction::I32Const(0));
            self.emit(Instruction::GlobalSet(global));
        }
        self.emit(Instruction::I32Const(frame as i32));
        self.emit(Instruction::GlobalSet(sync_frame));
    }

    pub(crate) fn memarg(memory: u32, offset: u32) -> MemArg {
        MemArg {
            offset: u64::from(offset),
            align: 2,
            memory_index: memory,
        }
    }

    pub(crate) fn load_i32(&mut self, memory: u32, offset: u32) {
        self.emit(Instruction::I32Load(Self::memarg(memory, offset)));
    }

    pub(crate) fn store_i32(&mut self, memory: u32, offset: u32) {
        self.emit(Instruction::I32Store(Self::memarg(memory, offset)));
    }

    /// Calls `realloc(0, 0, align, len)` for a fresh allocation; the length is
    /// taken from the scratch local `tmp_len`.
    pub(crate) fn allocate(&mut self, realloc: u32, align: u32) {
        self.emit(Instruction::I32Const(0));
        self.emit(Instruction::I32Const(0));
        self.emit(Instruction::I32Const(align as i32));
        self.get(self.tmp_len);
        self.emit(Instruction::Call(realloc));
    }

    /// Copies `tmp_len` bytes from `src` in `src_memory` to `dst` in
    /// `dst_memory`, both locals.
    fn copy(&mut self, dst: u32, dst_memory: u32, src: u32, src_memory: u32) {
        self.get(dst);
        self.get(src);
        self.get(self.tmp_len);
        self.emit(Instruction::MemoryCopy {
            src_mem: src_memory,
            dst_mem: dst_memory,
        });
    }

    /// Scales the element count on the stack to a byte length in `tmp_len`.
    fn byte_length(&mut self, element_size: u32) {
        if element_size != 1 {
            self.emit(Instruction::I32Const(element_size as i32));
            self.emit(Instruction::I32Mul);
        }
        self.set(self.tmp_len);
    }

    /// Copies the pointer/length pair in `tmp_ptr`/`tmp_len` from
    /// `src_memory` into a fresh allocation in `dst_memory`, leaving the new
    /// pointer in `tmp_dst`.
    fn transfer(&mut self, align: u32, realloc: u32, dst_memory: u32, src_memory: u32) {
        self.allocate(realloc, align);
        self.set(self.tmp_dst);
        self.copy(self.tmp_dst, dst_memory, self.tmp_ptr, src_memory);
    }

    pub(crate) fn ops(&mut self) -> Ops<'_> {
        let runtime = self
            .env
            .handles
            .expect("handle conversion only happens with a handle table")
            .runtime;
        Ops {
            runtime,
            code: &mut self.code,
            scratch: self.scratch,
        }
    }

    fn owner(&self, resource: u32) -> Option<u32> {
        self.env
            .handles
            .expect("handle conversion only happens with a handle table")
            .resources[resource as usize]
            .owner
    }

    /// Whether lowering the parameters lends handles into a frame that does
    /// not implement them, which the callee must give back before returning.
    pub(crate) fn needs_scope(&self, params: &ValType) -> bool {
        let Some(target) = self.env.target.frame else {
            return false;
        };
        let mut borrowed = Vec::new();
        borrowed_resources(params, &mut borrowed);
        borrowed
            .into_iter()
            .any(|resource| self.owner(resource) != Some(target))
    }

    pub(crate) fn open_scope(&mut self) {
        let scope = self.local(WasmType::I32);
        let address = self.local(WasmType::I32);
        self.ops().open_scope(scope, address);
        self.scope = Some((scope, address));
    }

    pub(crate) fn close_scope(&mut self) {
        if let Some((scope, address)) = self.scope {
            self.ops().close_scope(scope, address);
        }
    }

    /// Converts the handle on the stack between the two sides of the call.
    fn convert_handle(&mut self, resource: u32, own: bool, direction: Direction) -> Result<()> {
        let (from, to) = match direction {
            Direction::ToCallee => (self.env.caller, self.env.target),
            Direction::ToCaller => (self.env.target, self.env.caller),
        };
        if own {
            if let Some(frame) = from.frame {
                self.ops().lift_own(resource, frame);
            }
            if let Some(frame) = to.frame {
                self.ops().lower_own(resource, frame);
            }
        } else {
            if direction == Direction::ToCaller {
                bail!(
                    "adapter for `{}` returns a borrowed handle, which the canonical ABI forbids",
                    self.name
                );
            }
            if let Some(frame) = from.frame {
                self.ops().lift_borrow(resource, frame);
                if let Some(subtask) = self.lend_to {
                    self.get(subtask);
                    self.get(self.scratch.address);
                    self.call_runtime("lend");
                }
            }
            if let Some(frame) = to.frame {
                if self.owner(resource) != Some(frame) {
                    let (scope, address) = self
                        .scope
                        .expect("a scope is open while borrows are lowered");
                    self.ops().lower_borrow(resource, frame, scope, address);
                }
            }
        }
        Ok(())
    }

    /// Moves the readable end of the stream or future `ty` on the stack
    /// between the two sides of the call.
    fn convert_end(&mut self, ty: &ValType, direction: Direction) -> Result<()> {
        let (from, to) = match direction {
            Direction::ToCallee => (self.env.caller, self.env.target),
            Direction::ToCaller => (self.env.target, self.env.caller),
        };
        // The host holds its ends in a table of its own.
        let host = self.runtime().host_frame;
        let (from, to) = (from.frame.unwrap_or(host), to.frame.unwrap_or(host));
        let type_id = self.runtime().end_type(ty);
        let future = matches!(ty, ValType::Future(_));
        self.set(self.scratch.handle);
        self.emit(Instruction::I32Const(from as i32));
        self.emit(Instruction::I32Const(to as i32));
        self.get(self.scratch.handle);
        self.emit(Instruction::I32Const(type_id as i32));
        self.emit(Instruction::I32Const(future as i32));
        self.call_runtime("end.move");
        Ok(())
    }

    /// Visits the stream or future end on the stack.
    fn end_leaf(&mut self, ty: &ValType, visit: Visit) -> Result<()> {
        match visit {
            Visit::Convert { direction, .. } => self.convert_end(ty, direction),
            Visit::Unlend { .. } => unreachable!("an end is never borrowed"),
        }
    }

    /// Visits the handle on the stack.
    fn handle_leaf(&mut self, resource: u32, own: bool, visit: Visit) -> Result<()> {
        match visit {
            Visit::Convert { direction, .. } => self.convert_handle(resource, own, direction),
            Visit::Unlend { .. } => {
                let frame = self.env.caller.frame.expect("only a frame lends handles");
                self.ops().unlend(resource, frame);
                Ok(())
            }
        }
    }

    /// Reads a flat `i32` value out of its slot.
    pub(crate) fn load_slot(&mut self, slot: Slot) {
        self.get(slot.local);
        if slot.ty == CoreType::I64 {
            self.emit(Instruction::I32WrapI64);
        }
    }

    /// Writes the `i32` on the stack back into its slot.
    pub(crate) fn store_slot(&mut self, slot: Slot) {
        if slot.ty == CoreType::I64 {
            self.emit(Instruction::I64ExtendI32U);
        }
        self.set(slot.local);
    }

    /// Visits the elements of a list whose pointer and count are in
    /// `ptr`/`count`. Under a transfer, `src_ptr` locates the original
    /// elements.
    fn for_each_element(
        &mut self,
        element: &ValType,
        dst_ptr: u32,
        src_ptr: u32,
        count: u32,
        visit: Visit,
    ) -> Result<()> {
        let stride = size(element);
        if stride == 0 {
            return Ok(());
        }
        let dst_cursor = self.local(WasmType::I32);
        let src_cursor = self.local(WasmType::I32);
        let end = self.local(WasmType::I32);
        self.get(dst_ptr);
        self.set(dst_cursor);
        self.get(src_ptr);
        self.set(src_cursor);
        self.get(count);
        self.emit(Instruction::I32Const(stride as i32));
        self.emit(Instruction::I32Mul);
        self.get(dst_ptr);
        self.emit(Instruction::I32Add);
        self.set(end);
        self.emit(Instruction::Block(BlockType::Empty));
        self.emit(Instruction::Loop(BlockType::Empty));
        self.get(dst_cursor);
        self.get(end);
        self.emit(Instruction::I32GeU);
        self.emit(Instruction::BrIf(1));
        self.walk_memory(element, dst_cursor, src_cursor, 0, visit)?;
        for cursor in [dst_cursor, src_cursor] {
            self.get(cursor);
            self.emit(Instruction::I32Const(stride as i32));
            self.emit(Instruction::I32Add);
            self.set(cursor);
        }
        self.emit(Instruction::Br(0));
        self.emit(Instruction::End);
        self.emit(Instruction::End);
        Ok(())
    }

    /// Visits a string or list whose pointer and count are in
    /// `tmp_ptr`/`count`, copying it when the visit transfers.
    fn sequence(
        &mut self,
        element: &ValType,
        count: u32,
        visit: Visit,
        store_pointer: impl FnOnce(&mut Self),
    ) -> Result<()> {
        match visit {
            Visit::Convert {
                memory: Memory::Transfer { src, dst, realloc },
                ..
            } => {
                self.get(count);
                self.byte_length(size(element));
                self.transfer(alignment(element), realloc, dst, src);
                store_pointer(self);
                if visit.applies(element) {
                    self.for_each_element(element, self.tmp_dst, self.tmp_ptr, count, visit)?;
                }
            }
            Visit::Convert {
                memory: Memory::Untouched,
                ..
            } => {
                if visit.applies(element) {
                    bail!(
                        "adapter for `{}` reached a list of resource handles without a \
                         memory to convert them in",
                        self.name
                    );
                }
            }
            Visit::Convert {
                memory: Memory::InPlace(_) | Memory::Lend { .. },
                ..
            }
            | Visit::Unlend { memory: Some(_) } => {
                if visit.applies(element) {
                    self.for_each_element(element, self.tmp_ptr, self.tmp_ptr, count, visit)?;
                }
            }
            // The borrows inside were pushed on the lender chain as they
            // were lifted, and walking the chain has returned them.
            Visit::Unlend { memory: None } => {}
        }
        Ok(())
    }

    /// Visits a flat value held in `slots`.
    pub(crate) fn walk_flat(&mut self, ty: &ValType, slots: &[Slot], visit: Visit) -> Result<()> {
        if !visit.applies(ty) {
            return Ok(());
        }
        match ty {
            ValType::Own(resource) | ValType::Borrow(resource) => {
                let own = matches!(ty, ValType::Own(_));
                self.load_slot(slots[0]);
                self.handle_leaf(resource.id, own, visit)?;
                if matches!(visit, Visit::Convert { .. }) {
                    self.store_slot(slots[0]);
                }
            }
            ValType::Stream(_) | ValType::Future(_) => {
                self.load_slot(slots[0]);
                self.end_leaf(ty, visit)?;
                self.store_slot(slots[0]);
            }
            ValType::String | ValType::List(_) => {
                let element = match ty {
                    ValType::List(element) => element.as_ref(),
                    _ => &ValType::U8,
                };
                let (pointer, length) = (slots[0], slots[1]);
                self.load_slot(pointer);
                self.set(self.tmp_ptr);
                let count = self.local(WasmType::I32);
                self.load_slot(length);
                self.set(count);
                self.sequence(element, count, visit, |emitter| {
                    emitter.get(emitter.tmp_dst);
                    emitter.store_slot(pointer);
                })?;
            }
            _ => {
                if let Some(fields) = record_fields(ty) {
                    let mut next = 0;
                    for field in fields {
                        let width = flat_types(field).len();
                        self.walk_flat(field, &slots[next..next + width], visit)?;
                        next += width;
                    }
                } else if let Some(cases) = variant_cases(ty) {
                    let discriminant = slots[0];
                    for (index, payload) in cases.into_iter().enumerate() {
                        let Some(payload) = payload else {
                            continue;
                        };
                        if !visit.applies(payload) {
                            continue;
                        }
                        let width = flat_types(payload).len();
                        self.get(discriminant.local);
                        self.emit(Instruction::I32Const(index as i32));
                        self.emit(Instruction::I32Eq);
                        self.emit(Instruction::If(BlockType::Empty));
                        self.walk_flat(payload, &slots[1..1 + width], visit)?;
                        self.emit(Instruction::End);
                    }
                }
            }
        }
        Ok(())
    }

    /// Visits a value in memory at `offset` from the address in `dst_base`,
    /// reading it from the same offset from `src_base`; under a transfer
    /// those are the copy and the original, otherwise the same place.
    pub(crate) fn walk_memory(
        &mut self,
        ty: &ValType,
        dst_base: u32,
        src_base: u32,
        offset: u32,
        visit: Visit,
    ) -> Result<()> {
        if !visit.applies(ty) {
            return Ok(());
        }
        let (load, store) = visit
            .memories()
            .expect("a value in memory is only visited through a memory");
        match ty {
            ValType::Own(resource) | ValType::Borrow(resource) => {
                let own = matches!(ty, ValType::Own(_));
                let converting = matches!(visit, Visit::Convert { .. });
                if converting {
                    self.get(dst_base);
                }
                self.get(src_base);
                self.load_i32(load, offset);
                self.handle_leaf(resource.id, own, visit)?;
                if converting {
                    self.store_i32(store, offset);
                }
                if let Visit::Convert {
                    memory: Memory::Lend { head, .. },
                    ..
                } = visit
                {
                    if !own {
                        self.ops().push_lender(head, dst_base, offset);
                    }
                }
            }
            ValType::Stream(_) | ValType::Future(_) => {
                self.get(dst_base);
                self.get(src_base);
                self.load_i32(load, offset);
                self.end_leaf(ty, visit)?;
                self.store_i32(store, offset);
            }
            ValType::String | ValType::List(_) => {
                let element = match ty {
                    ValType::List(element) => element.as_ref(),
                    _ => &ValType::U8,
                };
                self.get(src_base);
                self.load_i32(load, offset);
                self.set(self.tmp_ptr);
                let count = self.local(WasmType::I32);
                self.get(src_base);
                self.load_i32(load, offset + 4);
                self.set(count);
                self.sequence(element, count, visit, |emitter| {
                    emitter.get(dst_base);
                    emitter.get(emitter.tmp_dst);
                    emitter.store_i32(store, offset);
                })?;
            }
            _ => {
                if let Some(fields) = record_fields(ty) {
                    let mut field_offset = offset;
                    for field in fields {
                        field_offset = align_to(field_offset, alignment(field));
                        self.walk_memory(field, dst_base, src_base, field_offset, visit)?;
                        field_offset += size(field);
                    }
                } else if let Some(cases) = variant_cases(ty) {
                    let discriminant = discriminant_size(cases.len());
                    let payload_align = cases
                        .iter()
                        .flatten()
                        .map(|case| alignment(case))
                        .max()
                        .unwrap_or(1);
                    let payload_offset = offset + align_to(discriminant, payload_align);
                    for (index, payload) in cases.into_iter().enumerate() {
                        let Some(payload) = payload else {
                            continue;
                        };
                        if !visit.applies(payload) {
                            continue;
                        }
                        self.get(src_base);
                        let mut memarg = Self::memarg(load, offset);
                        memarg.align = discriminant.trailing_zeros();
                        self.emit(match discriminant {
                            1 => Instruction::I32Load8U(memarg),
                            2 => Instruction::I32Load16U(memarg),
                            _ => Instruction::I32Load(memarg),
                        });
                        self.emit(Instruction::I32Const(index as i32));
                        self.emit(Instruction::I32Eq);
                        self.emit(Instruction::If(BlockType::Empty));
                        self.walk_memory(payload, dst_base, src_base, payload_offset, visit)?;
                        self.emit(Instruction::End);
                    }
                }
            }
        }
        Ok(())
    }

    /// Copies `layout.size` bytes from `src` in `src_memory` to `dst` in
    /// `dst_memory`, both locals, then converts what the copy holds.
    pub(crate) fn copy_value(
        &mut self,
        ty: &ValType,
        layout: &Layout,
        dst: u32,
        src: u32,
        visit: Visit,
    ) -> Result<()> {
        let (src_memory, dst_memory) = visit.memories().expect("a copy happens through memories");
        self.emit(Instruction::I32Const(layout.size as i32));
        self.set(self.tmp_len);
        self.copy(dst, dst_memory, src, src_memory);
        self.walk_memory(ty, dst, src, 0, visit)
    }

    /// Loads the flat values of `ty` from `offset` past the address in
    /// `base`, as `lower_flat` of the value `load` reads would produce them,
    /// into fresh locals.
    pub(crate) fn load_flat(
        &mut self,
        ty: &ValType,
        base: u32,
        offset: u32,
        memory: u32,
    ) -> Vec<Slot> {
        let mut slots = Vec::new();
        self.load_flat_into(ty, base, offset, memory, &mut slots);
        slots
    }

    fn scalar_memarg(memory: u32, offset: u32, bytes: u32) -> MemArg {
        MemArg {
            offset: u64::from(offset),
            align: bytes.trailing_zeros(),
            memory_index: memory,
        }
    }

    fn load_flat_into(
        &mut self,
        ty: &ValType,
        base: u32,
        offset: u32,
        memory: u32,
        slots: &mut Vec<Slot>,
    ) {
        let mut scalar = |emitter: &mut Self, load: Instruction<'static>, ty: CoreType| {
            let local = emitter.local(ty.encode());
            emitter.get(base);
            emitter.emit(load);
            emitter.set(local);
            slots.push(Slot { local, ty });
        };
        let arg = |bytes| Self::scalar_memarg(memory, offset, bytes);
        match ty {
            ValType::Bool | ValType::U8 => {
                scalar(self, Instruction::I32Load8U(arg(1)), CoreType::I32)
            }
            ValType::S8 => scalar(self, Instruction::I32Load8S(arg(1)), CoreType::I32),
            ValType::U16 => scalar(self, Instruction::I32Load16U(arg(2)), CoreType::I32),
            ValType::S16 => scalar(self, Instruction::I32Load16S(arg(2)), CoreType::I32),
            ValType::S32
            | ValType::U32
            | ValType::Char
            | ValType::Own(_)
            | ValType::Borrow(_)
            | ValType::Stream(_)
            | ValType::Future(_) => scalar(self, Instruction::I32Load(arg(4)), CoreType::I32),
            ValType::S64 | ValType::U64 => {
                scalar(self, Instruction::I64Load(arg(8)), CoreType::I64)
            }
            ValType::F32 => scalar(self, Instruction::F32Load(arg(4)), CoreType::F32),
            ValType::F64 => scalar(self, Instruction::F64Load(arg(8)), CoreType::F64),
            ValType::Flags(_) => {
                let load = match size(ty) {
                    1 => Instruction::I32Load8U(arg(1)),
                    2 => Instruction::I32Load16U(arg(2)),
                    _ => Instruction::I32Load(arg(4)),
                };
                scalar(self, load, CoreType::I32)
            }
            ValType::String | ValType::List(_) => {
                scalar(self, Instruction::I32Load(arg(4)), CoreType::I32);
                let length = Self::scalar_memarg(memory, offset + 4, 4);
                scalar(self, Instruction::I32Load(length), CoreType::I32);
            }
            _ => {
                if let Some(fields) = record_fields(ty) {
                    let mut field_offset = offset;
                    for field in fields {
                        field_offset = align_to(field_offset, alignment(field));
                        self.load_flat_into(field, base, field_offset, memory, slots);
                        field_offset += size(field);
                    }
                    return;
                }
                let cases = variant_cases(ty).expect("every type is scalar, record or variant");
                let discriminant = discriminant_size(cases.len());
                let load = match discriminant {
                    1 => Instruction::I32Load8U(arg(1)),
                    2 => Instruction::I32Load16U(arg(2)),
                    _ => Instruction::I32Load(arg(4)),
                };
                let case = self.local(WasmType::I32);
                self.get(base);
                self.emit(load);
                self.set(case);
                slots.push(Slot {
                    local: case,
                    ty: CoreType::I32,
                });
                let joined = &flat_types(ty)[1..];
                // The joined values a case does not fill are zero, and the
                // locals may hold an earlier element's.
                let payload: Vec<Slot> = joined
                    .iter()
                    .map(|ty| {
                        let local = self.local(ty.encode());
                        self.emit(match ty {
                            CoreType::I32 => Instruction::I32Const(0),
                            CoreType::I64 => Instruction::I64Const(0),
                            CoreType::F32 => Instruction::F32Const(0.0f32.into()),
                            CoreType::F64 => Instruction::F64Const(0.0f64.into()),
                        });
                        self.set(local);
                        Slot { local, ty: *ty }
                    })
                    .collect();
                let payload_offset = offset + align_to(discriminant, variant_payload_align(ty));
                for (index, case_ty) in cases.into_iter().enumerate() {
                    let Some(case_ty) = case_ty else { continue };
                    if flat_types(case_ty).is_empty() {
                        continue;
                    }
                    self.get(case);
                    self.emit(Instruction::I32Const(index as i32));
                    self.emit(Instruction::I32Eq);
                    self.emit(Instruction::If(BlockType::Empty));
                    let values = self.load_flat(case_ty, base, payload_offset, memory);
                    for (value, slot) in values.iter().zip(&payload) {
                        self.get(value.local);
                        coerce_to_joined(&mut self.code, value.ty, slot.ty);
                        self.set(slot.local);
                    }
                    self.emit(Instruction::End);
                }
                slots.extend(payload);
            }
        }
    }

    /// Stores the flat values of `ty` held in `slots` at `offset` past the
    /// address in `base`, as `store` of the value `lift_flat` would read.
    pub(crate) fn store_flat(
        &mut self,
        ty: &ValType,
        slots: &[Slot],
        base: u32,
        offset: u32,
        memory: u32,
    ) {
        let arg = |bytes| Self::scalar_memarg(memory, offset, bytes);
        let scalar = |emitter: &mut Self, store: Instruction<'static>| {
            emitter.get(base);
            emitter.get(slots[0].local);
            emitter.emit(store);
        };
        match ty {
            ValType::Bool | ValType::U8 | ValType::S8 => {
                scalar(self, Instruction::I32Store8(arg(1)))
            }
            ValType::U16 | ValType::S16 => scalar(self, Instruction::I32Store16(arg(2))),
            ValType::S32
            | ValType::U32
            | ValType::Char
            | ValType::Own(_)
            | ValType::Borrow(_)
            | ValType::Stream(_)
            | ValType::Future(_) => scalar(self, Instruction::I32Store(arg(4))),
            ValType::S64 | ValType::U64 => scalar(self, Instruction::I64Store(arg(8))),
            ValType::F32 => scalar(self, Instruction::F32Store(arg(4))),
            ValType::F64 => scalar(self, Instruction::F64Store(arg(8))),
            ValType::Flags(_) => {
                let store = match size(ty) {
                    1 => Instruction::I32Store8(arg(1)),
                    2 => Instruction::I32Store16(arg(2)),
                    _ => Instruction::I32Store(arg(4)),
                };
                scalar(self, store)
            }
            ValType::String | ValType::List(_) => {
                scalar(self, Instruction::I32Store(arg(4)));
                self.get(base);
                self.get(slots[1].local);
                self.emit(Instruction::I32Store(Self::scalar_memarg(
                    memory,
                    offset + 4,
                    4,
                )));
            }
            _ => {
                if let Some(fields) = record_fields(ty) {
                    let mut field_offset = offset;
                    let mut next = 0;
                    for field in fields {
                        field_offset = align_to(field_offset, alignment(field));
                        let width = flat_types(field).len();
                        self.store_flat(
                            field,
                            &slots[next..next + width],
                            base,
                            field_offset,
                            memory,
                        );
                        next += width;
                        field_offset += size(field);
                    }
                    return;
                }
                let cases = variant_cases(ty).expect("every type is scalar, record or variant");
                let discriminant = discriminant_size(cases.len());
                let store = match discriminant {
                    1 => Instruction::I32Store8(arg(1)),
                    2 => Instruction::I32Store16(arg(2)),
                    _ => Instruction::I32Store(arg(4)),
                };
                self.get(base);
                self.get(slots[0].local);
                self.emit(store);
                let payload_offset = offset + align_to(discriminant, variant_payload_align(ty));
                for (index, case_ty) in cases.into_iter().enumerate() {
                    let Some(case_ty) = case_ty else { continue };
                    let case_flat = flat_types(case_ty);
                    if case_flat.is_empty() {
                        continue;
                    }
                    self.get(slots[0].local);
                    self.emit(Instruction::I32Const(index as i32));
                    self.emit(Instruction::I32Eq);
                    self.emit(Instruction::If(BlockType::Empty));
                    let mut values = Vec::with_capacity(case_flat.len());
                    for (want, slot) in case_flat.iter().zip(&slots[1..]) {
                        let local = self.local(want.encode());
                        self.get(slot.local);
                        coerce_from_joined(&mut self.code, slot.ty, *want);
                        self.set(local);
                        values.push(Slot { local, ty: *want });
                    }
                    self.store_flat(case_ty, &values, base, payload_offset, memory);
                    self.emit(Instruction::End);
                }
            }
        }
    }

    pub(crate) fn finish(self) -> Function {
        let mut runs: Vec<(u32, WasmType)> = Vec::new();
        for ty in self.locals {
            match runs.last_mut() {
                Some((count, last)) if *last == ty => *count += 1,
                _ => runs.push((1, ty)),
            }
        }
        let mut body = Function::new(runs);
        for instruction in &self.code {
            body.instruction(instruction);
        }
        body.instruction(&Instruction::End);
        body
    }
}

/// The alignment of a variant's payload, where its cases' values start.
fn variant_payload_align(ty: &ValType) -> u32 {
    variant_cases(ty)
        .expect("a variant-like type")
        .into_iter()
        .flatten()
        .map(alignment)
        .max()
        .unwrap_or(1)
}

/// Widens a case's flat value to its variant's joined flat type, as
/// `lower_flat_variant` does.
fn coerce_to_joined(code: &mut Vec<Instruction<'static>>, have: CoreType, want: CoreType) {
    match (have, want) {
        (CoreType::F32, CoreType::I32) => code.push(Instruction::I32ReinterpretF32),
        (CoreType::I32, CoreType::I64) => code.push(Instruction::I64ExtendI32U),
        (CoreType::F32, CoreType::I64) => {
            code.push(Instruction::I32ReinterpretF32);
            code.push(Instruction::I64ExtendI32U);
        }
        (CoreType::F64, CoreType::I64) => code.push(Instruction::I64ReinterpretF64),
        (have, want) => assert_eq!(have, want, "flat types only widen"),
    }
}

/// Narrows a variant's joined flat value to its case's type, as
/// `lift_flat_variant` does.
fn coerce_from_joined(code: &mut Vec<Instruction<'static>>, have: CoreType, want: CoreType) {
    match (have, want) {
        (CoreType::I32, CoreType::F32) => code.push(Instruction::F32ReinterpretI32),
        (CoreType::I64, CoreType::I32) => code.push(Instruction::I32WrapI64),
        (CoreType::I64, CoreType::F32) => {
            code.push(Instruction::I32WrapI64);
            code.push(Instruction::F32ReinterpretI32);
        }
        (CoreType::I64, CoreType::F64) => code.push(Instruction::F64ReinterpretI64),
        (have, want) => assert_eq!(have, want, "flat types only narrow"),
    }
}

fn borrowed_resources(ty: &ValType, out: &mut Vec<u32>) {
    match ty {
        ValType::Borrow(resource) => out.push(resource.id),
        ValType::List(element) => borrowed_resources(element, out),
        _ => {
            if let Some(fields) = record_fields(ty) {
                for field in fields {
                    borrowed_resources(field, out);
                }
            } else if let Some(cases) = variant_cases(ty) {
                for case in cases.into_iter().flatten() {
                    borrowed_resources(case, out);
                }
            }
        }
    }
}

pub(crate) fn require(value: Option<u32>, what: &str, name: &str) -> Result<u32> {
    value.ok_or_else(|| {
        anyhow::anyhow!(
            "adapter for `{name}` needs {what}, which its canonical options do not name"
        )
    })
}

/// Generates the adapter for `ty` in `env`.
pub fn emit(name: &str, ty: &FuncType, env: &Environment) -> Result<Emitted> {
    let boundary = env.boundary;
    if boundary == Boundary::Fused
        && (env.caller.encoding != StringEncoding::Utf8
            || env.target.encoding != StringEncoding::Utf8)
    {
        bail!("adapter for `{name}` would transcode strings; only utf8 on both sides is supported");
    }

    let params_ty = params_record(&ty.params);
    let params = layout(&params_ty);
    let result = ty.result.as_ref().map(layout);
    let spill_params = params.flat.len() > MAX_FLAT_PARAMS;
    let spill_results = result
        .as_ref()
        .is_some_and(|result| result.flat.len() > MAX_FLAT_RESULTS);
    let result_handles = result.as_ref().is_some_and(|result| result.handles);
    let result_handles_in_memory = ty.result.as_ref().is_some_and(|result| {
        (spill_results && result_handles) || contains_handles_in_memory(result)
    });
    let params_handles_in_memory =
        (spill_params && params.handles) || contains_handles_in_memory(&params_ty);

    if (params.handles || result_handles) && env.handles.is_none() {
        bail!("adapter for `{name}` moves resource handles, but the link has no handle table");
    }

    let mut adapter_params = if spill_params {
        vec![CoreType::I32]
    } else {
        params.flat.clone()
    };
    let retptr = if spill_results && boundary != Boundary::Export {
        adapter_params.push(CoreType::I32);
        Some(adapter_params.len() as u32 - 1)
    } else {
        None
    };
    let adapter_results = if spill_results {
        if boundary == Boundary::Export {
            vec![CoreType::I32]
        } else {
            Vec::new()
        }
    } else {
        result
            .as_ref()
            .map(|result| result.flat.clone())
            .unwrap_or_default()
    };

    let params_need_memory = spill_params || params.pointers;
    let results_need_memory = spill_results || result.as_ref().is_some_and(Layout::needs_memory);
    let (callee_memory, caller_memory, callee_realloc, caller_realloc) = match boundary {
        Boundary::Fused => (
            (params_need_memory || results_need_memory)
                .then(|| require(env.target.memory, "the callee's memory", name))
                .transpose()?,
            (params_need_memory || results_need_memory)
                .then(|| require(env.caller.memory, "the caller's memory", name))
                .transpose()?,
            params_need_memory
                .then(|| require(env.target.realloc, "the callee's realloc", name))
                .transpose()?,
            result
                .as_ref()
                .is_some_and(Layout::needs_memory)
                .then(|| require(env.caller.realloc, "the caller's realloc", name))
                .transpose()?,
        ),
        Boundary::Import => (
            None,
            (params_handles_in_memory || result_handles_in_memory)
                .then(|| require(env.caller.memory, "the caller's memory", name))
                .transpose()?,
            None,
            None,
        ),
        Boundary::Export => (
            (params_handles_in_memory || result_handles_in_memory)
                .then(|| require(env.target.memory, "the callee's memory", name))
                .transpose()?,
            None,
            None,
            None,
        ),
    };

    let mut emitter = Emitter::new(env, name, adapter_params.len() as u32);
    if emitter.needs_scope(&params_ty) {
        emitter.open_scope();
    }

    let lower = |memory: Memory| Visit::Convert {
        direction: Direction::ToCallee,
        memory,
    };
    let lift = |memory: Memory| Visit::Convert {
        direction: Direction::ToCaller,
        memory,
    };
    let src = emitter.local(WasmType::I32);
    let area = emitter.local(WasmType::I32);
    let ret = emitter.local(WasmType::I32);
    // The lender chain of a host import with handles in memory; a local
    // starts at zero, which is the empty chain.
    let lenders = (boundary == Boundary::Import && params_handles_in_memory)
        .then(|| emitter.local(WasmType::I32));

    match (boundary, spill_params) {
        (Boundary::Fused, true) => {
            let (callee_mem, caller_mem, realloc) = (
                callee_memory.unwrap(),
                caller_memory.unwrap(),
                callee_realloc.unwrap(),
            );
            emitter.get(0);
            emitter.set(src);
            emitter.emit(Instruction::I32Const(params.size as i32));
            emitter.set(emitter.tmp_len);
            emitter.allocate(realloc, params.align);
            emitter.set(area);
            emitter.copy_value(
                &params_ty,
                &params,
                area,
                src,
                lower(Memory::Transfer {
                    src: caller_mem,
                    dst: callee_mem,
                    realloc,
                }),
            )?;
            emitter.get(area);
        }
        (Boundary::Import, true) => {
            if let Some(head) = lenders {
                let memory = caller_memory.unwrap();
                emitter.walk_memory(&params_ty, 0, 0, 0, lower(Memory::Lend { memory, head }))?;
            }
            emitter.get(0);
        }
        (Boundary::Export, true) => {
            if params.handles {
                let callee_mem = callee_memory.unwrap();
                emitter.walk_memory(&params_ty, 0, 0, 0, lower(Memory::InPlace(callee_mem)))?;
            }
            emitter.get(0);
        }
        (_, false) => {
            let memory = match boundary {
                Boundary::Fused if params.pointers => Memory::Transfer {
                    src: caller_memory.unwrap(),
                    dst: callee_memory.unwrap(),
                    realloc: callee_realloc.unwrap(),
                },
                Boundary::Export if params_handles_in_memory => {
                    Memory::InPlace(callee_memory.unwrap())
                }
                // Flat handles are converted into fresh locals and returned
                // from the originals; the borrows inside lists go through
                // the lender chain.
                Boundary::Import if params_handles_in_memory => Memory::Lend {
                    memory: caller_memory.unwrap(),
                    head: lenders.unwrap(),
                },
                _ => Memory::Untouched,
            };
            let mut args = Vec::with_capacity(params.flat.len());
            for (index, ty) in params.flat.iter().enumerate() {
                let local = emitter.local(ty.encode());
                emitter.get(index as u32);
                emitter.set(local);
                args.push(Slot { local, ty: *ty });
            }
            emitter.walk_flat(&params_ty, &args, lower(memory))?;
            for arg in &args {
                emitter.get(arg.local);
            }
        }
    }
    // The host implements the lowered signature, which takes the return
    // area; a lifted function returns a pointer to its own instead.
    if boundary == Boundary::Import {
        if let Some(retptr) = retptr {
            emitter.get(retptr);
        }
    }

    let thread = env.context.map(|frame| {
        let saved = emitter.save_thread();
        emitter.fresh_sync_thread(frame);
        saved
    });
    let task = env.task.map(|frame| {
        let saved = emitter.save_thread();
        let task = emitter.local(WasmType::I32);
        emitter.emit(Instruction::I32Const(frame as i32));
        for _ in 0..3 {
            emitter.emit(Instruction::I32Const(0));
        }
        // Called by the host.
        emitter.emit(Instruction::I32Const(4));
        for _ in 0..2 {
            emitter.emit(Instruction::I32Const(0));
        }
        emitter.call_runtime("task.new");
        emitter.set(task);
        emitter.get(task);
        emitter.call_runtime("task.try-enter");
        emitter.emit(Instruction::I32Eqz);
        emitter.emit(Instruction::If(BlockType::Empty));
        emitter.get(task);
        emitter.call_runtime("task.wait-enter");
        emitter.emit(Instruction::End);
        emitter.get(task);
        emitter.call_runtime("task.start");
        emitter.get(task);
        emitter.call_runtime("task.enter");
        (task, saved)
    });
    emitter.emit(Instruction::Call(env.callee));
    if let Some(saved) = thread {
        emitter.restore_thread(saved);
    }
    if let Some((task, saved)) = task {
        emitter.get(task);
        emitter.call_runtime("task.leave");
        emitter.restore_thread(saved);
    }

    // The result of the call, when it is a flat value or a pointer the
    // adapter must give back after its bookkeeping.
    let mut saved = None;
    let result_ty = ty.result.as_ref();
    match (boundary, spill_results) {
        (Boundary::Fused, true) => {
            let result_ty = result_ty.expect("spilled results come from a result");
            let result = result.as_ref().expect("spilled results come from a result");
            let (callee_mem, caller_mem) = (callee_memory.unwrap(), caller_memory.unwrap());
            emitter.set(ret);
            emitter.get(retptr.unwrap());
            emitter.set(area);
            // A result without pointers needs no realloc; any index will do
            // for the unused argument.
            let realloc = caller_realloc.unwrap_or(0);
            emitter.copy_value(
                result_ty,
                result,
                area,
                ret,
                lift(Memory::Transfer {
                    src: callee_mem,
                    dst: caller_mem,
                    realloc,
                }),
            )?;
            if let Some(post_return) = env.post_return {
                emitter.get(ret);
                emitter.emit(Instruction::Call(post_return));
            }
        }
        (Boundary::Import, true) => {
            if result_handles {
                let result_ty = result_ty.expect("spilled results come from a result");
                let caller_mem = caller_memory.unwrap();
                let retptr = retptr.unwrap();
                emitter.walk_memory(
                    result_ty,
                    retptr,
                    retptr,
                    0,
                    lift(Memory::InPlace(caller_mem)),
                )?;
            }
        }
        (Boundary::Export, true) => {
            emitter.set(ret);
            if result_handles {
                let result_ty = result_ty.expect("spilled results come from a result");
                let callee_mem = callee_memory.unwrap();
                emitter.walk_memory(result_ty, ret, ret, 0, lift(Memory::InPlace(callee_mem)))?;
            }
            saved = Some(ret);
        }
        (_, false) => {
            if let (Some(result_ty), Some(result)) = (result_ty, result.as_ref()) {
                if result.flat.is_empty() {
                    // An empty record returns nothing.
                } else if result.needs_memory() {
                    // A single flat result can only be a pointer-free scalar;
                    // anything with memory has two flat values and spills.
                    // Keep the invariant visible rather than silently
                    // trusting it.
                    bail!(
                        "adapter for `{name}` has a memory-bearing result of {} flat values",
                        result.flat.len()
                    );
                } else {
                    let local = emitter.local(result.flat[0].encode());
                    emitter.set(local);
                    if result.handles {
                        let slot = Slot {
                            local,
                            ty: result.flat[0],
                        };
                        emitter.walk_flat(result_ty, &[slot], lift(Memory::Untouched))?;
                    }
                    saved = Some(local);
                }
            }
            if let Some(post_return) = env.post_return {
                emitter.emit(Instruction::Call(post_return));
            }
        }
    }

    if let Some(head) = lenders {
        emitter.ops().return_lenders(head, caller_memory.unwrap());
    }
    // The host lends nothing. A fused call reads the caller's untouched
    // originals again, in memory or in the incoming locals. A host import
    // lent every borrow in memory through the chain, walked above, so only
    // its flat locals are left; passing the memory here would read the
    // restored words and return them twice.
    let unlend = match boundary {
        Boundary::Export => None,
        Boundary::Fused => Some(Visit::Unlend {
            memory: caller_memory,
        }),
        Boundary::Import if spill_params => None,
        Boundary::Import => Some(Visit::Unlend { memory: None }),
    };
    if let Some(unlend) = unlend.filter(|_| contains_borrows(&params_ty)) {
        if spill_params {
            emitter.walk_memory(&params_ty, 0, 0, 0, unlend)?;
        } else {
            let slots: Vec<Slot> = params
                .flat
                .iter()
                .enumerate()
                .map(|(index, ty)| Slot {
                    local: index as u32,
                    ty: *ty,
                })
                .collect();
            emitter.walk_flat(&params_ty, &slots, unlend)?;
        }
    }
    emitter.close_scope();
    if let Some((task, _)) = task {
        emitter.get(task);
        emitter.call_runtime("task.resolve");
        emitter.get(task);
        emitter.call_runtime("task.exit");
    }
    if let Some(saved) = saved {
        emitter.get(saved);
    }

    Ok(Emitted {
        params: adapter_params,
        results: adapter_results,
        body: emitter.finish(),
    })
}
