<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# The CIL importer

`gameplayc` first lowered C# from Roslyn's `IOperation` trees: a frontend
that understood every C# construct itself (closures, iterators, records,
pattern matching, string interpolation, `foreach`, `using`, ...). This
document describes the importer that replaced it, and has been gameplayc's
only frontend since phase 6 ("Retiring the IOperation frontend"; where
the sections below, written as the work went, say "IL mode" they mean the
importer, and "source mode" the retired frontend): `gameplayc` compiles
**CIL** (the IL `csc` emits) to Wasm GC, so that anything that compiles to
pure-managed IL can run: gameplay assemblies built by our pinned `csc`,
pure-managed NuGet packages, and the upper layers of the .NET class library
(System.Linq, System.Collections, System.Runtime.Numerics, later
System.Text.Json and Regex), all above a gameplay CoreLib of our own.

The decision rests on `tools/bclscan`'s measurements
(`buck2 run tilde//aseipp/cs2wasm/tools/bclscan:bclscan`) of the .NET 11
RC1 framework: the upper assemblies are nearly all importable once feature
switches and `IsSupported` checks are folded (System.Linq 99.7% of reachable
bodies, System.Collections 99.1%, System.Runtime.Numerics 95.5%), while
System.Private.CoreLib is not (about 11% of its reachable bodies blocked even
after folding and the byref intrinsics: pointers, pinning, byte
reinterpretation, CoreCLR's object layout, FCalls and QCalls, reflection).
So the framework above CoreLib is imported, and CoreLib is ours.

## Architecture

```
 user .cs ──csc──► user.dll ─┐
 NuGet (pure IL) ────────────┤
 System.Linq.dll etc. ───────┼──► gameplayc (importer) ──► module.wasm
 gameplay CoreLib (.cs, csc) ┘         │
                                        └── reference assemblies (API surface)
```

1. **Frontend: a CIL importer.** It reads assemblies with
   System.Reflection.Metadata, types each method's evaluation stack,
   structures its control flow, and lowers it through the backend the
   `IOperation` frontend used.
2. **A gameplay CoreLib**, compiled by `csc` from C# and imported like any
   assembly: the current `runtime/*.cs` layer, grown into the types
   System.Private.CoreLib provides (object, string, arrays, exceptions,
   delegates, the primitive types and their generic-math interfaces,
   Nullable, spans, tasks, ...), plus pure-managed dotnet/runtime sources
   brought in through the build graph (below). User code keeps compiling
   against .NET's reference assemblies, so its API surface is .NET's; the
   importer resolves their type references to CoreLib.
3. **API control**: CoreLib contains only what we choose, and an IL
   member-reference allowlist is checked over every imported assembly,
   with source-located diagnostics.
4. **Async** from IL: Roslyn's state machines and a single-threaded task
   library driven by the host's frames.
5. The `IOperation` frontend stayed until the importer reached parity on
   every suite, then was retired (phase 6).
6. `Vector128<float>` and its relatives lower to Wasm SIMD's `v128`.

## One lowering layer for two frontends

The compiler today is two layers fused together:

- **The module layer** (`Frontend*.cs`): Roslyn symbols (`ITypeSymbol`,
  `IMethodSymbol`, `IFieldSymbol`) to Wasm: `MapType`, class and struct
  layouts (vtables, itables, the `$Object` root, flattened struct values
  and their boxes), generic instantiation through `Substitution`, delegate
  layouts, boxing, the exception tag and fault codes, static-initialization
  state, budgets, poisoning, the entry ABI and canonical-ABI glue, and the
  maps from framework members to runtime ones (`RuntimeCounterpart`,
  shims, intrinsics).
- **The body layer** (`FunctionEmitter*.cs`): a function shell (fuel, call
  depth, the class trigger, the return block) and primitives (locals,
  `Location` loads and stores, `CallTarget` calls, allocation, boxing and
  unboxing, checked arithmetic, conversions, faults, `try_table`
  lowering), driven by a walk over `IOperation`.

Both layers are keyed on Roslyn symbols, which is what makes sharing them
cheap: **the importer's type system is Roslyn's own metadata symbols.** The
importer builds a metadata-only `CSharpCompilation` over the assemblies it
imports (no syntax trees) and resolves every IL token to the `ISymbol` Roslyn
reads from the same metadata. Every module-layer query (`MapType`,
`ResolveCall`, `EnsureStruct`, `Substitute`, `FindImplementationForInterfaceMember`,
...) then works unchanged, and so do the body layer's primitives. What the
importer adds is what the `IOperation` frontend does from syntax:

| concern | IOperation frontend | importer |
|---|---|---|
| which types and members exist | declaration syntax (`Frontend.Declarations`) | the imported assemblies' metadata, through their symbols (`Frontend.Import`) |
| which members a body reaches | walking `IOperation` (`EnsureReferencedMembers`) | walking IL operands |
| a method's body | `IBlockOperation` | an `IlBody`: decoded, stack-typed, structured IL |
| "defined here" | has declaring syntax | defined in an imported assembly |

The refactor that gives both frontends one lowering layer is therefore:

- **`MethodPlan` carries either body**: `Body` (an `IBlockOperation`) or
  `Il` (an `IlMethod`: the metadata handle, the reader and the method's
  definition symbol). `FunctionEmitter` keeps its shell and primitives and
  dispatches the body to `EmitStatement` or to the IL lowering
  (`FunctionEmitter.Il*.cs`).
- **"Defined in the module" is one predicate** (`Frontend.IsModuleDefined`)
  instead of `DeclaringSyntaxReferences.Length > 0` spread through the
  module layer, and **"runtime type"** is decided by the symbol's origin
  (a runtime syntax tree, or in IL mode a type name the runtime layer
  declares), so the on-demand compilation of the runtime layer works in
  both modes.
- **Registration from symbols** (`Frontend.Import`): a class's fields,
  slots and methods come from its symbol's members; each method with an IL
  body becomes a plan; generic instantiations are registered from the
  definition's metadata under a `Substitution`, as the `IOperation`
  frontend registers them from syntax templates. What C# synthesizes that
  the `IOperation` frontend recreates by hand (records' members, iterators,
  closures, lambdas, auto-properties, field-like event accessors, field
  initializers) is already ordinary IL, so the importer registers none of
  those plan kinds: a display class is a class, a state machine is a class
  implementing `IEnumerator<T>`, an auto-property accessor is a method.
- **Errors carry an IL location**: `CompileError` gains a site that is a
  method and IL offset, mapped to a source line through the PDB's sequence
  points where one exists.

Everything below the body walk is shared: a module compiled from IL has
the same heap types, the same vtables, the same exception tag, the same
budgets and fault codes, and the same exports as one compiled from
`IOperation`, which is what lets every existing suite judge the importer.

Since phase 6 the IL lowering alone drives the body layer: a `MethodPlan`
carries IL (or is one of the functions the compiler synthesizes), and the
`IOperation` walk, its plan kinds and its registration from syntax are
gone ("Retiring the IOperation frontend").

## Reading IL

- **Metadata**: System.Reflection.Metadata (`PEReader`, `MetadataReader`,
  `MethodBodyBlock`). Tokens resolve to symbols through `ISymbol.MetadataToken`
  for definitions (a table built per imported assembly) and through
  signature decoding (`ISignatureTypeProvider<ITypeSymbol, GenericContext>`)
  for `TypeRef`, `TypeSpec`, `MemberRef` and `MethodSpec`: a member
  reference is found among its parent type's members by name and decoded
  signature, with type parameters matched by position. Symbols stay in the
  definition's context (`!0` is the definition's type parameter), and the
  body layer closes them under the plan's `Substitution`, exactly as it
  closes the symbols an `IOperation` names.
- **Diagnostics**: a portable PDB (embedded or beside the assembly) maps IL
  offsets to sequence points; errors read `file(line,col): GP1000: ...`
  where one exists, else `Type::Method+IL_xxxx`.

## Stack typing

A method body is decoded into instructions, split into basic blocks at
branch targets, `switch` targets, exception-region boundaries and handler
starts, and typed by abstract interpretation of the evaluation stack. Stack
entries are *IL types refined to what Wasm needs*: `int32`, `int64`,
`float32`/`float64` (IL's `F` is split by where the value came from, as
RyuJIT does), `native int` (64 bits, as `IntPtr.Size` is 8 on the
oracle's CLR: `nint` and `nuint` are `long` and `ulong` in every place a
value can be, "System.Runtime.Numerics as built"), object references with their static type (for the
`CallTarget` resolution of `callvirt`, the element type of `ldelem.ref`,
and struct layouts), value types with their symbol, `null`, and byrefs
`&T` with their kind (below). The CLI's stack rules guarantee one stack
shape per block entry; where a merge sees two reference types the entry
takes their common base, as the verifier does.

The lowering keeps every evaluation stack entry in a local of its depth and
type (`dup` is a second name for the local), so blocks carry no Wasm values
and a branch copies what differs into its target's entry locals: the arms
of `c ? a : b` store into the same local. Which of those values can stay on
the Wasm stack is decided afterwards, over the code (see "Stackification
as built").

## Structured control flow

Wasm needs structured control flow; `csc`'s IL is always reducible, so the
importer uses the dominator-tree algorithm of "Beyond Relooper" (Ramsey,
ICFP 2022): blocks are emitted in reverse postorder, a loop header opens a
`loop`, a merge node (more than one forward predecessor) is the target of an
enclosing `block`, and every branch becomes `br`/`br_if`/`br_table` to one of
those labels. `switch` becomes `br_table`. An irreducible graph (not from
`csc`) is rejected with a diagnostic; node splitting can come later.

Exception regions are structural constraints. Each protected region and
each handler is structured as its own subgraph, entered only at its first
block (ECMA-335's rule) and left only by `leave`, `throw`, `rethrow`,
`endfinally` or `endfilter`:

- **catch**: the try body in a `try_table` catching the module's tag; the
  handler receives the exception object, tests the clauses sharing the try
  region in order (`isinst` of the catch type), runs the first match, and
  rethrows otherwise. This is `FunctionEmitter.Exceptions`' lowering, fed
  from IL regions instead of `ITryOperation`.
- **finally/fault**: the protected region in a `try_table` with
  `catch_all_ref`; every `leave` out of it records its target index and
  falls into the finally body, which ends by rethrowing the caught
  `exnref` or dispatching (`br_table`) to the recorded target; `endfinally`
  branches to that dispatch. This is the existing "routed through the
  finally" scheme.
- **filter**: the existing two-pass machinery (`Frontend.Filters`): a
  filter block becomes the try statement's selector function. Its IL is a
  subgraph ending in `endfilter`, lowered in its own function over the
  enclosing method's locals, which are hoisted to an environment as
  `Frontend.Captures` does for source filters.

## Byrefs

The existing model (`Frontend.References`) already has what IL needs: "a
reference to a struct is its box; a reference to anything else is a `$ref`
struct of its type: the cell of a variable, or a handle naming an array
element or a field". So:

| IL | lowering |
|---|---|
| `ldloca`/`ldarga` of a struct | the local's box (the importer boxes every struct local or argument whose address escapes: not one read or written through at once, nor an `in` argument of a module method, which takes the value) |
| `ldloca`/`ldarga` of anything else | the local's cell (likewise allocated at entry) |
| `ldflda` of a struct field | the field's storage box (a class's struct fields are boxes already) |
| `ldflda` of a scalar or reference field | a field handle (object, field number) |
| `ldsflda` | a static field handle |
| `ldelema` | the element's box (struct) or an element handle (array, index); `readonly.` skips the covariance check |
| `ldind.*`/`stind.*`/`ldobj`/`stobj`/`cpobj`/`initobj` | the type's load and store functions |
| struct `this` | the box, as the `IOperation` frontend's mutating struct methods take it; `readonly` members may take the flattened value |

A byref's type decides its representation, and IL gives every byref its
exact type, so no escape analysis is needed beyond "is its address taken".
`ref` fields and byref-like types (`Span<T>` is the runtime's struct of an
array, a start and a length) follow the same model. What has no
representation (pointers, `localloc` outside a `Span`, `Unsafe.As` between
unrelated layouts, `ldftn` escaping into arithmetic, `calli`) is rejected
where it appears; `Unsafe.Add` on a byref from an array element is an
element handle with a moved index, one of the intrinsics bclscan's FoldC
scenario lists.

## Generics

Generic instantiations are monomorphized (`EnsureInstance`,
`Substitution`) under a cap of 2048 instantiations per definition, but in
IL mode the instantiations over reference types share one representation
and, where more than one of them runs it, one body. Value-type
instantiations stay monomorphized: their layouts differ (a `List<int>`
holds an `i32` array, a `List<Vector3>` an array of flattened structs). A
mixed instantiation (`Dictionary<string, int>`) shares over its reference
arguments and keeps its value arguments.

### Shared generics as built (phase 4)

What the framework assemblies did to monomorphization, before sharing:
`tests/Linq.cs` went from 585 instantiations (0.72 MB, the IOperation
frontend's runtime Linq) to 1515 (2.07 MB), of which 672 had only
reference type arguments, 518 only value types and 325 both. The growth
came as much from System.Linq specializing by source and element type
(every iterator an operator may make was kept) as from the number of
element types, so sharing alone could not undo it; the closed-world
pruning below is the other half.

**Representations** (`Frontend.Sharing`). A closed type's canonical form
has `object` for every reference type argument (a value type argument
keeps its type, its own arguments canonical). Instantiations of one
canonical form have its representation: `List<string>` and `List<Enemy>`
one heap type and vtable type (a `shared` supertype each exact class
extends with its own vtable global), `Func<string, bool>` and
`Func<object, bool>` one delegate layout, `KeyValuePair<string, int>` and
`KeyValuePair<Enemy, int>` one flattened struct, and every array of
references one family (arrays of `eqref`, each element type's exact array
a final subtype, which allocation uses and type tests read; a load casts).
What tells exact instantiations apart is kept beside the representation:
each exact class has its own vtable global and a class id (DFS-numbered,
in the root vtable, so a class test is a range check), each exact
interface its own itable id (itable types are per canonical interface),
each boxed value type its own box, each delegate type its own id. Reference
cells (`ref T`) and fields of type-parameter type are `eqref` storage,
cast on load. Functions take and return their canonical forms' types (an
override its slot's), so vtable, itable and delegate functions line up
however their code is instantiated; callers cast results to the exact
type and bodies cast the arguments they declare more exactly on entry.
Exceptions are never shared (catch clauses test heap types), nor the
framework types the module layer stands in for.

**Code** (`Frontend.SharedCode`, `FunctionEmitter.SharedCode`). A
method of an instantiation over reference types runs its canonical form's
code, compiled once over `object`, where its lowering does not depend on
the exact type arguments. Each instruction that does (a cast or type test
of `T`, `new T[n]`, `new List<T>()`, `typeof(T)`, a static field of
`C<T>`, a call into another instantiation, `EqualityComparer<T>.Default`
and the other intrinsics decided by T) is a site of the code:

- a **Thunk** site calls through the exact instantiation's dictionary: a
  struct of functions, one per such instruction, each the instruction
  lowered as the exact instantiation lowers it (an `ExactStep` plan,
  deduplicated by what it does: its opcode, exact operands and stack);
- a **Function** site calls the exact instantiation's method, whose
  function the dictionary holds;
- a **Direct** site is lowered once over the canonical form (a call of
  canonical code, a vtable slot) but reaches what each instantiation has
  of its own, which discovery walks per instantiation.

An instance method of a class finds its dictionary in `this`'s vtable (a
class's dictionary extends its base class's, as a prefix); a static
method, a struct's method and a generic method take it as a hidden last
parameter, which each exact instantiation's entry function (a
`SharedEntry`) passes. Discovery analyzes each exact use of shared code
in exact types (`ExactFlow`), which is what fills its dictionary and
walks its Direct sites. A method stays per instantiation where its code
folds by its exact type arguments (`typeof(T) == typeof(string)`), has
filters or catch clauses of them, or initializes static state of them
(a precise static constructor of a type over its shared parameters); a
`beforefieldinit` class's statics are per exact instantiation through
Thunk sites.

