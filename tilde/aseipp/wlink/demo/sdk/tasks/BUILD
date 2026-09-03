# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/wlink/demo/sdk:defs.bzl", "C_FLAGS", "NATIVE", "WASM", "console_headless", "console_host", "console_link", "console_task_component")

depot.export_file(
    name = "contract.expected",
    src = "contract.expected",
)

# What a C component of the async worlds links instead of the SDK's libc.
depot.cxx_library(
    name = "support",
    srcs = ["support.c"],
    compiler_flags = C_FLAGS,
    exported_headers = {
        "stdlib.h": "include/stdlib.h",
        "string.h": "include/string.h",
    },
    header_namespace = "",
    preferred_linkage = "static",
    target_compatible_with = WASM,
    visibility = ["PUBLIC"],
)

console_task_component(
    name = "scheduler",
    srcs = ["scheduler_component.c"],
    world = "scheduler",
)

console_task_component(
    name = "launcher",
    srcs = ["launcher_component.c"],
    world = "launcher",
)

# The contract of `console:sdk/tasks`, checked by an async game from the
# inside and run by the native runner and the web core alike.
console_task_component(
    name = "contract",
    srcs = ["contract_test.c"],
)

console_link(
    name = "contract-linked",
    game = ":contract.wasm",
    tasks = True,
)

console_host(
    name = "contract-host",
    srcs = ["//aseipp/wlink/demo/sdk:host-smoke.c"],
    linked = ":contract-linked",
)

console_headless(
    name = "contract-headless",
    linked = ":contract-linked",
)

# The schedule the contract logs is the same under both runners, frame for
# frame, and is `contract.expected`: the waits wake in the frames the
# interface promises, and the load arrives whole, a read's worth a frame.
# The game ends one frame after `run` returns, as the launcher sees it. A
# `run` that returns at once ends the game before its first frame, and a
# broken canonical ABI traps with the runtime's reason in both.
depot.command_test(
    name = "test-contract",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/console-tasks-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :contract-host) --headless --frames 20 --trace >"$out/native"
$(exe :contract-headless) --headless --frames 20 --trace >"$out/web"
diff "$out/native" "$out/web"
grep '^log ' "$out/native" | diff $(location :contract.expected) -
grep -q '^summary frames=13 presents=12 .* exit=0$' "$out/native"

$(exe :contract-host) --headless --frames 5 -- --quick >"$out/native-quick"
$(exe :contract-headless) --headless --frames 5 -- --quick >"$out/web-quick"
diff "$out/native-quick" "$out/web-quick"
grep -q '^log 1: game: tasks: run returns at once$' "$out/native-quick"
grep -q '^summary frames=1 presents=0 .* exit=0$' "$out/native-quick"

set +e
$(exe :contract-host) --headless --frames 5 -- --misuse >"$out/native-misuse" 2>&1
native=$?
$(exe :contract-headless) --headless --frames 5 -- --misuse >"$out/web-misuse" 2>&1
web=$?
set -e
test "$native" -eq 1
test "$web" -eq 1
grep -q '^async runtime trap 8$' "$out/native-misuse"
grep -q 'async runtime trap 8' "$out/web-misuse"
""",
    ],
    compatible_with = NATIVE,
)
