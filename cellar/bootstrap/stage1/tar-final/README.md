<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU tar 1.12

GCC 4.7.4 stage3 and musl 1.2.5 build a static tar from the prepared source
of the [early tar](../tar/README.md), with its regenerated date parser, LP64
fixes and full 100-byte header names.

## Tests

The tests check the version output, relative and absolute date parsing, and
an archive round trip.

```
buck2 test cellar//bootstrap/stage1/tar-final:
```
