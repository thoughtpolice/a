# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""The configuration every target in the repository starts from.

The root PACKAGE sets these modifiers, and PACKAGE files apply by directory
rather than by cell, so they reach every cell checked out beneath it:
toolchains, third-party, tilde, cellar and mode alike. A PACKAGE file further
down can override any of them, as cellar's does, and so can `-m` on the command
line.

Keep this file free of loads: whatever the root PACKAGE loads is an input of
every package in the repository.
"""

# Go builds without cgo everywhere, the standard library included: no Go code
# here calls C, and a pure Go binary needs no C toolchain to link, for the host
# or any other platform. The prelude's own default for this constraint is cgo
# on, and its go_binary and go_test rules would set it back on for a target that
# asked; the Go shims refuse to. The execution platforms in buck/platforms carry
# it too, so an exec dep gets it without the modifiers.
CGO_DISABLED = "prelude//go/constraints:cgo_enabled[false]"

def _host_cpu() -> str:
    if host_info().arch.is_aarch64:
        return "config//cpu/constraints:arm64"
    else:
        return "config//cpu/constraints:x86_64"

def _host_os() -> str:
    os = host_info().os
    if os.is_macos:
        return "config//os/constraints:macos"
    elif os.is_windows:
        return "config//os/constraints:windows"
    else:
        return "config//os/constraints:linux"

# Without a cpu and an os, a target takes the prelude's defaults, which are
# `unspecified`: every select keyed on config//os or config//cpu falls through
# to its DEFAULT branch, or fails to configure where it has none.
DEFAULT_MODIFIERS = [
    _host_cpu(),
    _host_os(),
    CGO_DISABLED,
]
