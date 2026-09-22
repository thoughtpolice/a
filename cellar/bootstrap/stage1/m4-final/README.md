<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU m4 1.4.7 rebuilt with final GCC 4.7.4 and static musl 1.2.5.
BUILD declares the upstream macro engine and GNU helper archive separately.
Matching final-musl system/popen copies preserve process and stream semantics;
the Buck runnable target selects final Bash explicitly. The temporary-file
helper honors TMPDIR, rejects an explicitly empty value, and uses /tmp for an
ordinary runtime caller that leaves TMPDIR unset.

All eight tests pass: version, nested macros, include/diversion behavior,
freeze/reload, shell capture and status, a diversion larger than 512 KiB,
and malformed input/missing dependency diagnostics. The earlier m4 package
remains in the generator bootstrap chain.
