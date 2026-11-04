#!/bin/sh
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Installed as /usr/local/bin/lean, lake, leanc, leanchecker and leanir.
# Lean's own bin/ also holds the clang, ld.lld and llvm-ar that leanc
# drives, which would shadow the image's on PATH, so only these tools go
# there, each running the one of its name in /opt/lean.

exec /opt/lean/bin/"${0##*/}" "$@"
