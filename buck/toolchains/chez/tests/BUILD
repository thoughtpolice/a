# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# The toolchain, end to end: libraries in two targets (one using the other's
# macro), a program, a boot file, a standalone executable.

load("@root//buck/shims:shims.bzl", "shims")
load("//chez:defs.bzl", "chez")

chez.library(
    name = "greet",
    srcs = glob(["greet/**/*.sls"]),
    prefix = "demo",
    strip_prefix = "greet",
)

chez.library(
    name = "shout",
    srcs = ["shout/shout.sls"],
    prefix = "demo",
    strip_prefix = "shout",
    deps = [":greet"],
)

chez.program(
    name = "main",
    src = "main.ss",
    deps = [":shout"],
)

chez.boot(
    name = "demo",
    requires = ["petite"],
    deps = [":main"],
)

shims.cxx_binary(
    name = "kernel",
    srcs = ["kernel.c"],
    deps = [
        "//chez:embed",
        "//chez:kernel",
    ],
)

chez.standalone(
    name = "demo-bin",
    boots = [":demo"],
    kernel = ":kernel",
    runtime = "petite",
)

# The same, on the host's dynamic linker and libraries.
chez.standalone(
    name = "demo-host",
    boots = [":demo"],
    host = True,
    kernel = ":kernel",
    runtime = "petite",
)

shims.command_test(
    name = "test-standalone",
    script = """
        out=`$(exe :demo-bin) a b`
        echo "$out"
        test "$out" = 'HELLO, CHEZ HELLO, CHEZ ("a" "b")'
        # The boot file loads (demo greet name), (demo greet), (demo shout),
        # each after what it imports.
        test "`cat $(location :greet[manifest])`" = '(((demo greet name) "demo/greet/name.so") ((demo greet) "demo/greet.so"))'
    """,
)

# What makes it the host's: its interpreter, and no search path of the
# toolchain's. It is not run, since the host may have an older C library
# than the toolchain's. The boot files are appended after patching, so the
# trailer is still at the end.
shims.command_test(
    name = "test-standalone-host",
    script = """
        exe=$(location :demo-host)
        readelf -l $exe | grep -q 'interpreter: /lib'
        if readelf -d $exe | grep -q 'RUNPATH\\|RPATH'; then
            echo "$exe still has a search path" >&2
            exit 1
        fi
        test "`tail -c 8 $exe`" = CHEZBOOT
    """,
    target_compatible_with = ["config//os:linux"],
)
