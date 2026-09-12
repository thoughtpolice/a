<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# WIT worlds: generated bindings

A gameplay module's boundary is a set of typed function imports and exports
with scalar signatures. That is also what the component model's canonical
ABI produces for the scalar part of a WIT world, so instead of declaring
`WasmImport` methods by hand, a module can be programmed against a WIT
world: `witgen` reads the world and writes the C# that `gameplayc` binds.

```
sdk.wit  --witgen csharp-->  Bindings.g.cs  --+
                                               |--gameplayc-->  game.wasm  --witgen componentize-->  game.component.wasm
Game.cs  --------------------------------------+
```

`witgen` is a Rust tool on the same `wit-parser` and `wit-component` crates
as the console's linker, so the WIT dialect, the naming of imports and
exports, and the flat signatures are those of the component model, not a
reimplementation of them.

## Using it

```sh
buck2 run tilde//aseipp/cs2wasm:witgen -- csharp sdk.wit --world game -o Bindings.g.cs
buck2 run tilde//aseipp/cs2wasm:gameplayc -- -o game.wasm Bindings.g.cs Game.cs
buck2 run tilde//aseipp/cs2wasm:witgen -- componentize game.wasm --wit sdk.wit --world game -o game.component.wasm
```

`csharp` takes WIT files or package directories in dependency order and
selects the world from the last one (a package with one world needs no
`--world`). Every function or type it cannot express is left out with a
comment in the output and reported on standard error; `--strict` turns the
report into a failure. `--namespace` overrides the `Ns.Pkg` namespace derived
from the package name. The generated file starts with the SPDX header lines
of the WIT file it came from, when there are any.

`componentize` wraps the module into a component. It is also the conformance
check: wit-component refuses a module whose imports and exports are not
exactly the world's, with their canonical names and flat signatures.

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
| `record color { r: u8, ... }` | `public sealed class Color` with public fields and a positional constructor; passed to imports field by field, rebuilt by export wrappers |
| `enum key { ... }` | `public enum Key` |
| `flags buttons { ... }` | `[Flags] public enum Buttons : uint` with `None = 0`, unless a flag is itself named `none` |
| `resource sheet` | `public sealed class Sheet` holding the i32 handle: constructor, methods and statics from the interface, `FromHandle`, `ToHandle` and `Dispose` (the `[resource-drop]` import) |
| `option<rect>` (parameter or record field) | the class, `null` for `none`; lowered to a discriminant and the fields, each option independently |
| `bool`, `u8`...`u64`, `s8`...`s64`, `f32`, `f64` | `bool`, `byte`...`ulong`, `sbyte`...`long`, `float`, `double` |
| `char` | `int`, a Unicode scalar value |

Names change case as C# expects: `fill-rect` is `FillRect`, `dt-ms` is
`dtMs`, and a `%list` becomes `List`. An interface called `system` becomes
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

## What cannot cross the boundary

Anything the canonical ABI places in linear memory, which a gameplay module
does not have: `string`, `list<T>`, `tuple`, `variant`, `result`, `option` of
anything but a record, records as results, more than sixteen flat parameters,
and asynchronous functions. Those functions and types are left out with a
comment, so a world may contain them; only the module's own exports must all
be expressible for `componentize` to accept it. Exported resources are not
generated either, and functions that use them are reported as unsupported.
Exports may take and return handles to imported resources.

Ownership follows the WIT: an `own<T>` parameter spends the C# object (its
handle is marked dropped and cleared, as `Dispose` does), a `borrow<T>` does not, and an `own<T>` result is
wrapped in a fresh object the module should `Dispose`. The host sees only the
i32 representations.

## Files

- `witgen/src/lib.rs`: the generator; `names.rs`: case rules; `tests.rs`:
  unit tests of the generated source.
- `tests/wit/features.wit`, `Bindings.g.cs` (the committed output),
  `Features.cs`, `tests/wit.mjs`: the world exercising every construct, its
  module, and a host keyed by canonical names; `buck2 test
  tilde//aseipp/cs2wasm:wit-test` regenerates, compares, compiles, runs and
  componentizes.
- `defs.bzl`: the Buck macros.
