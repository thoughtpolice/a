// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Validation coverage for Wedge's standard Core WebAssembly 3.0 boundary.
//!
//! Every accepted fixture the build lists must pass the standalone validation
//! API, the interleaved compile path, and IR verification. Rejection fixtures
//! exercise both validation and compile. Together they keep the two entry
//! points from drifting on Wedge's language profile in either direction.

use wedge::{CompileError, Compiler, STANDARD_WASM_3_FEATURES};
mod fixture_support;

use fixture_support::fixture;

fn accept_fixture(name: &str) {
    let wasm = fixture(name);
    let compiler = Compiler::default();
    compiler
        .validate(&wasm)
        .unwrap_or_else(|error| panic!("validate {name}.wat: {error}"));
    let program = compiler
        .compile(&wasm)
        .unwrap_or_else(|error| panic!("compile {name}.wat: {error}"));
    program
        .verify()
        .unwrap_or_else(|errors| panic!("compile {name}.wat produced invalid IR:\n{errors}"));
}

fn reject_fixture(name: &str) {
    let wasm = fixture(name);
    let compiler = Compiler::default();
    let error = match compiler.validate(&wasm) {
        Ok(()) => panic!("accepted invalid or out-of-profile fixture {name}.wat"),
        Err(error) => error,
    };

    assert!(
        matches!(&error, CompileError::InvalidWasm { .. }),
        "expected a validation error for {name}.wat, got {error:?}"
    );

    let error = compiler
        .compile(&wasm)
        .expect_err("the compile path must enforce the same language profile");
    assert!(
        matches!(&error, CompileError::InvalidWasm { .. }),
        "expected a compile-time validation error for {name}.wat, got {error:?}"
    );
}

macro_rules! rejection_test {
    ($test:ident, $fixture:literal) => {
        #[test]
        fn $test() {
            reject_fixture($fixture);
        }
    };
}

#[test]
fn every_accepted_fixture_validates_and_compiles() {
    let fixtures = std::env::var("WEDGE_ACCEPTED_WAT_FIXTURES")
        .expect("the build lists the accepted fixtures in WEDGE_ACCEPTED_WAT_FIXTURES");
    let names: Vec<&str> = fixtures.split_whitespace().collect();
    assert!(
        names.len() >= 35,
        "the accepted fixture list shrank to {} entries",
        names.len()
    );
    for name in names {
        accept_fixture(name);
    }
}

rejection_test!(rejects_nonstandard_threads, "nonstandard_threads");
rejection_test!(
    rejects_nonstandard_compact_imports,
    "nonstandard_compact_imports"
);
rejection_test!(
    rejects_nonstandard_custom_page_sizes,
    "nonstandard_custom_page_sizes"
);
rejection_test!(
    rejects_nonstandard_legacy_exception_handling,
    "nonstandard_legacy_eh"
);
rejection_test!(
    rejects_nonstandard_wide_arithmetic,
    "nonstandard_wide_arithmetic"
);
rejection_test!(rejects_a_missing_function_result, "invalid_missing_result");

#[test]
fn rejects_malformed_binary_input() {
    assert!(matches!(
        Compiler::default().validate(b"not wasm"),
        Err(CompileError::InvalidWasm { .. })
    ));
}

#[test]
fn rejects_component_encoding() {
    // Empty component: WebAssembly magic, component version 0x0d, component
    // encoding discriminator 0x01. Components are a separate specification,
    // not part of the Core WebAssembly 3.0 language accepted by Wedge.
    const EMPTY_COMPONENT: &[u8] = b"\0asm\x0d\0\x01\0";

    assert_eq!(
        Compiler::default().validate(EMPTY_COMPONENT),
        Err(CompileError::UnsupportedEncoding)
    );
}

#[test]
fn core_webassembly_3_profile_enables_every_standard_feature() {
    let features = STANDARD_WASM_3_FEATURES;
    assert_eq!(
        features.bits(),
        0x0000_000c_010a_fcff,
        "the exact pinned Core WebAssembly 3.0 feature mask changed"
    );
    let expected = [
        ("mutable globals", features.mutable_global()),
        (
            "saturating float-to-int",
            features.saturating_float_to_int(),
        ),
        ("sign extension", features.sign_extension()),
        ("reference types", features.reference_types()),
        ("multi-value", features.multi_value()),
        ("bulk memory", features.bulk_memory()),
        ("SIMD", features.simd()),
        ("relaxed SIMD", features.relaxed_simd()),
        ("tail calls", features.tail_call()),
        ("floating point", features.floats()),
        ("multi-memory", features.multi_memory()),
        ("exception handling", features.exceptions()),
        ("memory64", features.memory64()),
        ("extended constants", features.extended_const()),
        ("typed function references", features.function_references()),
        ("garbage collection", features.gc()),
        ("GC types", features.gc_types()),
        (
            "overlong call_indirect encoding",
            features.call_indirect_overlong(),
        ),
        (
            "bulk-memory optimization subset",
            features.bulk_memory_opt(),
        ),
    ];

    for (name, enabled) in expected {
        assert!(enabled, "Core WebAssembly 3.0 feature is disabled: {name}");
    }
}

#[test]
fn core_webassembly_3_profile_disables_every_out_of_scope_feature() {
    let features = STANDARD_WASM_3_FEATURES;
    let out_of_scope = [
        ("threads", features.threads()),
        (
            "shared-everything threads",
            features.shared_everything_threads(),
        ),
        ("Component Model", features.component_model()),
        ("memory control", features.memory_control()),
        ("custom page sizes", features.custom_page_sizes()),
        ("legacy exceptions", features.legacy_exceptions()),
        ("stack switching", features.stack_switching()),
        ("wide arithmetic", features.wide_arithmetic()),
        ("component values", features.cm_values()),
        ("component nested names", features.cm_nested_names()),
        ("component async", features.cm_async()),
        ("component stackful async ABI", features.cm_async_stackful()),
        (
            "component additional async builtins",
            features.cm_more_async_builtins(),
        ),
        ("component threading", features.cm_threading()),
        ("component error contexts", features.cm_error_context()),
        (
            "component fixed-length lists",
            features.cm_fixed_length_lists(),
        ),
        ("component GC", features.cm_gc()),
        ("custom descriptors", features.custom_descriptors()),
        ("compact imports", features.compact_imports()),
        ("component maps", features.cm_map()),
        ("64-bit component contexts", features.cm64()),
        ("component implements", features.cm_implements()),
        ("component canonical names", features.cm_canon_names()),
    ];

    for (name, enabled) in out_of_scope {
        assert!(!enabled, "non-standard feature is enabled: {name}");
    }
}
