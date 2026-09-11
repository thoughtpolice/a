<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

Hegel's native engine and C ABI, built from the `hegeltest-c` crate managed
by Reindeer. The header comes from that same crate archive.

| Target in `third-party//by-name/li/libhegel` | Use |
| --- | --- |
| `:libhegel` | C/C++ dependency; exports `<hegel.h>` and native link dependencies |
| `:shared` | Standalone `libhegel.so`, `libhegel.dylib`, or `hegel.dll` for FFI loading |
| `:static` | Rust `staticlib` archive for embedding the engine |
| `:hegel.h` | Upstream C header for binding generation |
| `:rust` | Hegel's Rust frontend, with the engine linked statically |

Build the artifacts with:

```sh
buck2 build third-party//by-name/li/libhegel:shared \
  third-party//by-name/li/libhegel:static \
  third-party//by-name/li/libhegel:hegel.h --show-output
```

C/C++ targets should depend on `:libhegel`; Buck carries the transitive
dependencies. Use `link_style = "static_pic"` for static linking into a PIE
executable, or `"shared"` for dynamic linking. The `"static"` link style and
`:static` archive contain non-PIC Rust code; on Linux they require a
non-PIE executable (`-no-pie`). When linking `:static` outside Buck, also
link mimalloc and the platform libraries required by Rust's standard
library. Buck's `:libhegel` dependency carries the native dependencies.
Foreign runtimes can load `:shared`
directly and bind the declarations in `:hegel.h`. Use the matching header
and library together: the engine's version is distinct from the Rust
frontend's version.

The C API uses a pull loop: create settings, start a run, request a test
case, draw values, and mark the case's outcome. After the run ends, inspect
its result and any minimized failures. Release handles with the matching
`hegel_*_free` functions, including strings through their owning handles;
the header documents ownership and threading. [test.c](test.c) demonstrates
passing and failing runs, shrinking, and replay through this interface.

The repository compiles Rust with `panic=abort`. The C protocol reports
property outcomes explicitly and supports shrinking without unwinding
through a host runtime. The Rust frontend retains the repository's existing
limitation: panic-based failures and rejections abort instead of unwinding.

Run the integration tests and Rust frontend regressions with:

```sh
buck2 test third-party//by-name/li/libhegel: tilde//aseipp/hegel:tests
```

When updating, change `hegeltest` and its matching `hegeltest-c` pin in
`buck/third-party/rust/Cargo.toml`, update this package's `PACKAGE` version
and OSV metadata, and run:

```sh
buck/bin/reindeer --third-party-dir buck/third-party/rust buckify
```
