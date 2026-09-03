<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fozzie

Fozzie is a vertically integrated, coverage-guided fuzzer for binaries built
by this repository. Buck selects the compiler instrumentation, builds the
complete code-under-test dependency closure, links a small target runtime, and
runs an ordinary test. The wrapper retains the native binary's Buck runtime
files and resources; the controller itself remains uninstrumented.

The immediate goal is robustness: finding crashes, hangs, assertion failures,
miscompilations, and violations of semantic or differential oracles. The same
mechanics naturally find security bugs, but Fozzie does not assume that a
finding must be security-sensitive to matter.

## Use it

A C or C++ harness exports the ecosystem-standard entry point:

```c
#include "fozzie/runtime/target.h"

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    parse(data, size);
    return 0;
}
```

Its `BUILD` file creates a fuzz test and instruments every dependency below the
generated target binary:

```python
load("@root//src/fozzie:defs.bzl", "cxx_fuzz_binary")

cxx_fuzz_binary(
    name = "parser-fuzz",
    srcs = ["parser_fuzz.cc"],
    deps = [":parser"],
    corpus = [":seeds"],
)
```

Rust uses the same ABI through a small macro. Fuzz binary crates use
`#![no_main]`; the Buck rule supplies the target runtime and abort-on-panic
policy.

```rust
#![no_main]

fozzie::fuzz_target!(|data: &[u8]| {
    let _ = parser::parse(data);
});
```

```python
load("@root//src/fozzie:defs.bzl", "rust_fuzz_binary")

rust_fuzz_binary(
    name = "parser-fuzz",
    srcs = ["parser_fuzz.rs"],
    deps = [":parser"],
    corpus = [":seeds"],
)
```

A closure declared `-> i32` returns the harness result. Zero is an ordinary
run; any other value is a `nonzero_harness` finding fingerprinted by that
value, so an oracle with several ways to fail gives each its own code and
prints what it saw on stderr before returning:

```rust
fozzie::fuzz_target!(|data: &[u8]| -> i32 {
    match parser::parse(data) {
        Ok(tree) if tree.encode() != data => 1,
        _ => 0,
    }
});
```

AddressSanitizer is an opt-in profile on either rule:

```python
rust_fuzz_binary(
    name = "parser-fuzz-asan",
    srcs = ["parser_fuzz.rs"],
    deps = [":parser"],
    sanitizer = "address",
)
```

The transition applies ASan and SanitizerCoverage to the complete target
dependency graph. On Linux, Clang supplies the one statically linked
compiler-rt runtime for C++, Rust, and mixed-language final binaries, and Rust
uses `-Zexternal-clangrt` to avoid a second copy; macOS links the dynamic
runtime described under the current boundary below. Fuzz targets that install a custom
allocator should select the system allocator when `cfg(fozzie_asan)` is set,
because replacing `malloc` can bypass ASan's heap redzones. The Rust example
shows this while retaining mimalloc for ordinary coverage-only campaigns.

A harness that needs a file at run time, such as a reference implementation
to compare against, names it in `resources`. The file belongs to the wrapper
rather than the target, so it is built without instrumentation, and the
engine starts the target with `--fozzie-resource=NAME=PATH` for each one,
the path made absolute. A Rust harness finds it with
`fozzie::resource("NAME")`; a C harness reads its command line in
`LLVMFuzzerInitialize`. The same flag, `--resource NAME=PATH`, serves
`replay` and `minimize`.

Run the bounded smoke campaign with the normal test interface:

```console
buck2 test //path/to:parser-fuzz
```

After importing seeds and dictionaries and hashing the target, the test starts
its time budget. Calibration and fuzzing share the configured time or primary
execution count; a campaign that executes nothing fails. Fresh-process
verification runs are additional and reported separately in `FOZZIE_SUMMARY`.
Exhausting the budget without a finding passes. A confirmed crash, hang,
unexpected process exit, or nonzero harness result fails the test. Test mode
forces one worker, disables result caching, and executes locally.

Dictionary import streams and deduplicates entries in file order, retaining at
most 8,192 entries and reading at most 16 MiB across all dictionary files.
Reaching either limit prints a diagnostic and skips the remaining data; a line
longer than 1 MiB is rejected with its file and line number. Target hashing also
streams, so large executables do not need an equally large temporary buffer.

