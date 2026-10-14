# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# Every shims.git_fetch runs this, so nothing it depends on may come from
# one: that would be a cycle. It needs only Go and its standard library.
shims.go_binary(
    name = "git-fetch",
    srcs = glob(
        ["*.go"],
        exclude = ["*_test.go"],
    ),
    cgo_enabled = False,
    link_mode = "internal",
    # What `-m release` adds for Go, which compiles optimized either way.
    # This runs as an exec dep of every git_fetch, which `-m release`
    # never reaches, and a stripped binary is less to download from the
    # cache.
    linker_flags = [
        "-s",
        "-w",
    ],
    tests = [":unit"],
)

shims.go_test(
    name = "unit",
    srcs = glob(["*.go"]),
    cgo_enabled = False,
)

# A real fetch over the network, through the macro reindeer emits. The
# action is cached like any other, so this only reaches GitHub when
# git-fetch or defs.bzl changes.
HELLO_WORLD_REV = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"

shims.git_fetch(
    name = "Hello-World.git",
    repo = "https://github.com/octocat/Hello-World",
    rev = HELLO_WORLD_REV,
    sub_targets = ["README"],
)

# Backquotes rather than $(...), which Buck would take for a macro.
shims.command_test(
    name = "fetch-hello-world",
    script = """
        rev=""" + HELLO_WORLD_REV + """
        work_tree="$(location :Hello-World.git)"
        git_dir="$(location :Hello-World.git[.git])"

        test "`basename "$work_tree"`" = Hello-World
        test "`ls -A "$work_tree"`" = README
        printf 'Hello World!\\n' | cmp - "$(location :Hello-World.git[README])"

        test "`cat "$git_dir/HEAD"`" = "$rev"
        test "`cat "$git_dir/shallow"`" = "$rev"
        test "`ls "$git_dir"/objects/pack | sed 's/.*[.]//' | sort | tr '\\n' ' '`" = "idx pack "
    """,
)
