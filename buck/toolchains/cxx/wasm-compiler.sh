#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Nix's native clang wrapper injects options for its host architecture, such
# as -fzero-call-used-regs, that WebAssembly cannot accept. This wrapper is
# selected only for freestanding wasm compilation. Nix names its settings
# with target/role suffixes, so clear every spelling, including the base name.
for setting in ${!NIX_HARDENING_ENABLE@}; do
    export "$setting="
done

exec "$@"
