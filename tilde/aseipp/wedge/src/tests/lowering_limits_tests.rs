// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Size limits of the frontend: shapes that once overflowed the stack or made
//! lowering superlinear, generated at a scale that still exposes a
//! regression, and inputs whose declared sizes must be validated before
//! anything is allocated for them.

use wedge::cfg::ControlFlowGraph;
use wedge::ir::{Block, FunctionBody, Program, TerminatorKind};
use wedge::{CompileError, Compiler};
mod encoding_support;

use encoding_support::{append_section, encode_u32};

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Encodes one function of the given signature with `i32_locals` declared
/// `i32` locals and the given body operators.
fn single_function_module(
    params: &[u8],
    results: &[u8],
    i32_locals: u32,
    operators: &[u8],
) -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    let mut types = vec![0x01, 0x60];
    encode_u32(&mut types, params.len() as u32);
    types.extend_from_slice(params);
    encode_u32(&mut types, results.len() as u32);
    types.extend_from_slice(results);
    append_section(&mut module, 1, &types);
    append_section(&mut module, 3, &[0x01, 0x00]);

    let mut body = Vec::new();
    if i32_locals == 0 {
        body.push(0x00);
    } else {
        body.push(0x01);
        encode_u32(&mut body, i32_locals);
        body.push(0x7f);
    }
    body.extend_from_slice(operators);
    let mut code = vec![0x01];
    encode_u32(&mut code, body.len() as u32);
    code.extend(body);
    append_section(&mut module, 10, &code);
    module
}

fn compile(module: &[u8]) -> Program {
    let program = Compiler::default()
        .compile(module)
        .unwrap_or_else(|error| panic!("compile generated module: {error}"));
    program
        .verify()
        .unwrap_or_else(|errors| panic!("generated module lowered to invalid IR:\n{errors}"));
    program
}

fn only_body(program: &Program) -> &FunctionBody {
    program.functions[0]
        .body
        .as_ref()
        .expect("the generated function has a body")
}

/// The number of arguments each edge occurrence delivers to every block.
const DEEP_CHAIN: usize = 20_000;
const MERGE_CHAIN: usize = 5_000;

#[test]
fn deep_single_predecessor_chains_lower_iteratively() {
    // Each `if` diverts into a returning arm and falls through into a fresh
    // single-predecessor block, so the read at the end walks a chain of
    // DEEP_CHAIN blocks. A recursive walk overflowed the stack at a fraction
    // of this depth.
    let mut operators = Vec::new();
    for _ in 0..DEEP_CHAIN {
        operators.extend_from_slice(&[0x41, 0x00, 0x04, 0x40, 0x0f, 0x0b]);
    }
    operators.extend_from_slice(&[0x20, 0x00, 0x1a, 0x0b]);

    let program = compile(&single_function_module(&[], &[], 1, &operators));
    let body = only_body(&program);
    assert!(body.blocks.len() > DEEP_CHAIN);
    assert!(
        body.blocks.iter().all(|block| block.parameters.is_empty()),
        "a chain without merges needs no block parameters"
    );
}

#[test]
fn deep_nested_merges_lower_iteratively() {
    // if/else diamonds with empty arms: the read of local 1 after the last one
    // creates one trivial merge parameter per join, each read through the
    // previous join. This once recursed once per diamond and simplified each
    // parameter with a full rescan of the function.
    let mut operators = Vec::new();
    for _ in 0..MERGE_CHAIN {
        operators.extend_from_slice(&[0x20, 0x00, 0x04, 0x40, 0x01, 0x05, 0x01, 0x0b]);
    }
    operators.extend_from_slice(&[0x20, 0x01, 0x0b]);

    let program = compile(&single_function_module(&[0x7f], &[0x7f], 1, &operators));
    let body = only_body(&program);
    assert!(body.blocks.len() > 2 * MERGE_CHAIN);
    assert!(
        body.blocks
            .iter()
            .filter(|block| block.id != body.entry)
            .all(|block| block.parameters.is_empty()),
        "every merge parameter was trivial"
    );
    let returned = body
        .blocks
        .iter()
        .find_map(|block| match &block.terminator.kind {
            TerminatorKind::Return { values } => values.first().copied(),
            _ => None,
        })
        .expect("the function returns a value");
    let entry = body
        .blocks
        .iter()
        .find(|block| block.id == body.entry)
        .expect("entry block exists");
    assert!(
        entry.instructions.iter().any(|instruction| instruction
            .results
            .iter()
            .any(|result| result.id == returned)),
        "the returned value is the entry block's default definition of the local"
    );
}

