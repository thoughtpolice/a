<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native installation

This package assembles the delivered toolchain and userland as relocatable
directory trees. `:toolchain` holds GCC 13.5 stage3 with its libstdc++,
binutils 2.41 and musl 1.2.5, `:userland` the GCC 4.7.4-built Bash, Make,
coreutils and the other tools, and `:all` both. `cellar//bootstrap/stage1:all`,
`:toolchain` and `:userland` name the same trees. [README](README), LICENSE
and NOTICE are the texts installed under share/.

Each program sits in libexec/, and bin/ holds a copy of one static launcher
built from [launcher.c](launcher.c). The launcher finds the installation
through /proc/self/exe and runs the program that its name selects in the
`launch-config.h` table, which BUILD generates. The table gives the compiler
drivers the installation's search paths and gives each program the settings
it reads, such as m4's path for Bison and Flex. `share/bootstrap/manifest.tsv`
records every installed path with its source label.

The runnable targets named after the commands, such as `:gcc` and `:make`,
run the command from `:all`:

```
buck2 run cellar//bootstrap/stage1/installation:gcc -- hello.c -o hello
```

## Tests

[tests/acceptance.sh](tests/acceptance.sh) runs with PATH holding only the
installation. Its cases check versions and that every installed program is a
static executable, build C and C++ programs with Make, ar and the binutils,
regenerate parsers and scanners with Bison and Flex, create and unpack
archives, index files with updatedb and locate, and move the installation to
a path containing spaces, where it must keep working and must fail rather than
fall back to host headers, libraries or programs.

```
buck2 test cellar//bootstrap/stage1/installation:
```
