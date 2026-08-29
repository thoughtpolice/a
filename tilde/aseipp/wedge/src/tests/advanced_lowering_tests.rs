// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! End-to-end contracts for calls, final exception handling, and reference-
//! refining control flow.

use std::collections::BTreeMap;

use wedge::Compiler;
use wedge::ir::{
    Block, Callee, CatchClause, CatchKind, Edge, ExportItem, Function, FunctionBody, FunctionId,
    HeapType, Immediate, Instruction, OperationKind, Program, RefType, RegionKind, TableId, TagId,
    TerminatorKind, TypeId, ValueId, ValueType,
};
use wedge::opcode::CoreOpcode;
mod fixture_support;

use fixture_support::{block, compile_fixture, exported_function, instructions};

fn compile_bytes(wasm: &[u8]) -> Program {
    let program = Compiler::default()
        .compile(wasm)
        .unwrap_or_else(|error| panic!("compile hand-encoded Wasm module: {error}"));
    program
        .verify()
        .unwrap_or_else(|errors| panic!("frontend emitted invalid IR:\n{errors}"));
    program
}

fn refined_argument(edge: &Edge) -> (usize, ValueId) {
    assert_eq!(edge.refinements.len(), 1, "{edge:?}");
    let index = edge.refinements[0].slot as usize;
    (index, edge.arguments[index])
}

/// Every refined edge of `body` stores exactly the type its target parameter
/// assumes.
fn assert_refinements_match_target_parameters(body: &FunctionBody) {
    let mut refined = 0;
    for source in &body.blocks {
        let TerminatorKind::Branch {
            then_edge,
            else_edge,
            ..
        } = &source.terminator.kind
        else {
            continue;
        };
        for edge in [then_edge, else_edge] {
            for refinement in &edge.refinements {
                refined += 1;
                let parameter = &block(body, edge.target).parameters[refinement.slot as usize];
                assert_eq!(
                    refinement.proven, parameter.ty,
                    "{} slot {} stores its target's type",
                    edge.target, refinement.slot
                );
            }
        }
    }
    assert!(refined > 0, "the function has refined edges");
}

fn assert_no_legacy_reference_refinements(body: &FunctionBody) {
    assert!(
        body.blocks.iter().all(
            |block| block.instructions.iter().all(|instruction| !matches!(
                instruction.operation.mnemonic(),
                "wedge.refine_non_null" | "wedge.refine_reference"
            ))
        )
    );
}

fn push_u32_leb(output: &mut Vec<u8>, mut value: u32) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        output.push(if value == 0 { byte } else { byte | 0x80 });
        if value == 0 {
            break;
        }
    }
}

fn push_section(module: &mut Vec<u8>, id: u8, payload: &[u8]) {
    module.push(id);
    push_u32_leb(module, payload.len() as u32);
    module.extend_from_slice(payload);
}

fn push_name(output: &mut Vec<u8>, name: &str) {
    push_u32_leb(output, name.len() as u32);
    output.extend_from_slice(name.as_bytes());
}

