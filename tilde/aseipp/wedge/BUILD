# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/fozzie:defs.bzl", "rust_fuzz_binary")

WAT_FIXTURES = [
    "add",
    "answer",
    "bulk_memory",
    "canonical_types",
    "catch_after_catch_all",
    "chacha20",
    "control_flow",
    "default_locals",
    "exception_routing",
    "exceptions",
    "extended_const",
    "function_references",
    "gc_types",
    "loop_label_arguments",
    "memory",
    "memory64",
    "module_entities",
    "multi_memory",
    "multi_value",
    "mutable_globals",
    "named_functions",
    "numeric",
    "reference_br_on_non_null",
    "reference_br_on_null",
    "reference_const_expr",
    "reference_types",
    "relaxed_simd",
    "saturating_conversions",
    "scalar_leaf_operations",
    "segments",
    "sign_extension",
    "simd",
    "simd_lane_operations",
    "ssa_locals",
    "structured_control",
    "table64",
    "table_leaf_operations",
    "tables",
    "tag_aliasing",
    "tail_calls",
]

NONSTANDARD_WAT_FIXTURES = [
    "nonstandard_compact_imports",
    "nonstandard_custom_page_sizes",
    "nonstandard_legacy_eh",
    "nonstandard_threads",
    "nonstandard_wide_arithmetic",
]

INVALID_WAT_FIXTURES = [
    "invalid_missing_result",
]

WAT_FLAGS = {
    # WABT leaves these standard Core 3.0 features off by default.
    "canonical_types": "--enable-function-references",
    "exception_routing": "--enable-function-references",
    "function_references": "--enable-function-references",
    "gc_types": "--enable-gc",
    "invalid_missing_result": "--no-check",
    "named_functions": "--debug-names",
    "reference_br_on_non_null": "--enable-function-references",
    "reference_br_on_null": "--enable-function-references",
    "reference_const_expr": "--enable-function-references",
    "ssa_locals": "--enable-function-references",
    # Emit proposal binaries only so the compiler can prove it rejects them.
    "nonstandard_compact_imports": "--enable-compact-imports",
    "nonstandard_custom_page_sizes": "--enable-custom-page-sizes",
    "nonstandard_threads": "--enable-threads",
    "nonstandard_wide_arithmetic": "--enable-wide-arithmetic",
}

ALL_WAT_FIXTURES = WAT_FIXTURES + NONSTANDARD_WAT_FIXTURES + INVALID_WAT_FIXTURES

ADVANCED_LOWERING_WAT_FIXTURES = [
    # WABT enables final EH and tail calls by default and exposes only
    # --disable-exceptions/--disable-tail-call switches for those features.
    "exceptions",
    "function_references",
    "reference_br_on_non_null",
    "reference_br_on_null",
    "tail_calls",
]

E2E_WAT_FIXTURES = [
    "add",
    "answer",
    "canonical_types",
    "extended_const",
    "gc_types",
    "module_entities",
    "named_functions",
    "numeric",
    "reference_const_expr",
    "segments",
]

LEAF_LOWERING_WAT_FIXTURES = [
    "bulk_memory",
    "gc_types",
    "memory",
    "memory64",
    "multi_memory",
    "mutable_globals",
    "numeric",
    "reference_types",
    "relaxed_simd",
    "saturating_conversions",
    "scalar_leaf_operations",
    "sign_extension",
    "simd",
    "simd_lane_operations",
    "table64",
    "table_leaf_operations",
]

IR_GOLDENS = [
    "compiled_add",
    "compiled_answer",
    "diamond_cfg",
    "effects_and_exception_handling",
    "minimal_typed_function",
    "rich_module_entities_and_types",
]