**Only where it pays.** Shared code with its dictionaries and entries is
larger than one instantiation's own code, so after a first discovery the
canonical methods that only one exact instantiation used are compiled per
instantiation (discovery restarts with them unshared), and a module none
of whose code stays shared is compiled without sharing at all, so its
representations are the exact ones. `GAMEPLAYC_SHARING=0` turns sharing
off; `GAMEPLAYC_DEBUG_SHARING` prints each decision and site.

Not shared, by design or not yet: value-type instantiations; methods whose
IL is replaced by the module layer (intrinsics, shims); exceptions.

**The default comparers.** `EqualityComparer<T>.Default` is one object
per exact instantiation (a static of `DefaultEqualityComparer<T>`), whose
`Equals` and `GetHashCode` are the runtime's `Equal` and `Hash`
intrinsics: Thunk sites, lowered per exact `T` as the CLR chooses its
comparer when it creates `Default` (`FunctionEmitter.EmitEqual`). A `T`
implementing `IEquatable<T>` compares by its `Equals(T)`
(`GenericEqualityComparer`), a nullable by its value's
(`NullableEqualityComparer`), anything else by `Equals(object)`
(`ObjectEqualityComparer`): a class's or struct's override, or identity, or
a struct's fields each by its own `Equals(object)`, as `ValueType.Equals`
compares them. So `List<Odd>.Contains`, where it runs the canonical
`List<object>`'s code, calls `Odd`'s `IEquatable<Odd>.Equals` through its
dictionary. A shared
struct's layout is its canonical form's, over `object`, so its fields
compare and hash by the exact instantiation's field types
(`Frontend.ExactFieldTypes`), each read cast to its own. `Comparer<T>.Default`
is chosen alike: an `IComparable<T>` of `T`'s, or, contravariantly, of a
base class or interface's (`Frontend.ComparableCompareTo`); for a `T` of
the non-generic `IComparable` alone, its `CompareTo(object)`
(`ObjectComparer<T>`), and for a nullable its value's order, no value first
(`NullableComparer<T>`), whose arrays the runtime's sort orders by
`Compare` rather than by the values' `<`, as the CLR's `ArraySortHelper<T>`
does (the `SortsByComparer<T>` intrinsic, folded per instantiation).
These call an interface member's implementation directly, where the CLR
calls through the interface; a class of the module deriving from `T` that
re-implements the interface (lists it again and declares its own member)
is tested for, most derived first, and runs its own
(`Frontend.Reimplementation`, whose implementations discovery compiles as
classes appear), as an interface call through its itable does.

`tests/Sharing.cs` runs against the CLR what sharing must keep apart per
instantiation: boxes and registries over several reference types, generic
methods and their dictionaries, comparers (over types whose `Equals(T)`
and `Equals(object)` disagree), statics and class initialization per
instantiation, virtual and generic virtual methods, variance, and nested
generics. `tests/Equatables.cs` runs such types through
`EqualityComparer<T>.Default`, the collections, System.Linq, records,
tuples and shared code.

### Closed-world pruning (phase 4)

A module is a closed world: every object it will ever hold is made by its
own code, and code converts a value to another type only where its IL does
(`Frontend.ClosedWorld`).

- **Arrays that do not escape.** Discovery notes, in exact types, each
  array IL converts to another type (an argument, a store, a return, a
  cast, the join of two paths; a type test of it) or passes where a
  method only tests it for null (as `ArgumentNullException.ThrowIfNull`
  does, which does not count). The others are only ever their own type,
  so they get none of what arrays of unknown type need: the non-generic
  and covariant collection interfaces' members, Type objects and names,
  store checks.
