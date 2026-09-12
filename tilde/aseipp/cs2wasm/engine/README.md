<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Kiln: an entity-component-system engine for gameplayc

Kiln is a small ECS engine for games compiled by gameplayc, arranged as
Bevy, Unity's DOTS or EnTT are: the engine is a library (`:kiln`, a
`gameplay.library` of `core/`) whose world knows no game's types, and each
game gets a generated plugin. A program describes its data and behaviour
with attributes, and Kiln's source generator (`generator/`, run by
`gameplayc --generator`) writes the program's schedule at compile time
(its components' ids and storage, its query loops, the order of its
systems), as plain typed C#: nothing is looked up by reflection at run
time, and the same program runs on the CLR (csc runs the same generator
as an analyzer).

```csharp
[Component] partial struct Position { public Vector2 Value; }
[Component] partial struct Velocity { public Vector2 Value; }
[Component] partial struct Frozen { }                // no fields: a tag
[Resource] sealed class Clock { public float Step = 1f / 60; }
[Event] partial struct Damage { public Entity Target; public int Amount; }

static partial class Motion
{
    [System(Phase.Update)]
    [Without<Frozen>]
    static void Integrate(ref Position position, in Velocity velocity, Clock clock) =>
        position.Value += velocity.Value * clock.Step;
}
```

## The world

