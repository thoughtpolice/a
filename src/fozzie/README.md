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
dependency graph. Clang supplies the one statically linked compiler-rt runtime
for C++, Rust, and mixed-language final binaries; Rust uses
`-Zexternal-clangrt` to avoid a second copy. Fuzz targets that install a custom
allocator should select the system allocator when `cfg(fozzie_asan)` is set,
because replacing `malloc` can bypass ASan's heap redzones. The Rust example
shows this while retaining mimalloc for ordinary coverage-only campaigns.

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

For a durable campaign, give `buck2 run` a work directory. External seeds are
imported into its content-addressed corpus, so it is self-contained afterward;
existing interesting inputs are loaded automatically on the next invocation:

```console
buck2 run //path/to:parser-fuzz -- --workdir /var/tmp/parser-fuzz
```

During execution, SIGINT (Ctrl-C) and SIGTERM stop active workers, retain the
campaign corpus and artifacts, and print `FOZZIE_SUMMARY` with
`interrupted_signal` set. An interrupted campaign exits with status 130 or 143
unless it already has a confirmed finding or infrastructure failure. The
`workdir_persisted` field reports whether the directory remains after exit,
including a supplied `--workdir` on a successful campaign.

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

Hegel-style generated programs are a natural complement. For a WASM compiler,
a harness can generate or decode a bounded module, run it through a trusted
interpreter and the compiler under test, and assert equal values, traps, and
observable memory. Hegel supplies high-value structured cases; Fozzie supplies
mutation, coverage feedback, parallel execution, lifecycle isolation, corpus
management, and Buck reproducibility. Neither component needs to know the
other's internal scheduling model.

## Current boundary and next layers

The initial backend is Linux 5.3 or newer (for `pidfd_open`) and requires a
repeatable `LLVMFuzzerTestOneInput` harness. Persistent execution is fast but
does not reset arbitrary global target state, so harnesses must make repeated
calls independent and must join or quiesce any work that can still touch the
input before returning. A slower spawn/file/stdin adapter and a forkserver are
natural future executors for stateful programs.

Coverage feedback works without an external sanitizer runtime. The optional
address profile uses the ASan-only compiler-rt carried by the pinned Clang
toolchain; it does not link libFuzzer or Rust's bundled sanitizer archives.
Keeping Clang as the single runtime owner makes callback and allocator
ownership unambiguous for mixed-language binaries.

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
