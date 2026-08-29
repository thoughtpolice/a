// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! End-to-end contracts for sealed-block SSA construction in the frontend.

use std::collections::{BTreeMap, BTreeSet};

use wedge::ir::{
    Block, BlockId, Edge, ExportItem, Function, FunctionBody, HeapType, Immediate, Operation,
    Program, RefType, RegionKind, TerminatorKind, ValueId, ValueType,
};
use wedge::{CompileError, Compiler};
mod fixture_support;

use fixture_support::{block, compile_fixture, exported_function};
mod encoding_support;

use encoding_support::{append_section, encode_u32};

fn body<'a>(program: &'a Program, name: &str) -> &'a FunctionBody {
    exported_function(program, name)
        .body
        .as_ref()
        .unwrap_or_else(|| panic!("exported function {name:?} has no body"))
}

fn outgoing_edges(terminator: &TerminatorKind) -> Vec<&Edge> {
    terminator.edges().collect()
}

fn incoming_edges(body: &FunctionBody, target: BlockId) -> Vec<(BlockId, &Edge)> {
    body.blocks
        .iter()
        .flat_map(|source| {
            outgoing_edges(&source.terminator.kind)
                .into_iter()
                .filter(move |edge| edge.target == target)
                .map(move |edge| (source.id, edge))
        })
        .collect()
}

