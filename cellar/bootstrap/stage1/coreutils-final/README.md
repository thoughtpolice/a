<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU coreutils 6.10

GCC 4.7.4 stage3 and musl 1.2.5 build the default programs of upstream
src/Makefile.am as static executables, plus the groups script. As upstream
does by default, the set leaves out arch, hostname and su.
[programs.bzl](programs.bzl) lists the programs and their sources. libacl,
libselinux and message catalogs are disabled, so chcon and runcon report
that the platform does not support them.

BUILD declares every shared helper, configuration value, header wrapper and
generator. The GNU option parser keeps argument permutation and long options,
and the bundled GNU regex provides its extended API. The programs use musl's
public stdio extension functions instead of the old private FILE layout.

Native generators replace release-generated sources: C ports of the Perl
tools that write dircolors.h, wheel.h and fs.h, and the CRC generator
embedded in cksum.c, whose release table is stripped before any compilation.
The early Bison regenerates getdate.c from its grammar.

## Tests

The generated tables must match the release copies, which serve only as test
fixtures. The generators must reject malformed input, and every program but
false and test reports its version. Shell tests cover permissions, recursive
copy, move, link and remove, text operations, GNU option parsing, 64-bit
arithmetic, sparse files, the hash programs, base64, relative and nanosecond
dates and UTF-8. They keep this release's byte-count result for expr's regex
matches while checking that its regex matches UTF-8 characters.

```
buck2 test cellar//bootstrap/stage1/coreutils-final:
```
