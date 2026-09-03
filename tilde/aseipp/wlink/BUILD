# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_library(
    name = "wlink-lib",
    srcs = glob(
        [
            "src/**/*.rs",
            "src/runtime.wat",
        ],
        exclude = [
            "src/main.rs",
            "src/tests/**",
        ],
    ),
    crate = "wlink",
    crate_root = "src/lib.rs",
    tests = [
        ":conformance-tests",
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

# The component model's async conformance tests: the WAST scripts of its
# specification repository (github.com/WebAssembly/component-model, Apache
# 2.0, the WebAssembly Community Group participants) at a fixed commit,
# each `:component-model/<file name>`, and all of them in one directory.
COMPONENT_MODEL_COMMIT = "a25fc0b372dd21f07f0242c46e98bd0f1ea0c0e1"

COMPONENT_MODEL_ASYNC_TESTS = {
    "async-calls-sync.wast": "bacf1fab5f97e7dfcceca89c19a6b84bf4d89ebaedb69ccb448928f9af0fc879",
    "big-interleaving-test.wast": "94d776825d50d7b74505653caf4e6428a0ea4650813bcb42ab171f846c9fbb81",
    "builtin-trap-poisons-instance.wast": "d513bcff29bb9ca0356f31806cfaed2b15ad3ac1593c1fa1eb913fd1010c0c77",
    "cancel-and-exclusive-lock.wast": "a6bef2fe693216c65239ba9bfde3eb2636280282cefef58808a8c58d98be9f27",
    "cancel-delivery.wast": "e4ae0061ad2ce2bfe95e05fa31d8bac3d367725701a9df061f423c4d418194cc",
    "cancel-not-delivered.wast": "746524e3306b0f218f9816949d0449d20a160f76f04856bf708f447a6eb56774",
    "cancel-resumed-callback-switch.wast": "35112c3305f0fc553648567d406d95da2e0c6affc7cef52bfc83f496632b984d",
    "cancel-stream.wast": "bd3bb6babaebf6f03e41e6eb7cb30c5dafa2adc276dc1356e2f2c5d4743fbebf",
    "cancel-subtask.wast": "b72065c29f656e56c0f12e589ec1300005a9ae48061a945cdaca0bf21f1c4497",
    "cancel-targeted-resume.wast": "8cfa1d2e0782b06c0072a789a4dd29f81090e251198df28292e70b8b577b944e",
    "closed-stream.wast": "5fddd95e1f7920f6a453e4f72bd4abc9d8a1615f8937f33ae06e0df31ca4d2a0",
    "cross-abi-calls.wast": "32a9b35490c7f3ca8191ddd9d812810d9d0b70d67b50b97e10f75a72bfd8b85e",
    "cross-task-future.wast": "d962876ba33012ce0ff068a0d056b2d8b27f5a86749fc410ca1051bd26a50a14",
    "deadlock.wast": "9bdd951733f5219bba0b3e226a15d85429f054d67faa6d784c42b50588213e19",
    "dont-block-start.wast": "69fd1debc9898c4bdf71f9a2bbc3f9994d1f3ef143ebbf4df6eacbdc47affc9d",
    "drop-cross-task-borrow.wast": "1e8f60537f6f0a6f78a693de01b8175181c1e15fbd8a78be27a3764576d1e1e3",
    "drop-stream.wast": "ff226f805c84cd6a3e445905a312a7abd94e7439359c1e912ce055d774a386ad",
    "drop-subtask.wast": "2b41e426796f0b49b25ce8ce8ae5bb1ed1b1d9279e59d2d0bdc1dadaf0f67b97",
    "drop-waitable-set.wast": "8c4deb26d062ab421c99d8c178e59916473bc0e3016efea6b68779b0338ee59f",
    "during-sync-call-exclusive-resume.wast": "2276977b966fe04706758ef9d95b9194bc11dde8c96d2f74c59ba93ec1f37aa0",
    "during-sync-call-may-block-if-other-ready-threads.wast": "d949b721f1890b1f6e67f14ad1edb548e8357d3b336b793d1135e95ad91f982a",
    "during-sync-call-no-sibling-resume.wast": "0c64d9224cb25a94cda2840c650f2317d633a93ceb5e60658a8e2fbec19d3dcb",
    "during-sync-scheduling-candidates.wast": "282a97133650c6e1be560f40be6e721bd93ae90b477e78f608b2828b2a776810",
    "empty-wait.wast": "cadb124978a329d9fa2912d109901ad862357d7969f072325069511646b892c9",
    "forward.wast": "c9c8557a21e64fea87680f1a72b5cc1220cff6de6d0c3037dafaf8c05e7bfbfc",
    "future-completion-order.wast": "a4312e5a4e2fb354f9b213c6623a30f4913c4008779f36e021e3000f8b4972c0",
    "futures-must-write.wast": "f9574e013de0db6da1ce2fbbb295526da87f51bc5214c60354ce61700b18f5c3",
    "idle-drop.wast": "96ba6a39c7556e4678013f3b5066363decb5cbf9abbcea4cabfcce30b6b68c11",
    "partial-stream-copies.wast": "74bdc4f5f643c3e7c8449d676133f19fa396003c53d52dac88986bc1938a395f",
    "passing-resources.wast": "5fcee86ff0e2581af82095e56ed6661a651f80f6c6060a428f00ec7911bddf23",
    "reentrance.wast": "4683f1edbbbf5f095a6ec2dd529a876d1a62113a7d8f68369f41334cca5dd173",
    "same-component-stream-future.wast": "2623dc2abe9b6a438d66c9c01ac92e59655121ccf04f5e230af9839cc7b023fa",
    "self-switch-traps.wast": "eb4a4a38963ee151f085abad80459fbdc86bd8ec3cdcfc23fe95882be4aede84",
    "switch-to-ready-callback.wast": "5eef918faedae04b9ffdd8698f649bb41f8fb58637fe7e1423b354616718509a",
    "sync-barges-in.wast": "11c3e1046c8b01259fd2e6b1057677d9add26701857fdbb5e4d304f57eb94509",
    "sync-streams.wast": "bcf37448f4495e986adbd17915060ed6b7cce7e5c0fa11b8c3a4cce2b08919e1",
    "trap-if-block-and-sync.wast": "0f53f570bbb8e8d8c6d47cb0ad71ce702d691cae945c56b4c4fcb0c779945c4d",
    "trap-if-done.wast": "fdafc2fc7f90698f6a4cc5e5fca67a247963f964787879d9deb645d95e878a82",
    "trap-if-sync-and-waitable-set.wast": "c86d28eb001b4aecabab9a054e0d3b9a275d3c08ef982d7c85d389dde9cbd399",
    "trap-if-transfer-in-waitable-set.wast": "71cb99c7f7b6dd6533bc3fc744392f495c78814eae27e7d72ee9431c8e299460",
    "validate-no-async-abi-for-sync-type.wast": "ac454e9b7685b2b22b29be1f3b8b5d4c5d38e3378ebe1b49a88d0bdad0ebb55b",
    "validate-no-stream-char.wast": "5767951700e4e823da091bc82bdaa3cf99ded92b279b0ddd0352dddf4c545bec",
    "wait-during-callback.wast": "8231ba4aac41de37aed764c6fff78b610b05d1fbfcf7c0da3ccc01cc8d926079",
    "zero-length.wast": "aecbf367aa80cc35393d2545129ab7b20793a6f47c06a404a1a4fa6f0719009a",
}

[
    depot.http_file(
        name = "component-model/" + name,
        sha256 = sha256,
        urls = ["https://raw.githubusercontent.com/WebAssembly/component-model/{}/test/async/{}".format(
            COMPONENT_MODEL_COMMIT,
            name,
        )],
        visibility = [],
    )
    for name, sha256 in COMPONENT_MODEL_ASYNC_TESTS.items()
]

depot.genrule(
    name = "component-model-async-tests",
    srcs = [":component-model/" + name for name in COMPONENT_MODEL_ASYNC_TESTS],
    out = "async",
    cmd = "mkdir -p $OUT && cp $SRCS $OUT/",
    visibility = [],
)

# The component model's async conformance tests, each script linked
# against generated drivers and run in WABT's interpreter.
depot.rust_test(
    name = "conformance-tests",
    srcs = ["src/tests/conformance.rs"],
    crate_root = "src/tests/conformance.rs",
    env = {
        "COMPONENT_MODEL_ASYNC_TESTS": "$(location :component-model-async-tests)",
        "WASM_INTERP": "$(exe_target third-party//by-name/wa/wabt:wasm-interp)",
    },
    visibility = [],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:wasm-encoder",
        "third-party//rust:wasmparser",
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
    "async_client",
    "async_server",
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
    "gc_consumer",
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
    "async": [
        "async_server",
        "async_client",
    ],
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

# A consumer whose state lives on the GC heap (the shape of a gameplayc
# module) linked through the command line as well: the module carries a
# recursive type group, which the linker must count as several types. It is
# kept out of the fuzz seeds, whose consumers compile for linear memory.
depot.genrule(
    name = "linked-gc.wasm",
    out = "linked-gc.wasm",
    cmd = "$(exe :wlink) link -o $OUT $(location :scalar_producer.wat) $(location :gc_consumer.wat)",
    visibility = ["PUBLIC"],
)

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

# The async host ABI through wasm2c: async imports the host resolves later
# or at once, async exports whose results come back through the host's
# `wlink:task-return` imports, a synchronous wait that asks the host to
# finish its work, and cancellation both ways.
depot.export_file(
    name = "host_async.wat",
    src = "tests/host_async.wat",
    visibility = [],
)

depot.genrule(
    name = "linked-host-async.wasm",
    out = "linked-host-async.wasm",
    cmd = "$(exe :wlink) link -o $OUT $(location :host_async.wat)",
    visibility = ["PUBLIC"],
)

depot.genrule(
    name = "host-async-c",
    outs = {
        "c": ["host_async.c"],
        "h": ["host_async.h"],
    },
    cmd = "$(exe third-party//by-name/wa/wabt:wasm2c) $(location :linked-host-async.wasm) -n host_async -o $OUT/host_async.c",
    default_outs = ["host_async.c"],
    visibility = [],
)

depot.cxx_binary(
    name = "host-async",
    srcs = [
        "tests/async_host.c",
        ":host-async-c[c]",
    ],
    header_namespace = "",
    headers = {"host_async.h": ":host-async-c[h]"},
    linker_flags = ["-lm"],
    visibility = [],
    deps = ["third-party//by-name/wa/wabt:wasm-rt"],
)

depot.command_test(
    name = "run-host-async",
    cmd = ["$(exe :host-async)"],
)

# Streams and futures across the host's edge through wasm2c: ends the host
# makes and hands in, ends it is handed, its copies to and from its own
# memory with events for those that wait, and blocking copies that ask it
# to do its part.
depot.export_file(
    name = "host_streams.wat",
    src = "tests/host_streams.wat",
    visibility = [],
)

depot.genrule(
    name = "linked-host-streams.wasm",
    out = "linked-host-streams.wasm",
    cmd = "$(exe :wlink) link -o $OUT $(location :host_streams.wat)",
    visibility = ["PUBLIC"],
)

depot.genrule(
    name = "host-streams-c",
    outs = {
        "c": ["host_streams.c"],
        "h": ["host_streams.h"],
    },
    cmd = "$(exe third-party//by-name/wa/wabt:wasm2c) $(location :linked-host-streams.wasm) -n host_streams -o $OUT/host_streams.c",
    default_outs = ["host_streams.c"],
    visibility = [],
)

depot.cxx_binary(
    name = "host-streams",
    srcs = [
        "tests/streams_host.c",
        ":host-streams-c[c]",
    ],
    header_namespace = "",
    headers = {"host_streams.h": ":host-streams-c[h]"},
    linker_flags = ["-lm"],
    visibility = [],
    deps = ["third-party//by-name/wa/wabt:wasm-rt"],
)

depot.command_test(
    name = "run-host-streams",
    cmd = ["$(exe :host-streams)"],
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
    "async-concurrent": ("async", "run-concurrent", "i32:3"),
    "async-counter": ("async", "run-counter", "i32:7"),
    "async-sum": ("async", "run-sum", "i32:10"),
    "async-token": ("async", "run-token", "i32:55"),
    "async-upper": ("async", "run-upper", "i32:1"),
    "async-words": ("async", "run-words", "i32:6"),
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
