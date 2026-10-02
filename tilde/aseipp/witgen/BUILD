# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:anyhow",
    "third-party//rust:wit-bindgen-core",
    "third-party//rust:wit-parser",
]

LIB_SRCS = glob(
    ["src/**/*.rs"],
    exclude = ["src/main.rs"],
)

depot.rust_library(
    name = "witgen-lib",
    srcs = LIB_SRCS,
    crate = "witgen",
    crate_root = "src/lib.rs",
    tests = [":witgen-tests"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_binary(
    name = "witgen",
    srcs = ["src/main.rs"],
    crate_root = "src/main.rs",
    visibility = ["PUBLIC"],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:anyhow",
        "third-party//rust:clap",
        "third-party//rust:wit-bindgen-c",
        "third-party//rust:wit-bindgen-core",
        "third-party//rust:wit-bindgen-rust",
        ":witgen-lib",
    ],
)

depot.rust_test(
    name = "witgen-tests",
    srcs = LIB_SRCS + ["tests/host.wit"],
    crate = "witgen",
    crate_root = "src/lib.rs",
    deps = ["third-party//by-name/mi/mimalloc:rust"] + DEPS,
)

depot.export_file(
    name = "host.wit",
    src = "tests/host.wit",
)

# The host bindings of tests/host.wit in each language, run against a guest
# memory of the test's own: the Rust ones compiled into a test, the C ones
# into a test over wasm2c's runtime, the TypeScript ones checked and run
# with Deno.
[
    depot.genrule(
        name = "host-" + lang,
        out = out,
        cmd = "$(exe :witgen) host $(location :host.wit) --lang " + lang + " --strict -o $OUT",
    )
    for lang, out in [
        ("c", "host.h"),
        ("rust", "host.rs"),
    ]
]

# The guest generators, wit-bindgen's own, over the same fixture: the files
# each writes, which the console SDK's guests compile.
depot.command_test(
    name = "guest-test",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/witgen-guest-$$"
trap 'rm -rf "$out"' EXIT
$(exe :witgen) c $(location :host.wit) --no-object-file --out-dir "$out/c"
test -s "$out/c/host_test.h" && test -s "$out/c/host_test.c"
grep -q 'test_host_things_scalars' "$out/c/host_test.h"
$(exe :witgen) rust $(location :host.wit) --generate-all --out-dir "$out/rust"
test -s "$out/rust/host_test.rs"
grep -q 'pub fn scalars' "$out/rust/host_test.rs"
""",
    ],
)

# Deno resolves `./host.ts` beside the test, so the two share a directory.
depot.genrule(
    name = "ts-host-test-files",
    srcs = ["tests/ts_host_test.ts"],
    outs = {
        "host": ["host.ts"],
        "test": ["ts_host_test.ts"],
    },
    cmd = "$(exe :witgen) host $(location :host.wit) --lang ts --strict -o $OUT/host.ts && " +
          "cp $SRCS $OUT/ts_host_test.ts",
)

# The TypeScript is checked in beside a host's sources, which `deno fmt`
# keeps formatted: the bindings must already be.
depot.deno.fmt_check(
    name = "ts-host-fmt",
    srcs = [":ts-host-test-files[host]"],
)

depot.deno.test(
    name = "ts-host-test",
    srcs = [":ts-host-test-files[test]"],
    data = [":ts-host-test-files[host]"],
)

depot.cxx_library(
    name = "host-c-header",
    exported_headers = {"host.h": ":host-c"},
    header_namespace = "",
)

# Warnings are errors: the bindings compile cleanly into any host.
depot.cxx_binary(
    name = "c-host-test-bin",
    srcs = ["tests/c_host_test.c"],
    compiler_flags = [
        "-Wall",
        "-Wextra",
        "-Werror",
    ],
    deps = [
        "third-party//by-name/wa/wabt:wasm-rt",
        ":host-c-header",
    ],
)

depot.command_test(
    name = "c-host-test",
    cmd = ["$(exe :c-host-test-bin)"],
)

depot.rust_test(
    name = "rust-host-test",
    srcs = ["tests/rust_host.rs"],
    crate_root = "tests/rust_host.rs",
    mapped_srcs = {":host-rust": "tests/host.rs"},
    deps = ["third-party//by-name/mi/mimalloc:rust"],
)
