<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Bootstrap action helpers

`capture` and `expect-exit` are M2-built helpers for declared standard I/O and
command tests. `withenv` preserves the caller's environment while setting
explicit values, then executes the declared command without a PATH search.

`libshell.a` contains the matching musl system/popen implementations under
private `bootstrap_system`/`bootstrap_popen` names. They require
`BOOTSTRAP_SHELL`, preserve the upstream signal and stdio ownership behavior,
and fail with ENOENT when the setting is absent. The source and its COPYRIGHT
come from `musl:source-restored`; source transformations are explicit in BUILD.
Callers rename the standard functions at compilation and carry the shell's
artifact in their configured RunInfo. m4's shell tests cover direct execution,
captured output, status propagation, here documents and the missing-shell case.
