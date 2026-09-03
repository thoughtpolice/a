# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_library(
    name = "wlink-lib",
    srcs = glob(
        ["src/**/*.rs"],
        exclude = [
            "src/main.rs",
            "src/tests/**",
        ],
    ),
    crate = "wlink",
    crate_root = "src/lib.rs",
    tests = [
        ":layout-property-tests",
        ":layout-tests",
        ":link-tests",
    ],
    visibility = ["PUBLIC"],
    deps = [
        "third-party//rust:anyhow",
        "third-party//rust:indexmap",
        "third-party//rust:wasm-encoder",
        "third-party//rust:wasmparser",
        "third-party//rust:wat",
        "third-party//rust:wit-component",
        "third-party//rust:wit-parser",
    ],
)

depot.rust_binary(
    name = "wlink",
    srcs = ["src/main.rs"],
    crate_root = "src/main.rs",
    visibility = ["PUBLIC"],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:anyhow",
        "third-party//rust:clap",
        "third-party//rust:wasmprinter",
        ":wlink-lib",
    ],
)

depot.rust_test(
    name = "layout-tests",
    srcs = ["src/tests/layout_tests.rs"],
    crate_root = "src/tests/layout_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        ":wlink-lib",
    ],
)

depot.rust_test(
    name = "layout-property-tests",
    srcs = ["src/tests/layout_property_tests.rs"],
    crate_root = "src/tests/layout_property_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:hegeltest",
        ":wlink-lib",
    ],
)

depot.rust_test(
    name = "link-tests",
    srcs = ["src/tests/link_tests.rs"] + glob(["tests/*.wat"]),
    crate_root = "src/tests/link_tests.rs",
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:anyhow",
        "third-party//rust:wasmparser",
        "third-party//rust:wat",
        ":wlink-lib",
    ],
)

# Component text fixtures. Each set below is linked with the CLI into a
# build artifact that WABT's interpreter runs, to check the generated adapters
# behave and not just validate. The linked artifacts are public so consumers
# of core modules can test against exactly what the linker produces.
FIXTURES = [
    "chain_app",
    "chain_base",
    "chain_mid",
    "hal_consumer",
    "host_a",
    "host_b",
    "host_exports",
    "host_lists",
    "host_resources",
    "initialization_order",
    "element_order",
    "escaped_scope",
    "initialization_growth",
    "list_consumer",
    "list_producer",
    "nested",
    "outer_scope",
    "record_consumer",
    "record_producer",
    "ref_func_export",
    "resource_consumer",
    "resource_producer",
    "resource_relay",
    "scalar_consumer",
    "scalar_producer",
    "string_consumer",
    "string_producer",
    "variant",
    "wide_consumer",
    "wide_producer",
]

[
    depot.export_file(
        name = "{}.wat".format(fixture),
        src = "tests/{}.wat".format(fixture),
        visibility = [],
    )
    for fixture in FIXTURES
]

# name: the fixtures that link into linked-<name>.wasm
LINKED_MODULES = {
    "initialization-order": ["initialization_order"],
    "initialization-growth": ["initialization_growth"],
    "escaped-scope": ["escaped_scope"],
    "element-order": ["element_order"],
    "outer-scope": ["outer_scope"],
    "ref-func-export": ["ref_func_export"],
    "host-abi": [
        "host_a",
        "host_b",
        "host_exports",
        "host_lists",
        "host_resources",
    ],
    "chain": [
        "chain_base",
        "chain_mid",
        "chain_app",
    ],
    "hal": ["hal_consumer"],
    "lists": [
        "list_producer",
        "list_consumer",
    ],
    "nested": ["nested"],
    "records": [
        "record_producer",
        "record_consumer",
    ],
    "resources": [
        "resource_producer",
        "resource_relay",
        "resource_consumer",
    ],
    "scalar": [
        "scalar_producer",
        "scalar_consumer",
    ],
    "string": [
        "string_producer",
        "string_consumer",
    ],
    "variant": ["variant"],
    "wide": [
        "wide_producer",
        "wide_consumer",
    ],
}

[
    depot.genrule(
        name = "linked-{}.wasm".format(name),
        out = "linked-{}.wasm".format(name),
        cmd = "$(exe :wlink) link -o $OUT " + " ".join(["$(location :{}.wat)".format(fixture) for fixture in fixtures]),
        visibility = ["PUBLIC"],
    )
    for name, fixtures in LINKED_MODULES.items()
]

