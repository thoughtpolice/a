# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/wlink/demo/sdk:defs.bzl", "LIBM", "LTO_COMPILER_FLAGS", "LTO_LINKER_FLAGS", "NATIVE", "console_application", "console_host", "console_link", "console_rust_component", "console_web")

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

[
    console_application(
        name = name,
        srcs = ["//aseipp/wlink/demo/doom:shim.c"],
        compiler_flags = ["-DDOOM_TEST"] if name == "doom-test" else [],
        headers = {"PureDOOM.h": "//aseipp/wlink/demo/doom:PureDOOM.h"},
        host_srcs = ["//aseipp/wlink/demo/doom:host.c"],
    )
    for name in [
        "doom",
        "doom-test",
    ]
]

console_application(
    name = "sdk-contract",
    srcs = ["//aseipp/wlink/demo/sdk:contract_test.c"],
    host_srcs = ["//aseipp/wlink/demo/doom:host.c"],
    initial_memory = 2097152,
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

WAD = "//aseipp/wlink/demo/doom:freedoom[freedoom2.wad]"

# The same applications, packaged for a browser: `buck2 build :doom-web
# --show-output` names a directory to serve, `buck2 run :doom-web-serve` serves
# it, and `:doom-web-headless` replays it the way the native runner does.
console_web(
    name = "game",
    linked = ":linked",
    title = "Rectangle",
)

console_web(
    name = "doom",
    frames_per_second = 35,
    linked = ":doom-linked",
    mounts = {"doom2.wad": WAD},
    option = "iwad",
    title = "Doom",
)

console_web(
    name = "sdk-contract",
    frames_per_second = 35,
    linked = ":sdk-contract-linked",
    mounts = {"doom2.wad": WAD},
    option = "iwad",
    title = "SDK contract",
)

depot.command(
    name = "doom",
    cmd = [
        "$(exe :doom-host)",
        "--iwad",
        "$(location //aseipp/wlink/demo/doom:freedoom[freedoom2.wad])",
    ],
    visibility = ["PUBLIC"],
)

depot.alias(
    name = "quake2",
    actual = "//aseipp/wlink/demo/quake2:quake2",
    visibility = ["PUBLIC"],
)

depot.command_test(
    name = "test-doom-e2e",
    cmd = [
        "python3",
        "$(location :e2e-test.py)",
        "doom",
        "$(exe :doom-test-host)",
        "$(exe :doom-host)",
        "$(location //aseipp/wlink/demo/doom:freedoom[freedoom2.wad])",
    ],
    target_compatible_with = ["config//os:linux"],
)

depot.command_test(
    name = "test-sdk-contract",
    cmd = [
        "python3",
        "$(location :e2e-test.py)",
        "sdk",
        "$(exe :sdk-contract-host)",
        "$(location //aseipp/wlink/demo/doom:freedoom[freedoom2.wad])",
    ],
    target_compatible_with = ["config//os:linux"],
)

depot.export_file(
    name = "e2e-test.py",
    src = "host/e2e_test.py",
    visibility = [],
)

depot.export_file(
    name = "parity-test.py",
    src = "host/parity_test.py",
    visibility = ["//aseipp/wlink/demo/..."],
)

# The browser host through the same suites, with the same assertions: the
# runner is several words, which the suites shlex-split.
depot.command_test(
    name = "test-sdk-contract-web",
    cmd = [
        "python3",
        "$(location :e2e-test.py)",
        "sdk-web",
        "$(exe :sdk-contract-web-headless)",
        "$(location " + WAD + ")",
    ],
)

depot.command_test(
    name = "test-doom-e2e-web",
    cmd = [
        "python3",
        "$(location :e2e-test.py)",
        "doom",
        "$(exe :doom-web-headless) --module $(location :doom-test-linked-opt.wasm)",
        "$(exe :doom-web-headless)",
        "$(location " + WAD + ")",
    ],
)

# Two hosts over one module: every traced frame and the summary must agree.
[
    depot.command_test(
        name = "test-" + application + "-web-parity",
        cmd = [
            "python3",
            "$(location :parity-test.py)",
            mode,
            "$(exe :" + application + "-host)",
            "$(exe :" + application + "-web-headless)",
            "$(location " + WAD + ")",
        ],
        target_compatible_with = ["config//os:linux"],
    )
    for application, mode in [
        ("doom", "doom"),
        ("sdk-contract", "sdk"),
    ]
]

depot.command_test(
    name = "test-doom-imports",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/wlink-doom-imports-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe third-party//by-name/wa/wabt:wasm-validate) --enable-all $(location :doom-linked.wasm)
$(exe tilde//aseipp/wlink:wlink) print $(location :doom-core.wasm) >"$out/game.wat"
$(exe tilde//aseipp/wlink:wlink) print $(location :doom-linked.wasm) >"$out/linked.wat"
if grep '(import "' "$out/game.wat" | grep -v '"console:sdk/'; then
    echo "game imports services outside the SDK" >&2
    exit 1
fi
if grep '(import "' "$out/linked.wat" | grep -v '"console:hal/raw@0.1.0"'; then
    echo "linked module imports services outside the HAL" >&2
    exit 1
fi
grep -q '(export "init"' "$out/linked.wat"
grep -q '(export "frame"' "$out/linked.wat"
""",
    ],
)

depot.command_test(
    name = "test-app-pty",
    cmd = [
        "python3",
        "$(location :app-pty-script)",
        "$(exe :doom-host)",
        "$(exe :sdk-contract-host)",
        "$(location //aseipp/wlink/demo/doom:freedoom[freedoom2.wad])",
        "$(location :sdk-terminal-pty-script)",
    ],
    target_compatible_with = ["config//os:linux"],
)

depot.export_file(
    name = "app-pty-script",
    src = "host/app_pty_test.py",
)
