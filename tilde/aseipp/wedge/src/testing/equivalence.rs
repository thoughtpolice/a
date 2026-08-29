// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Holding a transformed program to the original under the reference
//! interpreter.
//!
//! Both programs are instantiated and their exported functions invoked in
//! export order with the same arguments. After every invocation the two
//! sides must agree on what came back, values, trap, or exception, and on
//! the state left behind: globals, memories, tables, and dropped segments.
//! The original runs on a fuel budget; the transformed program gets more,
//! since a simplification may move a constant into a block that is entered
//! more often than the instruction it replaced was executed. An invocation
//! the original cannot finish within its budget ends the comparison as
//! inconclusive, because the two sides have then observed different
//! prefixes of the same computation.

use arbitrary::Unstructured;
use wedge::Compiler;
use wedge::interp::{Config, Fault, Instance, NoHost, Value};
use wedge::ir::{ExportItem, Program, ValueType};
use wedge::simplify::{self, Statistics};

/// What the comparison concluded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Verdict {
    /// Every invocation ended the same way on both sides.
    Equivalent {
        invocations: usize,
        statistics: Statistics,
    },
    /// The comparison could not be carried out, for the stated reason.
    Inconclusive(String),
    /// The transformed program does not verify.
    Unverifiable(String),
    /// An invocation ended differently; the report names it.
    Divergent(String),
}

impl Verdict {
    /// The harness result for a transformed program that fails
    /// verification.
    pub const UNVERIFIABLE_CODE: i32 = 6;
    /// The harness result for a transformed program that behaves
    /// differently.
    pub const DIVERGENT_CODE: i32 = 7;
}

const FUEL: u64 = 2_000_000;
const MAX_CALL_DEPTH: usize = 1000;
const STACK_BYTES: usize = 256 << 20;

/// Compiles `wasm`, simplifies a copy, and compares the two. `arguments`
/// supplies the argument values of every invocation; an exhausted source
/// yields zeros.
pub fn check_simplified(wasm: &[u8], arguments: &mut Unstructured<'_>) -> Verdict {
    let original = match Compiler::new().compile(wasm) {
        Ok(program) => program,
        Err(error) => {
            return Verdict::Inconclusive(format!("the module does not compile: {error}"));
        }
    };
    let mut simplified = original.clone();
    let statistics = match simplify::simplify(&mut simplified) {
        Ok(statistics) => statistics,
        Err(error) => return Verdict::Unverifiable(format!("the pass failed: {error}")),
    };
    if let Err(errors) = simplified.verify() {
        return Verdict::Unverifiable(format!("the simplified program does not verify:\n{errors}"));
    }
    let argument_bytes = arguments.bytes(arguments.len()).unwrap_or(&[]).to_vec();
    match compare(&original, &simplified, &argument_bytes) {
        Verdict::Equivalent { invocations, .. } => Verdict::Equivalent {
            invocations,
            statistics,
        },
        other => other,
    }
}

