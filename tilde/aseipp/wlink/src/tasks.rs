// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The component model's async ABI in a static link.
//!
//! The runtime itself (`runtime.wat`) keeps the canonical ABI's state:
//! tasks, subtasks, waitable sets, and stream and future ends, with the
//! scheduler that runs callback tasks and the nested waits that stand in for
//! stack switching. This module generates what differs per link around it:
//!
//! - For every call of an async function between two frames, the lowered
//!   import the caller calls, a *start* thunk that lowers the arguments into
//!   the callee and enters it (called at once, or by the scheduler once
//!   backpressure lets the call start), and for a callback lift a *resolve*
//!   thunk that `task.return` calls to hand the result to the caller.
//! - The host's edges: an async import the host implements takes the
//!   subtask it runs as its first argument and resolves it later through
//!   `wlink:async:resolve`; an async export the host calls returns a status
//!   and its result arrives through a `wlink:task-return` import.
//! - The canonical async built-ins of every frame, over the runtime.
//! - The dispatchers the runtime calls through: callbacks by lift, start
//!   and resolve thunks by site, and copies between stream buffers by the
//!   pair of built-ins that made them.

use std::collections::HashMap;

use anyhow::{Result, bail};
use wasm_encoder::{BlockType, Instruction, MemArg, ValType as WasmType};

use crate::adapter::{Direction, Emitted, Emitter, Environment, Memory, Slot, Visit, require};
use crate::component::AsyncBuiltin;
use crate::types::{
    CoreType, FuncType, MAX_FLAT_ASYNC_PARAMS, MAX_FLAT_PARAMS, ValType, alignment,
    async_lift_signature, async_lower_signature, contains_handles, contains_handles_in_memory,
    contains_pointers, flat_types, is_number_or_none, layout, lower_signature, params_record, size,
    task_return_signature,
};

/// The runtime's text.
pub const RUNTIME: &str = include_str!("runtime.wat");

/// Where the runtime landed in the output module, and the link's registries
/// of the types it compares by index.
#[derive(Debug, Default)]
pub struct AsyncRuntime {
    /// The runtime's exported functions, by name.
    pub funcs: HashMap<String, u32>,
    /// `cur_task`, `ctx0`, `ctx1` and `sync_frame`.
    pub globals: [u32; 4],
    pub handles_memory: u32,
    pub state_memory: u32,
    /// The frame whose table holds the host's stream and future ends.
    pub host_frame: u32,
    /// Every stream and future type of the link, whose index is its type.
    pub end_types: Vec<ValType>,
    /// Every result type an async function returns, likewise.
    pub result_types: Vec<Option<ValType>>,
}

impl AsyncRuntime {
    pub fn func(&self, name: &str) -> u32 {
        *self
            .funcs
            .get(name)
            .unwrap_or_else(|| panic!("the async runtime has no function `{name}`"))
    }

    pub fn thread_globals(&self) -> [u32; 4] {
        self.globals
    }

    pub fn end_type(&self, ty: &ValType) -> u32 {
        self.end_types
            .iter()
            .position(|known| known == ty)
            .unwrap_or_else(|| panic!("{ty} is not a registered stream or future type"))
            as u32
    }

    pub fn result_type(&self, ty: Option<&ValType>) -> u32 {
        self.result_types
            .iter()
            .position(|known| known.as_ref() == ty)
            .expect("every async result type is registered") as u32
    }
}

/// Registers every stream and future type `ty` names.
pub fn register_end_types(ty: &ValType, types: &mut Vec<ValType>) {
    match ty {
        ValType::Stream(element) | ValType::Future(element) => {
            if !types.contains(ty) {
                types.push(ty.clone());
            }
            if let Some(element) = element {
                register_end_types(element, types);
            }
        }
        ValType::List(element) | ValType::Option(element) => register_end_types(element, types),
        ValType::Record(fields) => {
            for (_, field) in fields {
                register_end_types(field, types);
            }
        }
        ValType::Tuple(items) => {
            for item in items {
                register_end_types(item, types);
            }
        }
        ValType::Variant(cases) => {
            for ty in cases.iter().filter_map(|(_, ty)| ty.as_ref()) {
                register_end_types(ty, types);
            }
        }
        ValType::Result { ok, err } => {
            for ty in [ok, err].into_iter().flatten() {
                register_end_types(ty, types);
            }
        }
        _ => {}
    }
}

/// The element type of a stream or future type.
pub fn end_payload(ty: &ValType) -> Option<&ValType> {
    payload(ty)
}

fn payload(ty: &ValType) -> Option<&ValType> {
    match ty {
        ValType::Stream(element) | ValType::Future(element) => element.as_deref(),
        _ => unreachable!("an end type is a stream or future"),
    }
}

/// An async call between two sides of the link, as its thunks see it.
#[derive(Clone, Copy, Debug)]
pub struct Call<'a> {
    pub name: &'a str,
    pub ty: &'a FuncType,
    /// The caller lowered the call with the async ABI; the host's calls of
    /// async exports count as async.
    pub caller_async: bool,
    /// The callee was lifted with a callback.
    pub callback: bool,
    /// The callee was lifted async without a callback: it runs to its end,
    /// returning through `task.return`, without the frame's lock.
    pub stackful: bool,
    /// The site: which start and resolve thunks the call's task uses.
    pub site: u32,
    /// The lift, which names the callback.
    pub lift: u32,
    pub result_type: u32,
    /// The lift's memory, as `task.return` must name it: its index plus
    /// one, or 0 for none.
    pub result_memory: u32,
    /// The start thunk.
    pub start: u32,
}

impl Call<'_> {
    fn task_flags(&self) -> i32 {
        if self.stackful {
            TASK_ASYNC | TASK_STACKFUL
        } else if self.callback {
            TASK_ASYNC
        } else {
            0
        }
    }

    /// The most flat parameters the caller passes before it passes a
    /// pointer to them: four for a component's async lower.
    fn caller_max_flat(&self, env: &Environment) -> usize {
        if self.caller_async && env.caller.frame.is_some() {
            MAX_FLAT_ASYNC_PARAMS
        } else {
            MAX_FLAT_PARAMS
        }
    }

    /// The core types of the arguments the caller passes, without the
    /// return area.
    pub fn caller_params(&self, env: &Environment) -> Vec<CoreType> {
        let flat = layout(&params_record(&self.ty.params)).flat;
        if flat.len() > self.caller_max_flat(env) {
            vec![CoreType::I32]
        } else {
            flat
        }
    }
}

const TASK_ASYNC: i32 = 1;
const TASK_HOST: i32 = 4;
const TASK_KEPT: i32 = 8;
const TASK_STACKFUL: i32 = 32;
const SUBTASK: i32 = -4;
const SYNC_CALL: i32 = -5;
const CALL_HOST: i32 = 4;
/// The result slot of a synchronous call's record.
const CALL_RESULT: u32 = 48;
const CALL_STATE: u32 = 4;
const TASK_SITE: u32 = 16;
const CALL_SITE: u32 = 44;
/// `wlink:async:trap` for a host that breaks the protocol.
const TRAP_HOST: i32 = 16;
/// `wlink:async:trap` for a buffer a built-in cannot use.
const TRAP_BUFFER: i32 = 17;

fn i32_const(emitter: &mut Emitter, value: i32) {
    emitter.emit(Instruction::I32Const(value));
}

fn handles_memarg(env: &Environment, offset: u32, align: u32) -> MemArg {
    MemArg {
        offset: u64::from(offset),
        align,
        memory_index: env
            .handles
            .expect("the async runtime keeps a handle table")
            .runtime
            .memory,
    }
}

fn state_memarg(runtime: &AsyncRuntime, offset: u32, align: u32) -> MemArg {
    MemArg {
        offset: u64::from(offset),
        align,
        memory_index: runtime.state_memory,
    }
}

