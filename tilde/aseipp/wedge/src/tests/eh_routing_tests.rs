// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! End-to-end and malformed-IR contracts for final-EH exceptional routing.

use wedge::Compiler;
use wedge::ir::{
    BlockId, Callee, CatchKind, ExceptionRouting, ExceptionalArgument, ExportItem, FunctionBody,
    FunctionId, OperationKind, Program, SourceInfo, TagId, Terminator, TerminatorKind, ValueId,
    ValueType,
};
use wedge::opcode::CoreOpcode;
mod fixture_support;

use fixture_support::compile_fixture;

fn function_id(program: &Program, export: &str) -> FunctionId {
    program
        .exports
        .iter()
        .find_map(|item| match (&*item.name, item.item) {
            (name, ExportItem::Function(function)) if name == export => Some(function),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing exported function {export}"))
}

fn body<'a>(program: &'a Program, export: &str) -> &'a FunctionBody {
    let function = function_id(program, export);
    program.functions[function.index()]
        .body
        .as_ref()
        .unwrap_or_else(|| panic!("{export} has no body"))
}

/// The block index and routing of the first invoke wrapping `opcode`.
fn routed_operation(body: &FunctionBody, opcode: CoreOpcode) -> (usize, &ExceptionRouting) {
    body.blocks
        .iter()
        .enumerate()
        .find_map(|(block_index, block)| match &block.terminator.kind {
            TerminatorKind::Invoke { operation, .. }
                if operation.kind == OperationKind::Core(opcode) =>
            {
                block
                    .terminator
                    .exception
                    .as_ref()
                    .map(|routing| (block_index, routing))
            }
            _ => None,
        })
        .expect("function has an invoke with an in-function exception route")
}

fn routed_call(body: &FunctionBody) -> (usize, &ExceptionRouting) {
    routed_operation(body, CoreOpcode::Call)
}

fn invoke(body: &FunctionBody, block_index: usize) -> (&wedge::ir::Operation, &wedge::ir::Edge) {
    match &body.blocks[block_index].terminator.kind {
        TerminatorKind::Invoke {
            operation, normal, ..
        } => (operation, normal),
        other => panic!(
            "{} is not an invoke: {other:?}",
            body.blocks[block_index].id
        ),
    }
}

fn routing_mut(body: &mut FunctionBody, block_index: usize) -> &mut ExceptionRouting {
    body.blocks[block_index]
        .terminator
        .exception
        .as_mut()
        .expect("invoke routing")
}

fn block_by_id(body: &FunctionBody, id: BlockId) -> &wedge::ir::Block {
    body.block(id).unwrap_or_else(|| panic!("missing {id}"))
}

/// Compiles `exception_routing.wat`, lets `corrupt` edit the exported
/// function given its routed call's block index, and returns the verifier's
/// report.
fn rejection(export: &str, corrupt: impl FnOnce(&mut FunctionBody, usize)) -> String {
    let mut program = compile_fixture("exception_routing");
    let function = function_id(&program, export);
    let body = program.functions[function.index()].body.as_mut().unwrap();
    let (block_index, _) = routed_call(body);
    corrupt(body, block_index);
    verification_error(&program)
}

fn arm_target(body: &FunctionBody, handler: wedge::ir::RegionId, clause: u32) -> BlockId {
    let region = body
        .regions
        .iter()
        .find(|region| region.id == handler)
        .unwrap_or_else(|| panic!("missing {handler}"));
    let wedge::ir::RegionKind::TryTable { catches } = &region.kind else {
        panic!("{handler} is not a try_table");
    };
    catches[clause as usize].target
}

fn verification_error(program: &Program) -> String {
    program
        .verify()
        .expect_err("malformed exceptional IR should fail verification")
        .to_string()
}

#[test]
fn lowers_and_verifies_the_wabt_final_eh_fixture() {
    compile_fixture("exception_routing");
}

#[test]
fn tail_calls_explicitly_escape_instead_of_entering_local_handlers() {
    let terminator = Terminator::new(
        TerminatorKind::TailCall {
            callee: Callee::Direct(FunctionId(0)),
            arguments: vec![],
        },
        SourceInfo::synthetic(),
    );
    let routing = terminator.exception.expect("tail call exception routing");
    assert!(routing.arms.is_empty());
    assert!(routing.escapes);
}

