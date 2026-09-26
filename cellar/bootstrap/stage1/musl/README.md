<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# musl 1.1.24

Static musl 1.1.24 is built in three passes, each by a newer TCC. BUILD
declares every source, native override, generated header and CRT object; each
object gets a short unique archive member name, and C compiles with `-Werror`.
Bootstrapped sed runs musl's own `alltypes.h` and `syscall.h` generators.

| Pass | Compiled by | Sources |
| --- | --- | --- |
| `initial` | `tcc-release:tcc-mes1`, linked against Mes libc | reduced |
| `rebuilt` | `tcc-musl:tcc-musl1` | reduced |
| `restored` | `tcc-musl:tcc-musl2` | reduced plus the table users |

The reduced sources leave out complex functions, which TCC cannot compile,
and the Unicode, ctype and iconv functions that use generated tables. They
also take musl's generic C math, since TCC's assembler lacks x87 instructions
that the native math uses. The native startup, TLS, clone, setjmp, string and
floating-environment assembly stays. `restored` compiles the table users with
the tables `musl-tables` regenerates; musl's shipped tables are left out of
every prepared source tree.

Each pass `<name>` provides `<name>-libc.a`, the CRT objects, empty
compatibility archives such as `libm.a`, and the `runtime-<name>` sysroot and
`<name>-link-runtime`, which pair the pass with a TCC `libtcc1.a`. `defs.bzl`
describes one pass. `:tcc` is `tcc-musl2` with the restored
sysroot, and `tcc-link-runtime` is what programs it links need around their
objects. `:tcc` marks the musl headers as system headers, so package include
directories come first.

The patches adapt SysV varargs to TCC's support library, call Linux syscalls
through an assembly entry where TCC's inline assembly runs out of registers,
drop PLT syntax from static sigsetjmp calls, and keep errno across malloc's
madvise. The madvise change follows the pinned live-bootstrap patch by Richard
Masters. The local adaptations are MIT, like musl.

The tests check the generated layouts and varargs, then run each pass's
programs: startup and environment, formatted output, allocation, mmap,
setjmp, floating arithmetic, fork, pipes and wait, fenv, signal masks,
file-backed mmap at a nonzero offset, and threads with their own errno and a
shared mutex. The restored pass also checks Unicode classification, case
mapping, widths, multibyte decoding and iconv conversions. The programs use
memfd for temporary files and need no host userland.

```
buck2 test cellar//bootstrap/stage1/musl: --local-only -j 8
buck2 run cellar//bootstrap/stage1/musl:tcc -- example.c -o example
```