/// Widens the value on the stack to the `i64` the runtime saves.
fn to_i64(emitter: &mut Emitter, ty: CoreType) {
    match ty {
        CoreType::I32 => emitter.emit(Instruction::I64ExtendI32U),
        CoreType::I64 => {}
        CoreType::F32 => {
            emitter.emit(Instruction::I32ReinterpretF32);
            emitter.emit(Instruction::I64ExtendI32U);
        }
        CoreType::F64 => emitter.emit(Instruction::I64ReinterpretF64),
    }
}

fn from_i64(emitter: &mut Emitter, ty: CoreType) {
    match ty {
        CoreType::I32 => emitter.emit(Instruction::I32WrapI64),
        CoreType::I64 => {}
        CoreType::F32 => {
            emitter.emit(Instruction::I32WrapI64);
            emitter.emit(Instruction::F32ReinterpretI32);
        }
        CoreType::F64 => emitter.emit(Instruction::F64ReinterpretI64),
    }
}

/// Saves the arguments in `locals` with the task in `task`, four to a
/// record, for a start the scheduler makes later.
fn save_args(emitter: &mut Emitter, task: u32, locals: &[(u32, CoreType)]) {
    let record = emitter.local(WasmType::I32);
    for chunk in locals.chunks(4) {
        emitter.get(task);
        emitter.call_runtime("args.push");
        emitter.set(record);
        for (index, (local, ty)) in chunk.iter().enumerate() {
            emitter.get(record);
            emitter.get(*local);
            to_i64(emitter, *ty);
            let arg = handles_memarg(emitter.env, 8 * index as u32, 3);
            emitter.emit(Instruction::I64Store(arg));
        }
    }
}

/// Pushes the arguments `save_args` saved with the task in `task`.
fn load_args(emitter: &mut Emitter, task: u32, types: &[CoreType]) {
    for (index, ty) in types.iter().enumerate() {
        emitter.get(task);
        i32_const(emitter, (index / 4) as i32);
        emitter.call_runtime("args.at");
        let arg = handles_memarg(emitter.env, 8 * (index % 4) as u32, 3);
        emitter.emit(Instruction::I64Load(arg));
        from_i64(emitter, *ty);
    }
}

/// The address of the runtime entry whose index is in `local`.
fn entry(emitter: &mut Emitter, local: u32) {
    emitter.get(local);
    emitter.call_runtime("addr");
}

fn lower_visit(memory: Memory) -> Visit {
    Visit::Convert {
        direction: Direction::ToCallee,
        memory,
    }
}

fn lift_visit(memory: Memory) -> Visit {
    Visit::Convert {
        direction: Direction::ToCaller,
        memory,
    }
}

/// Copies the parameters `from` names into fresh slots.
fn param_slots(emitter: &mut Emitter, flat: &[CoreType], first: u32) -> Vec<Slot> {
    flat.iter()
        .enumerate()
        .map(|(index, ty)| {
            let local = emitter.local(ty.encode());
            emitter.get(first + index as u32);
            emitter.set(local);
            Slot { local, ty: *ty }
        })
        .collect()
}

/// The import an async caller calls: starts the call's task, at once or
/// once backpressure allows, and returns its status (async) or waits for
/// its result (sync).
pub fn emit_lower(call: &Call, env: &Environment) -> Result<Emitted> {
    let ty = call.ty;
    let signature = if call.caller_async {
        async_lower_signature(ty)
    } else {
        lower_signature(ty)
    };
    let params = call.caller_params(env);
    let out = (signature.params.len() > params.len()).then_some(params.len() as u32);
    let caller_frame = env.caller.frame.expect("a component calls");
    let callee_frame = env.target.frame.expect("a component is called");
    let mut emitter = Emitter::new(env, call.name, signature.params.len() as u32);
    let subtask = emitter.local(WasmType::I32);
    let task = emitter.local(WasmType::I32);

    i32_const(
        &mut emitter,
        if call.caller_async {
            SUBTASK
        } else {
            SYNC_CALL
        },
    );
    i32_const(&mut emitter, caller_frame as i32);
    i32_const(&mut emitter, call.site as i32);
    match out {
        Some(out) => emitter.get(out),
        None => i32_const(&mut emitter, 0),
    }
    i32_const(&mut emitter, 0);
    emitter.call_runtime("call.new");
    emitter.set(subtask);

    i32_const(&mut emitter, callee_frame as i32);
    i32_const(&mut emitter, call.lift as i32);
    i32_const(&mut emitter, call.site as i32);
    emitter.get(subtask);
    i32_const(&mut emitter, call.task_flags());
    i32_const(&mut emitter, call.result_type as i32);
    i32_const(&mut emitter, call.result_memory as i32);
    emitter.call_runtime("task.new");
    emitter.set(task);

    let start = |emitter: &mut Emitter| {
        emitter.get(task);
        emitter.get(subtask);
        for index in 0..params.len() as u32 {
            emitter.get(index);
        }
        emitter.emit(Instruction::Call(call.start));
    };
    emitter.get(task);
    emitter.call_runtime("task.try-enter");
    emitter.emit(Instruction::If(BlockType::Empty));
    start(&mut emitter);
    emitter.emit(Instruction::Else);
    if call.caller_async {
        let locals: Vec<(u32, CoreType)> = params
            .iter()
            .enumerate()
            .map(|(index, ty)| (index as u32, *ty))
            .collect();
        save_args(&mut emitter, task, &locals);
        emitter.get(task);
        emitter.call_runtime("task.defer");
    } else {
        emitter.get(task);
        emitter.call_runtime("task.wait-enter");
        start(&mut emitter);
    }
    emitter.emit(Instruction::End);

    if call.caller_async {
        emitter.get(subtask);
        emitter.call_runtime("call.status");
    } else {
        emitter.get(subtask);
        emitter.call_runtime("call.wait");
        let result = signature.results.first().copied();
        let saved = result.map(|ty| {
            let local = emitter.local(ty.encode());
            entry(&mut emitter, subtask);
            let arg = handles_memarg(emitter.env, CALL_RESULT, 3);
            emitter.emit(Instruction::I64Load(arg));
            from_i64(&mut emitter, ty);
            emitter.set(local);
            local
        });
        emitter.get(subtask);
        emitter.call_runtime("call.free");
        if let Some(saved) = saved {
            emitter.get(saved);
        }
    }
    Ok(Emitted {
        params: signature.params,
        results: signature.results,
        body: emitter.finish(),
    })
}

/// Stores the flat value in `local` as the result of a synchronous call.
fn store_call_result(emitter: &mut Emitter, subtask: u32, slot: Slot) {
    entry(emitter, subtask);
    emitter.get(slot.local);
    to_i64(emitter, slot.ty);
    let arg = handles_memarg(emitter.env, CALL_RESULT, 3);
    emitter.emit(Instruction::I64Store(arg));
}

/// The memories and allocator a result moves through, callee to caller.
fn result_transfer(call: &Call, env: &Environment, pointers: bool) -> Result<Memory> {
    let dst = require(env.caller.memory, "the caller's memory", call.name)?;
    if !pointers {
        return Ok(Memory::Transfer {
            src: env.target.memory.unwrap_or(dst),
            dst,
            realloc: 0,
        });
    }
    Ok(Memory::Transfer {
        src: require(env.target.memory, "the callee's memory", call.name)?,
        dst,
        realloc: require(env.caller.realloc, "the caller's realloc", call.name)?,
    })
}

