#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$example_dir/.."

# GAMEPLAYC names a built compiler executable; otherwise Buck2 runs it.
if [[ -n "${GAMEPLAYC:-}" ]]; then
  compiler=("$GAMEPLAYC")
else
  compiler=(buck2 run tilde//aseipp/cs2wasm:gameplayc --)
fi
module=publish/gameplay.wasm

# The native compiler embeds its C# binding metadata and writes Wasm directly.
"${compiler[@]}" -o "$module" examples/Gameplay.cs
wasm-tools validate "$module"

run_example() {
  local export_name="$1"
  local expected="$2"
  shift 2

  local actual
  actual="$(wasmtime run --invoke "$export_name" "$module" "$@")"
  printf '%s => %s (expected %s)\n' "$export_name" "$actual" "$expected"
  if [[ "$actual" != "$expected" ]]; then
    return 1
  fi
}

# C# creates an int[] and sums 0² + 1² + 2² + 3² + 4².
run_example Demo.Gameplay.SumSquares 30 5

# C# creates a Vec3 object and calls its instance method: 2² + 3² + 6².
run_example Demo.Gameplay.VectorLengthSquared 49 2 3 6

# The larger module uses explicit constructors, shared references, cyclic
# graphs, jagged grids, and objects allocated throughout a simulation.
module=publish/heap-gameplay.wasm
"${compiler[@]}" -o "$module" examples/HeapGameplay.cs
wasm-tools validate "$module"
run_example Demo.HeapGameplay.ParticleSimulation 3404 3 4
run_example Demo.HeapGameplay.SharedGraphWeight 15 5
run_example Demo.HeapGameplay.MazeDistance 14 6 4
run_example Demo.HeapGameplay.AllocationPressure 16129 127

# A small JavaScript host keeps one instance alive so it can inspect the fault
# global and demonstrate recovery after an allocation-budget trap.
node examples/heap-budget.mjs
