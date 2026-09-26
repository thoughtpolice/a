<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Bootstrap action helpers

M2-Mesoplanet builds these helpers with the stage0 tools, so every stage can
use them:

- `capture` runs a command with its standard output written to a declared
  file, optionally with a declared standard input and working directory.
  `generate(capture = True)` uses it.
- `expect-exit` runs a command and passes only when it exits with the given
  status. Tests of failure cases use it.
- `source-alias` links a declared source tree as `source` inside the action's
  output directory, then runs the command there. With `source_tree`,
  `c_object` and `generate` use it to give every compiler generation the same
  source spellings, so `__FILE__` values and debug paths match between
  stages. Temporary compiler files stay in the output directory.
- `capture-probe` only serves the tests here.

Two more are built with TCC against musl 1.1.24:

- `withenv` sets explicit variables on top of the caller's environment, then
  runs the command without a PATH search. `configured_tool(env = ...)` uses
  it. The Mes wrappers use cellar-extra's `envexec` instead, which replaces
  the environment.
- `libshell.a` holds musl's own `system` and `popen` under the private names
  `bootstrap_system` and `bootstrap_popen`. They run the shell that
  `BOOTSTRAP_SHELL` names and fail with ENOENT when it is unset, where musl
  would run the executor's `/bin/sh`. BUILD derives both sources from
  `musl:source-restored` with exact patches. Callers rename the standard
  functions when they compile and carry the shell in their configured
  RunInfo. m4's shell tests cover direct execution, captured output, exit
  status, here documents and the missing-shell case.

The tests here cover captured output, exit status, standard input, working
directories, missing programs and inputs, concatenation order and configured
environments.