/// Hands a result held in `slots` (flat) or at the address in `slots[0]`
/// (spilled, in the callee's memory) to a component caller, whose call
/// record is in `subtask`.
fn deliver_result(
    emitter: &mut Emitter,
    call: &Call,
    env: &Environment,
    subtask: u32,
    slots: &[Slot],
    spilled: bool,
) -> Result<()> {
    let Some(result) = call.ty.result.as_ref() else {
        return Ok(());
    };
    let result_layout = layout(result);
    if !call.caller_async && result_layout.flat.len() <= 1 && !spilled {
        if let Some(slot) = slots.first() {
            emitter.walk_flat(result, slots, lift_visit(Memory::Untouched))?;
            store_call_result(emitter, subtask, *slot);
        }
        return Ok(());
    }
    let transfer = result_transfer(call, env, result_layout.pointers)?;
    let Memory::Transfer {
        dst: caller_memory, ..
    } = transfer
    else {
        unreachable!("results move by transfer")
    };
    let out = emitter.local(WasmType::I32);
    emitter.get(subtask);
    emitter.call_runtime("call.out");
    emitter.set(out);
    if spilled {
        emitter.copy_value(
            result,
            &result_layout,
            out,
            slots[0].local,
            lift_visit(transfer),
        )?;
    } else {
        emitter.walk_flat(result, slots, lift_visit(transfer))?;
        emitter.store_flat(result, slots, out, 0, caller_memory);
    }
    Ok(())
}

/// The start thunk, `(task, subtask, caller's arguments...)`: lowers the
/// arguments into the callee and runs it until it returns or waits.
pub fn emit_start(call: &Call, env: &Environment) -> Result<Emitted> {
    let ty = call.ty;
    let caller_params = call.caller_params(env);
    let mut params = vec![CoreType::I32, CoreType::I32];
    params.extend(&caller_params);
    let mut emitter = Emitter::new(env, call.name, params.len() as u32);
    let (task, subtask) = (0, 1);
    let saved = emitter.save_thread();
    let task_address = emitter.local(WasmType::I32);
    entry(&mut emitter, task);
    emitter.set(task_address);
    emitter.get(task);
    emitter.call_runtime("task.start");
    emitter.scope = Some((task, task_address));
    if env.caller.frame.is_some() {
        emitter.lend_to = Some(subtask);
    }

    let params_ty = params_record(&ty.params);
    let params_layout = layout(&params_ty);
    let callee_spills = params_layout.flat.len() > MAX_FLAT_PARAMS;
    let caller_spills = params_layout.flat.len() > call.caller_max_flat(env);
    let mut args = Vec::new();
    match env.caller.frame {
        Some(_) => {
            let transfer = || -> Result<Memory> {
                Ok(Memory::Transfer {
                    src: require(env.caller.memory, "the caller's memory", call.name)?,
                    dst: require(env.target.memory, "the callee's memory", call.name)?,
                    realloc: require(env.target.realloc, "the callee's realloc", call.name)?,
                })
            };
            match (caller_spills, callee_spills) {
                (false, _) => {
                    let slots = param_slots(&mut emitter, &params_layout.flat, 2);
                    let memory = if params_layout.pointers {
                        transfer()?
                    } else {
                        Memory::Untouched
                    };
                    emitter.walk_flat(&params_ty, &slots, lower_visit(memory))?;
                    args.extend(slots.iter().map(|slot| slot.local));
                }
                (true, true) => {
                    let memory = transfer()?;
                    let Memory::Transfer { realloc, .. } = memory else {
                        unreachable!()
                    };
                    let area = emitter.local(WasmType::I32);
                    emitter.emit(Instruction::I32Const(params_layout.size as i32));
                    let length = emitter.local(WasmType::I32);
                    emitter.set(length);
                    emitter.emit(Instruction::I32Const(0));
                    emitter.emit(Instruction::I32Const(0));
                    emitter.emit(Instruction::I32Const(params_layout.align as i32));
                    emitter.get(length);
                    emitter.emit(Instruction::Call(realloc));
                    emitter.set(area);
                    emitter.copy_value(&params_ty, &params_layout, area, 2, lower_visit(memory))?;
                    args.push(area);
                }
                (true, false) => {
                    let memory = require(env.caller.memory, "the caller's memory", call.name)?;
                    let slots = emitter.load_flat(&params_ty, 2, 0, memory);
                    let visit = if params_layout.pointers {
                        transfer()?
                    } else {
                        Memory::Untouched
                    };
                    emitter.walk_flat(&params_ty, &slots, lower_visit(visit))?;
                    args.extend(slots.iter().map(|slot| slot.local));
                }
            }
        }
        None => {
            let in_memory =
                contains_handles_in_memory(&params_ty) || (callee_spills && params_layout.handles);
            let memory = if in_memory {
                Memory::InPlace(require(
                    env.target.memory,
                    "the callee's memory",
                    call.name,
                )?)
            } else {
                Memory::Untouched
            };
            if callee_spills {
                if params_layout.handles {
                    emitter.walk_memory(&params_ty, 2, 2, 0, lower_visit(memory))?;
                }
                args.push(2);
            } else {
                let slots = param_slots(&mut emitter, &params_layout.flat, 2);
                emitter.walk_flat(&params_ty, &slots, lower_visit(memory))?;
                args.extend(slots.iter().map(|slot| slot.local));
            }
        }
    }

    if call.caller_async {
        let sync_frame = env.runtime.expect("an async link").thread_globals()[3];
        emitter.emit(Instruction::I32Const(-1));
        emitter.emit(Instruction::GlobalSet(sync_frame));
    }
    emitter.get(task);
    emitter.call_runtime("task.enter");
    for arg in &args {
        emitter.get(*arg);
    }
    emitter.emit(Instruction::Call(env.callee));

    if call.callback {
        let code = emitter.local(WasmType::I32);
        emitter.set(code);
        emitter.get(task);
        emitter.call_runtime("task.leave");
        emitter.restore_thread(saved);
        emitter.get(task);
        emitter.get(code);
        emitter.call_runtime("task.after");
    } else if call.stackful {
        // Its one thread has ended: the task must have resolved.
        emitter.get(task);
        emitter.call_runtime("task.leave");
        emitter.restore_thread(saved);
        emitter.get(task);
        emitter.call_runtime("task.exit");
    } else {
        let result_flat = ty.result.as_ref().map(flat_types).unwrap_or_default();
        let spilled = result_flat.len() > 1;
        let result = (!result_flat.is_empty()).then(|| {
            let ty = if spilled {
                CoreType::I32
            } else {
                result_flat[0]
            };
            let local = emitter.local(ty.encode());
            emitter.set(local);
            Slot { local, ty }
        });
        emitter.get(task);
        emitter.call_runtime("task.leave");
        emitter.restore_thread(saved);
        let slots: Vec<Slot> = result.into_iter().collect();
        deliver_result(&mut emitter, call, env, subtask, &slots, spilled)?;
        if let Some(post_return) = env.post_return {
            for slot in &slots {
                emitter.get(slot.local);
            }
            emitter.emit(Instruction::Call(post_return));
        }
        emitter.get(task);
        emitter.call_runtime("task.resolve");
        emitter.get(task);
        emitter.call_runtime("task.exit");
    }
    Ok(Emitted {
        params,
        results: Vec::new(),
        body: emitter.finish(),
    })
}

/// The values `task.return` left in the scratch area, in fresh locals.
fn scratch_values(emitter: &mut Emitter, result: Option<&ValType>) -> Vec<Slot> {
    let runtime = emitter.env.runtime.expect("an async link");
    task_return_signature(result)
        .params
        .into_iter()
        .enumerate()
        .map(|(index, ty)| {
            let local = emitter.local(ty.encode());
            emitter.emit(Instruction::I32Const(0));
            let offset = 8 * index as u32;
            emitter.emit(match ty {
                CoreType::I32 => Instruction::I32Load(state_memarg(runtime, offset, 2)),
                CoreType::I64 => Instruction::I64Load(state_memarg(runtime, offset, 3)),
                CoreType::F32 => Instruction::F32Load(state_memarg(runtime, offset, 2)),
                CoreType::F64 => Instruction::F64Load(state_memarg(runtime, offset, 3)),
            });
            emitter.set(local);
            Slot { local, ty }
        })
        .collect()
}

