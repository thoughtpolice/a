# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(":defs.bzl", "default_platforms", "generate_platforms")

# Go builds without cgo everywhere, the standard library included: no Go code
# here calls C, and a pure Go binary needs no C toolchain to link, for the host
# or any other platform. The prelude's own default for this constraint is cgo
# on, and its go_binary and go_test rules would set it back on for a target that
# asked; the Go shims refuse to.
generate_platforms(
    default_platforms,
    constraints = ["prelude//go/constraints:cgo_enabled[false]"],
)
