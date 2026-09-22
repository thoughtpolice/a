<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU patch 2.5.9 is built statically with final GCC and musl. BUILD declares
native file, signal, wide-character and unlocked-stdio configuration plus
the upstream sources. Unified, context and normal patches, reversals, backups,
date parsing and reject output remain enabled. Ed-format patches retain the
upstream optional external ed command.

Tests create real patches with the delivered GNU diff and check forward and
reverse application for all three formats, rejected hunks, unchanged rejected
input and malformed-input diagnostics. Temporary files remain within a
declared output directory. No configure or Make action builds this package.
