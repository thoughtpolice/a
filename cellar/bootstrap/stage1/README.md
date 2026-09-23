<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Source-regenerated native bootstrap

The native Linux/x86_64 endpoint is implemented: static GCC 10.5.0 C/C++, binutils
2.41, musl 1.2.5 and the complete selected userland. GCC 4.7.4 builds
[GCC 10.5.0](gcc10/README.md) and its [C++ library](libstdcxx10/README.md),
which bootstrap through three stages whose stage2 and stage3 objects match.
GCC 10.5 then builds [binutils 2.41](binutils241/README.md). Package builds, generators,
configurations and installation mappings are declared in cellar BUILD files.

The examples below run from `cellar/`, the standalone project, whose
configuration and platform rules load no prelude, parent PACKAGE policy, or
external Starlark rules. The same targets also build from the parent project,
but the closure audits require the standalone one. Both target and execution compatibility require
x86_64 Linux, and executable dependencies use Buck's execution configuration.
See the [platform guide](../platforms/README.md) for remote Linux workers and
Windows/macOS/Linux clients. RBE endpoint integration remains to be validated.
`buck2 run` launches its final program on the client; the runnable compiler
examples below therefore require a Linux x86_64 client.

```sh
cd cellar
../buck/bin/buck2 build @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1:all --show-output
../buck/bin/buck2 build @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1:toolchain cellar//bootstrap/stage1:userland
../buck/bin/buck2 run @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1:gcc -- hello.c -o hello
../buck/bin/buck2 run @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1:g++ -- -std=gnu++17 -pthread hello.cc -o hello
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1: --local-only -j 8
```

`:toolchain` installs the native compiler, standard binutils, public C/C++ and
unwind headers, CRT objects, libgcc, libgcov, libstdc++, libsupc++, the
Filesystem TS library libstdc++fs and musl.
`:userland` installs Bash 5.2.15, Make 4.2.1, coreutils 6.10, findutils 4.2.33,
diffutils 2.7, sed 4.0.9, grep 2.4, gawk 3.0.4, tar 1.12, gzip 1.2.4,
bzip2 1.0.8, patch 2.5.9, m4 1.4.7, Flex 2.6.4 and Bison 3.4.1.
`:all` combines the two. Every command has a runnable target of the same name;
`[` uses the target name `:lbracket`. The installation includes manifests,
generator data, upstream licenses (including the statically linked compiler
support libraries) and instructions under `share/`.

A static launcher finds its installation through Linux `/proc/self/exe`, sets
its declared shell/generator paths and supplies explicit compiler tool, header
and runtime directories. It embeds no workspace path. Copy or move the entire
tree, including paths containing spaces. Compiler search environment variables
are cleared; project dependencies remain available through explicit arguments.
Make keeps normal Makefile/command-line shell precedence. Its recursive command
uses PATH, and its default shell path is escaped as one executable name.

The six assembled-product tests cover versions, Make-driven static C/C++ builds,
threads/TLS, varargs, exceptions/RTTI/STL, generated C/C++ parsers/scanners, shell
pipelines, file/date operations, archives, locate databases and relocation.
Removing installed headers, libc, cc1 or m4 produces errors instead of host
fallback. The earlier cross-workspace gate passed 271 final-userland/installation
tests, 1001 GCC/C++ tests and 72 stage0/Mes/TCC/musl checks. At that checkpoint the
installation had 1286 files, 293 static executable entries (143 distinct executable
contents), no symlinks and no embedded absolute workspace paths. Its `:all` audit covered
15858 targets and 16349 actions with no violations. Cross-workspace and traced
validation passed at `ac91c095`; the complete results are recorded in
[validation.json](validation.json).

The GCC fixed-point contract is the upstream-style stage2/stage3 comparison of
every object and archive a GCC stage builds, excluding only the two compiler
checksum objects; the [GCC 10.5.0 port](gcc10/README.md) lists the installed
compiler's inventory. It is not a claim of executable identity between compiler
generations.
The [GNU SHA256 gate](sha256/README.md) separately builds the actual coreutils
command with GCC stages 1, 2 and 3, compares its objects and executable, and
tests GNU checksum syntax and the original seed hashes with every generation.
Shared runtimes, multilib, cross compilation, Gold and additional GCC languages
remain outside this native static endpoint. Buck2 and the running kernel remain
trusted infrastructure.

