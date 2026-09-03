# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/wlink/demo/sdk:defs.bzl", "CXX_FLAGS", "NATIVE", "WASM", "console_application", "console_web")

# The C++ library a freestanding wasm32 guest gets. Nothing here comes from
# the host's: a standard library is configured for the machine it was built
# for, and the one on the machine doing the building is not the console.
HEADERS = [
    "__cxx_support",
    "algorithm",
    "climits",
    "cmath",
    "cstddef",
    "cstdint",
    "cstdio",
    "cstdlib",
    "cstring",
    "cwchar",
    "exception",
    "initializer_list",
    "limits",
    "new",
    "optional",
    "stdexcept",
    "string",
    "string_view",
    "tuple",
    "type_traits",
    "typeinfo",
    "unordered_set",
    "utility",
    "vector",
]

depot.cxx_library(
    name = "libcxx",
    srcs = [
        "src/exceptions.cpp",
        "src/support.cpp",
    ],
    compiler_flags = CXX_FLAGS,
    exported_deps = [
        "//aseipp/wlink/demo/sdk:headers",
        "//aseipp/wlink/demo/sdk/libc",
    ],
    # The standard spells these without a file extension; the files on disk
    # keep one, and the map gives each the name a guest includes it by.
    exported_headers = {header: "include/" + header + ".h" for header in HEADERS},
    header_namespace = "",
    preferred_linkage = "static",
    target_compatible_with = WASM,
    visibility = ["PUBLIC"],
)

# The containers as a guest uses them, run under the native runner: the same
# code the console will link, on the allocator it will really have.
console_application(
    name = "libcxx-test",
    srcs = ["test/guest_test.cpp"],
    compiler_flags = [
        "-fno-exceptions",
        "-fno-rtti",
    ],
    host_srcs = ["//aseipp/wlink/demo/sdk:host-smoke.c"],
    deps = [":libcxx"],
)

# Exceptions as a guest throws them, which is the one part of the runtime the
# compiler cannot supply for itself.
console_application(
    name = "exception-test",
    srcs = ["test/exception_test.cpp"],
    compiler_flags = [
        "-fwasm-exceptions",
        "-fno-rtti",
    ],
    host_srcs = ["//aseipp/wlink/demo/sdk:host-smoke.c"],
    deps = [":libcxx"],
)

# The same guest in a browser. Throwing is a WebAssembly instruction here, so
# the two hosts have to agree about it and not only about what the C++ meant.
console_web(
    name = "exception-test",
    linked = ":exception-test-linked",
    title = "C++ exceptions",
)

depot.command_test(
    name = "test-exceptions-web",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/console-libcxx-exceptions-web-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :exception-test-web-headless) --headless --frames 1 >"$out/log"
grep -q 'PASS libcxx throw' "$out/log"
grep -q 'PASS libcxx hierarchy' "$out/log"
grep -q 'PASS libcxx unwinding' "$out/log"
grep -q 'PASS libcxx rethrow' "$out/log"
grep -q 'PASS libcxx nesting' "$out/log"
grep -q 'PASS libcxx exceptions' "$out/log"
""",
    ],
    target_compatible_with = ["config//os:linux"],
)

depot.command_test(
    name = "test-exceptions",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/console-libcxx-exceptions-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :exception-test-host) --headless --frames 1 >"$out/log"
grep -q 'log 1: game: PASS libcxx throw' "$out/log"
grep -q 'log 1: game: PASS libcxx hierarchy' "$out/log"
grep -q 'log 1: game: PASS libcxx unwinding' "$out/log"
grep -q 'log 1: game: PASS libcxx rethrow' "$out/log"
grep -q 'log 1: game: PASS libcxx nesting' "$out/log"
grep -q 'log 1: game: PASS libcxx exceptions' "$out/log"
""",
    ],
    compatible_with = NATIVE,
)

depot.command_test(
    name = "test-guest",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/console-libcxx-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :libcxx-test-host) --headless --frames 1 >"$out/log"
grep -q 'log 1: game: PASS libcxx vector' "$out/log"
grep -q 'log 1: game: PASS libcxx string' "$out/log"
grep -q 'log 1: game: PASS libcxx unordered_set' "$out/log"
grep -q 'log 1: game: PASS libcxx interop' "$out/log"
grep -q 'log 1: game: PASS libcxx all' "$out/log"
""",
    ],
    compatible_with = NATIVE,
)
