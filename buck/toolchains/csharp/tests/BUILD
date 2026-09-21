# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# A library, a program using it under every profile, and checks that each
# profile produced what it claims. `:hello` follows the configuration
# (`-m aot` and friends); the pinned ones cover the profiles the
# configuration did not pick.

depot.csharp.library(
    name = "greeter",
    srcs = ["Greeter.cs"],
)

# Expected `RuntimeFeature.IsDynamicCodeSupported` and TieredPGO answers per
# profile; the program checks them against how it was really built.
PROFILES = {
    "aot": ("false", "false"),
    "jit": ("true", "false"),
    "pgojit": ("true", "true"),
    "r2r": ("true", "false"),
}

depot.csharp.binary(
    name = "hello",
    srcs = ["Program.cs"],
    deps = [":greeter"],
)

[
    depot.csharp.binary(
        name = "hello-{}".format(profile),
        srcs = ["Program.cs"],
        profile = profile,
        deps = [":greeter"],
    )
    for profile in PROFILES.keys()
]

[
    depot.run_test(
        name = "hello-{}-test".format(profile),
        args = [
            "--expect-dynamic-code",
            dynamic_code,
            "--expect-pgo",
            pgo,
        ],
        dep = ":hello-{}".format(profile),
    )
    for profile, (dynamic_code, pgo) in PROFILES.items()
]

# The program's output, not only its exit status; `$(exe)` space-joins the
# multi-word `dotnet exec` command, which is what a shell wants. Backticks
# because `$(` is buck2's own macro syntax here.
[
    depot.command_test(
        name = "hello-{}-output".format(profile),
        script = """
            out="`$(exe :hello-{profile})`"
            printf '%s\\n' "$out"
            case "$out" in
                *"hello, buck2"*"sum-of-squares=30"*) ;;
                *) echo "unexpected output" >&2; exit 1 ;;
            esac
        """.format(profile = profile),
    )
    for profile in PROFILES.keys()
]

depot.csharp.test(
    name = "selftest",
    srcs = ["SelfTest.cs"],
    args = ["--from-build-file"],
    env = {"CSHARP_TEST_ENV": "set"},
    deps = [":greeter"],
)
