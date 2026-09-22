<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU gawk 3.0.4 rebuilt with final GCC 4.7.4 and static musl 1.2.5.
The Bison-generated parser is regenerated as a declared action; release parser
output is not consumed. Program and parser compilation use stable logical
source paths. Shell operations select final Bash explicitly in Buck; normal
runtime callers retain the conventional shell default when BOOTSTRAP_SHELL
is unset, while an explicitly empty value fails.

All eight tests pass with compiler warnings treated as errors: field/record
handling, arrays and language features, math, input/output pipelines and
status handling, bundled awk libraries, malformed input and missing-shell
rejection. The installation contains gawk/awk and the ten bundled awk library
files, with licenses for the matching private musl shell implementations.
