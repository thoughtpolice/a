<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

Use PATH to locate diff and pr instead of compiling absolute installation
prefixes. Buck supplies an explicit helper PATH; installed programs use their
ordinary environment. The source keeps GNU diffutils copyright and GPL-2.0-or-later.

The regex patches preserve full-width pointers during failure-stack transport
and comparison on LP64, using uintptr_t rather than 32-bit int. Narrow
register numbers are converted back only after the pointer-width conversion.
The original GNU regex GPL-2.0-or-later copyright and license are retained.

Each patch without its own SPDX notice has a REUSE `.license` file beside it
that records its copyright holders and license.