# Every linked set packed into one text file, the components separated by a
# line a fuzz harness can split on, so a consumer's campaign starts from
# packages that link.
depot.genrule(
    name = "fuzz-seeds",
    out = "seeds",
    cmd = "mkdir -p $OUT && " + " && ".join([
        "{ " + "; printf '\\n(;wlink-fuzz-split;)\\n'; ".join([
            "cat $(location :{}.wat)".format(fixture)
            for fixture in fixtures
        ]) + "; }} > $OUT/{}.wat".format(name)
        for name, fixtures in LINKED_MODULES.items()
    ]),
    visibility = ["PUBLIC"],
)

# Exercise the raw host ABI through wasm2c, including memory selection,
# reading an exported result before invoking its post-return callback,
# resources on both sides of the edge, and handles that reach the host
# through the component's memory.
depot.genrule(
    name = "host-abi-c",
    outs = {
        "c": ["host_abi.c"],
        "h": ["host_abi.h"],
    },
    cmd = "$(exe third-party//by-name/wa/wabt:wasm2c) $(location :linked-host-abi.wasm) -n host_abi -o $OUT/host_abi.c",
    default_outs = ["host_abi.c"],
    visibility = [],
)

depot.cxx_binary(
    name = "host-abi",
    srcs = [
        "tests/host_abi.c",
        ":host-abi-c[c]",
    ],
    header_namespace = "",
    headers = {"host_abi.h": ":host-abi-c[h]"},
    linker_flags = ["-lm"],
    visibility = [],
    deps = ["third-party//by-name/wa/wabt:wasm-rt"],
)

depot.command_test(
    name = "run-host-abi",
    cmd = ["$(exe :host-abi)"],
)

# A core module written against a WIT world, wrapped with `wlink componentize`
# and then linked like any other component.
depot.export_file(
    name = "componentize.wit",
    src = "tests/componentize.wit",
    visibility = [],
)

depot.genrule(
    name = "componentize-core.wasm",
    srcs = ["tests/componentize_core.wat"],
    out = "core.wasm",
    cmd = "$(exe third-party//by-name/wa/wabt:wat2wasm) $SRCS -o $OUT",
    visibility = [],
)

depot.genrule(
    name = "component-consumer.wasm",
    out = "consumer.wasm",
    cmd = "$(exe :wlink) componentize $(location :componentize-core.wasm) " +
          "--wit $(location :componentize.wit) --world consumer -o $OUT",
    visibility = ["PUBLIC"],
)

depot.genrule(
    name = "linked-componentized.wasm",
    out = "linked-componentized.wasm",
    cmd = "$(exe :wlink) link -o $OUT $(location :scalar_producer.wat) $(location :component-consumer.wasm)",
    visibility = ["PUBLIC"],
)

# name: (linked module, export, expected interpreter result)
BEHAVIOUR_TESTS = {
    "initialization-order": ("initialization-order", "run", "i32:1"),
    "element-order": ("element-order", "run", "i32:1"),
    "outer-scope": ("outer-scope", "run", "i32:42"),
    "ref-func-export": ("ref-func-export", "run", "i32:42"),
    "initialization-growth": ("initialization-growth", "run", "i32:42"),
    "escaped-scope": ("escaped-scope", "run", "i32:42"),
    "chain": (
        "chain",
        "run",
        "i32:1107",
    ),
    "componentized": (
        "componentized",
        "run",
        "i32:42",
    ),
    "list-result": (
        "lists",
        "run-iota",
        "i32:403",
    ),
    "lists": (
        "lists",
        "run",
        "i32:10",
    ),
    "lists-nested": (
        "lists",
        "run-total",
        "i32:15",
    ),
    "lists-option": (
        "lists",
        "run-label",
        "i32:229",
    ),
    "nested": (
        "nested",
        "run",
        "i32:42",
    ),
    "records": (
        "records",
        "run",
        "i32:48",
    ),
    "resources": (
        "resources",
        "run",
        "i32:181",
    ),
    "resources-misuse": (
        "resources",
        "misuse",
        "error: unreachable executed",
    ),
    "scalar": (
        "scalar",
        "run",
        "i32:42",
    ),
    "string-param": (
        "string",
        "run",
        "i32:5",
    ),
    "string-result": (
        "string",
        "run-name",
        "i32:124",
    ),
    "variant": (
        "variant",
        "run",
        "i32:42",
    ),
    "wide-params": (
        "wide",
        "run",
        "i32:139",
    ),
}

[
    depot.command_test(
        name = "run-{}".format(name),
        cmd = [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            """
out="${{TMPDIR:-/tmp}}/wlink-run-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe third-party//by-name/wa/wabt:wasm-interp) --enable-all --run-export={export} $(location :linked-{module}.wasm) >"$out/result"
grep -q '{export}() => {expected}' "$out/result"
""".format(
                expected = expected,
                export = export,
                module = module,
            ),
        ],
    )
    for name, (module, export, expected) in BEHAVIOUR_TESTS.items()
]
