# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/fozzie:defs.bzl", "cxx_fuzz_binary")

# framelog, a record log with checksummed frames. See README.md.

depot.cxx_library(
    name = "crc32",
    srcs = ["crc32.c"],
    deps = ["toolchains//lean:headers"],
)

depot.lean.library(
    name = "framelog-lib",
    srcs = [
        "Framelog.lean",
        "Framelog/Crc32.lean",
        "Framelog/Crc32Check.lean",
        "Framelog/Frame.lean",
        "Framelog/Varint.lean",
    ],
    options = {"autoImplicit": False},
    package = "framelog",
    precompile = True,
    visibility = ["PUBLIC"],
    warnings_as_errors = True,
    deps = [":crc32"],
)

depot.lean.binary(
    name = "framelog",
    srcs = ["Main.lean"],
    warnings_as_errors = True,
    deps = [":framelog-lib"],
)

depot.lean.test(
    name = "golden",
    srcs = ["Golden.lean"],
    options = {"autoImplicit": False},
    warnings_as_errors = True,
    deps = [":framelog-lib"],
)

# The program end to end. Pack a log, read it back, damage it, recover.
# Backticks because `$(` is buck2's own macro syntax here.
depot.command_test(
    name = "cli",
    script = """
        bin="$(exe :framelog)"
        tmp="`mktemp -d`"
        trap 'rm -rf "$tmp"' EXIT
        printf 'begin 7\\nput account/alice 100\\nput account/bob 250\\ncommit 7\\n' > "$tmp/records"
        "$bin" pack "$tmp/records" "$tmp/log"
        "$bin" unpack "$tmp/log" > "$tmp/out"
        cmp "$tmp/records" "$tmp/out"

        # One flipped byte in the third record.
        cp "$tmp/log" "$tmp/damaged"
        printf 'X' | dd of="$tmp/damaged" bs=1 seek=40 conv=notrunc 2>/dev/null
        if "$bin" unpack "$tmp/damaged" > /dev/null 2>&1; then
            echo "damage went unnoticed" >&2
            exit 1
        fi
        "$bin" recover "$tmp/damaged" "$tmp/recovered"
        [ "`"$bin" unpack "$tmp/recovered" | wc -l`" -eq 2 ]
    """,
)

depot.cxx_binary(
    name = "client",
    srcs = ["client.cpp"],
    deps = [":framelog-lib"],
)

depot.run_test(
    name = "client-test",
    dep = ":client",
)

# A valid log for the fuzzer to start from, written by the program.
depot.genrule(
    name = "seed-log",
    out = "seed.log",
    cmd = "printf 'begin 7\\\\nput k v\\\\ncommit 7\\\\n' > $TMP/records && $(exe :framelog) pack $TMP/records $OUT",
)

[
    cxx_fuzz_binary(
        name = name,
        srcs = ["fuzz.cpp"],
        corpus = [":seed-log"],
        duration_seconds = 0,
        jobs = 1,
        # The codec works on lists; short inputs keep each run quick.
        max_input = 512,
        runs = 2000,
        sanitizer = sanitizer,
        deps = [":framelog-lib"],
    )
    for name, sanitizer in [
        ("fuzz", "none"),
        ("fuzz-asan", "address"),
    ]
]
