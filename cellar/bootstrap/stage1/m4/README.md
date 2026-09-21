<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU m4 1.4.7

Native TCC and restored musl build each source separately, including the bundled
GNU regex and obstack implementations. Configuration and archive order are in
BUILD; no configure or Make action runs.

The runnable `:m4` carries a declared bootstrap Bash through `BOOTSTRAP_SHELL`.
Private copies of musl's system/popen implementations preserve signal handling
and pipe ownership while selecting that shell. The matching musl copyright
notice is included. Large diversions use an unlinked file in the caller's
`TMPDIR`; callers must supply a writable declared directory. Missing settings
fail without a host shell or temporary-directory fallback.

Eight tests cover version, macro/regex/format expansion, includes and definition
stacks, shell commands and here documents, frozen-state reload, a 600 KiB
diversion, malformed input, and missing shell/temporary-directory settings.

```
buck2 test cellar//bootstrap/stage1/m4: --local-only -j 8
```
