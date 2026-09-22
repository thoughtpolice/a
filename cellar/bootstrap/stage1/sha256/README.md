<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU SHA256 checksumming across the three GCC 4.7.4 bootstrap generations.

From the standalone `cellar/` directory:

```sh
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1/sha256:bootstrap --local-only
../buck/bin/buck2 run @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1/sha256:sha256sum -- --check checksums
```

`stage1-sha256sum`, `stage2-sha256sum` and `stage3-sha256sum` compile the real
GNU coreutils 6.10 implementation and its fourteen gnulib helpers with the
corresponding compiler, CRT and libgcc. Each build uses the same logical
source paths, flags and archive order. `sha256sum` runs the third generation;
`bootstrap` collects all three and their comparison/compatibility tests.

Source preparation reuses the pinned upstream archive and reviewed native
coreutils configuration. Its explicit source/header inventory excludes the
unrelated generated tables, keeping the first generation independent of
final-coreutils generators. This adds no compiler, binary seed or new SHA256
implementation. The final userland continues to deliver GNU coreutils.

The tests compare all fifteen objects, the archive and the executable across
successive generations, and require the final executable to match the
delivered coreutils binary byte for byte. Each generation checks SHA256 vectors,
padding boundaries, a million-byte input, binary/stdin/multiple-file input,
GNU escaped filenames, text/binary records, check/status/warning modes and
error exits. Output is compared with the delivered GNU command, and every
generation verifies checksums of all three actual executable files.
Each GNU generation also checks all nineteen upstream stage0 golden answers,
independently repeating the early checksum program's existing seed checks.

Compatibility means the GNU coreutils 6.10 interface; later options such as
`--quiet`, `--strict` and `--zero` are outside this release. These checks
supplement the GCC stage2/stage3 compiler-object comparisons; matching one
application alone would not establish a compiler fixed point.