Each run hands its coverage features and comparison observations back through
shared regions of `feature_capacity` entries, 65,536 by default, and
`cmp_capacity` entries, 4,096 by default. A run that exceeds either keeps
what fit but loses the rest of that feedback, and the summary counts it under
`truncated_observations`; a target that parses or compiles whole programs
wants a larger comparison capacity. Comparison operands only ever feed the
dynamic dictionary, so once it holds its 8,192 entries the engine stops
decoding the comparison region altogether and no longer counts its
truncation; the cost of a large `cmp_capacity` is then only the target's
recording.

For a durable campaign, give `buck2 run` a work directory. External seeds are
imported into its content-addressed corpus, so it is self-contained afterward;
existing interesting inputs are loaded automatically on the next invocation:

```console
buck2 run //path/to:parser-fuzz -- --workdir /var/tmp/parser-fuzz
```

The rule fixes the worker count, the budget, the timeout, and the capacities
on that command line, but the last occurrence of an option wins, so a
campaign can still choose its own:

```console
buck2 run //path/to:parser-fuzz -- --workdir /var/tmp/parser-fuzz --jobs 8 --duration 3600
```

During execution, SIGINT (Ctrl-C) and SIGTERM stop active workers, retain the
campaign corpus and artifacts, and print `FOZZIE_SUMMARY` with
`interrupted_signal` set. An interrupted campaign exits with status 130 or 143
unless it already has a confirmed finding or infrastructure failure. The
`workdir_persisted` field reports whether the directory remains after exit,
including a supplied `--workdir` on a successful campaign.

Every campaign publishes its live state to `<workdir>/status.json`,
rewritten atomically about once a second and once more at exit: the phase,
execution and coverage counts, per-worker counters, mutator yields, and the
confirmed finding, if any. Campaigns outside `--test-mode` also register
themselves under `$FOZZIE_STATE_DIR` (by default `$XDG_STATE_HOME/fozzie`,
or `~/.local/state/fozzie`), one entry per work directory; a temporary
campaign that finishes with nothing to keep removes its entry again.
`fozzie tui` reads that registry and each campaign's status file.

### Watching campaigns

`fozzie tui` is a status screen over every campaign the registry knows,
plus any given as `--workdir DIR`:

```console
buck2 run root//src/fozzie/engine:fozzie -- tui
```

One row per campaign shows its state, executions, current rate, corpus and
coverage counts, and findings; the panels below describe the selected one
the way AFL++ does: timing, results with the covered share of the target's
counter map, throughput with a rate history, per-worker counters, mutator
yields, and the findings on disk with their `repro` commands and captured
stderr. A campaign whose process is gone without a final status shows as
`dead`, one whose status file stopped updating as `stalled`. `j`/`k` or
the arrows select a campaign, `Tab` moves between the campaign table, the
findings list, and the finding detail, `Enter` opens a finding,
`PgUp`/`PgDn` scroll, `r` refreshes, `?` shows the keys, and `q` quits.
`--refresh-ms` sets the poll interval and `--no-registry` watches only the
given directories. `--once` prints a single frame as plain text and exits,
for scripts and CI, with `--width` and `--height` fixing its size:

```console
buck2 run root//src/fozzie/engine:fozzie -- tui --once --workdir /var/tmp/parser-fuzz
```

## Architecture

The generated binary is intentionally small. It contains the user harness,
the transitively instrumented Rust/C/C++ code under test, and `fozzie_rt`. One
persistent target process runs per controller worker. Inputs arrive through a
shared mapping, then the runtime copies each one into a guarded private arena
and asks ASan to poison the bytes before and beyond its logical bounds. The
input slot is shadow-granule aligned, and controller-required ASan options keep
user poisoning enabled. Fixed-size, little-endian Run/Done frames travel over
a Unix socket in a private `/tmp` directory, independent of campaign path
length. The parent enforces one absolute deadline, monitors the direct target
even when descendants retain descriptors, and kills residual process group
members on failure. A natural direct-child failure observed before that cleanup
retains its crash or exit identity; otherwise a late response is a hang. Target
stderr is continuously drained into a bounded per-worker tail buffer.
Before each Run, the controller drains and resets that buffer under the same
lock as its reader, keeping diagnostics from completed calls out of later
findings. Harnesses must finish their stderr writes before returning.

LLVM SanitizerCoverage supplies inline 8-bit counters, PC tables, and trace-cmp
observations. The runtime turns nonzero counters into sparse, bucketed feature
IDs. The Rust controller owns global novelty, BLAKE3-addressed corpus files,
mutation and scheduling, comparison-derived dictionary values, process
lifecycle, replay, minimization, and artifacts. The protocol begins with magic,
layout, size, capability, and version checks; no fixed inherited file
descriptors or compiler-layout-dependent Rust/C structures cross the boundary.

