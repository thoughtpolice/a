<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU findutils 4.2.33 with final GCC 4.7.4 and static musl 1.2.5. BUILD
models find, xargs, locate, libfind, the bundled gnulib helper library and
frcode/code/bigram individually. The pinned release already contains gnulib
8e128ebf42e16c8631f971a68f188c30962818be, matching its import configuration.
The gnulib version string is explicit build metadata. Header wrappers are
prepared from upstream templates with reviewed native values.

The delivered updatedb script composes the declared tools, preserves both
modern and legacy database formats, and honors the caller's PATH instead of
inserting host system directories. xargs' default echo also uses PATH. Its
Buck runnable target supplies GNU echo explicitly. The installed scripts'
relocatable launch configuration is assembled at the stage1 installation gate.

All seven tests pass, including directory pruning, regex dialects, symlinks,
-exec aggregation, -execdir, -delete, NUL-safe xargs with embedded newlines and
quotes, parallel execution and child-status propagation. Both locate database
formats round-trip through updatedb; tests cover case folding, regex lookup,
existence filtering and corrupted-input diagnostics. All six C programs are
static ELF. The database script uses the final GCC build of gawk.