fn returned_values(body: &FunctionBody) -> Vec<ValueId> {
    let returns: Vec<_> = body
        .blocks
        .iter()
        .filter_map(|block| {
            if let TerminatorKind::Return { values } = &block.terminator.kind {
                Some(values.as_slice())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(returns.len(), 1, "test function should have one return");
    returns[0].to_vec()
}

fn defining_operations(body: &FunctionBody) -> BTreeMap<ValueId, (&ValueType, &Operation)> {
    body.blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .flat_map(|instruction| {
            instruction
                .results
                .iter()
                .map(move |result| (result.id, (&result.ty, &instruction.operation)))
        })
        .collect()
}

fn nullable_ref(heap: HeapType) -> ValueType {
    ValueType::Ref(RefType {
        nullable: true,
        heap,
    })
}

const I32_BINARY_TYPE: &[u8] = &[0x7f];
const NON_NULL_FUNCTION_TYPE: &[u8] = &[0x64, 0x00];

/// Encodes one function with a non-defaultable `(ref 0)` local.
///
/// These focused contracts use the standard binary encoding directly so the
/// deliberately invalid case reaches wasmparser instead of failing in WABT.
fn non_defaultable_local_module(parameters: &[&[u8]], operators: &[u8]) -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();

    let mut types = vec![
        0x02, // two types
        0x60, 0x00, 0x00, // type 0: () -> ()
        0x60, // type 1: the test function
    ];
    encode_u32(&mut types, parameters.len() as u32);
    for parameter in parameters {
        types.extend_from_slice(parameter);
    }
    types.push(0x01); // one result
    types.extend_from_slice(NON_NULL_FUNCTION_TYPE);
    append_section(&mut module, 1, &types);

    append_section(&mut module, 3, &[0x01, 0x01]); // one function of type 1

    let mut body = vec![
        0x01, // one local declaration group
        0x01, // one local
    ];
    body.extend_from_slice(NON_NULL_FUNCTION_TYPE);
    body.extend_from_slice(operators);

    let mut code = vec![0x01]; // one function body
    encode_u32(&mut code, body.len() as u32);
    code.extend(body);
    append_section(&mut module, 10, &code);
    module
}

fn compile_non_defaultable_local_module(parameters: &[&[u8]], operators: &[u8]) -> Program {
    let program = Compiler::default()
        .compile(&non_defaultable_local_module(parameters, operators))
        .expect("compile function with a definitely initialized non-defaultable local");
    program
        .verify()
        .expect("non-defaultable-local lowering must produce valid IR");
    program
}

fn only_defined_body(program: &Program) -> &FunctionBody {
    program.functions[0]
        .body
        .as_ref()
        .expect("test function has a body")
}

fn non_null_function_ref() -> ValueType {
    ValueType::Ref(RefType {
        nullable: false,
        heap: HeapType::Concrete(wedge::ir::TypeId(0)),
    })
}

#[test]
fn function_parameters_are_entry_block_parameters() {
    let program = compile_fixture("ssa_locals");
    let body = body(&program, "parameters");
    let entry = block(body, body.entry);

    let parameter_types: Vec<_> = entry
        .parameters
        .iter()
        .map(|parameter| parameter.ty.clone())
        .collect();
    assert_eq!(
        parameter_types,
        [
            ValueType::I32,
            ValueType::I64,
            ValueType::F32,
            ValueType::F64,
            ValueType::V128,
            nullable_ref(HeapType::Extern),
            nullable_ref(HeapType::Func),
        ]
    );
    assert_eq!(
        returned_values(body),
        entry
            .parameters
            .iter()
            .map(|parameter| parameter.id)
            .collect::<Vec<_>>()
    );
}

#[test]
fn wasm_local_operators_do_not_survive_ssa_construction() {
    let program = compile_fixture("ssa_locals");

    for function in &program.functions {
        let Some(body) = &function.body else {
            continue;
        };
        for instruction in body.blocks.iter().flat_map(|block| &block.instructions) {
            assert!(
                !matches!(
                    instruction.operation.mnemonic(),
                    "local.get" | "local.set" | "local.tee"
                ),
                "{} retained {} as an instruction",
                instruction.id,
                instruction.operation.mnemonic
            );
        }
    }
}

#[test]
fn local_tee_is_an_ssa_alias_of_its_input() {
    let program = compile_fixture("ssa_locals");
    let body = body(&program, "local_tee");
    let entry_parameter = block(body, body.entry).parameters[0].id;
    let add = body
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.operation.mnemonic == "i32.add")
        .expect("lowered i32.add");

    assert_eq!(add.operands.first(), Some(&entry_parameter));
}

#[test]
fn a_precise_reference_remains_valid_through_a_supertype_local() {
    let program = compile_fixture("ssa_locals");
    let function = exported_function(&program, "widen_reference_local");
    let body = function.body.as_ref().expect("defined function");
    let entry = block(body, body.entry);
    let precise_type = ValueType::Ref(RefType {
        nullable: false,
        heap: HeapType::Concrete(wedge::ir::TypeId(0)),
    });

    assert_eq!(entry.parameters.len(), 1);
    assert_eq!(entry.parameters[0].ty, precise_type);
    assert_eq!(function.locals[1], nullable_ref(HeapType::Func));
    assert_eq!(returned_values(body), [entry.parameters[0].id]);
    assert!(
        body.blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .all(|instruction| !matches!(
                instruction.operation.mnemonic(),
                "local.get" | "local.set" | "local.tee"
            ))
    );
}

#[test]
fn distinct_local_definitions_merge_through_edge_arguments() {
    let program = compile_fixture("ssa_locals");
    let body = body(&program, "if_else_local");
    let candidates: Vec<_> = body
        .blocks
        .iter()
        .filter_map(|block| {
            let incoming = incoming_edges(body, block.id);
            (incoming.len() == 2 && !block.parameters.is_empty()).then_some((block, incoming))
        })
        .collect();

    assert_eq!(candidates.len(), 1, "expected exactly one local merge");
    let (join, incoming) = &candidates[0];
    assert_eq!(join.parameters.len(), 1);
    assert_eq!(join.parameters[0].ty, ValueType::I32);
    assert!(incoming.iter().all(|(_, edge)| edge.arguments.len() == 1));
    assert_eq!(
        incoming
            .iter()
            .map(|(_, edge)| edge.arguments[0])
            .collect::<BTreeSet<_>>()
            .len(),
        2,
        "the two arms should pass their distinct definitions"
    );
    assert_eq!(returned_values(body), [join.parameters[0].id]);
}

#[test]
fn an_identical_definition_on_both_paths_needs_no_merge_parameter() {
    let program = compile_fixture("ssa_locals");
    let body = body(&program, "if_same_local");
    let merge_blocks: Vec<_> = body
        .blocks
        .iter()
        .filter(|block| incoming_edges(body, block.id).len() >= 2)
        .collect();

    assert!(!merge_blocks.is_empty(), "the if should have a CFG join");
    assert!(
        merge_blocks.iter().all(|block| block.parameters.is_empty()),
        "a phi whose inputs are the same value is trivial"
    );
}

#[test]
fn a_single_predecessor_needs_no_merge_parameter() {
    let program = compile_fixture("ssa_locals");
    let body = body(&program, "single_predecessor");
    let single_predecessor_blocks: Vec<_> = body
        .blocks
        .iter()
        .filter(|block| block.id != body.entry && incoming_edges(body, block.id).len() == 1)
        .collect();

    assert!(
        !single_predecessor_blocks.is_empty(),
        "the explicit branch should create a successor block"
    );
    assert!(
        single_predecessor_blocks
            .iter()
            .all(|block| block.parameters.is_empty()),
        "a one-predecessor local read should resolve directly"
    );
}

#[test]
fn loop_carried_locals_are_header_parameters() {
    let program = compile_fixture("ssa_locals");
    let body = body(&program, "loop_carried_locals");
    let loop_region = body
        .regions
        .iter()
        .find(|region| region.kind == RegionKind::Loop)
        .expect("loop region");
    let header = block(body, loop_region.entry);
    let incoming = incoming_edges(body, header.id);

    assert!(incoming.len() >= 2, "loop header needs entry and backedge");
    assert_eq!(
        header
            .parameters
            .iter()
            .map(|parameter| parameter.ty.clone())
            .collect::<Vec<_>>(),
        [ValueType::I32, ValueType::I32]
    );
    assert!(
        incoming
            .iter()
            .all(|(_, edge)| edge.arguments.len() == header.parameters.len())
    );
    assert!(
        incoming
            .iter()
            .map(|(_, edge)| edge.arguments.as_slice())
            .collect::<BTreeSet<_>>()
            .len()
            >= 2,
        "the entry edge and backedge should carry different definitions"
    );
}

#[test]
fn defaultable_locals_receive_typed_zero_or_null_definitions() {
    let program = compile_fixture("default_locals");
    let body = body(&program, "defaults");
    assert!(
        block(body, body.entry).parameters.is_empty(),
        "local defaults are definitions, not function parameters"
    );

    let returned = returned_values(body);
    let definitions = defining_operations(body);
    let expected_types = [
        ValueType::I32,
        ValueType::I64,
        ValueType::F32,
        ValueType::F64,
        ValueType::V128,
        nullable_ref(HeapType::Func),
        nullable_ref(HeapType::Extern),
    ];
    let expected_mnemonics = [
        "i32.const",
        "i64.const",
        "f32.const",
        "f64.const",
        "v128.const",
        "ref.null",
        "ref.null",
    ];

    assert_eq!(returned.len(), expected_types.len());
    for ((value, expected_type), expected_mnemonic) in
        returned.iter().zip(&expected_types).zip(expected_mnemonics)
    {
        let (actual_type, operation) = definitions
            .get(value)
            .unwrap_or_else(|| panic!("{value} has no defining instruction"));
        assert_eq!(*actual_type, expected_type);
        assert_eq!(operation.mnemonic, expected_mnemonic);
    }

    let operations: Vec<_> = returned.iter().map(|value| definitions[value].1).collect();
    assert_eq!(operations[0].immediates, [Immediate::S32(0)]);
    assert_eq!(operations[1].immediates, [Immediate::S64(0)]);
    assert_eq!(operations[2].immediates, [Immediate::F32(0)]);
    assert_eq!(operations[3].immediates, [Immediate::F64(0)]);
    assert_eq!(operations[4].immediates, [Immediate::V128([0; 16])]);
    assert_eq!(
        operations[5].immediates,
        [Immediate::HeapType(HeapType::Func)]
    );
    assert_eq!(
        operations[6].immediates,
        [Immediate::HeapType(HeapType::Extern)]
    );
}

#[test]
fn non_defaultable_local_is_defined_by_local_set() {
    let program = compile_non_defaultable_local_module(
        &[NON_NULL_FUNCTION_TYPE],
        &[
            0x20, 0x00, // local.get 0
            0x21, 0x01, // local.set 1
            0x20, 0x01, // local.get 1
            0x0b, // end
        ],
    );
    let body = only_defined_body(&program);
    let entry = block(body, body.entry);

    assert_eq!(entry.parameters.len(), 1);
    assert_eq!(entry.parameters[0].ty, non_null_function_ref());
    assert_eq!(returned_values(body), [entry.parameters[0].id]);
    assert!(
        body.blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .all(|instruction| instruction.operation.mnemonic != "ref.null")
    );
}

#[test]
fn validator_rejects_a_read_before_non_defaultable_local_initialization() {
    let module = non_defaultable_local_module(
        &[NON_NULL_FUNCTION_TYPE],
        &[
            0x20, 0x01, // local.get 1
            0x0b, // end
        ],
    );
    let error = Compiler::default()
        .compile(&module)
        .expect_err("an uninitialized non-defaultable local is invalid Wasm");

    assert!(
        matches!(
            error,
            CompileError::InvalidWasm { ref message, .. }
                if message.contains("uninitialized local")
        ),
        "unexpected diagnostic: {error}"
    );
}

#[test]
fn validator_rejects_a_non_defaultable_local_initialized_on_only_one_if_arm() {
    let module = non_defaultable_local_module(
        &[NON_NULL_FUNCTION_TYPE, I32_BINARY_TYPE],
        &[
            0x20, 0x01, // local.get 1: condition
            0x04, 0x40, // if
            0x20, 0x00, //   local.get 0
            0x21, 0x02, //   local.set 2
            0x05, // else: local 2 remains uninitialized
            0x0b, // end if
            0x20, 0x02, // local.get 2
            0x0b, // end function
        ],
    );
    let error = Compiler::default()
        .compile(&module)
        .expect_err("every path must initialize a non-defaultable local before it is read");

    assert!(
        matches!(
            error,
            CompileError::InvalidWasm { ref message, .. }
                if message.contains("uninitialized local")
        ),
        "unexpected diagnostic: {error}"
    );
}

#[test]
fn non_defaultable_local_definitions_merge_after_if_else() {
    let program = compile_non_defaultable_local_module(
        &[
            NON_NULL_FUNCTION_TYPE,
            NON_NULL_FUNCTION_TYPE,
            I32_BINARY_TYPE,
        ],
        &[
            0x20, 0x00, // local.get 0
            0x21, 0x03, // local.set 3
            0x20, 0x02, // local.get 2
            0x04, 0x40, // if
            0x20, 0x00, //   local.get 0
            0x21, 0x03, //   local.set 3
            0x05, // else
            0x20, 0x01, //   local.get 1
            0x21, 0x03, //   local.set 3
            0x0b, // end
            0x20, 0x03, // local.get 3
            0x0b, // end
        ],
    );
    let body = only_defined_body(&program);
    let candidates: Vec<_> = body
        .blocks
        .iter()
        .filter_map(|block| {
            let incoming = incoming_edges(body, block.id);
            (incoming.len() == 2
                && block
                    .parameters
                    .iter()
                    .any(|parameter| parameter.ty == non_null_function_ref()))
            .then_some((block, incoming))
        })
        .collect();

    assert_eq!(candidates.len(), 1, "expected one reference-local merge");
    let (join, incoming) = &candidates[0];
    assert_eq!(join.parameters.len(), 1);
    assert_eq!(join.parameters[0].ty, non_null_function_ref());
    assert!(incoming.iter().all(|(_, edge)| edge.arguments.len() == 1));
    assert_eq!(
        incoming
            .iter()
            .map(|(_, edge)| edge.arguments[0])
            .collect::<BTreeSet<_>>()
            .len(),
        2,
        "the two arms should pass distinct non-null references"
    );
    assert_eq!(returned_values(body), [join.parameters[0].id]);
}

#[test]
fn non_defaultable_local_can_be_loop_carried_after_initialization() {
    let program = compile_non_defaultable_local_module(
        &[
            NON_NULL_FUNCTION_TYPE,
            NON_NULL_FUNCTION_TYPE,
            I32_BINARY_TYPE,
        ],
        &[
            0x20, 0x00, // local.get 0
            0x21, 0x03, // local.set 3
            0x03, 0x40, // loop
            0x20, 0x03, //   local.get 3
            0x1a, //   drop
            0x20, 0x01, //   local.get 1
            0x21, 0x03, //   local.set 3
            0x20, 0x02, //   local.get 2
            0x0d, 0x00, //   br_if 0
            0x0b, // end
            0x20, 0x03, // local.get 3
            0x0b, // end
        ],
    );
    let body = only_defined_body(&program);
    let loop_region = body
        .regions
        .iter()
        .find(|region| region.kind == RegionKind::Loop)
        .expect("loop region");
    let header = block(body, loop_region.entry);
    let incoming = incoming_edges(body, header.id);

    assert!(incoming.len() >= 2, "loop header needs entry and backedge");
    assert_eq!(header.parameters.len(), 1);
    assert_eq!(header.parameters[0].ty, non_null_function_ref());
    assert!(incoming.iter().all(|(_, edge)| edge.arguments.len() == 1));
    assert_eq!(
        incoming
            .iter()
            .map(|(_, edge)| edge.arguments[0])
            .collect::<BTreeSet<_>>()
            .len(),
        2,
        "the entry edge and backedge should carry distinct definitions"
    );
}

#[test]
fn br_table_arms_carry_every_nested_loop_header_parameter() {
    let program = compile_fixture("loop_label_arguments");
    for name in [
        "br_table_inner_before_outer",
        "br_table_default_inner",
        "br_table_carries_nested_loop_locals",
    ] {
        let body = body(&program, name);
        for region in body
            .regions
            .iter()
            .filter(|region| matches!(region.kind, RegionKind::Loop))
        {
            let header = block(body, region.entry);
            let incoming = incoming_edges(body, header.id);
            assert!(
                !incoming.is_empty(),
                "{name}: {} has predecessors",
                header.id
            );
            for (source, edge) in incoming {
                assert_eq!(
                    edge.arguments.len(),
                    header.parameters.len(),
                    "{name}: edge from {source} to {} is complete",
                    header.id
                );
            }
        }
    }

    let body = body(&program, "br_table_carries_nested_loop_locals");
    let definitions = defining_operations(body);
    let headers: Vec<&Block> = body
        .regions
        .iter()
        .filter(|region| matches!(region.kind, RegionKind::Loop))
        .map(|region| block(body, region.entry))
        .collect();
    assert_eq!(headers.len(), 2);
    for header in &headers {
        assert_eq!(
            header.parameters.len(),
            1,
            "{} keeps only the loop-carried local",
            header.id
        );
        assert_eq!(header.parameters[0].ty, ValueType::I32);
    }
    let outer = headers
        .iter()
        .copied()
        .find(|header| {
            incoming_edges(body, header.id)
                .iter()
                .any(|(source, _)| *source == body.entry)
        })
        .expect("the outer header follows the entry block");
    let inner = headers
        .iter()
        .copied()
        .find(|header| header.id != outer.id)
        .expect("the inner header");
    let carried: BTreeSet<ValueId> = incoming_edges(body, inner.id)
        .iter()
        .filter(|(source, _)| *source == inner.id)
        .chain(
            incoming_edges(body, outer.id)
                .iter()
                .filter(|(source, _)| *source == inner.id),
        )
        .map(|(_, edge)| edge.arguments[0])
        .collect();
    assert_eq!(
        carried.len(),
        1,
        "the backedge and the outer arm carry the same value"
    );
    let carried = carried.into_iter().next().expect("one carried value");
    assert_eq!(definitions[&carried].1.mnemonic(), "i32.add");
    let (_, initial) = incoming_edges(body, outer.id)
        .into_iter()
        .find(|(source, _)| *source == body.entry)
        .expect("entry edge");
    assert_eq!(definitions[&initial.arguments[0]].1.mnemonic(), "i32.const");
}
