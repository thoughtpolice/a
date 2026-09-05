// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The simplification pass on small modules whose results are known, on
//! every fixture, and on the modules wlink links.
//!
//! Each small module is assembled from text, lowered, simplified, and
//! verified; the test then looks at what is left and, where the module
//! runs without imports, runs it before and after with the same arguments.

use std::collections::BTreeSet;

use wedge::Compiler;
use wedge::edit::EditError;
use wedge::interp::{Config, Instance, NoHost, Value};
use wedge::ir::{
    FunctionBody, Immediate, OperationKind, Program, TerminatorKind, ValueDefinition, ValueType,
};
use wedge::opcode::CoreOpcode;
use wedge::simplify::{self, Statistics};
use wedge_testing::equivalence::{self, Verdict};

mod fixture_support;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn program(wat: &str) -> Program {
    let wasm = wat::parse_str(wat).expect("the module assembles");
    let program = Compiler::new().compile(&wasm).expect("the module compiles");
    program.verify().expect("the program verifies");
    program
}

/// Simplifies `program`, requires the result to verify and to behave like
/// the original, and returns it with what the pass reported.
fn simplified(program: &Program) -> (Program, Statistics) {
    let mut simplified = program.clone();
    let statistics = simplify::simplify(&mut simplified).expect("the pass applies");
    simplified.verify().unwrap_or_else(|errors| {
        panic!("the simplified program does not verify:\n{errors}\n{simplified}")
    });
    match equivalence::compare(program, &simplified, &[7, 0, 3, 1, 4, 1, 5, 9, 2, 6]) {
        Verdict::Equivalent { .. } | Verdict::Inconclusive(_) => {}
        Verdict::Unverifiable(why) | Verdict::Divergent(why) => {
            panic!("{why}\nbefore:\n{program}\nafter:\n{simplified}")
        }
    }
    (simplified, statistics)
}

fn body<'a>(program: &'a Program, export: &str) -> &'a FunctionBody {
    fixture_support::exported_body(program, export)
}

fn mnemonics(body: &FunctionBody) -> Vec<&str> {
    body.blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .map(|instruction| instruction.operation.mnemonic())
        .collect()
}

fn constants(body: &FunctionBody) -> Vec<i32> {
    body.blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(
            |instruction| match instruction.operation.immediates.as_slice() {
                [Immediate::S32(value)]
                    if instruction.operation.kind == OperationKind::Core(CoreOpcode::I32Const) =>
                {
                    Some(*value)
                }
                _ => None,
            },
        )
        .collect()
}

fn run(program: &Program, export: &str, arguments: &[Value]) -> Vec<Value> {
    Instance::instantiate(program, &mut NoHost, Config::default())
        .expect("instantiates")
        .invoke_export(&mut NoHost, export, arguments)
        .unwrap_or_else(|fault| panic!("{export} faulted: {fault}"))
}

#[test]
fn arithmetic_on_constants_folds_to_one_constant() {
    let original = program(
        r#"(module (func (export "f") (result i32)
            i32.const 6 i32.const 7 i32.mul
            i32.const 2 i32.shl
            i64.const 100 i32.wrap_i64 i32.sub))"#,
    );
    let (program, statistics) = simplified(&original);
    let body = body(&program, "f");
    assert_eq!(body.blocks.len(), 1);
    assert_eq!(mnemonics(body), ["i32.const"]);
    assert_eq!(constants(body), [((6 * 7) << 2) - 100]);
    assert_eq!(statistics.instructions_folded, 4);
    assert_eq!(statistics.instructions_removed, 7);
    assert_eq!(run(&program, "f", &[]), [Value::I32(68)]);
}

#[test]
fn trapping_and_nondeterministic_operations_are_not_folded() {
    let original = program(
        r#"(module
            (func (export "div") (result i32) i32.const 1 i32.const 0 i32.div_u)
            (func (export "trunc") (result i32) f32.const nan i32.trunc_f32_s)
            (func (export "relaxed") (result v128)
                v128.const i32x4 1 2 3 4 v128.const i32x4 5 6 7 8 v128.const i32x4 0 -1 0 -1
                i8x16.relaxed_laneselect))"#,
    );
    let (program, statistics) = simplified(&original);
    assert_eq!(statistics.instructions_folded, 0);
    assert_eq!(
        mnemonics(body(&program, "div")),
        ["i32.const", "i32.const", "i32.div_u"]
    );
    assert_eq!(
        mnemonics(body(&program, "trunc")),
        ["f32.const", "i32.trunc_f32_s"]
    );
    assert_eq!(
        mnemonics(body(&program, "relaxed")).last(),
        Some(&"i8x16.relaxed_laneselect")
    );
}

