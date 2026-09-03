<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Console SDK libc

A freestanding C library for wasm32 guests, so engines written against the
hosted C library compile for the console unchanged. `:libc` exports the
headers `assert.h`, `ctype.h`, `errno.h`, `math.h`, `setjmp.h`, `stdio.h`,
`stdlib.h`, `string.h`, `strings.h`, and `time.h`; the compiler's own
`stddef.h`, `stdint.h`, `stdarg.h`, `stdbool.h`, `limits.h`, and `float.h`
are self-contained in freestanding mode and are used as they are. Every
freestanding C guest gets the library through `//aseipp/wlink/demo/sdk:c`.

## What the console changes

The library sits on the SDK rather than on an operating system, and a few
functions mean something slightly different as a result:

- **Files.** `fopen` opens the SDK's file resources through the stream layer
  in modes `r`, `w`, and `a`, each with an optional `b`; `+` modes fail with
  `EINVAL`. Appending copies the existing contents into a fresh file, because
  the resource has no append mode. Reads are buffered; writes go straight to
  the file. `remove` and `rename` go through the SDK's `files` interface and
  report `ENOENT` for whatever it refuses, such as a read-only asset.
- **Standard streams.** `stdout` and `stderr` collect text until a newline
  and send each line to the console log at the info and error levels. `exit`
  flushes a pending partial line; `_Exit` does not. `stdin` is always at its
  end.
- **Memory.** `malloc`, `calloc`, `realloc`, and `free` are the reactor's
  allocator, 16-byte aligned, trapping when memory is exhausted.
- **Process.** `exit` and `_Exit` end the application with their status;
  `abort` traps. There is no environment: `getenv` finds nothing and `putenv`
  is accepted and ignored.
- **Time.** `time` counts seconds since the application started and `clock`
  milliseconds; `localtime` is `gmtime`.
- **Random numbers.** `rand` is a fixed-seed generator, so a headless run is
  reproducible.
- **setjmp.** WebAssembly cannot capture a call stack and return into it, so
  a jump is lowered onto the machine's exception mechanism instead: the
  compiler rewrites every function that calls `setjmp` to catch the tag
  `longjmp` throws, and `src/setjmp.c` is the runtime that decides which
  frame a jump was meant for. Jumps work as they do anywhere else, including
  out of several frames at once, with the usual rule that a local written
  between the two and not declared `volatile` is indeterminate afterwards.
- **assert.** A failed assertion logs the expression and location, then
  traps.

## Formatting and parsing

`printf`, `sprintf`, `snprintf`, and their `v` forms support the integer,
character, string, pointer, count, and floating-point conversions with flags,
widths, precisions, and the `hh`, `h`, `l`, `ll`, `j`, `z`, `t`, and `L`
modifiers. Floating-point output is exact: digits come from the binary value
and are rounded half to even at the requested place, so the text matches a
hosted C library digit for digit. `sscanf` covers the same conversions plus
scansets, widths, and assignment suppression; its `L` conversions parse at
double precision and widen. `strtod` is correctly rounded
for decimal and hexadecimal input, and `strtol` and `strtoul` follow the
standard's base rules. `qsort` is a heapsort.

The transcendental functions come from musl 1.2.5 (`musl/`, MIT; the files
derived from Sun's fdlibm carry the SunPro notice, and `COPYRIGHT` is musl's).
The fork keeps the sources verbatim apart from two changes: `libm.h` drops the
`endian.h` and `fp_arch.h` includes in favour of the wasm32 byte order and
the `hidden` attribute, and the data headers include `libm.h` instead of
musl's `features.h`. `sqrt`, `fabs`, `floor`, `ceil`, `trunc`, `rint`,
`copysign`, `fmin`, and `fmax` are inline functions over the compiler
builtins, which become WebAssembly instructions.

## Tests

`buck2 test tilde//aseipp/wlink/demo/sdk/libc/...` runs three suites. The
native suite compiles the portable formatting and parsing routines for the
host and compares them with the host's C library over fixed cases and tens of
thousands of random values: printf output, `strtod` bit patterns and end
pointers, `strtol` values and `errno`, `sscanf` results, and `qsort` orders.
Where the standard leaves the behaviour open the library does what glibc
does, so on other hosts the suite leaves out what their libc prints
differently, such as a null `%p` or the sign of a NaN. The math suite
compiles the musl fork for the host and checks it against the host's libm to
within one unit in the last place, bit-exact for the non-transcendental
functions; `tan` gets three on macOS, whose libm is itself more than a unit
off for some arguments. The guest suite runs a wasm32 application under
the SDK runner and exercises files, the log-backed standard streams, the
clock, the process, and a sample of everything else.
