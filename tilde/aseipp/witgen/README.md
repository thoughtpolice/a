<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# witgen

Bindings for WIT worlds, generated from the world with wit-parser, the crate
[wlink](../wlink/README.md) links components with. One tool for each side of
a world the repository writes code for by hand otherwise:

- `witgen csharp`: C# for a module gameplayc compiles, the world's imports
  to call and its exports to implement ([cs2wasm's
  docs/WIT.md](../cs2wasm/docs/WIT.md)).
- `witgen host`: the side of a world's imports a host implements itself,
  under wlink's host ABI, in TypeScript, C or Rust.
- `witgen c` and `witgen rust`: a C or Rust guest's bindings, from
  wit-bindgen's own generators (`third-party//rust:wit-bindgen-c` and
  `:wit-bindgen-rust`), with all of their options, built in the graph rather
  than downloaded.

```sh
buck2 run tilde//aseipp/witgen:witgen -- host sdk.wit hal.wit --world platform --lang ts -o hal_bindings.ts
```

WIT files or package directories come in dependency order; the world is the
last one's (its only world, or `--world`). Generated code starts with the
SPDX lines of that last file. What a backend cannot express it leaves out and
reports on standard error, one `witgen: not generated:` line each; `--strict`
fails instead.

## Host bindings

A package wlink links keeps every import nothing in it satisfies as a core
import with its canonical lowered signature, and exports the memory and
allocator of each one's canonical options as `wlink:import:M#F:memory` and
`:realloc` (wlink's README, "Host ABI"). The host is the callee of those
lowerings: it lifts the arguments out of the flat values and that memory, and
lowers the results back, allocating strings and lists with that allocator.
`witgen host` writes that part, per imported interface (and once for the
world's own functions, as module `$root`), so the host implements each
function with typed values:

| | TypeScript | C (over wasm2c) | Rust |
|---|---|---|---|
| The host implements | `interface Raw` | `console_hal_raw_write_log(...)` prototypes | `trait Raw` |
| The bindings give | `bindRaw(host, guest)`: the core imports of the module | the imports wasm2c's module calls | `raw::call(host, guest, name, args)` |
| The guest's memory and allocator | `Guest.binding(module, name)` | `F<name>_memory`/`_realloc` of `<BASE>GUEST(instance)` | `Guest` |
| A string or `list<u8>` parameter | `Uint8Array`, a view of the memory | `*_bytes_t`, pointing into the memory | `&[u8]`, a slice of the memory |
| Another list parameter | a typed array over the memory, or loaded records | a `*_view_t` read element by element | a `Vec`, copied |
| A result string | `Uint8Array \| string` | `*_bytes_t` in the host's memory | `Vec<u8>` |
| A result list | `ArrayLike<T>` | `*_list_t` in the host's memory | `Vec<T>` |

What is read and written where, and in what order, is wit-bindgen-core's
plan for a host providing an import (`abi::call` with `GuestImport` and
`LiftArgsLowerResults`, the library behind wit-bindgen's generators): each
language only renders its instructions (`src/host/plan.rs` keeps the
statements and blocks they make up). A new host language is that rendering
plus its declarations of the interface and types.

Strings arrive as their UTF-8 bytes, which the bindings do not validate; the
host decides what a malformed one means. Views of the guest's memory are
valid until the import returns: the bindings allocate nothing before the
host's function returns. Results are copied in after it does, each string or
list into fresh memory from the import's allocator (none for an empty one,
whose pointer is its alignment), outer before inner, element by element, and
lists of more than bytes zeroed first so padding is zero.

Where the canonical ABI traps, the bindings do: a pointer misaligned for what
it points at, a range outside the memory (through the host's own bounds
checks), a character that is not a Unicode scalar value, an enum's
discriminant out of range, and in Rust a call whose arguments are not the
import's core signature. More than sixteen flat parameters arrive spilled to
memory, and more than one flat result goes out through a return pointer, as
wit-parser's signature for the import says; the bindings check their own
flattening against it.

What a host implements this way is plain data: booleans, numbers,
characters, strings, lists, records, tuples, enums, and flags of up to 32
members. Functions that pass options, results, variants, resources, futures
or streams, async functions, and functions taking lists of strings or lists
are left out and reported. A C host additionally takes no lists of
characters or enums, nor records or tuples holding lists of more than bytes,
as parameters.

### TypeScript

The output is formatted as `deno fmt` formats it, so a host can check it in
beside its sources (Deno resolves imports relative to the file on disk) with
a test that regenerates it. `<NAME>_MEMORY` and `<NAME>_REALLOC` list the
functions whose imports have a memory and an allocator.

### C

One header. It declares the types (`_t`) and the functions the host
implements; a host includes it after declaring the imports' context type
(`--c-context`, `namespace_package_t` by default). In one source file the host
includes it again where `<BASE>IMPLEMENTATION` is defined, and
`<BASE>GUEST(instance)` as the wasm2c instance whose exports hold the imports'
memories and allocators; there the header defines each import as `F<name>` (`--c-flat-prefix`,
`namespace_package_` by default) and finds its memory and allocator as
`F<name>_memory(guest)` and `F<name>_realloc(guest, ...)`. Those are the
names the host's aliases give wasm2c's, which the console SDK's
`host_bindings.py` reads out of wasm2c's header. `--c-prefix` renames the
types and the host's functions (`namespace_package_interface_` by default;
its uppercase form is `<BASE>`). The header reads lists little-endian
whatever the host's byte order, and compiles cleanly under `-Wall -Wextra`.

### Rust

A module per interface, with the trait, `MODULE`, `MEMORY`, `REALLOC` and
`call`; the engine reaches the guest through the `Guest` trait the file
defines, so the bindings name no engine. The file is a module of the host's
crate: it starts with an inner attribute.

## Tests

```sh
buck2 test tilde//aseipp/witgen:
```

`tests/host.wit` holds every kind of value the host bindings carry. Its
bindings run against a guest memory of each test's own: in Rust
(`tests/rust_host.rs`), in C over wasm2c's runtime with warnings as errors
(`tests/c_host_test.c`), and in TypeScript under Deno, type-checked
(`tests/ts_host_test.ts`). The unit tests cover what is reported, signatures,
names and options.
