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

use anyhow::{Result, bail};
use wasm_encoder::{BlockType, Function, Instruction, MemArg, ValType as WasmType};

use crate::component::StringEncoding;
use crate::handles::{Ops, Runtime, Scratch};
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
enum Direction {
    /// Parameters: from the caller into the callee.
    ToCallee,
    /// Results: from the callee back to the caller.
    ToCaller,
}

#[derive(Clone, Copy, Debug)]
enum Memory {
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
enum Visit {
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
struct Slot {
    local: u32,
    ty: CoreType,
}

struct Emitter<'e, 'a> {
    env: &'e Environment<'a>,
    name: &'e str,
    code: Vec<Instruction<'static>>,
    param_count: u32,
    locals: Vec<WasmType>,
    scratch: Scratch,
    tmp_ptr: u32,
    tmp_len: u32,
    tmp_dst: u32,
    /// The open scope's index and entry address locals.
    scope: Option<(u32, u32)>,
}

impl<'e, 'a> Emitter<'e, 'a> {
    fn new(env: &'e Environment<'a>, name: &'e str, param_count: u32) -> Self {
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

    fn local(&mut self, ty: WasmType) -> u32 {
        self.locals.push(ty);
        self.param_count + self.locals.len() as u32 - 1
    }

    fn emit(&mut self, instruction: Instruction<'static>) {
        self.code.push(instruction);
    }

    fn get(&mut self, local: u32) {
        self.emit(Instruction::LocalGet(local));
    }

    fn set(&mut self, local: u32) {
        self.emit(Instruction::LocalSet(local));
    }

    fn memarg(memory: u32, offset: u32) -> MemArg {
        MemArg {
            offset: u64::from(offset),
            align: 2,
            memory_index: memory,
        }
    }

    fn load_i32(&mut self, memory: u32, offset: u32) {
        self.emit(Instruction::I32Load(Self::memarg(memory, offset)));
    }

    fn store_i32(&mut self, memory: u32, offset: u32) {
        self.emit(Instruction::I32Store(Self::memarg(memory, offset)));
    }

    /// Calls `realloc(0, 0, align, len)` for a fresh allocation; the length is
    /// taken from the scratch local `tmp_len`.
    fn allocate(&mut self, realloc: u32, align: u32) {
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

    fn ops(&mut self) -> Ops<'_> {
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
    fn needs_scope(&self, params: &ValType) -> bool {
        let Some(target) = self.env.target.frame else {
            return false;
        };
        let mut borrowed = Vec::new();
        borrowed_resources(params, &mut borrowed);
        borrowed
            .into_iter()
            .any(|resource| self.owner(resource) != Some(target))
    }

    fn open_scope(&mut self) {
        let scope = self.local(WasmType::I32);
        let address = self.local(WasmType::I32);
        self.ops().open_scope(scope, address);
        self.scope = Some((scope, address));
    }

    fn close_scope(&mut self) {
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
    fn load_slot(&mut self, slot: Slot) {
        self.get(slot.local);
        if slot.ty == CoreType::I64 {
            self.emit(Instruction::I32WrapI64);
        }
    }

    /// Writes the `i32` on the stack back into its slot.
    fn store_slot(&mut self, slot: Slot) {
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
    fn walk_flat(&mut self, ty: &ValType, slots: &[Slot], visit: Visit) -> Result<()> {
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
    fn walk_memory(
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
    fn copy_value(
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

    fn finish(self) -> Function {
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

fn require(value: Option<u32>, what: &str, name: &str) -> Result<u32> {
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

    emitter.emit(Instruction::Call(env.callee));

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
    if let Some(saved) = saved {
        emitter.get(saved);
    }

    Ok(Emitted {
        params: adapter_params,
        results: adapter_results,
        body: emitter.finish(),
    })
}
