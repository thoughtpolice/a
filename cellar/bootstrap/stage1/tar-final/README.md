<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU tar 1.12 rebuilt with final GCC 4.7.4 and static musl 1.2.5.
The prepared source is shared with the earlier tar: it retains the regenerated
date parser, LP64 fixes and full 100-byte header-name handling. Three acceptance
tests cover version, relative/absolute dates and archive round trips.
