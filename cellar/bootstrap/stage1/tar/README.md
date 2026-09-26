<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU tar 1.12

The rebuilt GCC 4.0.4 builds a static tar against musl 1.2.5, because the
GCC 4.7.4 archive has GNU long-name entries that the seed extractor cannot
read. BUILD declares the translation units and a reviewed native
configuration. Bison 3.4.1 regenerates the date parser from `getdate.y`; the
release's parser and the reference recipe's date stub are not used. No
configure or Make process runs.

The source changes add two missing standard-header declarations, make the
octal mode parser const-correct and fix the native unsigned long format
strings. `patches/full-names.patch` copies full-width header names and link
targets into terminated buffers, keeping all 100 bytes. The obsolete rexec
transport is off for musl, so a remote shell must be given with
`--rsh-command`; no host shell is built in. Upstream 1.12's incomplete
`--posix` mode stays as it is, without a claim of full POSIX conformance.
Archive actions that use this tar pass `--numeric-owner`, so it never reads
the host's account databases.

## Tests

The tests check `--version`, and parse absolute and relative dates in UTC,
timezone offsets, leap dates and invalid dates. A round trip writes and reads
archives in its declared output directory, covering 220-character names and
link targets, full 100-byte name and link fields, hard links, modes,
date-based selection and rejection of malformed archives. Compression
commands are not tested.

```
buck2 test cellar//bootstrap/stage1/tar:
```
