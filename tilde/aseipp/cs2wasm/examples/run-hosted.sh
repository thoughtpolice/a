#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$example_dir/.."
# GAMEPLAYC names a built compiler executable; otherwise Buck2 runs it.
if [[ -n "${GAMEPLAYC:-}" ]]; then
  compiler=("$GAMEPLAYC")
else
  compiler=(buck2 run tilde//aseipp/cs2wasm:gameplayc --)
fi
mkdir -p publish
"${compiler[@]}" -o publish/hosted-gameplay.wasm examples/HostedGameplay.cs
wasm-tools validate publish/hosted-gameplay.wasm
node examples/run-hosted.mjs