#[test]
fn invokes_end_their_blocks_and_lead_their_continuations_with_results() {
    let program = compile_fixture("exception_routing");
    let mut invokes = 0;
    for function in &program.functions {
        let Some(body) = &function.body else {
            continue;
        };
        for block in &body.blocks {
            let TerminatorKind::Invoke {
                operation, normal, ..
            } = &block.terminator.kind
            else {
                continue;
            };
            invokes += 1;
            let routing = block
                .terminator
                .exception
                .as_ref()
                .expect("an invoke carries its routing");
            assert!(!routing.arms.is_empty(), "{} routes to a handler", block.id);
            let continuation = block_by_id(body, normal.target);
            let results = &operation.signature.results;
            assert!(continuation.parameters.len() >= results.len());
            for (parameter, result) in continuation.parameters.iter().zip(results) {
                assert_eq!(
                    &parameter.ty, result,
                    "{} leads with the results",
                    normal.target
                );
            }
            assert_eq!(
                normal.arguments.len() + results.len(),
                continuation.parameters.len()
            );
            assert!(routing.arms.iter().all(|arm| arm.target != normal.target));
        }
    }
    assert!(invokes > 0);
}

#[test]
fn exceptional_edges_name_their_clause_targets() {
    for fixture in [
        "exception_routing",
        "loop_label_arguments",
        "catch_after_catch_all",
    ] {
        let program = compile_fixture(fixture);
        for function in &program.functions {
            let Some(body) = &function.body else {
                continue;
            };
            for block in &body.blocks {
                let Some(routing) = &block.terminator.exception else {
                    continue;
                };
                for arm in &routing.arms {
                    assert_eq!(
                        arm.target,
                        arm_target(body, arm.handler, arm.clause),
                        "{fixture}: {} arm {}#{}",
                        block.id,
                        arm.handler,
                        arm.clause
                    );
                }
            }
        }
    }
}

#[test]
fn exceptional_only_local_reads_lower_without_a_normal_predecessor() {
    let program = compile_fixture("exception_routing");
    let body = body(&program, "exceptional_only_local");
    let (_, routing) = routed_call(body);
    assert_eq!(routing.arms.len(), 1);
    assert!(
        routing.escapes,
        "the tagged catch does not catch other tags"
    );
}

#[test]
fn mixed_normal_and_exceptional_local_values_form_a_typed_merge() {
    let program = compile_fixture("exception_routing");
    let body = body(&program, "mixed_local");
    let (_, routing) = routed_call(body);
    let arm = &routing.arms[0];
    let target = arm_target(body, arm.handler, arm.clause);
    let target = body
        .blocks
        .iter()
        .find(|block| block.id == target)
        .expect("catch target");

    assert_eq!(target.parameters.len(), 1, "local merge parameter");
    assert_eq!(arm.arguments.len(), target.parameters.len());
    assert!(matches!(arm.arguments[0], ExceptionalArgument::Value(_)));
}

