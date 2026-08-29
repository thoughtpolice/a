// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Whole-program fixtures: realistic modules that exercise the frontend the
//! way hand-written or compiled code does, rather than one feature at a time.
//!
//! `tests/chacha20.wat` is RFC 8439 ChaCha20 with a self-test against the
//! RFC's vectors. `tests/filecheck/chacha20.test` runs that self-test under
//! WABT's interpreter, so these tests take the module to be a correct program
//! and concentrate on what the frontend makes of it.

use std::collections::{BTreeMap, BTreeSet};

use wedge::Compiler;
use wedge::cfg::ControlFlowGraph;
use wedge::ir::{
    Block, BlockId, Effect, EffectAccess, EffectResource, ExportItem, FunctionBody, FunctionId,
    Immediate, Instruction, MemoryId, Program, TerminatorKind, ValueType,
};
mod fixture_support;

use fixture_support::{block, compile_fixture, exported_body, instructions};

fn mnemonic_counts<'body>(
    instructions: impl IntoIterator<Item = &'body Instruction>,
) -> BTreeMap<&'body str, usize> {
    let mut counts = BTreeMap::new();
    for instruction in instructions {
        *counts.entry(instruction.operation.mnemonic()).or_insert(0) += 1;
    }
    counts
}

fn callee(call: &Instruction) -> FunctionId {
    match call.operation.immediates.as_slice() {
        [Immediate::Function(callee)] => *callee,
        other => panic!("call immediates {other:?}"),
    }
}

#[test]
fn compiles_verifies_and_keeps_the_module_interface() {
    let program = compile_fixture("chacha20");

    let exports: Vec<(&str, ExportItem)> = program
        .exports
        .iter()
        .map(|export| (export.name.as_str(), export.item.clone()))
        .collect();
    assert_eq!(
        exports,
        [
            ("memory", ExportItem::Memory(MemoryId(0))),
            ("chacha20_block", ExportItem::Function(FunctionId(1))),
            ("chacha20_xor", ExportItem::Function(FunctionId(2))),
            ("selftest", ExportItem::Function(FunctionId(4))),
        ]
    );
    assert_eq!(program.functions.len(), 5);
    assert!(
        program
            .functions
            .iter()
            .all(|function| function.body.is_some())
    );
    assert_eq!(program.memories.len(), 1);
    assert_eq!(program.globals.len(), 8);

    // Key, two nonces, the expected block, the plaintext, and the ciphertext.
    let segment_sizes: Vec<usize> = program
        .data
        .iter()
        .map(|segment| segment.bytes.len())
        .collect();
    assert_eq!(segment_sizes, [32, 12, 12, 64, 114, 114]);
    assert!(
        program.data[4]
            .bytes
            .starts_with(b"Ladies and Gentlemen of the class of '99")
    );
    assert_eq!(program.data[5].bytes[..4], [0x6e, 0x2e, 0x35, 0x9a]);

    let loop_counts: Vec<usize> = program
        .functions
        .iter()
        .map(|function| {
            let body = function.body.as_ref().expect("defined body");
            let graph = ControlFlowGraph::new(body).expect("chacha20 CFG");
            let loops = graph.natural_loops();

            // Structured source is reducible: every cyclic component is exactly
            // the body of its outermost natural loop.
            let components = graph.strongly_connected_components();
            for (component, blocks) in components.components() {
                if !components.is_cyclic(component) {
                    continue;
                }
                let blocks: BTreeSet<BlockId> = blocks.iter().copied().collect();
                assert!(
                    loops
                        .iter()
                        .any(|natural_loop| natural_loop.blocks == blocks),
                    "func{}: cyclic component {blocks:?} is not a natural loop",
                    function.wasm_index
                );
            }

            // No exception handling, and no state outside memory 0, the
            // immutable layout globals, and the host state behind calls.
            for block in &body.blocks {
                assert!(!matches!(
                    block.terminator.kind,
                    TerminatorKind::Invoke { .. }
                ));
                assert!(
                    block
                        .terminator
                        .exception
                        .as_ref()
                        .map_or(true, |routing| routing.arms.is_empty())
                );
                let accesses = block
                    .instructions
                    .iter()
                    .flat_map(|instruction| &instruction.effects.accesses);
                for effect in accesses {
                    assert!(
                        matches!(
                            effect.resource,
                            EffectResource::Memory(MemoryId(0))
                                | EffectResource::Global(_)
                                | EffectResource::Host
                        ),
                        "func{} touches {:?}",
                        function.wasm_index,
                        effect.resource
                    );
                }
            }
            loops.len()
        })
        .collect();
    // quarter_round, block, xor, memeq, selftest
    assert_eq!(loop_counts, [0, 1, 2, 1, 0]);
}

