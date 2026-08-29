// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Running function bodies: frames, blocks, terminators, calls, exception
//! dispatch, the contextual operations, constant expressions, and
//! instantiation.

use crate::ir::{
    Block, BlockId, Callee, CompositeType, ConstExpr, DataId, DataMode, Edge, ElementId,
    ElementItem, ElementMode, EntityOrigin, ExceptionRouting, ExceptionalArgument, FieldType,
    FunctionBody, FunctionId, GlobalId, HeapType, Immediate, ImportItem, MemoryArgument, MemoryId,
    Operation, OperationKind, Region, RegionId, RegionKind, StorageType, TableId, Terminator,
    TerminatorKind, TrapCode, TypeId, ValueDefinition, ValueId, ValueType, is_heap_subtype,
    is_nominal_type_subtype,
};
use crate::opcode::CoreOpcode;

use super::numeric::{self, Operands, address};
use super::simd;
use super::store::{Memory, PAGE_SIZE, Table};
use super::{ExceptionId, Fault, Host, Instance, NoHost, Ref, Value};

/// Where control goes after a terminator.
enum Control {
    Jump(BlockId),
    Return(Vec<Value>),
    TailCall(FunctionId, Vec<Value>),
}

/// What an operation produced. Nearly every operation produces one value
/// or none, so those two cases do not allocate.
pub(super) enum Values {
    None,
    One(Value),
    Many(Vec<Value>),
}

impl Values {
    fn len(&self) -> usize {
        match self {
            Self::None => 0,
            Self::One(_) => 1,
            Self::Many(values) => values.len(),
        }
    }

    fn extend_into(self, target: &mut Vec<Value>) {
        match self {
            Self::None => {}
            Self::One(value) => target.push(value),
            Self::Many(values) => target.extend(values),
        }
    }
}

/// The SSA values of one activation, indexed by value id, plus the buffer
/// operands and edge arguments are gathered in. Frames are pooled by the
/// instance, so a call reuses a finished activation's allocations.
#[derive(Default)]
pub(super) struct Frame {
    values: Vec<Value>,
    scratch: Vec<Value>,
}

impl Frame {
    /// Prepares the frame for a function with `count` values.
    fn reset(&mut self, count: usize) {
        self.values.clear();
        self.values.resize(count, Value::I32(0));
    }

    #[inline(always)]
    fn get(&self, value: ValueId) -> Result<Value, Fault> {
        self.values
            .get(value.index())
            .copied()
            .ok_or_else(|| invalid(format!("{value} is outside the frame")))
    }

    #[inline(always)]
    fn set(&mut self, value: ValueId, new: Value) -> Result<(), Fault> {
        match self.values.get_mut(value.index()) {
            Some(slot) => {
                *slot = new;
                Ok(())
            }
            None => Err(invalid(format!("{value} is outside the frame"))),
        }
    }

    /// Reads `values` into the scratch buffer, which the caller takes back
    /// with [`Self::restore`]; taking the buffer out lets it be read while
    /// the frame's values are written.
    #[inline(always)]
    fn gather(&mut self, values: &[ValueId]) -> Result<Vec<Value>, Fault> {
        let mut scratch = std::mem::take(&mut self.scratch);
        scratch.clear();
        for value in values {
            match self.values.get(value.index()) {
                Some(value) => scratch.push(*value),
                None => {
                    self.scratch = scratch;
                    return Err(invalid(format!("{value} is outside the frame")));
                }
            }
        }
        Ok(scratch)
    }

    #[inline(always)]
    fn restore(&mut self, scratch: Vec<Value>) {
        self.scratch = scratch;
    }

    /// Binds the parameters from `skip` on to `values`, one each; `values`
    /// must run exactly to the last parameter.
    fn bind(
        &mut self,
        parameters: &[ValueDefinition],
        skip: usize,
        values: &[Value],
    ) -> Result<(), Fault> {
        let targets = parameters.get(skip..).unwrap_or(&[]);
        if targets.len() != values.len() {
            return Err(invalid(format!(
                "{} values delivered to {} parameters",
                values.len(),
                targets.len()
            )));
        }
        for (parameter, value) in targets.iter().zip(values) {
            self.set(parameter.id, *value)?;
        }
        Ok(())
    }
}

fn invalid(message: impl Into<String>) -> Fault {
    Fault::Invalid(message.into())
}

fn trap(code: TrapCode) -> Fault {
    Fault::Trap(code)
}

#[inline(always)]
fn block_of(body: &FunctionBody, id: BlockId) -> Result<&Block, Fault> {
    body.block(id).ok_or_else(|| invalid(format!("no {id}")))
}

fn region_of(body: &FunctionBody, id: RegionId) -> Result<&Region, Fault> {
    body.regions
        .get(id.index())
        .filter(|region| region.id == id)
        .or_else(|| body.regions.iter().find(|region| region.id == id))
        .ok_or_else(|| invalid(format!("no {id}")))
}

fn immediate(operation: &Operation, index: usize) -> Result<&Immediate, Fault> {
    operation
        .immediates
        .get(index)
        .ok_or_else(|| invalid(format!("{} has no immediate {index}", operation.mnemonic())))
}

macro_rules! immediate_accessor {
    ($name:ident, $variant:ident, $ty:ty, $what:literal) => {
        fn $name(operation: &Operation, index: usize) -> Result<$ty, Fault> {
            match immediate(operation, index)? {
                Immediate::$variant(value) => Ok(value.clone()),
                other => Err(invalid(format!(
                    "{} immediate {index} should be {}, found {other:?}",
                    operation.mnemonic(),
                    $what
                ))),
            }
        }
    };
}

immediate_accessor!(function_immediate, Function, FunctionId, "a function");
immediate_accessor!(type_immediate, Type, TypeId, "a type");
immediate_accessor!(table_immediate, Table, TableId, "a table");
immediate_accessor!(memory_immediate, Memory, MemoryId, "a memory");
immediate_accessor!(global_immediate, Global, GlobalId, "a global");
immediate_accessor!(data_immediate, Data, DataId, "a data segment");
immediate_accessor!(element_immediate, Element, ElementId, "an element segment");
immediate_accessor!(u32_immediate, U32, u32, "an integer");
immediate_accessor!(heap_type_immediate, HeapType, HeapType, "a heap type");
immediate_accessor!(
    memarg_immediate,
    MemoryArgument,
    MemoryArgument,
    "a memory argument"
);
immediate_accessor!(tag_immediate, Tag, crate::ir::TagId, "a tag");

/// Whether a packed or ordinary field type is what `value` may fill.
fn pack(storage: &StorageType, value: Value) -> Result<Value, Fault> {
    Ok(match (storage, value) {
        (StorageType::I8, Value::I32(value)) => Value::I32(value & 0xff),
        (StorageType::I16, Value::I32(value)) => Value::I32(value & 0xffff),
        (StorageType::Value(_), value) => value,
        (storage, value) => {
            return Err(invalid(format!(
                "{value} cannot be stored in a {storage} field"
            )));
        }
    })
}

/// Reads a field back, sign-extending a packed one on request.
fn unpack(storage: &StorageType, value: &Value, signed: bool) -> Result<Value, Fault> {
    Ok(match (storage, value) {
        (StorageType::I8, Value::I32(value)) if signed => {
            Value::I32(*value as u8 as i8 as i32 as u32)
        }
        (StorageType::I16, Value::I32(value)) if signed => {
            Value::I32(*value as u16 as i16 as i32 as u32)
        }
        (_, value) => *value,
    })
}

fn default_field(storage: &StorageType) -> Value {
    Value::default_for(&storage.stack_type())
}