/// The resolve thunk, `(task)`: hands the values of the task's
/// `task.return` to its caller.
pub fn emit_resolve(call: &Call, env: &Environment, host_return: Option<u32>) -> Result<Emitted> {
    let mut emitter = Emitter::new(env, call.name, 1);
    let task = 0;
    let values = scratch_values(&mut emitter, call.ty.result.as_ref());
    let spilled = call
        .ty
        .result
        .as_ref()
        .is_some_and(|result| flat_types(result).len() > MAX_FLAT_PARAMS);
    match host_return {
        Some(host_return) => {
            if let Some(result) = call.ty.result.as_ref() {
                let in_memory =
                    contains_handles_in_memory(result) || (spilled && contains_handles(result));
                let memory = if in_memory {
                    Memory::InPlace(require(
                        env.target.memory,
                        "the callee's memory",
                        call.name,
                    )?)
                } else {
                    Memory::Untouched
                };
                if spilled {
                    if contains_handles(result) {
                        let base = values[0].local;
                        emitter.walk_memory(result, base, base, 0, lift_visit(memory))?;
                    }
                } else {
                    emitter.walk_flat(result, &values, lift_visit(memory))?;
                }
            }
            emitter.get(task);
            for value in &values {
                emitter.get(value.local);
            }
            emitter.emit(Instruction::Call(host_return));
        }
        None => {
            let subtask = emitter.local(WasmType::I32);
            emitter.get(task);
            emitter.call_runtime("task.super");
            emitter.set(subtask);
            deliver_result(&mut emitter, call, env, subtask, &values, spilled)?;
        }
    }
    Ok(Emitted {
        params: vec![CoreType::I32],
        results: Vec::new(),
        body: emitter.finish(),
    })
}

/// The wrapper of an async export the host calls with a callback lift:
/// starts the task and returns its status.
pub fn emit_export(call: &Call, env: &Environment) -> Result<Emitted> {
    let frame = env.target.frame.expect("a component is called");
    let params = async_lift_signature(call.ty, true).params;
    let mut emitter = Emitter::new(env, call.name, params.len() as u32);
    let task = emitter.local(WasmType::I32);
    i32_const(&mut emitter, frame as i32);
    i32_const(&mut emitter, call.lift as i32);
    i32_const(&mut emitter, call.site as i32);
    i32_const(&mut emitter, 0);
    i32_const(&mut emitter, call.task_flags() | TASK_HOST | TASK_KEPT);
    i32_const(&mut emitter, call.result_type as i32);
    i32_const(&mut emitter, call.result_memory as i32);
    emitter.call_runtime("task.new");
    emitter.set(task);
    emitter.get(task);
    emitter.call_runtime("task.try-enter");
    emitter.emit(Instruction::If(BlockType::Empty));
    emitter.get(task);
    i32_const(&mut emitter, 0);
    for index in 0..params.len() as u32 {
        emitter.get(index);
    }
    emitter.emit(Instruction::Call(call.start));
    emitter.emit(Instruction::Else);
    let locals: Vec<(u32, CoreType)> = params
        .iter()
        .enumerate()
        .map(|(index, ty)| (index as u32, *ty))
        .collect();
    save_args(&mut emitter, task, &locals);
    emitter.get(task);
    emitter.call_runtime("task.defer");
    emitter.emit(Instruction::End);
    emitter.get(task);
    emitter.call_runtime("host.status");
    Ok(Emitted {
        params,
        results: vec![CoreType::I32],
        body: emitter.finish(),
    })
}

/// The trampoline of an async-lowered import the host implements. The host
/// takes the subtask as its first argument and returns 2 when it has
/// already written the result, or 1 when it resolves the subtask later.
pub fn emit_host_import(
    name: &str,
    ty: &FuncType,
    env: &Environment,
    site: u32,
    host_resolve: u32,
) -> Result<Emitted> {
    let signature = async_lower_signature(ty);
    let frame = env.caller.frame.expect("a component calls the host");
    let params_ty = params_record(&ty.params);
    let params_layout = layout(&params_ty);
    let spilled = params_layout.flat.len() > MAX_FLAT_ASYNC_PARAMS;
    let argument_count = if spilled { 1 } else { params_layout.flat.len() };
    let out = (signature.params.len() > argument_count).then_some(argument_count as u32);
    let mut emitter = Emitter::new(env, name, signature.params.len() as u32);
    let subtask = emitter.local(WasmType::I32);
    let status = emitter.local(WasmType::I32);
    i32_const(&mut emitter, SUBTASK);
    i32_const(&mut emitter, frame as i32);
    i32_const(&mut emitter, site as i32);
    match out {
        Some(out) => emitter.get(out),
        None => i32_const(&mut emitter, 0),
    }
    i32_const(&mut emitter, CALL_HOST);
    emitter.call_runtime("call.new");
    emitter.set(subtask);
    emitter.lend_to = Some(subtask);

    let in_memory = contains_handles_in_memory(&params_ty) || (spilled && params_layout.handles);
    let lenders = in_memory.then(|| emitter.local(WasmType::I32));
    let memory = match lenders {
        Some(head) => Memory::Lend {
            memory: require(env.caller.memory, "the caller's memory", name)?,
            head,
        },
        None => Memory::Untouched,
    };
    let mut args = Vec::new();
    if spilled {
        if params_layout.handles {
            emitter.walk_memory(&params_ty, 0, 0, 0, lower_visit(memory))?;
        }
        args.push(0);
    } else {
        let slots = param_slots(&mut emitter, &params_layout.flat, 0);
        emitter.walk_flat(&params_ty, &slots, lower_visit(memory))?;
        args.extend(slots.iter().map(|slot| slot.local));
    }
    emitter.get(subtask);
    for arg in args {
        emitter.get(arg);
    }
    if let Some(out) = out {
        emitter.get(out);
    }
    emitter.emit(Instruction::Call(env.callee));
    emitter.set(status);
    if let (Some(head), Memory::Lend { memory, .. }) = (lenders, memory) {
        emitter.ops().restore_lenders(head, memory);
    }

    emitter.get(status);
    i32_const(&mut emitter, 2);
    emitter.emit(Instruction::I32Eq);
    emitter.emit(Instruction::If(BlockType::Empty));
    emitter.get(subtask);
    emitter.emit(Instruction::Call(host_resolve));
    entry(&mut emitter, subtask);
    i32_const(&mut emitter, 2);
    let arg = handles_memarg(emitter.env, CALL_STATE, 2);
    emitter.emit(Instruction::I32Store(arg));
    emitter.get(subtask);
    emitter.call_runtime("call.status");
    emitter.emit(Instruction::Return);
    emitter.emit(Instruction::End);
    emitter.get(status);
    i32_const(&mut emitter, 1);
    emitter.emit(Instruction::I32Ne);
    emitter.emit(Instruction::If(BlockType::Empty));
    i32_const(&mut emitter, TRAP_HOST);
    emitter.call_runtime("fail");
    emitter.emit(Instruction::End);
    emitter.get(subtask);
    emitter.call_runtime("host.started");
    Ok(Emitted {
        params: signature.params,
        results: signature.results,
        body: emitter.finish(),
    })
}

/// The core signature of an async import the host implements: the
/// subtask, then the async-lowered signature.
pub fn host_import_signature(ty: &FuncType) -> crate::types::Signature {
    let mut signature = async_lower_signature(ty);
    signature.params.insert(0, CoreType::I32);
    signature
}

