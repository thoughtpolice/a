<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU sha256sum across GCC 4.7 generations

This package compiles GNU coreutils 6.10's `sha256sum` and the gnulib helpers
it needs with each of GCC 4.7.4's three stages, against musl 1.2.5. Each
generation uses the same logical source paths, flags and archive order. The
sources, configuration and generated headers come from `coreutils-final`,
without its generated tables, so the first generation does not depend on
programs the final compiler built. `sha256sum` runs the third generation,
and `bootstrap` collects all three with their tests.

```sh
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1/sha256:bootstrap
```

The tests require every object, the archive and the program to match
between successive generations, and the third generation's program to match
the delivered coreutils `sha256sum` byte for byte. Each generation also
checks SHA256 test vectors, padding boundaries, a million-byte input,
binary, standard and multiple-file input, escaped filenames, text and binary
records, the check, status and warning modes and error exits, and compares
its output with the delivered command. Each checks the stage0 seeds' golden
answers too, which the stage0 check verifies with mescc-tools-extra's
`sha256sum`.

These checks follow one program through the compiler generations. They
supplement the GCC 4.7.4 stage 2 and stage 3 comparisons, which are the
compiler's fixed point.