/// Splits `operands` into the arguments of a call and its trailing callee
/// operand.
fn split_callee(operands: &Operands<'_>, what: &str) -> Result<(Vec<Value>, Value), Fault> {
    let mut arguments = operands.to_vec()?;
    let callee = arguments
        .pop()
        .ok_or_else(|| invalid(format!("{what} has no callee operand")))?;
    Ok((arguments, callee))
}

fn checked_range(start: u64, len: u64, size: u64) -> Option<()> {
    let end = start.checked_add(len)?;
    (end <= size).then_some(())
}

fn size_result(address_type: crate::ir::AddressType, value: u64) -> Value {
    match address_type {
        crate::ir::AddressType::I32 => Value::I32(value as u32),
        crate::ir::AddressType::I64 => Value::I64(value),
    }
}

fn failed_growth(address_type: crate::ir::AddressType) -> Value {
    match address_type {
        crate::ir::AddressType::I32 => Value::I32(u32::MAX),
        crate::ir::AddressType::I64 => Value::I64(u64::MAX),
    }
}

/// See [`super::evaluate_pure`].
pub(super) fn evaluate_pure(
    operation: &Operation,
    a: &Operands<'_>,
) -> Result<Option<Value>, Fault> {
    let OperationKind::Core(opcode) = operation.kind else {
        return Ok(None);
    };
    if let Some(value) = numeric::execute(opcode, a)? {
        return Ok(Some(value));
    }
    if let Some(value) = simd::execute(opcode, operation, a)? {
        return Ok(Some(value));
    }

    use CoreOpcode::*;
    Ok(Some(match opcode {
        Select | TypedSelect => {
            let condition = a.i32(2)? != 0;
            a.get(if condition { 0 } else { 1 })?.clone()
        }
        I32Const => match immediate(operation, 0)? {
            Immediate::S32(value) => Value::I32(*value as u32),
            other => return Err(invalid(format!("i32.const of {other:?}"))),
        },
        I64Const => match immediate(operation, 0)? {
            Immediate::S64(value) => Value::I64(*value as u64),
            other => return Err(invalid(format!("i64.const of {other:?}"))),
        },
        F32Const => match immediate(operation, 0)? {
            Immediate::F32(bits) => Value::F32(*bits),
            other => return Err(invalid(format!("f32.const of {other:?}"))),
        },
        F64Const => match immediate(operation, 0)? {
            Immediate::F64(bits) => Value::F64(*bits),
            other => return Err(invalid(format!("f64.const of {other:?}"))),
        },
        V128Const => match immediate(operation, 0)? {
            Immediate::V128(bytes) => Value::V128(*bytes),
            other => return Err(invalid(format!("v128.const of {other:?}"))),
        },
        _ => return Ok(None),
    }))
}

impl<'program> Instance<'program> {
    /// Evaluates the module's initializers in order and runs its start
    /// function.
    pub(super) fn initialize(&mut self, host: &mut dyn Host) -> Result<(), Fault> {
        let program = self.program;
        for import in &program.imports {
            if !matches!(import.item, ImportItem::Function(_)) {
                return Err(Fault::Unsupported(format!(
                    "import {:?}.{:?} is not a function",
                    import.module, import.name
                )));
            }
        }

        for global in &program.globals {
            let Some(initializer) = &global.initializer else {
                return Err(Fault::Unsupported("imported global".to_owned()));
            };
            let value = self.evaluate_const(initializer)?;
            self.store.globals.push(value);
        }

        for memory in &program.memories {
            if matches!(memory.origin, EntityOrigin::Imported(_)) {
                return Err(Fault::Unsupported("imported memory".to_owned()));
            }
            let bytes = memory
                .ty
                .limits
                .min
                .checked_mul(PAGE_SIZE)
                .filter(|bytes| *bytes <= self.config.max_memory_bytes)
                .ok_or_else(|| {
                    Fault::Unsupported(format!(
                        "a memory of {} pages exceeds the interpreter's limit",
                        memory.ty.limits.min
                    ))
                })?;
            self.store.memories.push(Memory {
                bytes: vec![0; bytes as usize],
                max_pages: memory.ty.limits.max,
                address_type: memory.ty.address_type,
            });
        }

        for table in &program.tables {
            if matches!(table.origin, EntityOrigin::Imported(_)) {
                return Err(Fault::Unsupported("imported table".to_owned()));
            }
            let init = match &table.initializer {
                Some(initializer) => match self.evaluate_const(initializer)? {
                    Value::Ref(reference) => reference,
                    other => return Err(invalid(format!("table initializer gave {other}"))),
                },
                None => Ref::Null,
            };
            if table.ty.limits.min > self.config.max_table_elements {
                return Err(Fault::Unsupported(format!(
                    "a table of {} elements exceeds the interpreter's limit",
                    table.ty.limits.min
                )));
            }
            self.store.tables.push(Table {
                elements: vec![init; table.ty.limits.min as usize],
                max: table.ty.limits.max,
                address_type: table.ty.address_type,
            });
        }

        self.store.dropped_data = vec![false; program.data.len()];
        self.store.dropped_elements = vec![false; program.elements.len()];

        for (index, element) in program.elements.iter().enumerate() {
            match &element.mode {
                ElementMode::Active { table, offset } => {
                    let offset = address(&self.evaluate_const(offset)?)?;
                    let references = self.element_references(ElementId(index as u32))?;
                    let table = self.table_mut(*table)?;
                    checked_range(offset, references.len() as u64, table.elements.len() as u64)
                        .ok_or_else(|| trap(TrapCode::TableOutOfBounds))?;
                    for (slot, reference) in
                        table.elements[offset as usize..].iter_mut().zip(references)
                    {
                        *slot = reference;
                    }
                    self.store.dropped_elements[index] = true;
                }
                ElementMode::Declarative => self.store.dropped_elements[index] = true,
                ElementMode::Passive => {}
            }
        }

        for (index, data) in program.data.iter().enumerate() {
            if let DataMode::Active { memory, offset } = &data.mode {
                let offset = address(&self.evaluate_const(offset)?)?;
                let memory = self.memory_mut(*memory)?;
                let destination = memory
                    .slice_mut(offset, data.bytes.len())
                    .ok_or_else(|| trap(TrapCode::MemoryOutOfBounds))?;
                destination.copy_from_slice(&data.bytes);
                self.store.dropped_data[index] = true;
            }
        }

        if let Some(start) = program.start {
            self.fuel = self.config.fuel;
            self.run(host, start, Vec::new(), 0)?;
        }
        Ok(())
    }

    /// The references an element segment holds now: none once it is dropped.
    fn element_references(&mut self, id: ElementId) -> Result<Vec<Ref>, Fault> {
        let program = self.program;
        let element = program
            .elements
            .get(id.index())
            .ok_or_else(|| invalid(format!("no {id}")))?;
        if self.store.dropped_elements[id.index()] {
            return Ok(Vec::new());
        }
        element
            .items
            .iter()
            .map(|item| match item {
                ElementItem::Function(function) => Ok(Ref::Func(*function)),
                ElementItem::Expression(expression) => match self.evaluate_const(expression)? {
                    Value::Ref(reference) => Ok(reference),
                    other => Err(invalid(format!("element expression gave {other}"))),
                },
            })
            .collect()
    }

