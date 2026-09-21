<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Source-regenerated native bootstrap

Principal recipe reference: live-bootstrap
`dd8ac27bf959344b9bcf5e876bdd7716879bbc70`.

Package composition, sources, configuration, generator invocations, library order,
and compiler predecessors are declared in BUILD files. Reusable action mechanics
and static source inventories live in cellar-local Starlark files. No package
build invokes configure, Make, or kaem.

The initial source-preparation gate downloads Mes 0.27 and NYACC 1.00.2-lb1 using
pinned SHA256 hashes and extracts them with stage0 tools. Mes's source tree is
assembled from an explicit manifest, with no psyntax.pp or psyntax.pp.header.
Its compiler configuration contains no absolute workspace prefix. NYACC's eight
C parser tables are regenerated from grammar sources with M2-built mes.bin.
The CPP generator precedes C99/C99x; C99cx is independent. No shipped mach.d table
is copied into the modules consumed by MesCC. Mes then passes through the existing
three compiler stages and compares the last two interpreter executables.

Validation:

```
buck2 test cellar//bootstrap/stage0-posix/seeds/linux-amd64: \
  cellar//bootstrap/mes:hello-test cellar//bootstrap/mes:mes-fixed-point --local-only -j 8
```

The native stage1 target is x86_64 Linux. Compiler execution runtime and the
compiler's output sysroot are distinct toolchain properties. Object and archive
providers check Mes versus ELF formats and ABI compatibility during analysis.
The early archive rule preserves explicit member order and rejects truncated-name
collisions. Compiler commands retain their RunInfo artifact dependencies, including
MesCC, which has no default executable artifact.

The immutable simple-patch adaptation is based on the pinned reference's MIT
source. It requires exactly one nonempty before block, checks allocation and I/O,
and writes a distinct output artifact. Its tests exercise replacement plus missing,
ambiguous, empty, and oversize patterns.

The native TCC 0.9.26 fixed point now passes. MesCC builds the amalgamated seed;
boot0, boot1, and boot2 use separate translation units and identical feature
configuration. Their conventional x86_64 runtimes compile each Mes libc source
separately and use TCC's actual native support library. The seed's inability to
evaluate floating constants is accounted for in runtime initialization and the
compiler's negative-zero construction. MesCC's conditional register-spill fix is
also covered by a regression and the Mes fixed point.

All eight comparisons pass: `tcc`, `libtcc.a`, `crt1.o`, `crti.o`, `crtn.o`,
`libc.a`, `libgetopt.a`, and `libtcc1.a`. The 27 TCC tests additionally cover
startup arguments/environment, stack alignment, syscalls/errno, setjmp/longjmp,
integer and floating arithmetic, mixed varargs, separate compilation, archives,
weak symbols, diagnostics, and failure with missing sysroot headers/libraries.

```
buck2 test cellar//bootstrap/stage1/tcc: --local-only -j 8
buck2 run cellar//bootstrap/stage1/tcc:tcc -- example.c -o example
buck2 build cellar//bootstrap/stage1/tcc:runtime-boot2
```

The target endpoint remains GCC 4.7.4 C/C++, binutils 2.30, musl 1.2.5, and the
userland specified by the implementation plan. Those final toolchain and userland
rebuilds remain to be implemented. The Mes runtime is transitional and retains
other upstream stubs; the delivered runtime will be musl.

The two Mes-linked release TCC 0.9.27 passes are also built, with 16 acceptance
tests. The second pass preserves TCC 0.9.26 as predecessor and links the release
against its rebuilt Mes runtime. Sed 4.0.9 now builds with that release compiler;
six tests cover backreferences, hold space, branching, long lines, final-newline
handling, and diagnostics. Bootstrapped sed runs musl's actual header generator.
The generated musl 1.1.24 headers pass native layout and SysV varargs checks.

The native musl/TCC corrective sequence is now built: reduced musl, release TCC
linked with musl by TCC 0.9.26, self-built TCC, rebuilt reduced musl, and rebuilt
TCC. The twelve Unicode/ctype/iconv tables regenerate from pinned source/data and
match every published table value. Musl then rebuilds with those features
restored. It retains native threads/TLS and still excludes complex functions.
Fifteen musl and twenty-one musl-linked TCC tests cover these stages. The runnable
`musl:tcc` pairs the latest compiler with `musl:runtime-restored`.

```
buck2 test cellar//bootstrap/stage1/musl: \
  cellar//bootstrap/stage1/musl-tables: cellar//bootstrap/stage1/tcc-musl: --local-only -j 8
```

The source-generator chain now reaches gawk 3.0.4: handwritten oyacc 6.6,
Bash 2.05b's parser and builtin generators, Heirloom lex, Flex 2.5.11,
Flex 2.6.4, and Bison 3.4.1. Both Flex versions regenerate their scanners and
compare a further regeneration byte-for-byte. Bison progresses through the
reference's handwritten parser, simplified grammar, and full upstream grammar;
its final parser and header also match a further regeneration. GNU m4 1.4.7
supplies the skeleton processors. All package generation uses declared actions
and bootstrapped tools. Release-generated parser/scanner sources are excluded
from consumed package inputs.

These packages have 70 tests, including parser precedence and error handling,
GLR parsing, destructor ownership, reentrant scanners and external scanner
tables, m4 diversion spills and frozen state, shell pipelines and job control,
and awk records, arrays, regular expressions, and shell I/O. Their shell helpers
require a declared Bash executable, and their temporary files stay in action
output directories. The shared shell adapter retains musl's spawn and stdio
semantics; callers fail if its shell configuration is missing.

