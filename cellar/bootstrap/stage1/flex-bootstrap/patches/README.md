<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Source adaptations

The yyin declarations and scanner compatibility changes are the BSD-2-Clause
patches from live-bootstrap dd8ac27bf959344b9bcf5e876bdd7716879bbc70:
Copyright 2019-2020 Giovanni Mascellani, 2021 Andrius Štikonas and fosslinux.
The handwritten scan.lex.l preserves its own attribution and complete license.

The skeleton-generator adaptation (2026 Austin Seipp, BSD-2-Clause) supplies the two
here-document cat calls using Bash read/printf builtins. The upstream sed
transformation and skeleton remain unchanged. Every replacement checks an exact
unique before block and writes a separate artifact.

The yyunput skeleton definition uses the existing YYFARGS2 macro, adding the
scanner argument consistently in reentrant mode. The original handwritten
argument list omitted it. The reentrant test exercises unput on a separate
scanner instance. This adaptation is copyright 2026 Austin Seipp, BSD-2-Clause.
