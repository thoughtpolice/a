# CLR differential oracle

Inside `nix-shell`, publish the compiler and run:

```sh
dotnet publish -c Release -o publish
node tests/differential.mjs ./publish/gameplayc
```

The runner compiles the same C# fixtures twice: once with the pinned SDK into
this managed reference project, and once with the published native compiler
into Wasm. It invokes the actual CLR methods through reflection, then compares
their results with Wasm execution in Node. The reference program contains no
second implementation of the fixture algorithms.

Only the native executable is copied into the compiler's test directory, and
its process gets an empty `PATH` and nonexistent SDK paths. The separate CLR
oracle process uses the test runner's normal SDK environment.

Every run rebuilds the reference project and executes it. Its project overrides
the repository's Native AOT defaults because this oracle must run on the CLR.
Nullable annotations are disabled to match gameplayc's binding configuration;
the reference runner itself enables them. Warnings remain errors.

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

Inputs, reference output, both compiled forms and build intermediates stay in
`publish/differential/`. On failure the runner reports the seed, case index,
method and arguments. Reproduce the same input corpus with:

```sh
node tests/differential.mjs ./publish/gameplayc --seed=0x5eed1234
```

A different unsigned 32-bit seed changes the generated integer and heap inputs
while retaining the fixed boundary and evaluation-order cases.