#[test]
fn distinct_exception_points_snapshot_distinct_local_definitions() {
    let program = compile_fixture("exception_routing");
    let body = body(&program, "two_exception_points");
    let calls: Vec<_> = body
        .blocks
        .iter()
        .filter_map(|block| match &block.terminator.kind {
            TerminatorKind::Invoke { operation, .. }
                if operation.kind == OperationKind::Core(CoreOpcode::Call) =>
            {
                block
                    .terminator
                    .exception
                    .as_ref()
                    .map(|routing| (block.id, routing))
            }
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 2);
    assert_ne!(calls[0].0, calls[1].0, "each call ends its own block");
    assert_eq!(
        (calls[0].1.arms[0].handler, calls[0].1.arms[0].clause),
        (calls[1].1.arms[0].handler, calls[1].1.arms[0].clause)
    );
    assert_ne!(
        calls[0].1.arms[0].arguments.last(),
        calls[1].1.arms[0].arguments.last(),
        "the two routes must carry the local values live at their own calls"
    );
}

#[test]
fn invoke_results_are_the_leading_parameters_of_the_continuation() {
    let program = compile_fixture("exception_routing");
    let body = body(&program, "normal_only_call_result");
    let (block_index, routing) = routed_call(body);
    let (operation, normal) = invoke(body, block_index);
    assert_eq!(operation.signature.results, [ValueType::I32]);
    let continuation = block_by_id(body, normal.target);
    assert_eq!(continuation.parameters.len(), 1);
    assert_eq!(continuation.parameters[0].ty, ValueType::I32);
    assert!(normal.arguments.is_empty());
    assert!(routing.arms.iter().all(|arm| arm.target != normal.target));
}

#[test]
fn retains_all_ordered_clauses_through_catch_all() {
    let program = compile_fixture("exception_routing");
    let body = body(&program, "multiple_clauses");
    let (_, routing) = routed_call(body);
    assert_eq!(
        routing
            .arms
            .iter()
            .map(|arm| arm.clause)
            .collect::<Vec<_>>(),
        [0, 1, 2]
    );
    assert!(!routing.escapes);
    assert!(routing.arms.iter().all(|arm| arm.arguments.is_empty()));
}

#[test]
fn attaches_the_same_lexical_routes_to_all_catchable_call_forms() {
    let program = compile_fixture("exception_routing");
    for (export, opcode) in [
        ("indirect_call", CoreOpcode::CallIndirect),
        ("reference_call", CoreOpcode::CallRef),
    ] {
        let body = body(&program, export);
        let (_, routing) = routed_operation(body, opcode);
        assert_eq!(routing.arms.len(), 1);
        assert!(routing.escapes);
    }
}

#[test]
fn catch_ref_and_catch_all_ref_materialize_exception_provenance() {
    let program = compile_fixture("exception_routing");
    for (export, escapes, kind) in [
        ("catch_ref_call", true, CatchKind::CatchRef),
        ("catch_all_ref_call", false, CatchKind::CatchAllRef),
    ] {
        let body = body(&program, export);
        let (_, routing) = routed_call(body);
        assert_eq!(routing.escapes, escapes);
        assert_eq!(
            routing.arms[0].arguments,
            [ExceptionalArgument::CaughtException]
        );
        let region = body
            .regions
            .iter()
            .find(|region| region.id == routing.arms[0].handler)
            .expect("handler region");
        let wedge::ir::RegionKind::TryTable { catches } = &region.kind else {
            unreachable!();
        };
        assert_eq!(catches[routing.arms[0].clause as usize].kind, kind);
    }
}

#[test]
fn dynamic_tag_payloads_retain_field_index_and_type_provenance() {
    let program = compile_fixture("exception_routing");
    let body = body(&program, "caught_payload_call");
    let (_, routing) = routed_call(body);
    assert_eq!(
        routing.arms[0].arguments,
        [ExceptionalArgument::CaughtPayload {
            index: 0,
            ty: ValueType::I32,
        }]
    );
}

#[test]
fn nested_handlers_preserve_inner_to_outer_fallback_order() {
    let program = compile_fixture("exception_routing");
    let body = body(&program, "nested_fallback");
    let (_, routing) = routed_call(body);
    assert_eq!(routing.arms.len(), 2);
    assert_ne!(routing.arms[0].handler, routing.arms[1].handler);
    assert!(routing.escapes);
}

#[test]
fn known_throw_uses_existing_payload_ssa_values() {
    let program = compile_fixture("exception_routing");
    let body = body(&program, "known_throw_payload_and_local");
    let (arguments, routing) = body
        .blocks
        .iter()
        .find_map(
            |block| match (&block.terminator.kind, &block.terminator.exception) {
                (TerminatorKind::Throw { arguments, .. }, Some(routing)) => {
                    Some((arguments, routing))
                }
                _ => None,
            },
        )
        .expect("known throw terminator");
    assert_eq!(routing.arms.len(), 1);
    assert!(!routing.escapes);
    assert_eq!(
        routing.arms[0].arguments.first(),
        Some(&ExceptionalArgument::Value(arguments[0]))
    );
}

fn invoke_result(body: &FunctionBody, block_index: usize) -> ValueId {
    let (_, normal) = invoke(body, block_index);
    block_by_id(body, normal.target).parameters[0].id
}

#[test]
fn verifier_rejects_an_invoke_result_on_an_exceptional_edge() {
    let error = rejection("normal_only_call_result", |body, block_index| {
        let result = invoke_result(body, block_index);
        let argument = routing_mut(body, block_index).arms[0]
            .arguments
            .last_mut()
            .expect("exceptional local-state argument");
        *argument = ExceptionalArgument::Value(result);
    });
    assert!(error.contains("does not dominate"), "{error}");
}

#[test]
fn verifier_rejects_an_invoke_result_used_in_its_source_block() {
    let error = rejection("normal_only_call_result", |body, block_index| {
        let result = invoke_result(body, block_index);
        body.blocks[block_index]
            .instructions
            .push(wedge::ir::Instruction::new(
                wedge::ir::InstructionId(9_000),
                wedge::ir::Operation::synthetic("wedge.test_use", vec![ValueType::I32], vec![]),
                vec![result],
                vec![],
                SourceInfo::synthetic(),
            ));
    });
    assert!(error.contains("does not dominate"), "{error}");
}

#[test]
fn verifier_rejects_an_invoke_result_used_by_its_handler() {
    let error = rejection("normal_only_call_result", |body, block_index| {
        let result = invoke_result(body, block_index);
        let target = routing_mut(body, block_index).arms[0].target;
        let target = body
            .blocks
            .iter_mut()
            .find(|block| block.id == target)
            .expect("handler target");
        target.terminator = Terminator::new(
            TerminatorKind::Return {
                values: vec![result],
            },
            target.terminator.source,
        );
    });
    assert!(error.contains("does not dominate"), "{error}");
}

#[test]
fn verifier_rejects_a_continuation_without_the_result_parameters() {
    let error = rejection("normal_only_call_result", |body, block_index| {
        let (_, normal) = invoke(body, block_index);
        let continuation = normal.target;
        body.blocks
            .iter_mut()
            .find(|block| block.id == continuation)
            .expect("continuation")
            .parameters
            .clear();
    });
    assert!(
        error.contains("declares 0 parameters, but call produces 1 results"),
        "{error}"
    );
}

#[test]
fn verifier_rejects_a_mistyped_result_parameter() {
    let error = rejection("normal_only_call_result", |body, block_index| {
        let (_, normal) = invoke(body, block_index);
        let continuation = normal.target;
        body.blocks
            .iter_mut()
            .find(|block| block.id == continuation)
            .expect("continuation")
            .parameters[0]
            .ty = ValueType::I64;
    });
    assert!(
        error.contains("parameter 0 is i64, expected call result i32"),
        "{error}"
    );
}

#[test]
fn verifier_rejects_corrupted_exception_routing() {
    // One-field corruptions of an otherwise valid routing, each caught by a
    // different verifier rule.
    let cases: [(&str, fn(&mut ExceptionRouting, BlockId), &str); 5] = [
        (
            "normal_only_call_result",
            |routing, _| routing.arms.clear(),
            "invoke has no in-function exception route",
        ),
        (
            "normal_only_call_result",
            |routing, continuation| routing.arms[0].target = continuation,
            "but the clause targets",
        ),
        (
            "multiple_clauses",
            |routing, _| routing.arms.swap(0, 1),
            "expected lexical routes",
        ),
        (
            "multiple_clauses",
            |routing, _| routing.escapes = true,
            "expected escapes=false",
        ),
        (
            "catch_ref_call",
            |routing, _| {
                routing.arms[0].arguments[0] = ExceptionalArgument::CaughtPayload {
                    index: 0,
                    ty: ValueType::I32,
                }
            },
            "caught field",
        ),
    ];
    for (export, corrupt, expected) in cases {
        let error = rejection(export, |body, block_index| {
            let (_, normal) = invoke(body, block_index);
            let continuation = normal.target;
            corrupt(routing_mut(body, block_index), continuation);
        });
        let accepted_alias = expected == "caught field" && error.contains("payload slot");
        assert!(
            error.contains(expected) || accepted_alias,
            "{export}: expected {expected:?} in:\n{error}"
        );
    }
}

#[test]
fn exception_arms_carry_every_nested_loop_header_parameter() {
    let program = compile_fixture("loop_label_arguments");
    for name in [
        "call_routes_to_nested_loop_labels",
        "call_routes_carry_nested_loop_locals",
    ] {
        let body = body(&program, name);
        let (_, routing) = routed_call(body);
        assert_eq!(routing.arms.len(), 2, "{name}: both clauses are visible");
        assert!(!routing.escapes, "{name}: catch_all stops the escape");
        for arm in &routing.arms {
            let target = arm_target(body, arm.handler, arm.clause);
            let parameters = block_by_id(body, target).parameters.len();
            assert_eq!(
                arm.arguments.len(),
                parameters,
                "{name}: exception route {}#{} to {target} is complete",
                arm.handler,
                arm.clause
            );
        }
    }

    let body = body(&program, "call_routes_carry_nested_loop_locals");
    let (_, routing) = routed_call(body);
    let snapshots: Vec<_> = routing
        .arms
        .iter()
        .map(|arm| match arm.arguments.as_slice() {
            [ExceptionalArgument::Value(value)] => *value,
            other => panic!("the loop-carried local is one ordinary value, not {other:?}"),
        })
        .collect();
    assert_eq!(
        snapshots[0], snapshots[1],
        "both arms snapshot the same definition of the local"
    );
    for arm in &routing.arms {
        let target = arm_target(body, arm.handler, arm.clause);
        let header = block_by_id(body, target);
        assert_eq!(
            header.parameters.len(),
            1,
            "{target} keeps the loop-carried local"
        );
        assert_eq!(header.parameters[0].ty, ValueType::I32);
    }
}

#[test]
fn a_catch_clause_after_catch_all_is_a_dead_arm() {
    let program = compile_fixture("catch_after_catch_all");
    let body = body(&program, "catch_after_catch_all");
    let (_, routing) = routed_call(body);
    let clauses: Vec<_> = routing.arms.iter().map(|arm| arm.clause).collect();
    assert_eq!(clauses, vec![0], "routing stops at catch_all");
    assert!(!routing.escapes);
    let retained = body
        .regions
        .iter()
        .find_map(|region| match &region.kind {
            wedge::ir::RegionKind::TryTable { catches } => Some(catches.len()),
            _ => None,
        })
        .expect("the try_table region is retained");
    assert_eq!(retained, 2, "the dead clause stays as source structure");
}

fn known_throw(body: &FunctionBody) -> (&[ValueId], &ExceptionRouting) {
    body.blocks
        .iter()
        .find_map(
            |block| match (&block.terminator.kind, &block.terminator.exception) {
                (TerminatorKind::Throw { arguments, .. }, Some(routing)) => {
                    Some((arguments.as_slice(), routing))
                }
                _ => None,
            },
        )
        .expect("known throw terminator")
}

fn known_throw_routing_mut<'a>(program: &'a mut Program, export: &str) -> &'a mut ExceptionRouting {
    let function = function_id(program, export);
    program.functions[function.index()]
        .body
        .as_mut()
        .expect("function has a body")
        .blocks
        .iter_mut()
        .find_map(|block| match block.terminator.kind {
            TerminatorKind::Throw { .. } => block.terminator.exception.as_mut(),
            _ => None,
        })
        .expect("known throw routing")
}

