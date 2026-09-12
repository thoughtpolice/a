<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Differential fuzzing against the CLR

`fuzz/` generates random C# programs in gameplayc's subset, compiles each one
with gameplayc and with Roslyn, runs the same calls in Wasm (Deno's V8) and on
the CLR, and reports every disagreement with a reproducer. It extends
[tests/differential.mjs](../tests/differential.mjs) from fixed fixtures to
generated programs.

```sh
# A fixed set of seeds; part of `buck2 test tilde//aseipp/cs2wasm/...`, with
# fuzz-language-test (the same seeds without LIBRARY_FEATURES) and
# fuzz-runtime-async-test (async programs compiled with --runtime-async).
buck2 test tilde//aseipp/cs2wasm/fuzz:fuzz-test

# A campaign: findings go to DIR/<category>/<seed>.{cs,json}, the minimized
# program to <seed>.min.cs, and counts and signatures to DIR/summary.json.
buck2 run tilde//aseipp/cs2wasm/fuzz:fuzz -- --seeds 100000 --jobs 16 --out DIR --minimize

# Check one finding again, and minimize it.
buck2 run tilde//aseipp/cs2wasm/fuzz:fuzz -- --repro DIR/wrong-value/123.json --minimize

# Check a hand-written program: every public static method of Fuzz.Entry,
# with zero arguments, each on a fresh instance.
buck2 run tilde//aseipp/cs2wasm/fuzz:fuzz -- --repro probe.cs --each

# Print the program of one seed.
buck2 run tilde//aseipp/cs2wasm/fuzz:fuzz -- --emit 123
```

The runnable uses the compiler's JIT build (`:gameplayc`); pass
`--gameplayc PATH` to use another. Other options: `--start S` (first seed),
`--features a,b` or `--without a,b` (see `FEATURES` in `gen.mjs`),
`--all-features` (include `KNOWN_ISSUES`), `--size F` (scales the number of
methods and entries), `--minimize-per-signature N`, and `--poison`, which
compiles without `--recover-after-trap` and checks that every entry after a
trap faults with 18.

## Pieces

- `gen.mjs`: the seeded generator. A program is a set of declarations
  (enums, exception classes, structs, records and record structs, a class
  hierarchy with virtual and interface members, properties and an indexer,
  generic classes and methods, unions, classes with static constructors,
  helper methods) and public static entries `Fuzz.Entry.E<n>` with scalar
  parameters and results. Everything a program does that has an order
  (constructors, field initializers, filters, `finally` blocks, static
  initialization, collection enumeration) is logged into a trace hash that
  `Fuzz.Entry.Trace()` returns after every entry.
- `scenarios.mjs`: stylized statements for what random expressions rarely
  reach: compound assignments through receivers and indices with side
  effects, control leaving `try`/`catch`/`finally`, filters in loops, struct
  storage (elements, fields, copies, boxes, constrained calls), records
  cloned through a base type, method groups, per-instantiation statics,
  mutually dependent static constructors, generic class hierarchies, unions
  in collections, boundary values of every conversion and operator, and
  equality of signed zeros, NaN and boxed values.
- `features.mjs`: stylized statements for the features gameplayc gained
  later: tuples, nullable value types, iterators (declared in a prelude
  class, with `finally` blocks and early `break`), LINQ and query
  expressions, anonymous types (their `Equals`, `GetHashCode` of integers and
  `ToString`), indices, ranges and list patterns, checked arithmetic and
  conversions, `goto` and `goto case`, number formatting (floats' shortest
  round-trip text and format strings), `Array.Sort`/`List.Sort` with and
  without comparisons, seeded `Random`, events and multicast delegates, ref
  locals and ref returns, `GetType`/`typeof` and `Type.Name`, generic
  virtual methods, default interface methods and covariant returns;
  `decimal` (values of every shape, the arithmetic's bits and scales with its
  overflow and division faults, comparisons, rounding modes, formats,
  parsing, conversions from and to `double`, patterns, `decimal?` and LINQ
  sums), multidimensional arrays, spans over arrays and strings and
  `stackalloc` (with `foreach ref`), iterators in a struct and in local
  functions with `goto`, the ordinal string comparers and `Comparer`/
  `EqualityComparer` `Create`, `SortedList`, `SortedDictionary`,
  `SortedSet`, `PriorityQueue` and `LinkedList`, and `Cast`, `OfType`,
  `ToLookup`, `GroupBy` with a result selector, `Join`, and wide anonymous
  types with `with`; `Memory<T>` and `ReadOnlyMemory<T>` (slices, writes
  through `Span`, copies, string memories and their equality, memories in
  collections and closures); interface events (field-like, accessor, explicit
  and default implementations); and `Convert` between the scalar types and
  strings, decimal's `NumberStyles` and invariant providers, and enum and
  decimal conversions. Their declarations are in a prelude of the features a
  program uses. The programs also use what runs over the gameplay CoreLib
  and the framework (`LIBRARY_FEATURES`, which `fuzz-language-test` leaves
  out): the SDK's System.Collections
  and System.Linq IL (how often selectors run under `Last`, `ElementAt`,
  `Count` and `Skip`, cheap counts of casts, `Chunk`, `Index`, `CountBy`,
  `AggregateBy`, set operations, `OrderedDictionary`, and .NET's messages)
  and variance (variant interfaces of classes and arrays, variant
  delegates, a store into an array through a covariant `IList<T>`, array
  covariance and its `ArrayTypeMismatchException`), and async: an async
  lambda run under a single-threaded SynchronizationContext of the
  program's own (`AxPump`, so the CLR runs the continuations in the order
  the module does), awaiting async methods that yield, `WhenAll`,
  `WhenAny`, exceptions through awaits, `ValueTask`, an async iterator with
  `await foreach` and `break`, a `TaskCompletionSource` with two awaiters,
  and cancellation.
- `Oracle.cs`: the CLR side, a long-running process that compiles each
  program in process with Roslyn (C# 15, nullable disabled, the SDK
  attributes; invariant culture), loads it into a collectible
  `AssemblyLoadContext`, and answers each call with the encoding of
  [tests/reference/Program.cs](../tests/reference/Program.cs), plus the
  exception's class chain.
- `run.mjs`: compiles with `--recover-after-trap` and the largest budgets
  (`--fuel 1000000 --depth 128 --alloc-units 16777216 --max-array 1048576`),
  validates and runs the calls in order on one instance (in `runner.mjs`
  processes: V8 never frees the GC types it canonicalizes, so each process
  runs a few hundred modules), and classifies the result. An exception must
  end the entry with the fault code of the first class in its chain that has
  one (`tests/differential.mjs`'s table; 17 otherwise).
- `minimize.mjs`: delta debugging over the program text (calls, unused
  declarations, blocks with their headers and `else`/`catch` chains,
  unwrapped blocks, lines, then subexpressions), keeping candidates that
  Roslyn accepts and that still show the same category and signature.
- `fuzz.mjs`: the driver.

## Categories

Findings: `reject` (exit 1 on a program Roslyn accepts; either the program
uses something the README lists as unsupported, which is a generator bug, or
it is an unjustified rejection), `ice` (exit 3), `crash`, `invalid` (the
module fails validation), `link`/`start-trap`, `wrong-value`, `wrong-trace`,
`missing-fault` (the CLR threw, Wasm returned), `spurious-fault`,
`wrong-fault`, `stale-fault`, `missing-export`, `engine-error`,
`wasm-timeout`, and with `--poison`, `poison`.

Not findings: `budget` (fuel, depth, allocation or the maximum array length
ran out where the CLR has no limit; the generator estimates costs to keep
this rare), `generator` (Roslyn rejected the program), `oracle` (the oracle
timed out or died), and `clr-jit` (see below).

## Determinism

The generator avoids what the CLR does not define or gameplayc documents as
different: hash codes (records, strings, `object`; an anonymous object of
integers hashes as C# defines), the text of enums, full type names, the BCL's default exception messages, side-effecting
initializers of `beforefieldinit` classes (only classes with static
constructors have them; the minimizer keeps it that way), the order in which
patterns read properties, the sign of a NaN (unspecified in Wasm, and the
CLR's `double.NaN` is negative where JavaScript's is not, so `CopySign` takes
its sign through `Tr.Sign`), array lengths above the maximum (whose fault 4
would pass for an `OverflowException`), `Math`'s transcendental functions
(not bit-exact against the CLR's libm), how often sorts and the sorted
collections call a comparer or key selector (never logged), the culture's
string order (strings are ordered by ordinal comparers), negative
`stackalloc` sizes, counting a `Cast` of a sequence that is not an array,
and the rejected constructs of the README. Loops have constant trip counts; calls only go to
higher tiers, so the call graph is acyclic apart from bounded recursion; and
each callable carries a cost estimate so entries stay within the fuel.

The pinned runtime's JIT has bugs of its own on linux-arm64: unoptimized code
and the optimizing JIT each miscompute some intrinsics (`BitOperations` over a
constant folds to a 64-bit value in every mode, so the generator makes those
arguments opaque with an always-zero mutable static), and the optimizing JIT
crashes on some programs. The oracle runs with `DOTNET_TieredCompilation=0`,
so that an answer does not depend on how often a method ran. A request that
kills it is asked again of an oracle running `DOTNET_JITMinOpts=1`, and so is
every request whose answer disagrees with Wasm: when the two JIT modes answer
differently, the disagreement is filed as `clr-jit` rather than as a
gameplayc finding.

Features whose findings are still open are listed in `KNOWN_ISSUES` in
`gen.mjs` (empty today) and left out of `fuzz-test`, so that it passes and
turns them back on as the compiler is fixed.
