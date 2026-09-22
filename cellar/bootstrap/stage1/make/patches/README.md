<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

The exact blocks adapt GNU Make 4.2.1 main.c (GPL-3.0-or-later).
Adaptation copyright 2026 Austin Seipp under the same license. BOOTSTRAP_SHELL
selects the relocatable installation default; normal Makefile and command-line
SHELL overrides retain their precedence. Unset preserves upstream behavior.
The job.c adaptation escapes whitespace, quotes and backslashes in the default
shell executable path before Make reparses its internal command. It preserves
normal explicit multiword SHELL settings and is covered by a space-path test.

Each patch without its own SPDX notice has a REUSE `.license` file beside it
that records its copyright holders and license.
