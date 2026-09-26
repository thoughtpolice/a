<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

These are C ports of GNU coreutils 6.10 src/dcgen (Jim Meyering),
src/wheel-gen.pl and src/extract-magic, under GPL-3.0-or-later. The original
Free Software Foundation copyright and license apply to these ports; the
package installation retains COPYING.

Dcgen collapses horizontal whitespace and emits NUL-terminated C character
arrays. Wheel-gen derives prime-wheel increments for the selected size.
Extract-magic validates and translates the annotated stat.c case labels.
The generated outputs match the release fixtures byte for byte, including
formatting. Fixtures are only dependencies of comparison tests.
