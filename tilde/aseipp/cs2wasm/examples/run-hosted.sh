#!/usr/bin/env bash
set -euo pipefail
example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$example_dir/.."
./publish/gameplayc -o publish/hosted-gameplay.wasm examples/HostedGameplay.cs
wasm-tools validate publish/hosted-gameplay.wasm
node examples/run-hosted.mjs
