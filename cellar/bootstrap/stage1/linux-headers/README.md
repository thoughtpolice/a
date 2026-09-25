<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Linux 6.18.54 UAPI headers

This package installs the Linux kernel's user space API headers for x86_64
from the `linux-6.18.54.tar.xz` longterm release, as
`make ARCH=x86_64 headers_install` does. Runtimes include them for kernel
interfaces musl leaves to the kernel, such as the futex operations libc++'s
atomics wait with. `:headers` is the installed `include` directory, laid out
like `usr/include` with `asm`, `asm-generic`, `linux` and the other
subdirectories. `:installation` adds the kernel's notices under
`share/licenses/linux`.

```sh
buck2 test @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/linux-headers:
```

## Installation

One action decompresses and extracts the tarball, keeping only the UAPI
directories, the scripts and system call tables that generate headers, the
top Makefile and the notices.

The kernel's `headers` target works in two steps, and so does this package.
[generate.sh](generate.sh) writes the headers `make headers` generates first,
in the layout of the kernel's object tree.

- `linux/version.h` from the Makefile's version fields, as
  `filechk_version.h` writes it.
- A wrapper including the `asm-generic` header for every mandatory `asm`
  header that x86 neither ships nor generates, as
  `scripts/Makefile.asm-headers` makes them.
- `unistd_32.h`, `unistd_64.h` and `unistd_x32.h` from the system call
  tables, through the kernel's own `syscallhdr.sh` with the ABIs, offset and
  options of `arch/x86/entry/syscalls/Makefile`.

[install.sh](install.sh) then follows `scripts/Makefile.headersinst` for
`include/uapi` and `arch/x86/include/uapi`. Every header in their
subdirectories and in the generated tree, less those `include/uapi/Kbuild`
leaves out for the architecture, passes through the kernel's
`headers_install.sh`. That script removes kernel annotations and runs
unifdef, which GCC 13 builds from `scripts/unifdef.c` with the kernel's host
compiler flags. install.sh stops if a Kbuild file names exclusions it does not
know, or if the headers land in top-level directories other than those
[defs.bzl](defs.bzl) lists, which installations merge with the C library's
`include` directory.

The scripts run with the bootstrap's Bash, sed, grep, find and coreutils. The
bootstrap's GNU sed 4.0.9 predates the `-E` spelling of extended regular
expressions, so the build patches `headers_install.sh` to spell it `-r`, which
means the same. Upstream's scripts otherwise run unchanged.

## Tests

`header-test` repeats the kernel's own header test from `usr/include/Makefile`.
Each exported header, included twice into an empty translation unit, compiles
with GCC 13 against musl's headers under `-std=c90 -Wall -Werror -m64`, and
`usr/dummy-include` stops any of them from reaching `<stdlib.h>` or
`<stdbool.h>`. It skips the kernel's list of headers known to fail and the
`asm-generic` headers, which only `asm` headers include. The bootstrap has no
Perl, so the kernel's `headers_check.pl` does not run.

`futex-test` compiles a program against these headers and musl together, as
libc++ builds, then runs a futex wake and a futex wait on a word that no
thread waits on.
