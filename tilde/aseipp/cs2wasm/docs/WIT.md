<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# WIT worlds: generated bindings

A gameplay module's boundary is a set of typed function imports and exports
with scalar signatures. That is also what the component model's canonical
ABI produces for the scalar part of a WIT world, and for the rest (strings,
lists and the like) it adds a linear memory the values pass through. So
instead of declaring `WasmImport` methods by hand, a module can be
programmed against a WIT world: `witgen` reads the world and writes the C#
that `gameplayc` binds, including the glue that copies values through that
memory.

```
sdk.wit  --witgen csharp-->  Bindings.g.cs  --+
                                               |--gameplayc-->  game.wasm  --wlink componentize-->  game.component.wasm
Game.cs  --------------------------------------+
```

`witgen` is a Rust tool on the same `wit-parser` and `wit-component` crates
as the console's linker, so the WIT dialect, the naming of imports and
exports, and the flat signatures are those of the component model, not a
reimplementation of them.

## Using it

```sh
buck2 run tilde//aseipp/witgen:witgen -- csharp sdk.wit --world game -o Bindings.g.cs
buck2 run tilde//aseipp/cs2wasm:gameplayc -- -o game.wasm Bindings.g.cs Game.cs
buck2 run tilde//aseipp/wlink:wlink -- componentize game.wasm --wit sdk.wit --world game -o game.component.wasm
```

`csharp` takes WIT files or package directories in dependency order and
selects the world from the last one (a package with one world needs no
`--world`). Every function or type it cannot express is left out with a
comment in the output and reported on standard error; `--strict` turns the
report into a failure. `--namespace` overrides the `Ns.Pkg` namespace derived
from the package name. The generated file starts with the SPDX header lines
of the WIT file it came from, when there are any.