/// Runs `original` and `transformed` side by side on a thread with room
/// for deep recursion.
pub fn compare(original: &Program, transformed: &Program, argument_bytes: &[u8]) -> Verdict {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("wedge-equivalence".to_owned())
            .stack_size(STACK_BYTES)
            .spawn_scoped(scope, || {
                compare_on_this_thread(original, transformed, argument_bytes)
            })
            .expect("spawn the interpreter thread")
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

/// How one invocation ended, in a form the two sides can be compared by.
#[derive(Debug, Eq, PartialEq)]
enum Outcome {
    Return(Vec<Value>),
    Fault(Fault),
    Exception {
        tag: wedge::ir::TagId,
        payload: Vec<Value>,
    },
}

fn outcome(instance: &Instance<'_>, result: Result<Vec<Value>, Fault>) -> Outcome {
    match result {
        Ok(values) => Outcome::Return(values),
        Err(Fault::Exception(id)) => match instance.store().exception(id) {
            Some(exception) => Outcome::Exception {
                tag: exception.tag,
                payload: exception.payload.clone(),
            },
            None => Outcome::Fault(Fault::Exception(id)),
        },
        Err(fault) => Outcome::Fault(fault),
    }
}

/// The observable state of an instance: what a later invocation could
/// read.
fn state(
    instance: &Instance<'_>,
) -> (
    Vec<Value>,
    Vec<Vec<u8>>,
    Vec<Vec<wedge::interp::Ref>>,
    Vec<bool>,
    Vec<bool>,
) {
    let store = instance.store();
    (
        store.globals.clone(),
        store
            .memories
            .iter()
            .map(|memory| memory.bytes.clone())
            .collect(),
        store
            .tables
            .iter()
            .map(|table| table.elements.clone())
            .collect(),
        store.dropped_data.clone(),
        store.dropped_elements.clone(),
    )
}

fn compare_on_this_thread(
    original: &Program,
    transformed: &Program,
    argument_bytes: &[u8],
) -> Verdict {
    if let Some(import) = original.imports.first() {
        return Verdict::Inconclusive(format!(
            "the module imports {:?}.{:?}, which the comparison cannot supply",
            import.module, import.name
        ));
    }
    let config = Config {
        fuel: FUEL,
        max_call_depth: MAX_CALL_DEPTH,
        ..Config::default()
    };
    let generous = Config {
        fuel: FUEL * 2,
        ..config.clone()
    };
    let before = Instance::instantiate(original, &mut NoHost, config);
    let after = Instance::instantiate(transformed, &mut NoHost, generous);
    let (mut before, mut after) = match (before, after) {
        (Ok(before), Ok(after)) => (before, after),
        (Err(Fault::OutOfFuel), _) => {
            return Verdict::Inconclusive("instantiation runs out of fuel".to_owned());
        }
        (Err(left), Err(right)) => {
            return if left == right {
                Verdict::Equivalent {
                    invocations: 0,
                    statistics: Statistics::default(),
                }
            } else {
                Verdict::Divergent(format!(
                    "instantiation faults with {left} before simplification and {right} after"
                ))
            };
        }
        (Ok(_), Err(fault)) => {
            return Verdict::Divergent(format!(
                "instantiation succeeds before simplification and faults with {fault} after"
            ));
        }
        (Err(fault), Ok(_)) => {
            return Verdict::Divergent(format!(
                "instantiation faults with {fault} before simplification and succeeds after"
            ));
        }
    };
    if state(&before) != state(&after) {
        return Verdict::Divergent("instantiation leaves different state".to_owned());
    }

    let mut arguments = Unstructured::new(argument_bytes);
    let mut invocations = 0;
    for export in &original.exports {
        let ExportItem::Function(function) = export.item else {
            continue;
        };
        let signature = match before.signature(function) {
            Ok(signature) => signature,
            Err(fault) => return Verdict::Inconclusive(fault.to_string()),
        };
        let Some(argument_values) = draw_arguments(&signature.params, &mut arguments) else {
            continue;
        };
        let describe = || {
            format!(
                "invoking {:?} with {}",
                export.name,
                argument_values
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let left = before.invoke(&mut NoHost, function, &argument_values);
        let left = outcome(&before, left);
        if matches!(left, Outcome::Fault(Fault::OutOfFuel)) {
            break;
        }
        if let Outcome::Fault(fault @ (Fault::Unsupported(_) | Fault::Invalid(_))) = &left {
            return Verdict::Inconclusive(format!("{}: {fault}", describe()));
        }
        let right = after.invoke(&mut NoHost, function, &argument_values);
        let right = outcome(&after, right);
        if left != right {
            return Verdict::Divergent(format!(
                "{}: {left:?} before simplification, {right:?} after",
                describe()
            ));
        }
        if state(&before) != state(&after) {
            return Verdict::Divergent(format!(
                "{}: the two sides leave different state",
                describe()
            ));
        }
        invocations += 1;
    }
    Verdict::Equivalent {
        invocations,
        statistics: Statistics::default(),
    }
}

/// Arguments for `params` drawn from `source`: numbers from the bytes,
/// null for any nullable reference, and none at all when a parameter has
/// no value the comparison can invent.
fn draw_arguments(params: &[ValueType], source: &mut Unstructured<'_>) -> Option<Vec<Value>> {
    params
        .iter()
        .map(|ty| {
            Some(match ty {
                ValueType::I32 => Value::I32(source.arbitrary().unwrap_or(0)),
                ValueType::I64 => Value::I64(source.arbitrary().unwrap_or(0)),
                ValueType::F32 => Value::F32(source.arbitrary().unwrap_or(0)),
                ValueType::F64 => Value::F64(source.arbitrary().unwrap_or(0)),
                ValueType::V128 => Value::V128(source.arbitrary().unwrap_or([0; 16])),
                ValueType::Ref(reference) => {
                    if !reference.nullable {
                        return None;
                    }
                    Value::Ref(wedge::interp::Ref::Null)
                }
            })
        })
        .collect()
}