#[test]
fn a_known_throw_may_be_caught_by_an_aliasing_imported_tag() {
    let program = compile_fixture("tag_aliasing");

    let (thrown, routing) = known_throw(body(&program, "possible_alias"));
    assert_eq!(routing.arms.len(), 1);
    assert_eq!(
        routing.arms[0].arguments,
        vec![ExceptionalArgument::Value(thrown[0])],
        "a possible match carries the thrown payload like a definite one"
    );
    assert!(
        routing.escapes,
        "a possible match alone leaves the escape open"
    );

    let (thrown, routing) = known_throw(body(&program, "possible_then_definite"));
    let clauses: Vec<_> = routing.arms.iter().map(|arm| arm.clause).collect();
    assert_eq!(clauses, vec![0, 1]);
    for arm in &routing.arms {
        assert_eq!(arm.arguments, vec![ExceptionalArgument::Value(thrown[0])]);
    }
    assert!(!routing.escapes, "the definite match ends the search");

    let (_, routing) = known_throw(body(&program, "possible_then_catch_all"));
    let clauses: Vec<_> = routing.arms.iter().map(|arm| arm.clause).collect();
    assert_eq!(clauses, vec![0, 1]);
    assert!(routing.arms[1].arguments.is_empty());
    assert!(!routing.escapes);
}