#[test]
fn a_known_select_forwards_its_operand() {
    let original = program(
        r#"(module (func (export "f") (param i32 i32) (result i32)
            local.get 0 local.get 1 i32.const 1 select))"#,
    );
    let (program, statistics) = simplified(&original);
    let body = body(&program, "f");
    assert!(mnemonics(body).is_empty(), "{program}");
    let TerminatorKind::Return { values } = &body.blocks[0].terminator.kind else {
        panic!("{program}");
    };
    assert_eq!(values, &[body.blocks[0].parameters[0].id]);
    assert_eq!(statistics.values_forwarded, 1);
    assert_eq!(
        run(&program, "f", &[Value::I32(3), Value::I32(4)]),
        [Value::I32(3)]
    );
}

#[test]
fn a_branch_on_a_constant_collapses_to_its_taken_arm() {
    let original = program(
        r#"(module (func (export "f") (result i32)
            (if (result i32) (i32.const 1) (then i32.const 10) (else i32.const 20))))"#,
    );
    let (program, statistics) = simplified(&original);
    let body = body(&program, "f");
    assert_eq!(body.blocks.len(), 1, "{program}");
    assert_eq!(constants(body), [10]);
    assert_eq!(statistics.branches_resolved, 1);
    assert!(statistics.blocks_removed >= 2, "{statistics}");
    assert_eq!(run(&program, "f", &[]), [Value::I32(10)]);
}

#[test]
fn a_switch_on_a_constant_collapses_and_the_rest_is_unreachable() {
    let original = program(
        r#"(module (func (export "f") (result i32)
            (block $a (block $b (block $c
                i32.const 1 br_table $a $b $c)
                i32.const 30 return)
              i32.const 20 return)
            i32.const 10))"#,
    );
    let (program, statistics) = simplified(&original);
    let body = body(&program, "f");
    assert_eq!(body.blocks.len(), 1, "{program}");
    assert_eq!(constants(body), [20]);
    assert_eq!(statistics.branches_resolved, 1);
    assert_eq!(run(&program, "f", &[]), [Value::I32(20)]);
}

#[test]
fn arms_that_agree_on_a_constant_materialize_it_at_the_join() {
    let original = program(
        r#"(module (func (export "f") (param i32) (result i32)
            (if (result i32) (local.get 0) (then i32.const 7) (else i32.const 7))))"#,
    );
    let (program, statistics) = simplified(&original);
    let body = body(&program, "f");
    // The branch remains, but both arms are threaded straight to the join,
    // which now defines the constant itself and takes no parameter.
    assert_eq!(body.blocks.len(), 2, "{program}");
    let TerminatorKind::Branch {
        then_edge,
        else_edge,
        ..
    } = &body.blocks[0].terminator.kind
    else {
        panic!("{program}");
    };
    assert_eq!(then_edge.target, else_edge.target);
    assert!(then_edge.arguments.is_empty() && else_edge.arguments.is_empty());
    let join = &body.blocks[then_edge.target.index()];
    assert!(join.parameters.is_empty());
    assert_eq!(constants(body), [7]);
    assert_eq!(statistics.edges_threaded, 2);
    assert_eq!(statistics.parameters_removed, 1);
    assert_eq!(run(&program, "f", &[Value::I32(0)]), [Value::I32(7)]);
    assert_eq!(run(&program, "f", &[Value::I32(1)]), [Value::I32(7)]);
}

#[test]
fn a_parameter_with_one_remaining_source_is_forwarded_and_its_block_merged() {
    let original = program(
        r#"(module (func (export "f") (result i32) (local i32)
            (if (i32.const 0) (then (local.set 0 (i32.const 5))))
            local.get 0))"#,
    );
    let (program, statistics) = simplified(&original);
    let body = body(&program, "f");
    assert_eq!(body.blocks.len(), 1, "{program}");
    assert_eq!(constants(body), [0]);
    assert_eq!(statistics.values_forwarded, 1);
    assert_eq!(statistics.blocks_merged, 1);
    assert_eq!(run(&program, "f", &[]), [Value::I32(0)]);
}

