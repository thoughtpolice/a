# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "lean_toolchain", "lean_toolchain_check")

# Lean comes from the Nix dev shell (buck/etc/nix/lean4.nix), like the C++
# and Rust compilers, so all three link with the same Nix linker wrapper.

# Composes every lean, leanir and leanchecker invocation; see tool.py.
shims.python_binary(
    name = "tool",
    main = "tool.py",
    visibility = ["PUBLIC"],
)

# Checks that the lean on PATH is the one lean4.nix builds, and writes the
# include and link flags of its runtime. It reruns whenever the Nix
# expression or the flake lock changes, and its output is an input of every
# Lean action, so a new Lean rebuilds everything Lean.
lean_toolchain_check(
    name = "check",
    nix_expr = "root//buck/etc/nix:lean4.nix",
    nix_lock = "root//buck/etc/nix:flake.lock",
    tool = ":tool",
)

# lean.h for C code, and Lean's runtime and standard library for the link.
# Generated C needs both; so does C++ code implementing @[extern] functions.
shims.cxx_library(
    name = "runtime",
    exported_post_linker_flags = ["@$(location :check[ldflags])"],
    exported_preprocessor_flags = ["@$(location :check[cflags])"],
    preferred_linkage = "static",
    visibility = ["PUBLIC"],
)

lean_toolchain(
    name = "lean",
    check = ":check",
    tool = ":tool",
    visibility = ["PUBLIC"],
)