/// The core signature of the import that hands an async export's result
/// to the host: the task, then `task.return`'s parameters.
pub fn host_return_signature(ty: &FuncType) -> crate::types::Signature {
    let mut signature = task_return_signature(ty.result.as_ref());
    signature.params.insert(0, CoreType::I32);
    signature
}

/// The host wrote an async import's result: the handles in it become the
/// caller's.
pub fn emit_host_resolve(name: &str, ty: &FuncType, env: &Environment) -> Result<Emitted> {
    let mut emitter = Emitter::new(env, name, 1);
    if let Some(result) = ty.result.as_ref().filter(|result| contains_handles(result)) {
        let memory = require(env.caller.memory, "the caller's memory", name)?;
        let out = emitter.local(WasmType::I32);
        emitter.get(0);
        emitter.call_runtime("call.out");
        emitter.set(out);
        emitter.walk_memory(result, out, out, 0, lift_visit(Memory::InPlace(memory)))?;
    }
    Ok(Emitted {
        params: vec![CoreType::I32],
        results: Vec::new(),
        body: emitter.finish(),
    })
}

/// What a canonical async built-in is generated against.
pub struct BuiltinEnv<'a> {
    pub frame: u32,
    pub builtin: &'a AsyncBuiltin,
    /// The memory option, as an index.
    pub memory: Option<u32>,
    /// For `stream.read` and `stream.write`, the side the buffer copies to
    /// or from.
    pub side: u32,
    pub async_: bool,
    pub result_type: u32,
    pub result_memory: u32,
}

/// A canonical async built-in of one frame.
pub fn emit_builtin(builtin: &BuiltinEnv, env: &Environment) -> Result<Emitted> {
    let runtime = env.runtime.expect("an async link");
    let frame = builtin.frame as i32;
    let name = builtin.builtin.describe();
    if let AsyncBuiltin::Unsupported { params, result, .. } = builtin.builtin {
        let mut emitter = Emitter::new(env, &name, *params);
        emitter.call_runtime("unsupported");
        emitter.emit(Instruction::Unreachable);
        return Ok(Emitted {
            params: vec![CoreType::I32; *params as usize],
            results: if *result {
                vec![CoreType::I32]
            } else {
                Vec::new()
            },
            body: emitter.finish(),
        });
    }
    let params;
    let results;
    // Built-ins of one kind differ in their parameters only.
    let mut emitter;
    macro_rules! start {
        ($params:expr, $results:expr) => {{
            params = $params;
            results = $results;
            emitter = Emitter::new(env, &name, params.len() as u32);
        }};
    }
    use CoreType::{I32, I64};
    match builtin.builtin {
        AsyncBuiltin::BackpressureInc | AsyncBuiltin::BackpressureDec => {
            start!(vec![], vec![]);
            i32_const(&mut emitter, frame);
            emitter.call_runtime(&name);
        }
        AsyncBuiltin::TaskReturn { result, .. } => {
            start!(task_return_signature(result.as_ref()).params, vec![]);
            for (index, ty) in params.iter().enumerate() {
                let offset = 8 * index as u32;
                emitter.emit(Instruction::I32Const(0));
                emitter.get(index as u32);
                emitter.emit(match ty {
                    CoreType::I32 => Instruction::I32Store(state_memarg(runtime, offset, 2)),
                    CoreType::I64 => Instruction::I64Store(state_memarg(runtime, offset, 3)),
                    CoreType::F32 => Instruction::F32Store(state_memarg(runtime, offset, 2)),
                    CoreType::F64 => Instruction::F64Store(state_memarg(runtime, offset, 3)),
                });
            }
            i32_const(&mut emitter, frame);
            i32_const(&mut emitter, builtin.result_type as i32);
            i32_const(&mut emitter, builtin.result_memory as i32);
            emitter.call_runtime("task.return");
        }
        AsyncBuiltin::TaskCancel => {
            start!(vec![], vec![]);
            i32_const(&mut emitter, frame);
            emitter.call_runtime("task.cancel");
        }
        AsyncBuiltin::ContextGet(slot) => {
            start!(vec![], vec![I32]);
            i32_const(&mut emitter, *slot as i32);
            emitter.call_runtime("context.get");
        }
        AsyncBuiltin::ContextSet(slot) => {
            start!(vec![I32], vec![]);
            i32_const(&mut emitter, *slot as i32);
            emitter.get(0);
            emitter.call_runtime("context.set");
        }
        AsyncBuiltin::Yield => {
            start!(vec![], vec![I32]);
            emitter.call_runtime("thread.yield");
        }
        AsyncBuiltin::SubtaskDrop | AsyncBuiltin::WaitableSetDrop => {
            start!(vec![I32], vec![]);
            i32_const(&mut emitter, frame);
            emitter.get(0);
            emitter.call_runtime(&name);
        }
        AsyncBuiltin::SubtaskCancel { async_ } => {
            start!(vec![I32], vec![I32]);
            i32_const(&mut emitter, frame);
            emitter.get(0);
            i32_const(&mut emitter, *async_ as i32);
            emitter.call_runtime("subtask.cancel");
        }
        AsyncBuiltin::WaitableSetNew => {
            start!(vec![], vec![I32]);
            i32_const(&mut emitter, frame);
            emitter.call_runtime("waitable-set.new");
        }
        AsyncBuiltin::WaitableJoin => {
            start!(vec![I32, I32], vec![]);
            i32_const(&mut emitter, frame);
            emitter.get(0);
            emitter.get(1);
            emitter.call_runtime("waitable.join");
        }
        AsyncBuiltin::WaitableSetWait { .. } | AsyncBuiltin::WaitableSetPoll { .. } => {
            start!(vec![I32, I32], vec![I32]);
            let memory = builtin.memory.expect("wait and poll name a memory");
            let code = emitter.local(WasmType::I32);
            i32_const(&mut emitter, frame);
            emitter.get(0);
            emitter.call_runtime(&name);
            emitter.set(code);
            for (offset, payload) in [(0, "event.p1"), (4, "event.p2")] {
                emitter.get(1);
                emitter.call_runtime(payload);
                emitter.emit(Instruction::I32Store(MemArg {
                    offset,
                    align: 2,
                    memory_index: memory,
                }));
            }
            emitter.get(code);
        }
        AsyncBuiltin::New { ty } => {
            start!(vec![], vec![I64]);
            i32_const(&mut emitter, frame);
            i32_const(&mut emitter, runtime.end_type(ty) as i32);
            i32_const(&mut emitter, matches!(ty, ValType::Future(_)) as i32);
            emitter.call_runtime("end.new");
        }
        AsyncBuiltin::Read { ty, .. } | AsyncBuiltin::Write { ty, .. } => {
            let future = matches!(ty, ValType::Future(_));
            let read = matches!(builtin.builtin, AsyncBuiltin::Read { .. });
            if future {
                start!(vec![I32, I32], vec![I32]);
            } else {
                start!(vec![I32, I32, I32], vec![I32]);
            }
            let length = if future {
                let local = emitter.local(WasmType::I32);
                i32_const(&mut emitter, 1);
                emitter.set(local);
                local
            } else {
                2
            };
            // The buffer must lie in the memory, aligned, and hold at most
            // 2^28 - 1 values.
            emitter.get(length);
            i32_const(&mut emitter, (1 << 28) - 1);
            emitter.emit(Instruction::I32GtU);
            emitter.emit(Instruction::If(BlockType::Empty));
            i32_const(&mut emitter, TRAP_BUFFER);
            emitter.call_runtime("fail");
            emitter.emit(Instruction::End);
            if let Some(element) = payload(ty).filter(|element| size(element) > 0) {
                let memory = require(builtin.memory, "a memory", &name)?;
                emitter.get(length);
                emitter.emit(Instruction::If(BlockType::Empty));
                emitter.get(1);
                i32_const(&mut emitter, alignment(element) as i32 - 1);
                emitter.emit(Instruction::I32And);
                emitter.get(1);
                emitter.emit(Instruction::I64ExtendI32U);
                emitter.get(length);
                emitter.emit(Instruction::I64ExtendI32U);
                emitter.emit(Instruction::I64Const(i64::from(size(element))));
                emitter.emit(Instruction::I64Mul);
                emitter.emit(Instruction::I64Add);
                emitter.emit(Instruction::MemorySize(memory));
                emitter.emit(Instruction::I64ExtendI32U);
                emitter.emit(Instruction::I64Const(16));
                emitter.emit(Instruction::I64Shl);
                emitter.emit(Instruction::I64GtU);
                emitter.emit(Instruction::I32Or);
                emitter.emit(Instruction::If(BlockType::Empty));
                i32_const(&mut emitter, TRAP_BUFFER);
                emitter.call_runtime("fail");
                emitter.emit(Instruction::End);
                emitter.emit(Instruction::End);
            }
            i32_const(&mut emitter, frame);
            i32_const(&mut emitter, runtime.end_type(ty) as i32);
            emitter.get(0);
            i32_const(&mut emitter, builtin.side as i32);
            emitter.get(1);
            emitter.get(length);
            i32_const(&mut emitter, builtin.async_ as i32);
            i32_const(&mut emitter, read as i32);
            i32_const(&mut emitter, future as i32);
            i32_const(&mut emitter, is_number_or_none(payload(ty)) as i32);
            emitter.call_runtime("end.copy");
        }
        AsyncBuiltin::CancelRead { ty, async_ } | AsyncBuiltin::CancelWrite { ty, async_ } => {
            start!(vec![I32], vec![I32]);
            let read = matches!(builtin.builtin, AsyncBuiltin::CancelRead { .. });
            i32_const(&mut emitter, frame);
            i32_const(&mut emitter, runtime.end_type(ty) as i32);
            emitter.get(0);
            i32_const(&mut emitter, *async_ as i32);
            i32_const(&mut emitter, read as i32);
            i32_const(&mut emitter, matches!(ty, ValType::Future(_)) as i32);
            emitter.call_runtime("end.cancel");
        }
        AsyncBuiltin::Unsupported { .. } => unreachable!("handled above"),
        AsyncBuiltin::DropReadable { ty } | AsyncBuiltin::DropWritable { ty } => {
            start!(vec![I32], vec![]);
            let read = matches!(builtin.builtin, AsyncBuiltin::DropReadable { .. });
            i32_const(&mut emitter, frame);
            i32_const(&mut emitter, runtime.end_type(ty) as i32);
            emitter.get(0);
            i32_const(&mut emitter, read as i32);
            i32_const(&mut emitter, matches!(ty, ValType::Future(_)) as i32);
            emitter.call_runtime("end.drop");
        }
    }
    Ok(Emitted {
        params,
        results,
        body: emitter.finish(),
    })
}

