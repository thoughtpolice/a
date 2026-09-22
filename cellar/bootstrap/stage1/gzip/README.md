<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU gzip 1.2.4 is compiled with final native GCC 4.7.4 and musl 1.2.5.
BUILD declares the generic C compressor, decompressor, native POSIX features
and installation aliases. File timestamps, permissions and recursion remain
enabled. The upstream makecrc C program regenerates the CRC table; the
release table is stripped before compiling util.c.

Tests cover deterministic compression, binary round trips, CRC rejection,
in-place operation and timestamp/mode preservation. Source extraction uses
the earlier bootstrapped decoder and GNU tar. No configure or Make runs.