    /// The bytes a data segment holds now: none once it is dropped.
    fn data_bytes(&self, id: DataId) -> Result<&'program [u8], Fault> {
        let data = self
            .program
            .data
            .get(id.index())
            .ok_or_else(|| invalid(format!("no {id}")))?;
        Ok(if self.store.dropped_data[id.index()] {
            &[]
        } else {
            &data.bytes
        })
    }

    /// Evaluates a constant expression in stack form. Constant operators
    /// never call, so no host is involved.
    fn evaluate_const(&mut self, expression: &ConstExpr) -> Result<Value, Fault> {
        let mut host = NoHost;
        let mut stack: Vec<Value> = Vec::new();
        for instruction in &expression.instructions {
            let arity = instruction.operation.signature.params.len();
            if stack.len() < arity {
                return Err(invalid(format!(
                    "constant {} underflows its stack",
                    instruction.operation.mnemonic()
                )));
            }
            let operands = stack.split_off(stack.len() - arity);
            let results = self.execute_operation(
                &mut host,
                &instruction.operation,
                &Operands::Direct(&operands),
            )?;
            results.extend_into(&mut stack);
        }
        match stack.as_slice() {
            [value] => Ok(value.clone()),
            other => Err(invalid(format!(
                "constant expression left {} values",
                other.len()
            ))),
        }
    }

    /// Charges `cost` instructions and terminators to the fuel budget.
    #[inline(always)]
    fn charge(&mut self, cost: u64) -> Result<(), Fault> {
        self.fuel = self.fuel.checked_sub(cost).ok_or(Fault::OutOfFuel)?;
        Ok(())
    }

    /// Runs `function` on `arguments` at call depth `depth`, restoring the
    /// caller's depth afterwards.
    pub(super) fn run(
        &mut self,
        host: &mut dyn Host,
        function: FunctionId,
        arguments: Vec<Value>,
        depth: usize,
    ) -> Result<Vec<Value>, Fault> {
        if depth > self.config.max_call_depth {
            return Err(Fault::CallDepthExceeded);
        }
        let caller = std::mem::replace(&mut self.depth, depth);
        let mut frame = self.frames.pop().unwrap_or_default();
        let result = self.run_in(host, &mut frame, function, arguments);
        self.frames.push(frame);
        self.depth = caller;
        result
    }

    /// Runs `function` in `frame`. A tail call replaces the activation
    /// without deepening the Rust stack.
    fn run_in(
        &mut self,
        host: &mut dyn Host,
        frame: &mut Frame,
        mut function: FunctionId,
        mut arguments: Vec<Value>,
    ) -> Result<Vec<Value>, Fault> {
        let program = self.program;
        loop {
            let definition = program
                .functions
                .get(function.index())
                .ok_or_else(|| invalid(format!("no {function}")))?;
            let Some(body) = &definition.body else {
                let EntityOrigin::Imported(import) = definition.origin else {
                    return Err(invalid(format!(
                        "{function} has neither a body nor an import"
                    )));
                };
                let import = program
                    .imports
                    .get(import.index())
                    .ok_or_else(|| invalid(format!("no {import}")))?;
                return host.call(self, import, &arguments);
            };

            frame.reset(self.value_counts[function.index()]);
            let entry = block_of(body, body.entry)?;
            frame.bind(&entry.parameters, 0, &arguments)?;
            let mut current = body.entry;
            loop {
                let block = block_of(body, current)?;
                self.charge(block.instructions.len() as u64 + 1)?;
                for instruction in &block.instructions {
                    self.execute_instruction(host, frame, instruction)?;
                }
                match self.execute_terminator(host, body, frame, &block.terminator)? {
                    Control::Jump(next) => current = next,
                    Control::Return(values) => return Ok(values),
                    Control::TailCall(callee, values) => {
                        function = callee;
                        arguments = values;
                        break;
                    }
                }
            }
        }
    }

    fn execute_instruction(
        &mut self,
        host: &mut dyn Host,
        frame: &mut Frame,
        instruction: &crate::ir::Instruction,
    ) -> Result<(), Fault> {
        let operands = Operands::Indexed {
            values: &frame.values,
            ids: &instruction.operands,
        };
        let results = self.execute_operation(host, &instruction.operation, &operands)?;
        if results.len() != instruction.results.len() {
            return Err(invalid(format!(
                "{} produced {} results for {} definitions",
                instruction.operation.mnemonic(),
                results.len(),
                instruction.results.len()
            )));
        }
        match results {
            Values::None => {}
            Values::One(value) => frame.set(instruction.results[0].id, value)?,
            Values::Many(values) => {
                for (definition, value) in instruction.results.iter().zip(values) {
                    frame.set(definition.id, value)?;
                }
            }
        }
        Ok(())
    }

    fn execute_terminator(
        &mut self,
        host: &mut dyn Host,
        body: &FunctionBody,
        frame: &mut Frame,
        terminator: &Terminator,
    ) -> Result<Control, Fault> {
        match &terminator.kind {
            TerminatorKind::Jump(edge) => self.deliver(body, frame, edge, Values::None),
            TerminatorKind::Branch {
                condition,
                then_edge,
                else_edge,
            } => {
                let taken = numeric::i32(&frame.get(*condition)?)? != 0;
                self.deliver(
                    body,
                    frame,
                    if taken { then_edge } else { else_edge },
                    Values::None,
                )
            }
            TerminatorKind::Switch {
                selector,
                targets,
                default,
            } => {
                let index = numeric::i32(&frame.get(*selector)?)? as usize;
                let edge = targets.get(index).unwrap_or(default);
                self.deliver(body, frame, edge, Values::None)
            }
            TerminatorKind::Invoke {
                operation,
                operands,
                normal,
                ..
            } => {
                let operands = Operands::Indexed {
                    values: &frame.values,
                    ids: operands,
                };
                match self.execute_operation(host, operation, &operands) {
                    Ok(results) => self.deliver(body, frame, normal, results),
                    Err(Fault::Exception(exception)) => {
                        self.dispatch_exception(body, frame, terminator, exception)
                    }
                    Err(fault) => Err(fault),
                }
            }
            TerminatorKind::Return { values } => Ok(Control::Return(
                values
                    .iter()
                    .map(|value| frame.get(*value))
                    .collect::<Result<_, _>>()?,
            )),
            TerminatorKind::TailCall { callee, arguments } => {
                let arguments = arguments
                    .iter()
                    .map(|argument| frame.get(*argument))
                    .collect::<Result<Vec<_>, _>>()?;
                let callee = self.resolve_callee(frame, callee)?;
                Ok(Control::TailCall(callee, arguments))
            }
            TerminatorKind::Throw { tag, arguments } => {
                let payload = arguments
                    .iter()
                    .map(|argument| frame.get(*argument))
                    .collect::<Result<Vec<_>, _>>()?;
                let exception = self.store.allocate_exception(*tag, payload);
                self.dispatch_exception(body, frame, terminator, exception)
            }
            TerminatorKind::ThrowRef { exception } => match frame.get(*exception)? {
                Value::Ref(Ref::Exn(exception)) => {
                    self.dispatch_exception(body, frame, terminator, exception)
                }
                Value::Ref(Ref::Null) => Err(trap(TrapCode::NullReference)),
                other => Err(invalid(format!("throw_ref of {other}"))),
            },
            TerminatorKind::Unreachable { trap: code } => Err(trap(code.clone())),
        }
    }

    /// Follows `edge`: the target's leading parameters take `leading`, the
    /// rest take the edge's arguments. Arguments are all read before any
    /// parameter is written, so an edge may permute its target's own
    /// parameters.
    fn deliver(
        &self,
        body: &FunctionBody,
        frame: &mut Frame,
        edge: &Edge,
        leading: Values,
    ) -> Result<Control, Fault> {
        let target = block_of(body, edge.target)?;
        let arguments = frame.gather(&edge.arguments)?;
        let bound = Self::bind_edge(frame, &target.parameters, leading, &arguments);
        frame.restore(arguments);
        bound?;
        Ok(Control::Jump(edge.target))
    }

    fn bind_edge(
        frame: &mut Frame,
        parameters: &[ValueDefinition],
        leading: Values,
        arguments: &[Value],
    ) -> Result<(), Fault> {
        let count = leading.len();
        if count > parameters.len() {
            return Err(invalid(format!(
                "{count} leading values delivered to {} parameters",
                parameters.len()
            )));
        }
        frame.bind(parameters, count, arguments)?;
        match leading {
            Values::None => {}
            Values::One(value) => frame.set(parameters[0].id, value)?,
            Values::Many(values) => {
                for (parameter, value) in parameters.iter().zip(values) {
                    frame.set(parameter.id, value)?;
                }
            }
        }
        Ok(())
    }

    /// Routes `exception` through the terminator's arms in order; an arm
    /// whose clause matches the exception's tag receives it. Nothing
    /// matching means the exception leaves the function.
    fn dispatch_exception(
        &mut self,
        body: &FunctionBody,
        frame: &mut Frame,
        terminator: &Terminator,
        exception: ExceptionId,
    ) -> Result<Control, Fault> {
        let routing: Option<&ExceptionRouting> = terminator.exception.as_ref();
        let thrown = self
            .store
            .exception(exception)
            .ok_or_else(|| invalid(format!("no exception {}", exception.0)))?
            .clone();
        for arm in routing.map_or(&[][..], |routing| routing.arms.as_slice()) {
            let region = region_of(body, arm.handler)?;
            let RegionKind::TryTable { catches } = &region.kind else {
                return Err(invalid(format!("{} is not a try_table", arm.handler)));
            };
            let clause = catches
                .get(arm.clause as usize)
                .ok_or_else(|| invalid(format!("{} has no clause {}", arm.handler, arm.clause)))?;
            let matches = match clause.kind {
                crate::ir::CatchKind::CatchAll | crate::ir::CatchKind::CatchAllRef => true,
                crate::ir::CatchKind::Catch | crate::ir::CatchKind::CatchRef => {
                    clause.tag == Some(thrown.tag)
                }
            };
            if !matches {
                continue;
            }
            let values = arm
                .arguments
                .iter()
                .map(|argument| match argument {
                    ExceptionalArgument::Value(value) => frame.get(*value),
                    ExceptionalArgument::CaughtPayload { index, .. } => thrown
                        .payload
                        .get(*index as usize)
                        .cloned()
                        .ok_or_else(|| invalid(format!("the exception has no payload {index}"))),
                    ExceptionalArgument::CaughtException => Ok(Value::Ref(Ref::Exn(exception))),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let target = block_of(body, arm.target)?;
            frame.bind(&target.parameters, 0, &values)?;
            return Ok(Control::Jump(arm.target));
        }
        Err(Fault::Exception(exception))
    }

    fn resolve_callee(&self, frame: &Frame, callee: &Callee) -> Result<FunctionId, Fault> {
        match callee {
            Callee::Direct(function) => Ok(*function),
            Callee::Indirect { ty, table, index } => {
                self.indirect_callee(*table, *ty, &frame.get(*index)?)
            }
            Callee::Reference { reference, .. } => self.reference_callee(&frame.get(*reference)?),
        }
    }

    /// The function `table[index]` names, checked against `expected`.
    fn indirect_callee(
        &self,
        table: TableId,
        expected: TypeId,
        index: &Value,
    ) -> Result<FunctionId, Fault> {
        let index = address(index)?;
        let table = self.table(table)?;
        let entry = table
            .elements
            .get(index as usize)
            .ok_or_else(|| trap(TrapCode::TableOutOfBounds))?;
        let function = match entry {
            Ref::Null => return Err(trap(TrapCode::NullFunctionReference)),
            Ref::Func(function) => *function,
            other => return Err(invalid(format!("table entry {other} is not a function"))),
        };
        let actual = self
            .program
            .functions
            .get(function.index())
            .ok_or_else(|| invalid(format!("no {function}")))?
            .ty;
        if !is_nominal_type_subtype(&self.program.types, actual, expected) {
            return Err(trap(TrapCode::IndirectCallTypeMismatch));
        }
        Ok(function)
    }

    fn reference_callee(&self, reference: &Value) -> Result<FunctionId, Fault> {
        match numeric::reference(reference)? {
            Ref::Null => Err(trap(TrapCode::NullFunctionReference)),
            Ref::Func(function) => Ok(*function),
            other => Err(invalid(format!("call_ref of {other}"))),
        }
    }

    fn memory(&self, id: MemoryId) -> Result<&Memory, Fault> {
        self.store
            .memories
            .get(id.index())
            .ok_or_else(|| invalid(format!("no {id}")))
    }

    fn memory_mut(&mut self, id: MemoryId) -> Result<&mut Memory, Fault> {
        self.store
            .memories
            .get_mut(id.index())
            .ok_or_else(|| invalid(format!("no {id}")))
    }

    fn table(&self, id: TableId) -> Result<&Table, Fault> {
        self.store
            .tables
            .get(id.index())
            .ok_or_else(|| invalid(format!("no {id}")))
    }

    fn table_mut(&mut self, id: TableId) -> Result<&mut Table, Fault> {
        self.store
            .tables
            .get_mut(id.index())
            .ok_or_else(|| invalid(format!("no {id}")))
    }

    fn effective_address(memarg: &MemoryArgument, base: &Value) -> Result<u64, Fault> {
        address(base)?
            .checked_add(memarg.offset)
            .ok_or_else(|| trap(TrapCode::MemoryOutOfBounds))
    }

    /// The `N` bytes a load addresses.
    fn load_bytes<const N: usize>(
        &self,
        memarg: &MemoryArgument,
        base: &Value,
    ) -> Result<[u8; N], Fault> {
        let address = Self::effective_address(memarg, base)?;
        self.memory(memarg.memory)?
            .slice(address, N)
            .map(|bytes| bytes.try_into().expect("exact length"))
            .ok_or_else(|| trap(TrapCode::MemoryOutOfBounds))
    }

    fn store_bytes(
        &mut self,
        memarg: &MemoryArgument,
        base: &Value,
        bytes: &[u8],
    ) -> Result<(), Fault> {
        let address = Self::effective_address(memarg, base)?;
        self.memory_mut(memarg.memory)?
            .slice_mut(address, bytes.len())
            .ok_or_else(|| trap(TrapCode::MemoryOutOfBounds))?
            .copy_from_slice(bytes);
        Ok(())
    }

    fn struct_fields(&self, ty: TypeId) -> Result<&'program [FieldType], Fault> {
        match self
            .program
            .types
            .get(ty.index())
            .map(|definition| &definition.composite)
        {
            Some(CompositeType::Struct(fields)) => Ok(fields),
            _ => Err(invalid(format!("{ty} is not a struct type"))),
        }
    }

    fn array_element(&self, ty: TypeId) -> Result<&'program FieldType, Fault> {
        match self
            .program
            .types
            .get(ty.index())
            .map(|definition| &definition.composite)
        {
            Some(CompositeType::Array(element)) => Ok(element),
            _ => Err(invalid(format!("{ty} is not an array type"))),
        }
    }

    fn object_fields(&self, reference: &Ref) -> Result<&[Value], Fault> {
        match reference {
            Ref::Null => Err(trap(TrapCode::NullReference)),
            Ref::Struct(object) | Ref::Array(object) => self
                .store
                .object(*object)
                .map(|object| object.fields.as_slice())
                .ok_or_else(|| invalid(format!("no object {}", object.0))),
            other => Err(invalid(format!("{other} is not a managed object"))),
        }
    }

    fn object_fields_mut(&mut self, reference: &Ref) -> Result<&mut Vec<Value>, Fault> {
        match reference {
            Ref::Null => Err(trap(TrapCode::NullReference)),
            Ref::Struct(object) | Ref::Array(object) => self
                .store
                .object_mut(*object)
                .map(|object| &mut object.fields)
                .ok_or_else(|| invalid(format!("no object {}", object.0))),
            other => Err(invalid(format!("{other} is not a managed object"))),
        }
    }

    fn allocate_array(&mut self, ty: TypeId, elements: Vec<Value>) -> Result<Values, Fault> {
        if elements.len() > self.config.max_array_elements as usize {
            return Err(trap(TrapCode::AllocationFailure));
        }
        Ok(Values::One(Value::Ref(Ref::Array(
            self.store.allocate_object(ty, elements),
        ))))
    }

    /// Decodes `count` elements of the array type `ty` from `bytes`, the
    /// contents of a data segment.
    fn array_elements_from_bytes(&self, ty: TypeId, bytes: &[u8]) -> Result<Vec<Value>, Fault> {
        let storage = &self.array_element(ty)?.storage;
        let width = match storage {
            StorageType::I8 => 1,
            StorageType::I16 => 2,
            StorageType::Value(ValueType::I32) | StorageType::Value(ValueType::F32) => 4,
            StorageType::Value(ValueType::I64) | StorageType::Value(ValueType::F64) => 8,
            StorageType::Value(ValueType::V128) => 16,
            StorageType::Value(ValueType::Ref(_)) => {
                return Err(invalid(format!("{ty} holds references, not bytes")));
            }
        };
        Ok(bytes
            .chunks_exact(width)
            .map(|chunk| match storage {
                StorageType::I8 => Value::I32(u32::from(chunk[0])),
                StorageType::I16 => Value::I32(u32::from(u16::from_le_bytes([chunk[0], chunk[1]]))),
                StorageType::Value(ValueType::I32) => {
                    Value::I32(u32::from_le_bytes(chunk.try_into().expect("width")))
                }
                StorageType::Value(ValueType::F32) => {
                    Value::F32(u32::from_le_bytes(chunk.try_into().expect("width")))
                }
                StorageType::Value(ValueType::I64) => {
                    Value::I64(u64::from_le_bytes(chunk.try_into().expect("width")))
                }
                StorageType::Value(ValueType::F64) => {
                    Value::F64(u64::from_le_bytes(chunk.try_into().expect("width")))
                }
                StorageType::Value(ValueType::V128) => {
                    Value::V128(chunk.try_into().expect("width"))
                }
                StorageType::Value(ValueType::Ref(_)) => unreachable!("rejected above"),
            })
            .collect())
    }

    /// `count` elements of the array type `ty` starting `offset` elements
    /// into data segment `data`, or a trap when the segment is shorter.
    fn array_elements_from_data(
        &self,
        ty: TypeId,
        data: DataId,
        offset: u64,
        count: u64,
    ) -> Result<Vec<Value>, Fault> {
        let width = match &self.array_element(ty)?.storage {
            StorageType::I8 => 1,
            StorageType::I16 => 2,
            StorageType::Value(ValueType::I32) | StorageType::Value(ValueType::F32) => 4,
            StorageType::Value(ValueType::I64) | StorageType::Value(ValueType::F64) => 8,
            StorageType::Value(ValueType::V128) => 16,
            StorageType::Value(ValueType::Ref(_)) => {
                return Err(invalid(format!("{ty} holds references, not bytes")));
            }
        };
        let bytes = self.data_bytes(data)?;
        let len = count
            .checked_mul(width)
            .ok_or_else(|| trap(TrapCode::BadArrayElement))?;
        checked_range(offset, len, bytes.len() as u64)
            .ok_or_else(|| trap(TrapCode::BadArrayElement))?;
        self.array_elements_from_bytes(ty, &bytes[offset as usize..(offset + len) as usize])
    }

    /// `count` references starting `offset` items into element segment
    /// `element`.
    fn array_elements_from_segment(
        &mut self,
        element: ElementId,
        offset: u64,
        count: u64,
    ) -> Result<Vec<Value>, Fault> {
        let references = self.element_references(element)?;
        checked_range(offset, count, references.len() as u64)
            .ok_or_else(|| trap(TrapCode::BadArrayElement))?;
        Ok(references[offset as usize..(offset + count) as usize]
            .iter()
            .cloned()
            .map(Value::Ref)
            .collect())
    }

    /// Whether `reference` may be viewed as `(ref null? target)`.
    fn ref_test(&self, reference: &Ref, target: &HeapType, nullable: bool) -> bool {
        match reference {
            Ref::Null => nullable,
            Ref::Extern(_) => matches!(target, HeapType::Extern | HeapType::Any),
            Ref::Externalized(_) => matches!(target, HeapType::Extern),
            other => self
                .runtime_heap_type(other)
                .is_some_and(|actual| is_heap_subtype(&self.program.types, &actual, target)),
        }
    }

    /// Executes one operation. Calls recurse from here, one level deeper.
    pub(super) fn execute_operation(
        &mut self,
        host: &mut dyn Host,
        operation: &Operation,
        a: &Operands<'_>,
    ) -> Result<Values, Fault> {
        let OperationKind::Core(opcode) = operation.kind else {
            return Err(Fault::Unsupported(format!(
                "synthetic operation {}",
                operation.mnemonic()
            )));
        };
        if let Some(value) = evaluate_pure(operation, a)? {
            return Ok(Values::One(value));
        }

        use CoreOpcode::*;
        let one = |value: Value| Ok(Values::One(value));
        let memarg = || memarg_immediate(operation, 0);

        match opcode {
            Nop | Drop => Ok(Values::None),

            Call => {
                let callee = function_immediate(operation, 0)?;
                self.run(host, callee, a.to_vec()?, self.depth + 1)
                    .map(Values::Many)
            }
            CallIndirect => {
                let ty = type_immediate(operation, 0)?;
                let table = table_immediate(operation, 1)?;
                let (arguments, index) = split_callee(a, "call_indirect")?;
                let callee = self.indirect_callee(table, ty, &index)?;
                self.run(host, callee, arguments, self.depth + 1)
                    .map(Values::Many)
            }
            CallRef => {
                let (arguments, reference) = split_callee(a, "call_ref")?;
                let callee = self.reference_callee(&reference)?;
                self.run(host, callee, arguments, self.depth + 1)
                    .map(Values::Many)
            }

            GlobalGet => {
                let global = global_immediate(operation, 0)?;
                one(self
                    .store
                    .globals
                    .get(global.index())
                    .cloned()
                    .ok_or_else(|| invalid(format!("no {global}")))?)
            }
            GlobalSet => {
                let global = global_immediate(operation, 0)?;
                let slot = self
                    .store
                    .globals
                    .get_mut(global.index())
                    .ok_or_else(|| invalid(format!("no {global}")))?;
                *slot = *a.get(0)?;
                Ok(Values::None)
            }

            I32Load => one(Value::I32(u32::from_le_bytes(
                self.load_bytes(&memarg()?, a.get(0)?)?,
            ))),
            I64Load => one(Value::I64(u64::from_le_bytes(
                self.load_bytes(&memarg()?, a.get(0)?)?,
            ))),
            F32Load => one(Value::F32(u32::from_le_bytes(
                self.load_bytes(&memarg()?, a.get(0)?)?,
            ))),
            F64Load => one(Value::F64(u64::from_le_bytes(
                self.load_bytes(&memarg()?, a.get(0)?)?,
            ))),
            I32Load8S => one(Value::I32(
                i8::from_le_bytes(self.load_bytes(&memarg()?, a.get(0)?)?) as i32 as u32,
            )),
            I32Load8U => one(Value::I32(u32::from(u8::from_le_bytes(
                self.load_bytes(&memarg()?, a.get(0)?)?,
            )))),
            I32Load16S => one(Value::I32(
                i16::from_le_bytes(self.load_bytes(&memarg()?, a.get(0)?)?) as i32 as u32,
            )),
            I32Load16U => one(Value::I32(u32::from(u16::from_le_bytes(
                self.load_bytes(&memarg()?, a.get(0)?)?,
            )))),
            I64Load8S => one(Value::I64(
                i8::from_le_bytes(self.load_bytes(&memarg()?, a.get(0)?)?) as i64 as u64,
            )),
            I64Load8U => one(Value::I64(u64::from(u8::from_le_bytes(
                self.load_bytes(&memarg()?, a.get(0)?)?,
            )))),
            I64Load16S => one(Value::I64(
                i16::from_le_bytes(self.load_bytes(&memarg()?, a.get(0)?)?) as i64 as u64,
            )),
            I64Load16U => one(Value::I64(u64::from(u16::from_le_bytes(
                self.load_bytes(&memarg()?, a.get(0)?)?,
            )))),
            I64Load32S => one(Value::I64(
                i32::from_le_bytes(self.load_bytes(&memarg()?, a.get(0)?)?) as i64 as u64,
            )),
            I64Load32U => one(Value::I64(u64::from(u32::from_le_bytes(
                self.load_bytes(&memarg()?, a.get(0)?)?,
            )))),
            I32Store | F32Store => {
                let bits = match a.get(1)? {
                    Value::I32(bits) | Value::F32(bits) => *bits,
                    other => return Err(invalid(format!("32-bit store of {other}"))),
                };
                self.store_bytes(&memarg()?, a.get(0)?, &bits.to_le_bytes())?;
                Ok(Values::None)
            }
            I64Store | F64Store => {
                let bits = match a.get(1)? {
                    Value::I64(bits) | Value::F64(bits) => *bits,
                    other => return Err(invalid(format!("64-bit store of {other}"))),
                };
                self.store_bytes(&memarg()?, a.get(0)?, &bits.to_le_bytes())?;
                Ok(Values::None)
            }
            I32Store8 => {
                let bits = a.i32(1)? as u8;
                self.store_bytes(&memarg()?, a.get(0)?, &bits.to_le_bytes())?;
                Ok(Values::None)
            }
            I32Store16 => {
                let bits = a.i32(1)? as u16;
                self.store_bytes(&memarg()?, a.get(0)?, &bits.to_le_bytes())?;
                Ok(Values::None)
            }
            I64Store8 => {
                let bits = a.i64(1)? as u8;
                self.store_bytes(&memarg()?, a.get(0)?, &bits.to_le_bytes())?;
                Ok(Values::None)
            }
            I64Store16 => {
                let bits = a.i64(1)? as u16;
                self.store_bytes(&memarg()?, a.get(0)?, &bits.to_le_bytes())?;
                Ok(Values::None)
            }
            I64Store32 => {
                let bits = a.i64(1)? as u32;
                self.store_bytes(&memarg()?, a.get(0)?, &bits.to_le_bytes())?;
                Ok(Values::None)
            }

            V128Load => one(Value::V128(self.load_bytes(&memarg()?, a.get(0)?)?)),
            V128Load8x8S | V128Load8x8U | V128Load16x4S | V128Load16x4U | V128Load32x2S
            | V128Load32x2U => one(Value::V128(simd::load_extend(
                opcode,
                self.load_bytes::<8>(&memarg()?, a.get(0)?)?,
            ))),
            V128Load8Splat => one(Value::V128(simd::splat_bytes(
                &self.load_bytes::<1>(&memarg()?, a.get(0)?)?,
            ))),
            V128Load16Splat => one(Value::V128(simd::splat_bytes(
                &self.load_bytes::<2>(&memarg()?, a.get(0)?)?,
            ))),
            V128Load32Splat => one(Value::V128(simd::splat_bytes(
                &self.load_bytes::<4>(&memarg()?, a.get(0)?)?,
            ))),
            V128Load64Splat => one(Value::V128(simd::splat_bytes(
                &self.load_bytes::<8>(&memarg()?, a.get(0)?)?,
            ))),
            V128Load32Zero => one(Value::V128(simd::zero_extend_bytes(
                &self.load_bytes::<4>(&memarg()?, a.get(0)?)?,
            ))),
            V128Load64Zero => one(Value::V128(simd::zero_extend_bytes(
                &self.load_bytes::<8>(&memarg()?, a.get(0)?)?,
            ))),
            V128Store => {
                let bytes = a.v128(1)?;
                self.store_bytes(&memarg()?, a.get(0)?, &bytes)?;
                Ok(Values::None)
            }
            V128Load8Lane | V128Load16Lane | V128Load32Lane | V128Load64Lane => {
                let width = match opcode {
                    V128Load8Lane => 1,
                    V128Load16Lane => 2,
                    V128Load32Lane => 4,
                    _ => 8,
                };
                let memarg = memarg()?;
                let lane = match immediate(operation, 1)? {
                    Immediate::Lane(lane) => usize::from(*lane),
                    other => return Err(invalid(format!("lane load with {other:?}"))),
                };
                let address = Self::effective_address(&memarg, a.get(0)?)?;
                let bytes = self
                    .memory(memarg.memory)?
                    .slice(address, width)
                    .ok_or_else(|| trap(TrapCode::MemoryOutOfBounds))?
                    .to_vec();
                one(Value::V128(simd::replace_lane_bytes(
                    a.v128(1)?,
                    lane,
                    &bytes,
                )?))
            }
            V128Store8Lane | V128Store16Lane | V128Store32Lane | V128Store64Lane => {
                let width = match opcode {
                    V128Store8Lane => 1,
                    V128Store16Lane => 2,
                    V128Store32Lane => 4,
                    _ => 8,
                };
                let lane = match immediate(operation, 1)? {
                    Immediate::Lane(lane) => usize::from(*lane),
                    other => return Err(invalid(format!("lane store with {other:?}"))),
                };
                let vector = a.v128(1)?;
                let bytes = simd::lane_bytes(&vector, lane, width)?.to_vec();
                self.store_bytes(&memarg()?, a.get(0)?, &bytes)?;
                Ok(Values::None)
            }

            MemorySize => {
                let memory = self.memory(memory_immediate(operation, 0)?)?;
                one(size_result(memory.address_type, memory.pages()))
            }
            MemoryGrow => {
                let delta = a.address(0)?;
                let limit = self.config.max_memory_bytes;
                let memory = self.memory_mut(memory_immediate(operation, 0)?)?;
                let address_type = memory.address_type;
                one(match memory.grow(delta, limit) {
                    Some(old) => size_result(address_type, old),
                    None => failed_growth(address_type),
                })
            }
            MemoryFill => {
                let (destination, value, count) = (a.address(0)?, a.i32(1)? as u8, a.address(2)?);
                let memory = self.memory_mut(memory_immediate(operation, 0)?)?;
                checked_range(destination, count, memory.bytes.len() as u64)
                    .ok_or_else(|| trap(TrapCode::MemoryOutOfBounds))?;
                memory.bytes[destination as usize..(destination + count) as usize].fill(value);
                Ok(Values::None)
            }
            MemoryCopy => {
                let (destination, source, count) = (a.address(0)?, a.address(1)?, a.address(2)?);
                let destination_memory = memory_immediate(operation, 0)?;
                let source_memory = memory_immediate(operation, 1)?;
                checked_range(
                    source,
                    count,
                    self.memory(source_memory)?.bytes.len() as u64,
                )
                .ok_or_else(|| trap(TrapCode::MemoryOutOfBounds))?;
                checked_range(
                    destination,
                    count,
                    self.memory(destination_memory)?.bytes.len() as u64,
                )
                .ok_or_else(|| trap(TrapCode::MemoryOutOfBounds))?;
                let bytes = self.memory(source_memory)?.bytes
                    [source as usize..(source + count) as usize]
                    .to_vec();
                self.memory_mut(destination_memory)?.bytes
                    [destination as usize..(destination + count) as usize]
                    .copy_from_slice(&bytes);
                Ok(Values::None)
            }
            MemoryInit => {
                let (destination, source, count) = (a.address(0)?, a.address(1)?, a.address(2)?);
                let data = data_immediate(operation, 0)?;
                let memory = memory_immediate(operation, 1)?;
                let bytes = self.data_bytes(data)?;
                checked_range(source, count, bytes.len() as u64)
                    .ok_or_else(|| trap(TrapCode::MemoryOutOfBounds))?;
                let memory = self.memory_mut(memory)?;
                checked_range(destination, count, memory.bytes.len() as u64)
                    .ok_or_else(|| trap(TrapCode::MemoryOutOfBounds))?;
                memory.bytes[destination as usize..(destination + count) as usize]
                    .copy_from_slice(&bytes[source as usize..(source + count) as usize]);
                Ok(Values::None)
            }
            DataDrop => {
                let data = data_immediate(operation, 0)?;
                match self.store.dropped_data.get_mut(data.index()) {
                    Some(dropped) => *dropped = true,
                    None => return Err(invalid(format!("no {data}"))),
                }
                Ok(Values::None)
            }

            TableGet => {
                let index = a.address(0)?;
                let table = self.table(table_immediate(operation, 0)?)?;
                one(Value::Ref(
                    table
                        .elements
                        .get(index as usize)
                        .cloned()
                        .ok_or_else(|| trap(TrapCode::TableOutOfBounds))?,
                ))
            }
            TableSet => {
                let index = a.address(0)?;
                let value = *a.reference(1)?;
                let table = self.table_mut(table_immediate(operation, 0)?)?;
                let slot = table
                    .elements
                    .get_mut(index as usize)
                    .ok_or_else(|| trap(TrapCode::TableOutOfBounds))?;
                *slot = value;
                Ok(Values::None)
            }
            TableSize => {
                let table = self.table(table_immediate(operation, 0)?)?;
                one(size_result(table.address_type, table.elements.len() as u64))
            }
            TableGrow => {
                let init = *a.reference(0)?;
                let delta = a.address(1)?;
                let limit = self.config.max_table_elements;
                let table = self.table_mut(table_immediate(operation, 0)?)?;
                let address_type = table.address_type;
                one(match table.grow(delta, init, limit) {
                    Some(old) => size_result(address_type, old),
                    None => failed_growth(address_type),
                })
            }
            TableFill => {
                let (start, value, count) = (a.address(0)?, *a.reference(1)?, a.address(2)?);
                let table = self.table_mut(table_immediate(operation, 0)?)?;
                checked_range(start, count, table.elements.len() as u64)
                    .ok_or_else(|| trap(TrapCode::TableOutOfBounds))?;
                table.elements[start as usize..(start + count) as usize].fill(value);
                Ok(Values::None)
            }
            TableCopy => {
                let (destination, source, count) = (a.address(0)?, a.address(1)?, a.address(2)?);
                let destination_table = table_immediate(operation, 0)?;
                let source_table = table_immediate(operation, 1)?;
                checked_range(
                    source,
                    count,
                    self.table(source_table)?.elements.len() as u64,
                )
                .ok_or_else(|| trap(TrapCode::TableOutOfBounds))?;
                checked_range(
                    destination,
                    count,
                    self.table(destination_table)?.elements.len() as u64,
                )
                .ok_or_else(|| trap(TrapCode::TableOutOfBounds))?;
                let references = self.table(source_table)?.elements
                    [source as usize..(source + count) as usize]
                    .to_vec();
                self.table_mut(destination_table)?.elements
                    [destination as usize..(destination + count) as usize]
                    .clone_from_slice(&references);
                Ok(Values::None)
            }
            TableInit => {
                let (destination, source, count) = (a.address(0)?, a.address(1)?, a.address(2)?);
                let element = element_immediate(operation, 0)?;
                let table = table_immediate(operation, 1)?;
                let references = self.element_references(element)?;
                checked_range(source, count, references.len() as u64)
                    .ok_or_else(|| trap(TrapCode::TableOutOfBounds))?;
                let table = self.table_mut(table)?;
                checked_range(destination, count, table.elements.len() as u64)
                    .ok_or_else(|| trap(TrapCode::TableOutOfBounds))?;
                table.elements[destination as usize..(destination + count) as usize]
                    .clone_from_slice(&references[source as usize..(source + count) as usize]);
                Ok(Values::None)
            }
            ElemDrop => {
                let element = element_immediate(operation, 0)?;
                match self.store.dropped_elements.get_mut(element.index()) {
                    Some(dropped) => *dropped = true,
                    None => return Err(invalid(format!("no {element}"))),
                }
                Ok(Values::None)
            }

            RefNull => one(Value::Ref(Ref::Null)),
            RefIsNull => one(Value::I32(u32::from(a.reference(0)?.is_null()))),
            RefFunc => one(Value::Ref(Ref::Func(function_immediate(operation, 0)?))),
            RefAsNonNull => match a.reference(0)? {
                Ref::Null => Err(trap(TrapCode::NullReference)),
                reference => one(Value::Ref(*reference)),
            },
            RefEq => one(Value::I32(u32::from(a.reference(0)? == a.reference(1)?))),
            RefTestNonNull | RefTestNullable => {
                let target = heap_type_immediate(operation, 0)?;
                let nullable = opcode == RefTestNullable;
                one(Value::I32(u32::from(self.ref_test(
                    a.reference(0)?,
                    &target,
                    nullable,
                ))))
            }
            RefCastNonNull | RefCastNullable => {
                let target = heap_type_immediate(operation, 0)?;
                let nullable = opcode == RefCastNullable;
                let reference = a.reference(0)?;
                if self.ref_test(reference, &target, nullable) {
                    one(Value::Ref(*reference))
                } else if reference.is_null() {
                    Err(trap(TrapCode::NullReference))
                } else {
                    Err(trap(TrapCode::Other("cast-failure".to_owned())))
                }
            }
            AnyConvertExtern => one(Value::Ref(match *a.reference(0)? {
                Ref::Externalized(id) => self
                    .store
                    .externalized(id)
                    .ok_or_else(|| invalid(format!("no externalized reference {}", id.0)))?,
                other => other,
            })),
            ExternConvertAny => one(Value::Ref(match *a.reference(0)? {
                Ref::Null => Ref::Null,
                external @ Ref::Extern(_) => external,
                internal => Ref::Externalized(self.store.externalize(internal)),
            })),
            RefI31 => one(Value::Ref(Ref::I31(a.i32(0)? & 0x7fff_ffff))),
            I31GetS => match a.reference(0)? {
                Ref::Null => Err(trap(TrapCode::NullReference)),
                Ref::I31(value) => one(Value::I32(((*value << 1) as i32 >> 1) as u32)),
                other => Err(invalid(format!("i31.get_s of {other}"))),
            },
            I31GetU => match a.reference(0)? {
                Ref::Null => Err(trap(TrapCode::NullReference)),
                Ref::I31(value) => one(Value::I32(*value & 0x7fff_ffff)),
                other => Err(invalid(format!("i31.get_u of {other}"))),
            },

            StructNew => {
                let ty = type_immediate(operation, 0)?;
                let fields = self.struct_fields(ty)?;
                if fields.len() != a.len() {
                    return Err(invalid(format!(
                        "struct.new of {ty} takes {} fields, given {}",
                        fields.len(),
                        a.len()
                    )));
                }
                let values = fields
                    .iter()
                    .zip(a.to_vec()?)
                    .map(|(field, value)| pack(&field.storage, value))
                    .collect::<Result<Vec<_>, _>>()?;
                one(Value::Ref(Ref::Struct(
                    self.store.allocate_object(ty, values),
                )))
            }
            StructNewDefault => {
                let ty = type_immediate(operation, 0)?;
                let values = self
                    .struct_fields(ty)?
                    .iter()
                    .map(|field| default_field(&field.storage))
                    .collect();
                one(Value::Ref(Ref::Struct(
                    self.store.allocate_object(ty, values),
                )))
            }
            StructGet | StructGetS | StructGetU => {
                let ty = type_immediate(operation, 0)?;
                let field = u32_immediate(operation, 1)? as usize;
                let storage = &self
                    .struct_fields(ty)?
                    .get(field)
                    .ok_or_else(|| invalid(format!("{ty} has no field {field}")))?
                    .storage;
                let value = self
                    .object_fields(a.reference(0)?)?
                    .get(field)
                    .ok_or_else(|| invalid(format!("the object has no field {field}")))?;
                one(unpack(storage, value, opcode == StructGetS)?)
            }
            StructSet => {
                let ty = type_immediate(operation, 0)?;
                let field = u32_immediate(operation, 1)? as usize;
                let storage = &self
                    .struct_fields(ty)?
                    .get(field)
                    .ok_or_else(|| invalid(format!("{ty} has no field {field}")))?
                    .storage;
                let value = pack(storage, *a.get(1)?)?;
                let fields = self.object_fields_mut(a.reference(0)?)?;
                let slot = fields
                    .get_mut(field)
                    .ok_or_else(|| invalid(format!("the object has no field {field}")))?;
                *slot = value;
                Ok(Values::None)
            }

            ArrayNew => {
                let ty = type_immediate(operation, 0)?;
                let count = a.i32(1)?;
                if count > self.config.max_array_elements {
                    return Err(trap(TrapCode::AllocationFailure));
                }
                let value = pack(&self.array_element(ty)?.storage, *a.get(0)?)?;
                self.allocate_array(ty, vec![value; count as usize])
            }
            ArrayNewDefault => {
                let ty = type_immediate(operation, 0)?;
                let count = a.i32(0)?;
                if count > self.config.max_array_elements {
                    return Err(trap(TrapCode::AllocationFailure));
                }
                let value = default_field(&self.array_element(ty)?.storage);
                self.allocate_array(ty, vec![value; count as usize])
            }
            ArrayNewFixed => {
                let ty = type_immediate(operation, 0)?;
                let count = u32_immediate(operation, 1)? as usize;
                if a.len() != count {
                    return Err(invalid(format!(
                        "array.new_fixed of {count} elements given {}",
                        a.len()
                    )));
                }
                let storage = &self.array_element(ty)?.storage;
                let values = a
                    .to_vec()?
                    .into_iter()
                    .map(|value| pack(storage, value))
                    .collect::<Result<Vec<_>, _>>()?;
                self.allocate_array(ty, values)
            }
            ArrayNewData => {
                let ty = type_immediate(operation, 0)?;
                let data = data_immediate(operation, 1)?;
                let (offset, count) = (a.address(0)?, a.address(1)?);
                let values = self.array_elements_from_data(ty, data, offset, count)?;
                self.allocate_array(ty, values)
            }
            ArrayNewElem => {
                let ty = type_immediate(operation, 0)?;
                let element = element_immediate(operation, 1)?;
                let (offset, count) = (a.address(0)?, a.address(1)?);
                let values = self.array_elements_from_segment(element, offset, count)?;
                self.allocate_array(ty, values)
            }
            ArrayGet | ArrayGetS | ArrayGetU => {
                let ty = type_immediate(operation, 0)?;
                let storage = &self.array_element(ty)?.storage;
                let index = a.i32(1)? as usize;
                let value = self
                    .object_fields(a.reference(0)?)?
                    .get(index)
                    .ok_or_else(|| trap(TrapCode::BadArrayElement))?;
                one(unpack(storage, value, opcode == ArrayGetS)?)
            }
            ArraySet => {
                let ty = type_immediate(operation, 0)?;
                let value = pack(&self.array_element(ty)?.storage, *a.get(2)?)?;
                let index = a.i32(1)? as usize;
                let slot = self
                    .object_fields_mut(a.reference(0)?)?
                    .get_mut(index)
                    .ok_or_else(|| trap(TrapCode::BadArrayElement))?;
                *slot = value;
                Ok(Values::None)
            }
            ArrayLen => one(Value::I32(self.object_fields(a.reference(0)?)?.len() as u32)),
            ArrayFill => {
                let ty = type_immediate(operation, 0)?;
                let value = pack(&self.array_element(ty)?.storage, *a.get(2)?)?;
                let (start, count) = (u64::from(a.i32(1)?), u64::from(a.i32(3)?));
                let elements = self.object_fields_mut(a.reference(0)?)?;
                checked_range(start, count, elements.len() as u64)
                    .ok_or_else(|| trap(TrapCode::BadArrayElement))?;
                elements[start as usize..(start + count) as usize].fill(value);
                Ok(Values::None)
            }
            ArrayCopy => {
                let (destination, source) = (*a.reference(0)?, *a.reference(2)?);
                let (destination_start, source_start, count) = (
                    u64::from(a.i32(1)?),
                    u64::from(a.i32(3)?),
                    u64::from(a.i32(4)?),
                );
                let source_elements = self.object_fields(&source)?;
                checked_range(source_start, count, source_elements.len() as u64)
                    .ok_or_else(|| trap(TrapCode::BadArrayElement))?;
                let values = source_elements
                    [source_start as usize..(source_start + count) as usize]
                    .to_vec();
                let destination_elements = self.object_fields_mut(&destination)?;
                checked_range(destination_start, count, destination_elements.len() as u64)
                    .ok_or_else(|| trap(TrapCode::BadArrayElement))?;
                destination_elements
                    [destination_start as usize..(destination_start + count) as usize]
                    .clone_from_slice(&values);
                Ok(Values::None)
            }
            ArrayInitData => {
                let ty = type_immediate(operation, 0)?;
                let data = data_immediate(operation, 1)?;
                let (destination_start, source_start, count) = (
                    u64::from(a.i32(1)?),
                    u64::from(a.i32(2)?),
                    u64::from(a.i32(3)?),
                );
                let reference = *a.reference(0)?;
                let values = self.array_elements_from_data(ty, data, source_start, count)?;
                let elements = self.object_fields_mut(&reference)?;
                checked_range(destination_start, count, elements.len() as u64)
                    .ok_or_else(|| trap(TrapCode::BadArrayElement))?;
                elements[destination_start as usize..(destination_start + count) as usize]
                    .clone_from_slice(&values);
                Ok(Values::None)
            }
            ArrayInitElem => {
                let element = element_immediate(operation, 1)?;
                let (destination_start, source_start, count) = (
                    u64::from(a.i32(1)?),
                    u64::from(a.i32(2)?),
                    u64::from(a.i32(3)?),
                );
                let reference = *a.reference(0)?;
                let values = self.array_elements_from_segment(element, source_start, count)?;
                let elements = self.object_fields_mut(&reference)?;
                checked_range(destination_start, count, elements.len() as u64)
                    .ok_or_else(|| trap(TrapCode::BadArrayElement))?;
                elements[destination_start as usize..(destination_start + count) as usize]
                    .clone_from_slice(&values);
                Ok(Values::None)
            }

            Throw => {
                let tag = tag_immediate(operation, 0)?;
                Err(Fault::Exception(
                    self.store.allocate_exception(tag, a.to_vec()?),
                ))
            }

            other => Err(Fault::Unsupported(format!(
                "operation {}",
                other.mnemonic()
            ))),
        }
    }
}