#[test]
fn tags_alias_only_when_both_are_imported_with_equivalent_types() {
    let program = compile_fixture("tag_aliasing");
    for name in ["different_type_no_alias", "defined_no_alias"] {
        let (_, routing) = known_throw(body(&program, name));
        assert!(routing.arms.is_empty(), "{name}: no clause can match");
        assert!(routing.escapes, "{name}: the throw escapes");
    }

    let (t1, t2, wide, local) = (TagId(0), TagId(1), TagId(2), TagId(3));
    assert!(program.tags_may_alias(t1, t2));
    assert!(program.tags_may_alias(t2, t1));
    assert!(program.tags_may_alias(t1, t1));
    assert!(program.tags_may_alias(local, local));
    assert!(!program.tags_may_alias(t1, wide));
    assert!(!program.tags_may_alias(t1, local));
    assert!(!program.tags_may_alias(local, t1));
    assert!(!program.tags_may_alias(t1, TagId(99)));
}

#[test]
fn verifier_requires_the_possible_alias_arm_and_its_escape() {
    let mut program = compile_fixture("tag_aliasing");
    known_throw_routing_mut(&mut program, "possible_alias")
        .arms
        .clear();
    let error = verification_error(&program);
    assert!(
        error.contains("expected lexical routes [(RegionId("),
        "{error}"
    );
    assert!(
        error.contains("catches tag1, which may alias thrown tag0"),
        "{error}"
    );

    let mut program = compile_fixture("tag_aliasing");
    known_throw_routing_mut(&mut program, "possible_alias").escapes = false;
    let error = verification_error(&program);
    assert!(
        error.contains("exception route escapes=false, expected escapes=true"),
        "{error}"
    );
}