/// Emits a dispatch over the index `index` pushes: the case bodies in
/// order, each ending the function, and a trap for any other index.
fn dispatch(
    emitter: &mut Emitter,
    index: impl FnOnce(&mut Emitter),
    cases: Vec<Box<dyn FnOnce(&mut Emitter) + '_>>,
) {
    let count = cases.len() as u32;
    for _ in 0..=count {
        emitter.emit(Instruction::Block(BlockType::Empty));
    }
    index(emitter);
    emitter.emit(Instruction::BrTable(
        (0..count).collect::<Vec<_>>().into(),
        count,
    ));
    for case in cases {
        emitter.emit(Instruction::End);
        case(emitter);
        emitter.emit(Instruction::Return);
    }
    emitter.emit(Instruction::End);
    emitter.emit(Instruction::Unreachable);
}

/// `callback(lift, event, p1, p2) -> code`.
pub fn emit_dispatch_callback(env: &Environment, callbacks: &[u32]) -> Emitted {
    let mut emitter = Emitter::new(env, "callback", 4);
    let cases = callbacks
        .iter()
        .map(|&callback| {
            Box::new(move |emitter: &mut Emitter| {
                emitter.get(1);
                emitter.get(2);
                emitter.get(3);
                emitter.emit(Instruction::Call(callback));
            }) as Box<dyn FnOnce(&mut Emitter)>
        })
        .collect();
    dispatch(&mut emitter, |emitter| emitter.get(0), cases);
    Emitted {
        params: vec![CoreType::I32; 4],
        results: vec![CoreType::I32],
        body: emitter.finish(),
    }
}

/// A site's thunks, for the dispatchers: its start thunk and the types of
/// the arguments it saves, and its resolve thunk.
pub struct SiteThunks {
    pub start: u32,
    pub saved: Vec<CoreType>,
    pub resolve: Option<u32>,
}

/// `start(task)`: a deferred call starts with the arguments it saved.
pub fn emit_dispatch_start(env: &Environment, sites: &[SiteThunks]) -> Emitted {
    let mut emitter = Emitter::new(env, "start", 1);
    let cases = sites
        .iter()
        .map(|site| {
            Box::new(move |emitter: &mut Emitter| {
                emitter.get(0);
                emitter.get(0);
                emitter.call_runtime("task.super");
                load_args(emitter, 0, &site.saved);
                emitter.emit(Instruction::Call(site.start));
            }) as Box<dyn FnOnce(&mut Emitter)>
        })
        .collect();
    let arg = handles_memarg(env, TASK_SITE, 2);
    dispatch(
        &mut emitter,
        |emitter| {
            entry(emitter, 0);
            emitter.emit(Instruction::I32Load(arg));
        },
        cases,
    );
    Emitted {
        params: vec![CoreType::I32],
        results: Vec::new(),
        body: emitter.finish(),
    }
}

/// `resolve(task)`: `task.return` reaches the task's caller.
pub fn emit_dispatch_resolve(env: &Environment, sites: &[SiteThunks]) -> Emitted {
    let mut emitter = Emitter::new(env, "resolve", 1);
    let cases = sites
        .iter()
        .map(|site| {
            let resolve = site.resolve;
            Box::new(move |emitter: &mut Emitter| match resolve {
                Some(resolve) => {
                    emitter.get(0);
                    emitter.emit(Instruction::Call(resolve));
                }
                None => emitter.emit(Instruction::Unreachable),
            }) as Box<dyn FnOnce(&mut Emitter)>
        })
        .collect();
    let arg = handles_memarg(env, TASK_SITE, 2);
    dispatch(
        &mut emitter,
        |emitter| {
            entry(emitter, 0);
            emitter.emit(Instruction::I32Load(arg));
        },
        cases,
    );
    Emitted {
        params: vec![CoreType::I32],
        results: Vec::new(),
        body: emitter.finish(),
    }
}

/// `host-resolve(subtask)`: an async import's result, which the host wrote,
/// gets its handles.
pub fn emit_dispatch_host_resolve(env: &Environment, thunks: &[u32]) -> Emitted {
    let mut emitter = Emitter::new(env, "host-resolve", 1);
    let cases = thunks
        .iter()
        .map(|&thunk| {
            Box::new(move |emitter: &mut Emitter| {
                emitter.get(0);
                emitter.emit(Instruction::Call(thunk));
            }) as Box<dyn FnOnce(&mut Emitter)>
        })
        .collect();
    let arg = handles_memarg(env, CALL_SITE, 2);
    dispatch(
        &mut emitter,
        |emitter| {
            entry(emitter, 0);
            emitter.emit(Instruction::I32Load(arg));
        },
        cases,
    );
    Emitted {
        params: vec![CoreType::I32],
        results: Vec::new(),
        body: emitter.finish(),
    }
}

