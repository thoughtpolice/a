# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/wlink/demo/sdk:defs.bzl", "C_FLAGS", "LIBM", "NATIVE", "WASM", "console_application")

# The hosted C headers a ported engine expects, for freestanding wasm32
# guests. The compiler's own stddef, stdint, stdarg, stdbool, limits, and
# float headers are self-contained in freestanding mode and are not shadowed.
HEADERS = [
    "assert.h",
    "ctype.h",
    "errno.h",
    "math.h",
    "setjmp.h",
    "stdio.h",
    "stdlib.h",
    "string.h",
    "strings.h",
    "time.h",
]

# Formatting and parsing are portable C, kept apart so the native tests can
# check them against the host's own C library.
PORTABLE_SOURCES = [
    "src/bigint.c",
    "src/format.c",
    "src/qsort.c",
    "src/scan.c",
    "src/strtod.c",
    "src/strtol.c",
]

MATH_FUNCTIONS = [
    "acos",
    "asin",
    "atan",
    "atan2",
    "cbrt",
    "cos",
    "cosh",
    "exp",
    "expm1",
    "fmod",
    "frexp",
    "hypot",
    "ldexp",
    "log",
    "log10",
    "log2",
    "modf",
    "pow",
    "round",
    "scalbn",
    "sin",
    "sinh",
    "tan",
    "tanh",
]

depot.cxx_library(
    name = "libc",
    srcs = glob([
        "musl/*.c",
        "src/*.c",
    ]),
    compiler_flags = C_FLAGS,
    exported_headers = {header: "include/" + header for header in HEADERS},
    header_namespace = "",
    headers = glob([
        "musl/*.h",
        "src/*.h",
    ]),
    preferred_linkage = "static",
    target_compatible_with = WASM,
    visibility = ["PUBLIC"],
    deps = ["//aseipp/wlink/demo/sdk:headers"],
)

depot.cxx_library(
    name = "portable-native",
    srcs = PORTABLE_SOURCES,
    compiler_flags = ["-DCONSOLE_LIBC_NATIVE_TEST"],
    header_namespace = "",
    headers = glob(["src/*.h"]),
    preferred_linkage = "static",
)

depot.cxx_binary(
    name = "native-tests",
    srcs = ["test/native_test.c"],
    deps = [":portable-native"],
)

depot.command_test(
    name = "test-native",
    cmd = ["$(exe :native-tests)"],
)

# The forked musl routines under other names, so the test can hold them next
# to the host's libm. They see the SDK's math.h rather than the host's, whose
# declarations do not survive the renaming, and no fused multiply-adds, which
# wasm32 has no instruction for.
depot.cxx_library(
    name = "musl-native",
    srcs = glob(["musl/*.c"]),
    compiler_flags = [
        "-ffp-contract=off",
        "-fno-math-errno",
    ] + ["-D{}=console_musl_{}".format(name, name) for name in MATH_FUNCTIONS],
    header_namespace = "",
    headers = dict([("math.h", "include/math.h")] + [(header, header) for header in glob(["musl/*.h"])]),
    preferred_linkage = "static",
)

depot.cxx_binary(
    name = "math-tests",
    srcs = ["test/math_test.c"],
    post_linker_flags = LIBM,
    deps = [":musl-native"],
)

depot.command_test(
    name = "test-math",
    cmd = ["$(exe :math-tests)"],
)

# The parts bound to the SDK, streams, the log, the clock, and the process,
# run as a guest under the native runner.
console_application(
    name = "libc-test",
    srcs = ["test/guest_test.c"],
    host_srcs = ["//aseipp/wlink/demo/sdk:host-smoke.c"],
)

depot.command_test(
    name = "test-guest",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/console-libc-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :libc-test-host) --headless --frames 1 >"$out/log"
grep -q 'log 1: game: PASS libc stdout' "$out/log"
grep -q 'log 3: game: PASS libc stderr' "$out/log"
grep -q 'log 1: game: PASS libc jumps' "$out/log"
grep -q 'log 1: game: PASS libc flush' "$out/log"
grep -q 'log 1: game: PASS libc all' "$out/log"
""",
    ],
    compatible_with = NATIVE,
)
