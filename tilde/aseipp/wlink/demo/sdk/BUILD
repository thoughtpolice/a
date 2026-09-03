# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load(":defs.bzl", "C_FLAGS", "NATIVE", "WASM", "console_rust_component")

[
    depot.export_file(
        name = name,
        src = src,
        visibility = ["PUBLIC"],
    )
    for name, src in {
        "sdk.wit": "wit/sdk.wit",
        "hal.wit": "wit/hal.wit",
        "runtime.rs": "runtime.rs",
        "rust_runtime.rs": "rust_runtime.rs",
        "contract_test.c": "contract_test.c",
        "host.c": "host/host.c",
        "host-smoke.c": "host/smoke.c",
        "host_bindings.py": "host_bindings.py",
        "host_bindings_test.py": "host_bindings_test.py",
        "terminal-pty-script": "host/terminal_pty_test.py",
    }.items()
]

console_rust_component(
    name = "platform",
    src = "platform.rs",
    modules = {"font.rs": "font.rs"},
    world = "platform",
)

# The same generated declarations and key constants are available to native
# hosts and freestanding C guests; only the guest links the import wrappers.
depot.cxx_library(
    name = "headers",
    exported_headers = {
        "console.h": "console.h",
        "runtime.h": "runtime.h",
        "stream.h": "stream.h",
        "game.h": "//aseipp/wlink/demo/sdk/bindings:game-c[h]",
        "platform.h": "//aseipp/wlink/demo/sdk/bindings:platform-c[h]",
        "host.h": "host/host.h",
        "terminal.h": "host/terminal.h",
    },
    header_namespace = "",
    visibility = ["PUBLIC"],
)

depot.cxx_library(
    name = "c",
    srcs = [
        "component.c",
        "console.c",
        "stream.c",
        "//aseipp/wlink/demo/sdk/bindings:game-c[c]",
    ],
    compiler_flags = C_FLAGS,
    exported_deps = [
        ":headers",
        "//aseipp/wlink/demo/sdk/libc",
    ],
    header_namespace = "",
    preferred_linkage = "static",
    target_compatible_with = WASM,
    visibility = ["PUBLIC"],
)

depot.cxx_library(
    name = "terminal",
    srcs = ["host/terminal.c"],
    compatible_with = NATIVE,
    exported_deps = [":headers"],
    preferred_linkage = "static",
    visibility = ["PUBLIC"],
)

depot.cxx_binary(
    name = "terminal-tests",
    srcs = ["host/terminal_test.c"],
    compatible_with = NATIVE,
    visibility = ["PUBLIC"],
    deps = [":terminal"],
)

depot.command_test(
    name = "test-terminal",
    cmd = ["$(exe :terminal-tests)"],
    compatible_with = NATIVE,
    visibility = ["PUBLIC"],
)

depot.command_test(
    name = "test-terminal-pty",
    cmd = [
        "python3",
        "$(location :terminal-pty-script)",
        "$(exe :terminal-tests)",
    ],
    compatible_with = NATIVE,
    visibility = ["PUBLIC"],
)

depot.cxx_binary(
    name = "stream-tests",
    srcs = [
        "stream.c",
        "stream_test.c",
    ],
    visibility = ["PUBLIC"],
    deps = [":headers"],
)

depot.command_test(
    name = "test-stream",
    cmd = ["$(exe :stream-tests)"],
    visibility = ["PUBLIC"],
)

depot.command_test(
    name = "test-host-bindings",
    cmd = [
        "python3",
        "$(location :host_bindings_test.py)",
        "$(location :host_bindings.py)",
    ],
)