The standalone cleanup at `bc3e89bc` passed 2192 tests under native Landlock,
including all 95 GNU SHA256 cases. The selected gate excludes only the PTY
test deferred below; no tests were removed. All three installation targets
build, and all 1286 installed files retain identical bytes and modes to the
earlier parent-project build. The 36 configuration checks cover Linux, macOS
and Windows clients, native target/exec compatibility, remote-only selection,
and the copied executable seed. These are graph/provider checks, not a live
RBE run. The seed copy has identical bytes and explicit executable metadata;
the 19 original seed golden checks still pass.

The cleanup replaces 104 paired patch fragments with single exact patches,
preserving all 158 production replacements. The configured installation
closure contains 15723 targets and 16341 actions, all in cellar; the separate
SHA256 closure and all 95 explicit Starlark files also pass their audits.
The `standalone_cleanup_validation` entry in [validation.json](validation.json)
records this cleanup's build, test, trace and installation evidence, taken with
the GCC 4.7 installation, separately from the historical results below.
The corrected incremental trace covers 17618 bootstrap processes and 1089442
file opens without closure violations, plus 8287 successful Landlock
enforcement calls and no failures. It reuses earlier native foundation
artifacts; it is not a wholly uncached seed-to-userland rebuild.

Historical Landlock validation at `c68560a4`, before the standalone project
conversion, built all three installation targets successfully. Its full
recursive gate passed 2082 tests, including all 19 stage0 golden checks, the Mes
fixed point, eight TCC fixed-point comparisons and all
895 GCC/C++ object/archive comparisons. One additional test was blocked:
`bash:interactive-job-control-and-readline` could not build its `pty-result` because
the native policy denies `/dev/ptmx` and `/dev/pts` access. That PTY session
now runs as the test itself rather than as a build action, and the native
executor now grants `/dev/ptmx` and `/dev/pts`, so it passes in sandbox mode
too. These historical results do not claim
validation of later configuration or source changes. To run the same target
selections with the current standalone configuration:

```sh
../buck/bin/buck2 --isolation-dir native-stage1-landlock-verified build @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1:toolchain cellar//bootstrap/stage1:userland \
  cellar//bootstrap/stage1:all --local-only --no-remote-cache -j 8
../buck/bin/buck2 --isolation-dir native-stage1-landlock-verified test @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1/... cellar//bootstrap/mes: \
  cellar//bootstrap/stage0-posix/seeds/linux-amd64: \
  --local-only --no-remote-cache -j 8
```

The historical isolation directory started empty. Retries after sandbox
compatibility fixes reused artifacts produced under Landlock in that isolation;
this was not one uninterrupted invocation. Cellar now sets the download timeouts
to 60 seconds in its own buckconfig. The historical startup syscall sample
recorded 13 successful `landlock_restrict_self` calls with kernel ABI 6;
it is not a trace of every action. The native policy permits host system paths,
so these results supplement the earlier process/file audits rather than proving
the complete absence of host dependencies on their own.

The sandbox exposed input-directory ordering defects: a file projection visited
before its complete parent tree could hide declared sibling files. Compilation,
generation, test and installed-tool commands now visit complete trees first;
three focused regression tests cover source/header and generator/test trees.
Flex skeleton generation also uses its complete source tree at a stable logical
path. All 1286 installed files retained identical contents and modes to the earlier
build in that validation, and the static-format, workspace-path and cellar-only
rule audits passed. The `native_landlock_validation` entry in [validation.json](validation.json)
records this run separately from the earlier cross-workspace results, including
the remaining PTY restriction.