#[test]
fn quarter_round_is_a_pure_single_block_multi_value_leaf() {
    let program = compile_fixture("chacha20");
    let body = program.functions[0]
        .body
        .as_ref()
        .expect("quarter round body");
    assert_eq!(body.blocks.len(), 1);

    let entry = block(body, body.entry);
    assert_eq!(entry.parameters.len(), 4);
    assert!(
        entry
            .parameters
            .iter()
            .all(|parameter| parameter.ty == ValueType::I32)
    );
    assert!(
        entry
            .instructions
            .iter()
            .all(|instruction| instruction.effects.is_pure())
    );
    assert_eq!(
        mnemonic_counts(&entry.instructions),
        BTreeMap::from([
            ("i32.add", 4),
            ("i32.const", 4),
            ("i32.rotl", 4),
            ("i32.xor", 4)
        ])
    );

    let rotations: Vec<i32> = entry
        .instructions
        .iter()
        .filter(|instruction| instruction.operation.mnemonic() == "i32.const")
        .map(
            |instruction| match instruction.operation.immediates.as_slice() {
                [Immediate::S32(amount)] => *amount,
                other => panic!("i32.const immediates {other:?}"),
            },
        )
        .collect();
    assert_eq!(rotations, [16, 12, 8, 7]);

    let TerminatorKind::Return { values } = &entry.terminator.kind else {
        panic!("quarter round ends in {:?}", entry.terminator.kind);
    };
    let defined: BTreeSet<_> = entry
        .instructions
        .iter()
        .flat_map(|instruction| instruction.results.iter().map(|result| result.id))
        .collect();
    assert_eq!(values.len(), 4);
    assert_eq!(values.iter().collect::<BTreeSet<_>>().len(), 4);
    assert!(values.iter().all(|value| defined.contains(value)));

    let text = program.to_string();
    assert!(text.contains("= i32.rotl("));
    assert!(text.contains("i32.const<s32=16>"));
}