#[test]
fn unused_reads_go_and_writes_and_traps_stay() {
    let original = program(
        r#"(module
            (memory 1)
            (global $g (mut i32) (i32.const 1))
            (func (export "f") (param i32) (result i32)
                (drop (i32.mul (local.get 0) (local.get 0)))
                nop
                (drop (global.get $g))
                (drop (memory.size))
                (drop (i32.load (i32.const 0)))
                (global.set $g (i32.const 2))
                local.get 0))"#,
    );
    let (program, statistics) = simplified(&original);
    let body = body(&program, "f");
    assert_eq!(
        mnemonics(body),
        ["i32.const", "i32.load", "i32.const", "global.set"],
        "{program}"
    );
    assert_eq!(statistics.instructions_removed, 8);
    assert_eq!(run(&program, "f", &[Value::I32(9)]), [Value::I32(9)]);
}

#[test]
fn loops_keep_their_parameters_and_their_meaning() {
    let original = program(
        r#"(module (func (export "sum") (param i32) (result i32) (local $acc i32)
            (loop $l
                (local.set $acc (i32.add (local.get $acc) (local.get 0)))
                (local.set 0 (i32.sub (local.get 0) (i32.const 1)))
                (br_if $l (local.get 0)))
            local.get $acc))"#,
    );
    let (program, _) = simplified(&original);
    let body = body(&program, "sum");
    let header = body
        .blocks
        .iter()
        .find(|block| block.parameters.len() == 2)
        .unwrap_or_else(|| panic!("the loop header keeps both parameters:\n{program}"));
    assert!(
        header
            .parameters
            .iter()
            .all(|parameter| parameter.ty == ValueType::I32)
    );
    assert_eq!(run(&program, "sum", &[Value::I32(10)]), [Value::I32(55)]);
}

#[test]
fn exceptional_routing_survives_simplification() {
    let original = program(
        r#"(module
            (tag $t (param i32))
            (func $thrower (param i32) (local.get 0) (throw $t))
            (func (export "catch") (param i32) (result i32)
                (block $caught (result i32)
                    (try_table (catch $t $caught)
                        (call $thrower (i32.add (local.get 0) (i32.const 1)))
                        (i32.const 0)
                        (return))
                    i32.const -1)
                i32.const 1 i32.add))"#,
    );
    let (program, _) = simplified(&original);
    let body = body(&program, "catch");
    assert!(
        body.blocks
            .iter()
            .any(|block| matches!(block.terminator.kind, TerminatorKind::Invoke { .. })),
        "{program}"
    );
    assert_eq!(run(&program, "catch", &[Value::I32(41)]), [Value::I32(43)]);
}

#[test]
fn refined_edges_are_threaded_with_their_facts() {
    let original = program(
        r#"(module
            (type $sig (func (result i32)))
            (func $one (result i32) i32.const 1)
            (elem declare func $one)
            (func (export "call_or_default") (param (ref null $sig)) (result i32)
                (block $null
                    (block $present (result (ref $sig))
                        (br_on_non_null $present (local.get 0))
                        (br $null))
                    (return (call_ref $sig)))
                i32.const 0))"#,
    );
    let (program, _) = simplified(&original);
    let body = body(&program, "call_or_default");
    let refined = body
        .blocks
        .iter()
        .flat_map(|block| block.terminator.kind.edges())
        .filter(|edge| !edge.refinements.is_empty())
        .count();
    assert_eq!(refined, 1, "{program}");
    assert_eq!(
        run(
            &program,
            "call_or_default",
            &[Value::Ref(wedge::interp::Ref::Func(wedge::ir::FunctionId(
                0
            )))]
        ),
        [Value::I32(1)]
    );
    assert_eq!(
        run(
            &program,
            "call_or_default",
            &[Value::Ref(wedge::interp::Ref::Null)]
        ),
        [Value::I32(0)]
    );
}

