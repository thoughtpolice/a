// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Holding the front end to an independent implementation of WebAssembly.
//!
//! A module is instantiated and its exported functions invoked in export
//! order under Wedge's reference interpreter, which runs the lowered IR.
//! What happened, value by value and trap by trap, is written as a spec-test
//! script whose expectations WABT's `spectest-interp` then checks by running
//! the same module through its own interpreter. Any disagreement is a bug in
//! the frontend, the reference interpreter, or WABT, and the report says
//! which invocation and which value.
//!
//! WABT is not a complete oracle: its interpreter stops on deep recursion
//! long before Wedge's depth limit, does not implement the garbage
//! collection proposal, and may run a generated loop forever. Those cases
//! are inconclusive rather than disagreements, and the script stops at the
//! first inconclusive invocation so nothing after it depends on state WABT
//! never reached.

use std::fmt::Write as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use arbitrary::Unstructured;
use wedge::Compiler;
use wedge::interp::{Config, Fault, Instance, NoHost, Ref, Value};
use wedge::ir::{ExportItem, HeapType, Program, TrapCode, ValueType};

/// WABT's spec-test runner, and how long one script may take.
#[derive(Clone, Debug)]
pub struct Wabt {
    pub spectest_interp: PathBuf,
    pub timeout: Duration,
}

impl Wabt {
    pub fn new(spectest_interp: PathBuf) -> Self {
        Self {
            spectest_interp,
            timeout: Duration::from_secs(10),
        }
    }
}

/// What the differential check concluded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Verdict {
    /// WABT reproduced every recorded outcome.
    Agree { invocations: usize },
    /// Neither side could be held to the other, for the stated reason.
    Inconclusive(String),
    /// WABT observed something else; the report names the invocation.
    Disagree(String),
}

impl Verdict {
    /// The harness result that identifies a disagreement to Fozzie.
    pub const DISAGREE_CODE: i32 = 5;
}

/// The interpreter's budget for one invocation. WABT runs the same code
/// without a limit, so a budget that runs out makes the check inconclusive
/// rather than wrong.
const FUEL: u64 = 2_000_000;
const MAX_CALL_DEPTH: usize = 1000;
/// Each interpreted call nests a few Rust frames; the interpreter runs on
/// a thread with room for the whole depth.
const STACK_BYTES: usize = 256 << 20;

/// One invocation's arguments and outcome under the reference interpreter.
struct Invocation {
    field: String,
    arguments: Vec<(ValueType, Value)>,
    results: Vec<ValueType>,
    outcome: Outcome,
}

enum Outcome {
    Return(Vec<Value>),
    Trap(TrapCode),
    Exception,
}

/// Everything the reference interpreter observed.
enum Script {
    Uninstantiable,
    Invocations(Vec<Invocation>),
}

/// Checks `wasm` against WABT. `arguments` supplies the argument values of
/// every invocation; an exhausted source yields zeros.
pub fn check(wabt: &Wabt, wasm: &[u8], arguments: &mut Unstructured<'_>) -> Verdict {
    let program = match Compiler::new().compile(wasm) {
        Ok(program) => program,
        Err(error) => {
            return Verdict::Inconclusive(format!("the module does not compile: {error}"));
        }
    };
    check_program(wabt, wasm, &program, arguments)
}

/// Checks `program`, some lowering of `wasm`, against WABT's execution of
/// `wasm`: the way to hold a transformed program to the source module.
pub fn check_program(
    wabt: &Wabt,
    wasm: &[u8],
    program: &Program,
    arguments: &mut Unstructured<'_>,
) -> Verdict {
    let argument_bytes = arguments.bytes(arguments.len()).unwrap_or(&[]).to_vec();
    let script = std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("wedge-interp".to_owned())
            .stack_size(STACK_BYTES)
            .spawn_scoped(scope, || record(program, &argument_bytes))
            .expect("spawn the interpreter thread")
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    });
    let script = match script {
        Ok(script) => script,
        Err(why) => return Verdict::Inconclusive(why),
    };
    replay(wabt, wasm, &script)
}