/// WABT at `third-party//by-name/wa/wabt` does not recognize either cast-
/// branch mnemonic yet. Keep this tiny binary encoder local to the test so the
/// standard instructions are still covered without adding another dependency.
fn cast_branch_module() -> Vec<u8> {
    const REF_NULL: u8 = 0x63;
    const REF: u8 = 0x64;
    const ANY: u8 = 0x6e;
    const EQ: u8 = 0x6d;
    const BR_ON_CAST: u8 = 0x18;
    const BR_ON_CAST_FAIL: u8 = 0x19;

    let mut module = b"\0asm\x01\0\0\0".to_vec();

    // The first signature is shared by the four scalar cases. The other two
    // types describe a multi-value block and its containing function.
    push_section(
        &mut module,
        1,
        &[
            3, // type count
            0x60, 1, REF_NULL, ANY, 1, REF_NULL, ANY, 0x60, 0, 2, 0x7f, REF_NULL, EQ, 0x60, 2,
            0x7f, REF_NULL, ANY, 2, 0x7f, REF_NULL, ANY,
        ],
    );

    let mut functions = vec![5];
    functions.extend_from_slice(&[0; 4]);
    functions.push(2);
    push_section(&mut module, 3, &functions);

    let cases = [
        ("cast_nullable_success", BR_ON_CAST, true),
        ("cast_non_null_success", BR_ON_CAST, false),
        ("cast_nullable_failure", BR_ON_CAST_FAIL, true),
        ("cast_non_null_failure", BR_ON_CAST_FAIL, false),
    ];
    let mut exports = vec![(cases.len() + 1) as u8];
    for (index, (name, _, _)) in cases.iter().enumerate() {
        push_name(&mut exports, name);
        exports.push(0); // function export
        push_u32_leb(&mut exports, index as u32);
    }
    push_name(&mut exports, "cast_with_prefix");
    exports.push(0);
    push_u32_leb(&mut exports, cases.len() as u32);
    push_section(&mut module, 7, &exports);

    let mut code = vec![(cases.len() + 1) as u8];
    for (_, opcode, target_nullable) in cases {
        let (label_prefix, label_heap) = if opcode == BR_ON_CAST {
            (if target_nullable { REF_NULL } else { REF }, EQ)
        } else {
            // A failed nullable cast excludes null; a failed non-null cast
            // preserves the source's nullability.
            (if target_nullable { REF } else { REF_NULL }, ANY)
        };
        let flags = 1 | (u8::from(target_nullable) << 1); // nullable source
        let body = [
            0, // local declaration groups
            0x02,
            label_prefix,
            label_heap, // block (result <branch result>)
            0x20,
            0, // local.get 0
            0xfb,
            opcode,
            flags,
            0, // depth 0
            ANY,
            EQ,   // from/to heap types
            0x0f, // return on fallthrough
            0x0b, // end block
            0x0b, // end function
        ];
        push_u32_leb(&mut code, body.len() as u32);
        code.extend_from_slice(&body);
    }
    let prefix_body = [
        0, // local declaration groups
        0x02, 1, // block type 1: (result i32 (ref null eq))
        0x20, 0, // local.get 0, preserved label prefix
        0x20, 1, // local.get 1, cast operand
        0xfb, BR_ON_CAST, 3, // nullable source and target
        0, // depth 0
        ANY, EQ, 0x0f, // return on fallthrough
        0x0b, // end block
        0x0b, // end function
    ];
    push_u32_leb(&mut code, prefix_body.len() as u32);
    code.extend_from_slice(&prefix_body);
    push_section(&mut module, 10, &code);
    module
}

fn concrete_cast_branch_module() -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    push_section(
        &mut module,
        1,
        &[
            2, // type count
            0x60, 1, 0x7f, 1, 0x7f, // type 0: (func (param i32) (result i32))
            0x60, 1, 0x70, 1, 0x70, // type 1: (func (param funcref) (result funcref))
        ],
    );
    push_section(&mut module, 3, &[1, 1]);

    let mut exports = vec![1];
    push_name(&mut exports, "cast_concrete_function");
    exports.extend_from_slice(&[0, 0]);
    push_section(&mut module, 7, &exports);

    let body = [
        0, // local declaration groups
        0x02, 0x63, 0, // block (result (ref null type 0))
        0x20, 0, // local.get 0
        0xfb, 0x18, // br_on_cast
        3,    // nullable source and target
        0,    // depth 0
        0x70, // func heap type
        0,    // concrete heap type 0
        0x0f, // return on fallthrough
        0x0b, // end block
        0x0b, // end function
    ];
    let mut code = vec![1];
    push_u32_leb(&mut code, body.len() as u32);
    code.extend_from_slice(&body);
    push_section(&mut module, 10, &code);
    module
}

/// Exercises the validator rule that the actual operand need only be a subtype
/// of the instruction's declared `from` type. The two final struct types are
/// distinct siblings below the same non-final base type.
fn sibling_subtype_cast_branch_module() -> Vec<u8> {
    const REF_NULL: u8 = 0x63;
    const REF: u8 = 0x64;
    const BR_ON_CAST: u8 = 0x18;
    const BR_ON_CAST_FAIL: u8 = 0x19;

    let mut module = b"\0asm\x01\0\0\0".to_vec();
    push_section(
        &mut module,
        1,
        &[
            4, // type count
            0x50, 0, 0x5f, 0, // type 0: non-final empty struct base
            0x4f, 1, 0, 0x5f, 1, 0x7f, 0, // type 1: final subtype 0, immutable i32 field
            0x4f, 1, 0, 0x5f, 1, 0x7e, 0, // type 2: final subtype 0, immutable i64 field
            0x60, 1, REF_NULL, 1, 1, REF_NULL,
            0,
            // type 3: (func (param (ref null 1)) (result (ref null 0)))
        ],
    );
    push_section(&mut module, 3, &[2, 3, 3]);

    let names = ["cast_sibling_success", "cast_sibling_failure"];
    let mut exports = vec![names.len() as u8];
    for (index, name) in names.into_iter().enumerate() {
        push_name(&mut exports, name);
        exports.push(0); // function export
        push_u32_leb(&mut exports, index as u32);
    }
    push_section(&mut module, 7, &exports);

    let cases = [
        (BR_ON_CAST, REF_NULL, 2), // success edge carries the sibling type
        (BR_ON_CAST_FAIL, REF, 0), // failure edge carries difference(from, to)
    ];
    let mut code = vec![cases.len() as u8];
    for (opcode, label_prefix, label_heap) in cases {
        let body = [
            0, // local declaration groups
            0x02,
            label_prefix,
            label_heap, // block result used by the taken edge
            0x20,
            0, // local.get 0: actual type is (ref null type 1)
            0xfb,
            opcode,
            3,    // nullable declared source and target
            0,    // depth 0
            0,    // declared from heap type 0
            2,    // cast target heap type 2, a sibling of the operand's type 1
            0x0f, // return on fallthrough
            0x0b, // end block
            0x0b, // end function
        ];
        push_u32_leb(&mut code, body.len() as u32);
        code.extend_from_slice(&body);
    }
    push_section(&mut module, 10, &code);
    module
}

