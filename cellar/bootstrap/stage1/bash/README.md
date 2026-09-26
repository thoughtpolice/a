<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU Bash 5.2.15

GCC 4.7.4 stage3 and musl 1.2.5 build a static Bash from its release
tarball, which this userland's gzip decodes because the stage0 decoder
rejects its stream. BUILD declares the core, builtin, glob, shell-support,
Readline and termcap sources and a reviewed Linux LP64 configuration with job
control, line editing, history, arrays, regular expressions, Unicode, process
substitution and coprocesses. Loadable builtins and translated messages are
left out, and Bash uses musl's allocator.

The early Bison regenerates the parser from parse.y, and upstream mkbuiltins,
mksyntax and mksignames run as native generator actions, so no release parser
or builtin C output is compiled. Version values and the Linux pipe-size
ceiling are explicit configuration. Bash still checks the real pipe capacity
with F_GETPIPE_SZ and writes large here-documents to temporary files. Every
source compiles under a stable logical path. [patches/README.md](patches/README.md)
describes the two patches, including the opt-in identity flag that keeps
isolated actions from reading the host account database.

## Tests

The shell tests cover modern shell semantics, Unicode conversion, signals,
pipelines, descriptors, large here-documents and malformed input, with no
host commands on PATH. A C pseudo-terminal harness drives an interactive
session with a declared inputrc through line editing, history, stopping and
resuming jobs, foreground terminal ownership and Ctrl-C. That test carries
the `terminal` label, because it needs /dev/ptmx and /dev/pts.

```
buck2 test cellar//bootstrap/stage1/bash: --local-only
```