`componentize` (the console's `wlink componentize`) wraps the module into a
component, declaring UTF-8 strings. It is also the conformance check:
wit-component refuses a module whose imports and exports are not exactly the
world's, with their canonical names and flat signatures, or that passes
values through memory without exporting `memory` and `cabi_realloc`.

In Buck, [defs.bzl](../defs.bzl) wraps the three steps:

```python
load("tilde//aseipp/cs2wasm:defs.bzl", "gameplay")

gameplay.bindings(name = "bindings", wit = ":sdk.wit", world = "game")
gameplay.module(name = "game", srcs = [":bindings", "Game.cs"])
gameplay.component(name = "game-component", module = ":game", wit = [":sdk.wit"], world = "game")
```

[examples/console](../examples/console/README.md) is Breakout written this
way against the console SDK's `game` world.

## What the bindings look like

For `world game` of `console:sdk@0.1.0`, the file declares, in namespace
`Console.Sdk`:

| WIT | C# |
| --- | --- |
| `interface gfx` (imported) | `public static class Gfx` with the interface's types and one wrapper per function, backed by a private `Imports` class of `[WasmImport("console:sdk/gfx@0.1.0", "fill-rect")]` externs |
| `world game` | `public static partial class Game`: the world's own imports as wrappers, and its exports as `[WasmExport("frame")] public static partial bool Frame(uint dtMs);` for the module to implement |
| `export ns:pkg/iface` | `public static partial class Iface` nested in the world class, exported as `ns:pkg/iface@1.0.0#name` |
| `record color { r: u8, ... }` | `public sealed record Color(byte R, ...)`: value equality, `with`, printing and deconstruction (`var (r, g, b, a) = color`), its field docs as `<param>`s; passed to imports field by field, rebuilt by export wrappers |
| `enum key { ... }` | `public enum Key` |
| `flags buttons { ... }` | `[Flags] public enum Buttons : uint` with `None = 0`, unless a flag is itself named `none` |
| `resource sheet` | `public sealed class Sheet` holding the i32 handle: constructor, methods and statics from the interface, `FromHandle`, `ToHandle` and `Dispose` (the `[resource-drop]` import) |
| `resource account` of an exported interface | `public sealed partial class Account` the module implements: `public partial Account(string owner);`, `public partial uint Deposit(uint amount);`, `internal static partial Account Open(string owner, uint amount);` (see "Exported resources") |
| `option<rect>` (parameter or record field) | the record, `null` for `none`; lowered to a discriminant and the fields, each option independently |
| `bool`, `u8`...`u64`, `s8`...`s64`, `f32`, `f64` | `bool`, `byte`...`ulong`, `sbyte`...`long`, `float`, `double` |
| `char` | `int`, a Unicode scalar value |
| `string` | `string` |
| `list<T>` | `T[]`, lists of lists as jagged arrays |
| `tuple<A, B>` | the world class's `record struct Tuple2<A, B>(A Item0, B Item1)`... (up to eight), which deconstructs |
| `option<T>` of a string, list, record or handle | the value, `null` for `none` |
| `option<T>` of anything else | the world class's `Option<T>` struct: `HasValue`, `Value` |
| `record` with such fields | a sealed record, as above, marked `[CanonicalAbi]` |
| `variant shape { circle(f32), label(string), empty }` | a sealed record per case (`ShapeCircle(float Value)`, `ShapeEmpty`), and the C# 15 `public union Shape(ShapeCircle, ShapeLabel, ShapeEmpty)`, which a switch takes apart with positional patterns (`ShapeCircle(var radius) => ...`) |
| `variant` without payloads | `public enum`, like a WIT `enum` |
| `result<T, E>` | the world class's `Result<T, E>` union of the records `Ok<T>(T Value)` and `Err<E>(E Value)`, with the record `Unit` for a side without a payload |

Names change case as C# expects: `fill-rect` is `FillRect`, `dt-ms` is
`dtMs`, and a `%list` becomes `List`. A function named like its interface
(`log` in `interface log`) gets a trailing `_`, since C# forbids a member
named like its class. An interface called `system` becomes
`SystemInterface` so `System.Math` still means the framework. Interfaces whose
names collide (the same name in two packages, or the world's own name) are
qualified with their package, then their version: `test:other/util` becomes
`TestOtherUtil`.

The module side implements the partial methods, in the same namespace:

```csharp
namespace Console.Sdk;

public static partial class Game
{
    static float paddleX;

    public static partial void Init() => Gfx.SetMode(320, 240);

    public static partial bool Frame(uint dtMs)
    {
        if ((Input.Poll() & Input.Buttons.Left) != 0)
            paddleX -= 200 * (dtMs / 1000f);
        Gfx.FillRect(new Gfx.Rect((int)paddleX, 220, 48, 6), new Gfx.Color(230, 230, 230, 255));
        return true;
    }
}
```

The generated wrappers are `internal`, so they never become exports
themselves; the module's exports are exactly the world's, which is what
`componentize` checks.

## Through memory

A function whose values do not all fit the flat signature (strings, lists,
tuples, options of anything but a record, records as results, more than
sixteen flat parameters, more than one flat result) is canonical ABI glue.
The wrapper of an import copies its arguments into the module's linear
memory, passes the extern their (pointer, length) pairs or a pointer to a
parameter tuple, has the host write a result that does not fit one value to
an area it passes, copies the result into GC objects, and then returns the
memory to where it was. The wrapper of an export copies its arguments out of
memory into GC objects, calls the partial method, and writes a result that
does not fit one value into memory, returning its address. Strings are
UTF-8 there (the component's declared encoding): the glue transcodes to and
from C#'s UTF-16, surrogate pairs included; a lone surrogate, which UTF-8
cannot carry, becomes U+FFFD, as it does in .NET, and so does a malformed
sequence from the host, which the canonical ABI rules out anyway.

The memory is the module's boundary and nothing else: the glue reaches it
through `Gameplay.Runtime.Canonical` and `Memory`, which only code marked
`[Gameplay.CanonicalAbi]` (the glue) and the compiler's runtime may use, and
a module gets a memory, its `memory` export and `cabi_realloc` only when
its code uses them. The glue is compiled where it is used, so a world full
of string functions costs a module that calls none of them nothing: the
console Breakout's module is the same with or without them. The memory is an
arena. `cabi_realloc` and the glue allocate at its end, growing the memory
as needed (the allocation budget's fault 3 when it cannot); an import's glue
frees what the call used when it returns; the outermost exported entry
empties the arena when it starts, after the host has placed its arguments
there and before the glue allocates anything, which also reclaims what a
trap left. Results therefore stay valid until the next call, as a component
host lifts them, and no `cabi_post_*` functions are needed.

`tests/wit` exercises all of it against a host that does the canonical ABI
lowering itself (`tests/wit.mjs`), and `tests/wit/echo.wit`, an export-only
world, against Wasmtime's component runtime when it is installed:

```sh
wasmtime run --invoke 'entries(["ab", "ü", ""])' echo.component.wasm
# [{name: "ab0", values: [97, 98]}, {name: "ü1", values: [252]}, {name: "2", values: []}]
```

A variant or result lowers as the canonical ABI has it: its case's index,
then its payload in the variant's joined flat types, where the payloads of
the cases share positions: an `f32` joined with an `i32` travels as its bits,
and one joined with an `i64` as its bits widened, as a `u32` widens to `i64`.
In memory, the case's index takes one, two or four bytes, and the payload
starts at the alignment of the widest one. The union's default value is no
case, and passing it to the host throws `InvalidOperationException`; a case
index from the host out of range throws too.

## Exported resources

A resource of an interface the world exports is the module's own: its
class is a `public sealed partial class` the module implements, with a
partial member per WIT function: the constructor (`public partial
Account(string owner);`, a C# 14 partial constructor), the methods
(`public partial uint Deposit(uint amount);`) and the statics, which are
`internal static partial` so that a scalar one does not become a module
export itself. Async methods and statics return `Task` or `Task<T>`, as
async exports do. The glue exports each under its canonical name
(`test:ledger/books@1.0.0#[method]account.deposit`), and the resource's
destructor (`#[dtor]account`), and imports `[resource-new]account`,
`[resource-rep]account` and `[resource-drop]account` from
`[export]test:ledger/books@1.0.0`.

A handle the host holds carries a rep, the i32 the module gave
`resource.new`. The class keeps the objects behind the reps in a table,
the CoreLib's `ResourceReps<T>` (`corelib/Resources.cs`): an object gets an
entry the first time it leaves the module as an `own` handle (a
constructor's object, or a result), and every `own` handle that leaves is
a new handle of the same rep, which the entry counts. The host's drop of a
handle calls the destructor with the rep, and the last one takes the
object out of the table and calls `OnDropped`, a partial method
(`partial void OnDropped();`) the module may implement to release what the
object holds. The object itself lives on while the module references it,
and gets a new entry if it leaves again.

On the way in, a `borrow` (a method's receiver too) is the rep itself,
which the glue looks up. An `own` handle the host gives back lands in the
module's table: the glue reads its rep and drops it, so the module never
holds a handle of its own resource and its objects need no `Dispose`, and
when that was the object's last handle outside, `OnDropped` runs before
the method does. The objects cross in exports, their results, records,
lists, options, variants, futures and streams; an import that would pass
one (a world can name its exports' types in its imports) is reported, as
lending one would take a handle of the module's own.

`tests/wit/tasks.wit`'s `account` runs against the fake host, which keeps
the module's handle table and calls the destructor as it drops handles:
reps given and used again, a second handle of one object, an object given
back, synchronous and async methods and statics. `tests/wit/ledger.wit`'s
two modules, `teller` using the accounts `bank` exports, run linked
together by wlink (`tests/wit-linked.mjs`), and composed by
`wasm-tools compose` under Wasmtime when both are installed.

## Async functions

`async func`s (WASI 0.3's) go through the component model's callback ABI,
over the CoreLib's task library (docs/IMPORTER.md, "Async as built"). The glue is `../witgen/src/csharp/tasks.rs`
and its runtime the CoreLib's `Gameplay.Runtime.ComponentTasks`
(`corelib/ComponentTasks.cs`), which modules without async functions never
reach.

- **An async import** is an `internal static` wrapper returning `Task` or
  `Task<T>`. It lowers its arguments as a synchronous import's glue does (at
  most four flat values, else a pointer to them), passes an area for the
  result, and calls the `[async-lower]` extern, whose status says how far
  the host got: returned (the task is complete, its result read from the
  area), or started or not yet started, when the subtask joins the calling
  export's waitable set and the task completes when its event comes. Its
  continuations then run as any task's do.
- **An async export** is a partial method returning `Task` or `Task<T>`,
  lifted with a callback: the `[async-lift]` export starts a component task
  and the method, the `[callback][async-lift]` export takes the task's
  events, and the method's result goes to the host through the
  `[task-return]` import (a failed method faults the call that would have
  returned it, with the exception's own fault). After each entry the task
  runs what the frame loop has posted until nothing is left, then tells the
  host to wait on its set while it has subtasks (and to exit once it has
  returned and has none), or, with none, to call it back (yield): it waits
  for work only another call brings, such as another export completing a
  `TaskCompletionSource` it awaits. Waiting would be cheaper, but nothing
  could end the wait: a set's events come from subtasks and the ends of
  futures and streams, and the callback ABI gives a component no waitable
  of its own to signal without a future or stream type in its world. So
  the host calls a yielding task back once per turn of its scheduler (wlink
  calls such tasks once per pump). A result that other work completes while
  the task waits on its set is returned at its next event.
  `ComponentTasks.Cancellation` is the running export's token, canceled when
  the host cancels the task; a method that then ends canceled acknowledges
  it with `task.cancel`, and one that returns is returned as usual.
- **Memory that outlives a call.** The host writes an async import's result
  when the subtask returns, and reads its arguments when it starts, both
  possibly after the call and between other entries, which empty the arena.
  So the result areas, and the arguments of a subtask that has not started,
  are held below the arena's floor (`__heap_floor`, where an outermost entry
  empties it to; a module without async imports has none): a block
  allocated at the arena's end raises the floor over it, freed blocks are
  used again first, and the floor falls when the highest is freed. What an
  entry's arena held below a block it raised the floor over is free once
  another entry has started.

- **Results the host allocates.** An async import whose result holds
  strings or lists has the host call `cabi_realloc` for them when the
  subtask returns, outside any call of the module, where the arena would
  reuse them before the event reaches the module. So while such a subtask
  (or a future's or stream's read of such values, below) is pending,
  `cabi_realloc` puts what it allocates below the floor as well, each block
  after a 16-byte header (its address, its end, the previous header, and
  whether an entry was running) chained from the module's `__host_chain`
  global; the glue's own allocations set the chain aside. The CoreLib adopts
  the chain into its held blocks at its next look at them, and the lift
  frees each string's or list's block as soon as it has copied it into GC
  objects (`ComponentTasks.Consumed`, which the glue calls after every lift
  of a string or list in a module that may hold the host's memory: an
  export's arguments included, which the host may allocate there
  meanwhile). The arena itself stays an arena: only blocks the host
  allocates while such an operation is pending are held, and a module whose
  async imports return no strings or lists has no chain.
- **Async functions of imported resources.** An async method is an
  instance method of the resource's class returning `Task` or `Task<T>`,
  the handle its first argument (`[async-lower][method]r.f`); an async
  static is a static of the class (`[async-lower][static]r.f`). WIT has no
  async constructors. Those of exported resources are async partial
  members of their class (see "Exported resources").

Async exports take and return what synchronous ones do.

wlink links all of it: its async runtime, spliced into the one core module
it writes, runs the tasks, subtasks, futures and streams between
components and keeps their state, and the host completes the module's
async imports, takes its exports' results and holds its ends of futures
and streams through wlink's async host ABI (`tilde/aseipp/wlink/ASYNC.md`).
The console's `async-game` world is such a component: its one long `run`
task waits for frames through the SDK's scheduler
(`examples/console:fireworks-tasks`). A `game` world module, whose frame
loop runs inside its `frame` export, has no async imports, and so no held
memory, chain or task runtime. wedge does not take GC modules, so none of
this reaches it.

`tests/wit/tasks.wit` exercises all of it against a host that keeps the
canonical built-ins' state and completes subtasks in the order each check
says (`tests/wit-tasks.mjs`): results out of order, arguments read when a
call starts while other calls allocate, a task yielding until another call
completes it, a result returned before the task is over, cancellation, a
thousand rounds of overlapping calls whose held memory stays small, and a
failure; results holding strings, lists, lists of strings and records of
them, several at once and out of order, with the held memory back to where
it was after hundreds of rounds; async methods and statics of a resource;
and the futures and streams below. `tests/wit/sleepy.wit` imports WASI
0.3's monotonic clock, and `tests/wit/files.wit` its filesystem and
standard output. Linked by wlink, `tests/wit-linked.mjs` runs both over
wlink's async host ABI: waits completed in either order and a cancel the
method ignores, a link's string returned at once and later, a directory
listed through a stream of records the host writes from its own memory and
the future of its outcome, and standard output read from a stream of bytes
the module writes. Wasmtime (48 or later, when installed) runs the
components themselves:

```sh
wasmtime run -W component-model-async=y -W component-model-more-async-builtins=y -S p3 --invoke 'nap(20)' sleepy.component.wasm
# 60
wasmtime run -W component-model-async=y -W component-model-more-async-builtins=y -S p3 --dir dir::/ --invoke 'probe("link")' files.component.wasm
# file.txt|file.txt,link@,sub|True
# "file.txt|file.txt,link@,sub|True|33|True"
```

## Futures and streams

A `future<T>` or `stream<T>` crosses the boundary as the handle of its
readable end, which C# holds as the CoreLib's `FutureReader<T>` or
`StreamReader<T>` (`corelib/Channels.cs`); a module makes a pair with the
world class's `NewFutureT()` or `NewStreamT()` (`NewStreamU8`,
`NewFutureResultOfUnitAndErrorCode`, ...), keeps the writer and passes the
reader. The canonical built-ins are imported per type, named after a
function whose signature holds the type and the type's index among that
signature's futures and streams (`[stream-new-0]f`,
`[async-lower][stream-read-0]f`, `[stream-drop-readable-0]f`; an exported
function's are under `[export]<interface>`). Futures and streams are
compared by structure, so witgen generates one `ChannelOps<T>` per payload
type (`../witgen/src/csharp/channels.rs`): those built-ins, over the first function
that names the type, and the payload's size, alignment, load and store.
Payload types of one name in two interfaces get numbered classes.

- `StreamReader<T>.ReadAsync(buffer, start, count)` completes with how
  many values the writer sent, at least one, or 0 once it has dropped its
  end (`IsCompleted`). A reader is an `IAsyncEnumerable<T>`, so `await
  foreach` reads it to its end.
- `StreamWriter<T>.WriteAsync(values)` completes once the reader has taken
  them all, with how many it took: fewer when it dropped its end
  (`IsClosed`).
- `FutureReader<T>.ReadAsync()` completes with the value, and drops the
  end; `FutureWriter<T>.WriteAsync(value)` with whether the reader took it.
- `Dispose` drops an end, canceling a copy pending first; a canceled
  `CancellationToken` cancels the copy too, and a copy canceled before it
  copied anything ends canceled. Cancels are async-lowered
  (`[async-lower][stream-cancel-read-0]f`): one the other end's holder has
  yet to stop returns `BLOCKED`, the copy stays pending until its event,
  and an end disposed meanwhile is dropped then. Wasmtime has them behind
  `-W component-model-more-async-builtins=y` (🚝).

A copy that cannot complete at once (`BLOCKED`) joins the running export's
waitable set, as a subtask does, and its task completes at its event
(`STREAM_READ`, `STREAM_WRITE`, `FUTURE_READ`, `FUTURE_WRITE`); so ends are
used from async exports. A read's buffer, and a write's values until the
host has taken them, are held memory, and so are the strings and lists a
read's values hold, which the host allocates as it does an async result's.

`tests/wit/tasks.wit` has the module read a stream the host writes in
pieces, write one the host reads, forward one, and read and write futures,
against the fake host; `tests/wit/files.wit` reads a link (an async method
whose result is a string), lists a directory (a stream of records holding
strings, and the future of its outcome) and writes a stream of bytes to
standard output under Wasmtime.

## What cannot cross the boundary

`flags` of more than 32 flags, tuples of more than eight, `error-context`,
futures and streams without a payload type, maps, fixed-length lists, and
the objects of exported resources in imports. Those functions and types
are left out with a comment, so a world may contain them; only the
module's own exports must all be expressible for `componentize` to accept
it. Exports may take and return handles to imported resources.

Ownership of an imported resource's handles follows the WIT: an `own<T>`
parameter spends the C# object (its handle is marked dropped and cleared,
as `Dispose` does), a `borrow<T>` does not, and an `own<T>` result is
wrapped in a fresh object the module should `Dispose`. The host sees only the
i32 representations. An exported resource's objects are the module's (see
"Exported resources").

## Files

- `../witgen/src/csharp/mod.rs`: the generator; `memory.rs`: the canonical ABI glue;
  `tasks.rs`: async functions' glue; `names.rs`: case rules; `tests.rs`:
  unit tests of the generated source.
- `../witgen/src/csharp/channels.rs`: futures' and streams' ops classes.
- `corelib/ComponentTasks.cs`: the async functions' runtime (component
  tasks, subtasks, the held memory, the host's blocks);
  `corelib/Channels.cs`: futures' and streams' ends; `corelib/Resources.cs`:
  the table of exported resources' objects.
- `runtime/Canonical.cs`: the boundary memory's C# side (UTF-8 transcoding),
  compiled with the module.
- `tests/wit/features.wit`, `Bindings.g.cs` (the committed output),
  `Features.cs`, `tests/wit.mjs`: the world exercising every construct, its
  module, and a host keyed by canonical names; `buck2 test
  tilde//aseipp/cs2wasm:wit-test` regenerates, compares, compiles, runs and
  componentizes; `echo.wit` and `Echo.cs`: an export-only world a
  component runtime calls; `tasks.wit`, `Tasks.cs`, `sleepy.wit`,
  `Sleepy.cs`, `files.wit`, `Files.cs`, `ledger.wit`, `Bank.cs`,
  `Teller.cs`, `tests/wit-tasks.mjs` and `tests/wit-linked.mjs`: async
  functions, futures and streams, and exported resources
  (`:wit-tasks-test`).
- `defs.bzl`: the Buck macros.
