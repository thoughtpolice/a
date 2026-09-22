<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native GNU Make 4.2.1

The final stage3 GCC 4.7.4 compiles 31 individually declared translation units
and links Make statically with musl 1.2.5. BUILD supplies a reviewed native
configuration and the bundled GNU glob/fnmatch library, including its alternate
directory callbacks. POSIX signals, nanosecond timestamps, symlink timestamps,
parallel jobs and the recursive jobserver are enabled. Guile and dynamic object
loading remain outside the selected static runtime scope.

There are no generated compiler inputs beyond the explicit configuration map.
The Guile-generated header is excluded with Guile support. Neither configure
nor Make builds this package; Buck owns every compile, archive and link action.

Five tests check version reporting, malformed Makefile diagnostics, shell
selection and paths containing spaces, and an
integration build using the delivered stage3 GCC and native GNU ar. The sample
uses a pattern rule and an archive dependency, then runs the static executable.
It also checks GNU wildcard/sort expansion, recursive jobserver propagation,
.RECIPEPREFIX, .ONESHELL and up-to-date detection. All writes stay inside the
integration action's output directory, with an unavailable host PATH. The
test shell is the delivered Bash 5.2.15, with its explicit isolated-action
identity setting.

```
buck2 test cellar//bootstrap/stage1/make: --local-only -j 8
buck2 build cellar//bootstrap/stage1/make:installation
```

The assembled installation sets `BOOTSTRAP_SHELL` to its own Bash. Make uses
that as its default shell before variable initialization; Makefile and command
line `SHELL` assignments retain their usual precedence. Unset keeps upstream
behavior and an explicitly empty value fails. The integration test now uses
this default rather than a command line SHELL assignment. All five tests pass. The command builder escapes whitespace and quoting
characters in the selected default shell path, preserving one executable name.
