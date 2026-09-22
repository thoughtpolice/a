<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

GNU diffutils 2.7 supplies static diff, cmp, diff3 and sdiff, built from
explicit source groups using final GCC 4.7.4 and musl 1.2.5. GNU regex and
fnmatch remain bundled. Native configuration enables fork, signals and
standard POSIX file interfaces. No configure or Make builds the package.

The helper-execution patches use PATH instead of a fixed installation prefix.
Buck supplies a declared diff helper directory for diff3/sdiff. Installed
programs use the caller's PATH, including pr for paginated diff output and an
editor for sdiff's editing mode. Tests exercise unified patches, binary/status
comparison, ignored changes, three-way merging and interactive left/right
selection, and reject a missing declared diff helper.

Four exact regex changes use pointer-width integer conversions in the failure
stack and saved-position comparison. Nested and alternative backtracking
patterns have positive and negative execution checks on the native LP64 build.