/// One side of a stream or future copy: a `read` or `write` built-in, whose
/// buffers lie in its frame's memory, or the host's buffers of one type,
/// which it both reads and writes.
#[derive(Clone, Debug)]
pub struct Side {
    pub ty: ValType,
    pub party: crate::adapter::Party,
    pub reads: bool,
    pub writes: bool,
    pub host: bool,
}

/// How the copy between a writer's side and a reader's moves elements.
pub enum PairCopy {
    /// Nothing moves: the elements are empty.
    Nothing,
    /// The bytes move as they are.
    Bytes { src: u32, dst: u32, size: u32 },
    /// The pair's copy function converts each element.
    Convert { func: u32, size: u32 },
}

/// The pair copy function `(src, dst, n)` for elements that hold pointers
/// or handles: copies `n` elements from the writer's memory at `src` into
/// the reader's at `dst`.
pub fn emit_pair_copy(name: &str, element: &ValType, env: &Environment) -> Result<Emitted> {
    let mut emitter = Emitter::new(env, name, 3);
    let memory = Memory::Transfer {
        src: require(env.caller.memory, "the writer's memory", name)?,
        dst: require(env.target.memory, "the reader's memory", name)?,
        realloc: if contains_pointers(element) {
            require(env.target.realloc, "the reader's realloc", name)?
        } else {
            0
        },
    };
    let element_layout = layout(element);
    let (src, dst) = (emitter.local(WasmType::I32), emitter.local(WasmType::I32));
    let end = emitter.local(WasmType::I32);
    emitter.get(0);
    emitter.set(src);
    emitter.get(1);
    emitter.set(dst);
    emitter.get(2);
    i32_const(&mut emitter, element_layout.size as i32);
    emitter.emit(Instruction::I32Mul);
    emitter.get(1);
    emitter.emit(Instruction::I32Add);
    emitter.set(end);
    emitter.emit(Instruction::Block(BlockType::Empty));
    emitter.emit(Instruction::Loop(BlockType::Empty));
    emitter.get(dst);
    emitter.get(end);
    emitter.emit(Instruction::I32GeU);
    emitter.emit(Instruction::BrIf(1));
    emitter.copy_value(element, &element_layout, dst, src, lower_visit(memory))?;
    for cursor in [src, dst] {
        emitter.get(cursor);
        i32_const(&mut emitter, element_layout.size as i32);
        emitter.emit(Instruction::I32Add);
        emitter.set(cursor);
    }
    emitter.emit(Instruction::Br(0));
    emitter.emit(Instruction::End);
    emitter.emit(Instruction::End);
    Ok(Emitted {
        params: vec![CoreType::I32; 3],
        results: Vec::new(),
        body: emitter.finish(),
    })
}

/// `copy(src side, dst side, src ptr, src progress, dst ptr, dst progress,
/// n)`, over the pairs of sides of one type; `pairs[w][r]` is the copy from
/// writer side `w + 1` to reader side `r + 1`.
pub fn emit_dispatch_copy(env: &Environment, pairs: &[Vec<Option<PairCopy>>]) -> Emitted {
    let mut emitter = Emitter::new(env, "copy", 7);
    let (src_side, dst_side, src_ptr, src_progress, dst_ptr, dst_progress, count) =
        (0, 1, 2, 3, 4, 5, 6);
    let address = |emitter: &mut Emitter, ptr: u32, progress: u32, size: u32| {
        emitter.get(ptr);
        emitter.get(progress);
        i32_const(emitter, size as i32);
        emitter.emit(Instruction::I32Mul);
        emitter.emit(Instruction::I32Add);
    };
    let mut outer: Vec<Box<dyn FnOnce(&mut Emitter)>> = vec![Box::new(|emitter: &mut Emitter| {
        emitter.emit(Instruction::Unreachable)
    })];
    for row in pairs {
        outer.push(Box::new(move |emitter: &mut Emitter| {
            let mut inner: Vec<Box<dyn FnOnce(&mut Emitter)>> =
                vec![Box::new(|emitter: &mut Emitter| {
                    emitter.emit(Instruction::Unreachable)
                })];
            for pair in row {
                inner.push(Box::new(move |emitter: &mut Emitter| match pair {
                    None => emitter.emit(Instruction::Unreachable),
                    Some(PairCopy::Nothing) => {}
                    Some(PairCopy::Bytes { src, dst, size }) => {
                        address(emitter, dst_ptr, dst_progress, *size);
                        address(emitter, src_ptr, src_progress, *size);
                        emitter.get(count);
                        i32_const(emitter, *size as i32);
                        emitter.emit(Instruction::I32Mul);
                        emitter.emit(Instruction::MemoryCopy {
                            src_mem: *src,
                            dst_mem: *dst,
                        });
                    }
                    Some(PairCopy::Convert { func, size }) => {
                        address(emitter, src_ptr, src_progress, *size);
                        address(emitter, dst_ptr, dst_progress, *size);
                        emitter.get(count);
                        emitter.emit(Instruction::Call(*func));
                    }
                }));
            }
            dispatch(emitter, |emitter| emitter.get(dst_side), inner);
        }));
    }
    dispatch(&mut emitter, |emitter| emitter.get(src_side), outer);
    Emitted {
        params: vec![CoreType::I32; 7],
        results: Vec::new(),
        body: emitter.finish(),
    }
}

/// Whether a copy goes from `writer` to `reader`: one writes, the other
/// reads, both of one type.
pub fn pairs(writer: &Side, reader: &Side) -> bool {
    writer.writes && reader.reads && writer.ty == reader.ty
}

/// Whether the copy from `writer` to `reader` goes through a function of its
/// own, converting each element. The host's copies between its own buffers
/// stay within its memory, and move the bytes.
pub fn pair_converts(writer: &Side, reader: &Side) -> bool {
    pairs(writer, reader) && !(writer.host && reader.host) && converts_elements(&writer.ty)
}

/// The copy between writer side `w` and reader side `r`, unless they cannot
/// pair.
pub fn pair_copy(writer: &Side, reader: &Side) -> Result<Option<PairCopy>> {
    if !pairs(writer, reader) {
        return Ok(None);
    }
    let Some(element) = payload(&writer.ty).filter(|element| size(element) > 0) else {
        return Ok(Some(PairCopy::Nothing));
    };
    if pair_converts(writer, reader) {
        bail!("a pair of sides whose elements convert has its own copy function");
    }
    let (Some(src), Some(dst)) = (writer.party.memory, reader.party.memory) else {
        bail!(
            "a stream or future of {} copies between buffers without a memory",
            writer.ty
        );
    };
    Ok(Some(PairCopy::Bytes {
        src,
        dst,
        size: size(element),
    }))
}

/// Whether the copies between sides of `ty` go through a function per pair.
pub fn converts_elements(ty: &ValType) -> bool {
    payload(ty).is_some_and(|element| contains_pointers(element) || contains_handles(element))
}

/// A trap standing in for a host function the link never calls.
pub fn emit_unreachable(
    env: &Environment,
    params: Vec<CoreType>,
    results: Vec<CoreType>,
) -> Emitted {
    let mut emitter = Emitter::new(env, "unreachable", params.len() as u32);
    emitter.emit(Instruction::Unreachable);
    Emitted {
        params,
        results,
        body: emitter.finish(),
    }
}

/// `host-wait` for a link whose host runs no async import: nothing can
/// make progress.
pub fn emit_no_wait(env: &Environment) -> Emitted {
    let mut emitter = Emitter::new(env, "host-wait", 0);
    i32_const(&mut emitter, 0);
    Emitted {
        params: Vec::new(),
        results: vec![CoreType::I32],
        body: emitter.finish(),
    }
}

/// `host-frame() -> frame`.
pub fn emit_host_frame(env: &Environment, frame: u32) -> Emitted {
    let mut emitter = Emitter::new(env, "host-frame", 0);
    i32_const(&mut emitter, frame as i32);
    Emitted {
        params: Vec::new(),
        results: vec![CoreType::I32],
        body: emitter.finish(),
    }
}

