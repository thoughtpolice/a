<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# wlink

A static linker for WebAssembly components.

WebAssembly components can be thought of in terms of "holes" represented by an
interfaces. A component that relies on an interface, when compiled as a module,
has a "hole" in the module that must be filled by a module which implements
said interface (similar to a Functor in ML-derived languages, or "mixin modules"
in Haskell). This is no different than a C program be compiled to an `.o` file,
which must then have that definition filled later.

Thus, components need to be linked together before they can be run. For a full
webassembly component module to execute, all of the "holes" must be filled with
a satisfying implementation. The task of `wlink` is to fill these holes, just
like a typical object code linker, **and emit a standard WebAssembly Module**.

`wlink` can also leave some of these holes "open" and thus create a residual
program. This is a common case, typically where the final programs' "open" holes
are interfaces implemented by the underlying host environment. The most obvious
example of this pattern is the WASI interfaces used by a WASI program in the
component module, which are implemented inside the host program.

The output module from `wlink` should run on any standard WebAssembly engine,
assuming appropriate holes are filled by the host, including ahead-of-time
translators such as `wasm2c`. This making deployment of component-based
applications (including non-WASI ones!) to existing standard webassembly
runtimes a bit easier.

```
wlink link -o linked.wasm platform=platform.wasm game=game.wasm
wlink componentize core.wasm --wit sdk.wit --world game -o game.wasm
wlink print linked.wasm
```

Inputs may be binaries or component text (`.wat`); `name=path` names a
component, otherwise it is located by file stem.

## Host ABI

Unsatisfied functions remain core imports with their canonical lowered
signatures. Identical lowerings share an import. When the same module/name is
lowered with different canonical options (for example, different memories),
each import name gets a `$lowerN` suffix, where `N` is its index in the linked
module's function imports. A name with only one lowering is unchanged.

For an import `M` / `F`, the output exports its canonical memory as
`wlink:import:M#F:memory` and its allocator as `wlink:import:M#F:realloc`, when
those options are present. `F` includes the suffix when one is needed. Hosts
must use that memory for pointer arguments and results, and that allocator for
returned strings and lists. Component memories also retain their usual
`<component>:memory` exports.

Package function exports retain their core lifted signatures. For an export
`F`, its canonical memory and allocator are exposed as
`wlink:export:F:memory` and `wlink:export:F:realloc`, when present. If its lift
specifies a post-return function, it is exported as `cabi_post_F`. The host
must call it once after reading the result, passing the original core return
values, before making another call into that component. It must not read the
returned storage after post-return has reclaimed it.

### Resources

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

Core module instantiation order is preserved, including data and table
initialization before each instance's start function. Nested component aliases
retain the environment in which their component was defined.

## Feature support

Basic support for the component model 0.2 ABI:

- UTF-8 strings
- scalars, records, tuples, enums, flags, variants, options, results, strings,
  and lists, nested however the interface likes
- resource handles, owned and borrowed, wherever a value can hold them.

Note that strings and lists are relatively expensive when crossing a component
interface, as they must be reallocated into the consumers linear memory.
Handles are cheap: a call moves them between tables that live in one
synthesized memory of the linked module, exported as `wlink:handles`, and a
borrowed handle passed to the component that implements the resource costs
nothing at all.

Not yet supported:

- non-UTF-8 encodings
- component start functions,
- component values
- everything async.
