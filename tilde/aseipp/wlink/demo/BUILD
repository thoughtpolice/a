# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/wlink/demo/sdk:defs.bzl", "LIBM", "LTO_COMPILER_FLAGS", "LTO_LINKER_FLAGS", "NATIVE", "console_application", "console_c_component", "console_host", "console_link", "console_rust_component")

# Keep the original example labels stable for linker consumers and scripts.
[
    depot.alias(
        name = name,
        actual = "//aseipp/wlink/demo/sdk:" + name,
        visibility = ["PUBLIC"],
    )
    for name in [
        "sdk.wit",
        "hal.wit",
        "platform.wasm",
        "platform-core.wasm",
    ]
]

console_rust_component(
    name = "game",
    src = "game/src/main.rs",
)

console_link(
    name = "linked",
    game = ":game.wasm",
)

depot.cxx_binary(
    name = "host",
    srcs = [
        "host/main.c",
        ":linked-c[c]",
    ],
    compiler_flags = LTO_COMPILER_FLAGS,
    header_namespace = "",
    headers = {
        "linked.h": ":linked-c[h]",
        "linked-impl.h": ":linked-c[impl]",
        "hal-host.h": ":linked-c[hal]",
    },
    linker_flags = LTO_LINKER_FLAGS,
    post_linker_flags = LIBM,
    visibility = ["PUBLIC"],
    deps = ["third-party//by-name/wa/wabt:wasm-rt"],
)

console_c_component(
    name = "sdk-contract",
    srcs = ["//aseipp/wlink/demo/sdk:contract_test.c"],
    initial_memory = 2097152,
)

console_link(
    name = "sdk-contract-linked",
    game = ":sdk-contract.wasm",
)

console_host(
    name = "sdk-host-smoke",
    srcs = ["//aseipp/wlink/demo/sdk:host-smoke.c"],
    linked = ":sdk-contract-linked",
)

depot.command_test(
    name = "test-sdk-host-no-assets",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
set +e
$(exe :sdk-host-smoke) --headless --frames 1 -- --exit-7
status=$?
set -e
test "$status" -eq 7
set +e
$(exe :sdk-host-smoke) --headless --frames 1 -- --trap
status=$?
set -e
test "$status" -eq 1
""",
    ],
    compatible_with = NATIVE,
)

# The SDK owns terminal and stream unit coverage; retain these public aliases.
[
    depot.alias(
        name = name,
        actual = "//aseipp/wlink/demo/sdk:" + actual,
    )
    for name, actual in [
        ("terminal-tests", "terminal-tests"),
        ("test-terminal", "test-terminal"),
        ("test-terminal-pty", "test-terminal-pty"),
        ("file-io-tests", "stream-tests"),
        ("test-file-io", "test-stream"),
        ("sdk-terminal-pty-script", "terminal-pty-script"),
    ]
]

depot.command_test(
    name = "test-host",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/wlink-demo-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :host) >"$out/log"
grep -q 'log 1: game: init' "$out/log"
grep -q 'log 1: game: frame 1 at (104, 80)' "$out/log"
test `grep -c 'present 320 240 bytes=307200' "$out/log"` -eq 3
grep -q 'log 1: game: frame 3 at (108, 80)' "$out/log"
grep -q 'game over after 3 frames' "$out/log"
""",
    ],
)

# The linked package is plain core wasm: a toolchain that knows nothing about
# components must accept it unchanged, and nothing but the HAL may remain
# imported once the SDK has been linked in.
depot.command_test(
    name = "test-linked-is-core-wasm",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/wlink-demo-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe third-party//by-name/wa/wabt:wasm-validate) --enable-all $(location :linked.wasm)
$(exe tilde//aseipp/wlink:wlink) print $(location :linked.wasm) >"$out/wat"
if grep '(import "' "$out/wat" | grep -v '"console:hal/raw@0.1.0"'; then
    echo "linked module imports more than the HAL" >&2
    exit 1
fi
grep -q '(export "init"' "$out/wat"
grep -q '(export "frame"' "$out/wat"
""",
    ],
)

depot.alias(
    name = "luau",
    actual = "//aseipp/wlink/demo/luau:luau",
    visibility = ["PUBLIC"],
)

depot.export_file(
    name = "parity-test.py",
    src = "host/parity_test.py",
    visibility = ["//aseipp/wlink/demo/..."],
)
