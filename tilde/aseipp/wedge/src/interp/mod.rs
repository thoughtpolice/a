// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A reference interpreter for the semantic IR.
//!
//! [`Instance`] instantiates a [`Program`] and runs its functions directly on
//! the typed SSA CFG: block parameters carry values across edges, instructions
//! compute results, terminators pick successors, and exceptional edges route
//! thrown exceptions to their catch blocks. It exists to say what the IR
//! means. The differential tests hold the frontend to it against an
//! independent WebAssembly implementation, and passes are checked against
//! it. It is a plain interpreter of the IR with no second representation,
//! kept fast enough to run whole programs: values are plain copies,
//! operands are read straight from the frame, frames are pooled, and fuel
//! is charged a block at a time.
//!
//! Every Core 3.0 operation the frontend lowers is executed here. Relaxed
//! SIMD operations, whose results the IR marks nondeterministic, follow the
//! specification's deterministic profile. Imports are resolved by a
//! [`Host`], which may call back into the guest; [`NoHost`] serves modules
//! without any.
//!
//! The interpreter trusts [`Program::verify`]: it reports malformed IR as
//! [`Fault::Invalid`] where it notices, but it does not re-check types.

mod exec;
mod numeric;
mod simd;
mod store;

use std::fmt;

use crate::ir::{
    ExportItem, FunctionId, FunctionType, HeapType, Import, Operation, Program, TrapCode, ValueType,
};

pub use store::{Exception, ExceptionId, ExternalizedId, Memory, Object, ObjectId, Store, Table};

/// A runtime value. Numbers are kept as bit patterns, so two values are
/// equal exactly when their bits are; a NaN compares equal to itself.
/// Values are plain data: what a reference points to lives in the
/// [`Store`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Value {
    I32(u32),
    I64(u64),
    F32(u32),
    F64(u64),
    V128([u8; 16]),
    Ref(Ref),
}

impl Value {
    pub fn f32(value: f32) -> Self {
        Self::F32(value.to_bits())
    }

    pub fn f64(value: f64) -> Self {
        Self::F64(value.to_bits())
    }

    /// The default (zero or null) value of a defaultable type.
    pub fn default_for(ty: &ValueType) -> Self {
        match ty {
            ValueType::I32 => Self::I32(0),
            ValueType::I64 => Self::I64(0),
            ValueType::F32 => Self::F32(0),
            ValueType::F64 => Self::F64(0),
            ValueType::V128 => Self::V128([0; 16]),
            ValueType::Ref(_) => Self::Ref(Ref::Null),
        }
    }

    /// Whether this value may inhabit `ty`, judged by representation alone:
    /// references are not checked against the heap type.
    pub fn has_type(&self, ty: &ValueType) -> bool {
        matches!(
            (self, ty),
            (Self::I32(_), ValueType::I32)
                | (Self::I64(_), ValueType::I64)
                | (Self::F32(_), ValueType::F32)
                | (Self::F64(_), ValueType::F64)
                | (Self::V128(_), ValueType::V128)
                | (Self::Ref(_), ValueType::Ref(_))
        )
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::I32(value) => write!(f, "i32:{value}"),
            Self::I64(value) => write!(f, "i64:{value}"),
            Self::F32(bits) => write!(f, "f32:{} ({bits:#x})", f32::from_bits(*bits)),
            Self::F64(bits) => write!(f, "f64:{} ({bits:#x})", f64::from_bits(*bits)),
            Self::V128(bytes) => {
                f.write_str("v128:0x")?;
                for byte in bytes.iter().rev() {
                    write!(f, "{byte:02x}")?;
                }
                Ok(())
            }
            Self::Ref(reference) => write!(f, "ref:{reference}"),
        }
    }
}

/// A reference value.
///
/// A reference is either null, a function, an opaque host value, an
/// internal value handed out through `extern.convert_any`, an unboxed
/// 31-bit integer, a managed object, or a caught exception. Object,
/// externalized-reference, and exception identities are indices into the
/// instance's [`Store`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Ref {
    Null,
    Func(FunctionId),
    /// A value the host provided; the interpreter only ever passes it back.
    Extern(u32),
    /// An internal reference seen through `extern.convert_any`; the store
    /// keeps the reference it wraps.
    Externalized(ExternalizedId),
    I31(u32),
    Struct(ObjectId),
    Array(ObjectId),
    Exn(ExceptionId),
}

impl Ref {
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
}

impl fmt::Display for Ref {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Null => f.write_str("null"),
            Self::Func(function) => write!(f, "{function}"),
            Self::Extern(handle) => write!(f, "extern#{handle}"),
            Self::Externalized(id) => write!(f, "extern(any#{})", id.0),
            Self::I31(value) => write!(f, "i31:{value}"),
            Self::Struct(object) => write!(f, "struct#{}", object.0),
            Self::Array(object) => write!(f, "array#{}", object.0),
            Self::Exn(exception) => write!(f, "exn#{}", exception.0),
        }
    }
}

