<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

The exact signames patch changes only the generated comment to use a stable
program name. The surrounding source retains its GNU Bash GPL-3.0-or-later
license and Free Software Foundation copyright.

The identity patch adds the opt-in CELLAR_BOOTSTRAP_IDENTITY environment flag
for isolated actions and pseudoterminal tests. When real/effective IDs match,
it supplies the fixed bootstrap name, root home and /bin/bash shell without
reading the host account database. Without the flag, upstream account lookup
is unchanged. This patch is GPL-3.0-or-later like the surrounding shell.c.

Each patch without its own SPDX notice has a REUSE `.license` file beside it
that records its copyright holders and license.
