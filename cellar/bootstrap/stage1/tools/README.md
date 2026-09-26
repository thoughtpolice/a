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

The tests here cover captured output, exit status, standard input, working
directories, missing programs and inputs, and concatenation order.
