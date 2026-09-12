<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Lichgate

A twin-stick roguelite for the console SDK, written in C#, compiled by
gameplayc to Wasm GC and run on [Kiln](../../engine/README.md), the
entity-component-system engine: a gameplay library the game references,
and a source generator that writes the game's schedule at compile time.

Descend the Lich's crypt a floor at a time. Each floor is grown from the
run's seed: rooms branching out from the start, a treasure room and a
shrine at dead ends, and the Lich's lair at the dead end farthest away.
Clear a room and its doors open; kill the Lich and take the stairs down
to a harder floor, and the next.

```sh
buck2 run tilde//aseipp/cs2wasm/examples/lichgate:terminal             # play in the terminal
buck2 run tilde//aseipp/cs2wasm/examples/lichgate:lichgate-web-serve   # or in a browser, at the printed address
buck2 test tilde//aseipp/cs2wasm/examples/lichgate:                    # the headless runs below
```

Every host is the console SDK's web host, over the linked module
optimized for a Wasm engine (`console_link` with `gc = True`: the native
runner's wasm2c has no garbage collector), in the browser, headless, or in
the terminal (`console_terminal`, `sdk/web/terminal.ts`): half-block
cells in 24-bit colour, sound through `pw-cat`, `aplay`, `play` or
`ffplay` when one is installed, saves under
`$XDG_DATA_HOME/console/lichgate`. Options follow the target
(`-- --seed 5`, `-- --no-audio`), and `-- -- --autopilot` watches the
demonstration. A terminal reports no key releases, so a key stays down for
a moment after each press and auto-repeat holds it; the mouse aims where
the terminal reports it. The page needs a browser with WebAssembly GC.

## Playing

| Keys | |
| --- | --- |
| W A S D | move |
| arrows (or I J K L) | shoot in that direction, diagonals too |
| mouse, left button | shoot at the pointer |
| Space, Shift, right button | dash (briefly untouchable) |
| Escape, P | pause; there M turns the music off and on, Q ends the run |
| Enter | start, continue |

- **Creatures**, each an async script: bats dart at you askew; slimes squat
  and leap, and the big ones split in two; skeletons keep their distance
  and loose arrows; eyes blink and fire rings of orbs; boars glare, paw the
  ground and charge until a wall stuns them; wisps drift closer and burst.
  They fade in before they can hurt or be hurt.
- **The Lich**, in three phases by its health: aimed fans while it circles
  you and rings between teleports; then spirals while it raises skeletons
  and bats; then, cursed (the room goes red), a double spiral with fans at
  once. Its servants and shots die with it.
- **Relics**, from the treasure room's altars and the Lich's: damage, rate
  of fire, speed, an extra shot, homing, piercing, a heart, range, a pact
  that trades a heart for damage, and a siphon that may heal on a kill.
- **Score**: kills (times a combo multiplier that grows while you keep
  killing), gems, rooms and floors. A high score asks for a name, typed,
  and joins the hall of the fallen on the title screen, saved in the
  console's save directory (`lichgate/scores.txt`) with the music setting.
- Left alone for twenty seconds, the title plays a demonstration: the
  autopilot, the same code the tests run.

## How it is built

The game is Kiln's components, resources, events and systems, over the
Kiln library (`deps = [KILN]`), with Kiln's console platform among its
sources; Kiln's generator writes its schedule (`Kiln.Generated.GameSchedule`,
which `World.Create()` runs a world with) and its resources' world
properties (`world.Crawl`):

- `Components.cs`: `Position`, `Velocity`, `Body` (a circle on a collision
  layer), `Health`, `Look` (sprite frames and a palette remap), `Enemy`,
  `Bullet`, `Pickup`, `Offer` (an altar's relic), and tags (`Hero`, `Boss`,
  `Spawning`, `Gate`); `Hit`, `Died` and `Collected` events; `Mob` and
  `Shot` bundles; the `Crawl` (the run: stats, score, the floor), `Intent`
  (what the player or autopilot asks for), `Effects` and `Space`
  resources. The run's sparks (`Effects.Particles`) are also the world's
  `Particles`, the resource of Kiln's own, which the engine ages every
  tick with its `Particles.Advance` system: Kiln is a Kiln library, whose
  systems join the game's schedule.
- `Systems.cs`: steering and firing, movement against the room's walls and
  rocks, bullets (homing, piercing, breaking on walls), the spatial hash's
  broad phase, strikes and contact damage, pickups and relics, wounds and
  deaths (sparks, score and combo, drops, slimes splitting, the Lich's
  end), and the room's doors. The generator orders them by phase and
  `Order`/`[After]`, and warns where two writers of a component are
  unordered.
- `Render.cs`: the render phase's systems, drawing into the indexed canvas:
  the room's background, doors, shadows, everything with a `Look` sorted
  by depth (flashing on a hit, pale while spawning), particles and
  popups, the curse, and the heads-up band with hearts, score, combo, the
  floor's map and the Lich's health.
- `Enemies.cs` and `Boss.cs`: each creature is a bundle and a script, an
  async method on Kiln's scheduler (`await script.Ticks(n)`) owned by the
  creature, so it stops where it was when the creature dies; the Lich runs
  its patterns together with `Task.WhenAll`. Directions turn through
  System.Numerics' `Matrix3x2`, and positions are its `Vector2`s, on
  gameplayc's SIMD.
- `Dungeon.cs`: the floor's rooms, doors and rock layouts from the seed,
  and each room's background drawn once; `Art.cs` the palette (DB32 and
  its shaded, cursed and pale variants) and the pixel art, written as rows
  of palette digits, with tiles drawn from a seed.
- `Game.cs`: the Kiln `App`. Its scenes are one async flow over the frame
  loop: the title (`await Frames.NextFrame()` each tick), a run (rooms
  entered through fades eased by `Tween<float>`, floors, the hero's end),
  the pause menu, and the end with its name entry and `Task.Delay`. Fights
  are encounter scripts owned by a room's director entity; the lair's is
  the Lich's entrance.
- `Autopilot.cs`: the demonstration's player, which writes the same
  `Intent` the keys do: fight at a distance leading the target, dodge
  shots coming at it, dash through close ones, pick up what helps, take a
  relic, and walk the floor with a breadth-first search over the doors and
  then over the room's tiles.
- `Sounds.cs`: sound effects as `Sound` records for Kiln's synthesizer, and
  the songs its composer writes: the title's, one per floor from the
  seed, and the Lich's.
- `Scores.cs`: the hall of the fallen, ranked with LINQ, and the settings,
  as key=value saves.

The module is compiled with `fuel = 1000000` and
`alloc_units = 16777216`: a frame renders a whole 320x192 indexed screen
and mixes a frame of audio.

## Tests

- `:autopilot-test` keeps the module to its size budget (1,445,463
  bytes), then lets the autopilot play 12,000 frames of seed 7 of the web
  package under the console's headless host. The first run dies in the
  lair; the second takes a relic, kills the Lich, takes another and
  reaches floor 2. The
  run is a function of its seed, so the last frame's and the audio's
  hashes are pinned; a change to the game that changes them updates them.
- `:play-test` plays `tests/play.txt`, a player's scripted session (start,
  a fight, a quit, a name typed for the hall), records it, and replays the
  recording into a fresh save directory, which must give the same run; a
  third run from the first's save directory finds its high score.
- `:terminal-test` draws two seconds through the terminal host's renderer,
  without a terminal.
- `:test-lichgate-web-package` checks the browser package (`console_web`).
