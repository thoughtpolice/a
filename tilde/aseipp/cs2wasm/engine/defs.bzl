# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Kiln, a small entity-component-system engine for gameplayc console games.

    load("tilde//aseipp/cs2wasm/engine:defs.bzl", "KILN", "KILN_GENERATOR", "KILN_PLATFORM")

    gameplay.module(
        name = "game",
        srcs = ["Game.cs"] + KILN_PLATFORM + [":bindings"],
        deps = [KILN],
        generators = [KILN_GENERATOR],
    )

`KILN` is the engine's portable half as a gameplay library (the world,
storage, events, coroutines, math, rendering into an indexed canvas, the
synthesizer), compiled once from `KILN_CORE`, which runs on the CLR as
well; `KILN_PLATFORM` is its console SDK half, sources of the module
(it implements the SDK's bindings, which only a module can); and
`KILN_GENERATOR` the source generator that writes each program's
schedule, which every Kiln program (and Kiln library) compiles with.
"""

ENGINE = "tilde//aseipp/cs2wasm/engine"

KILN = ENGINE + ":kiln"

KILN_GENERATOR = ENGINE + ":generator"

KILN_CORE = [ENGINE + ":core/" + name for name in [
    "Attributes.cs",
    "Canvas.cs",
    "Entity.cs",
    "Events.cs",
    "Generated.cs",
    "Music.cs",
    "Particles.cs",
    "Phase.cs",
    "Rng.cs",
    "Schedule.cs",
    "Scheduler.cs",
    "SpatialHash.cs",
    "Sprite.cs",
    "Storage.cs",
    "Store.cs",
    "Synth.cs",
    "Tween.cs",
    "World.cs",
]]

KILN_PLATFORM = [ENGINE + ":platform/" + name for name in [
    "Controls.cs",
    "Host.cs",
    "Saves.cs",
    "Screen.cs",
    "Speaker.cs",
]]
