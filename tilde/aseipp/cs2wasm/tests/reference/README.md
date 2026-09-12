# CLR differential oracle

`tests/differential.mjs` runs the comparison against a Native AOT compiler
executable (`GAMEPLAYC`) and the oracle built here:

```sh
ORACLE=$(buck2 build tilde//aseipp/cs2wasm:reference --show-full-simple-output)
DOTNET_ROOT=$(buck2 build toolchains//csharp:dotnet --show-full-simple-output) \
GAMEPLAYC_REFERENCE="$ORACLE/Gameplay.Reference" \
deno run --allow-all tests/differential.mjs "$GAMEPLAYC"
```

The runner compiles the same C# fixtures twice: once with the toolchain's
Roslyn into this managed reference program (`:reference` in `BUILD`, a plain
JIT-compiled csharp_binary), and once with the native compiler into Wasm. It
invokes the actual CLR methods through reflection, then compares their
results with Wasm execution in the JavaScript engine. The reference program
contains no second implementation of the fixture algorithms.

Only the native executable is copied into the compiler's test directory, and
its process gets an empty `PATH` and nonexistent SDK paths. The separate CLR
oracle process runs the toolchain's apphost, which finds its runtime through
`DOTNET_ROOT`; `GAMEPLAYC_REFERENCE` names that executable.

The oracle is compiled on the CLR's terms: nullable annotations are disabled
to match gameplayc's binding configuration (the reference runner itself
enables them) and warnings remain errors.

Coverage includes integer boundaries and seeded inputs, floating-point
infinities, NaN and signed zero, constructors, shared and cyclic heap objects,
the particle simulation and maze examples, compound assignment, array `foreach`,
field initializers, and evaluation order. Floating results are compared by their
bits after widening `float` to `double`, as the JavaScript Wasm API does. NaN
payloads are unspecified, so different NaN payloads count as equal.

CLR null-reference, index, divide-by-zero and overflow exceptions must match
the corresponding Wasm fault code. A negative array length maps to fault 4.
The compiler's fuel, depth, allocation charge and maximum array length have no
CLR equivalents. Four explicit cases require successful CLR execution and the
documented Wasm budget fault. Ordinary cases cannot silently opt out of matching.
Tests that would run forever or exhaust the CLR's stack are never invoked.

Inputs, reference output and the compiled Wasm stay in a temporary directory
the runner prints at startup. On failure the runner reports the seed, case
index, method and arguments. Reproduce the same input corpus with:

```sh
deno run --allow-all tests/differential.mjs "$GAMEPLAYC" --seed=0x5eed1234
```

A different unsigned 32-bit seed changes the generated integer and heap inputs
while retaining the fixed boundary and evaluation-order cases.
