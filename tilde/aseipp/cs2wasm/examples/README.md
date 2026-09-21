# Run compiled C# in Wasmtime

For a fully worked playable game, start with [Breakout](breakout/README.md).
It includes the C# gameplay, browser host, terminal run, and a walkthrough of
each frame from input through Wasm execution to rendering.

For persistent game state, typed host callbacks, and per-frame command batches,
see [the hosted example](../docs/HOSTING.md) and run `./examples/run-hosted.sh`
after publishing the compiler.

These examples compile C# into Wasm GC modules and run their exported functions
in Wasmtime. C# objects and arrays become Wasm GC types; Wasmtime executes the
resulting modules without a .NET runtime.

From the repository root:

```sh
GAMEPLAYC=$(buck2 build -m aot tilde//aseipp/cs2wasm:gameplayc --show-full-simple-output)
./examples/run-wasmtime.sh
```

The script compiles [Gameplay.cs](Gameplay.cs) and
[HeapGameplay.cs](HeapGameplay.cs) into `publish/gameplay.wasm` and
`publish/heap-gameplay.wasm`, validates them with `wasm-tools`, then checks:

```text
Demo.Gameplay.SumSquares => 30 (expected 30)
Demo.Gameplay.VectorLengthSquared => 49 (expected 49)
Demo.HeapGameplay.ParticleSimulation => 3404 (expected 3404)
Demo.HeapGameplay.SharedGraphWeight => 15 (expected 15)
Demo.HeapGameplay.MazeDistance => 14 (expected 14)
Demo.HeapGameplay.AllocationPressure => 16129 (expected 16129)
```

`SumSquares(5)` allocates an integer array and sums the squares of 0 through 4.
`VectorLengthSquared(2, 3, 6)` creates a `Vec3` and calls its instance method.
The script exits unsuccessfully if compilation, validation, execution, or a
result check fails. Wasmtime currently prints experimental notices for its
`--invoke` command-line interface.

To perform the steps individually:

```sh
"$GAMEPLAYC" -o publish/gameplay.wasm examples/Gameplay.cs
wasm-tools validate publish/gameplay.wasm
wasmtime run --invoke Demo.Gameplay.SumSquares publish/gameplay.wasm 5
wasmtime run --invoke Demo.Gameplay.VectorLengthSquared publish/gameplay.wasm 2 3 6
wasm-tools print publish/gameplay.wasm -o publish/gameplay.wat
```

These exports take primitive values, so they can be called directly from
Wasmtime's CLI. The module has no imports, memory, or WASI dependency. Each CLI
invocation creates a fresh instance.

## Heap examples

| Export | What it does | Example result |
| --- | --- | --- |
| `ParticleSimulation(3, 4)` | Builds an array of particle objects, shares one gravity vector, mutates velocities, and allocates fresh position objects every step while retaining previous positions. | `3404` |
| `SharedGraphWeight(5)` | Builds a diamond-shaped object graph with a cycle back to its root, mutates a shared node through one branch, and visits each object once. | `15` |
| `MazeDistance(6, 4)` | Finds a shortest path through a jagged grid using breadth-first search and a queue of heap-allocated position objects. | `14` |
| `AllocationPressure(127)` | Repeatedly allocates 1,024-element arrays and uses their first and last values to compute a checksum. | `16129` |

For the particle simulation, each `Particle` constructor receives three object
references. All particles point to the same gravity object, so changing its `Y`
field changes every particle's acceleration. Each update keeps the previous
position alive and allocates a new one. The result is a checksum of current and
previous positions. `ParticleSimulation(100, 20)` exercises a larger workload
and returns `1678298650`.

The graph contains these references:

```text
root → left  → shared → root
     → right → shared
```

The four starting weights total 10. Adding 5 through `left.Children[0]` changes
the same object reached through the right branch. Visited flags prevent both
double counting and infinite traversal around the cycle.

Run or inspect the larger module directly:

```sh
"$GAMEPLAYC" -o publish/heap-gameplay.wasm examples/HeapGameplay.cs
wasmtime run --invoke Demo.HeapGameplay.ParticleSimulation publish/heap-gameplay.wasm 100 20
wasmtime run --invoke Demo.HeapGameplay.MazeDistance publish/heap-gameplay.wasm 6 4
wasm-tools print publish/heap-gameplay.wasm -o publish/heap-gameplay.wat
```

## Allocation limits and recovery

Each `int[1024]` costs `16 + 8 × 1024 = 8208` logical allocation units. The
default budget is 1,048,576 units, so 127 arrays fit and the 128th traps with
fault code 3. This is cumulative allocation accounting, not a measurement of
live heap bytes; collecting an old array does not refund its charge.

The script also runs [heap-budget.mjs](heap-budget.mjs), a small Node host that
catches the trap, reads the exported `__fault` global, and calls the same module
instance again successfully. To run just that part after compiling:

```sh
node examples/heap-budget.mjs
```

The full compiler suite checks these examples, every maze destination, and
constructor evaluation order in Node and SpiderMonkey, before and after
Binaryen optimization. Selected exports also run in Wasmtime:

```sh
deno run --allow-all tests/integration.mjs "$GAMEPLAYC" --all-tools
```