/// Uses two distinct module indices that wasmparser assigns one canonical
/// CoreTypeId. Both cast directions exercise the raw-index/canonical-index
/// boundary in the validator-derived fallthrough type.
fn equivalent_concrete_cast_branch_module() -> Vec<u8> {
    const REF_NULL: u8 = 0x63;
    const REF: u8 = 0x64;
    const BR_ON_CAST: u8 = 0x18;
    const BR_ON_CAST_FAIL: u8 = 0x19;

    let mut module = b"\0asm\x01\0\0\0".to_vec();
    push_section(
        &mut module,
        1,
        &[
            3, // type count
            0x60, 0, 0, // type 0: (func)
            0x60, 0, 0, // type 1: distinct module index, canonically type 0
            0x60, 1, REF_NULL, 1, 1, REF_NULL,
            1,
            // type 2: (func (param (ref null 1)) (result (ref null 1)))
        ],
    );
    push_section(&mut module, 3, &[2, 2, 2]);

    let names = ["cast_alias_success", "cast_alias_failure"];
    let mut exports = vec![names.len() as u8];
    for (index, name) in names.into_iter().enumerate() {
        push_name(&mut exports, name);
        exports.push(0); // function export
        push_u32_leb(&mut exports, index as u32);
    }
    push_section(&mut module, 7, &exports);

    let cases = [(BR_ON_CAST, REF_NULL), (BR_ON_CAST_FAIL, REF)];
    let mut code = vec![cases.len() as u8];
    for (opcode, label_prefix) in cases {
        let body = [
            0, // local declaration groups
            0x02,
            label_prefix,
            1, // block result uses the second, equivalent module type index
            0x20,
            0, // local.get 0
            0xfb,
            opcode,
            3,    // nullable declared source and target
            0,    // depth 0
            1,    // declared from heap type 1
            1,    // cast target heap type 1
            0x0f, // return on fallthrough
            0x0b, // end block
            0x0b, // end function
        ];
        push_u32_leb(&mut code, body.len() as u32);
        code.extend_from_slice(&body);
    }
    push_section(&mut module, 10, &code);
    module
}

fn body<'a>(program: &'a Program, name: &str) -> &'a FunctionBody {
    exported_function(program, name)
        .body
        .as_ref()
        .unwrap_or_else(|| panic!("exported function {name:?} has no body"))
}

fn instruction<'a>(body: &'a FunctionBody, mnemonic: &str) -> &'a Instruction {
    instructions(body)
        .find(|instruction| instruction.operation.mnemonic == mnemonic)
        .unwrap_or_else(|| panic!("function did not lower {mnemonic}"))
}

fn value_types(body: &FunctionBody) -> BTreeMap<ValueId, ValueType> {
    body.blocks
        .iter()
        .flat_map(|block| {
            block.parameters.iter().chain(
                block
                    .instructions
                    .iter()
                    .flat_map(|instruction| &instruction.results),
            )
        })
        .map(|definition| (definition.id, definition.ty.clone()))
        .collect()
}

