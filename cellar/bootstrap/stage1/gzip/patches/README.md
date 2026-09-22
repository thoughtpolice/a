<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

Use the native standard headers for getenv/strcmp/strncmp. The 1993 fallback
wrongly declares strncmp with int instead of size_t on LP64. Upstream GNU
getopt copyright and GPL-2.0-or-later license are retained in the source.