# Core modules wlink links from components, consumed as the build produces
# them: the prototype console package, PureDOOM on the same SDK, and the
# linker's own fixture sets.
WLINK_MODULES = {
    "wlink-chain.wasm": "tilde//aseipp/wlink:linked-chain.wasm",
    "wlink-console.wasm": "tilde//aseipp/wlink/demo:linked.wasm",
    "wlink-doom.wasm": "tilde//aseipp/wlink/demo:doom-linked.wasm",
    "wlink-hal.wasm": "tilde//aseipp/wlink:linked-hal.wasm",
    "wlink-quake2.wasm": "tilde//aseipp/wlink/demo/quake2:quake2-linked.wasm",
    "wlink-host-abi.wasm": "tilde//aseipp/wlink:linked-host-abi.wasm",
    "wlink-lists.wasm": "tilde//aseipp/wlink:linked-lists.wasm",
    "wlink-nested.wasm": "tilde//aseipp/wlink:linked-nested.wasm",
    "wlink-records.wasm": "tilde//aseipp/wlink:linked-records.wasm",
    "wlink-resources.wasm": "tilde//aseipp/wlink:linked-resources.wasm",
    "wlink-scalar.wasm": "tilde//aseipp/wlink:linked-scalar.wasm",
    "wlink-string.wasm": "tilde//aseipp/wlink:linked-string.wasm",
    "wlink-variant.wasm": "tilde//aseipp/wlink:linked-variant.wasm",
    "wlink-wide.wasm": "tilde//aseipp/wlink:linked-wide.wasm",
}

[
    depot.genrule(
        name = "{}-wasm".format(fixture),
        srcs = ["tests/{}.wat".format(fixture)],
        out = "{}.wasm".format(fixture),
        cmd = "$(exe third-party//by-name/wa/wabt:wat2wasm) {} $SRCS -o $OUT".format(
            WAT_FLAGS.get(fixture, ""),
        ),
        visibility = [],
    )
    for fixture in ALL_WAT_FIXTURES
]

[
    depot.export_file(
        name = "{}-golden".format(golden),
        src = "tests/golden/{}.txt".format(golden),
        visibility = [],
    )
    for golden in IR_GOLDENS
]

depot.rust_library(
    name = "wedge-lib",
    srcs = [
        "src/cfg.rs",
        "src/core_context.rs",
        "src/core_numeric.rs",
        "src/core_schema.rs",
        "src/dump.rs",
        "src/edit.rs",
        "src/frontend.rs",
        "src/interp/exec.rs",
        "src/interp/mod.rs",
        "src/interp/numeric.rs",
        "src/interp/simd.rs",
        "src/interp/store.rs",
        "src/ir.rs",
        "src/lib.rs",
        "src/opcode.rs",
        "src/semantics.rs",
        "src/simplify.rs",
    ],
    crate = "wedge",
    crate_root = "src/lib.rs",
    tests = [
        ":advanced-lowering-tests",
        ":cfg-analysis-filecheck-tests",
        ":cfg-analysis-property-tests",
        ":cfg-analysis-tests",
        ":cfg-property-tests",
        ":console-tests",
        ":control-flow-tests",
        ":core-context-tests",
        ":core-numeric-tests",
        ":core-operation-property-tests",
        ":core-schema-inventory-tests",
        ":core-schema-tests",
        ":differential-tests",
        ":e2e-tests",
        ":effects-property-tests",
        ":effects-tests",
        ":eh-property-tests",
        ":eh-routing-tests",
        ":gc-const-expr-tests",
        ":golden-tests",
        ":interp-tests",
        ":ir-contract-tests",
        ":ir-unit-tests",
        ":leaf-lowering-tests",
        ":lowering-limits-tests",
        ":opcode-tests",
        ":program-tests",
        ":simplify-property-tests",
        ":simplify-tests",
        ":smith-property-tests",
        ":ssa-lowering-tests",
        ":type-verifier-tests",
        ":validation-tests",
        ":wlink-tests",
    ],
    visibility = ["PUBLIC"],
    deps = [
        "third-party//rust:thiserror",
        "third-party//rust:wasmparser",
    ],
)

depot.rust_binary(
    name = "wedge",
    srcs = ["src/main.rs"],
    crate_root = "src/main.rs",
    resources = {
        "wat2wasm": "third-party//by-name/wa/wabt:wat2wasm",
    },
    tests = [
        ":e2e-tests",
        ":test-cli",
        ":test-cli-function-export",
        ":test-cli-function-index",
        ":test-cli-function-name",
        ":test-cli-wat",
    ],
    visibility = ["PUBLIC"],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:anyhow",
        "third-party//rust:buck-resources",
        "third-party//rust:clap",
        ":wedge-lib",
    ],
)

depot.command_test(
    name = "test-cli",
    cmd = [
        "$(exe :wedge)",
        "$(location :answer-wasm)",
    ],
)