/// Why execution stopped before the function returned.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Fault {
    /// A WebAssembly trap.
    Trap(TrapCode),
    /// An exception escaped the invoked function. The store keeps its tag
    /// and payload.
    Exception(ExceptionId),
    /// The invocation used up [`Config::fuel`].
    OutOfFuel,
    /// A call would have nested deeper than [`Config::max_call_depth`].
    CallDepthExceeded,
    /// The program uses something the interpreter does not implement.
    Unsupported(String),
    /// The program is not executable as written; verification would have
    /// rejected it.
    Invalid(String),
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Trap(code) => write!(f, "trap: {code:?}"),
            Self::Exception(exception) => write!(f, "uncaught exception exn#{}", exception.0),
            Self::OutOfFuel => f.write_str("out of fuel"),
            Self::CallDepthExceeded => f.write_str("call depth exceeded"),
            Self::Unsupported(what) => write!(f, "unsupported: {what}"),
            Self::Invalid(what) => write!(f, "invalid program: {what}"),
        }
    }
}

impl std::error::Error for Fault {}

/// Limits on one instance. Every limit is a value the program can observe
/// only as a fault or a failed allocation, never as a different result.
#[derive(Clone, Debug)]
pub struct Config {
    /// Instructions and terminators one invocation may execute before it
    /// stops with [`Fault::OutOfFuel`]. Instantiation gets the same budget.
    /// A block is charged as a whole when it is entered, so an invocation
    /// stops at a block boundary, possibly with a little fuel left.
    pub fuel: u64,
    /// The deepest call nesting an invocation may reach.
    pub max_call_depth: usize,
    /// The most bytes one memory may hold; growth past it fails as if the
    /// memory's declared maximum were reached.
    pub max_memory_bytes: u64,
    /// The most elements one table may hold, likewise.
    pub max_table_elements: u64,
    /// The largest array `array.new` and its relatives allocate; a longer
    /// one traps with [`TrapCode::AllocationFailure`].
    pub max_array_elements: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            fuel: u64::MAX,
            max_call_depth: 1000,
            max_memory_bytes: 1 << 30,
            max_table_elements: 1 << 24,
            max_array_elements: 1 << 26,
        }
    }
}

/// The provider of a program's function imports.
///
/// The instance is handed back to the host so it can read and write the
/// instance's state and call back into the guest, as a canonical-ABI host
/// does to allocate through the guest's `realloc`; [`Instance::call`] runs
/// such a call at the current depth and fuel.
pub trait Host {
    /// Calls the imported function `import` with `arguments`.
    fn call(
        &mut self,
        instance: &mut Instance<'_>,
        import: &Import,
        arguments: &[Value],
    ) -> Result<Vec<Value>, Fault>;
}

/// The host of a program without function imports; any call is
/// [`Fault::Unsupported`].
#[derive(Clone, Copy, Debug, Default)]
pub struct NoHost;

impl Host for NoHost {
    fn call(
        &mut self,
        _instance: &mut Instance<'_>,
        import: &Import,
        _arguments: &[Value],
    ) -> Result<Vec<Value>, Fault> {
        Err(Fault::Unsupported(format!(
            "call to import {:?}.{:?} without a host",
            import.module, import.name
        )))
    }
}

/// An instantiated program: its state plus the ability to run its functions.
///
/// The host is not part of the instance; every entry point takes it, so a
/// host may re-enter the guest from inside an import call.
pub struct Instance<'program> {
    program: &'program Program,
    config: Config,
    store: Store,
    fuel: u64,
    /// The call depth of the function executing now; the invoked function
    /// is at depth zero.
    depth: usize,
    /// One past the largest SSA value id each function defines, so a frame
    /// can be sized without scanning the body again.
    value_counts: Vec<usize>,
    /// Frames of finished activations, kept so a call reuses their
    /// allocations.
    frames: Vec<exec::Frame>,
}

impl<'program> Instance<'program> {
    /// Instantiates `program`: evaluates its global, table, and segment
    /// initializers in module order and runs its start function. A trap in
    /// any of them is the instantiation's fault, as in the specification.
    pub fn instantiate(
        program: &'program Program,
        host: &mut dyn Host,
        config: Config,
    ) -> Result<Self, Fault> {
        let value_counts = program
            .functions
            .iter()
            .map(|function| {
                function.body.as_ref().map_or(0, |body| {
                    body.blocks
                        .iter()
                        .flat_map(|block| {
                            block
                                .parameters
                                .iter()
                                .map(|parameter| parameter.id.index() + 1)
                                .chain(block.instructions.iter().flat_map(|instruction| {
                                    instruction
                                        .results
                                        .iter()
                                        .map(|result| result.id.index() + 1)
                                }))
                        })
                        .max()
                        .unwrap_or(0)
                })
            })
            .collect();
        let mut instance = Self {
            program,
            fuel: config.fuel,
            config,
            store: Store::default(),
            depth: 0,
            value_counts,
            frames: Vec::new(),
        };
        instance.initialize(host)?;
        Ok(instance)
    }