#[test]
fn block_function_carries_the_whole_state_through_one_loop() {
    let program = compile_fixture("chacha20");
    let body = exported_body(&program, "chacha20_block");
    let graph = ControlFlowGraph::new(body).expect("chacha20_block CFG");

    let loops = graph.natural_loops();
    assert_eq!(loops.len(), 1);
    let rounds = &loops[0];
    assert_eq!(rounds.blocks, BTreeSet::from([rounds.header]));
    assert_eq!(rounds.back_edges.len(), 1);

    // Sixteen state words plus the round counter are loop-carried.
    let header = block(body, rounds.header);
    assert_eq!(header.parameters.len(), 17);
    assert!(
        header
            .parameters
            .iter()
            .all(|parameter| parameter.ty == ValueType::I32)
    );
    let parameters: BTreeSet<_> = header
        .parameters
        .iter()
        .map(|parameter| parameter.id)
        .collect();

    let TerminatorKind::Branch {
        then_edge,
        else_edge,
        ..
    } = &header.terminator.kind
    else {
        panic!("round loop ends in {:?}", header.terminator.kind);
    };
    assert_eq!(then_edge.target, rounds.header);
    assert_eq!(then_edge.arguments.len(), 17);
    assert!(
        then_edge.arguments[..16]
            .iter()
            .all(|argument| !parameters.contains(argument))
    );
    assert_ne!(else_edge.target, rounds.header);
    assert!(else_edge.arguments.is_empty());

    // Eight multi-value quarter rounds per double round: the column calls
    // consume the header parameters and the diagonal calls their results.
    let calls: Vec<&Instruction> = header
        .instructions
        .iter()
        .filter(|instruction| instruction.operation.mnemonic() == "call")
        .collect();
    assert_eq!(calls.len(), 8);
    for call in &calls {
        assert_eq!(callee(call), FunctionId(0));
        assert_eq!(call.operands.len(), 4);
        assert_eq!(call.results.len(), 4);
        assert!(
            call.results
                .iter()
                .all(|result| result.ty == ValueType::I32)
        );
        assert!(!call.effects.is_pure());
        assert!(call.effects.is_barrier());
    }
    let column_results: BTreeSet<_> = calls[..4]
        .iter()
        .flat_map(|call| call.results.iter().map(|result| result.id))
        .collect();
    assert!(calls[..4].iter().all(|call| {
        call.operands
            .iter()
            .all(|operand| parameters.contains(operand))
    }));
    assert!(calls[4..].iter().all(|call| {
        call.operands
            .iter()
            .all(|operand| column_results.contains(operand))
    }));

    // The loop itself never touches memory; the loads and stores surround it.
    assert!(header.instructions.iter().all(|instruction| {
        instruction
            .effects
            .accesses
            .iter()
            .all(|effect| effect.resource == EffectResource::Host)
    }));
    let counts = mnemonic_counts(instructions(body));
    assert_eq!(counts["call"], 8);
    assert_eq!(counts["i32.load"], 22);
    assert_eq!(counts["i32.store"], 16);
    let memory = |access| {
        vec![Effect {
            resource: EffectResource::Memory(MemoryId(0)),
            access,
        }]
    };
    for instruction in instructions(body) {
        match instruction.operation.mnemonic() {
            "i32.load" => assert_eq!(instruction.effects.accesses, memory(EffectAccess::Read)),
            "i32.store" => assert_eq!(instruction.effects.accesses, memory(EffectAccess::Write)),
            _ => {}
        }
    }
}

