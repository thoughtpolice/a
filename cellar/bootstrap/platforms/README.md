<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Bootstrap configurations and execution

From the repository root, one command builds the x86 seed chain, cross-builds
an ARM compiler, runs its two native self-builds, and verifies the fixed point:

```sh
buck2 build @mode//buildbuddy cellar//bootstrap/...
```

`cellar//bootstrap:toolchain` selects the client's architecture. The explicit
installations are `stage1/llvm:toolchain` for x86_64 and
`stage2/aarch64/llvm:toolchain` for AArch64. Both can be dependencies of the same
build. `--modifier amd64` or `--modifier aarch64` changes the requested
architecture of the selector; no build-wide cross-compilation mode is needed.

## Three different architecture choices

| Choice | Meaning | Representation |
|---|---|---|
| Target configuration | ABI of the artifact being built | cellar's `:os` and `:cpu` constraints |
| Execution configuration | ABI of the tools executing an action | execution platform resolution and `attrs.exec_dep` |
| LLVM back ends | Machines the resulting compiler can generate code for | the upstream-derived LLVM inventory, currently X86 and AArch64 |

For example, an ARM stage0 object has the ARM target configuration and the
x86 execution configuration. Its C toolchain keeps ARM headers, flags and
runtime dependencies in the target configuration; its Clang, LLD, llvm-ar and
working-directory helper are execution dependencies and require x86. In the
next stage those executables require ARM. Python, sed and archive extraction
can still run on x86 in that same graph.

The original seed rules keep their executable compiler descriptors. The new
`c_toolchain` rule is an actual Buck toolchain (`is_toolchain_rule = True`).
`c_object`, `c_library` and `c_binary` with `target_cpu` use
`attrs.toolchain_dep`, which retains the target configuration and inherits the
consumer's executor. This is why moving to ARM does not accidentally change
the sysroot to x86 or try to execute an ARM compiler on an x86 worker.

`:default` remains the canonical **x86 seed platform**, preserving the existing
cache paths. `:linux-arm64` is the canonical ARM platform. Each executor uses
the same configuration identity as its target platform. There is no extra
"local", "remote", or bootstrap-stage constraint: changing where an action
runs does not create another copy of its compiler graph.

## Modifiers and transitions

Cellar owns its small modifier constructor and needs no prelude. Its precedence
for a top-level target is platform, PACKAGE, target, then CLI. It accepts
constraint labels and the aliases `amd64`/`x86_64`, `arm64`/`aarch64`, and
`linux`. The ARM packages use PACKAGE modifiers; individual cross-built tools
can declare a different target architecture. Compatibility attributes enforce
those declarations even when a CLI modifier requests an unsupported ABI.

An execution dependency receives the executor's configuration, ignoring target
architecture modifiers. A package requesting ARM cannot relabel an x86
executor. The parent project's unrelated build-mode modifiers do not enter the
bootstrap configuration.

Modifiers select requested roots; they do not establish fixed architecture
boundaries inside an aggregate graph. `amd64_dep` uses an outgoing transition
to keep the seed-chain predecessors, generated tables and source trees in
`:default`, even below an ARM target. It forwards the original providers and
artifacts without copying or rebuilding them. Adding another architecture
therefore shares the entire existing seed chain.

Buck uses the root project's configuration constructor even for an external
cell. The parent's constructor delegates cellar configurations to the same
functions used by `cellar/PACKAGE`. The standalone project and parent project
consequently produce the same constraint sets and configuration identities.
The configuration regression verifies both entry points.

## Local execution and BuildBuddy

`@mode//buildbuddy` configures the service connection and selects
`bootstrap.execution=auto`. Execution is resolved for each action:

- Linux programs may run locally only when their CPU matches the client.
- CPUs listed in `bootstrap.remote_cpus` may run remotely; the default is
  `amd64`, matching the currently available workers.
- Local actions also read and populate the remote cache. Automatic local
  execution uses Buck's native Landlock sandbox by default.
