<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native target changes

The numbered unified patches are preserved from live-bootstrap revision
`dd8ac27bf959344b9bcf5e876bdd7716879bbc70`, with their original SPDX notices.
BUILD applies exact before/after blocks from the native Linux, x86_64 and
stdint hunks using the bootstrapped immutable patch helper. Configure and
Makefile hunks are represented by reviewed BUILD configuration instead.

The numbered `.before` and `.after` fragments retain the corresponding unified
patch's copyright and GPL-2.0-or-later license. They are checked against the
pinned GCC source with exactly one matching block; no fuzzy patching runs.

`tmpdir.before` and `tmpdir.after` adapt libiberty's LGPL-2.0-or-later temporary
directory selection. The original source copyright is retained, and the
replacement written by Austin Seipp in 2026 is licensed under LGPL-2.0-or-later.

`remove_gperf_dependency.patch` retains the pinned reference's original
copyright and GPL-3.0-or-later notice. Its two C++ source hunks are applied by
`except-include` and `except-libfn`; the Makefile hunk is represented directly
by the BUILD inputs. This conservatively disables recognition of additional
nonthrowing C library calls and removes the shipped `cfns.h` dependency.

`gcov-program` changes only the generator-name comment in `gcov-iov.h` so it
does not record an action path. Its before block retains the GCC source's
GPL-3.0-or-later license; the replacement is Copyright 2026 Austin Seipp under the
same license.

`driver-tool` and `driver-pipe` reject an unresolved compiler subcommand before
libiberty could search the host `PATH`. The before blocks retain GCC's
GPL-3.0-or-later license; the replacement checks are Copyright 2026 Austin Seipp
under the same license. They cover ordinary commands and pipeline members.

`runtime-eh` applies the native Linux hunk from the preserved
`0003-unwind-fix-for-musl.patch`, enabling the target's `dl_iterate_phdr`
unwind lookup. `runtime-context` uses musl's public `ucontext_t` typedef in the
x86_64 signal-frame fallback. Its before block retains GCC's GPL-3.0-or-later
license with the GCC Runtime Library Exception; the replacement is Copyright
2026 Austin Seipp under those same terms.

`c-family-mask` removes a redundant extern specifier from the initialized
language-mask definition; `c-common.h` supplies the external declaration.
This preserves linkage while allowing the C bootstrap's later stages to use
-Werror. The source is Copyright 2002–2011 Free Software Foundation, Inc.,
GPL-3.0-or-later; the 2026 Austin Seipp replacement uses the same license.