#[test]
fn removing_a_parameter_keeps_every_predecessor_consistent() {
    let original = program(
        r#"(module (func (export "f") (param i32 i32) (result i32)
            (if (local.get 0) (then (local.set 1 (i32.const 9))))
            local.get 1))"#,
    );
    let mut program = original.clone();
    let function = fixture_support::exported_function(&program, "f");
    let index = program
        .functions
        .iter()
        .position(|candidate| std::ptr::eq(candidate, function))
        .expect("the function is in the program");
    let body = program.functions[index].body.as_mut().expect("a body");
    let entry = body.entry;
    let join = body
        .blocks
        .iter()
        .find(|block| block.id != entry && block.parameters.len() == 1)
        .map(|block| block.id)
        .expect("the join block merges the local");
    assert_eq!(
        body.remove_parameters(join, &BTreeSet::from([1])),
        Err(EditError::MissingParameter {
            block: join,
            slot: 1
        })
    );
    let removed: Vec<ValueDefinition> = body
        .remove_parameters(join, &BTreeSet::from([0]))
        .expect("the parameter can go");
    assert_eq!(removed.len(), 1);
    let second_argument = body.blocks[entry.index()].parameters[1].id;
    body.replace_uses(removed[0].id, second_argument);
    assert!(
        body.blocks
            .iter()
            .flat_map(|block| block.terminator.kind.edges())
            .all(|edge| edge.arguments.is_empty()),
        "{program}"
    );
    program
        .verify()
        .unwrap_or_else(|errors| panic!("{errors}\n{program}"));
    assert_eq!(
        run(&original, "f", &[Value::I32(1), Value::I32(4)]),
        [Value::I32(9)]
    );
    assert_eq!(
        run(&program, "f", &[Value::I32(1), Value::I32(4)]),
        [Value::I32(4)]
    );
}

fn simplify_module(name: &str, wasm: &[u8]) -> Statistics {
    let original = Compiler::new()
        .compile(wasm)
        .unwrap_or_else(|error| panic!("{name}: {error}"));
    let mut simplified = original.clone();
    let statistics = simplify::simplify(&mut simplified)
        .unwrap_or_else(|error| panic!("{name}: the pass failed: {error}"));
    simplified.verify().unwrap_or_else(|errors| {
        panic!("{name}: the simplified program does not verify:\n{errors}")
    });
    match equivalence::compare(&original, &simplified, &[3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]) {
        Verdict::Equivalent { .. } | Verdict::Inconclusive(_) => {}
        Verdict::Unverifiable(why) | Verdict::Divergent(why) => panic!("{name}: {why}"),
    }
    statistics
}

#[test]
fn every_fixture_simplifies_to_a_verified_equivalent_program() {
    let fixtures: Vec<&str> = std::env::var("WEDGE_FIXTURES")
        .expect("the test target names its fixtures")
        .leak()
        .split_whitespace()
        .collect();
    let mut total = Statistics::default();
    for fixture in &fixtures {
        let statistics = simplify_module(fixture, &fixture_support::fixture(fixture));
        eprintln!("{fixture}: {statistics}");
        total = Statistics {
            instructions_folded: total.instructions_folded + statistics.instructions_folded,
            blocks_removed: total.blocks_removed + statistics.blocks_removed,
            ..total
        };
    }
    assert!(
        total.instructions_folded > 0 && total.blocks_removed > 0,
        "{total}"
    );
}

#[test]
fn every_linked_module_simplifies_to_a_verified_program() {
    for name in [
        "chain",
        "console",
        "doom",
        "hal",
        "host-abi",
        "lists",
        "nested",
        "records",
        "resources",
        "scalar",
        "string",
        "variant",
        "wide",
    ] {
        let path = buck_resources::get(format!("aseipp/wedge/wlink-{name}.wasm"))
            .unwrap_or_else(|error| panic!("locate wlink's linked {name} module: {error}"));
        let wasm = std::fs::read(&path).unwrap_or_else(|error| panic!("read {name}: {error}"));
        let statistics = simplify_module(name, &wasm);
        eprintln!("wlink-{name}: {statistics}");
        if matches!(name, "console" | "doom") {
            assert!(
                statistics.instructions_folded > 0
                    && statistics.blocks_merged > 0
                    && statistics.edges_threaded > 0,
                "wlink-{name}: {statistics}"
            );
        }
    }
}
