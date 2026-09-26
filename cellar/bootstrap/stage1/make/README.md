<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU Make 4.2.1

GCC 4.7.4 stage3 and musl 1.2.5 build a static Make with the bundled GNU glob
and fnmatch library. BUILD declares a reviewed native configuration with
POSIX signals, nanosecond and symlink timestamps, parallel jobs and the
recursive jobserver. Guile and dynamic object loading are left out, so no
Guile-generated header is needed.

When BOOTSTRAP_SHELL is set, Make uses it as its default shell, and Makefile
and command-line SHELL assignments keep their usual precedence. An empty value
fails, and unset keeps upstream's /bin/sh. Make escapes whitespace and quotes
in that shell's path, so a path containing spaces stays one program name.
[patches/README.md](patches/README.md) describes both patches.

## Tests

An integration Makefile builds and runs a program with the GCC 4.7.4 stage3
compiler and the early binutils ar through a pattern rule and an archive
dependency. It also checks wildcard and sort expansion, recursive jobserver
propagation, `.RECIPEPREFIX`, `.ONESHELL` and up-to-date detection, with Bash
as the default shell and no host PATH. Other tests cover version output,
malformed Makefiles, an empty BOOTSTRAP_SHELL and a shell path containing
spaces.

```
buck2 test cellar//bootstrap/stage1/make:
```
