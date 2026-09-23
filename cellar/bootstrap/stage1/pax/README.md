<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# pax archive extraction

GNU tar 1.12 and the stage0 `untar` read ustar and GNU long-name archives, but
not POSIX.1-2001 pax extended headers. The GCC 10.5 archive stores 626 long
member names only in pax records. This extractor reads pax `path` and
`linkpath` records, GNU long names and the ustar prefix and name fields, and
ignores other pax records such as timestamps. Only POSIX ustar headers have a
prefix field; old GNU headers keep times there. The extractor never changes
ownership. It rejects absolute names, names containing `..`, and members
beneath a symbolic link or other non-directory, so an archive cannot write
outside the extraction directory.

It is built with the final GCC 4.7.4 and static musl 1.2.5. The tests build a
pax archive with a long path, a ustar prefix name, a directory and a symbolic
link, extract it, and check that a truncated archive fails. Further archives
check that extraction stops at a file beneath a symbolic link and at a pax
record too short to hold its own length, and that an old GNU header's times
do not become part of a member name.

```
buck2 test cellar//bootstrap/stage1/pax:
```
