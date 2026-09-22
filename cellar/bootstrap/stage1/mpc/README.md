<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native static MPC 1.2.1

BUILD declares all 82 library translation units, the reviewed native GNU C99
configuration, the static library, public header and license installation.
The source archive hash matches the pinned live-bootstrap revision. The rebuilt
GCC 4.0.4 links programs with musl 1.2.5, GMP 6.2.1 and MPFR 4.1.0. No configure
or Make process runs, and no generated build-system inputs are consumed.

All 69 upstream tests pass with seed 42 and an explicit declared fixture
directory. They cover complex arithmetic, elementary functions, rounding,
conversion, norms, roots of unity, precision, exceptional values and stream I/O.
The stream-I/O test runs in a declared output directory; its captured output is
compared after successful execution.

```
buck2 test cellar//bootstrap/stage1/mpc: --local-only -j 8
buck2 build cellar//bootstrap/stage1/mpc:installation
```
