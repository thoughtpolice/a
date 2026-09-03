<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fozzie

Fozzie is a vertically integrated, coverage-guided fuzzer for binaries built
by this repository. Buck selects the compiler instrumentation, builds the
complete code-under-test dependency closure, links a small target runtime, and
runs an ordinary test. The controller itself remains uninstrumented.

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

Run the bounded smoke campaign with the normal test interface:

```console
buck2 test //path/to:parser-fuzz
```

Importing seeds and dictionaries and hashing the target do not consume the
execution time budget. A campaign that executes nothing fails.

The test first calibrates its checked-in seeds, then fuzzes for the configured
time or execution count. Exhausting the budget without a finding passes. A
confirmed crash, hang, or nonzero harness result fails the test. Stochastic
fuzz tests explicitly disable test-result caching and execute locally.

Dictionary import streams and deduplicates entries in file order, retaining at
most 8,192 entries and reading at most 16 MiB across all dictionary files.
Reaching either limit prints a diagnostic and skips the remaining data; a line
longer than 1 MiB is rejected with its file and line number. Target hashing also
streams, so large executables do not need an equally large temporary buffer.

For a durable campaign, give `buck2 run` a work directory. Existing interesting
inputs in that directory are loaded automatically on the next invocation:

```console
buck2 run //path/to:parser-fuzz -- --workdir /var/tmp/parser-fuzz
```

## Architecture

The generated binary is intentionally small. It contains the user harness,
the transitively instrumented Rust/C/C++ code under test, and `fozzie_rt`. One
persistent target process runs per controller worker. Inputs live in a shared
mapping and fixed-size, little-endian Run/Done frames travel over a Unix socket in a private `/tmp` directory, independent of campaign path
length.
The parent owns timeouts and kills the target process group on failure.

LLVM SanitizerCoverage supplies inline 8-bit counters, PC tables, and trace-cmp
observations. The runtime turns nonzero counters into sparse, bucketed feature
IDs. The Rust controller owns global novelty, BLAKE3-addressed corpus files,
mutation and scheduling, comparison-derived dictionary values, process
lifecycle, replay, minimization, and artifacts. The protocol begins with magic,
layout, size, capability, and version checks; no fixed inherited file
descriptors or compiler-layout-dependent Rust/C structures cross the boundary.

Fozzie preserves crashes and hangs as first-class artifacts. Metadata includes
the input and target digests, build/instrumentation schema, Buck label, campaign
seed, failure class, target stderr, and a base64 reproduction command. Findings
are rerun in a fresh target before a Buck test fails; flaky findings are still
preserved and reported.

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

The initial backend is Linux and requires a repeatable
`LLVMFuzzerTestOneInput` harness. Persistent execution is fast but does not
reset arbitrary global target state, so harnesses must make repeated calls
independent. A slower spawn/file/stdin adapter and a forkserver are natural
future executors for stateful programs.

Coverage feedback works without an external sanitizer runtime. Sanitizer
profiles are separate toolchain selections because this repository's pinned
LLVM and Rust distributions control which compiler-rt libraries exist. This
keeps callback ownership unambiguous for mixed-language binaries.

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
