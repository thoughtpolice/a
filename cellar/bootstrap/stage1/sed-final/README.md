<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU sed 4.0.9 rebuilt with final GCC 4.7.4 and static musl 1.2.5.
The native configuration enables the upstream multibyte regex and replacement
paths, including multibyte transliteration. A focused source repair moves
setlocale outside the message-catalog conditional. Musl supplies getline, mkstemp and strverscmp. The early TCC/Mes sed
remains available to break generator dependencies.

All eleven tests pass, including UTF-8 matching/transliteration, backreferences,
hold space, branches, long lines, in-place backups/permissions, declared-shell
execution and missing dependency diagnostics. The installed
program is static ELF.
