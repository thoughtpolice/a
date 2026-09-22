<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU grep 2.4, egrep and fgrep are individually linked static programs built
with final GCC 4.7.4 and musl 1.2.5. Their shared archive contains the upstream
DFA, GNU regex, keyword-set matcher and file/search support. BUILD declares
the reviewed LP64 configuration and all source/header inputs directly. There
are no configure, Make or source-generator actions for this package.

Tests cover basic backreferences, extended expressions, fixed strings, case
folding, line numbers, multiple patterns, context and error/absence statuses.