- Every registration uses `fallback = "error"`. There is no emulation, host
  tool lookup, or unspecified execution fallback.

Thus an ARM Linux client uses remote x86 workers and its native ARM executor.
An x86 Linux client can use local and remote x86 execution. To enable ARM
workers when the service has them, set `bootstrap.remote_cpus=amd64,arm64` in
the service configuration; the target graph is unchanged. A remote worker must
advertise `OSFamily=Linux` and `Arch=amd64` or `Arch=arm64`, the scheduler's Go
and OCI spellings, and its container image must support that architecture.

The BuildBuddy mode pins a distroless static image with no shell or toolchain.
The API key comes from `BUILDBUDDY_API_KEY` in the daemon's environment, never
the repository. Additional scheduler properties come from
`bootstrap.remote_properties`. The standalone project supplies no RE endpoint;
configure `[buck2_re_client]` in `cellar/.buckconfig.local` or an explicit
`--config-file` when using it independently: `engine_address`,
`action_cache_address`, `cas_address`, TLS and authentication settings.

The explicit `native`, `sandbox` and `remote` modes remain useful diagnostics.
`bootstrap.execution=local` registers only locally executable platforms;
`remote` registers both Linux architectures as remote-only and therefore
requires workers for any architecture the requested graph executes. The
`sandbox` mode restricts read access to declared inputs and `/proc/self`, with
Buck's device write paths plus pseudo-terminals. Auto mode uses those same
paths. `buck2.local_sandbox_mode` can explicitly override the default.

`buck2 run` executes its final program on the client. Execution platform
selection applies to build actions and tests; it does not remotely execute the
final program of a `run` command.

## Materialization

The graph works with Buck's deferred materializer. `-M none` avoids explicitly
materializing requested outputs, but native ARM actions still materialize the
inputs they must execute or read. A normal build materializes requested
outputs. A recursive pattern requests intermediate targets too; request
`cellar//bootstrap:toolchain` when only the installation should be materialized.
No rule uses host filesystem existence or materialization state to select an
architecture.

Cellar outputs opt out of content-based paths. Canonical configurations and
explicit transitions share the seed artifacts without storing each output
again at a content-hashed path. The standalone project uses `fs_hash_crawler`
and skips `buck-out` before traversal. The parent keeps Watchman and ignores
`cellar/buck-out`, where standalone builds write.

## Verification and extension

```sh
python3 cellar/bootstrap/platforms/test-platforms.py
buck2 audit execution-platform-resolution @mode//buildbuddy \
  cellar//bootstrap/stage2/aarch64/llvm:stage0-musl-0 \
  cellar//bootstrap/stage2/aarch64/llvm:stage1-musl-0
```

The regression checks fake Linux, macOS and Windows clients, both CPU types,
local rejection, remote properties, canonical configurations, modifier
precedence, fixed predecessor transitions, native TableGen, toolchain
execution resolution and sandbox permissions. It runs no compiler actions.
Its Buck test is labeled `nested-buck`, excluded by sandbox and remote modes
because it launches host Python and nested daemons. `:host-tests` is never
registered for build actions and retains Buck's host read paths. GCC driver
tests using `command_test(host_paths = True)` also use that test executor to
check that the compiler ignores programs in the host's `/usr/bin`.

A new architecture needs a CPU constraint and platform, compatible executors,
an upstream-derived source/runtime inventory and a bootstrap predecessor. A
new operating system also needs its own OS constraint, executor path semantics
and runtime/ABI implementation. Keep infrastructure availability in executor
registration, output ABI in target constraints, compiler tools in exec deps,
and fixed bootstrap ancestors behind transitions. Do not add a global mode
that changes the architecture of every node in the graph.

The design follows the local Buck2 documentation in
`~/src/buck2/docs/concepts/modifiers.md`, `concepts/transitions.md`,
`rule_authors/configurations.md`, `rule_authors/writing_toolchains.md`, and
`rfcs/implemented/execution_modifiers.md`. In particular, modifiers alone do
not replace transitions or toolchain dependencies.