- **Type tests of what the module never makes.** A module is compiled
  again in the world its first compilation made: the classes and boxes
  whose vtables were kept, the arrays that escaped, whether it has
  strings. `isinst X` of an X none of them can be folds to null, and
  `x.GetType() == typeof(X)` to false (`IlAnalysis.Fold`, then branches on
  them as on constants), so the branches only such tests led to are not
  compiled, nor what they make: System.Linq's specializations for
  sources the module never has (`ArrayWhereIterator` when no array is ever
  an `IEnumerable<T>`). Classes are taken from the last compilation
  whose world was sound (each compilation walks a part of what that one
  did, so it makes a part of it); arrays are taken optimistically, none at
  first (an array reaches a Linq operator's `is T[]` test mostly through
  the operator's own `[]` behind that test), and a compilation is kept
  only when every array it lets escape, including each a folded test
  would have tested, was in its world; otherwise the escaped arrays are
  added and it compiles again. Discovery decides which arrays escape, so
  a compilation that does not hold is not emitted. At most six
  compilations; the last sound one is the module. In shared code only tests independent of the shared
  type arguments fold. `GAMEPLAYC_CLOSED_WORLD=0` compiles once;
  `GAMEPLAYC_DEBUG_ESCAPES=1` prints each escape and folded test.

### Measurements (phase 4)

Bytes (and instantiations: canonical forms / exact instantiations, from
the final compilation's `GAMEPLAYC_STATS`); the fuzzer's figure is the
average module of seeds 1 to 200 (`--recover-after-trap`, fuzz limits).

| module | before | sharing | + array escapes | + type-test folding |
|---|---|---|---|---|
| `Where`/`Select`/`Sum` over a `List<int>` | 55,482 (79) | 55,520 | 55,485 | 48,002 (66/66, no sharing) |
| `tests/corpus/LinqQuery.cs` | 180,622 (146) | 182,286 | 180,973 | 154,370 (133/144) |
| `tests/Linq.cs` | 2,071,825 (1515) | 1,872,209 | 1,716,931 | 1,580,090 (876/1336) |
| `tests/Anonymous.cs` | 690,212 (642) | 627,319 | 617,436 | 613,063 (260/599) |
| `examples/breakout` | 15,349 | 15,586 | 15,586 | 15,349 (no sharing) |
| `examples/console` | 9,086 | 9,150 | 9,150 | 9,086 (no sharing) |
| fuzzer, average | 266,499 | — | — | 236,137 |

With the closed world but without sharing (`GAMEPLAYC_SHARING=0`):
LinqQuery 153,612, Linq 1,701,631, Anonymous 628,423. Sharing pays where
several reference instantiations run the same code (Linq over tuples,
anonymous types and strings); in the fuzzer's programs most instantiations
are over value types and most of a module is the runtime's own code, so
the pruning is what moves them. Source mode is unchanged, byte for byte.
The compilations cost compile time where tests fold: `tests/Linq.cs`
takes four (about 7.5 s instead of 5); a module where nothing folds, such
as breakout, takes no more than it did without pruning. What a
compilation asks of the symbols alone (tuple names, conversions, keys)
is kept for the next, and discovery only looks again at what is new to
it (`GAMEPLAYC_TIMINGS=1` shows where the time goes).

### Variance as built (phase 4)

Variance needs no runtime type descriptors: a module is a closed world,
every class, interface, delegate and array type it has is known when it
is emitted, so variance is decided there, per type, instead of per object
(shared code's instantiations included, by their exact ids):

- **Variant interfaces.** A class (or box) has, besides the itables of the
  interfaces it implements, one for each of the module's interfaces those
  convert to by variance (`Frontend.Implemented`: an `IEnumerable<Animal>`
  itable for a `List<Bird>`, an `IComparer<Bird>` one for a
  `Comparer<Animal>`), whose members run what the class runs for the
  interface it implements (`Implementation`). Interface values are any
  references and the parameters and results of the two members' functions
  are subtypes of each other in the variance's direction, so the itable's
  thunks need no casts. Type tests and casts read itables as before, and
  pruning keeps a variant itable's members where code dispatches through
  the variant interface (`Reaches`). Variant interfaces of the user's
  own are accepted.
- **Arrays as variant interfaces**: an array is an `IEnumerable<E>`,
  `IReadOnlyList<E>`, ... of any `E` its elements convert to by
  reference; a call tests for each of the module's array types that may be
  one, and runs `corelib/ArrayCollections.cs`'s covariant members over
  it (whose stores check the value's type and throw
  `ArrayTypeMismatchException`); `x is E[]` holds of each of those arrays.
- **Variant delegates.** Delegate types share a representation only by
  their lowered signatures, so a delegate converted by variance (a
  `Func<Bird>` as a `Func<Animal>`) is a new delegate of the target's
  representation, of the original's type and method, whose function
  forwards to the original (`Frontend.DelegateVariance`). It is not the
  original object, so it is not `==` to it (the CLR's is); combining or
  removing delegates of two types throws `ArgumentException`, as the
  CLR's does.
- **Array covariance** proper (`object[] a = new string[1]`,
  `Frontend.Arrays`). Arrays of different element types have unrelated
  representations, so a module that converts an array to an array of
  `E`, or tests an object for an `E[]` other arrays convert to, is
  compiled again with the arrays of the references that convert to `E` in
  one family: each such array's type is the family's (an array of `eqref`,
  `$refarray`), and each element type's exact array type a final subtype of
  it, which allocation uses and type tests (`is`, `castclass`, `GetType`)
  read. A load casts the element to its type. A store into an array whose
  element type has subtypes with arrays in the module tests the value
  against the array's exact element type and throws
  `ArrayTypeMismatchException`, as `stelem.ref` does (for delegates, by the
  type id each carries, since delegate types of one signature share a
  representation). Modules without such conversions keep exact array
  types, so their sizes do not change. `tests/IlAccepted.cs`'s
  `ArrayCovariance` runs reads, stores that throw, tests, `Array.Copy`,
  `Array.Sort`, `string.Format`/`Join` over `object[]`, enumeration and
  arrays of delegates against the CLR.

## CoreLib and type-reference resolution

User code compiles against .NET's reference assemblies (`System.Runtime`,
`System.Collections`, `System.Linq`, `System.Memory`,
`System.Runtime.InteropServices`, `System.Threading`: the pinned SDK's
targeting pack, embedded in the compiler), so its API surface, overload
resolution and diagnostics are .NET's. The importer then reads it over the
gameplay CoreLib (`Gameplay.CoreLib`, embedded too) instead of those
assemblies, as the runtime's type forwarding reads it over
System.Private.CoreLib: each reference assembly is stood in for by a facade
of its identity (name, version and public key, copied from it) whose
exported types forward every public CoreLib type to the CoreLib
(`Frontend.CoreLib`). The metadata compilation is built over the CoreLib,
the facades and the user's assembly; the CoreLib, which references nothing
and defines `System.Object`, is its core library, so Roslyn's
`SpecialType`s are CoreLib's and every special-type check in the module
layer keeps working. A reference to a type or member the CoreLib does not
have is an error at the instruction that names it ("is not in the gameplay
CoreLib").

The CoreLib is built in the build graph (`:corelib`) by coresurface, the
Roslyn tool below, which compiles it with the pinned Roslyn as a core
library (no references), from four parts:

- **The runtime layer** (`runtime/*.cs`, which the retired frontend
  compiled with every program). Its types have the framework's names where
  they stand for framework types (`List<T>`, `Dictionary<TKey, TValue>`,
  `StringBuilder`, `Random`), with the shapes code compiled against .NET
  needs (disposable struct enumerators, say).
- **CoreLib's own sources** (`corelib/*.cs`): what only IL needs (.NET's
  overloads of the span extensions C# 14 binds array calls to,
  `CollectionsMarshal.SetCount` for collection expressions, `Interlocked`
  for field-like events, `Monitor` for `lock`), generic math
  (`corelib/GenericMath.cs`: the primitive types' explicit implementations
  of the `System.Numerics` interfaces, and `corelib/Numbers.cs`, their
  conversions, decimal's included; decimal's own, `runtime/DecimalMath.cs`,
  are dotnet/runtime's Decimal.cs generic-math members ported onto the
  runtime's decimal struct, which gameplay code's `System.Decimal` is, so a
  constrained call over decimal finds them where it looks, on that
  struct), and the types phase 3 adds: `Guid` (its own: .NET's is
  SIMD and unsafe code throughout), the invariant culture's `DateTime` and
  `TimeSpan` formatting, `Int128`'s decimal text, the host services. A
  partial declaration of a surface type that marks itself `[Surface]` (the
  primitives' generic math, `Math`'s integer members, the argument
  exceptions' `ThrowIf` helpers) keeps the type .NET's for the module layer
  while its static members with bodies are CoreLib IL, compiled where a
  (constrained) call reaches them.
- **dotnet/runtime's implementation sources**, where they fit
  (`DOTNET_RUNTIME_IMPLEMENTATION_SOURCES`: `Lazy<T>`, `TimeSpan`,
  `DateTime`, `DateTimeOffset`, `Stopwatch`, `Int128`, `UInt128`,
  `ThrowHelper`, System.Numerics' vectors and `BigInteger` and `Complex`,
  fetched and pinned like the reference sources), with
  `System.SR` generated from their `Strings.resx` files so they throw
  .NET's messages. A type they define replaces the surface's; each member that
  does not compile against the rest is dropped (the report's "unused"
  lines: parsing, `TryFormat`, serialization, `IConvertible`), unless it
  overrides, which CoreLib's sources must then provide (the `ToString`s);
  a member CoreLib's sources define wins over theirs.
- **The framework surface**, generated: `corelib/generator` (coresurface)
  reads dotnet/runtime's
  reference-assembly sources (`src/libraries/*/ref/*.cs` at the
  `v11.0.0-rc.1.26425.128` tag, the release the targeting pack was built
  from, fetched as single files with their sha256 by
  `runtime/dotnet`), keeps the types
  `corelib/surface.txt` allows, makes every member with a body `extern`,
  and drops what then fails to compile (members whose signatures name a
  type left out, base interfaces, attributes), until the surface and the
  sources compile together. A type the sources define replaces .NET's; one
  they declare `partial` is merged with it member by member, the sources'
  members winning (`MemoryExtensions`, `Enumerable`). Surface types carry
  `[Gameplay.Runtime.Surface]`: the module layer treats them as it treated
  the reference assemblies' framework types (special types,
  `RuntimeCounterpart`, shims, intrinsics), and CoreLib's other types as
  the runtime layer's. Its report
  (`buck2 build :corelib[report.txt]`) lists the types kept, the
  declarations dropped and why, and the members .NET's types have that
  CoreLib's own lack: the work list for matching .NET's surface.

The canonical ABI glue witgen generates calls the runtime layer's boundary
memory (`Gameplay.Runtime.Memory` and `Canonical`, public in the CoreLib):
the sources also compile against `Gameplay.Abi`, a reference assembly of
those members made from the CoreLib's metadata when IL mode starts, and a
facade forwards it like the others. As in source mode, only the CoreLib
and `[CanonicalAbi]` code may call them, and the first call gives the
module its memory and `cabi_realloc`
(`examples/console:console-host-test` plays the console Breakout compiled
this way).

The surface is what makes `surface.txt` the API allowlist at type
granularity: a type it leaves out does not exist for gameplay code, and a
member naming one is dropped with it.

Host services are host imports, declared in the CoreLib with its
internal `[HostImport]` (`corelib/Host.cs`) and imported only when used:
`gameplay.clock-utc` (microseconds since the Unix epoch, for
`DateTime.UtcNow` and `Now`), `gameplay.clock-monotonic` (nanoseconds, for
`Stopwatch`) and `gameplay.random` (64 bits, for `Guid.NewGuid` and
`CreateVersion7`). The local time zone is UTC.

IL shows what the `IOperation` frontend lowered itself, and the importer
keeps modules as small as source mode's by recognizing it: a
beforefieldinit static constructor that only stores constants, arrays and
trivially constructed objects in its class's fields runs eagerly (no lazy
initialization, so no exception handling); what C# synthesizes for a
record is registered on demand, as source mode synthesizes it; `record ==
null` is a reference test; an auto-property getter is a read of its field;
and a `finally` that only disposes of a struct whose `Dispose` is empty (a
`List<T>` enumerator's, in `foreach`) is dropped. The CoreLib's static
classes keep no static fields, which every module would carry.

## Framework assemblies

Above the CoreLib, IL mode imports the framework's own implementation
assemblies: the pinned SDK's (`:framework` copies them out of the
toolchain's `shared/Microsoft.NETCore.App/<version>/`), so their IL is the
IL the differential oracle's CLR runs, and embedded in the compiler as
`Gameplay.Compiler.Framework.<name>.dll`.

- **Resolution.** Each replaces its reference assembly's facade in the
  import compilation (`Frontend.CoreLib`). What it references that no
  reference assembly stands for (System.Collections is compiled against
  System.Private.CoreLib itself) is a facade of that name forwarding the
  CoreLib's types, which the framework image references by name alone: the
  importer clears those references' public key tokens (`Weakened`). Type
  forwarders chain as the runtime's do: System.Collections forwards
  `List<T>` to System.Private.CoreLib, whose facade forwards it to the
  CoreLib.
- **The module's own.** Their types are the module's (`IsModuleDefined`)
  and, like the CoreLib's own, runtime types, registered where code uses
  them, static classes too; a static field is registered where code first
  uses it. What does not fit is left out rather than rejected: a member
  whose signature names a type the CoreLib does not have (serialization's),
  a class's instance field of a type there is no representation of
  (SortedSet's `SerializationInfo`), and a method the lowering cannot take
  (the `IDeserializationCallback` members) becomes a trap that is an error
  only if the module keeps it, as the rest of pruning decides.
- **Folding** (`Il.Folding`), as a JIT folds what it knows of the machine
  and of the instantiation, per instantiation: `typeof(T).IsEnum` and
  `IsValueType`, a call of a hardware
  intrinsic's `IsSupported`, a vector's `IsHardwareAccelerated` (true of
  Vector128 alone, "SIMD as built"),
  `RuntimeFeature.IsDynamicCode*`, `RuntimeHelpers.IsBitwiseEquatable<T>`
  (false), `RuntimeHelpers.IsReferenceOrContainsReferences<T>` (from `T`),
  `IntPtr.Size` (8, as on the oracle's CLR), a
  `[FeatureSwitchDefinition]` property (the CLR's defaults,
  `Frontend.FeatureSwitches`: `System.Linq.Enumerable.IsSizeOptimized` is
  false) and `typeof(T) == typeof(X)` is the constant it returns, and a
  conditional branch on a constant is unconditional. The paths not taken are
  never typed, walked or lowered, and a token among them that names what
  the CoreLib does not have (`Vector128`'s members) is no error: a token
  that does not resolve is one only where an instruction reached names it,
  and a block folding leaves unreached is no exit of the try block it is
  in.
- **Messages.** A framework assembly's `SR` properties look their message
  up by key in the assembly's resources; the importer reads the resources
  (`IlModule.ResourceStrings`) and a call of one is the message itself, so
  the framework throws .NET's messages without a ResourceManager.
- **What the CoreLib adds for them**: `Array.MaxLength` and
  `Array.LastIndexOf`'s overloads; `Array.Clear` and `Array.Copy` of
  one-dimensional arrays of one element type, as IL's stack types show them,
  are the CoreLib's generic `ArrayMethods` (`Frontend.ArrayRedirect`);
  `BitOperations.Log2`, `IsPow2` and `RoundUpToPowerOf2`; a
  `NonRandomizedStringEqualityComparer` that never wraps (strings' hashes are
  not randomized here); `Unsafe.NullRef<T>` and `IsNullRef` as a null
  reference. .NET's non-generic collection interfaces and the rest of its
  generic ones (`ICollection`, `ISet<T>`, ...) are adopted as the
  enumerable ones are, but for the members this representation has no
  signature for (`ICollection.CopyTo(Array, int)`).
- **Itables are pruned** like vtables: an itable member keeps its function
  only where code calls the member through the interface. The framework's
  collections implement far more interface members than code calls.
- **Arrays are the CLR's collections.** In IL mode an array is an
  `ICollection<T>`, `IList<T>`, `IReadOnlyCollection<T>` and
  `IReadOnlyList<T>` of its elements, as System.Linq passes them, and the
  non-generic `IEnumerable`, `ICollection` and `IList` whatever its
  elements; values of those interface types are any references, as
  `IEnumerable<T>`'s are. A member call tests for an object first, then
  runs the CoreLib's implementation for arrays (`corelib/ArrayCollections.cs`,
  as the CLR's `SZArrayHelper` behaves: a fixed size, .NET's messages, and
  `Contains` and `IndexOf` of references by `Equals(object)`, as its shared
  code compares them, not by `IEquatable<T>`); for
  the non-generic interfaces, the implementation of the element type of each
  of the module's array types, as a closed world lets it test for each. The
  CoreLib's collections enumerate as non-generic `IEnumerable`s too.
- **Array type tests** are the closed world's: `x is Base[]` holds of an
  array of any of the module's array types whose elements convert to
  `Base` by reference, as array covariance has it (IL mode tested only
  exact element types before, and rejected the rest).
- **Exact type tests**: `x.GetType() == typeof(X)` (System.Linq asks it
  of every source: an array? a `List<T>`?) is folded into a test of `x`'s
  heap type against `X`'s and its subclasses', as RyuJIT folds it, so a
  module needs no `Type` object, and no name, for each of its classes.
- **Boxed numbers' interfaces**: in IL mode a boxed number has the
  itables of the `IComparable<T>`, `IEquatable<T>` and `IComparable`
  code names as types, whose members run the numbers' shims
  (`IComparable<int> x = 5; x.CompareTo(3)` compared nothing and trapped
  before). `IEquatable<T>` and `IComparable` are adopted only once code
  names them as types, so other classes carry no itables of them.
- **Redirects**: a call of System.Linq's operators over `decimal` runs the
  CoreLib's own of the same signature (`Frontend.Redirected`): .NET's are
  generic math over `INumber<decimal>`, which the CoreLib's decimal did not
  implement when these were written (it does now: `runtime/DecimalMath.cs`),
  and the CoreLib's are kept.

Which types come from where, in IL mode:

| types | from |
|---|---|
| `Stack<T>`, `LinkedList<T>`, `SortedSet<T>`, `SortedDictionary<TKey, TValue>`, `SortedList<TKey, TValue>`, `PriorityQueue<TElement, TPriority>`, `OrderedDictionary<TKey, TValue>` (System.Collections) | the SDK's System.Collections |
| `Enumerable` and its iterators, `Lookup`, `IGrouping`, `ILookup`, `IOrderedEnumerable` (System.Linq) | the SDK's System.Linq, but for its operators over `decimal` (the CoreLib's) |
| `List<T>`, `Dictionary<TKey, TValue>`, `HashSet<T>`, `Queue<T>`, the comparers, `KeyValuePair` (System.Private.CoreLib in .NET) | the CoreLib (runtime layer) |
| `ArrayPool<T>` (rents new arrays), `GC.AllocateUninitializedArray`, `AppContext` (no switches set), `DictionaryEntry` | the CoreLib's own, for the framework assemblies |
| `BigInteger`, `Complex`, `Complex<T>` (System.Runtime.Numerics) | dotnet/runtime's sources in the CoreLib, with its own text ("System.Runtime.Numerics as built") |

The CoreLib's own collections (the runtime layer's `HashSet<T>`,
`Dictionary<TKey, TValue>`, ...) gain in IL mode what code compiled against
.NET's reference assemblies relies on: `HashSet<T>` is an `ICollection<T>`,
`ISet<T>` and `IReadOnlySet<T>` with .NET's set operations (in
dotnet/runtime's order of removals and additions, so that enumeration
afterwards is in its order), the collections enumerate as non-generic
`IEnumerable`s, and `Dictionary`'s missing and duplicate keys throw .NET's
messages.

What the framework's IL costs: System.Linq's speed-optimized operators
specialize by source (array, `List<T>`, `IList<T>`, iterator) and element
type, and a module keeps every specialization an operator can reach. A
module using `Where`, `Select` and `Sum` over a `List<int>` is 59.8 KB
against 25.8 KB with the runtime layer's Linq; `tests/corpus/LinqQuery.cs`
180.5 KB against 51.4 KB; `tests/Linq.cs` 2.0 MB against 0.72 MB, with
1501 generic instantiations against 585 (the cap is 2048). The Breakout
modules, which use no Linq, keep their sizes.

## Libraries

A gameplay library is an assembly gameplayc compiled from C# with
`--library Name` (README, "Libraries"): the same reference assemblies,
the ABI reference assembly, language version and options as a module's
sources (`Frontend.EmitAssembly`, which a module's compilation uses too),
under its own name. A module (or another library) names libraries with
`--reference`; its sources compile against them, and the importer imports
their IL as the module's own:

- **Resolution.** The libraries join the import compilation beside the
  module's assembly (`Frontend.ImportCompilation`); they reference the same
  reference assemblies the module does, which the facades already resolve
  to the CoreLib, and each other by name (unkeyed, version 0.0.0.0), which
  the metadata resolver matches (`IlModule` resolves an assembly reference
  by name).
- **The module's own.** A library's symbols are module-defined
  (`IsModuleDefined`, `InLibrary`) but not runtime types: its types are
  discovered as the module's own are, first, in reference order
  (`DiscoverImported`), with the same checks (a `ref` struct, a base class
  that is not a source class, an enum over a non-integer), and their
  members registered and walked as source code's; `IlModuleOf` finds their
  IL, and their PDBs locate what the importer refuses in them. So the
  closed world, pruning, sharing and dispatch see one program: a module
  over libraries is the module compiled from all their sources, up to the
  order of its types. Only the module's own assembly exports
  (`ExportName`); the SDK's attributes are not a library compilation's, so
  a library cannot import or export.
- **API control.** A library is checked when it is compiled and again in
  each module, as the user's assembly is (`CheckUserReferences`), except
  that references into the libraries themselves are not checked: they are
  the module's own types (`MemberReferences` skips a member of a type
  whose resolution scope is a library's assembly reference).
- **Two-pass exception handling** starts when any library has a filter,
  as when the module's own code has one.

What it costs and saves: nothing at run time, and little at compile time,
since the whole program is still imported and lowered per module (a closed
world cannot compile a library's generics or dispatch once for every
module). `tests/Libraries.cs` over its two libraries is 310,193 bytes
against 310,138 compiled from the three sources (types in another order).
Lichgate over Kiln's services as a library (its core but the world half,
below) was 1,411,340 bytes against 1,411,262, and compiled in 10.9 s
against 11.1 s (the library, compiled once, in 1.0 s): Roslyn's share of a
module's compile time is small beside the importer's.

**Kiln.** Kiln's generator wrote the other half of `partial class World`
(its stores, resources, events, bundles and schedule), and a partial
class cannot span a library and a module, so only Kiln's services could be
a library. Kiln is now arranged as Bevy or EnTT are (engine/README.md):
`World` is the library's, typed by no program, and the generator writes
each program a `Kiln.Schedule` subclass that registers its components'
ids, makes each world's storage and runs the query loops phase by phase,
and C# 14 extension properties for the resources, which the importer
compiles as the static methods they are. The world reaches a component's
storage through `Storage<T>`, a static class per component whose table,
indexed by the world's index, is an array of one-field structs: arrays of
references are one `eqref` family under shared generics (each load a
`ref.cast`), arrays of structs keep their exact types, so `world.Get<T>`
reads a global, the world's index, a bounds check, an `array.get` and a
`struct.get`, with neither cast nor call. A Kiln library (a gameplay library
compiled with Kiln's generator, which gameplayc tells it is a library
through `build_property.GameplayOutputKind`, and which marks the assembly
so) contributes components and systems, which the program's generator
reads from its metadata and schedules with its own. Lichgate
over the Kiln library is 1,439,903 bytes against 1,411,262 (the
per-component tables and their registration are code per component),
compiles in about 11.1 s against 10.8 s (the library once, in 1.1 s), and
its autopilot's 12,000 frames spend 0.17% less fuel (a component access
makes three calls fewer; a resource, read through shared code, two more). An
entity's components were then one `ulong` (63 components and an alive
bit); they are now a bitset of as many words as the program's components
need, the generator writing each query loop's test over the words its
components are in, so a program of at most 63 components compiles its
loops exactly as before. Lichgate grew by 5,476 bytes (the world's
per-component members index the entity's words, run-time queries carry the
words past the first) and spends the same fuel.

## API control

What a module can call is what the imported set defines. On top of that,
the importer checks every `MemberRef` and `TypeRef` of every imported
assembly against an allowlist (s&box's approach): a checked-in list of
members, by assembly and signature, that gameplay code may reference
(`System.Linq.Enumerable.*`, `System.Collections.Generic.List`1.*`, not
`System.IO.*`, `System.Reflection.Emit.*`, `System.Threading.Thread`).
User assemblies are checked strictly; the imported framework assemblies are
checked against their own list, so that a new SDK cannot silently widen the
surface. Violations are errors at the referencing IL instruction, located
through the PDB.

As built (phase 4, `Frontend.Allowlist`), at member-reference granularity:

- **The user's assembly**: each `MemberRef` its code makes is
  `Type::Member` (the type's metadata name, a generic definition's for an
  instantiation's member) and is checked against `corelib/allowlist.txt`,
  first matching `allow` or `deny` rule wins, `*` a wildcard, and what no
  rule allows is refused: an error at the first instruction making the
  reference, located by the PDB (`file(line,col): GP1000: 'System.GC::...'
  is not in the gameplay API`). The rules allow what C# emits for its own
  lowering (`Unsafe.Add`/`As`/`AsRef` in inline-array helpers,
  `CollectionsMarshal`'s collection-expression members,
  `Environment.CurrentManagedThreadId` in iterators) and refuse the rest
  of `Unsafe` and `System.Runtime.InteropServices`, the process and its
  hosting (`Environment`, `AppContext`, `GC`), threads, tasks, files,
  reflection beyond a member's name, and `ArrayPool`; the CoreLib and the
  imported assemblies bound the rest (`corelib/surface.txt` keeps its types
  at type granularity). References to the user's own types, and to its
  libraries' (each library checked the same way, above), are not
  checked. `tests/behavior.mjs` checks refusals and their locations.
- **The imported framework assemblies**: `corelib/framework/<name>.txt`
  lists every member each references in other assemblies, by signature
  (`System.ArgumentOutOfRangeException::ThrowIfLessThan<1>(!!0, !!0,
  String):Void`); an image that references anything else is refused as a
  whole, so an SDK update has to regenerate the list (with
  `GAMEPLAYC_DUMP_REFERENCES=DIR`), which makes what it newly reaches
  reviewable. `TypeRef`s alone are not checked: a type is inert until a
  member of it is referenced.

## System.Runtime.Numerics as built

**Why sources, not the SDK's IL.** System.Runtime.Numerics was to be
imported as System.Collections and System.Linq are, and with native
integers made values (below) its arithmetic's IL imports. What does not is
.NET 11's own use of memory: `BigInteger` is an array of `nuint` limbs that
its code reads and writes as other element types, through
`MemoryMarshal.Cast<nuint, uint>` (Lehmer's step of the greatest common
divisor, rotations), `MemoryMarshal.AsBytes` (the constructor from bytes,
`TryWriteBytes`, the hash); all of its formatting and parsing goes through
pointers into pinned buffers (`fixed`, `TChar*`, `NumberBuffer`'s
`byte*`), and every text entry point reinterprets a span of chars or bytes
as a span of its `Utf16Char` or `Utf8Char` structs
(`MemoryMarshal.Cast<char, Utf16Char>`, `Unsafe.BitCast<Span<TChar>,
Span<char>>`), as `Complex`'s parsing reinterprets a `Complex` as a
`Complex<double>` (`Unsafe.As`). A GC array of limbs is not an array of
bytes or words, a span here is its array, start and length, and a struct
array is an array of boxes, so none of these has a representation, and
they are written through, so no copy stands in. An import would have
needed redirects of those methods, whose replacements name the assembly's
internal types, which the CoreLib cannot. Taking the same files' sources
into the CoreLib keeps the arithmetic .NET's line for line and lets the
few reinterpreting lines be patched.

**The sources.** `BigInteger.cs`, `BigInteger.RentedBuffer.cs`,
`BigIntegerCalculator.*.cs` (with System.Private.CoreLib's
`BigIntegerCalculator.Shared.cs`), `NumericsHelpers.cs`, `Complex.cs`,
`Complex.Generic.cs` and the assembly's `Strings.resx` (merged with
System.Private.CoreLib's by coresurface, the texts they share being equal),
pinned per file at the RC1 tag in `runtime/dotnet`
with the assembly's reference source, whose declarations of `BigInteger`
and `Complex` the sources' replace. Three patches beside them:
`BigInteger.cs.patch` reads a limb a byte at a time where the constructor
from bytes reinterpreted, takes `TryGetBytes`' limb-by-limb loop for every
sign, and swaps a rotation's 32-bit words through the CoreLib's
`SwapUpperAndLowerWords`; `BigIntegerCalculator.GcdInv.cs.patch` takes the
`Int128` path of Lehmer's step .NET takes on big-endian machines;
`BigIntegerCalculator.ShiftRot.cs.patch` gives the words swapped aside an
array of their own. `Number.BigInteger.cs` and `Number.Polyfill.cs` (the
text) are not taken: `corelib/BigInteger.cs` and `corelib/Complex.cs` are
.NET's algorithms over strings for the invariant culture: the decimal
digits by division by 10^9 over 32-bit halves of the limbs, `D`, `G` and
`R` with .NET's quirks (a small value's `G5` pads as `D5`), `X` and `B`
from the two's complement bytes as `FormatBigIntegerToHex` and
`...ToBinary` write them, every other standard and custom format through
the CoreLib's number formatting (`Number.FormatDigits`, `FormatInteger`'s
over any number of digits), and `Parse`/`TryParse`/`TryParsePartial` as
.NET's `TryParseNumber` and `NumberToBigInteger` (styles validated as
`TryValidateParseStyleInteger` does, hexadecimal and binary as two's
complement, decimals and exponents allowed where what they add is zeros,
trailing nulls consumed), UTF-8 overloads through a small transcoder;
`Complex` is `"<real; imaginary>"` with each part formatted and parsed as
`T` does. The hash is `HashCode`'s over the limbs (the CLR's over their
bytes, seeded per process). What the sources need of the CoreLib was
added to it: the span searches of anything but a value
(`IndexOfAnyExcept`, `LastIndexOfAnyExcept`, `ContainsAnyExcept`,
`TrimStart`/`TrimEnd` of a value), `MemoryMarshal.GetReference`, a
`Vector128.LoadUnsafe`/`StoreUnsafe` with an offset, `BitOperations` and
the shims of `nint` and `nuint`, `decimal.GetBits` into a span,
`Int128` and `UInt128` to and from `decimal` (whose own read `decimal`'s
internal fields), `BFloat16`, `Vector256` and `Vector512` in the surface
(so that code testing for them compiles; they fold away), and
`double`/`float`'s `INumberBase` classifications, `ToString(format,
provider)` and `TryParse` with a `NumberStyles` (up to `Float |
AllowThousands`, what `Complex` parses its parts with).

**Native integers** are values now: `nint` and `nuint` are `Scalar.I64` and
`U64` (`IntPtr.Size` folds to 8), so a `nuint[]` is an `i64` array, a field,
local, box or `Vector128` lane of one is a 64-bit one, and
`BitConverter.IsLittleEndian` (true: Wasm is little-endian) and
`Environment.Is64BitProcess` fold. `typeof(T).IsPrimitive` folds as
`IsEnum` does, which lets the primitives' `CreateChecked`,
`CreateSaturating` and `CreateTruncating` ask `TOther`'s conversion when
they have none of their own, as .NET's do (`long.CreateSaturating` of a
`BigInteger`), without costing modules that convert between primitives.

**What else the importer learned.** A struct holding an `[InlineArray]`
buffer (`BigInteger.RentedBuffer`'s 64 inline limbs) gets the buffer's
array when `initobj` initializes it, as a buffer alone always did; an
interpolation hole with a format over one of the CoreLib's own
`IFormattable` structs (`BigInteger`, `Complex`, `DateTime`, `TimeSpan`,
...) calls its `ToString(format, provider)`, as .NET's handler does (it
called `ToString()`); the CoreLib's interfaces of static members only
(`BigIntegerCalculator.IBitwiseOp`, a generic constraint) are not every
module's, having nothing to dispatch; and coresurface tells conversion
operators apart by their result (a CoreLib `explicit operator
decimal(Int128)` had dropped every conversion of `Int128`'s).

**Validation.** `tests/BigIntegers.cs` (`big-integers` in the differential
suite, 12,977 cases) compares against the CLR the arithmetic of 30 values
from 0 to 1000-bit numbers of both signs (division, remainders, `DivRem`,
powers, `ModPow`, shifts of both signs and `>>>`, bitwise operations on
negatives, `GreatestCommonDivisor`, rotations, bit counts, magnitudes),
logarithms and conversions to `double` within an ulp, conversions to and
from the integers, `decimal`, `double`, `float`, `Int128`, `UInt128` and
bytes of either endianness, generic math (`INumber<T>`,
`IBinaryInteger<T>`, `CreateChecked` and the rest both ways), 33 formats
through `ToString`, `TryFormat` (too short a destination included) and
interpolation, parsing of 34 texts under 12 styles (invalid ones throwing),
round trips, and `HashSet` and `Dictionary` of them; `tests/Complexes.cs`
(`complexes`, 8,646 cases) Complex's arithmetic, its elementary functions
within 4 ulps (the CoreLib's transcendentals are not the CLR's), special
values, predicates, formats, parsing and `Complex<float>`/`<double>`.
Both modules run with the largest budgets (1000-bit multiplications take
more than the default steps). `tests/NativeIntegers.cs` (`native-integers`
in the behavior suite) checks what has no CLR counterpart: native integers
as values, lanes and boxes, a deterministic hash that agrees with
equality, known texts, and a computation beyond the default budgets
faulting with 1. The fuzzer's `bignum` feature (`LIBRARY_FEATURES`)
generates BigInteger arithmetic, text and parsing over the program's ints
and Complex's exact arithmetic.

**Deviations.** `GetHashCode` differs from the CLR's (which is seeded per
process); the invariant culture is the only one; a `NumberStyles` beyond
`Float | AllowThousands` for a `Complex`'s parts (currency, parentheses) is
read as that. **Size**: a module multiplying, adding and taking a
remainder of BigIntegers is 108,235 bytes (the calculator's
Karatsuba/Toom-3 multiplication and Burnikel-Ziegler division come with any
multiplication or division, and `UInt128`'s arithmetic with the limb
helpers), one printing a power 99,901, `tests/BigIntegers.cs` 353,215,
`tests/Complexes.cs` 144,959 and a `Complex` product's magnitude 7,078.
Modules without them are unchanged: Breakout 11,484 bytes, the console's
7,346, Fireworks 106,268.

## Generic math as built

**The primitive types** stay the module layer's scalars, whose
`System.Numerics` interfaces the CoreLib implements explicitly in C#
(`corelib/GenericMath.cs`, `[Surface]` partial declarations over the
types' own operators), `nint` and `nuint` among them as the 64-bit integers
they are here. Their `CreateChecked`, `CreateSaturating`,
`CreateTruncating`, `TryConvertFrom...` and `TryConvertTo...` are
`corelib/Numbers.cs`, which follows .NET's split of the conversions
between two types: the primitives' own convert from and to one another, to
and from decimal, and from and to `Int128`, `UInt128` and `Half` (a
128-bit value checked, clamped or truncated to the type's range; a `Half`
as the `float` it converts to exactly; to `Int128` and `UInt128` through
their checked or saturating conversions), so that whichever type a
`Create...` asks first, the pair converts as on the CLR. Decimal's
(`runtime/DecimalMath.cs`) convert to `Half` through `double`, as .NET's
do.

**`Int128`, `UInt128` and `Half`** are dotnet/runtime's sources
(`Int128.cs`, `UInt128.cs`, `Half.cs`, pinned in
`runtime/dotnet`). coresurface drops what of
them does not compile against the CoreLib, and their text (.NET's
`Number` formatting and parsing, over pointers into stack buffers) did not,
nor their byte-order members (`BinaryPrimitives`' 128-bit reads and
writes); with those members dropped, the interfaces they implement no
longer compiled, and were dropped too, so no generic-math member of theirs
existed ("Call ... is not allowed"). The CoreLib's own sources now define
what did not compile (`corelib/Int128.cs`, `corelib/Half.cs`): the 128-bit
integers' formats (the decimal digits by long division, hexadecimal and
binary of the bits, the rest through `Number.FormatDigits`) and .NET's
`TryParseBinaryInteger` over 128 bits (the integer styles' fast path, the
hexadecimal and binary one, and the general one through the number parser
BigInteger shares, `corelib/NumberText.cs`); `Half`'s shortest round-trip
digits by the CoreLib's Dragon4 over its 11-bit significand
(`Number.FormatHalf`) and its parsing, the digits rounded once, exactly,
to 11 bits (`DecimalRounding.Nearest` of a precision and a least
exponent), with .NET's special values; `Half`'s comparisons without the
hardware paths whose tests name x64's and arm64's intrinsic classes; the
bit-layout constants its conversions name on `float` and `double`; and
`BitConverter`'s `Half` members. The rest of each file is .NET's, so the
three implement `IBinaryInteger<T>`, `IBinaryFloatingPointIeee754<Half>`
and the rest as .NET's do. `Half` is an ordinary struct of a `ushort` to
the module layer (it was a type without a representation, which only
folded-away code could name).

**Default interface members.** .NET's numeric interfaces implement some of
their members themselves (`INumber<T>.Clamp`, `IBinaryInteger<T>`'s
`ReadLittleEndian`, `DivRem`, rounding divisions and `Log10`,
`IFloatingPoint<T>`'s `Round` overloads, `INumberBase<T>.CreateChecked`,
the checked operators...), which a type not implementing them runs. The
surface declared them without bodies. coresurface's `--defaults` takes
dotnet/runtime's interface sources (`INumber.cs`, `INumberBase.cs`,
`IBinaryInteger.cs`, `IFloatingPoint.cs` and the rest, pinned with the
others) and merges their members with bodies into the surface's
declarations, which stay the surface's (`[Surface]`, so no itables of them
anywhere), as the CoreLib's hand-written defaults of the checked operators
and `INumberBase<T>`'s creation members did before them. A default member
that does not compile (the UTF-8 `Parse`, `TryParse` and `TryFormat`,
which transcode through `System.Text.Encoding` and `stackalloc`'d
buffers) is dropped after the surface's declaration it replaced, so the
surface is made again without it, keeping the declaration: its report
lists each as "a default member that does not compile". A static default
runs as the CoreLib's IL where a constrained call reaches it; an instance
default (`WriteLittleEndian`) would run on a box of the value with the
interface's itable, which surface interfaces do not have, and stays
unsupported.

**Diagnostics.** A call nothing implements was reported as "Call to '...'
is not allowed. Declare host calls with WasmImport." whatever the reason,
which for generic math over these types (a constrained call reaching .NET's
declaration of an explicit implementation) was wrong on both counts. Every
such site (`Frontend.UnsupportedCall`) now says what the method is and why
nothing runs it: .NET's declaration the CoreLib does not implement, a
member of an assembly the compiler does not import, an extern without
`WasmImport`, or what the module lacks of one of its own (a vtable slot,
an itable member, a dispatcher, a box's function); `tests/behavior.mjs`
checks two.

**Validation.** `tests/WideMath.cs` (`wide-math` in the differential
suite, 2,600 cases) runs against the CLR generic arithmetic, the
`IBinaryInteger<T>` statics and predicates and checked operators over
`nint`, `nuint`, `Int128` and `UInt128` (their byte-order members for the
128-bit ones), `IBinaryFloatingPointIeee754<T>`'s members over `Half`,
the checked, saturating and truncating conversions between every pair of
the 17 numeric types over 50 values each, 32 formats of 14 128-bit values,
the 128-bit integers' and `Half`'s parsing of 45 texts under 10 styles
(partially too), and every one of the 65,536 `Half` values' shortest text,
read back, and a standard format of each. It found two older bugs: `R`
formatted an integer ending in zeros in scientific notation (`1E+03`; it is
`D`'s digits), and a caught exception left the call depth of the frames it
unwound, so a loop catching a few hundred faulted with 2 (a handler now
restores its function's depth).

## Async

- **Roslyn's state machines** are ordinary IL: `IAsyncStateMachine`
  classes calling `AsyncTaskMethodBuilder` and `TaskAwaiter`. CoreLib
  provides `Task`, `Task<T>`, `ValueTask`, `ValueTask<T>`,
  `TaskCompletionSource<T>`, the method builders and awaiters over a
  single-threaded `SynchronizationContext` that the host pumps from its
  frame export: `await NextFrame()` completes on the next frame, and
  `Task.Delay` counts game time. Continuations run under the frame's
  budgets. Blocking on an incomplete task (`.Result`, `Wait()`) is a
  deterministic fault (the only thread would deadlock); `Task.Run`, threads
  and thread-pool APIs are rejected by the allowlist.
- **Runtime-async methods** (`MethodImplAttributes.Async`, 0x2000; 101 of
  them in RC1's CoreLib, none in System.Linq, System.Text.Json or
  System.Threading.Channels; opt-in for our `csc` with
  `/features:runtime-async=on`) are split by the importer: a state-machine
  transform at each `AsyncHelpers.Await` site, with the locals live across
  it moved into a heap frame, producing the same builder protocol.
- **Host async**: `witgen` generates the component model's callback-ABI
  glue for a world's async functions, modelled on wit-bindgen's C#
  `AsyncSupport.cs`, for WASI 0.3 component runtimes and for wlink, which
  links it with its own async runtime: the console's `async-game` world
  waits for its frames that way, and the `game` world's frame loop, which
  `Frames` runs inside the `frame` export, needs none of it. No JSPI,
  stack switching or Asyncify.
  As built: docs/WIT.md, "Async functions" (the glue is its own rather than
  wit-bindgen's, whose C# async support leaves results, failures and
  callbacks unimplemented as of 0.57.1).

### Async as built (phase 5)

**The task library** is the CoreLib's own C# (`corelib/Tasks.cs`,
`Awaiters.cs`, `AsyncMethodBuilders.cs`, `ContinueWith.cs`,
`Cancellation.cs`, `AggregateException.cs`), written after dotnet/runtime's
`Task.cs`, `Task_T.cs`, `TaskContinuation.cs`, `TaskAwaiter.cs`,
`YieldAwaitable.cs`, `ValueTask.cs`, the method builders,
`CancellationTokenSource.cs` and `AggregateException.cs` rather than taken
from them: every one of those is built on the thread pool, ExecutionContext,
TaskScheduler and lock-free state transitions, and would compile against
the CoreLib only with most of its members dropped. What it has: `Task`,
`Task<T>`, `TaskCompletionSource(<T>)`, `ValueTask(<T>)`, their awaiters and
`ConfigureAwait` forms (`ConfigureAwaitOptions` too), `Task.Yield`,
`FromResult`/`FromException`/`FromCanceled`, `CompletedTask`, `WhenAll`,
`WhenAny`, `Delay`, `ContinueWith`, `Wait`, `WaitAll`, `WaitAny` (with
timeouts and tokens), `WaitAsync`, delegate tasks (`Task`'s constructors,
`Start`, `RunSynchronously`, `Task.Run`, `TaskFactory(<T>)` with `StartNew`,
`ContinueWhenAll` and `ContinueWhenAny`, attached children, `Unwrap`:
`corelib/DelegateTasks.cs`, `corelib/TaskFactory.cs`), `TaskScheduler`
(the default, `FromCurrentSynchronizationContext` and code's own:
`corelib/TaskScheduler.cs`), the builders of async `Task`,
`Task<T>`, `ValueTask(<T>)` and `void` methods, `CancellationToken`, its
source (linked, delayed, `TryReset`) and registrations,
`OperationCanceledException`, `TaskCanceledException`,
`ObjectDisposedException`, `AggregateException` (`Flatten`, `Handle`) and
`ReadOnlyCollection<T>`, `SynchronizationContext`, and `ExecutionContext`
with `AsyncLocal<T>` (`corelib/ExecutionContext.cs`). Roslyn's state
machines are ordinary IL, as planned: a builder copies a struct state
machine into a box at its first await that does not complete (the box,
`AsyncStateMachineBox<TStateMachine, TResult>`, is the method's task), and
each await's continuation is the box's `MoveNext`.

- **Order.** Continuations run as dotnet/runtime runs them, which is what
  code can observe: a completing task runs its first await continuation
  inline when it may (the SynchronizationContext it captured is the current
  one, or it captured none and none of a derived type is current), posts
  or queues the others first, runs `ContinueWith` continuations queued
  unless they asked to run synchronously, and the combinators' completion
  actions synchronously; `RunContinuationsAsynchronously` queues them all.
  What the CLR queues to its thread pool goes to the frame loop's queue
  (below) and runs with no SynchronizationContext current, as on a thread
  of the pool. An async method's step, as `ExecutionContext.RunInternal`
  does, restores the current context when it returns.
- **Exceptions.** `await` (and `GetAwaiter().GetResult()`) throws a faulted
  task's first exception itself and a canceled task's
  `OperationCanceledException` (the one that canceled it, or a new
  `TaskCanceledException`); `Result` and `Wait` throw a new
  `AggregateException` of them each time, as `Task.Exception` returns one;
  an async method that throws an `OperationCanceledException` is canceled;
  what escapes an `async void` method is thrown again in the context it
  started in (the frame loop, by default), which ends the frame with the
  exception's fault (17). This module's exceptions keep their message in a
  field (`System.Exception`'s members are the module layer's), so
  `AggregateException`'s message, which the CLR's `Message` override
  composes from the inner exceptions', and `ObjectDisposedException`'s are
  composed when they are made; `ToString` is the override's, over its
  runtime type's name and each inner exception's text, and
  `GetBaseException` .NET's, a type test in `Exception`'s (whose virtual
  members have no slots here).
- **Waiting.** A module has one thread, so nothing completes a task while
  code waits for it: a wait without a timeout for one that has not
  completed (`Result`, `Wait()`, `GetAwaiter().GetResult()`, `WaitAll`,
  `WaitAny`) would wait for ever, as the CLR's does on a single-threaded
  context, and is fault 20 instead (`Intrinsics.Trap`), which nothing
  catches; one with a timeout returns at once what the CLR's returns once
  the timeout has passed (false, or -1 from `WaitAny`). `WaitAsync`'s
  timeout counts game time, as `Delay`'s does.
- **ExecutionContext.** It flows where the CLR's does: an await captures
  it and the async method's next step runs in it (the state machine box,
  and a runtime-async method's resumption), what a method sets before its
  first await does not outlast the call (`AsyncMethodBuilderCore.Start`,
  and a runtime-async method's first step), `ContinueWith`,
  `CancellationToken.Register` (not `UnsafeRegister`), awaiters'
  `OnCompleted` (not `UnsafeOnCompleted`) and `ManualResetValueTaskSourceCore`
  with `FlowExecutionContext` run their callbacks in the context they were
  made in, and what the CLR queues to its thread pool runs in the default
  context, or the one it flows. `AsyncLocal<T>`'s change handlers run on
  each set and each change of context that changes the value; one that
  throws on a change of context faults (17), as the CLR fails fast. The
  module has one thread, so the current context is a static field.
- **Stack.** A task that completes runs its continuations inline only while
  the call-depth budget has room for another await's continuation and for
  queuing the next (16 calls, `Task.FinishContinuations`), as the CLR's
  does only while `RuntimeHelpers.TryEnsureSufficientExecutionStack` says
  its stack has room; past that they go to the SynchronizationContext or
  the frame loop's queue, so a long chain of awaits completing one another
  goes on there rather than exceeding the budget (fault 2).
- **Schedulers.** The default TaskScheduler is the frame loop's queue,
  which stands for the CLR's thread pool: `Task.Run`, `StartNew` and
  `ContinueWith` queue there unless given another (by default
  `TaskScheduler.Current`, the scheduler of the delegate task running, as
  the CLR's), and an await in a delegate task on another scheduler, or a
  `Task.Yield` there, continues on it when no SynchronizationContext is
  current. A thread waiting for a queued delegate task runs it, if its
  scheduler lets it (`TryExecuteTaskInline`): the CLR's only for a wait
  without a timeout or token, the default scheduler for any, since a
  thread of the CLR's pool would have run it meanwhile; so
  `Task.Run(() => 42).Result` is 42. An attached child keeps its parent
  `WaitingForChildrenToComplete` and gives it an AggregateException of its
  exceptions, unless the parent's delegate observed them by waiting.
  Only a module (or a library of it) that names `TaskScheduler` or a
  `TaskFactory` has scheduler code (`Intrinsics.HasTaskSchedulers`, which
  the importer folds); the others queue every delegate task to the frame
  loop, and a module without delegate tasks keeps none of their code (the
  task code every module has reaches it through slots).
- **API control.** `corelib/allowlist.txt` refuses `Parallel`, `Thread`,
  `ThreadPool` and `Timer`, at the instruction that names them.

**Async enumeration** (`corelib/AsyncEnumerables.cs`): an async iterator's
state machine is a class that is its own `IAsyncEnumerator<T>` and the
`IValueTaskSource<bool>` of each `MoveNextAsync`, driven by
`AsyncIteratorMethodBuilder` (whose box is an async method's) over a
`ManualResetValueTaskSourceCore<bool>`; `await foreach` and `await using`
call `IAsyncEnumerable<T>`, `IAsyncEnumerator<T>` and `IAsyncDisposable`
(.NET's, adopted lazily as the interfaces of await are), and
`WithCancellation` and `ConfigureAwait` make the configured enumerables and
disposables of `TaskAsyncEnumerableExtensions` (a class of static members
here, not a static class, whose extension methods code compiled against
.NET's reference assemblies calls all the same). An
`[EnumeratorCancellation]` token and the enumeration's are linked by
`CancellationTokenSource.CreateLinkedTokenSource`, as C#'s lowering asks.
`ManualResetValueTaskSourceCore` posts a continuation that captured a
SynchronizationContext, and runs one that did not inline (unless it runs
continuations asynchronously), restoring the current context afterwards,
as the CLR's does; a continuation registered after completion is posted or
queued, never run inline.

**The frame loop** (`corelib/Frames.cs`) is the module's thread. The public
API is `Gameplay.Frames`, which gameplay code compiled against .NET's
reference assemblies sees through the same reference assembly as the
canonical ABI's members (`Gameplay.Abi`, now with read-only static
properties): `Frames.NextFrame()` is a task that completes when the next
frame starts; `Frames.Advance(TimeSpan elapsed)`, which the module's frame
export calls, starts it (game time moves on by `elapsed`), completes the
tasks waiting for it, then the delays that are due (in the order they are
due, those due together in the order they started), then runs what is
posted until nothing is left (so `Task.Yield` resumes in the same frame,
and `NextFrame` is how to wait for the next); `Frames.Count` and
`Frames.Time` are the frames and game time so far. Its SynchronizationContext
is the current one unless code sets another, so await continuations come
back to the loop as a game engine's main-thread context brings them back to
its main thread; everything runs inside the frame export's call, under its
fuel, depth and allocation budgets. `Task.Delay` and
`CancellationTokenSource`'s delays count game time, in the CLR's whole
milliseconds. Each waiting task, due timer and posted item leaves its queue
before it runs, so what a trap interrupts is where the next frame finds it,
and a frame a trap abandoned (with `--recover-after-trap`) does not count as
running: `Advance` refuses to run inside a frame by the call depth
(`Intrinsics.CallDepth`), which any call inside a frame exceeds. For
ordinary .NET projects (IDE support, the CLR oracle), `sdk/Frames.cs` is the
same loop over the CLR's SynchronizationContext, whose context becomes
current on the thread that first uses it; `Task.Delay` there is the CLR's.

**An example**: `examples/console/Fireworks.cs`, a console game written as
coroutines (`NextFrame`, `Task.Delay`, `Task.WhenAll`, a
`CancellationToken` that Start cancels), which the console's headless host
plays to its end (`:fireworks-console-host-test`). Its module is 122,847
bytes, of which the task library and the frame loop are about a third of
the code (Breakout's console module is 9,086).

**Size.** A CoreLib static class's members and a non-generic interface of
the CoreLib's are every module's (their static fields and the types their
signatures name), so the task library has neither: its helpers are sealed
classes of static members, its internal abstractions abstract classes, and
the interfaces of await (`IAsyncStateMachine`, `INotifyCompletion`,
`ICriticalNotifyCompletion`, `IValueTaskSource(<T>)`) are .NET's, adopted
once code names them as types (`Frontend.IsLazilyAdopted`), as
`IEquatable<T>` is. A module without async is byte for byte what it was:
Breakout 15,349 bytes, the console's Breakout 9,086.

**Validation.** `tests/Async.cs` runs against the CLR (IL mode's
differential suite), each case under a single-threaded SynchronizationContext
of its own (`Pump`, installed on the CLR's thread and in the module alike and
drained by the case), so that continuations run in the order the task
library decides on both and never on the CLR's pool: awaits and their
order, `ValueTask`, async void, results, exceptions and their identity,
the tasks `FromResult` caches, combinators, `ContinueWith` that runs
synchronously, cancellation, async iterators (`await foreach`, `break` and
the iterator's `finally`, exceptions, `WithCancellation` and linked tokens,
enumerators by hand, enumerating twice), `await using`, an
`IValueTaskSource<T>` of the test's own over
`ManualResetValueTaskSourceCore<T>`, schedulers (a `Lane` of the test's own
that queues in order and runs inline only when told to: `StartNew`,
`TaskFactory`, `Start`, `RunSynchronously`, `ContinueWith` on it, attached
children, awaits and `Task.Yield` continuing on it, inline waits, `Unwrap`,
`FromCurrentSynchronizationContext`, a scheduler that throws), the frame loop (the CoreLib's
against `sdk/Frames.cs`, an async iterator over frames too), where the
ExecutionContext flows and where it does not (awaits, `Run`, `Capture`,
`Restore`, suppressed flow, change handlers, `ContinueWith`, `Register`,
`OnCompleted`, async iterators), and waits with timeouts and `WaitAsync`
with tokens. A case's result is the hash of what it traced, and
`LastLength`/`LastChar` read the trace on either side. `tests/Frames.cs`
(`frames` in the behavior suite, IL mode only) checks what has no CLR
counterpart: delays and `CancelAfter` in game time, timeouts with `WhenAny`,
what runs from the queue with no context current (`ConfigureAwait(false)`,
`ContinueWith`) and in which ExecutionContext, fault 20, an async void
exception ending a frame, a frame running out of fuel, a chain of 300
awaits that completes from the queue rather than exceeding the call depth,
`WaitAsync` timing out in game time, and `Task.Run` on the default
scheduler (`.Result` running its task inline). The suites found two older bugs in IL mode,
fixed with regressions in `tests/IlRegressions.cs`: a struct without fields
passed as a parameter took the next local's id (`VoidTaskResult`), and
`GetType` of an exception typed as a base class answered `Exception` (the
type tests were ordered by depth over source classes only).

**Deviations from the CLR.** `Task.Delay`, `CancelAfter` and `WaitAsync`'s
timeouts count game time; there is no unobserved-exception event (no
finalizers, and no `EventHandler<T>`) and no `TaskFactory.FromAsync`; `Wait`
with a timeout of an incomplete task returns at once rather than after the
timeout (nothing could complete it meanwhile), but first runs it if the
default scheduler queued it; `CancelAsync` runs the
callbacks from the frame loop's queue; `Task.Id` counts per module;
`Task.FromResult` caches the tasks of null, bools, the ints -1 to 8 and the
primitives' zero, not of every unmanaged struct's default as the CLR does;
continuations stop running inline sixteen calls short of the call-depth
budget, where the CLR's stop near its stack's end, so a chain of awaits
deep enough to come near it continues from the queue sooner than the
CLR's; the frame loop runs the thread pool's work on the module's one
thread, switching to its ExecutionContext and back, so an `AsyncLocal<T>`
change handler sees those switches where the CLR's would see them on a
thread of the pool. The CLR does not order what it runs on its thread
pool, so the differential cases never let it (`tests/Async.cs` explains).

### Runtime-async methods as built (phase 5)

**Whether imported code needs them.** No. The CoreLib is this project's
own, compiled without runtime-async, and of the framework assemblies IL
mode imports, System.Collections and System.Linq have no method with
`MethodImplAttributes.Async`; bclscan over RC1's closure of the core
entry points (the FoldC scenario, which is what the importer can reach)
finds none reachable either (the 101 counted above in
System.Private.CoreLib are all outside that closure). So the splitter is for gameplay code compiled
with runtime-async, which csc does with `/features:runtime-async=on`:
gameplayc's `--runtime-async` (`runtime_async = True` in
`gameplay_module`), IL mode only.

**The split** (`Il.RuntimeAsync.cs`, `Frontend.RuntimeAsync.cs`,
`corelib/RuntimeAsync.cs`). Such a method's IL is written as if it ran to
its end, awaiting with `AsyncHelpers.Await` (or `AwaitAwaiter` and
`UnsafeAwaitAwaiter` for other awaiters), and returns its result, not a
task. The splitter rewrites it into two bodies of IL of the compiler's own
(`IlCode` with synthetic operands and pseudo-instructions), which the
importer then compiles as any IL:

- the **kickoff**, which callers call: its arguments and locals are cells
  (the escaping storage of captured variables) that a frame struct holds;
  it makes a `RuntimeAsyncTask<T>` and the continuation, an `Action` whose
  target is the frame and whose function is the step, runs the first step,
  and returns what an async method's builder would (a result it completed
  with before suspending as `Task.FromResult`'s, `Task.CompletedTask` or a
  `ValueTask` of it; `RuntimeAsync.Return*`);
- the **step**, which the continuation runs: the method's own IL over the
  frame's cells, entered by a dispatch on a state at the start of the body
  and of each try block around an await (a try block is entered at its
  start, as in C#'s state machines), where each await became `GetAwaiter`,
  `IsCompleted`, and if not, `RuntimeAsync.Suspend` (the awaiter's
  `UnsafeOnCompleted`, or `OnCompleted` for `AwaitAwaiter`) and a `leave`
  to the step's end that every finally block skips, then the await's label
  and `GetResult`. What the evaluation stack holds below the awaitable is
  spilled to frame locals and reloaded; `ret` completes the task, and what
  escapes the body faults it (or cancels it, for an
  `OperationCanceledException`). A step saves and restores the current
  SynchronizationContext as an async method's `MoveNext` does, so the
  order continuations run in is the task library's, as with state
  machines.

Roslyn hoists awaits out of catch and finally blocks and copies a struct's
`this` as it does for state machines, so what C# writes is covered; IL
with an await inside a handler, a reference on the stack across an await,
or a method returning another task-like type is refused with an error.

**Validation.** `tests/Async.cs` runs twice in the differential suite, as
`async` (state machines) and `async-runtime` (the same source with
`--runtime-async`), against the same CLR results (69 cases each, including
`Shapes`: generic methods, awaits in handlers, nested try blocks with an
exception filter, recursion, what is on the stack across an await, loops
with early returns, a struct's method and a `ValueTask` instance method);
`frames-runtime-async` runs the frame-loop behavior suite so compiled; the
console's `:fireworks-runtime-async-console-host-test` plays Fireworks so
compiled to the same end; and `fuzz-il-runtime-async-test` compiles the
fuzzer's async programs with it (100 seeds). **Size**: runtime-async
modules are smaller, with no state-machine struct, box or builder per
method: Fireworks 113,437 bytes against 122,847, `tests/Async.cs` 628,276
against 796,263, and a module without async is unchanged.

## SIMD

`System.Numerics.Vector2/3/4`, `Matrix4x4` and `Quaternion` are built on
`Vector128<float>` in .NET 11. `Vector128<T>` lowers to Wasm SIMD's `v128`,
its operations to `f32x4.*`/`i32x4.*` and friends, and its `As*`
reinterpretations to no-ops, as intrinsics; `Vector128.IsHardwareAccelerated`
folds to true. The engines and tools the module meets (wasm-opt, V8,
SpiderMonkey, Wasmtime, wlink) accept SIMD; wedge and wasm2c do not take GC
modules at all, so they do not constrain it.

### SIMD as built (phase 6)

**Representation** (`Frontend.Simd`). A `Vector128<T>` of one of the ten
primitive numbers (sbyte to ulong, float, double) is a `v128`, as an `int`
is an `i32`: a local, parameter or result of its own, a field of a struct,
class or static of type `v128`, an `array (mut v128)` element, a cell or
handle's value when code takes a reference to one, and a box's value (a
`$Box` with a `v128` field, whose `Equals`, `GetHashCode` and `ToString`
are the vector's). Its default is `v128.const 0`. It is a value type
argument, so an instantiation over it is never shared (`List<Vector128<int>>`
holds `v128`s). `Vector128<nint>` and `Vector128<nuint>` are two 64-bit
lanes, as `long`'s and `ulong`'s. `Vector64` and `Vector<T>` are not in the
CoreLib at all, and `Vector256` and `Vector512` only so that dotnet/runtime's
sources testing their `IsHardwareAccelerated` compile (a local of theirs
that folding leaves unused is no error).

**Folding.** `Vector128.IsHardwareAccelerated` is true and
`Vector128<T>.IsSupported` true of those ten element types and the
native integers; `Vector64`, `Vector256` and `Vector512`'s
`IsHardwareAccelerated`, `Vector.IsHardwareAccelerated` (`Vector<T>`'s) and
every hardware intrinsic class's `IsSupported`, `PackedSimd`'s included,
are false. So code written for the CLR takes its 128-bit paths, or its
scalar ones: `PackedSimd` is Wasm's own instructions, but the Vector128 API
reaches the same ones, and no code the importer takes in uses it.

**Operations** (`FunctionEmitter.Simd`). A call of a Vector128 or
`Vector128<T>` member that one or a few instructions do is those
instructions, whatever the element type: construction (`Create` of one or
every lane, from an array or an array and an index, `CreateScalar`,
`Zero`, `One`, `AllBitsSet`, `Indices`, the constants `Pi`, `E`, `NaN`,
...), lanes (`GetElement` and `WithElement` of a constant index as
`extract_lane`/`replace_lane`, of any other by `i8x16.swizzle` and
`v128.bitselect`; `ToScalar`), arithmetic, bitwise operations, shifts (their
count taken modulo the lane's bits, as .NET's are), comparisons and their
All/Any forms, `ConditionalSelect`, `Min`/`Max` and their Native forms,
`Abs`, `Sqrt`, `Floor`/`Ceiling`/`Truncate`/`Round`, `Sum` and `Dot`,
`ExtractMostSignificantBits` (`bitmask`), `Shuffle` (`swizzle` of each
index's bytes), widening, narrowing (truncating by `i8x16.shuffle`,
saturating by the `narrow` instructions, an unsigned input clamped first),
the int/float conversions, `MultiplyAddEstimate`, and the `As*`
reinterpretations. The rest is the CoreLib's C# (`corelib/Vector128.cs`) in
terms of those, after dotnet/runtime's `Vector128.cs` and `VectorMath.cs`
(the definitions of `MinNumber`, `MaxMagnitude` and the like, `CopySign`,
the `Is*` classifications, `Lerp`, the sequences), and, for what no
instruction does per element type (an 8-bit multiply, integer division, a
64-bit minimum, a saturating 32-bit add), dotnet/runtime's own `Scalar<T>`
(pinned with the other implementation sources) an element at a time.
`Vector128<T>`'s instance members (`Equals`, the indexer, `GetHashCode`,
`ToString`) are the lowering's too, on the value a reference to it holds.

**Against the CLR.** `tests/Simd.cs` (the `simd` differential module, 16,254
cases on the arm64 machine the suites run on) compares every element
type's operations, lanes hashed by their bits with NaN as one NaN, bit for
bit. Where Wasm's semantics and .NET's documented results could differ:

- `Min` and `Max` of floats are IEEE 754's minimum and maximum (NaN wins,
  -0 is below +0), as .NET 9 defines them and as `f32x4.min`/`max` compute
  them; a NaN's payload is Wasm's (canonical), not the operand's.
- `MinNative`, `MaxNative` and `ClampNative` are whatever the platform's
  instruction does with NaN and signed zeros: here x64's `minps`/`maxps`
  (`f32x4.pmin`/`pmax` with the operands swapped: the second operand where
  either is NaN or both are zero), where arm64's CLR gives `fmin`/`fmax`'s.
  The differential suite compares them over ordered, distinct values;
  `tests/SimdPlatform.cs` (`simd` in the behavior suite) pins ours.
- `MultiplyAddEstimate` rounds the product and then the sum: Wasm's only
  fused multiply-add is relaxed SIMD's, whose result differs by platform,
  and deterministic results matter more to game code. The CLR fuses it
  wherever the hardware can (x64 with FMA3, arm64), which .NET's
  documentation allows either way, so what System.Numerics builds on it
  (`Lerp`, `Transform`, matrix products, `Quaternion` concatenation,
  `Vector4.Cross`, `Reflect`, `Invert`) can differ from the CLR's in the last
  bit: the differential cases give them quarters no larger than 8, whose
  products and sums are exact either way.
- `FusedMultiplyAdd` rounds once, as .NET defines it (and as
  `Math.FusedMultiplyAdd`, `MathF.FusedMultiplyAdd` and `float`/`double`'s
  now do too): a float's in doubles, where the product of two floats is
  exact, rounded to odd so that rounding it to a float is rounding once; a
  double's by Dekker's product and the round-to-odd sum Boldo and Melquiond
  prove correct (`Gameplay.Runtime.FusedMultiply`), but for operands beyond
  1e150 or products below 1e-290, which take the unfused result.
- `ConvertToInt32Native` and the other Native conversions saturate (NaN to
  0), as arm64's do; x64's give `int.MinValue`. `ShuffleNative` is
  `Shuffle`: an index out of range selects zero.
- `Sin`, `Cos`, `SinCos`, `Exp`, `Log`, `Log2`, `Asin` and a double's
  `Hypot` apply the scalar functions (the runtime's `Transcendental`) to
  each element, where the CLR runs vectorized approximations of its own
  (`VectorMath`): within 2 ulps in the suite. A float's `Hypot` is exact
  (the squares of floats are exact in doubles, as the CLR computes them).
- `GetHashCode` is deterministic (the CLR's `HashCode` is seeded per
  process); `ToString` is the invariant culture's, the only one here.

**System.Numerics** (`corelib/Numerics.cs`). `Vector2`, `Vector3`,
`Vector4`, `Quaternion`, `Plane`, `Matrix3x2` and `Matrix4x4`, with their
extension members, are dotnet/runtime's sources (pinned per file with their
sha256 in `runtime/dotnet`), compiled into the
CoreLib. They stay structs of their float fields (a `Vector4` is four `f32`
leaves); `AsVector128` and `AsVector4` and the like, which the CLR does as
bit casts, pack the leaves into a `v128` (`splat` and `replace_lane`, the
lanes a `Vector2` or `Vector3` lacks zeroed by `AsVector128` and left alone
by `AsVector128Unsafe`) and unpack it (`extract_lane`), as
`Unsafe.BitCast` between them and a `Vector128<float>` does; `BitCast`
between structs of the same leaves (a `Vector4` and a `Plane`) is nothing.
A matrix's implementation works on its `Impl`, four `Vector128<float>` rows
the CLR reinterprets the matrix's sixteen fields as (`Unsafe.As<Matrix4x4,
Impl>`). Here `Impl` has the matrix's fields, whose box it shares
(`[Gameplay.Runtime.SameLayout]`, `Frontend.Structs`), so a reference to one
is a reference to the other, and its rows are properties over them; C#
only lets code set a property of a struct that is assigned, so
`Matrix4x4.cs.patch` and `Matrix3x2.cs.patch` (unified diffs pinned beside
the sources, in `runtime/dotnet/patches`, which
coresurface applies with `--patch`) start each `Impl` local as `default`. What
indexes rows or elements through references to memory (the indexers,
`Decompose`'s pointers, `Create` and `CopyTo` of spans, `LoadUnsafe`,
`StoreUnsafe`, x64's `Shuffle2`) is written with the rows and elements
instead, and `ToString` formats in the invariant culture. Their
differential module (`tests/Vectors.cs`, `vectors`) compares every
operation bit for bit but for what takes a sine, cosine or tangent (within
8 ulps).

Packing and unpacking cost instructions each operation: a `Vector4` sum is
two packs, an `f32x4.add` and four extracts, where the scalar code is four
adds. A layout of `v128` leaves whose float fields are lanes (as RyuJIT
holds `Vector4` in a register) would make the packing free and field
accesses lane instructions; it is not done: field references, boxes and
handles of lanes would have to be new kinds of location.

**References and Unsafe.** What the numerics sources and `LoadUnsafe` need:
`Unsafe.Add` of a reference to an array element is a handle to the element
that many further on (a reference to a variable or a field faults with
Unsupported when moved, one to a struct is refused); `Unsafe.As` between
references to structs that share a box, `Unsafe.BitCast`, `Unsafe.AsRef`
and `Unsafe.SkipInit` are what they are in the CLR; and a `ref readonly`
parameter is a reference, as `ref` is (an `in` parameter stays a value), so
`LoadUnsafe(ref readonly T)` reads the array the reference names.

**Framework code's vector paths.** System.Linq's vectorized `Sum` and
`Average` are written with `Vector<T>` (as wide as the machine's vectors)
and `Vector.LoadUnsafe(ref T, nuint)`: neither has a representation here, so
they take their scalar paths (System.Linq's `Min` and `Max` have no vector
paths in .NET 11's; System.Collections has none). A vector load of a GC array
is an `array.get` per lane, which decides what pays (V8, 16K ints, per
call): a four-lane sum 5.8 µs against System.Linq's checked scalar sum's 13.6;
a search 5.9 µs against 9.7; `SequenceEqual`, two loads a step, 9.6 µs
against 9.5. So the CoreLib's `IndexOf` (and `Contains`) of a span of
integers searches a vector at a time where the span has two vectors' worth
(`runtime/Spans.cs`, `Vector128.LoadSpan`), at about 300 bytes per element
type used (`tests/Linq.cs` 1,580,434 bytes against 1,580,128; LinqQuery and Anonymous unchanged), and
`SequenceEqual` stays scalar; floats stay scalar too, since their `Equals`
makes NaN equal to itself.

**Validation.** Besides the two differential modules and `simd` in the
behavior suite, the fuzzer's IL-mode features add `vectors` (Vector128
lanes of random integers, System.Numerics' types of small integers), and
`tests/wit/Tasks.cs`'s synchronous export computes through `v128`, which
wlink componentizes and `tests/wit-tasks.mjs` runs. Modules without
vectors are unchanged: Breakout 15,349 bytes, the console's 9,086,
Fireworks 122,847.

## Retiring the IOperation frontend (phase 6)

Once every suite passed in IL mode with empty expected-failure lists, the
`IOperation` frontend was removed in three steps, each a green commit.

**Coverage first.** Everything that ran in source mode only moved to IL
mode before anything was deleted: the importer's behavior run gained the
checks source mode's had (`--info`, a module compiled twice byte for byte,
rejections reported with a diagnostic), `wit-test` compiled and ran its
fixtures in IL mode too, and `integration-test` (the Native AOT
executable, isolated, then Binaryen, SpiderMonkey and the rejection cases)
got an IL-mode twin. The Native AOT compiler needs the system's OpenSSL in
IL mode, which source mode never did: Roslyn names the data of array
initializers by their SHA-256 (`<PrivateImplementationDetails>`), and
.NET's hashing on Linux loads libssl; the tests give the executable the
system's libssl and libcrypto through a scratch `LD_LIBRARY_PATH`
directory (`tests/compiler.mjs`), since a binary linked against the build
graph's C library searches only that library's directories. (The Native AOT
build has since been removed; the JIT compiler loads the system's OpenSSL
the same way, through the runtime's own loader.)

**IL by default.** `gameplayc` then compiled through the importer unless
`--frontend=source` asked otherwise, and the console Breakout became the IL
build. Two cheap wins paid for most of the IL module's size: a `local.set`
followed by a `local.get` of the same local is written as `local.tee`
(`WasmWriter.OpIndex`, which leaves every recorded position where it was;
reading `Length` is a barrier, since code may be spliced in there), and a
field read of a struct local (`ldloc; ldfld`) or of a reference to a
subclass reads the local itself rather than a copy. The examples' sizes
became budgets their tests keep (`maxBytes` of the Breakout suite, the
console host test's):

| module | IL before | IL after | source mode |
|---|---|---|---|
| `examples/breakout` | 15,349 | 13,874 | 13,337 (12,867 with `local.tee`) |
| `examples/console` Breakout | 9,086 | 8,796 | 8,016 (7,824 with `local.tee`) |
| `examples/console` Fireworks | 122,847 | 119,541 | — |
| `tests/Linq.cs` | 1,580,434 | 1,540,554 | — |
| `tests/corpus/LinqQuery.cs` | 154,420 | 150,975 | — |
| `tests/Anonymous.cs` | 613,063 | 599,909 | — |
| `tests/Simd.cs` | 341,592 | 329,432 | — |

These are the sizes as phase 6 left them; the budgets have followed the
modules down since (`examples/breakout` 10,906 bytes, the console's
Breakout 6,935), and Fireworks is 108,070 (99,891 runtime-async).
| `tests/Vectors.cs` | 371,119 | 360,957 | — |

What is left of the IL modules' excess over source mode's is IL's stack
discipline: every value an instruction leaves goes through a stack-slot
local (`local.set`, then `local.get` where it is consumed), where source
mode left operands on the Wasm stack. Keeping them there where they are
consumed in order is stackification, which followed ("Stackification as
built").

**Deletion.** In IL mode the import compilation has no syntax trees, so no
`IOperation` ever exists: every method that needs one, and everything only
they reach, is unreachable. A reachability pass over the compiler's own
members (Roslyn symbols, from `Main`, with overrides and interface
implementations reached through what they implement) found them, and what
it could not see was folded by hand: `il` is never null, metadata methods
are never local functions or lambdas and never declare syntax, and the
source frontend's collections (auto-properties, class declarations,
generic method templates) are never filled, so the plan kinds only it made
(lambdas, local functions, iterator bodies and dispatchers, record members,
auto accessors, field-like event accessors) went, with the iterator,
capture, `goto`, `using`, collection-expression and range lowerings, the
source registration of declarations, records and unions, and the
runtime layer's `Iterator<T>`. The
`IOperation? site` parameters threaded through the shared layer, always
null, went with their arguments. What has no IL of its own is the module's
static initializer (the eager classes' static constructors) and a lazy
class's initializer. The compiler went from 42,981 lines in 83 files to
29,478 in 72; the source-mode resources (`Binding.System.Runtime.dll`, the
`Runtime.*.cs` embeds) and the runtime layer's `#if !CORELIB` paths went
too; `--frontend` is gone.

The tests fold into one set: `behavior-test`, `differential-test` and
`integration-test` are the IL runs; `fuzz-test` runs every feature,
`fuzz-language-test` the same seeds without the CoreLib's and framework's
(`LIBRARY_FEATURES`, the program set source mode's `fuzz-test` ran), and
`fuzz-runtime-async-test` async programs compiled as runtime-async. The
rejection cases IL mode compiles are `acceptedCases` in
`tests/rejections.mjs`, with their reasons, and must compile into valid
modules.

The expected-failure lists are gone rather than kept empty: they existed to
let a target pass while the importer caught up, and a list that may only be
empty is a second way of saying "every case passes". What they brought
stays: the behavior and differential runs go on past a failing case and
report every one by its key (`tests/failures.mjs`), so one run shows
everything a change broke, and the fuzzer's `--test` reports each failing
signature with its seed.

What the runtime layer carried only for the retired frontend went after it,
once nothing could reach it (no compiler reference by name, no member
reference of the user's assembly, the framework assemblies' lists or the
CoreLib's other code), and every module of the tests, examples and fuzzer
programs compiled byte for byte as before: the CoreLib's own System.Linq
(`runtime/Linq.cs`, `LinqComparers.cs`: the SDK's replaces it for user
code, and only System.Linq's decimal aggregates are redirected to the
CoreLib's, now in `runtime/Decimal.cs` alone), its `Stack<T>`,
`SortedList`, `SortedDictionary`, `SortedSet`, `LinkedList` and
`PriorityQueue` (the SDK's System.Collections replaces them), the records
anonymous types were (C#'s IL has classes of its own for them, which
Roslyn does not report as anonymous types when it reads them), the
lowering's helpers for ranges, collection expressions and `lock`, and in
the compiler what served only the retired frontend: `Enumerable.Cast` and
`OfType` over the CoreLib's Linq, the anonymous-type counterparts, property
and captured-variable locations, the syntax that diagnostics were located
at, the implicit exception constructors, partial methods, and
`GAMEPLAYC_FRAMEWORK` (the framework assemblies left out, their facades
forwarded to the runtime layer's copies). About 5,700 lines of the runtime
layer and 300 of the compiler.

## Stackification as built

The lowering leaves every IL stack entry in a local, and saves what it
reuses (a receiver, an index, an allocation's size) in locals of their
own, so a module's bodies are mostly `local.set` and `local.get`. A pass
over each kept function's linked code (`Wasm.Locals.cs`, run as the module
is written, so only for the compilation that is kept) takes them out again,
in the manner of LLVM's WebAssembly RegStackify and Binaryen's
simplify-locals and coalesce-locals.

It works on the binary code rather than in the lowering because that is
where every function is: the IL bodies, and the functions the compiler
synthesizes (thunks, shared code's dictionaries' steps and entries,
delegate and box members, the entries), in the final numbering, with every
callee's signature known. A body is decoded into instructions (the Wasm 3.0
instruction set the compiler emits: GC, exceptions, SIMD, the canonical
ABI's memory instructions) with each one's operands and results, its
structure matched, and a control flow graph built over it: a block's
branches go to its end, a loop's to its start, and every call or throw
inside a `try_table` may go to each catch clause's label of every
`try_table` around it. Liveness over that graph (a bit per local and basic
block) decides everything below. Then, round after round until nothing
changes:

- **Values that stay where they are.** A `local.set x` whose value only
  the next `local.get x` at the same block depth reads (x is not read after
  that get, nor where a branch or an exception leaving the range between
  them goes), when the code between leaves the stack as it found it
  (whatever it pushes it pops, and it pops nothing from below), loses both
  instructions: the value stays on the stack where it was. Nothing moves,
  so the side effects, traps and exceptions between the two keep their
  order, and the value's type is its producer's, a subtype of the local's.
  A single forward walk decides this for every local at once, keeping
  each block's stack as a list of values, some of them sets that may yet
  stay: an instruction that pops through one, a read of its local at
  another depth, the end of its block or an unconditional branch gives it
  up. Sets that cross (`a; set x; b; set y; get x; get y`, which is how IL
  hands two operands to one instruction) both stay: the first read
  commits x, and y's set is above it still.
- **Dead values.** A `local.tee` nothing reads is removed, a dead
  `local.set` becomes `drop`, and a constant, local or global read that is
  dropped goes with its `drop`; `local.tee x; drop` is `local.set x`, and
  `local.set x; local.get x`, which the other rewrites leave adjacent, is
  `local.tee x`. Code after an unconditional branch is deleted to its
  block's end.
- **Blocks that carry their value.** A block (or an `if` with an `else`)
  that every branch leaves with `local.set x; br` and whose ends set x or
  are never reached, followed by `local.get x` of a value read nowhere
  else (after, possibly, the epilogue restoring the call depth, which
  leaves the stack alone), gets x's type as its result type: the branches
  carry the value and the sets and the read go. These are the IL's merge
  slots (`c ? a : b`) and a body's result; where an end is unreachable only
  because blocks before it never complete, it gets an `unreachable` for
  validation's sake.

Then the locals are packed: a local written once, with a constant, and
not read before that write is replaced by the constant where that is no
larger (an allocation's size); locals of the same type that are never live
at once share one (a copy does not make its source interfere, and a copy of
a local to itself is removed); and they are numbered by type, the type used
most first and the local used most first in it, so that most indices take a
byte. The module writer declares each run of locals of one type once (it
wrote one declaration per local before).

Locals of non-nullable reference types are left alone: Wasm validates
their reads by where their writes are, which removing a write can break.
The decoder refuses what it does not know (a body is then written as it
was, which `GAMEPLAYC_DEBUG_STACKIFY` reports; none of the suites' do; a
memory instruction's memarg is its alignment, a memory index when the
alignment's bit 6 is set, and its offset, nothing more: reading one field
too many took the next opcode as an immediate, which went unnoticed until
a load followed by `local.tee` left a local unrenumbered), and
checks its own accounting: the stack at each reachable block end must be
the block's results. `GAMEPLAYC_STACKIFY=0` turns the pass off, and the
module is then byte for byte what it was before the pass.

**Sizes** (bytes; the fuzzer's figure is the average of seeds 1 to 200
compiled as `fuzz/run.mjs` compiles them):

| module | before | stackified | source mode |
|---|---|---|---|
| `examples/breakout` | 13,874 | 11,484 | 13,337 |
| `examples/console` Breakout | 8,796 | 7,346 | 8,016 |
| `examples/console` Fireworks | 119,541 | 106,268 | — |
| `tests/Linq.cs` | 1,540,001 | 1,400,408 | — |
| `tests/corpus/LinqQuery.cs` | 150,863 | 137,001 | — |
| `tests/Anonymous.cs` | 599,458 | 544,553 | — |
| `tests/Async.cs` | 776,651 | 695,239 | — |
| `tests/Async.cs`, `--runtime-async` | 612,223 | 545,573 | — |
| `tests/Simd.cs` | 329,605 | 279,596 | — |
| `tests/Vectors.cs` | 361,064 | 287,360 | — |
| fuzzer, average | 232,019 | 207,152 | — |

The examples' budgets are the new sizes. The pass costs about 0.5 s of
`tests/Linq.cs`'s 13 s and nothing measurable for the examples. For
comparison, Binaryen's `wasm-opt -O2` (which the integration test runs
over each suite's module, not part of any build) makes the Breakout module
7,995 bytes and Fireworks 57,882, from either input to within a few
hundred bytes, mostly by dropping the name section (Breakout without names
is 9,347 here) and inlining. What stays: each function's fuel and call
depth checks and each allocation's budget check are inline, and a null or
bounds check reads its value twice.

## Validation

The importer was judged by the suites that judged the `IOperation`
frontend, and now the suites are its own:

- The behavior suites (`tests/behavior.mjs`), the CLR differential suite
  (`tests/differential.mjs`, the same C# on the CLR and in Wasm), the
  integration run (`tests/integration.mjs`: every suite again after
  Binaryen, and in SpiderMonkey) and the fuzzer
  (`fuzz/`, random programs against the CLR) run as `behavior-test`,
  `differential-test`, `integration-test`, `fuzz-test`,
  `fuzz-language-test` and `fuzz-runtime-async-test`. Until parity, the
  IL-mode targets carried expected-failure lists, which only shrank; they
  are gone now (see "Retiring the IOperation frontend"), and a run reports
  every case that fails.
- The rejection cases (`tests/rejections.mjs`) must be rejected, with a
  diagnostic and no partial output; the ones source mode rejected that the
  importer legitimately compiles are `acceptedCases`, each with why (what
  C# lowers away, attributes as metadata, what the CoreLib adds), which
  must compile into valid modules, and `tests/IlAccepted.cs` runs their
  code against the CLR. Running them found what IL mode compiled wrongly,
  then rejected as source mode rejected it (array covariance and delegate
  variance, unrelated representations, since accepted: see "Variance as
  built"), a reference to an `in` parameter's copy returned,
  `base.ToString()` of object, a multidimensional array's `Type`,
  interpolating an `IFormattable` of the module's own, and ordering
  strings by the default comparer. Lone surrogates in
  `WasmImport`/`WasmExport` names are checked on the source's symbols,
  since metadata's UTF-8 has replaced them.
- Once CoreLib and the framework assemblies were imported, the fuzzer's
  feature snippets extended to the framework APIs they reach:
  `fuzz/features.mjs`'s `LIBRARY_FEATURES`, snippets over
  System.Collections' and System.Linq's own IL (selector calls counted,
  casts, chunking, indexing, counting and aggregating by key, sets,
  `OrderedDictionary`, messages), over variance, over async (async
  lambdas under a single-threaded context of the program's own: awaits,
  combinators, exceptions, `ValueTask`, async iterators, cancellation), and
  over vectors.

## Phases

1. **This document.**
2. **Importer MVP** (compatibility mode): IL reading and token resolution,
   stack typing, structuring, the byref mapping, exception regions without
   filters, monomorphized generics, registration from symbols, and the
   shims Roslyn's lowering needs; IL-mode test targets with expected
   failures. *Done*, with more than planned: filters (two-pass), `fault`
   blocks, irreducible flow (a dispatch loop), `localloc` and `cpblk` of
   constant initializers. Every behavior suite and fuzz seed passed; the
   differential suite passed but for its expected-failure list.
3. **Gameplay CoreLib**: the runtime layer as a `csc`-built CoreLib
   assembly with the framework's names, dotnet/runtime sources pinned in
   `runtime/dotnet`, the importer resolving reference-assembly type
   references to it; the framework-type special cases of the module layer
   become CoreLib IL one by one; the allowlist. *In progress*: IL mode
   compiles against .NET's reference assemblies and imports over the
   CoreLib, with every suite passing; generic math; `Guid`, `Lazy<T>`,
   `TimeSpan`, `DateTime`, `DateTimeOffset`, `Stopwatch`,
   `Int128`/`UInt128` from dotnet/runtime's sources and the host services
   (`tests/Time.cs`).
4. **Framework assemblies and sharing**: System.Linq, System.Collections,
   System.Runtime.Numerics imported from the SDK (feature switches and
   `IsSupported` folded, the FoldC intrinsics), shared generics over
   `eqref` with per-instantiation dictionaries, variance, filters in IL
   mode.
   *Done in part*: System.Collections and System.Linq are imported from
   the SDK with import-time folding ("Framework assemblies"); variance of
   interfaces and delegates, arrays as variant collection interfaces,
   and array covariance proper ("Variance as built"); boxed numbers'
   comparison interfaces; the member allowlists ("API control"); the
   fuzzer's IL-only features; shared generics and closed-world pruning
   ("Shared generics as built", "Closed-world pruning"). Every suite
   passes with empty expected-failure lists. System.Runtime.Numerics
   came last, from dotnet/runtime's sources rather than the SDK's IL
   ("System.Runtime.Numerics as built").
5. **Async**: CoreLib's task library, the frame-pumped context, the
   runtime-async splitter, witgen's WASI 0.3 glue. *Done*: the task
   library, async enumeration and the frame loop ("Async as built"), the
   runtime-async splitter ("Runtime-async methods as built"), and async
   functions through the callback ABI (docs/WIT.md, "Async functions"):
   async imports whose results hold strings or lists (the host's blocks
   held until the glue has read them), async methods and statics of
   imported and exported resources (docs/WIT.md, "Exported resources"),
   and futures and streams (docs/WIT.md, "Futures and streams"), tested
   against a fake host, wlink's linked modules and Wasmtime 48.
6. **SIMD and retirement**: `Vector128` as `v128`; System.Numerics vectors
   from the framework; the `IOperation` frontend retired once every suite
   passes in IL mode without expected failures. *Done*: SIMD ("SIMD as
   built": Vector128 over every primitive element type, the
   System.Numerics types from dotnet/runtime's sources, the CoreLib's span
   search vectorized where it measured faster), and the retirement
   ("Retiring the IOperation frontend": the importer is the only frontend,
   the tests one set, the examples' sizes budgets). Then stackification
   ("Stackification as built"), which brought the examples below source
   mode's sizes.

## Risks

- **Symbol model limits**: Roslyn's metadata symbols do not model
  everything IL can say (`modreq` on locals, `localloc`, function pointer
  signatures, `fault` blocks). Those are rejected; `csc`'s IL rarely needs
  them.
- **Code size**: Roslyn's lowering is more verbose than the `IOperation`
  frontend's was (display classes where environments sufficed, iterator
  state machines with their own `IEnumerable<T>` classes, interpolation
  handlers), and IL's stack slots cost locals. The Breakout modules' sizes
  are budgets their tests keep; pruning of unreached members, shared
  generics, closed-world pruning and stackification are the answers so
  far.
- **Semantics the `IOperation` frontend decided itself** (as it was
  retired): precise versus
  `beforefieldinit` class initialization now follows the IL flag, which
  `csc` sets exactly as C# specifies; string hashing and other documented
  differences stay where the runtime layer decides them.
- **CoreLib churn**: taking dotnet/runtime sources verbatim ties us to
  their internals; every file carries its patch in `runtime/dotnet`, and
  bclscan reruns when the pinned SDK moves.
- **Shared generics**: shared code is compiled from the IL once and its
  exact instantiations' differences go through dictionaries of ExactStep
  functions; a lowering that decides by a type argument outside the
  sites `Frontend.SharedCode` classifies would be wrong for every
  instantiation but the first. `tests/Sharing.cs`, the suites and the
  fuzzer run with sharing on, and `GAMEPLAYC_SHARING=0` is the
  comparison.
- **Closed-world assumptions**: type-test folding and array pruning rely
  on every conversion of a value being visible in some IL body; a
  module-layer helper that converts an array without IL would have to
  report it.
