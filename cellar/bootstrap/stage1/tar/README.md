<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native GNU tar 1.12

The rebuilt GCC 4.0.4 builds a static tar with musl 1.2.5. BUILD declares
the individual translation units and reviewed native configuration. Bison 3.4.1
regenerates the real date parser from `getdate.y`; the release parser and the
reference recipe's date stub are not consumed. This package is built before
GCC 4.7.4 because that archive needs GNU long-name extraction, which the seed
extractor does not support.

The immutable source changes add two missing standard-header declarations,
make the octal mode parser const-correct, and correct native unsigned-long
format strings. The obsolete rexec transport is disabled for musl. A remote
shell must be supplied explicitly with `--rsh-command`; no host shell is baked
in. Compression commands are not exercised at this milestone. Upstream 1.12's
incomplete `--posix` mode is retained without claiming full POSIX conformance.

Three tests cover the version, absolute and relative dates with explicit UTC,
timezone offsets, leap dates, invalid dates, archive round trips, 220-character
names and link targets, hard links, modes, date-based file selection and malformed
archive rejection. The integration test writes only in its declared output
directory. Bootstrap archive actions use `--numeric-owner` to avoid reads of
host account databases. Compiler inputs use stable logical source paths.

```
buck2 test cellar//bootstrap/stage1/tar: --local-only -j 8
buck2 build cellar//bootstrap/stage1/tar:installation
```

The final userland milestone will rebuild this package with the final GCC.
