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

shims.export_file(
    name = "test-standalone.ss",
    visibility = [],
)

shims.command_test(
    name = "test-standalone",
    cmd = [
        "$(location third-party//by-name/ch/chez-scheme:install[scheme])",
        "-q",
        "--script",
        "$(location :test-standalone.ss)",
        "$(location :demo-bin)",
        "$(location :greet[manifest])",
    ],
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
