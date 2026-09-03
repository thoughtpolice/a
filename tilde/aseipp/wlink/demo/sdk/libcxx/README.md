<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Console SDK C++ library

The C++ standard library a freestanding wasm32 guest gets, so an engine
written in C++ compiles for the console. It sits on [the SDK
libc](../libc/README.md), and a guest gets both through
`//aseipp/wlink/demo/sdk/libcxx`.

## Why there is one at all

A standard library is configured for the machine it was built for, and the
machine doing the building is not the console. On macOS the host's is a libc++
whose headers stop at an `#error` as soon as the target is not Apple's; on
Linux it is a libstdc++ that would quietly decide what a guest can have from
how the build machine is put together. A guest compiled through either one
would be a different guest depending on who compiled it.

So wasm32 C++ compiles with `-nostdinc++` and everything a guest includes
comes from here. The only headers taken as they are are the compiler's own
`stddef`, `stdint`, `stdarg`, `stdbool`, `limits`, and `float`, for the same
reason the SDK's libc takes them: those describe the target rather than the
host.

## What is here

The runtime the language itself needs, which is the part the compiler emits
references to without being asked: `new`, `initializer_list`, `typeinfo`, and
`exception`. `src/support.cpp` holds the allocation operators over the SDK's
allocator, the guard and vtable symbols the compiler reaches for, and the
hash every keyed container is built on; `src/exceptions.cpp` holds the
exception runtime described below.

The vocabulary everything else is written in: `type_traits`, `utility`, and
`limits`.

The containers and the views over them: `vector`, `string`, `string_view`,
`unordered_set`, `optional`, `tuple`, and the `algorithm` that works over
them. Iterators are plain pointers throughout, so a range is a pair of them
and nothing needs `iterator_traits` to say what it holds.

The SDK's C library under the names C++ spells it with: `climits`, `cmath`,
`cstddef`, `cstdint`, `cstdio`, `cstdlib`, `cstring`, and `cwchar`. `cmath` is
the one with work in it, because the classification entries are macros and a
macro has no namespace to be put into.

And `stdexcept`, the standard error types, for code that names them whether or
not it can throw them.

## What the console changes

- **Exceptions are opt-in.** Guests build with `-fno-exceptions` by default,
  because unwind tables are emitted for every function that could be unwound
  through and most guests never throw. A guest that wants them compiles with
  `-fwasm-exceptions` instead, and `src/exceptions.cpp` supplies the runtime
  the compiler leaves out: the type information the ABI is built on, the
  personality that reads the tables the compiler emits to decide whether a
  handler wants what was thrown, and the `__cxa_` entry points around an
  exception while a handler holds it. Throwing, catching by exact type or by
  a base of it, `catch (...)`, rethrowing, and destructors on the way out all
  work; what is missing is matching through a virtual base, and exception
  specifications, which the language dropped in C++17. An exception that
  escapes the guest's entry point is not a handler's to catch: the host
  reports it as `guest trapped: Uncaught exception` and stops. There is no
  `exception_ptr`, so an exception cannot be carried anywhere but up.
- **No runtime type information.** `-fno-rtti`, so `dynamic_cast` and
  `typeid` are unavailable. `std::type_info` is still here, because the
  exception runtime is built on it, but nothing reaches it through the
  language.
- **Running out of memory is the end.** There is no `bad_alloc` and no
  `new_handler`: the throwing `operator new` reports the failure through the
  console log and stops the guest, which is also what a container that cannot
  grow and an index out of range do. A guest with exceptions turned on still
  cannot catch any of them.
- **No over-aligned allocation.** `align_val_t` is not declared, so a type
  that needs more alignment than the allocator gives is a compile error
  rather than a link one.
- **One thread.** The guards around function-local statics are plain flags,
  and nothing here takes a lock.
- **No wide characters.** `char_traits<wchar_t>` compiles but its routines are
  not defined, so a guest that instantiates them fails to link.

## Tests

`:test-exceptions` throws as a guest does: handler selection, catching a base
of what was thrown, `catch (...)`, rethrowing, destructors running on the way
out of a scope, and a jump and a throw nested inside one another, which are
the same mechanism underneath. `:test-guest` runs the containers as a guest
under the native runner, on the console's own allocator: growth and rehashing,
copies and moves, erasure in the middle, and element lifetimes counted so a
container is held to destroying exactly what it constructs. `:libcxx` builds
for wasm32 only, like the libc.

The library is also held to a much larger program than its own tests:
[Luau](../../luau/README.md) is an interpreter written against this and
nothing else, and its carts are checked against a recorded hash of every frame
they draw.