- **Components** are `partial` structs marked `[Component]`. The program's
  schedule gives each an id (from 0, by full name, among the program's
  and its Kiln libraries' components, as many as there are) and, unless
  it is a tag (no instance fields), a sparse set per world: the components
  packed densely, which is what queries walk, and each entity's index into
  them. An entity's components are a bitset (below). The generator makes each component an
  `IComponent<T>` where it is declared, so `world.Get<T>(entity)`,
  `Has<T>`, `Add<T>`, `Remove<T>` and `Query<T1, T2>()` take components
  and nothing else.
- **Entities** are a slot and a generation, so a despawned entity never
  aliases the one reusing its slot.
- **Resources** (`[Resource]` classes) are the world's, one of each type:
  `world.Resource<T>()` and `SetResource`, and, where the resource is
  declared, a property of the world named after its type (a C# 14
  extension property the generator writes: `world.Clock`), made at start
  when they have a parameterless constructor.
- **Events** (`[Event]` partial structs) are channels kept for two ticks.
  A system reads them with an `EventReader<T>` parameter, which is its own
  cursor, so each reader sees each event once whether it runs before or
  after the sender; it sends with an `EventWriter<T>`.
- **Bundles** (`[Bundle]` record structs of components) spawn or add
  several components at once: `world.Spawn(new Mover(position, velocity))`
  (extension methods, where the bundle is declared).
- **Changes while iterating** (spawning, despawning, adding and removing
  from inside a system or a `foreach` over a query) are deferred until the
  iteration ends and applied in order, so iteration never sees its storage
  move.

`World.Create()` makes a world run by the program's schedule (it is `new
World(new Kiln.Generated.GameSchedule())`). A program may have several
worlds at once, each with its own entities, storage, channels, resources
and readers; `world.Dispose()` drops a world's storage and gives its index
to the next world made.

### Storage without casts

`World` is the engine's, so it cannot have a field per component. A
component's storage is instead a table per component type,
`Storage<T>`, indexed by the world's `Index`: `world.Get<T>(entity)` is
a static field load (`Storage<T>`'s table: a Wasm global, since each
component is its own instantiation of the class), a field load (the
world's index), an array index and the entity's dense index, with no
`ref.cast` (the table is an array of one-field structs, which stay exactly
typed where gameplayc's arrays of references share one representation
under shared generics), no boxing and no lookup. A component's id and
tag-ness are statics of `Storage<T>` too, so `Has<T>` is a bit test of
the entity's words against globals. Event channels are `Channels<T>` tables alike.
Resources are a table per resource type as well, but resource types are
classes, whose instantiations share code: reading one goes through that
code's dictionary and a cast, once per system run (or per
`world.Resource<T>()`), never per entity.

A system's query loop (below) takes each of its components' sparse sets
from the tables once per run, then walks the smallest one as before: the
loop itself is unchanged.

### An entity's components

An entity's components are a bitset of `world.MaskWords` words, a slot's
words side by side in `world.Masks` (a slot's first word at `slot *
MaskWords`), however many components the program has. The first word's
top bit marks the entity alive; a component's bit is its id's place
counting past it (`World.BitOf`: ids 0 to 62 are the first word's bits 0
to 62, id 63 the second word's bit 0, and so on), so a program of at most
63 components has one word per entity, which is the ulong mask Kiln had
before it had more. The schedule's component count sets the words, and the
generator, which knows the count, writes each query loop's test as
constants over the words its components are in, and only those: one
`(mask & required) != required || (mask & excluded) != 0` of the slot's
one word in a program of at most 63 components, and in a wider one a
single `(word & (required | excluded)) != required` per word the query
has components in (the alive bit is tested only when nothing else tells a
living entity from a free slot, whose words are all zero). A query built at
run time (`world.Query<T1, T2>().Without<T3>()`) keeps its first word's
bits in fields and the other words' in an array it makes only when it has
a component past the first word, so a query of a one-word program tests one
word as before. Despawning removes the entity's components word by word,
each set bit's storage, and clears the words.

The other layouts were weighed: sparse-set membership (EnTT's: a component
is had when its set's sparse index points back at the entity) tests each
component with two dependent loads where a word tests all of that word's
components with one, and tags would need sets of their own; archetypes
(Bevy's, Unity's) iterate by archetype, which would change the order
queries visit entities in (and so a game's outcome, which Lichgate's pinned
runs check). A bitset per entity keeps the order and the one-word loop.

## Systems and the schedule

A system is a static method of a partial class marked `[System(phase)]`.
Its parameters say what it runs over: `ref` components are written, `in`
and by-value ones read, and it runs once per entity that has them all (and
every `[With<T>]`, and none of the `[Without<T>]`), driven by the smallest
of their stores; an `Entity` parameter is that entity. A `World`, a
resource, an `EventReader<T>` or an `EventWriter<T>` parameter is the
world's. A system with no component parameters runs once per phase.
`[RunIf(nameof(Condition))]` names a static bool method of the class whose
parameters are resources, checked before the system runs.

Each phase's order is decided by the generator: `[After]` and `[Before]`
are edges, and among the systems free to run next the one with the lowest
`Order`, then by class and method name. `World.Tick()` runs the coroutines
that are due, then the `PreUpdate`, `Update` and `PostUpdate` phases, then
ages the events; `World.Render()` runs the `Render` phase and `Startup()`
the `Startup` one. `world.Systems` lists the schedule with each system's
reads and writes.

The schedule is the generated `Kiln.Generated.GameSchedule`, a
`Kiln.Schedule`: its `Attach` gives a new world its components' storage
(and the program's components their ids), its event channels, its
resources and each reading system's `EventReader`s; its `Run(phase)`
calls the phase's systems' loops in order. The world calls it once per
phase (a virtual call), and does the rest itself: removing a despawned
entity's components by its mask, ageing the events, describing an
entity.

The generator reports what it cannot make sense of as compiler
diagnostics, located in the source:

| Id | Severity | Meaning |
| --- | --- | --- |
| KILN001 | error | a component is not a partial, non-generic struct |
| KILN003 | error | a program's system's class (or one around it) is not partial |
| KILN004 | error | a system is not a static, non-generic void method |
| KILN005 | error | a system parameter is nothing a system can take |
| KILN006 | error | a component passed `out` |
| KILN007 | error | a tag as a parameter (use `[With<T>]`) |
| KILN008 | error | a resource, event or bundle of the wrong shape |
| KILN009 | error | a component taken twice |
| KILN010 | error | `[After]`/`[Before]` make a cycle |
| KILN011 | error | ordering against an unknown system, or one of another phase |
| KILN013 | error | a run condition that is not a static bool method of resources |
| KILN014 | error | a Kiln library's declaration that is not public, or (in a program) one it cannot use: not public, or of a library compiled without the generator |
| KILN020 | warning | two systems of a phase touch a component, one writing it, with nothing ordering them |

## Kiln libraries

A gameplay library compiled with Kiln's generator (`gameplay.library`
with `generators = [KILN_GENERATOR]`) is a Kiln library, and contributes
gameplay to every program that references it, as a Bevy plugin does: its public components, resources, events,
bundles and systems join the program's schedule. The program's generator
reads them from the library's metadata (Roslyn's symbols of the referenced
assembly) and schedules the library's systems with the program's own, so
a program's system can be ordered against a library's (`[After("Spinning.Turn")]`)
and read its events. Compiled with the generator, the library gets what its
own declarations need: its components' `IComponent<T>`, its events'
`IEvent<T>`, its resources' world properties and its bundles' `Spawn` and
`Add`, all public, and the mark of a Kiln library,
`[assembly: Kiln.Generated.KilnLibrary]`, by which a program's generator
finds it; it gets no schedule. Its systems need not be in partial classes
(the program calls them), but they, like everything a library declares,
must be public (KILN014). A library's sources say nothing of being one:

```csharp
[Component] public partial struct Spin { public int Turns; public int Speed; }
[Resource] public sealed class Odometer { public int Total; }

public static class Spinning
{
    [System(Phase.Update)]
    public static void Turn(ref Spin spin, Odometer odometer) => odometer.Total += spin.Speed;
}
```

The generator knows a library's compilation from a program's by what the
build tells it: gameplayc gives every generator the global analyzer option
`build_property.GameplayOutputKind`, `library` under `--library` and
`module` otherwise (the README's "Source generators"). A compilation
without the option, as csc's for the CLR sides of the tests, is a library
when it is a DLL and a program when it is an executable (`:kiln-clr` and
`:test-plugin-clr` are `csharp.library` targets, `:tests-clr` a
`csharp.binary`). A library compiled against Kiln without the generator is
no Kiln library: a program over it is told (KILN014) that each of its
declarations cannot join the schedule.

`tests/plugin/Spinning.cs` is one, which `tests/Ecs.cs` uses. Kiln is
one too: `Particles` is a resource of every world (`world.Particles`,
none until the game gives it a pool), and Kiln's `Particles.Advance`,
which ages it, is a system of every program's post-update phase;
Lichgate's sparks age that way. A Kiln library references `:kiln` as a
program does.

Libraries' components take ids among the program's, by full name, as
the program's own do, so a library's may be past the first word of an
entity's components (`tests/Wide.cs` has its plugin's there).

## Coroutines

`world.Scheduler` runs coroutines in game time: `await
scheduler.Ticks(n)`, `Seconds(s)`, `NextTick()` and `Until(condition)`
complete at a fixed step, in the order they were made, inside `Tick` and
before the systems. `Scheduler.Start(entity, async script => ...)` starts
a script owned by an entity, whose waits are dropped when the entity is
despawned, so the script simply stops; an exception escaping one is thrown
again from the tick that finds it. The waits are the engine's own rather
than `Task.Delay`, so a script runs identically on the CLR, whose
`Task.Delay` is wall time.

## Services

Beside the world, `core/` has what a game is made of, as plain C# that
runs on the CLR too (the tests compare the two):

- **Drawing** (`Canvas.cs`, `Sprite.cs`): an indexed canvas, a byte per
  pixel, with a camera offset and a clip rectangle; filled and outlined
  rectangles, lines, circles and rings, sprites with transparency,
  horizontal flips, a solid colour (a hit's flash) or a remapping table (a
  palette swap, a shadow), opaque blits of other canvases, and a 3x5 pixel
  font. Pixel art is written in source as rows of palette digits. A
  `Palette` holds the 256 colours and a brightness for fades and flashes.
- **Particles** (`Particles.cs`): a fixed pool of plain arrays rather than
  entities, each spark walking a colour ramp as it ages; the world's
  `Particles` resource, if it has one, ages every tick.
- **Sound** (`Synth.cs`, `Music.cs`): a synthesizer of square (with a duty
  cycle), triangle, saw, sine and linear-feedback noise voices with
  envelopes, sweeps and vibrato, mixed to 44.1 kHz stereo; sound effects
  as `Sound` records; a step sequencer, and a composer that writes a song
  from a seed (a mode, a progression, a bass line, an arpeggio, a melody
  and drums).
- **Motion** (`Tween.cs`): easing curves written once over
  `IFloatingPointIeee754<T>` generic math, interpolation over any
  `INumber<T>`, and `Tween<T>`, which counts an int up as readily as it
  eases a float.
- **Collision** (`SpatialHash.cs`): a uniform grid of circles by layer,
  rebuilt every tick with no allocation once grown.
- `Rng` (PCG32, seeded, forkable) and `KeyValues` (saved data as
  `key=value` text).

## On the console

`platform/` (`KILN_PLATFORM`, sources of the game's module rather than a
library: it implements the SDK's bindings and calls its imports, which
only a module's own sources may) implements the console SDK's `game` world
(`Console.Sdk.Game.Init` and `Frame`) over the bindings `witgen` makes of
it: a game derives from `App`, declares `static partial App Create()`, and
gets `Start`, a fixed-step `Tick` at 60 a second whatever the display's
rate (a frame's milliseconds are accumulated exactly, and the frame loop's
game time advances by the ticks', so `Task.Delay` and `Frames.NextFrame`
line up with them), and `Draw` per displayed frame. `Host` has the rest:

- `Screen`: the canvas presented through the palette with
  `present-indexed` (the palette uploaded only when it changes), and the
  platform's overlay for text in its 5x7 font and panels.
- `Speaker`: the synthesizer's samples, topping the audio queue up to three
  frames ahead after every frame.
- `Controls` and `InputMap<TAction>`: keys with their presses and releases
  since the last tick (a tap shorter than a frame still counts), the
  buttons, the mouse and typed text, and a game's actions bound to them.
- `Saves`: whole text files in the save directory, through the `files`
  interface.
- An exception escaping the game is logged with its type and message
  before the module traps, since a host sees only the trap.

A frame that renders a whole screen and mixes a frame of audio needs more
than gameplayc's default budgets: games raise `fuel` (to 1,000,000) and
`alloc_units` (a canvas's bytes are charged 8 units each).

## Tests

```sh
buck2 test tilde//aseipp/cs2wasm/engine:
```

`:engine-test` runs `tests/Ecs.cs` and `tests/Services.cs` compiled by
gameplayc into Wasm over the Kiln library and the Kiln library
`tests/plugin` (`:test-plugin`), and by csc into a CLR program over their
CLR builds (all with the generator), and compares every check (the world,
the schedule, events, deferred changes, coroutines, several worlds at
once and disposal, resources, the plugin's components, systems and events
in the program's schedule, Kiln's own particle system; random numbers, easing and tweens in float and
double, the spatial hash against brute force, drawing, particles,
synthesized audio sample by sample, composed songs, saved data), and
checks the ones whose answer is known on its own (the schedule's order,
the plugin's place in it, run conditions, generations).
`:wide-test` runs the same comparison over `tests/Wide.cs`, a program of
133 components whose entities have three words (the plugin's components
among them, past the first word): its systems and queries require and
exclude components of every word, and random spawns, adds, removes and
despawns, some deferred inside a query, are played against a plain model
of each entity's components, which the world, its counts, its queries and
what each system ran over must match.
`:diagnostics-test` compiles the programs in `tests/diagnostics` and
expects their errors and warnings, among them a Kiln library's that are
not public, and a program over a library compiled without the generator.
`:smoke-test` links `tests/Smoke.cs`, a minimal app, with the console's
platform (`console_link`) and runs it twice under the console's headless
host (`console_headless`) with a scripted key
press and a save directory: its coroutines' game time, the key, and the
save file read back and written again.

[Lichgate](../examples/lichgate/README.md) is a whole game on Kiln.
