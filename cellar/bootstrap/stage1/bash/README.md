<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU Bash 5.2.15 is built with final native GCC 4.7.4 and static musl 1.2.5.
BUILD declares the complete core, builtin, glob, shell-support, Readline and
termcap sources. The reviewed Linux/LP64 configuration retains native job
control, line editing, history, arrays, regular expressions, Unicode, process
substitution and coprocesses. Dynamic loadable builtins and translated messages
are outside this static configuration. The standard musl allocator is used.

The parser is regenerated from parse.y by bootstrapped Bison. Upstream
mkbuiltins, mksyntax and mksignames are separate native generator actions.
Release parser output and builtin C output are not consumed. Version values
and the Linux pipe-size ceiling are explicit configuration; Bash checks actual
pipe capacity with F_GETPIPE_SZ and uses temporary files for large here-docs.
The Unicode and termcap units explicitly include missing native declarations.
All compiled source names are stable logical paths. Gzip 1.2.4 decodes the
source archive because the stage0 decoder rejects this archive's stream.

Eight tests exercise modern shell semantics, Unicode conversions, signals,
pipelines, descriptors, large here-documents and malformed input. A native C
pseudoterminal harness verifies line editing, history, stopping and resuming
jobs, foreground terminal ownership and Ctrl-C delivery. No host commands are
on the test PATH. The opt-in identity patch avoids host account data during
isolated tests; ordinary shell invocation retains upstream account lookup.
See patches/README.md. Test terminal capabilities and inputrc are declared.

Run `buck2 test cellar//bootstrap/stage1/bash: --local-only`.
