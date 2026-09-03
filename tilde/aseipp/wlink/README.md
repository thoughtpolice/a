<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# wlink

A static linker for WebAssembly components. It takes a set of components whose
imports and exports plug into each other, evaluates the whole instantiation
graph ahead of time, and emits **one standard core module**. Calls that cross
a component boundary become fused adapters written as ordinary wasm; the only
imports left are the ones nothing in the package satisfies.

The output runs on any core engine, including ahead-of-time translators such
as `wasm2c`, and is plain input for any compiler that consumes core modules.

```
wlink link -o linked.wasm platform=platform.wasm game=game.wasm
wlink componentize core.wasm --wit sdk.wit --world game -o game.wasm
wlink print linked.wasm
```

Inputs may be binaries or component text (`.wat`); `name=path` names a
component, otherwise its file stem does.

## How it links

1. **Decode** (`component.rs`). Each component becomes its list of
   definitions: core modules and instances, nested components and instances,
   aliases, `canon lift`/`lower`, imports and exports. Types are resolved
   through wasmparser's validator into a small interface-type model
   (`types.rs`).
2. **Plan** (`plan.rs`). The definitions are interpreted with a frame per
   component instantiation, exactly as a runtime would instantiate them, but
   producing a plan instead of running anything: a list of core module
   instances in instantiation order with every import resolved, one adapter
   per `lower` of a `lift`, the lowered imports nothing provides, and the
   package's exports. Top-level components plug into each other by interface
   name, so a `wac` composition step is not needed, though a composed
   component links just the same.
   Each component instantiation is a frame, the owner of a handle table;
   resource types are created as the frames defining them are instantiated,
   bound through type imports, exports, and aliases, and named by index in
   every function type the plan records.
3. **Adapt** (`adapter.rs`). Each adapter converts between the caller's and
   the callee's canonical ABI by walking the value types: strings and lists
   are copied into the callee's memory through its `realloc`, handles move
   from the caller's table to the callee's, results are converted back
   through the caller's, spilled parameter lists and results go through
   memory as the ABI specifies, and `post-return` is honoured. Functions
   whose values never touch memory or a table bind straight to the callee.
   The same walk wraps host imports and exports that carry handles, so the
   host only ever sees representations.
4. **Merge** (`merge.rs`). Every instance's definitions are renumbered into
   the output with `wasm-encoder`'s reencoder, multiple memories included.
   Unsatisfied imports are exported in their lowered (flat) form and reached
   through trampolines, each component's memory is exported as
   `<component>:memory`, and a synthesized start runs every instance's start
   in order. When handles are in play, `handles.rs` contributes one table in
   a memory of its own, its maintenance functions, and the `resource.new`,
   `resource.rep`, and `resource.drop` built-ins.

## What the prototype supports

The synchronous 0.2 ABI with UTF-8 strings: scalars, records, tuples, enums,
flags, variants, options, results, strings, and lists, nested however the
interface likes, and resource handles, owned and borrowed, wherever a value
can hold them. Not yet: non-UTF-8 encodings, component start functions,
component values, and everything async.

Strings and lists are relatively expensive when crossing a component
interface, as they must be reallocated into the consumer's linear memory.
Handles are cheap: a call moves them between tables that live in one
synthesized memory of the linked module, exported as `wlink:handles`, and a
borrowed handle passed to the component that implements the resource costs
nothing at all.

## Resources at the host boundary

The host never sees a handle: wherever an import or export names a resource,
the host passes and receives the resource's representation, the `i32` a
component gave `resource.new` or the host gave out itself. The linked module
keeps every component's handle table itself and converts at the edge.

For a resource type `R` the host implements, imported from interface `I`, a
component that drops an owned handle makes the output import `I` /
`[resource-drop]R` taking the representation, which the host implements as
the destructor. A borrowed handle passed to the host is lent to it for the
call only. A handle may reach a host import anywhere: where it lies in the
component's memory, inside a list or in a parameter list that spills, the
linked module rewrites that word to the representation for the duration of
the call and puts a borrowed handle back afterwards, while an owned handle
is consumed and its word is left holding the representation. A host that
calls back into the component during such a call sees representations in
the lists it was passed. Results may hold handles anywhere.

For a resource type `R` a component implements and the package exports
through interface `I`, the output exports `I#[resource-drop]R` taking the
representation; the host calls it to destroy a resource it owns. An owned
handle the host passes in is created in the component's table, and an owned
handle it receives has been removed from it.

## The demo SDK

`demo/` is the shape the console is meant to take:

- `wit/sdk.wit` is `console:sdk`, the world games program against, with
  records, flags, enums, and strings.
- `wit/hal.wit` is `console:hal`, the scalar boundary a machine implements,
  and the `platform` world that exports the SDK over it.
- `platform/` implements the SDK in Rust for wasm32; `game/` is a game
  against it. Both use hand-written canonical ABI bindings.
- `host/main.c` implements the HAL over stdio and drives the frame loop of
  the `wasm2c` translation of the linked package.

`buck2 test tilde//aseipp/wlink/...` links the demo, runs it under wasm2c, and
checks that the linked package is plain core wasm with nothing but the HAL left
imported.