    pub fn program(&self) -> &'program Program {
        self.program
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut Store {
        &mut self.store
    }

    /// The fuel left from the last invocation or instantiation.
    pub fn fuel(&self) -> u64 {
        self.fuel
    }

    /// The export called `name`, if any.
    pub fn export(&self, name: &str) -> Option<ExportItem> {
        self.program
            .exports
            .iter()
            .find(|export| export.name == name)
            .map(|export| export.item)
    }

    /// The signature of `function`.
    pub fn signature(&self, function: FunctionId) -> Result<&'program FunctionType, Fault> {
        let definition = self
            .program
            .functions
            .get(function.index())
            .ok_or_else(|| Fault::Invalid(format!("no {function}")))?;
        match self.program.types.get(definition.ty.index()) {
            Some(crate::ir::TypeDefinition {
                composite: crate::ir::CompositeType::Function(signature),
                ..
            }) => Ok(signature),
            _ => Err(Fault::Invalid(format!("{function} has no function type"))),
        }
    }

    fn check_arguments(&self, function: FunctionId, arguments: &[Value]) -> Result<(), Fault> {
        let signature = self.signature(function)?;
        if arguments.len() != signature.params.len() {
            return Err(Fault::Invalid(format!(
                "{function} takes {} arguments, given {}",
                signature.params.len(),
                arguments.len()
            )));
        }
        for (argument, ty) in arguments.iter().zip(&signature.params) {
            if !argument.has_type(ty) {
                return Err(Fault::Invalid(format!(
                    "{function} expects {ty}, given {argument}"
                )));
            }
        }
        Ok(())
    }

    /// Runs `function` with `arguments` under a fresh fuel budget.
    pub fn invoke(
        &mut self,
        host: &mut dyn Host,
        function: FunctionId,
        arguments: &[Value],
    ) -> Result<Vec<Value>, Fault> {
        self.check_arguments(function, arguments)?;
        self.fuel = self.config.fuel;
        self.run(host, function, arguments.to_vec(), 0)
    }

    /// Runs the exported function `name`.
    pub fn invoke_export(
        &mut self,
        host: &mut dyn Host,
        name: &str,
        arguments: &[Value],
    ) -> Result<Vec<Value>, Fault> {
        match self.export(name) {
            Some(ExportItem::Function(function)) => self.invoke(host, function, arguments),
            Some(other) => Err(Fault::Invalid(format!(
                "export {name:?} is a {:?}, not a function",
                other.kind()
            ))),
            None => Err(Fault::Invalid(format!("no export {name:?}"))),
        }
    }

    /// Calls `function` from inside the running invocation: one level
    /// deeper than the function executing now, on the fuel it has left.
    /// This is how a host calls back into the guest.
    pub fn call(
        &mut self,
        host: &mut dyn Host,
        function: FunctionId,
        arguments: &[Value],
    ) -> Result<Vec<Value>, Fault> {
        self.check_arguments(function, arguments)?;
        self.run(host, function, arguments.to_vec(), self.depth + 1)
    }

    /// The heap type a non-null reference has at run time, or `None` for
    /// null.
    pub fn runtime_heap_type(&self, reference: &Ref) -> Option<HeapType> {
        Some(match reference {
            Ref::Null => return None,
            Ref::Func(function) => {
                HeapType::Concrete(self.program.functions.get(function.index())?.ty)
            }
            Ref::Extern(_) | Ref::Externalized(_) => HeapType::Extern,
            Ref::I31(_) => HeapType::I31,
            Ref::Struct(object) | Ref::Array(object) => {
                HeapType::Concrete(self.store.object(*object)?.ty)
            }
            Ref::Exn(_) => HeapType::Exn,
        })
    }
}

/// Evaluates an operation whose result depends on its operands alone: a
/// constant, a scalar numeric or vector operator, or a `select`. `Ok(None)`
/// means the operation needs an instance. A trap is the operation's own.
///
/// This is what constant folding evaluates with, so a folded value is by
/// construction the value the interpreter would have computed.
pub fn evaluate_pure(operation: &Operation, operands: &[Value]) -> Result<Option<Value>, Fault> {
    exec::evaluate_pure(operation, &numeric::Operands::Direct(operands))
}
