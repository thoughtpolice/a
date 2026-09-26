<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# MPC 1.2.1

The rebuilt GCC 4.0.4 builds MPC's static library against
[GMP](../gmp/README.md), [MPFR](../mpfr/README.md) and musl 1.2.5, with a
reviewed native GNU C99 configuration. BUILD declares the library's
translation units, the configuration, the public header and `:installation`.
The archive hash matches live-bootstrap's. No configure or Make process runs,
and no generated build-system file is used.

## Tests

The upstream tests run with seed 42 and read their data files through a
declared directory. They cover complex arithmetic, elementary functions,
rounding, conversion, norms, roots of unity, precision, exceptional values and
stream I/O. The stream-I/O test runs in a declared output directory, and its
captured output is compared with GMP's expected seed message.

```
buck2 test cellar//bootstrap/stage1/mpc:
```