The following notes retain the staged implementation and earlier audit evidence.

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
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage0-posix/seeds/linux-amd64: \
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
and writes a distinct output artifact. Each replacement is a single unified-hunk
`.patch` file; short replacements can use `exact_patch` strings directly in BUILD.
The helper reconstructs exact byte strings, including partial lines, rather than
using file offsets or fuzzy matching. Its tests cover replacement, context lines,
newline handling, deletion, missing and ambiguous matches, and malformed patches.
See [simple-patch's format](simple-patch/README.md).

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
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/tcc: --local-only -j 8
../buck/bin/buck2 run @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/tcc:tcc -- example.c -o example
../buck/bin/buck2 build @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/tcc:runtime-boot2
```

The Mes runtime in this milestone is transitional and retains upstream stubs.
The completed endpoint uses full static musl 1.2.5, as described above.

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
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/musl: \
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
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/oyacc: \
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
additional tests. The complete final coreutils rebuild is supplied by
`coreutils-final`, with 96 native programs and the upstream groups script.

```
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/binutils: \
  cellar//bootstrap/stage1/coreutils: --local-only -j 8
../buck/bin/buck2 build @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/binutils:installation
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
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/tcc-native: \
  cellar//bootstrap/stage1/musl: --local-only -j 8
../buck/bin/buck2 build @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/tcc-native:installation
```

Closure review:

```
../buck/bin/buck2 bxl @cellar//bootstrap/platforms/sandbox cellar//bootstrap/audit.bxl:closure -- \
  --target cellar//bootstrap/mes:mes-fixed-point > /tmp/mes-closure.json
python3 bootstrap/audit-loads.py
```

The BXL report includes every configured target's rule-definition path, action
owner and command, transitive Starlark loads, and the execution platform registry.
It rejects foreign rules, dependencies, loads, or action owners and checks the
native Linux/x86_64 constraints. The standalone project has no prelude or injected
BUILD shim; package decisions use Buck's built-in `select` directly. The
supplementary source audit rejects explicit imports outside cellar, including
unused imports.

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
part of this historical gate; the final GCC 4.7 gate below adds coverage, C++
and the stage2/stage3 object comparisons.

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

To repeat the foundation trace gate with the current configuration, start with a
fresh JJ workspace, enter its `cellar/` directory, and use an isolated daemon:

```
strace --seccomp-bpf -ff -ttt -s 65535 -yy -e trace=%file,%process \
  -o /tmp/bootstrap-trace ../buck/bin/buck2 --isolation-dir bootstrap-audit test @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage0-posix/seeds/linux-amd64: \
  cellar//bootstrap/mes:mes-fixed-point cellar//bootstrap/mes:hello-test \
  cellar//bootstrap/stage1/tcc: --local-only --no-remote-cache -j 8
```

After the tests finish, stop that isolated daemon from another terminal so strace
can exit, then run the host-side audit (it is never a bootstrap action input):

```
../buck/bin/buck2 --isolation-dir bootstrap-audit kill
python3 bootstrap/audit-trace.py --workspace "$PWD" \
  --trace-prefix /tmp/bootstrap-trace > /tmp/bootstrap-trace-audit.json
```

`buck2 test cellar//bootstrap:` runs the auditors' own regression tests with
the host `python3`.


The historical final installation gate at `ac91c095` passed all 1344 tests in both
`/home/exedev/a` and `/tmp/native-stage1-relocated`. All 1286 installed files
match byte-for-byte, including permission modes. The separate toolchain and
userland selections also match (979 and 314 files respectively). All 293 ELF
executable entries are static, representing 143 distinct executable contents;
the installation contains no symlinks or embedded absolute workspace prefixes.

The final traced run used no remote cache and executed 3822 local actions.
Its audit covers 13640 bootstrap processes and 1083025 open calls with no
boundary violations. Three correctly typed `/dev/urandom` reads by GNU mktemp
and two resolved pipe descriptors are counted as kernel services. The entropy
exception applies only to mktemp; negative tests still reject compiler entropy
reads, ordinary host files, untyped/wrong-type devices and foreign executables.
A negative diff test uses an explicitly declared empty helper directory, so
its expected failure stays inside the dependency closure. The first traced run
identified those audit/fixture issues; the figures above are from the corrected
rerun. No delivered program behavior was weakened to satisfy the audit.

That historical installation closure contained 15858 targets and 16349 actions,
with zero violations. All 88 explicitly loaded bootstrap Starlark files remained
in cellar. Its comparison inventory independently confirmed all 891 GCC/C++
object comparisons, all four runtime archives and only the two upstream
checksum exclusions. This gate is incremental on the previously audited
foundation outputs; it does not claim a wholly uncached seed-to-userland build.

For the full final test gate, combine the stage1 package with gcc10, libstdcxx10,
bash, make, coreutils-final, findutils, diffutils, sed-final, grep, gawk-final,
tar-final, gzip, bzip2, patch, m4-final, flex-final, bison-final, binutils241,
tools-final, tcc and musl12 package targets, plus the stage0 Linux/AMD64 golden
check and Mes hello/fixed-point tests. Run with `--local-only --no-remote-cache`.
Use the tracing procedure above in a second JJ workspace, materialize all three
installation targets while the traced daemon is still running, then stop it.
Compare each installation with the host-side auditor:

```
python3 bootstrap/audit-installation.py --root FIRST_INSTALLATION \
  --workspace FIRST_WORKSPACE --compare SECOND_INSTALLATION \
  --compare-workspace SECOND_WORKSPACE
../buck/bin/buck2 test cellar//bootstrap:
```
