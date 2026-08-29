// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Generated Core 3.0 modules through the whole front end.
//!
//! wasm-smith draws a module from a byte string Hegel generates, so a failure
//! shrinks toward the shortest byte string, and with it the smallest module,
//! that still fails. The generator is bounded and rejection-free so a
//! derandomized run spends its whole case budget on accepted cases.

use hegel::{TestCase, generators as gs};
use wedge::{Compiler, STANDARD_WASM_3_FEATURES};
use wedge_testing::{oracle, smith};

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// The most bytes a module is drawn from. wasm-smith spends them on
/// declarations and instructions, so this bounds the module's size.
const MAX_ENTROPY: usize = 4096;

fn module(tc: &TestCase) -> Vec<u8> {
    let entropy = tc.draw_silent(gs::binary().max_size(MAX_ENTROPY));
    let module = smith::module(&entropy).expect("wasm-smith draws a module from any byte string");
    tc.note(&smith::text(&module));
    module
}

#[test]
fn the_generator_stays_within_the_standard_profile() {
    let needed = smith::config().features();
    assert!(
        STANDARD_WASM_3_FEATURES.contains(needed),
        "wasm-smith needs {needed:?}, beyond the standard profile {STANDARD_WASM_3_FEATURES:?}"
    );
}

#[hegel::test(test_cases = 100, derandomize = true, database = None)]
fn generated_modules_are_standard(tc: TestCase) {
    let module = module(&tc);
    if let Err(error) = Compiler::new().validate(&module) {
        panic!("a generated module fails validation: {error}");
    }
}

#[hegel::test(test_cases = 100, derandomize = true, database = None)]
fn generated_modules_compile_to_verified_programs(tc: TestCase) {
    let module = module(&tc);
    match oracle::check_module(&module) {
        Ok(Some(_)) => {}
        Ok(None) => panic!("a generated module is rejected"),
        Err(failure) => panic!("{failure}"),
    }
}

#[hegel::test(test_cases = 100, derandomize = true, database = None)]
fn compilation_is_deterministic(tc: TestCase) {
    let module = module(&tc);
    let compiler = Compiler::new();
    let first = compiler.compile(&module);
    let second = compiler.compile(&module);
    assert!(
        first == second,
        "compiling the same module twice gives different results"
    );
}
