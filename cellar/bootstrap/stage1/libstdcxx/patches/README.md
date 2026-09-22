<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

The numbered patch is preserved from live-bootstrap revision
`dd8ac27bf959344b9bcf5e876bdd7716879bbc70`, including the original copyright
and GPL-2.0-or-later SPDX notices. BUILD applies its strong pthread-reference
setting to the generic operating-system header. The configure.host selection
is represented directly in the BUILD header mapping.

The exact `gthr.before` source fragment retains GCC's original GPL-3.0-or-later
license with the GCC Runtime Library Exception. The `gthr.after` replacement
was written by Austin Seipp in 2026 under those same terms. The patch helper requires
exactly one matching block and writes a separate output.
