# SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
# SPDX-License-Identifier: BSD-3-Clause

# An application framework of sorts for Chez Scheme, as a test of the
# package: a C kernel that boots the Scheme runtime and the application's
# boot file, a companion C library loaded at run time, whole-program
# compilation, profiling, coverage and profile-guided recompilation, and a
# test driver that runs N-Queens, the C bindings and native threads.

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "CHEZ", "chez_app")

APP = "hello"

VERSION = "20170101"

# Everything the Scheme code includes, and the scripts the test driver runs.
SCHEME_SRCS = [
    "src/c/_entry.ss",
    "src/ss/clib.ss",
    "src/ss/main.ss",
    "src/ss/nqueens.ss",
    "src/ss/remote-cafe.ss",
    "src/t/gold/basic001",
    "src/t/gold/basic002",
    "src/t/gold/basic003",
    "src/t/main.ss",
    "src/t/smoke/clib.ss",
    "src/t/smoke/nqueens.ss",
    "src/t/smoke/threads.ss",
]

shims.export_file(
    name = "build.ss",
)

# The C functions the Scheme code binds with foreign-procedure.
shims.cxx_library(
    name = "clib",
    srcs = [
        "src/c/hi.c",
        "src/c/version.c",
    ],
    preferred_linkage = "shared",
    preprocessor_flags = ['-DAPP_VERSION_STRING="{}"'.format(VERSION)],
    soname = "{}-clib-v{}.so".format(APP, VERSION),
)

# The Makefile's defaults, plus `make strip`: a stripped release on Petite.
chez_app(
    name = "hello",
    app = APP,
    clib = ":clib[shared]",
    opt = 2,
    scheme_srcs = SCHEME_SRCS,
    strip = True,
    version = VERSION,
)

# DEBUG=YES SCHEME_RUNTIME=chez: inspector information, a chatty kernel, and
# the compiler at run time.
chez_app(
    name = "hello-debug",
    app = APP,
    clib = ":clib[shared]",
    debug = True,
    runtime = "chez",
    scheme_srcs = SCHEME_SRCS,
    version = VERSION,
)

# `make test`: the test driver as the program, profiled for coverage. It
# boots the compiler as well, since PROFILE_DATA's profile-dump-data writes
# fasl data, and Petite has no fasl writer.
chez_app(
    name = "hello-test",
    app = APP,
    clib = ":clib[shared]",
    profile = True,
    runtime = "chez",
    scheme_srcs = SCHEME_SRCS,
    test_build = True,
    version = VERSION,
)

# REPROFILE=YES: the test driver again, compiled with the counts from a run
# of the profiled one.
shims.genrule(
    name = "hello-test.pd",
    out = APP + ".pd",
    cmd = """
        set -eu
        out=$PWD/$OUT
        cp -RL $(location :hello-test-tree)/. $TMP/run
        chmod -R u+w $TMP/run
        mkdir -p $TMP/run/build
        launcher=$PWD/$(location :hello-test-dist[launcher])
        bin=$PWD/$(location {chez}:install[bin])
        cd $TMP/run
        PATH=$bin:$PATH PROFILE_DATA=1 $launcher > /dev/null
        cp {app}.pd $out
    """.format(
        app = APP,
        chez = CHEZ,
    ),
)

chez_app(
    name = "hello-test-pgo",
    app = APP,
    clib = ":clib[shared]",
    profile_data = ":hello-test.pd",
    scheme_srcs = SCHEME_SRCS,
    test_build = True,
    version = VERSION,
)

# MARK: Tests

# Runs a build from a scratch copy of its source tree, which the test driver
# and the profiler read from the working directory, with Chez Scheme's tools
# on PATH for the gold scripts.
SETUP = """
    set -euo pipefail
    launcher=$(location :{name}-dist[launcher])
    work=`mktemp -d`
    trap 'rm -rf "$work"' EXIT
    cp -RL $(location :{name}-tree)/. "$work"
    chmod -R u+w "$work"
    mkdir -p "$work/build"
    cd "$work"
    export PATH=$(location {chez}:install[bin]):$PATH
"""

# Every gold script and smoke test ran, and passed.
CHECK_REPORT = """
    cat build/test.report
    test `wc -l < build/test.report` = 8
    ! grep -v '^[a-z]* [^ ]* ok ' build/test.report
"""

shims.command_test(
    name = "test-hello",
    script = SETUP.format(
        name = "hello",
        chez = CHEZ,
    ) + """
        out=`$launcher`
        echo "$out"
        grep -qx 'hello from C' <<< "$out"
        grep -qx 'hello v{version} (C says v{version})' <<< "$out"
        grep -q '^ok (in 1\\.' <<< "$out"

        # The runtime report, through the kernel's own C primitives.
        out=`RTSOPTS=1 $launcher`
        echo "$out"
        grep -q 'petite/.*threaded = YES' <<< "$out"
        grep -q 'profiled: #f, debug build: #f, [1-9][0-9]* cores' <<< "$out"
    """.format(version = VERSION),
)

shims.command_test(
    name = "test-hello-debug",
    script = SETUP.format(
        name = "hello-debug",
        chez = CHEZ,
    ) + """
        out=`RTSOPTS=1 OBJCNT=1 $launcher 2>&1`
        echo "$out"
        grep -q 'KERNEL.*registering symbol Sschemeapp_breakpoint' <<< "$out"
        grep -qx 'hello from C' <<< "$out"
        grep -q 'scheme/.*threaded = YES' <<< "$out"
        grep -q 'profiled: #f, debug build: #t' <<< "$out"
        grep -q '^Object records:' <<< "$out"

        # Without the application, the kernel boots into Chez Scheme's REPL,
        # compiler and all.
        out=`echo "(compile '(* 6 7))" | RTS_BOOT_CHEZ=1 $launcher 2>/dev/null`
        echo "$out"
        grep -q '^hello>.*42' <<< "$out"
    """,
)

shims.command_test(
    name = "test-hello-test",
    script = SETUP.format(
        name = "hello-test",
        chez = CHEZ,
    ) + """
        PROFILE_COVERAGE=1 $launcher
    """ + CHECK_REPORT + """
        # The coverage map marks N-Queens' lines as run.
        cat build/test.sscov
        grep -q '^src/ss/nqueens.ss [CUN]*C' build/test.sscov

        # The other profile reports.
        PROFILE_HTML=1 $launcher
        test -s profile.html
        PROFILE_LIST=1 $launcher
        grep -q 'src/ss/nqueens.ss' build/{app}.plist
    """.format(app = APP),
)

shims.command_test(
    name = "test-hello-test-pgo",
    script = SETUP.format(
        name = "hello-test-pgo",
        chez = CHEZ,
    ) + """
        $launcher
    """ + CHECK_REPORT,
)
