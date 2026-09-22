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

The 49 binutils tests cover native assembly and disassembly, static musl linking,
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

The pre-GCC sequence also rebuilds musl with GNU as/ar/ld, restoring its native
x86_64 math assembly, and then rebuilds TCC and its support library against that
libc. `tcc-native:tcc` supplies the resulting compiler and explicit sysroot.
TCC's original hexadecimal-float reader rounded through `double`, corrupting
long-double constants used by musl. The corrective compiler pass uses musl's
typed conversion routines and a temporary x87 scaling implementation; the final
pass uses the rebuilt libc without that temporary object. Twenty native-TCC and
twenty-one musl tests cover exact floating representations, extreme exponents,
fused operations, startup, threads/TLS, syscalls, Unicode, and driver linking.
Missing sysroot headers and libraries fail instead of falling back to the host.

```
buck2 test cellar//bootstrap/stage1/tcc-native: \
  cellar//bootstrap/stage1/musl: --local-only -j 8
buck2 build cellar//bootstrap/stage1/tcc-native:installation
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

At `81dac821`, the pre-GCC TCC installation's configured audit reported 7977
targets and 8641 actions with no violations. The second workspace passed all 90
binutils/musl/native-TCC tests with 1348 newly executed local actions and no remote
cache. Its trace covered 1469 bootstrap processes and 79821 open calls with no
successful opens or executions outside the audited boundary. All 233 installation
files, including the static compiler, its libraries, CRT objects and headers,
were byte-identical across the workspace paths. This extends the earlier
incremental validation; it does not claim another full uncached bootstrap.

GCC 4.0.4 now builds as a native static C compiler using the pre-GCC TCC,
musl 1.1.24, and GNU binutils. BUILD declares its libiberty/libcpp libraries,
C parser, options, machine-description and garbage-collector generators, frontend,
backend, driver, and runtime objects. The Unicode identifier generator is a C
translation of the original transformation. Shipped generated compiler sources
are excluded from consumed source trees. Target libgcc, libgcov, crtbeginT and
crtend are built with the newly compiled GCC. Its transitional libgcc also
contains a GCC-built copy of the TCC varargs helpers required by the input libc.
`gcc40:gcc` and `gcc40:cpp` supply explicit tool and header paths through RunInfo;
`gcc40:installation` exposes the binaries, private headers, sysroot and licenses.
The raw driver requires explicit `-B` tool/runtime prefixes; it rejects missing
tools instead of searching PATH. GCC 4.0 predates the `--sysroot` driver option.

At `a94427d0`, all 41 GCC tests passed in both workspaces. They cover source
regeneration, generator diagnostics, C compilation at O0/O2, driver preprocessing
and piped compilation, static linking, separate objects/archives/weak symbols,
128-bit arithmetic, complex arithmetic helpers, constructors/destructors, POSIX
threads/TLS, forced unwinding with C cleanups, native signal-frame unwinding,
math, Unicode, and missing declared tools/headers/libraries. The configured
installation audit reported 8543 targets and 9173 actions without violations.
The relocated run executed 534 new local actions with remote caching disabled;
its trace covered 823 bootstrap processes and 186337 successful open calls with
no boundary violations. All 246 installation files matched across the workspace
paths, and the five included executables had neither ELF interpreter nor dynamic
segments. This is incremental evidence on the previously validated closure.
The coverage archive is built here; instrumented coverage behavior is not yet
part of this gate. Final GCC 4.7 C++ and stage2/stage3 object comparisons remain
outstanding.

Full native static musl 1.2.5 now builds with the first GCC 4.0.4, including
complex math, mallocng and POSIX threads. Its five character/case tables regenerate
from pinned Unicode 12.1 data, and the eight unchanged iconv tables reuse the
validated generator outputs. All thirteen tables match the release fixtures.
`musl12:gcc` pairs the existing compiler with the new output sysroot; the compiler
execution runtime remains the preceding musl until its next rebuild. See
[musl12/README.md](musl12/README.md) for configuration and test coverage, including
the pinned release's long-double complex precision limitations.

At `921757a5`, the musl installation audit reported 9965 targets and 10559 actions
without violations. All 24 package tests passed in the second workspace, with
1392 newly executed local actions and no remote cache. The trace covered 4109
bootstrap processes and 76434 successful open calls with no boundary violations.
All 231 musl installation files were byte-identical across the workspace paths.
The trace also includes the initial failed download attempt; exact archive sizes
now avoid the timed-out HTTP HEAD requests. This remains incremental validation
on the previously audited compiler closure.

At `f38c1e70`, the GCC 4.0.4 rebuild with full musl 1.2.5 passed all 41 package
tests and the preceding compiler's RTL test in both workspaces. Every generator
and compiler object was rebuilt with the predecessor GCC; the new compiler then
rebuilt its own runtime. GCC instruction-condition evaluation is now enabled,
and the transitional TCC varargs helper is removed. The configured audit found
10474 targets and 11063 actions without ownership or load violations. The second
workspace executed 535 new local actions without remote caching. Its trace
covered 1461 bootstrap processes with no boundary violations. All 246 installed
files matched across absolute workspace paths, and the included executables
were static ELF files. This is another incremental validation of the bootstrap
closure, not the required future GCC 4.7 stage2/stage3 object comparison.

GMP 6.2.1 uses generic C implementations, fixed thresholds, reentrant temporary
allocation, and tables regenerated by six upstream mini-GMP-based generators.
At `dfcebff6`, all 164 selected upstream tests passed in both workspaces. The
configured installation audit reported 11017 targets and 11604 actions without
violations. Relocated validation executed 878 new local actions without remote
caching; its trace covered 2428 bootstrap processes and 52746 successful opens
with no boundary violations. All six installed files matched byte-for-byte.
See [gmp/README.md](gmp/README.md) for configuration and the test selection.

MPFR 4.1.0 follows the GMP milestone with generic arithmetic, fixed thresholds,
GNU TLS and per-thread caches. At `874eadcb`, all 174 selected upstream tests
and the additional pthread test passed in both workspaces. Its installation
audit reported 10733 targets and 11320 actions without violations. Relocated
validation executed 602 new local actions; the trace covered 1623 bootstrap
processes and 44081 successful opens with no boundary violations. All five
installation files were byte-identical across the workspace paths. See
[mpfr/README.md](mpfr/README.md) for source and configuration choices.

MPC 1.2.1 completes the three mathematical C library dependencies for GCC 4.7.
At `6ad6b934`, all 69 upstream tests passed in both workspaces. Its installation
audit found 10577 targets and 11164 actions without violations. The relocated
run executed 245 new local actions; tracing covered 656 bootstrap processes and
16830 successful opens with no boundary violations. All three installation
files matched byte-for-byte. See [mpc/README.md](mpc/README.md) for the graph and
test coverage. These math-library gates extend the incremental closure evidence.

GNU tar 1.12 is built ahead of GCC 4.7 to support GNU long-name archive entries.
Its date parser is regenerated from the grammar. At `e0dff814`, all three tar
tests and four rule tests passed in both workspaces. The tar closure audit
reported 10531 targets and 11115 actions without violations. Tracing initially
found host account-database reads; archive actions now select numeric ownership.
The corrected relocated run executed 37 local actions and traced 112 bootstrap
processes with no boundary violations. Both installed files matched across
workspace paths, and tar is a static ELF executable. This is incremental
validation extending the existing audited closure.

GCC 4.7.4's first generators and support libraries passed their gate at
`2d9dbf96`: ten tests in both workspaces, 11231 configured targets and 11803
actions with no closure violations. The relocated run executed 154 local
actions; tracing covered 403 bootstrap processes and reported no boundary
violations. All three library archives matched across absolute workspace
paths. Unicode and CRC outputs match the published bytes; the decimal tests
compare every value in both sets of regenerated conversion tables. This gate
does not yet build GCC's compiler executables or C++ runtime.

The GCC 4.7 generator graph passed its gate at `38c76fcc`: thirteen tests in
both workspaces and 106 generated files identical across absolute paths. The
configured audit covered 11381 targets and 11930 actions without violations.
The relocated run executed 226 new local actions; tracing covered 550 bootstrap
processes and 22906 open calls with no boundary violations. This extends the
incremental closure evidence through the machine and garbage-collector
generators; it is not yet a GCC compiler or runtime acceptance result.

GCC 4.7's C/C++ front ends and five drivers passed their gate at `4446143b`:
34 tests in both workspaces and seven byte-identical static executables. The
configured audit covered 12262 targets and 12764 actions without violations.
The relocated run executed 567 new local actions; tracing covered 1725 bootstrap
processes and 272009 open calls without boundary violations. The initial
front-end trace at `2b54a14c` had found three `/dev/urandom` reads in diagnostic
tests; adding their missing fixed-seed arguments resolved those findings. This
incremental gate does not yet cover new GCC target runtimes or stage comparison.

The GCC 4.7 target support runtime passed its gate at `92fc88ca`: 45 tests in
both workspaces, with all 244 compiler, driver and sysroot files identical
across absolute paths. The configured audit covered 12548 targets and 13029
actions without violations. The relocated run executed 889 new local actions;
tracing covered 2603 bootstrap processes and 303628 open calls with no boundary
violations. This includes binary128 and decimal arithmetic, pthread and
signal-frame unwinding, static linking, and a gcov round trip. The C++ standard
library and later compiler stages remain separate acceptance gates.

The static C++ libraries passed their gate at `242da897`: twelve C++ tests
and three tar tests passed in the relocated workspace, and all 619 installed
C++ headers, archives and license files matched across absolute paths. The
configured audit covered 12518 targets and 13058 actions without violations.
The relocated run executed 973 local actions; tracing covered 2904 bootstrap
processes and 468891 open calls without boundary violations. All twelve C++
test programs are static ELF executables. This incremental gate also validates
the full-width tar-header fix at `9db38fb9`; it does not establish a compiler
stage2/stage3 comparison. See [libstdcxx/README.md](libstdcxx/README.md).

The complete three-stage GCC/C++ gate passed at `88a5cead`: all 998 tests
passed in both workspaces, including 891 object comparisons and four runtime
archive comparisons. Only the two upstream compiler checksum objects are
excluded; the inventory audit checks that no declared object was omitted.
The configured closure audit reported 14267 targets and 14797 actions without
violations. The relocated run executed 2985 local actions; tracing covered
9766 bootstrap processes and 942372 open calls without boundary
violations. All 1911 collected files matched across absolute paths: both host
object inventories, final compiler/drivers, C sysroot and C++ installation.
All seven final compiler/driver executables are static. The 48 foundation
checks also passed. This completes the compiler stage comparison; final
userland construction and installation assembly remain separate milestones.

Final Bash 5.2.15, Make 4.2.1, gzip 1.2.4 and bzip2 1.0.8 passed their
combined relocation gate at `6f60786e`: all 20 tests passed, including a real
pseudoterminal job-control/Readline test, Make compilation and jobserver test,
gzip metadata/integrity test, and bzip2 reference vectors and block recovery.
All 17 installed files match across workspace paths; the nine executable
installation entries represent five static executables and invocation aliases.
The union of the three configured package audits covers 14477 targets and
14979 actions without violations. The relocated run executed 2592 local
actions; tracing covered 7780 bootstrap processes and 923993 open calls with
no host-file or executable violations. The auditor separately recognizes
two resolved pipe descriptors and three typed kernel terminal devices.
Negative audit tests still reject ordinary host files, untyped device paths,
wrong device types and foreign executables. The earlier trace exposed a test
race; the committed child-readiness handshake fixes it, and the final run
above is the acceptance evidence. This gate reuses earlier audited bootstrap
outputs and does not claim a wholly uncached seed-to-userland rebuild.

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
