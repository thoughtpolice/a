<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

The numbered patch is preserved from live-bootstrap revision
`dd8ac27bf959344b9bcf5e876bdd7716879bbc70`, including the original copyright
and GPL-2.0-or-later SPDX notices. BUILD applies its strong pthread-reference
setting to the generic operating-system header. The configure.host selection
is represented directly in the BUILD header mapping.

The original block in `gthr.patch` retains GCC's original GPL-3.0-or-later
license with the GCC Runtime Library Exception. Its replacement
was written by Austin Seipp in 2026 under those same terms. The patch helper requires
exactly one matching block and writes a separate output.

Each patch without its own SPDX notice has a REUSE `.license` file beside it
that records its copyright holders and license.
