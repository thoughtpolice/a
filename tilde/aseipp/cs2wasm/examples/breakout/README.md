# Breakout: C# gameplay in a browser

This example compiles C# into a playable Breakout game. C# moves the ball,
handles collisions, awards points, and decides when the player wins or loses.
JavaScript supplies input, retains the game state, and draws the result on an
800 × 600 canvas.

There are 32 bricks worth 10 points each and one ball. Clear the bricks to win;
lose the ball to end the game. The browser must support WebAssembly GC.

## Build and play

From this directory, run:

```sh
buck2 run tilde//aseipp/cs2wasm:gameplayc -- -o publish/breakout.wasm examples/breakout/Breakout.cs
node examples/breakout/serve.mjs
```

Open <http://127.0.0.1:8080> on this machine, or use a printed `Network` URL
from another device. The server listens on all IPv4 interfaces (`0.0.0.0`);
you can also use the server's reachable IP address or hostname with port 8080.
The game starts paused. The server serves the browser files and the compiled
`publish/breakout.wasm` from an explicit allowlist. To use another port, run
`node examples/breakout/serve.mjs 8081`.

| Control | Action |
| --- | --- |
| Pointer | Move the paddle toward the pointer's horizontal position. |
| Left/right arrows or A/D | Move the paddle with the keyboard. |
| Space | Pause or resume. |
| R | Reset the game. |
| Step button | Advance one simulation step while paused. |
| Test rollback button | Exercise a failed frame and verify that its writes do not commit. |

Pause and use Step to inspect the ball and paddle positions. The simulation
uses fixed steps of `1 / 120` second; drawing follows the browser's animation
frames. Several simulation steps can run before the next draw. Switching away
from the tab pauses the game.

## Run without a browser

The same compiled module and host adapter also run in Node:

```sh
node examples/breakout/run.mjs
```

This runner exercises the game with deterministic inputs. It is useful when
changing gameplay rules: browser timing and pointer movement are not involved.

With the supplied rules and paddle controller, the verified output is:

```text
Loaded 7378 bytes; 16 typed host imports.
Rollback: fault 6; all queued changes discarded.
20s: score 80, 24 bricks left.
40s: score 150, 17 bricks left.
60s: score 220, 10 bricks left.
80s: score 270, 5 bricks left.
100s: score 310, 1 brick left.
Won: score 320, all 32 bricks cleared in 13658 ticks (113.82 simulated seconds).
```

These are simulated seconds; the terminal run advances without waiting for
real time. The controller follows the ball with a changing horizontal offset
to vary its paddle rebounds. The runner asserts rollback, recovery, a full
victory, and unchanged state after the round ends. Changes to the compiler or
gameplay can change the byte size and trajectory.

For the repository's broader acceptance checks, run:

```sh
deno run --allow-all tests/integration.mjs "$GAMEPLAYC" --all-tools
```

The Breakout checks exercise the original module and Binaryen's optimized
output in Node and SpiderMonkey. This game has host imports, so its checks use
the supplied host adapter; the separate .NET differential suite covers pure
C# fixtures.

## Follow one frame through the code

| File | Responsibility |
| --- | --- |
| [Breakout.cs](Breakout.cs) | Gameplay rules, temporary bodies, and typed host-call declarations. |
| [host.mjs](host.mjs) | Initial state, validated host callbacks, and frame commits. |
| [app.mjs](app.mjs) | Browser input, the fixed-step clock, and drawing. |
| [index.html](index.html), [style.css](style.css) | Canvas, controls, and page layout. |
| [run.mjs](run.mjs) | Deterministic terminal exercise of the game. |
| [serve.mjs](serve.mjs) | Local server for the example and compiled Wasm. |

1. **Compile the source.** `gameplayc` binds `Breakout.cs` with Roslyn, then
   emits Wasm functions and GC types. Methods marked with `WasmImport` become
   typed function imports. The browser loads the resulting Wasm; it does not
   load the C# compiler or a .NET runtime.