# --function selects one function for either dump, by index, by its name
# section entry, or by export name; wlink's string fixture has all three.
[
    depot.command_test(
        name = "test-cli-function-{}".format(name),
        cmd = [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            """
$(exe :wedge) --emit {emit} --function '{selector}' $(location tilde//aseipp/wlink:linked-string.wasm) | grep '{expected}' >/dev/null
""".format(
                emit = emit,
                expected = expected,
                selector = selector,
            ),
        ],
    )
    for name, (emit, selector, expected) in {
        "export": ("cfg", "run-name", '^  func func6 name="string_consumer.1.func1" exports=\\["run-name"\\] entry='),
        "index": ("ir", "func7", '^  func func7 wasm-index=7 : type8 defined name="adapter#greet"'),
        "name": ("ir", "adapter#name", '^  func func8 wasm-index=8 : type9 defined name="adapter#name"'),
    }.items()
]

depot.export_file(
    name = "gc_types.wat",
    src = "tests/gc_types.wat",
    visibility = [],
)

depot.command_test(
    name = "test-cli-wat",
    cmd = [
        "$(exe :wedge)",
        "--emit",
        "cfg",
        "$(location :gc_types.wat)",
    ],
)

depot.rust_test(
    name = "advanced-lowering-tests",
    srcs = [
        "src/tests/advanced_lowering_tests.rs",
        "src/tests/fixture_support.rs",
    ],
    crate_root = "src/tests/advanced_lowering_tests.rs",
    resources = {
        "{}.wasm".format(fixture): ":{}-wasm".format(fixture)
        for fixture in ADVANCED_LOWERING_WAT_FIXTURES
    },
    visibility = [],
    deps = [
        "third-party//rust:buck-resources",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "eh-routing-tests",
    srcs = [
        "src/tests/eh_routing_tests.rs",
        "src/tests/fixture_support.rs",
    ],
    crate_root = "src/tests/eh_routing_tests.rs",
    resources = {
        "catch_after_catch_all.wasm": ":catch_after_catch_all-wasm",
        "exception_routing.wasm": ":exception_routing-wasm",
        "loop_label_arguments.wasm": ":loop_label_arguments-wasm",
        "tag_aliasing.wasm": ":tag_aliasing-wasm",
    },
    visibility = [],
    deps = [
        "third-party//rust:buck-resources",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "eh-property-tests",
    srcs = ["src/tests/eh_property_tests.rs"],
    crate_root = "src/tests/eh_property_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:hegeltest",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "control-flow-tests",
    srcs = [
        "src/tests/control_flow_tests.rs",
        "src/tests/fixture_support.rs",
    ],
    crate_root = "src/tests/control_flow_tests.rs",
    resources = {
        "control_flow.wasm": ":control_flow-wasm",
        "structured_control.wasm": ":structured_control-wasm",
    },
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:buck-resources",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "cfg-property-tests",
    srcs = ["src/tests/cfg_property_tests.rs"],
    crate_root = "src/tests/cfg_property_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:hegeltest",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "cfg-analysis-tests",
    srcs = ["src/tests/cfg_analysis_tests.rs"],
    crate_root = "src/tests/cfg_analysis_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "cfg-analysis-property-tests",
    srcs = ["src/tests/cfg_analysis_property_tests.rs"],
    crate_root = "src/tests/cfg_analysis_property_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:hegeltest",
        ":wedge-lib",
    ],
)

depot.filecheck.lit(
    name = "cfg-analysis-filecheck-tests",
    srcs = glob(["tests/filecheck/*.test"]),
    data = [
        "tests/chacha20.wat",
        "tests/control_flow.wat",
        "tests/exception_routing.wat",
        "tests/module_entities.wat",
        "tests/structured_control.wat",
    ],
    defines = {
        "wlink_component": "$(location tilde//aseipp/wlink:component-consumer.wasm)",
        "wlink_console": "$(location tilde//aseipp/wlink/demo:linked.wasm)",
        "wlink_doom": "$(location tilde//aseipp/wlink/demo:doom-linked.wasm)",
        "wlink_quake2": "$(location tilde//aseipp/wlink/demo/quake2:quake2-linked.wasm)",
        "wlink_string": "$(location tilde//aseipp/wlink:linked-string.wasm)",
    },
    tools = {
        "wasm-interp": "third-party//by-name/wa/wabt:wasm-interp",
        "wat2wasm": "third-party//by-name/wa/wabt:wat2wasm",
        "wedge": ":wedge",
    },
)

depot.rust_test(
    name = "effects-property-tests",
    srcs = ["src/tests/effects_property_tests.rs"],
    crate_root = "src/tests/effects_property_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:hegeltest",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "effects-tests",
    srcs = ["src/tests/effects_tests.rs"],
    crate_root = "src/tests/effects_tests.rs",
    visibility = [],
    deps = [
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "core-context-tests",
    srcs = [
        "src/tests/core_context_tests.rs",
        "src/tests/core_operation_test_support.rs",
    ],
    crate_root = "src/tests/core_context_tests.rs",
    visibility = [],
    deps = [
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "core-numeric-tests",
    srcs = [
        "src/tests/core_numeric_tests.rs",
        "src/tests/core_operation_test_support.rs",
    ],
    crate_root = "src/tests/core_numeric_tests.rs",
    visibility = [],
    deps = [
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "core-operation-property-tests",
    srcs = [
        "src/tests/core_operation_property_tests.rs",
        "src/tests/core_operation_test_support.rs",
    ],
    crate_root = "src/tests/core_operation_property_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:hegeltest",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "core-schema-inventory-tests",
    srcs = [
        "src/tests/core_operation_test_support.rs",
        "src/tests/core_schema_inventory_tests.rs",
    ],
    crate_root = "src/tests/core_schema_inventory_tests.rs",
    visibility = [],
    deps = [
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "core-schema-tests",
    srcs = ["src/tests/core_schema_tests.rs"],
    crate_root = "src/tests/core_schema_tests.rs",
    visibility = [],
    deps = [
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "gc-const-expr-tests",
    srcs = [
        "src/tests/encoding_support.rs",
        "src/tests/gc_const_expr_tests.rs",
    ],
    crate_root = "src/tests/gc_const_expr_tests.rs",
    visibility = [],
    deps = [
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "golden-tests",
    srcs = ["src/tests/golden_tests.rs"],
    crate_root = "src/tests/golden_tests.rs",
    resources = {
        "golden/{}.txt".format(golden): ":{}-golden".format(golden)
        for golden in IR_GOLDENS
    } | {
        "add.wasm": ":add-wasm",
        "answer.wasm": ":answer-wasm",
    },
    visibility = [],
    deps = [
        "third-party//rust:buck-resources",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "interp-tests",
    srcs = ["src/tests/interp_tests.rs"],
    crate_root = "src/tests/interp_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:wat",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "ir-contract-tests",
    srcs = ["src/tests/ir_contract_tests.rs"],
    crate_root = "src/tests/ir_contract_tests.rs",
    visibility = [],
    deps = [
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "ir-unit-tests",
    srcs = ["src/tests/ir_unit_tests.rs"],
    crate_root = "src/tests/ir_unit_tests.rs",
    visibility = [],
    deps = [
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "leaf-lowering-tests",
    srcs = [
        "src/tests/fixture_support.rs",
        "src/tests/leaf_lowering_tests.rs",
    ],
    crate_root = "src/tests/leaf_lowering_tests.rs",
    resources = {
        "{}.wasm".format(fixture): ":{}-wasm".format(fixture)
        for fixture in LEAF_LOWERING_WAT_FIXTURES
    },
    visibility = [],
    deps = [
        "third-party//rust:buck-resources",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "lowering-limits-tests",
    srcs = [
        "src/tests/encoding_support.rs",
        "src/tests/lowering_limits_tests.rs",
    ],
    crate_root = "src/tests/lowering_limits_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "opcode-tests",
    srcs = ["src/tests/opcode_tests.rs"],
    crate_root = "src/tests/opcode_tests.rs",
    visibility = [],
    deps = [
        "third-party//rust:wasmparser",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "program-tests",
    srcs = [
        "src/tests/fixture_support.rs",
        "src/tests/program_tests.rs",
    ],
    crate_root = "src/tests/program_tests.rs",
    resources = {
        "chacha20.wasm": ":chacha20-wasm",
    },
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:buck-resources",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "e2e-tests",
    srcs = [
        "src/tests/e2e_tests.rs",
        "src/tests/fixture_support.rs",
    ],
    crate_root = "src/tests/e2e_tests.rs",
    resources = {
        "{}.wasm".format(fixture): ":{}-wasm".format(fixture)
        for fixture in E2E_WAT_FIXTURES
    },
    visibility = [],
    deps = [
        "third-party//rust:buck-resources",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "ssa-lowering-tests",
    srcs = [
        "src/tests/encoding_support.rs",
        "src/tests/fixture_support.rs",
        "src/tests/ssa_lowering_tests.rs",
    ],
    crate_root = "src/tests/ssa_lowering_tests.rs",
    resources = {
        "default_locals.wasm": ":default_locals-wasm",
        "loop_label_arguments.wasm": ":loop_label_arguments-wasm",
        "ssa_locals.wasm": ":ssa_locals-wasm",
    },
    visibility = [],
    deps = [
        "third-party//rust:buck-resources",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "type-verifier-tests",
    srcs = ["src/tests/type_verifier_tests.rs"],
    crate_root = "src/tests/type_verifier_tests.rs",
    visibility = [],
    deps = [
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "validation-tests",
    srcs = [
        "src/tests/fixture_support.rs",
        "src/tests/validation_tests.rs",
    ],
    crate_root = "src/tests/validation_tests.rs",
    env = {
        "WEDGE_ACCEPTED_WAT_FIXTURES": " ".join(WAT_FIXTURES),
    },
    resources = {
        "{}.wasm".format(fixture): ":{}-wasm".format(fixture)
        for fixture in ALL_WAT_FIXTURES
    },
    visibility = [],
    deps = [
        "third-party//rust:buck-resources",
        ":wedge-lib",
    ],
)

depot.rust_test(
    name = "wlink-tests",
    srcs = [
        "src/tests/fixture_support.rs",
        "src/tests/wlink_tests.rs",
    ],
    crate_root = "src/tests/wlink_tests.rs",
    resources = WLINK_MODULES,
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:buck-resources",
        ":wedge-lib",
    ],
)

# The contract every module must satisfy and modules drawn from bytes with
# wasm-smith, shared by the fuzz harnesses and the generated-module properties.
depot.rust_library(
    name = "wedge-testing",
    srcs = [
        "src/testing/console.rs",
        "src/testing/differential.rs",
        "src/testing/equivalence.rs",
        "src/testing/lib.rs",
        "src/testing/oracle.rs",
        "src/testing/smith.rs",
    ],
    crate = "wedge_testing",
    crate_root = "src/testing/lib.rs",
    visibility = [],
    deps = [
        "third-party//rust:arbitrary",
        "third-party//rust:tempfile",
        "third-party//rust:wasm-smith",
        "third-party//rust:wasmprinter",
        ":wedge-lib",
    ],
)

# The reference interpreter against WABT's, on every fixture and on
# generated modules. The runner is a resource so the test and the harness
# find the same pinned build.
DIFFERENTIAL_RESOURCES = {
    "{}.wasm".format(fixture): ":{}-wasm".format(fixture)
    for fixture in WAT_FIXTURES
}

DIFFERENTIAL_RESOURCES["spectest-interp"] = "third-party//by-name/wa/wabt:spectest-interp"

depot.rust_test(
    name = "differential-tests",
    srcs = [
        "src/tests/differential_tests.rs",
        "src/tests/fixture_support.rs",
    ],
    crate_root = "src/tests/differential_tests.rs",
    resources = DIFFERENTIAL_RESOURCES,
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:arbitrary",
        "third-party//rust:buck-resources",
        "third-party//rust:hegeltest",
        ":wedge-lib",
        ":wedge-testing",
    ],
)

depot.rust_test(
    name = "simplify-tests",
    srcs = [
        "src/tests/fixture_support.rs",
        "src/tests/simplify_tests.rs",
    ],
    crate_root = "src/tests/simplify_tests.rs",
    env = {
        "WEDGE_FIXTURES": " ".join(WAT_FIXTURES),
    },
    resources = {
        "{}.wasm".format(fixture): ":{}-wasm".format(fixture)
        for fixture in WAT_FIXTURES
    } | WLINK_MODULES,
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:buck-resources",
        "third-party//rust:wat",
        ":wedge-lib",
        ":wedge-testing",
    ],
)

depot.rust_test(
    name = "simplify-property-tests",
    srcs = ["src/tests/simplify_property_tests.rs"],
    crate_root = "src/tests/simplify_property_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:arbitrary",
        "third-party//rust:hegeltest",
        ":wedge-lib",
        ":wedge-testing",
    ],
)

# The linked console packages run whole under the interpreter, against the
# native wasm2c hosts of the same modules.
depot.rust_test(
    name = "console-tests",
    srcs = ["src/tests/console_tests.rs"],
    crate_root = "src/tests/console_tests.rs",
    resources = {
        "console-host": "tilde//aseipp/wlink/demo:host",
        "doom-host": "tilde//aseipp/wlink/demo:doom-host",
        "freedoom2.wad": "tilde//aseipp/wlink/demo/doom:freedoom[freedoom2.wad]",
        "pak0.pak": "tilde//aseipp/wlink/demo/quake2:demo-data[pak]",
        "quake2-host": "tilde//aseipp/wlink/demo/quake2:quake2-host",
        "wlink-console.wasm": WLINK_MODULES["wlink-console.wasm"],
        "wlink-doom.wasm": WLINK_MODULES["wlink-doom.wasm"],
        "wlink-quake2.wasm": WLINK_MODULES["wlink-quake2.wasm"],
    },
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:buck-resources",
        ":wedge-lib",
        ":wedge-testing",
    ],
)

depot.rust_test(
    name = "smith-property-tests",
    srcs = ["src/tests/smith_property_tests.rs"],
    crate_root = "src/tests/smith_property_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:hegeltest",
        ":wedge-lib",
        ":wedge-testing",
    ],
)

# Fozzie harnesses: `buck2 test` runs a bounded campaign, and
# `buck2 run <target> -- --workdir PATH` keeps fuzzing into PATH. One draws
# modules from its input with wasm-smith; the other takes the input as the
# module, starting from every fixture and the linker's small outputs.
#
# Compiling one module makes tens of thousands of comparisons, far past the
# engine's default of 4,096 observations per run, which clipped nearly every
# run's comparison feedback.
WEDGE_CMP_CAPACITY = 65536

rust_fuzz_binary(
    name = "smith-fuzz",
    srcs = ["src/fuzz/smith_fuzz.rs"],
    cmp_capacity = WEDGE_CMP_CAPACITY,
    duration_seconds = 0,
    jobs = 1,
    runs = 256,
    timeout_ms = 5000,
    deps = [":wedge-testing"],
)

rust_fuzz_binary(
    name = "module-fuzz",
    srcs = ["src/fuzz/module_fuzz.rs"],
    cmp_capacity = WEDGE_CMP_CAPACITY,
    corpus = [":{}-wasm".format(fixture) for fixture in ALL_WAT_FIXTURES] + [
        label
        for label in WLINK_MODULES.values()
        if label.startswith("tilde//aseipp/wlink:")
    ],
    duration_seconds = 0,
    jobs = 1,
    runs = 256,
    timeout_ms = 5000,
    deps = [":wedge-testing"],
)

# Generated modules must behave the same under the reference interpreter
# and under WABT's; a run spawns WABT, so the bounded campaign is short.
rust_fuzz_binary(
    name = "exec-fuzz",
    srcs = ["src/fuzz/exec_fuzz.rs"],
    cmp_capacity = WEDGE_CMP_CAPACITY,
    duration_seconds = 0,
    jobs = 1,
    resources = {
        "spectest-interp": "third-party//by-name/wa/wabt:spectest-interp",
    },
    runs = 64,
    timeout_ms = 30000,
    deps = [
        "third-party//rust:arbitrary",
        ":wedge-lib",
        ":wedge-testing",
    ],
)

# The simplification pass must keep every generated module verifying and
# behaving as it did; both programs run under the reference interpreter.
rust_fuzz_binary(
    name = "simplify-fuzz",
    srcs = ["src/fuzz/simplify_fuzz.rs"],
    cmp_capacity = WEDGE_CMP_CAPACITY,
    duration_seconds = 0,
    jobs = 1,
    runs = 256,
    timeout_ms = 10000,
    deps = [
        "third-party//rust:arbitrary",
        ":wedge-testing",
    ],
)

# Whatever wlink links must meet the same contract, from every fixture set
# the linker's build links, packed one package per seed file.
rust_fuzz_binary(
    name = "link-fuzz",
    srcs = ["src/fuzz/link_fuzz.rs"],
    cmp_capacity = WEDGE_CMP_CAPACITY,
    corpus = ["tilde//aseipp/wlink:fuzz-seeds"],
    duration_seconds = 0,
    jobs = 1,
    runs = 256,
    timeout_ms = 5000,
    deps = [
        "tilde//aseipp/wlink:wlink-lib",
        ":wedge-lib",
        ":wedge-testing",
    ],
)
