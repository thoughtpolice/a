# Wedge

Wedge is a WebAssembly frontend and compiler framework whose first intended
target is the experimental EDGE dataflow ISA. The current milestone establishes
a target-neutral semantic IR boundary that later analyses and backends can
share. In addition to EDGE, the design is intended to admit conventional
RISC-V code generation and emission through MLIR's
[LLVM dialect](https://mlir.llvm.org/docs/Dialects/LLVM/). None of those target
backends is implemented yet.

The `wedge` binary compiles one module and prints either the semantic IR or
the CFG analyses (`--emit ir|cfg`). It accepts a Core WebAssembly binary or
WebAssembly text, recognized by the absence of the binary magic number, which
it assembles with the `wat2wasm` that the build attaches to the binary as
a resource (with typed function references and GC enabled), so no separate
WABT installation is needed. `--function` restricts either dump to one
function, named by its index, its `name` section entry, or an export. The
frontend decodes the module's `name` and `producers` sections, and both
dumps label each function header with its name.

## Language policy

The frontend validates the final WebAssembly Core 3.0 language. Its feature set
is an explicit allowlist rather than `wasmparser`'s default: threads, legacy
exception handling, stack switching, wide arithmetic, the Component Model, and
other proposals that are not part of Core 3.0 are rejected.

`Compiler::validate` covers the complete accepted language. `Compiler::compile`
interleaves that same validator with lowering and reuses its instantiated
operator signatures. The frontend now covers structured control, sealed-block
SSA locals, scalar and vector leaf operations, memories, tables, calls and tail
calls, final exception handling with invoke terminators and explicit
exceptional edges, and
nullability-refining reference branches whose facts live on individual CFG
edges. It also lowers the complete standardized Core 3.0 operator surface,
including GC allocation constant expressions and cast branches.

## Milestone-one IR

The owned IR keeps module index spaces strongly typed and represents function
bodies as typed SSA CFGs with block parameters. It also retains structured
regions, byte spans and source ordinals, explicit effects and traps, and
exceptional control-flow descriptors. A statically known throw routes to
every clause that may catch it: two imported tags with equivalent types may
be one instance at run time, so a clause naming either is a possible match,
while a clause after `catch_all` is retained as dead source structure.
Canonically equivalent Wasm type
declarations retain their original module indices while sharing an explicit
IR representative. `Program::verify` checks these contracts before later
passes consume a program. This includes recursive-group ordering and scope,
nominal subtype finality, depth and structural variance, canonical Core opcode
identity, exact immediate layouts and operator placement, every ordinary
opcode's typed signature, contextual entity/type relationships, memory and
table address widths, memory alignment and SIMD lane bounds, and stored effect
metadata. The schema inventory is fail-closed against the parser's complete
operator inventory, so a dependency update cannot silently admit an unchecked
standard opcode. At this owned-IR boundary, `ref.func` may name any function
that still exists: `wasmparser` enforces the source module's function-declaration
set during ingestion, while later IR transforms may synthesize new references.
`Display` is a deterministic format intended for checked-in golden tests.

This artifact describes WebAssembly semantics, not a least-common-denominator
machine IR. Native pointer widths, target data layouts and triples, calling
conventions, runtime representations for references, memories, tables, GC and
exceptions, trap expansion, instruction selection, and register placement
belong to later legalization and backend stages. In particular, Core memory and
table address widths are WebAssembly index types rather than RISC-V XLEN or an
LLVM pointer width. EDGE block formation, predication, scheduling, placement,
and encoding likewise remain target-specific rather than constraining the
shared CFG.

Block parameters form the common SSA seam: they can remain dataflow inputs for
EDGE, become machine-level phi/copy placement for RISC-V, or map to MLIR block
arguments and successor operands. CFG consumers must preserve edge occurrences,
not merely unique `(source, target)` pairs. Two branch arms or several switch
cases may target the same block while carrying different arguments or path
refinements, so such parallel edges are semantically distinct.

Strict CFG construction checks that block and region references resolve;
handler and catch-clause references are verified by `Program::verify`. Semantic analyses and backends consume the graph only
after `Program::verify`, which additionally authenticates SSA, types, effects,
traps, and exception routing. The default topology includes both ordinary and
in-function exceptional edges; future layout-specific filtered views must be
explicit analysis policies rather than changes to frontend semantics.

Post-dominance uses an explicit virtual exit joining the exits selected by its
policy. The semantic policy includes returns, tail calls, traps, and escaping
exceptions, while normal-completion includes only returns and tail calls. A
block must be entry-reachable and have a finite path to a selected exit to
participate; otherwise it has no relation, even with itself. Infinite paths
without a selected exit are outside this finite-exit analysis.

Mutable locals are translated directly with Braun-style sealed-block SSA
construction; the precise frontend contract is documented in [SSA.md](SSA.md).

## Interpreter

`wedge::interp` is a reference interpreter for the IR. It instantiates a
program, evaluating its global, table, and segment initializers in module
order and running its start function, and then runs functions directly on
the SSA CFG: block parameters carry values across edges, instructions
compute results, terminators pick successors, and exceptional edges route a
thrown exception to the first catch clause whose tag matches. Every Core 3.0
operation the frontend lowers is implemented, garbage-collected structs and
arrays included; relaxed SIMD operations, whose results the IR marks
nondeterministic, follow the deterministic profile. Function imports are
resolved by a `Host`, which is handed the instance back so it can read and
write memories and call into the guest, as a canonical-ABI host allocating
through the guest's `realloc` must. An instance is bounded by a fuel
budget, a call depth, and allocation limits, none of which a program can
observe except as a fault. The interpreter is the executable meaning of the
IR: the differential tests hold the frontend to it, and the simplification
pass is checked against it. It is fast enough to run whole programs: the
console packages `tilde//aseipp/wlink` links run on the HAL host in
`wedge_testing::console`, and PureDOOM initializes and renders under it at
some forty million IR instructions per second in an optimized build.

## Simplification

`wedge::simplify` is the canonical cleanup of a lowered program, built on
the editing operations of `wedge::edit`: renaming a value at every use,
removing a block parameter together with the argument every predecessor
delivers to it, and removing blocks together with the regions they began,
with the remaining blocks and regions renumbered to their positions and
every edge, arm, clause, and region reference kept resolving. The pass
folds constants, evaluating them with the interpreter so a folded value is
the value the interpreter would have computed; resolves branches and
switches on constants; threads jumps through empty blocks, carrying edge
arguments and refinements along; removes unreachable blocks and the catch
clauses that named them; replaces block parameters every predecessor
passes the same value or the same constant; merges a block into its only
predecessor; and removes unused instructions whose effects are at most
reads. It refuses whatever retained structure or types forbid: a branch
whose taken edge carries a refinement, a `try_table` entry, a catch
target's parameters, an invoke's continuation. `wedge --simplify` runs it
before printing. Every step preserves meaning under the interpreter, which
the tests check on hand-written, fixture, linked, and generated modules by
running each program before and after with the same arguments and
comparing results, traps, exceptions, and the state left behind.

## Effects

Every instruction stores the effects of its operation: the resources it
reads or writes, the traps it may raise, whether it may throw, whether it
allocates, and whether its result is nondeterministic. For a Core operation
the canonical effects derived by `wedge::semantics` are a conservative upper
bound. A pass that proves more may narrow the stored effects to any subset,
for example dropping a bounds-check trap or replacing an opaque callee
summary with the resources it actually touches, and `Program::verify` rejects
any widening.

Resources are memories, tables, globals, data and element segments, the GC
heap as one resource, and `host`, the opaque external state a call may touch.
`host` may alias every other resource, so a write to it is a barrier. Two
effect sets conflict, and may not be reordered, when they access aliasing
resources and at least one side writes, or when one side allocates against
the other's host access; `Effects::conflicts_with` and `Effects::is_barrier`
are the queries a scheduler must use rather than scanning access lists for a
particular resource. Traps, exceptions, and nondeterminism are control facts
carried by the CFG and take no part in that relation. Relaxed SIMD results
are implementation-defined under the Core 3.0 profile Wedge accepts, and
their instructions are marked `nondeterministic`.

## Tests

Rust test crates live under `src/tests/*_tests.rs`; the
`tests/` tree is reserved for `.wat` fixture inputs and golden data. Buck
compiles each WAT fixture to `.wasm` with
`third-party//by-name/wa/wabt:wat2wasm` as part of the test graph. Tests are
split into focused layers:

- end-to-end lowering and textual IR goldens;
- whole-program fixtures such as `tests/chacha20.wat`, an RFC 8439 ChaCha20
  whose self-test WABT's interpreter must pass before the compiler's view of
  its loops, multi-value calls, and memory effects is checked;
- modules `tilde//aseipp/wlink` links from components, the prototype console
  package and PureDOOM on the same SDK among them, compiled exactly as the
  build produces them so the linker's fused adapters, trampolines, and
  per-component memories stay within what the frontend accepts, and so a
  whole game lowers to verified IR with a CFG and its analyses per function;
- sealed-block SSA, structured control, leaf families, advanced control, and
  semantic-effect contracts;
- target-neutral multigraph analysis covering edge occurrences and payloads,
  explicit exits, reachability/RPO, dominance and post-dominance, SCCs, and
  natural loops, including WAT-to-Wasm end-to-end cases;
- full Core 3.0 validation plus explicit non-standard rejection cases;
- programmatically constructed verifier contracts for valid and invalid IR,
  including exhaustive Core-operation inventory, numeric/SIMD, contextual,
  immediate-layout, and nominal-type suites;
- deterministic Hegel properties that generate forged operations and typed
  CFGs, mutate signatures, immediates, ordinary and exceptional edges, exercise
  memory/SIMD bounds, and check multigraph topology, traversal, dominance,
  post-dominance, SCCs, region ownership, refinements, and nominal-subtype
  relationships against independent oracles;
- whole modules wasm-smith draws from Hegel-generated bytes under the
  standard Core 3.0 profile, each of which must validate, compile to a
  program that verifies and prints, and compile the same way twice;
- the reference interpreter on hand-written modules with known outcomes,
  from integer corner cases through exception routing to managed objects;
- differential execution: every fixture, and every module wasm-smith draws
  from Hegel-generated bytes under the executable profile (no imports,
  everything exported, canonical NaNs, no relaxed SIMD or garbage
  collection), runs under the reference interpreter, and the values, traps,
  and uncaught exceptions it records are written as a spec-test script that
  WABT's `spectest-interp` checks against its own interpreter. Recursion
  past WABT's call stack, a loop that exhausts the interpreter's fuel, and
  a module WABT cannot read are inconclusive rather than failures;
- the simplification pass on small modules with known results, on every
  fixture, on every module wlink links, and on generated modules under
  Hegel: the result must verify and behave exactly like the original under
  the interpreter, invocation by invocation, state included, and the
  editing operations are checked on their own;
- the console packages run whole: the prototype game must make the same
  HAL calls, in the same order and with the same arguments, as the demo's
  stdio host makes through wasm2c, and PureDOOM must render the same frame
  hashes as the SDK's headless host. Doom's initialization is two hundred
  million instructions, so an unoptimized build compares it only when
  `WEDGE_DOOM_FRAMES` asks; an optimized one (`buck2 test -m release`)
  always does.

Standardized recursive-type, executable-GC, and cast-branch forms that the
pinned WABT cannot yet tokenize are covered with small self-contained binary
encoders in their Rust test files; the normal end-to-end fixture pipeline
remains WAT through WABT. The golden comparator is local to this package. The
property targets use the repository's existing `hegeltest` dependency with
bounded, rejection-free generators, so each derandomized run spends its case
budget on accepted cases; the toolchain unwinds on panic, so Hegel shrinks a
failure to a minimal counterexample.

## Fuzzing

Five Fozzie harnesses share the properties' oracles, `src/testing/`:
validation and compilation must agree on whether a byte string is a standard
module, whatever compiles must verify and render both dumps, whatever
runs must run the same way under WABT, and whatever is simplified must
still verify and run the same way. `:smith-fuzz` draws a module from its
input with wasm-smith, configured to the accepted profile, so nearly every
execution reaches the lowering; `:module-fuzz` takes the input as the module
and starts from every fixture and the linker's small outputs, so it
exercises the parser and validator boundary as well; `:link-fuzz` reads the
input as the component text of a package, links it with wlink, and holds
the module that comes out to the same contract, starting from every fixture
set the linker's build links; `:exec-fuzz` draws a module under the
executable profile, runs it under the reference interpreter with arguments
drawn from the input's tail, simplifying it first when the tail's first
bit says so, and has WABT check the outcomes; `:simplify-fuzz` draws a
module the same way and runs it before and after simplification. Each way
of failing returns its own harness code, `1` for a valid module the
compiler rejects, `2` for an invalid one it accepts, `3` for a program that
fails verification, `4` for a linked module that is not a standard core
module, `5` for an execution WABT disagrees with, `6` for a simplified
program that fails verification, and `7` for one that behaves differently;
a panic is a crash. `buck2 test` runs a short bounded campaign; for a real
one, give `buck2 run` a work directory:

```sh
buck/bin/buck2 run tilde//aseipp/wedge:smith-fuzz -- --workdir /var/tmp/wedge-smith
```

`buck/bin/buck2 run root//src/fozzie/engine:fozzie -- tui` watches that
campaign, and every other registered one, live; `-- tui --once --workdir
/var/tmp/wedge-smith` prints one snapshot of it.