2. **Connect the imports.** `createBreakoutHost` instantiates the module with
   JavaScript callbacks. These callbacks expose the game state through integer
   handles and primitive values. A handle identifies a host entity; it is not
   a pointer to a JavaScript object.
3. **Advance the simulation.** For each fixed step, the browser calls
   `host.step(seconds, targetX)`. The adapter invokes the exported
   `Demo.Breakout.Tick(float seconds)` method with the current paddle target
   available through the host interface.
4. **Run C# gameplay.** `Tick` loads entity data into temporary C# bodies,
   updates movement, resolves collisions, and requests state changes through
   the imports. Its result is `0` while playing, `1` after winning, or `2`
   after losing.
5. **Commit the frame.** Write callbacks validate their arguments and queue
   commands. A successful return commits the batch. A trap or host exception
   discards it, leaving the previously committed state available.
6. **Draw the snapshot.** The browser obtains the committed state from
   `host.snapshot()` and paints the entities and score. Drawing does not
   implement the collision or scoring rules.

For example, this declaration connects a C# call to the host's
`breakout.read_x` callback, passing an integer handle and returning an `f32`:

```csharp
[WasmImport("breakout", "read_x")]
internal static extern float ReadX(int handle);
```

The compiler supplies the attribute declaration during binding. The callback
itself is JavaScript in `host.mjs`; it is not part of the generated Wasm.

Reads observe the state at the start of a step. Queued writes do not change
what subsequent reads return during that step. The temporary C# bodies let
gameplay calculations work with updated values before committing them.

## Host state and Wasm heap objects

`createInitialState()` provides the starting entities. `createBreakoutHost`
accepts that state, or creates a default state when none is supplied:

```js
import fs from 'node:fs';
import { createBreakoutHost, WORLD } from './examples/breakout/host.mjs';

const module = new WebAssembly.Module(fs.readFileSync('publish/breakout.wasm'));
const host = createBreakoutHost(module);
host.step(WORLD.stepSeconds, 400);
console.log(host.snapshot());
```

The snapshot contains `entities`, `score`, and `status`. Each entity has
`handle`, `kind`, `alive`, `x`, `y`, `vx`, and `vy` fields. The host module also
exports `WORLD` for dimensions and the fixed step, `KIND` for entity kinds, and
`STATUS` for the playing/won/lost values. `step` requires a finite paddle
target and a positive duration no greater than `WORLD.stepSeconds`.

The `Body[]` array and body objects allocated by C# belong to the Wasm GC
heap. They hold working values for a tick and can be collected afterward.
Entity state that must survive the next tick belongs to the host and changes
only when the command batch commits. This separates temporary allocation from
the durable state of the running game.

## Inspect a failed frame

The Test rollback control calls `host.failFrame()`. This deliberately requests
changes and then causes a trap. The host discards those queued changes, and
`host.lastFault()` reports array-bounds fault `6`. The next valid step can run
on the same instance.

Command batching belongs to this host adapter. A callback that immediately
changes external state would need its own rollback policy; Wasm does not undo
arbitrary JavaScript side effects.

## Change the game

For gameplay changes, edit `Breakout.cs`, compile it again, and reload the
page:

```sh
buck2 run tilde//aseipp/cs2wasm:gameplayc -- -o publish/breakout.wasm examples/breakout/Breakout.cs
node examples/breakout/run.mjs
```

Try changing a gameplay constant or the collision response, then use paused
steps to inspect the result. Changes to the initial entity layout belong in
`host.mjs`; changes to controls or drawing belong in `app.mjs`. Reload the
page after editing those files. Rebuild `gameplayc` with Buck2 when
changing the compiler itself.

`BounceOffPaddle` changes the outgoing direction according to the hit
position. `BounceOffBrick` resolves an expanded rectangle with square corner
regions; `Tick` removes at most one brick per step. Keep the small fixed steps
when experimenting with this collision model.

See [the hosting guide](../../docs/HOSTING.md) for the primitive import ABI,
host exceptions, and frame commit behavior shared with the smaller example.