fn tail_call(body: &FunctionBody) -> (&Callee, &[ValueId]) {
    let calls: Vec<_> = body
        .blocks
        .iter()
        .filter_map(|block| {
            if let TerminatorKind::TailCall { callee, arguments } = &block.terminator.kind {
                Some((callee, arguments.as_slice()))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(calls.len(), 1, "function should have one tail-call exit");
    calls[0]
}

fn returned_values(body: &FunctionBody) -> Vec<ValueId> {
    body.blocks
        .iter()
        .filter_map(|block| {
            if let TerminatorKind::Return { values } = &block.terminator.kind {
                Some(values.iter().copied())
            } else {
                None
            }
        })
        .flatten()
        .collect()
}

fn catch_clause(
    program: &Program,
    expected_kind: CatchKind,
    expected_tag: TagId,
) -> (&FunctionBody, CatchClause) {
    program
        .functions
        .iter()
        .filter_map(|function| function.body.as_ref())
        .find_map(|body| {
            body.regions.iter().find_map(|region| {
                let RegionKind::TryTable { catches } = &region.kind else {
                    return None;
                };
                catches
                    .iter()
                    .copied()
                    .find(|catch| catch.kind == expected_kind && catch.tag == Some(expected_tag))
                    .map(|catch| (body, catch))
            })
        })
        .unwrap_or_else(|| panic!("missing {expected_kind:?} for {expected_tag}"))
}

fn non_null_ref(heap: HeapType) -> ValueType {
    ValueType::Ref(RefType {
        nullable: false,
        heap,
    })
}

fn nullable_ref(heap: HeapType) -> ValueType {
    ValueType::Ref(RefType {
        nullable: true,
        heap,
    })
}

#[test]
fn lowers_direct_and_indirect_tail_call_fixture() {
    compile_fixture("tail_calls");
}

#[test]
fn lowers_direct_tail_calls_as_typed_exit_terminators() {
    let program = compile_fixture("tail_calls");
    let function_body = body(&program, "tail");
    let (callee, arguments) = tail_call(function_body);

    assert_eq!(callee, &Callee::Direct(FunctionId(0)));
    assert_eq!(
        arguments,
        [block(function_body, function_body.entry).parameters[0].id]
    );
}

#[test]
fn separates_indirect_tail_call_arguments_from_the_table_index() {
    let program = compile_fixture("tail_calls");
    let function_body = body(&program, "tail_indirect");
    let definitions = value_types(function_body);
    let (callee, arguments) = tail_call(function_body);

    let Callee::Indirect { ty, table, index } = callee else {
        panic!("expected an indirect tail-call callee, got {callee:?}");
    };
    assert_eq!((*ty, *table), (TypeId(0), TableId(0)));
    assert_eq!(definitions.get(index), Some(&ValueType::I32));
    assert_eq!(
        arguments,
        [block(function_body, function_body.entry).parameters[0].id]
    );
    assert_ne!(arguments, [*index]);
}

#[test]
fn lowers_typed_function_reference_calls() {
    compile_fixture("function_references");
}

#[test]
fn owns_call_ref_type_and_reference_operands() {
    let program = compile_fixture("function_references");
    let function_body = body(&program, "call_typed");
    let call = instruction(function_body, "call_ref");

    assert_eq!(
        call.operation.kind,
        OperationKind::Core(CoreOpcode::CallRef)
    );
    assert_eq!(call.operation.immediates, [Immediate::Type(TypeId(0))]);
    assert_eq!(call.operands.len(), 2);
    assert_eq!(call.operation.signature.results, [ValueType::I32]);
    assert_eq!(call.results.len(), 1);

    let reference = instruction(function_body, "ref.func");
    assert_eq!(
        reference.operation.immediates,
        [Immediate::Function(FunctionId(0))]
    );
    assert_eq!(
        reference.results[0].ty,
        non_null_ref(HeapType::Concrete(TypeId(0)))
    );
    assert_eq!(call.operands.last(), Some(&reference.results[0].id));
}

#[test]
fn lowers_return_call_ref_as_a_reference_tail_call() {
    let program = compile_fixture("function_references");
    let function_body = body(&program, "tail_typed");
    let definitions = value_types(function_body);
    let (callee, arguments) = tail_call(function_body);

    let Callee::Reference { ty, reference } = callee else {
        panic!("expected a reference tail-call callee, got {callee:?}");
    };
    assert_eq!(*ty, TypeId(0));
    assert_eq!(
        definitions.get(reference),
        Some(&non_null_ref(HeapType::Concrete(TypeId(0))))
    );
    assert_eq!(
        arguments,
        [block(function_body, function_body.entry).parameters[0].id]
    );
}

#[test]
fn lowers_final_exception_handling_fixture() {
    compile_fixture("exceptions");
}

#[test]
fn lowers_throw_with_typed_tag_arguments() {
    let program = compile_fixture("exceptions");
    let raise = program.functions[0].body.as_ref().expect("raise body");
    let throws: Vec<_> = raise
        .blocks
        .iter()
        .filter_map(|block| {
            if let TerminatorKind::Throw { tag, arguments } = &block.terminator.kind {
                Some((*tag, arguments.as_slice()))
            } else {
                None
            }
        })
        .collect();

    assert_eq!(throws.len(), 1);
    assert_eq!(throws[0].0, TagId(0));
    assert_eq!(throws[0].1, [block(raise, raise.entry).parameters[0].id]);
}

#[test]
fn represents_tagged_catch_and_catch_ref_as_try_table_regions() {
    let program = compile_fixture("exceptions");

    let (catch_body, caught) = catch_clause(&program, CatchKind::Catch, TagId(0));
    assert_eq!(
        block(catch_body, caught.target)
            .parameters
            .iter()
            .map(|parameter| parameter.ty.clone())
            .collect::<Vec<_>>(),
        [ValueType::I32]
    );

    let (catch_ref_body, caught_ref) = catch_clause(&program, CatchKind::CatchRef, TagId(1));
    assert_eq!(
        block(catch_ref_body, caught_ref.target)
            .parameters
            .iter()
            .map(|parameter| parameter.ty.clone())
            .collect::<Vec<_>>(),
        [nullable_ref(HeapType::Exn)]
    );
}

#[test]
fn associates_calls_in_try_table_with_their_handler_region() {
    let program = compile_fixture("exceptions");
    let function_body = body(&program, "catch");
    let routing = function_body
        .blocks
        .iter()
        .find_map(|block| match &block.terminator.kind {
            TerminatorKind::Invoke { operation, .. } if operation.mnemonic == "call" => {
                block.terminator.exception.as_ref()
            }
            _ => None,
        })
        .expect("call in try_table is an invoke with its handler region");
    let handler = routing
        .arms
        .first()
        .expect("call has a catch route")
        .handler;
    assert!(function_body.regions.iter().any(|region| {
        region.id == handler && matches!(&region.kind, RegionKind::TryTable { .. })
    }));
    assert!(
        routing.escapes,
        "other exception tags still escape the function"
    );
}

#[test]
fn lowers_throw_ref_with_the_label_declared_exception_type() {
    let program = compile_fixture("exceptions");
    let function_body = body(&program, "catch_and_rethrow");
    let definitions = value_types(function_body);
    let exceptions: Vec<_> = function_body
        .blocks
        .iter()
        .filter_map(|block| {
            if let TerminatorKind::ThrowRef { exception } = block.terminator.kind {
                Some(exception)
            } else {
                None
            }
        })
        .collect();

    assert_eq!(exceptions.len(), 1);
    assert_eq!(
        definitions.get(&exceptions[0]),
        Some(&nullable_ref(HeapType::Exn))
    );
}

#[test]
fn lowers_nullability_refining_reference_branches() {
    compile_fixture("reference_br_on_null");
    compile_fixture("reference_br_on_non_null");
}

#[test]
fn br_on_null_fallthrough_returns_a_non_null_reference() {
    let program = compile_fixture("reference_br_on_null");
    let function_body = body(&program, "refine_fallthrough");
    let definitions = value_types(function_body);
    let returns = returned_values(function_body);
    let source = function_body
        .blocks
        .iter()
        .find(|block| matches!(block.terminator.kind, TerminatorKind::Branch { .. }))
        .expect("br_on_null source block");
    let TerminatorKind::Branch {
        condition,
        then_edge,
        else_edge,
    } = &source.terminator.kind
    else {
        unreachable!()
    };
    let predicate = source
        .instructions
        .iter()
        .find(|instruction| {
            instruction.operation.kind == OperationKind::Core(CoreOpcode::RefIsNull)
        })
        .expect("ref.is_null predicate");
    assert_eq!(*condition, predicate.results[0].id);
    assert!(then_edge.refinements.is_empty());
    let (argument_index, original_reference) = refined_argument(else_edge);
    assert_eq!(argument_index, 0);
    assert_eq!(original_reference, predicate.operands[0]);
    assert_eq!(
        definitions.get(&original_reference),
        Some(&nullable_ref(HeapType::Extern))
    );
    let fallthrough = block(function_body, else_edge.target);
    assert_eq!(fallthrough.parameters[0].ty, non_null_ref(HeapType::Extern));

    assert_eq!(returns.len(), 1);
    assert_eq!(returns[0], fallthrough.parameters[0].id);
    assert_no_legacy_reference_refinements(function_body);
}

#[test]
fn br_on_non_null_taken_edge_carries_a_non_null_reference() {
    let program = compile_fixture("reference_br_on_non_null");
    let function_body = body(&program, "refine_taken");
    let entry = function_body.entry;
    let refined_parameters: Vec<_> = function_body
        .blocks
        .iter()
        .filter(|block| block.id != entry)
        .flat_map(|block| &block.parameters)
        .filter(|parameter| parameter.ty == non_null_ref(HeapType::Extern))
        .collect();

    assert_eq!(refined_parameters.len(), 1);
    let returns = returned_values(function_body);
    assert_eq!(returns, [refined_parameters[0].id]);
    let source = function_body
        .blocks
        .iter()
        .find(|block| matches!(block.terminator.kind, TerminatorKind::Branch { .. }))
        .expect("br_on_non_null source block");
    let TerminatorKind::Branch {
        condition,
        then_edge,
        else_edge,
    } = &source.terminator.kind
    else {
        unreachable!()
    };
    assert!(then_edge.refinements.is_empty());
    let (_, original_reference) = refined_argument(else_edge);
    let predicate = source
        .instructions
        .iter()
        .find(|instruction| {
            instruction.operation.kind == OperationKind::Core(CoreOpcode::RefIsNull)
        })
        .expect("ref.is_null predicate");
    assert_eq!(*condition, predicate.results[0].id);
    assert_eq!(original_reference, predicate.operands[0]);
    assert_no_legacy_reference_refinements(function_body);
}

#[test]
fn lowers_standard_cast_branches_from_hand_encoded_wasm() {
    let program = compile_bytes(&cast_branch_module());

    for name in [
        "cast_nullable_success",
        "cast_non_null_success",
        "cast_nullable_failure",
        "cast_non_null_failure",
        "cast_with_prefix",
    ] {
        let function_body = body(&program, name);
        assert!(
            function_body
                .blocks
                .iter()
                .any(|block| { matches!(block.terminator.kind, TerminatorKind::Branch { .. }) })
        );
    }
}

#[test]
fn br_on_cast_refines_both_success_and_failure_paths() {
    let program = compile_bytes(&cast_branch_module());

    for (name, test_opcode, cast_type, difference_type) in [
        (
            "cast_nullable_success",
            CoreOpcode::RefTestNullable,
            nullable_ref(HeapType::Eq),
            non_null_ref(HeapType::Any),
        ),
        (
            "cast_non_null_success",
            CoreOpcode::RefTestNonNull,
            non_null_ref(HeapType::Eq),
            nullable_ref(HeapType::Any),
        ),
    ] {
        let function_body = body(&program, name);
        let definitions = value_types(function_body);
        let source_block = function_body
            .blocks
            .iter()
            .find(|block| {
                block.instructions.iter().any(|instruction| {
                    instruction.operation.kind == OperationKind::Core(test_opcode)
                })
            })
            .unwrap_or_else(|| panic!("{name} has no reference test"));
        let test = source_block
            .instructions
            .iter()
            .find(|instruction| instruction.operation.kind == OperationKind::Core(test_opcode))
            .expect("reference test");
        assert_eq!(
            test.operation.immediates,
            [Immediate::HeapType(HeapType::Eq)]
        );

        let TerminatorKind::Branch {
            condition,
            then_edge,
            else_edge,
        } = &source_block.terminator.kind
        else {
            panic!("{name} cast did not become a conditional branch");
        };
        assert_eq!(*condition, test.results[0].id);

        let (taken_index, source_reference) = refined_argument(then_edge);
        assert_eq!(source_reference, test.operands[0]);
        assert_eq!(
            definitions.get(&source_reference),
            Some(&nullable_ref(HeapType::Any))
        );
        assert_eq!(
            block(function_body, then_edge.target)
                .parameters
                .get(taken_index)
                .map(|parameter| &parameter.ty),
            Some(&cast_type)
        );

        let fallthrough = block(function_body, else_edge.target);
        let (fallthrough_index, fallthrough_source) = refined_argument(else_edge);
        assert_eq!(fallthrough_source, source_reference);
        let fallthrough_parameter = &fallthrough.parameters[fallthrough_index];
        assert_eq!(fallthrough_parameter.ty, difference_type);
        assert!(matches!(
            fallthrough.terminator.kind,
            TerminatorKind::Return { ref values } if values == &[fallthrough_parameter.id]
        ));

        assert_eq!(test.source, source_block.terminator.source);
        assert_no_legacy_reference_refinements(function_body);
        let span = test.source.byte_span.expect("cast source byte span");
        assert_eq!(span.end - span.start, 6);
    }
}

#[test]
fn br_on_cast_fail_reverses_edges_without_losing_refined_types() {
    let program = compile_bytes(&cast_branch_module());

    for (name, test_opcode, cast_type, difference_type) in [
        (
            "cast_nullable_failure",
            CoreOpcode::RefTestNullable,
            nullable_ref(HeapType::Eq),
            non_null_ref(HeapType::Any),
        ),
        (
            "cast_non_null_failure",
            CoreOpcode::RefTestNonNull,
            non_null_ref(HeapType::Eq),
            nullable_ref(HeapType::Any),
        ),
    ] {
        let function_body = body(&program, name);
        let definitions = value_types(function_body);
        let source_block = function_body
            .blocks
            .iter()
            .find(|block| {
                block.instructions.iter().any(|instruction| {
                    instruction.operation.kind == OperationKind::Core(test_opcode)
                })
            })
            .unwrap_or_else(|| panic!("{name} has no reference test"));
        let test = source_block
            .instructions
            .iter()
            .find(|instruction| instruction.operation.kind == OperationKind::Core(test_opcode))
            .expect("reference test");
        let TerminatorKind::Branch {
            condition,
            then_edge,
            else_edge,
        } = &source_block.terminator.kind
        else {
            panic!("{name} cast did not become a conditional branch");
        };
        assert_eq!(*condition, test.results[0].id);

        // The test condition is true on cast success, so br_on_cast_fail's
        // taken label must be the else edge and carry the difference type.
        let (failed_index, source_reference) = refined_argument(else_edge);
        assert_eq!(source_reference, test.operands[0]);
        assert_eq!(
            definitions.get(&source_reference),
            Some(&nullable_ref(HeapType::Any))
        );
        assert_eq!(
            block(function_body, else_edge.target)
                .parameters
                .get(failed_index)
                .map(|parameter| &parameter.ty),
            Some(&difference_type)
        );

        let fallthrough = block(function_body, then_edge.target);
        let (fallthrough_index, fallthrough_source) = refined_argument(then_edge);
        assert_eq!(fallthrough_source, source_reference);
        let fallthrough_parameter = &fallthrough.parameters[fallthrough_index];
        assert_eq!(fallthrough_parameter.ty, cast_type);
        assert!(matches!(
            fallthrough.terminator.kind,
            TerminatorKind::Return { ref values } if values == &[fallthrough_parameter.id]
        ));

        assert_eq!(test.source, source_block.terminator.source);
        assert_no_legacy_reference_refinements(function_body);
    }
}

#[test]
fn cast_branch_preserves_multi_value_label_prefixes() {
    let program = compile_bytes(&cast_branch_module());
    let function_body = body(&program, "cast_with_prefix");
    let definitions = value_types(function_body);
    let source_block = function_body
        .blocks
        .iter()
        .find(|block| {
            block.instructions.iter().any(|instruction| {
                instruction.operation.kind == OperationKind::Core(CoreOpcode::RefTestNullable)
            })
        })
        .expect("cast source block");
    let TerminatorKind::Branch {
        then_edge,
        else_edge,
        ..
    } = &source_block.terminator.kind
    else {
        panic!("cast did not lower to a branch");
    };

    assert_eq!(then_edge.arguments.len(), 2);
    assert_eq!(then_edge.refinements.len(), 1);
    assert_eq!(then_edge.refinements[0].slot, 1);
    assert_eq!(
        definitions.get(&then_edge.arguments[0]),
        Some(&ValueType::I32)
    );
    assert_eq!(
        definitions.get(&then_edge.arguments[1]),
        Some(&nullable_ref(HeapType::Any))
    );
    assert_eq!(
        block(function_body, then_edge.target).parameters[1].ty,
        nullable_ref(HeapType::Eq)
    );

    let fallthrough = block(function_body, else_edge.target);
    let (fallthrough_index, source_reference) = refined_argument(else_edge);
    assert_eq!(source_reference, then_edge.arguments[1]);
    assert_eq!(
        fallthrough.parameters[fallthrough_index].ty,
        non_null_ref(HeapType::Any)
    );
    let TerminatorKind::Return { values } = &fallthrough.terminator.kind else {
        panic!("cast fallthrough should return its live prefix and reference");
    };
    assert_eq!(values.len(), 2);
    assert_eq!(definitions.get(&values[0]), Some(&ValueType::I32));
    assert_eq!(
        definitions.get(&values[1]),
        Some(&non_null_ref(HeapType::Any))
    );
    assert_no_legacy_reference_refinements(function_body);
}

#[test]
fn cast_branch_uses_canonical_concrete_types_from_the_validator() {
    let program = compile_bytes(&concrete_cast_branch_module());
    let function_body = body(&program, "cast_concrete_function");
    let definitions = value_types(function_body);
    let source_block = function_body
        .blocks
        .iter()
        .find(|block| {
            block.instructions.iter().any(|instruction| {
                instruction.operation.kind == OperationKind::Core(CoreOpcode::RefTestNullable)
            })
        })
        .expect("concrete cast source block");
    let test = source_block
        .instructions
        .iter()
        .find(|instruction| {
            instruction.operation.kind == OperationKind::Core(CoreOpcode::RefTestNullable)
        })
        .expect("concrete reference test");
    assert_eq!(
        test.operation.immediates,
        [Immediate::HeapType(HeapType::Concrete(TypeId(0)))]
    );

    let TerminatorKind::Branch {
        then_edge,
        else_edge,
        ..
    } = &source_block.terminator.kind
    else {
        panic!("concrete cast did not lower to a branch");
    };
    let (cast_index, cast_value) = refined_argument(then_edge);
    assert_eq!(
        definitions.get(&cast_value),
        Some(&nullable_ref(HeapType::Func))
    );
    assert_eq!(
        block(function_body, then_edge.target).parameters[cast_index].ty,
        nullable_ref(HeapType::Concrete(TypeId(0)))
    );

    let fallthrough = block(function_body, else_edge.target);
    let (fallthrough_index, fallthrough_value) = refined_argument(else_edge);
    assert_eq!(fallthrough_value, cast_value);
    assert_eq!(
        fallthrough.parameters[fallthrough_index].ty,
        non_null_ref(HeapType::Func)
    );
    assert_no_legacy_reference_refinements(function_body);
}

#[test]
fn cast_branches_accept_an_operand_from_a_sibling_subtype() {
    let program = compile_bytes(&sibling_subtype_cast_branch_module());
    let declared_from = nullable_ref(HeapType::Concrete(TypeId(0)));

    for name in ["cast_sibling_success", "cast_sibling_failure"] {
        let function_body = body(&program, name);
        let tests = function_body
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .filter(|instruction| {
                matches!(
                    instruction.operation.kind,
                    OperationKind::Core(CoreOpcode::RefTestNonNull | CoreOpcode::RefTestNullable)
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(tests.len(), 1, "{name}");
        assert_eq!(
            tests[0].operation.signature.params,
            [declared_from.clone()],
            "{name} must refine relative to the instruction's declared source type"
        );
        let source = function_body
            .blocks
            .iter()
            .find(|block| block.instructions.contains(tests[0]))
            .expect("reference-test source block");
        let TerminatorKind::Branch {
            then_edge,
            else_edge,
            ..
        } = &source.terminator.kind
        else {
            panic!("reference test must feed a branch")
        };
        assert_eq!(refined_argument(then_edge).1, tests[0].operands[0]);
        assert_eq!(refined_argument(else_edge).1, tests[0].operands[0]);
        assert_no_legacy_reference_refinements(function_body);
    }
}

#[test]
fn cast_branches_accept_equivalent_concrete_module_type_indices() {
    let program = compile_bytes(&equivalent_concrete_cast_branch_module());
    assert_eq!(program.types[1].canonical_alias, Some(TypeId(0)));

    for name in ["cast_alias_success", "cast_alias_failure"] {
        let function_body = body(&program, name);
        assert!(function_body.blocks.iter().any(|block| {
            block.instructions.iter().any(|instruction| {
                matches!(
                    instruction.operation.kind,
                    OperationKind::Core(CoreOpcode::RefTestNullable)
                ) && instruction.operation.immediates
                    == [Immediate::HeapType(HeapType::Concrete(TypeId(1)))]
            })
        }));
    }
}

#[test]
fn refined_edges_store_the_type_their_target_parameter_assumes() {
    for fixture in ["reference_br_on_null", "reference_br_on_non_null"] {
        let program = compile_fixture(fixture);
        for function in &program.functions {
            if let Some(body) = &function.body {
                assert_refinements_match_target_parameters(body);
            }
        }
    }
    let program = compile_bytes(&cast_branch_module());
    for function in &program.functions {
        if let Some(body) = &function.body {
            assert_refinements_match_target_parameters(body);
        }
    }
}