#[test]
fn many_surviving_merges_simplify_linearly() {
    // Each then-arm redefines local 1, so every join keeps exactly one
    // parameter fed by one argument from each arm.
    let mut operators = Vec::new();
    for _ in 0..MERGE_CHAIN {
        operators.extend_from_slice(&[
            0x20, 0x00, 0x04, 0x40, 0x41, 0x01, 0x21, 0x01, 0x05, 0x01, 0x0b,
        ]);
    }
    operators.extend_from_slice(&[0x20, 0x01, 0x0b]);

    let program = compile(&single_function_module(&[0x7f], &[0x7f], 1, &operators));
    let body = only_body(&program);
    let merges: Vec<&Block> = body
        .blocks
        .iter()
        .filter(|block| block.id != body.entry && !block.parameters.is_empty())
        .collect();
    assert_eq!(merges.len(), MERGE_CHAIN);
    let graph = ControlFlowGraph::new(body).expect("the lowered body is a valid CFG");
    for block in merges {
        assert_eq!(
            block.parameters.len(),
            1,
            "{} keeps one merge parameter",
            block.id
        );
        let counts: Vec<usize> = graph
            .incoming_edge_ids(block.id)
            .iter()
            .map(|id| {
                graph
                    .edge_site(*id)
                    .expect("every edge has a site")
                    .argument_count()
            })
            .collect();
        assert_eq!(
            counts,
            [1, 1],
            "{} receives one argument from each arm",
            block.id
        );
    }
}

fn invalid_wasm(result: Result<Program, CompileError>) -> CompileError {
    match result {
        Err(error @ CompileError::InvalidWasm { .. }) => error,
        Err(other) => panic!("expected an invalid-module error, got {other}"),
        Ok(_) => panic!("expected an invalid-module error, got a program"),
    }
}

/// A module whose only function declares `count` `i32` locals in one group.
fn module_with_local_count(count: u32) -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    append_section(&mut module, 1, &[0x01, 0x60, 0x00, 0x00]);
    append_section(&mut module, 3, &[0x01, 0x00]);
    let mut body = vec![0x01];
    encode_u32(&mut body, count);
    body.extend_from_slice(&[0x7f, 0x0b]);
    let mut code = vec![0x01];
    encode_u32(&mut code, body.len() as u32);
    code.extend(body);
    append_section(&mut module, 10, &code);
    module
}

/// A module with an `(array i32)` type whose single function body or global
/// initializer is `array.new_fixed` of `size` elements with nothing pushed
/// before it, so only `size == 0` is valid.
fn array_new_fixed_module(size: u32, in_global: bool) -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    append_section(&mut module, 1, &[0x02, 0x5e, 0x7f, 0x00, 0x60, 0x00, 0x00]);
    let mut expression = vec![0xfb, 0x08, 0x00];
    encode_u32(&mut expression, size);
    if in_global {
        expression.push(0x0b);
        let mut globals = vec![0x01, 0x64, 0x00, 0x00];
        globals.extend_from_slice(&expression);
        append_section(&mut module, 6, &globals);
    } else {
        expression.extend_from_slice(&[0x1a, 0x0b]);
        append_section(&mut module, 3, &[0x01, 0x01]);
        let mut body = vec![0x00];
        body.extend_from_slice(&expression);
        let mut code = vec![0x01];
        encode_u32(&mut code, body.len() as u32);
        code.extend(body);
        append_section(&mut module, 10, &code);
    }
    module
}

#[test]
fn rejects_oversized_local_declarations_without_allocating() {
    let compiler = Compiler::default();
    let module = module_with_local_count(u32::MAX);
    let rejected = invalid_wasm(compiler.compile(&module));
    assert!(
        rejected.to_string().contains("too many locals"),
        "{rejected}"
    );
    assert_eq!(
        compiler
            .validate(&module)
            .expect_err("validation rejects the declaration"),
        rejected,
        "compile reports the validator's own diagnostic"
    );

    let program = compile(&module_with_local_count(3));
    assert_eq!(program.functions[0].locals.len(), 3);
}

#[test]
fn rejects_oversized_array_new_fixed_without_allocating() {
    let compiler = Compiler::default();
    for in_global in [false, true] {
        let module = array_new_fixed_module(u32::MAX, in_global);
        let rejected = invalid_wasm(compiler.compile(&module));
        assert_eq!(
            compiler
                .validate(&module)
                .expect_err("validation rejects the element count"),
            rejected,
            "in_global={in_global}: compile reports the validator's own diagnostic"
        );
        compile(&array_new_fixed_module(0, in_global));
    }
}
