<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU findutils 4.2.33

GCC 4.7.4 stage3 and musl 1.2.5 build static find, xargs and locate, the
frcode, code and bigram helpers that updatedb runs, libfind and the bundled
gnulib library. The release already contains the gnulib import that its
import-gnulib.config pins. BUILD writes the gnulib version string and fills
the gnulib header templates with reviewed native values.

The updatedb script comes from upstream with every tool, database and
temporary path quoted, so paths containing spaces work, and it puts BINDIR in
front of the caller's PATH instead of the host's system directories. xargs
runs echo from PATH by default. The runnable find, xargs and locate targets
get coreutils on PATH, and `:updatedb` gets the coreutils, sed and gawk
programs that its script runs.

## Tests

The shell tests cover directory pruning, regex dialects, symlinks, `-exec`
aggregation, `-execdir`, `-delete`, NUL-separated xargs input with embedded
newlines and quotes, parallel execution and child exit statuses. Both locate
database formats round-trip through updatedb, with checks for case folding,
regex lookup, existence filtering and corrupted databases.

```
buck2 test cellar//bootstrap/stage1/findutils:
```