/// Runs the module under the reference interpreter, recording every
/// invocation until one is inconclusive.
fn record(program: &Program, argument_bytes: &[u8]) -> Result<Script, String> {
    if let Some(import) = program.imports.first() {
        return Err(format!(
            "the module imports {:?}.{:?}, which WABT's script runner cannot supply",
            import.module, import.name
        ));
    }
    let config = Config {
        fuel: FUEL,
        max_call_depth: MAX_CALL_DEPTH,
        ..Config::default()
    };
    let mut instance = match Instance::instantiate(program, &mut NoHost, config) {
        Ok(instance) => instance,
        Err(Fault::Trap(_) | Fault::Exception(_)) => return Ok(Script::Uninstantiable),
        Err(fault) => return Err(format!("instantiation is inconclusive: {fault}")),
    };
    let mut arguments = Unstructured::new(argument_bytes);
    let mut invocations = Vec::new();
    for export in &program.exports {
        let ExportItem::Function(function) = export.item else {
            continue;
        };
        let signature = instance
            .signature(function)
            .map_err(|fault| fault.to_string())?;
        let Some(argument_values) = draw_arguments(&signature.params, &mut arguments) else {
            continue;
        };
        if !signature.results.iter().all(|ty| representable(ty)) {
            continue;
        }
        let outcome = match instance.invoke(&mut NoHost, function, &argument_values) {
            Ok(values) => {
                if values
                    .iter()
                    .any(|value| matches!(value, Value::Ref(Ref::Exn(_))))
                {
                    break;
                }
                Outcome::Return(values)
            }
            Err(Fault::Trap(code)) => Outcome::Trap(code),
            Err(Fault::Exception(_)) => Outcome::Exception,
            Err(Fault::OutOfFuel | Fault::CallDepthExceeded) => break,
            Err(fault @ (Fault::Unsupported(_) | Fault::Invalid(_))) => {
                return Err(format!("{}: {fault}", export.name));
            }
        };
        invocations.push(Invocation {
            field: export.name.clone(),
            arguments: signature
                .params
                .iter()
                .cloned()
                .zip(argument_values)
                .collect(),
            results: signature.results.clone(),
            outcome,
        });
    }
    Ok(Script::Invocations(invocations))
}

/// Whether WABT's script format can spell a value of `ty`.
fn representable(ty: &ValueType) -> bool {
    match ty {
        ValueType::Ref(reference) => wabt_reference_type(&reference.heap).is_some(),
        _ => true,
    }
}

fn wabt_reference_type(heap: &HeapType) -> Option<&'static str> {
    Some(match heap {
        HeapType::Func | HeapType::NoFunc | HeapType::Concrete(_) => "funcref",
        HeapType::Extern | HeapType::NoExtern => "externref",
        HeapType::Exn | HeapType::NoExn => "exnref",
        _ => return None,
    })
}

/// Arguments for `params` drawn from `source`, or `None` when a parameter
/// has no value the script can pass: a non-null reference, or one outside
/// the function, extern, and exception hierarchies.
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
                    if !reference.nullable || wabt_reference_type(&reference.heap).is_none() {
                        return None;
                    }
                    Value::Ref(Ref::Null)
                }
            })
        })
        .collect()
}

/// A name as WABT's JSON reader takes it: it copies bytes and knows only
/// the `\uXXXX` escape, so the quote and the backslash are escaped and
/// everything else, UTF-8 included, is written as is.
fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\u0022"),
            '\\' => out.push_str("\\u005c"),
            _ => out.push(character),
        }
    }
    out.push('"');
    out
}

