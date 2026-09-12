<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Embed compiled gameplay

For a complete game using this interface, see [the Breakout walkthrough](../examples/breakout/README.md).
It builds and runs in a browser or in a deterministic terminal simulation.

The compiler supports typed Wasm function imports declared as ordinary static
`extern` C# methods. `gameplayc` supplies the `Gameplay.WasmImportAttribute`
declaration during binding; no source definition or runtime assembly is needed.

```csharp
using Gameplay;

internal static class Game
{
    [WasmImport("game", "read_x")]
    internal static extern float ReadX(int handle);

    [WasmImport("game", "set_position")]
    internal static extern void SetPosition(int handle, float x, float y);
}
```

The generated module imports `game.read_x` and `game.set_position`. They are
host capabilities, not native DLL calls. Unannotated `extern` methods and
arbitrary framework calls remain unsupported.

| C# type | Wasm ABI |
| --- | --- |
| `int`, `uint`, enums over them | `i32` |
| `sbyte`, `short` | `i32`, sign-extended; an imported result is sign-extended again |
| `byte`, `ushort`, `char` | `i32`, zero-extended; an imported result is masked to its width |
| `bool` | `i32`; zero is false, any nonzero imported result becomes true |
| `long`, `ulong` | `i64` |
| `float` | `f32` |
| `double` | `f64` |
| `void` result | No result |

This is the flat form of the component model's canonical ABI for scalars,
enums and flags, so a module whose imports and exports are named after a WIT
world is that world's core module. Exported entries canonicalize their
arguments the same way (bools to 0/1, narrow integers to their width), so a
host may pass any i32.

Imports cannot accept or return C# objects, arrays, strings, or references.
Pass integer handles for objects owned by the host. The host decides which
handles are valid and which operations they permit. Module/name pairs must be
unique; each string must be valid Unicode, nonblank, at most 256 UTF-16 code
units, and free of control characters, which admits the component model's
`ns:pkg/iface@1.0.0` and `[method]res.f` spellings. A module can declare at
most 1024 imports. Methods cannot have bodies, other attributes (including
return attributes), optional parameters, or by-reference parameters.

Exports follow the same rules: `[WasmExport("frame")]` names an export
explicitly, and public static scalar-signature methods of public classes are
exported under `Namespace.Class.Method` (see the README's Exports section).
The attribute declarations are in [sdk/Gameplay.cs](../sdk/Gameplay.cs).

## Multi-frame example

From this directory (the script builds the compiler through Buck2):

```sh
./examples/run-hosted.sh
```

[HostedGameplay.cs](../examples/HostedGameplay.cs) imports entity enumeration,
positions, velocities, liveness checks, and movement commands. Each tick creates
temporary Wasm objects, applies gravity, and requests host updates. It uses
field initializers, compound assignments, and array `foreach`.

[game-host.mjs](../examples/game-host.mjs) owns the entity state and one Wasm
instance. With frame durations `0.5`, `1`, and `0.5` seconds, the two active
entities end at `(4, -3.5)` and `(8, -6.5)`; the inactive entity stays at `(8, 8)`.
Temporary Wasm objects may be collected after a call; durable state stays with
the host and is read again on the next frame.

```js
import fs from 'node:fs';
import { createGameHost, exampleEntities } from './examples/game-host.mjs';

const module = new WebAssembly.Module(fs.readFileSync('publish/hosted-gameplay.wasm'));
const host = createGameHost(module, exampleEntities());
host.step(0.5);
host.step(1);
host.step(0.5);
console.log(host.snapshot());
```

The example uses a fixed host interface. Other embeddings can instantiate the
module with their own callbacks; inspect required module/name pairs with
`WebAssembly.Module.imports(module)` or `wasm-tools print`.

## Frame commit and failure

Reads observe the state at the start of a frame. Write callbacks validate the
entity handle and finite numeric values, then append commands to a batch. The
host applies that batch only after the export returns successfully. Reads do
not observe queued writes within the same frame.

`FailAfterMove` queues a position change and then traps on an array access. The
example discards the pending change, reports `__fault == 6`, and successfully
runs the next frame on the same instance. Host exceptions, including invalid
handles or nonfinite commands, also discard the batch. They may leave
`__fault == 0`, so a thrown exception must always be treated as a failed call.

The adapter refuses reentrant entry while a frame is executing. The compiler
gives every exported entry fresh fuel, call depth, allocation accounting and
fault code, and restores the caller's on return, so a nested entry from a host
callback does not disturb the outer call; an entry during static
initialization faults with code 12. These budgets do not meter time inside a host callback or limit
physical engine memory; embeddings must impose their own host/engine limits.
Transactional behavior belongs to this adapter, not to arbitrary Wasm imports.

## Verification

```sh
node tests/integration.mjs "$GAMEPLAYC" --all-tools
```

Host tests check primitive ABI values, noncanonical Boolean results, import
indexing, argument/field/constructor/object-initializer order, multi-frame
updates, invalid handles, and discarded commands after traps. They run in Node
and SpiderMonkey on original and Binaryen-optimized modules. Pure C# fixtures
also run through the actual .NET differential oracle.
