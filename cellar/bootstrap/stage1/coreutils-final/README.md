<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU coreutils 6.10: 96 native static executables and the groups script,
compiled with final GCC 4.7.4 and musl 1.2.5. The installation contains the
complete default native set from upstream src/Makefile.am. As upstream does
by default, it omits arch, hostname and su. Optional libacl, libselinux and
message catalogs are disabled; chcon/runcon retain their normal unsupported
platform diagnostics.

BUILD declares every program, shared helper, configuration value, header
transformation and generator. The GNU option parser preserves permutation
and long options; the bundled GNU regex engine provides its extended API.
Musl's public stdio extension functions replace the old private FILE-layout
assumptions. Gnulib's imported C/header copies are handwritten implementations;
its Unicode width table and release date parser are not compiler inputs.

Four table generators run under final GCC: three C ports of the Perl tools
and the upstream CRC generator embedded in cksum.c. The embedded release CRC
table is stripped before compilation. Bison regenerates getdate.c directly
from its grammar. Four byte comparisons check the generated tables against
isolated release fixtures; those fixtures never feed compiler actions.

All 108 package tests pass: generator validation, program version checks and
seven functional groups covering permissions, recursive copy/move/link/remove,
text operations, GNU option parsing, 64-bit arithmetic and sparse files, six
hash families, binary base64, relative/nanosecond dates and UTF-8. Every native
program is static ELF. The tests preserve this release's byte-count result
for expr regex matches, while checking that its regex matches UTF-8 characters.