fn json_value(ty: &ValueType, value: &Value, expected: bool) -> String {
    match (ty, value) {
        (ValueType::I32, Value::I32(bits)) => format!(r#"{{"type": "i32", "value": "{bits}"}}"#),
        (ValueType::I64, Value::I64(bits)) => format!(r#"{{"type": "i64", "value": "{bits}"}}"#),
        (ValueType::F32, Value::F32(bits)) => {
            let value = f32::from_bits(*bits);
            if expected && value.is_nan() && bits & 0x0040_0000 != 0 {
                r#"{"type": "f32", "value": "nan:arithmetic"}"#.to_owned()
            } else {
                format!(r#"{{"type": "f32", "value": "{bits}"}}"#)
            }
        }
        (ValueType::F64, Value::F64(bits)) => {
            let value = f64::from_bits(*bits);
            if expected && value.is_nan() && bits & 0x0008_0000_0000_0000 != 0 {
                r#"{"type": "f64", "value": "nan:arithmetic"}"#.to_owned()
            } else {
                format!(r#"{{"type": "f64", "value": "{bits}"}}"#)
            }
        }
        (ValueType::V128, Value::V128(bytes)) => {
            let low = u64::from_le_bytes(bytes[..8].try_into().expect("eight bytes"));
            let high = u64::from_le_bytes(bytes[8..].try_into().expect("eight bytes"));
            format!(r#"{{"type": "v128", "lane_type": "i64", "value": ["{low}", "{high}"]}}"#)
        }
        (ValueType::Ref(reference), Value::Ref(value)) => {
            let ty = wabt_reference_type(&reference.heap).expect("checked when planning");
            let value = if value.is_null() { "null" } else { "" };
            format!(r#"{{"type": "{ty}", "value": "{value}"}}"#)
        }
        (ty, value) => panic!("{value} is not a {ty}"),
    }
}

fn json_type(ty: &ValueType) -> String {
    let name = match ty {
        ValueType::I32 => "i32",
        ValueType::I64 => "i64",
        ValueType::F32 => "f32",
        ValueType::F64 => "f64",
        ValueType::V128 => "v128",
        ValueType::Ref(reference) => {
            wabt_reference_type(&reference.heap).expect("checked when planning")
        }
    };
    format!(r#"{{"type": "{name}"}}"#)
}

const SOURCE: &str = "m.wast";

/// The spec-test script asserting what the reference interpreter saw. Line
/// `n + 2` is invocation `n`; line 1 is the module.
fn script_json(script: &Script) -> String {
    let mut json = String::new();
    write!(json, r#"{{"source_filename": "{SOURCE}", "commands": ["#).unwrap();
    match script {
        Script::Uninstantiable => {
            write!(
                json,
                r#"{{"type": "assert_uninstantiable", "line": 1, "filename": "m.wasm", "text": "", "module_type": "binary"}}"#
            )
            .unwrap();
        }
        Script::Invocations(invocations) => {
            write!(
                json,
                r#"{{"type": "module", "line": 1, "filename": "m.wasm"}}"#
            )
            .unwrap();
            for (index, invocation) in invocations.iter().enumerate() {
                let line = index + 2;
                let arguments = invocation
                    .arguments
                    .iter()
                    .map(|(ty, value)| json_value(ty, value, false))
                    .collect::<Vec<_>>()
                    .join(", ");
                let action = format!(
                    r#""action": {{"type": "invoke", "field": {}, "args": [{arguments}]}}"#,
                    json_string(&invocation.field)
                );
                let result_types = invocation
                    .results
                    .iter()
                    .map(json_type)
                    .collect::<Vec<_>>()
                    .join(", ");
                match &invocation.outcome {
                    Outcome::Return(values) => {
                        let expected = invocation
                            .results
                            .iter()
                            .zip(values)
                            .map(|(ty, value)| json_value(ty, value, true))
                            .collect::<Vec<_>>()
                            .join(", ");
                        write!(
                            json,
                            r#", {{"type": "assert_return", "line": {line}, {action}, "expected": [{expected}]}}"#
                        )
                        .unwrap();
                    }
                    Outcome::Trap(_) => {
                        write!(
                            json,
                            r#", {{"type": "assert_trap", "line": {line}, {action}, "text": "", "expected": [{result_types}]}}"#
                        )
                        .unwrap();
                    }
                    Outcome::Exception => {
                        write!(
                            json,
                            r#", {{"type": "assert_exception", "line": {line}, {action}, "expected": [{result_types}]}}"#
                        )
                        .unwrap();
                    }
                }
            }
        }
    }
    json.push_str("]}\n");
    json
}

/// The WABT trap messages a trap code corresponds to. `None` accepts any.
fn wabt_trap_messages(code: &TrapCode) -> Option<&'static [&'static str]> {
    Some(match code {
        TrapCode::Unreachable => &["unreachable executed"],
        TrapCode::IntegerDivideByZero => &["integer divide by zero"],
        TrapCode::IntegerOverflow => &["integer overflow"],
        TrapCode::InvalidConversionToInteger => &["invalid conversion to integer"],
        TrapCode::MemoryOutOfBounds => &["out of bounds memory access"],
        TrapCode::TableOutOfBounds => &["out of bounds table access", "undefined table index"],
        TrapCode::IndirectCallTypeMismatch => &["indirect call signature mismatch"],
        TrapCode::NullReference => &["null reference", "expected exnref, got null"],
        TrapCode::NullFunctionReference => {
            &["uninitialized table element", "null function reference"]
        }
        TrapCode::StackOverflow => &["call stack exhausted"],
        TrapCode::BadArrayElement | TrapCode::AllocationFailure | TrapCode::Other(_) => {
            return None;
        }
    })
}

/// Trap messages that mark WABT's own limits rather than the program's
/// behaviour.
fn wabt_limit(message: &str) -> bool {
    message.starts_with("call stack exhausted")
        || message.starts_with("value stack exhausted")
        || message.starts_with("not implemented")
}

/// Runs the script under WABT and reads its verdict.
fn replay(wabt: &Wabt, wasm: &[u8], script: &Script) -> Verdict {
    let invocations = match script {
        Script::Uninstantiable => 0,
        Script::Invocations(invocations) => invocations.len(),
    };
    let directory = match tempfile::tempdir() {
        Ok(directory) => directory,
        Err(error) => return Verdict::Inconclusive(format!("no temporary directory: {error}")),
    };
    let json = script_json(script);
    if let Err(error) = std::fs::write(directory.path().join("m.wasm"), wasm)
        .and_then(|()| std::fs::write(directory.path().join("m.json"), &json))
    {
        return Verdict::Inconclusive(format!("cannot write the script: {error}"));
    }

    let mut child = match Command::new(&wabt.spectest_interp)
        .arg("--enable-all")
        .arg("m.json")
        .current_dir(directory.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return Verdict::Inconclusive(format!("cannot run spectest-interp: {error}")),
    };
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < wabt.timeout => {
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Verdict::Inconclusive("WABT did not finish in time".to_owned());
            }
            Err(error) => return Verdict::Inconclusive(format!("waiting for WABT: {error}")),
        }
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = std::io::Read::read_to_string(&mut pipe, &mut stdout);
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr);
    }

    let prefix = format!("{SOURCE}:");
    let mut failures = Vec::new();
    for line in stdout.lines().chain(stderr.lines()) {
        let Some(rest) = line.strip_prefix(&prefix) else {
            continue;
        };
        let Some((line_number, message)) = rest.split_once(": ") else {
            continue;
        };
        let line_number: usize = line_number.parse().unwrap_or(0);
        let invocation = match script {
            Script::Invocations(invocations) if line_number >= 2 => {
                invocations.get(line_number - 2)
            }
            _ => None,
        };
        let describe = |what: &str| match invocation {
            Some(invocation) => format!(
                "invoking {:?} with {}: {what}",
                invocation.field,
                invocation
                    .arguments
                    .iter()
                    .map(|(_, value)| value.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            None => format!("line {line_number}: {what}"),
        };

        if let Some(trapped) = message.strip_prefix("assert_trap passed: ") {
            if wabt_limit(trapped) {
                return Verdict::Inconclusive(describe(&format!("WABT hit its limit: {trapped}")));
            }
            let Some(Invocation {
                outcome: Outcome::Trap(code),
                ..
            }) = invocation
            else {
                failures.push(describe(&format!("unexpected trap report: {trapped}")));
                continue;
            };
            if let Some(messages) = wabt_trap_messages(code) {
                if !messages
                    .iter()
                    .any(|expected| trapped.starts_with(expected))
                {
                    failures.push(describe(&format!(
                        "Wedge trapped with {code:?} but WABT trapped with {trapped:?}"
                    )));
                }
            }
        } else if message == "assert_exception passed"
            || message.starts_with("assert_uninstantiable passed")
        {
        } else if let Some(trapped) = message
            .strip_prefix("unexpected trap: ")
            .or_else(|| message.strip_prefix("error instantiating module: \""))
        {
            if wabt_limit(trapped) {
                return Verdict::Inconclusive(describe(&format!("WABT hit its limit: {trapped}")));
            }
            failures.push(describe(&format!("WABT trapped: {trapped}")));
        } else if message.starts_with("error reading module")
            || message.starts_with("IR Validator thinks module is invalid")
        {
            return Verdict::Inconclusive(format!("WABT rejected the module: {message}"));
        } else {
            failures.push(describe(message));
        }
    }

    if failures.is_empty() {
        if status.success() {
            return Verdict::Agree { invocations };
        }
        return Verdict::Disagree(format!(
            "WABT exited with {status} without a diagnostic the check understands:\n{stdout}{stderr}"
        ));
    }
    Verdict::Disagree(failures.join("\n"))
}