Fozzie preserves crashes and hangs as first-class artifacts. Metadata includes
the input and target digests, build/instrumentation schema, Buck label, campaign
seed, structured finding fingerprint, bounded target stderr, and reproduction
instructions. Small inputs with UTF-8 target paths and arguments retain an
inline base64 reproduction command. Metadata schema 3 also embeds a replay
manifest with the original path, argument, and input bytes. Large inputs or
non-UTF-8 arguments use `fozzie replay-artifact METADATA.json`, which verifies
the input and target digests before replay. Keep that metadata file when
copying findings out of a Buck sandbox. Findings are rerun in a fresh target and must match the
same signal/exit status and sanitizer signature before a Buck test fails;
minimization preserves that structured fingerprint. Unsanitized crashes with
the same signal are one class until a future ptrace backend adds native stack
identity. Concurrent candidates wait for the verifier instead of being
discarded, and flaky candidates remain durable. If no `--workdir` was supplied,
a campaign with any finding or infrastructure failure retains its temporary
directory and reports the path in the summary.

## Compiler and semantic fuzzing

For compiler work, put the oracle in the harness. Good patterns include:

- Compile the same input at two optimization levels and compare behavior.
- Compile to an interpreter and a native backend and compare results.
- Apply a semantics-preserving transformation and require equivalent output.
- Round-trip an IR through encoding, decoding, validation, and execution.
- Assert invariants over diagnostics rather than requiring all bytes to parse.

Report each oracle's failure as a distinct nonzero harness result rather
than a panic: the code becomes the finding's identity, so two oracles never
collapse into one class and `fozzie replay --expect-code` pins a regression
to the property that found it.

Hegel-style generated programs are a natural complement. For a WASM compiler,
a harness can generate or decode a bounded module, run it through a trusted
interpreter and the compiler under test, and assert equal values, traps, and
observable memory. Hegel supplies high-value structured cases; Fozzie supplies
mutation, coverage feedback, parallel execution, lifecycle isolation, corpus
management, and Buck reproducibility. Neither component needs to know the
other's internal scheduling model.

## Current boundary and next layers

Fozzie runs on Linux 5.3 or newer and on macOS, and requires a repeatable
`LLVMFuzzerTestOneInput` harness. On Linux the controller watches each target
through a pidfd, and the kernel kills targets whose controller dies
(`PR_SET_PDEATHSIG`). On macOS a kqueue process filter stands in for the
pidfd, and a thread in the target runtime watches the controller and delivers
the same SIGKILL. macOS crash reporting can hold a crashing target for a while
before it can be reaped, so a target already dying of its own signal when the
deadline passes is classified as a crash, not a hang; crash-heavy campaigns
still run faster with the reporter disabled
(`launchctl unload -w /System/Library/LaunchAgents/com.apple.ReportCrash.plist`).
Persistent execution is fast but does not reset arbitrary global target
state, so harnesses must make repeated calls independent and must join or
quiesce any work that can still touch the input before returning. A slower
spawn/file/stdin adapter and a forkserver are natural future executors for
stateful programs.

Coverage feedback works without an external sanitizer runtime. The optional
address profile uses the compiler-rt carried by the Clang on `PATH`; it does
not link libFuzzer. On Linux that runtime is linked statically and Rust
targets use `-Zexternal-clangrt`, so Clang owns the single copy and callback
and allocator ownership stay unambiguous for mixed-language binaries. Darwin
ships ASan only as a dylib, and rustc's `-nodefaultlibs` link keeps Clang from
adding it, so a Rust target on macOS links rustc's copy of the same runtime
instead and C objects bind to it through the stable ASan ABI.

The controller keeps execution, feature collection, corpus storage, mutation,
scheduling, and artifact decisions separate. Those are the seams for future
ClusterFuzz-style sharding: content-addressed inputs in shared storage,
per-build feature metadata, append-only worker shards, asynchronous corpus
imports, sanitizer replay variants, and offline corpus distillation.

The target ABI and instrumentation choices follow the contracts documented by
[LLVM SanitizerCoverage](https://clang.llvm.org/docs/SanitizerCoverage.html)
and [libFuzzer](https://llvm.org/docs/LibFuzzer.html). The process/corpus split
also borrows the durable ideas from
[honggfuzz](https://github.com/google/honggfuzz),
[AFL++](https://aflplus.plus/docs/fuzzing_in_depth/), and
[Centipede](https://github.com/google/fuzztest/tree/main/centipede), without
embedding any of those engines in the Buck graph.