/// `host-side(type) -> side`: the side of the host's buffers of each type
/// that crosses its edge, by type index.
pub fn emit_host_side(env: &Environment, sides: &[Option<u32>]) -> Emitted {
    let mut emitter = Emitter::new(env, "host-side", 1);
    let cases = sides
        .iter()
        .map(|&side| {
            Box::new(move |emitter: &mut Emitter| match side {
                Some(side) => i32_const(emitter, side as i32),
                None => emitter.emit(Instruction::Unreachable),
            }) as Box<dyn FnOnce(&mut Emitter)>
        })
        .collect();
    dispatch(&mut emitter, |emitter| emitter.get(0), cases);
    Emitted {
        params: vec![CoreType::I32],
        results: vec![CoreType::I32],
        body: emitter.finish(),
    }
}

/// A call whose task the dispatchers reach: a fused call of an async
/// function, or the host's call of an async export lifted with a callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SiteKind {
    Adapter(usize),
    Export(usize),
}

/// What a plan asks of the async runtime.
#[derive(Debug, Default)]
pub struct AsyncLink {
    /// The frames whose threads the runtime tracks: those that lift, lower
    /// or build on anything async. A synchronously typed call into one runs
    /// as a fresh thread.
    pub aware: Vec<bool>,
    pub sites: Vec<SiteKind>,
    pub adapter_sites: Vec<Option<u32>>,
    pub export_sites: Vec<Option<u32>>,
    /// Each site's lift: the index of its callback, when it has one.
    pub site_lifts: Vec<Option<u32>>,
    /// Each site's callee returns through `task.return`.
    pub site_returns: Vec<bool>,
    /// The callbacks, by lift.
    pub callbacks: Vec<crate::plan::CoreFunc>,
    /// The async imports the host implements, lowered async: their sites.
    pub import_sites: Vec<Option<u32>>,
    pub host_imports: Vec<usize>,
    /// Each async built-in's side, for `read` and `write` (0 otherwise).
    pub builtin_sides: Vec<u32>,
    /// The read and write built-ins, by side less one. The host's sides
    /// follow theirs, one per type in `host_end_types`.
    pub sides: Vec<usize>,
    pub end_types: Vec<ValType>,
    /// The stream and future types whose ends the host can hold: those that
    /// cross its edge, and those their elements hold.
    pub host_end_types: Vec<ValType>,
    pub result_types: Vec<Option<ValType>>,
}

impl AsyncLink {
    /// The host's async imports, and the copies of the ends it holds, can
    /// leave work pending that a synchronous wait must ask the host to
    /// finish.
    pub fn host_waits(&self) -> bool {
        !self.host_imports.is_empty() || self.host_ends()
    }

    /// The host runs async imports, which a component may cancel.
    pub fn host_cancels(&self) -> bool {
        !self.host_imports.is_empty()
    }

    /// Streams or futures cross the host's edge.
    pub fn host_ends(&self) -> bool {
        !self.host_end_types.is_empty()
    }

    /// Elements the host reads hold strings or lists, which need its
    /// allocator.
    pub fn host_allocates(&self) -> bool {
        self.host_end_types
            .iter()
            .filter_map(payload)
            .any(contains_pointers)
    }

    /// The side of the host's buffers of each end type, by type index.
    pub fn host_sides(&self) -> Vec<Option<u32>> {
        self.end_types
            .iter()
            .map(|ty| {
                self.host_end_types
                    .iter()
                    .position(|host| host == ty)
                    .map(|index| (self.sides.len() + index + 1) as u32)
            })
            .collect()
    }

    /// The host can call an async export lifted with a callback.
    pub fn host_tasks(&self) -> bool {
        self.sites
            .iter()
            .any(|site| matches!(site, SiteKind::Export(_)))
    }
}

fn names_async(ty: &FuncType) -> bool {
    ty.async_
        || ty
            .params
            .iter()
            .map(|(_, ty)| ty)
            .chain(ty.result.as_ref())
            .any(crate::types::contains_ends)
}

fn register_result(types: &mut Vec<Option<ValType>>, ty: Option<&ValType>) {
    if !types.iter().any(|known| known.as_ref() == ty) {
        types.push(ty.cloned());
    }
}

fn register_func(ty: &FuncType, ends: &mut Vec<ValType>) {
    for (_, param) in &ty.params {
        register_end_types(param, ends);
    }
    if let Some(result) = &ty.result {
        register_end_types(result, ends);
    }
}

/// Analyzes what `plan` asks of the async runtime, or `None` when nothing
/// in it is async.
pub fn analyze(plan: &crate::plan::Plan) -> Result<Option<AsyncLink>> {
    let used = !plan.async_builtins.is_empty()
        || plan.adapters.iter().any(|adapter| names_async(&adapter.ty))
        || plan.imports.iter().any(|import| names_async(&import.ty))
        || plan.exports.iter().any(|export| names_async(&export.ty));
    if !used {
        return Ok(None);
    }
    let mut link = AsyncLink {
        aware: vec![false; plan.frames.len()],
        ..AsyncLink::default()
    };
    for builtin in &plan.async_builtins {
        link.aware[builtin.frame] = true;
        if let Some(ty) = builtin.builtin.end_type() {
            register_end_types(ty, &mut link.end_types);
        }
        if let AsyncBuiltin::TaskReturn { result, .. } = &builtin.builtin {
            register_result(&mut link.result_types, result.as_ref());
        }
        let side = matches!(
            builtin.builtin,
            AsyncBuiltin::Read { .. } | AsyncBuiltin::Write { .. }
        );
        if side {
            link.sides.push(link.builtin_sides.len());
            link.builtin_sides.push(link.sides.len() as u32);
        } else {
            link.builtin_sides.push(0);
        }
    }
    let add_site = |link: &mut AsyncLink, site: SiteKind, lift: &crate::plan::LiftOptions| {
        let callback = lift.callback.as_ref();
        let index = link.sites.len() as u32;
        link.sites.push(site);
        link.site_returns.push(lift.async_);
        link.site_lifts.push(callback.map(|callback| {
            link.callbacks.push(callback.clone());
            link.callbacks.len() as u32 - 1
        }));
        index
    };
    for adapter in &plan.adapters {
        register_func(&adapter.ty, &mut link.end_types);
        let site = if adapter.ty.async_ {
            link.aware[adapter.caller_frame] = true;
            link.aware[adapter.callee_frame] = true;
            register_result(&mut link.result_types, adapter.ty.result.as_ref());
            let adapter_index = link.adapter_sites.len();
            Some(add_site(
                &mut link,
                SiteKind::Adapter(adapter_index),
                &adapter.lift,
            ))
        } else {
            None
        };
        link.adapter_sites.push(site);
    }
    for (index, import) in plan.imports.iter().enumerate() {
        register_func(&import.ty, &mut link.end_types);
        register_func(&import.ty, &mut link.host_end_types);
        if import.ty.async_ {
            link.aware[import.frame] = true;
        }
        let site = (import.ty.async_ && import.lower.async_).then(|| {
            link.host_imports.push(index);
            link.host_imports.len() as u32 - 1
        });
        link.import_sites.push(site);
    }
    for export in &plan.exports {
        register_func(&export.ty, &mut link.end_types);
        register_func(&export.ty, &mut link.host_end_types);
        let site = if export.ty.async_ {
            link.aware[export.frame] = true;
            register_result(&mut link.result_types, export.ty.result.as_ref());
            let export_index = link.export_sites.len();
            export
                .lift
                .async_
                .then(|| add_site(&mut link, SiteKind::Export(export_index), &export.lift))
        } else {
            None
        };
        link.export_sites.push(site);
    }
    Ok(Some(link))
}