```
buck2 test cellar//bootstrap/stage1/oyacc: \
  cellar//bootstrap/stage1/bash-bootstrap: cellar//bootstrap/stage1/heirloom-lex: \
  cellar//bootstrap/stage1/m4: cellar//bootstrap/stage1/flex-bootstrap: \
  cellar//bootstrap/stage1/flex: cellar//bootstrap/stage1/bison: \
  cellar//bootstrap/stage1/gawk: --local-only -j 8
```

Native binutils 2.30 now builds all fifteen requested programs: `as`, `ld`,
`ar`, `ranlib`, `nm`, `objcopy`, `objdump`, `strip`, `readelf`, `elfedit`,
`addr2line`, `size`, `strings`, `c++filt`, and `gprof`. Separate actions build
libiberty, zlib, BFD, and opcodes. BFD headers, CRC/compression tables, x86 opcode
tables, GAS floating constants, LD and ar parsers/scanners, linker scripts and
emulations, and gprof's text-derived C sources regenerate from their source inputs.
Only the native x86_64 ELF backend is enabled. LD has no default library search
directories; callers supply their sysroot libraries explicitly.

The 48 binutils tests cover native assembly and disassembly, static musl linking,
weak symbols, partial linking, linker scripts, deterministic and thin archives,
MRI scripts, long archive member names, ELF inspection and modification,
compressed DWARF, stripping, malformed inputs, and 64-bit profiling records.
Gprof's x86 call decoder sign-extends relative offsets and bounds instruction
reads; a backward-call fixture covers that adaptation. The profiling fixtures
are generated records, not a claim that a GCC-instrumented program has run yet.
GNU cat and rm provide the linker generator's file operations and have seven
additional tests. The complete final coreutils rebuild remains outstanding.

```
buck2 test cellar//bootstrap/stage1/binutils: \
  cellar//bootstrap/stage1/coreutils: --local-only -j 8
buck2 build cellar//bootstrap/stage1/binutils:installation
```

Closure review:

```
buck2 bxl cellar//bootstrap/audit.bxl:closure -- \
  --target cellar//bootstrap/mes:mes-fixed-point > /tmp/mes-closure.json
python3 cellar/bootstrap/audit-loads.py
```

The BXL report includes every configured target's rule-definition path, action
owner and command, and transitive Starlark loads. Buck automatically injects its
bundled prelude into modules and the repository's noprelude shim into BUILD files;
the audit reports those infrastructure loads explicitly. No rule defined there
is permitted in the configured dependency closure. The supplementary source audit
rejects explicit imports outside cellar, including unused imports.

At commit `b6c6c231`, a second JJ workspace at `/tmp/native-stage1-relocated`
rebuilt the fixed-point closure locally without remote caching. All 48 tests
passed (19 stage0, two Mes, 27 TCC); 2160 commands executed locally. The eight
boot2 artifacts were byte-identical to those built under `/home/exedev/a`.
The process/file trace covered both the initial stage0 actions and the completed
run, including 3213 bootstrap processes and 101850 open calls. Its reviewed
executables and successful opens stayed in cellar sources, cellar artifacts,
Buck's cellar action scratch directories, or `/dev/null`. Buck, its launcher,
and test infrastructure remain trusted and are outside that process boundary.
This is observed closure evidence, not proof of per-action input completeness.

Incremental traced validation in the second workspace also covered the subsequent
musl and generator stages. An initial trace exposed Bash's default heredoc
temporary directory; after its correction, the Bash, m4, Flex, Bison, and final
shared-shell/gawk traces reported no successful opens or executions outside the
audited boundary. At `b9fb4257`, the Bash, m4, both Flex versions, Bison, and gawk
executables were byte-identical across the two absolute workspace paths. These
incremental runs extend the earlier fresh-workspace evidence; they are not a
second uncached rebuild of the entire closure.

At `5c3e394f`, the binutils installation's configured audit reported 6715 targets,
7426 actions, and no ownership or load violations. The second workspace ran all
55 binutils/coreutils tests with 424 newly executed local actions and no remote
cache. Its trace covered 1072 bootstrap processes, 69 executables, and 83963 open
calls, with no successful opens or executions outside the audited boundary.
All fifteen binaries, four static libraries, twenty-two linker scripts, and four
license files were byte-identical across the two workspace paths. This was an
incremental validation of the new packages on the previously audited closure.

To repeat the trace gate, start with a fresh JJ workspace and isolated daemon:

```
strace --seccomp-bpf -ff -ttt -s 65535 -yy -e trace=%file,%process \
  -o /tmp/bootstrap-trace ./buck/bin/buck2 --isolation-dir bootstrap-audit test \
  cellar//bootstrap/stage0-posix/seeds/linux-amd64: \
  cellar//bootstrap/mes:mes-fixed-point cellar//bootstrap/mes:hello-test \
  cellar//bootstrap/stage1/tcc: --local-only --no-remote-cache -j 8
```

After the tests finish, stop that isolated daemon from another terminal so strace
can exit, then run the host-side audit (it is never a bootstrap action input):

```
./buck/bin/buck2 --isolation-dir bootstrap-audit kill
python3 cellar/bootstrap/audit-trace.py --workspace "$PWD" \
  --trace-prefix /tmp/bootstrap-trace > /tmp/bootstrap-trace-audit.json
PYTHONDONTWRITEBYTECODE=1 python3 cellar/bootstrap/test-audit-trace.py
```
