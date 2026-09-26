<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

shell.patch adapts GNU Make 4.2.1 main.c (GPL-3.0-or-later) so that
BOOTSTRAP_SHELL, when set, becomes the default shell. Makefile and
command-line SHELL settings keep their precedence, an empty value fails, and
unset keeps upstream's behavior. shell-path.patch adapts job.c to escape
whitespace, quotes and backslashes in that default shell's path before Make
reparses its internal command, while explicit multiword SHELL settings work
as before. Both adaptations are copyright 2026 Austin Seipp under the same
license.

Each patch without its own SPDX notice has a REUSE `.license` file beside it
that records its copyright holders and license.