#[test]
fn stream_cipher_nests_the_byte_loop_inside_the_block_loop() {
    let program = compile_fixture("chacha20");
    let body = exported_body(&program, "chacha20_xor");
    let graph = ControlFlowGraph::new(body).expect("chacha20_xor CFG");

    let mut loops = graph.natural_loops();
    loops.sort_by_key(|natural_loop| std::cmp::Reverse(natural_loop.blocks.len()));
    let [blocks_loop, bytes_loop] = loops.as_slice() else {
        panic!("expected two loops, found {}", loops.len());
    };
    assert!(blocks_loop.blocks.is_superset(&bytes_loop.blocks));
    assert!(blocks_loop.blocks.len() > bytes_loop.blocks.len());
    assert_eq!(bytes_loop.blocks, BTreeSet::from([bytes_loop.header]));
    let dominators = graph.dominators();
    assert!(dominators.dominates(blocks_loop.header, bytes_loop.header));
    assert!(!dominators.dominates(bytes_loop.header, blocks_loop.header));

    // The outer loop carries the counter and the input, length, and output
    // cursors; the inner loop carries only its byte index.
    assert_eq!(block(body, blocks_loop.header).parameters.len(), 4);
    let inner = block(body, bytes_loop.header);
    assert_eq!(inner.parameters.len(), 1);

    // One keystream block per outer iteration, generated outside the byte loop.
    let calls: Vec<(BlockId, &Instruction)> = body
        .blocks
        .iter()
        .flat_map(|block| {
            block
                .instructions
                .iter()
                .map(move |instruction| (block.id, instruction))
        })
        .filter(|(_, instruction)| instruction.operation.mnemonic() == "call")
        .collect();
    let [(call_site, call)] = calls.as_slice() else {
        panic!("expected one call, found {}", calls.len());
    };
    assert!(blocks_loop.blocks.contains(call_site));
    assert!(!bytes_loop.blocks.contains(call_site));
    assert_eq!(callee(call), FunctionId(1));
    assert!(call.results.is_empty());
    assert!(mnemonic_counts(instructions(body)).contains_key("select"));

    // The byte loop is two loads, an xor, and a store. The store must stay
    // ordered against both loads, while the loads are free with respect to
    // each other.
    let inner_counts = mnemonic_counts(&inner.instructions);
    assert_eq!(inner_counts["i32.load8_u"], 2);
    assert_eq!(inner_counts["i32.xor"], 1);
    assert_eq!(inner_counts["i32.store8"], 1);
    let loads: Vec<&Instruction> = inner
        .instructions
        .iter()
        .filter(|instruction| instruction.operation.mnemonic() == "i32.load8_u")
        .collect();
    let store = inner
        .instructions
        .iter()
        .find(|instruction| instruction.operation.mnemonic() == "i32.store8")
        .expect("byte store");
    assert!(
        loads
            .iter()
            .all(|load| store.effects.conflicts_with(&load.effects))
    );
    assert!(!loads[0].effects.conflicts_with(&loads[1].effects));
    assert!(!store.effects.is_barrier());
}

#[test]
fn selftest_joins_its_failure_mask_and_memeq_returns_early_from_its_loop() {
    let program = compile_fixture("chacha20");

    let selftest = exported_body(&program, "selftest");
    let graph = ControlFlowGraph::new(selftest).expect("selftest CFG");
    assert!(graph.natural_loops().is_empty());

    // The block function once, the stream cipher twice, and one comparison
    // after each.
    let mut callees = BTreeMap::new();
    let calls =
        instructions(selftest).filter(|instruction| instruction.operation.mnemonic() == "call");
    for call in calls {
        *callees.entry(callee(call)).or_insert(0) += 1;
    }
    assert_eq!(
        callees,
        BTreeMap::from([(FunctionId(1), 1), (FunctionId(2), 2), (FunctionId(3), 3)])
    );

    // Each `if` merges the failure mask into one block parameter, and the
    // function returns the last merge.
    let joins: Vec<&Block> = selftest
        .blocks
        .iter()
        .filter(|block| block.id != selftest.entry && !block.parameters.is_empty())
        .collect();
    assert_eq!(joins.len(), 3);
    assert!(
        joins
            .iter()
            .all(|join| join.parameters.len() == 1 && join.parameters[0].ty == ValueType::I32)
    );
    let last = joins.last().expect("three joins");
    assert!(matches!(
        &last.terminator.kind,
        TerminatorKind::Return { values } if values == &[last.parameters[0].id]
    ));

    // memeq: the loop carries both cursors and the remaining length, and both
    // returns leave the loop, so neither belongs to its body even though the
    // header dominates them.
    let memeq = program.functions[3].body.as_ref().expect("memeq body");
    let graph = ControlFlowGraph::new(memeq).expect("memeq CFG");
    let loops = graph.natural_loops();
    assert_eq!(loops.len(), 1);
    assert_eq!(block(memeq, loops[0].header).parameters.len(), 3);
    let returns: Vec<BlockId> = memeq
        .blocks
        .iter()
        .filter(|block| matches!(block.terminator.kind, TerminatorKind::Return { .. }))
        .map(|block| block.id)
        .collect();
    assert_eq!(returns.len(), 2);
    assert!(returns.iter().all(|block| {
        graph.dominators().dominates(loops[0].header, *block) && !loops[0].blocks.contains(block)
    }));
}
