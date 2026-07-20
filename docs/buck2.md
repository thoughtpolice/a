# Buck2 Build System Reference

Buck2 is a large-scale multi-language build system designed for hermetic, reproducible builds. This monorepo uses Buck2 exclusively for all builds, tests, and packaging. It's conceptually similar to Bazel, with many shared ideas and patterns.

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Targets, Packages, and Cells](#targets-packages-and-cells)
3. [BUILD Files and Starlark](#build-files-and-starlark)
4. [Starlark Language Essentials](#starlark-language-essentials)
5. [Understanding Build Graphs](#understanding-build-graphs)
6. [Target Patterns and Addressing](#target-patterns-and-addressing)
7. [Monorepo Cell Structure](#monorepo-cell-structure)
8. [Configuration System](#configuration-system)
9. [Query System](#query-system)
10. [Advanced Query Patterns](#advanced-query-patterns)
11. [Common Commands and Workflows](#common-commands-and-workflows)
12. [Debugging and Troubleshooting](#debugging-and-troubleshooting)
13. [Performance and Caching](#performance-and-caching)
14. [Best Practices](#best-practices)
15. [Integration with jj Workflows](#integration-with-jj-workflows)

---

## Core Concepts

Buck2 is fundamentally different from traditional build tools like Make, Cargo, or npm. Understanding these core concepts is essential:

### Build as a Pure Function

Buck2 treats building as a pure mathematical function: given the same inputs (source files, dependencies, toolchains), you get identical outputs (binaries, libraries). This enables:

- **Hermetic builds**: No hidden dependencies on system state
- **Reproducible artifacts**: Same build anywhere, anytime
- **Efficient caching**: Content-addressed artifacts never rebuild unnecessarily
- **Distributed execution**: Actions can run anywhere with identical results

**Philosophy**: Buck2's design assumes that build processes should be deterministic and traceable. Every build action is a function from inputs to outputs, with no side effects. This means:
- No network access during builds (dependencies fetched ahead of time)
- No reading from arbitrary filesystem locations
- No accessing environment variables (except explicitly declared ones)
- Outputs depend only on declared inputs

### Everything is a Graph

Buck2 operates on directed acyclic graphs (DAGs) at multiple levels:

1. **Target Graph**: High-level dependencies between targets (`:binary` depends on `:lib`)
2. **Action Graph**: Low-level build commands (compile, link, copy)
3. **Package Graph**: Dependencies between packages

This graph-based model allows Buck2 to:
- Parallelize builds maximally
- Cache at fine granularity
- Determine exactly what needs rebuilding
- Detect cycles and enforce DAG structure

**Why graphs matter**: Traditional build systems often use linear scripts or Makefiles that hide dependencies. Buck2 makes all dependencies explicit in the graph, which enables:
- Accurate incremental builds (rebuild only what changed)
- Safe parallelization (independent actions run concurrently)
- Remote execution (actions can be distributed to workers)
- Build analysis and optimization (query the graph to understand builds)

### Incremental and Cached

Buck2 never rebuilds more than necessary:
- Changes to `src/foo.rs` only recompile targets depending on `foo.rs`
- Unchanged targets use cached artifacts (local or remote)
- Content addressing ensures cache correctness (SHA256 hashes)

**How it works**: Every build action is identified by a hash of:
1. Input file contents (SHA256 of all source files)
2. Dependencies (hashes of all deps)
3. Command and flags (exact compiler invocation)
4. Toolchain version (compiler, linker versions)

If the hash matches a cached artifact, Buck2 reuses it. Otherwise, it executes the action and caches the result.

### Deterministic Execution

Buck2 guarantees that builds are deterministic:
- Same inputs always produce identical outputs (bit-for-bit)
- No race conditions or build order dependencies
- Timestamps don't affect caching
- Random numbers or UUIDs in builds break hermeticity (don't do it!)

**Implications**:
- Reproducible builds for security audits
- Reliable caching across machines and time
- Easier debugging (same inputs = same outputs)

---

## Targets, Packages, and Cells

Buck2 organizes code into a three-level hierarchy:

### Cells

A **cell** is a top-level organizational unit, typically a directory with a `.buckconfig` file. Cells are defined by a short name mapped to a directory path.

In this monorepo, cells are defined in the root `.buckconfig`:

```ini
[cells]
depot = .
depot-cellar = cellar
depot-mode = buck/mode
depot-toolchains = buck/toolchains
depot-third-party = buck/third-party

[cell_aliases]
root = depot
cellar = depot-cellar
mode = depot-mode
toolchains = depot-toolchains
third-party = depot-third-party
```

**Cell aliases** provide convenient shorthand:
- `root//` = `depot//` (primary cell)
- `third-party//` = `depot-third-party//`

**Why cells?** Cells allow large monorepos to be organized into logical boundaries:
- Separate ownership and visibility rules
- Different configuration per cell
- Isolation of third-party dependencies
- Multi-repo support (reference external cells)

### Packages

A **package** is a directory containing a `BUILD` file (and optionally a `PACKAGE` file). Packages group related targets together and can contain:
- `BUILD` file: Defines targets (binaries, libraries, tests)
- `PACKAGE` file: Package-level metadata and defaults
- Source files, assets, configuration

Example package structure:
```
src/myproject/
├── BUILD           # Defines targets
├── PACKAGE         # Metadata (license, version)
├── src/
│   ├── main.rs
│   └── lib.rs
└── tests/
    └── integration.rs
```

**Package boundaries**: Packages are Buck2's unit of code organization. Each package:
- Has its own BUILD file defining targets
- Can set default visibility for all targets
- May declare metadata (license, version, description)
- Forms a node in the package dependency graph

### Targets

A **target** is a buildable unit of code defined in a `BUILD` file. Every target has a unique name within its package and produces artifacts (binaries, libraries, archives).

Targets are created by applying **rules** (functions) with parameters:

```starlark
depot.rust_binary(
    name = "myapp",          # Target name
    srcs = glob(["src/**/*.rs"]),
    deps = [":lib"],         # Dependency on another target
)
```

**Target types**: Different rules produce different kinds of targets:
- **Binary targets**: Executable programs (`rust_binary`, `cxx_binary`)
- **Library targets**: Reusable code (`rust_library`, `cxx_library`)
- **Test targets**: Test suites (`rust_test`, `python_test`)
- **Generated targets**: Outputs from custom rules

---

## BUILD Files and Starlark

### BUILD File Basics

`BUILD` files are written in **Starlark**, a deterministic Python-like language designed for build systems. Key characteristics:

- **Declarative, not imperative**: BUILD files describe *what* to build, not *how*
- **No evaluation order**: Targets can be defined in any order
- **Lazy evaluation**: Targets are only built when needed
- **Hermetic**: No access to system state, network, or filesystem (except via rules)

**Starlark restrictions**: Unlike Python, Starlark is intentionally limited:
- No `import` statements (use `load()` instead)
- No recursion (prevents infinite loops)
- No mutation of frozen values (immutability enforced)
- No file I/O or network access
- Deterministic execution (same inputs → same outputs)

A typical BUILD file structure:

```starlark
# SPDX headers (required in this monorepo)
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Load rule wrappers
load("@root//buck/shims:shims.bzl", depot = "shims")

# Define common dependencies
COMMON_DEPS = [
    "third-party//rust:anyhow",
    "third-party//rust:clap",
]

# Define targets
depot.rust_library(
    name = "lib",
    srcs = glob(["src/lib.rs", "src/**/*.rs"]),
    deps = COMMON_DEPS,
)

depot.rust_binary(
    name = "myapp",
    srcs = ["src/main.rs"],
    deps = [":lib"] + COMMON_DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["tests/**/*.rs"]),
    deps = [":lib", "third-party//rust:insta"],
)
```

`depot.rust_test` and `depot.go_test` follow Buck2's root
`test.use_internal_runner` setting. Its default, `true`, discovers and schedules
each Rust `#[test]` or top-level Go test in a separate process through Buck2's
internal runner. Use `-c test.use_internal_runner=false` for the standard
external runner. A comma-separated framework list selects the internal rule
only for the named languages, for example
`-c test.use_internal_runner=go,rust,gtest`.

Go discovery follows the standard test-binary interface: `-test.list .` finds
top-level tests, fuzz tests, and runnable examples, and each is selected with an
anchored `-test.run` expression. Subtests stay within their top-level test's
process. Benchmarks are omitted, matching ordinary `go test` behavior.

`depot.dynamic_test` extends the internal runner to arbitrary binaries that can
enumerate their own work (framework name `dynamic` in the setting above; it
degrades to a `run_test`-style opaque external test when disabled). The binary
implements a small stdout protocol: `<binary> -list-tests <args...>` prints one
`test: <filter> <name>` line per case, Buck2 then runs
`<binary> -run-test <args...> <filter>` once per case, and that execution
prints any number of `result: <PASS|FAIL|SKIP> <name> <seconds|-> [message]`
lines, each optionally followed by `result-details:` diagnostic lines. One case
may fan out into many named results, which lets a checker gather expensive data
in memory — batched network queries, `buck audit` output — in a single process
while still reporting a granular per-item verdict. The process exits 0 when
nothing failed, 1 when a FAIL result was reported, and anything else for
infrastructure errors. Listings are cacheable actions, so they must be a pure
function of the command line and its declared inputs; discovery that reads
undeclared state belongs in case execution, which always runs fresh.
`buck/tests/dynamic-runner` is a live fixture for the protocol, and
`buck/tests/osv.io` is the real consumer.

### Rules vs Macros vs Functions

Understanding the distinction is important:

**Rules** (e.g., `rust_binary`):
- Define buildable targets that produce artifacts
- Implement actual build logic (compilation, linking)
- Cannot be defined in BUILD files, only applied
- Examples: `rust_binary`, `cxx_library`, `java_test`

**Macros** (Starlark functions):
- Convenience wrappers that generate multiple targets or simplify configuration
- Can be defined in `.bzl` files and used in BUILD files
- Example: `depot.command()` wraps a binary with additional metadata

**Functions** (Starlark builtins):
- Utility functions available in BUILD files
- Examples: `glob()`, `select()`, `read_config()`

**When to use each**:
- **Rules**: For defining buildable artifacts
- **Macros**: For reusable patterns that create multiple targets
- **Functions**: For file selection, conditional logic, configuration

---

## Starlark Language Essentials

Starlark is Buck2's configuration language. Here are the essential patterns you'll use:

### Variables and Data Types

```starlark
# Strings
name = "myapp"
description = "My application"

# Lists
deps = ["third-party//rust:serde", "third-party//rust:tokio"]
srcs = ["main.rs", "lib.rs"]

# Dictionaries
env = {
    "DATABASE_URL": "sqlite:///db.sqlite",
    "LOG_LEVEL": "info",
}

# Constants (by convention, uppercase)
COMMON_DEPS = ["third-party//rust:anyhow"]
TEST_DEPS = COMMON_DEPS + ["third-party//rust:insta"]
```

**Immutability**: Values in Starlark are immutable once frozen. Lists and dicts can be modified during BUILD file evaluation, but become frozen after.

### List Operations

```starlark
# Concatenation
all_deps = COMMON_DEPS + ["third-party//rust:tokio"]

# Filtering with comprehensions
rust_files = [f for f in all_files if f.endswith(".rs")]

# Transformations
binary_names = [f.removesuffix(".rs") for f in glob(["src/bin/*.rs"])]
```

### Glob Patterns

`glob()` selects files matching patterns:

```starlark
# All Rust source files
srcs = glob(["src/**/*.rs"])

# Exclude test files
srcs = glob(["src/**/*.rs"], exclude = ["src/**/*_test.rs"])

# Multiple patterns
srcs = glob(["src/**/*.rs", "benches/**/*.rs"])

# Specific subdirectories
srcs = glob(["src/core/*.rs", "src/utils/*.rs"])
```

**Important**: `glob()` is evaluated at parse time, not build time. It sees files as they exist when Buck2 reads the BUILD file.

**Glob best practices**:
- Use `**` for recursive matching: `src/**/*.rs`
- Exclude test files from libraries: `exclude = ["**/*_test.rs"]`
- Be specific to avoid accidental inclusions
- Don't glob across package boundaries (use explicit deps)

### List Comprehensions

Generate multiple targets programmatically:

```starlark
# Create a binary for each file in src/bin/
[
    depot.rust_binary(
        name = bin.removesuffix(".rs"),
        srcs = [bin],
        deps = [":lib"],
    )
    for bin in glob(["src/bin/*.rs"])
]

# Generate tests for each module
[
    depot.rust_test(
        name = "test-" + module,
        srcs = [module + ".rs"],
        deps = [":lib"],
    )
    for module in ["auth", "db", "api"]
]
```

**Pattern**: List comprehensions are ideal for:
- Multiple binaries from a common library
- Parallel test suites
- Platform-specific variations
- Code generation workflows

### Conditional Logic with `select()`

`select()` enables conditional configuration based on build settings:

```starlark
# Platform-specific sources
srcs = select({
    "toolchains//cfg/target:x86_64-linux": glob(["src/x86_64/*.rs"]),
    "toolchains//cfg/target:aarch64-linux": glob(["src/aarch64/*.rs"]),
    "DEFAULT": [],
})

# Build mode flags
rustc_flags = select({
    "mode//:debug": ["-Cdebuginfo=2"],
    "mode//:release": ["-Copt-level=3"],
})

# Platform-specific dependencies
deps = [
    "third-party//rust:anyhow",
] + select({
    "toolchains//cfg/target:x86_64-linux": ["third-party//rust:native-linux"],
    "toolchains//cfg/target:aarch64-linux": ["third-party//rust:native-aarch64"],
    "DEFAULT": [],
})
```

The `select()` function is evaluated during the **configuration phase**, after the target graph is constructed but before actions are executed.

**`select()` semantics**:
- Keys are configuration labels (platform, mode, feature flags)
- Values can be lists, strings, or other types
- `"DEFAULT"` provides a fallback if no key matches
- Multiple `select()` expressions can be combined with `+`

### Control Flow

```starlark
# Conditional with ternary
deps = COMMON_DEPS + (["third-party//rust:tokio"] if async_enabled else [])

# Filtering
test_srcs = [s for s in all_srcs if "_test.rs" in s]

# Mapping
bin_targets = [make_binary(f) for f in bin_files]
```

**No if/else statements**: Starlark doesn't have traditional `if/else` blocks in BUILD files. Use:
- Ternary expressions: `value if condition else other`
- `select()` for build-time conditionals
- List comprehensions with filtering

### Functions and Macros

Define reusable logic in `.bzl` files:

```starlark
# In custom.bzl
def make_app(name, version):
    """Create a binary and test for an application."""
    depot.rust_binary(
        name = name,
        srcs = glob(["src/**/*.rs"]),
        version = version,
    )

    depot.rust_test(
        name = name + "-test",
        srcs = glob(["src/**/*.rs", "tests/**/*.rs"]),
        deps = [":" + name],
    )

# In BUILD
load("//pkg:custom.bzl", "make_app")

make_app(name = "myapp", version = "1.0.0")
```

**Macro best practices**:
- Keep macros simple and focused
- Document parameters clearly
- Avoid complex logic (build files should be readable)
- Use macros to enforce patterns, not hide complexity

---

## Understanding Build Graphs

Buck2 operates on two primary graph structures. Understanding these is key to debugging builds and optimizing performance.

### Target Graph

The **target graph** is the high-level dependency graph defined in BUILD files. Nodes are targets, edges are dependencies.

Example:
```
//src/app:binary → //src/app:lib → //third-party/rust:serde
                → //src/utils:helpers
```

This graph is:
- **Explicit**: Defined by `deps` attributes
- **Static**: Determined at parse time (with `select()` resolution at configuration time)
- **Acyclic**: Cycles are forbidden and cause errors

View the target graph:
```bash
# Show dependencies of a target
buck2 query "deps('//src/app:binary')"

# Show reverse dependencies (what depends on this?)
buck2 query "rdeps('//src/...', '//src/utils:helpers')"

# Visualize as DOT graph
buck2 query "deps('//src/app:binary')" --output-format=dot > graph.dot
dot -Tpng graph.dot -o graph.png
```

**Target graph properties**:
- **Transitive closure**: `deps()` includes all transitive dependencies
- **No cycles**: DAG structure enforced by Buck2
- **Explicit dependencies**: Hidden deps cause build failures
- **Visibility-aware**: Respects `visibility` restrictions

### Action Graph

The **action graph** is the low-level graph of build commands. Buck2 transforms the target graph into concrete actions (compile, link, copy, etc.).

Example actions for `rust_binary`:
1. Compile each `.rs` file → `.rlib`
2. Link all `.rlib` files → binary
3. Copy binary to output location

This graph is:
- **Implicit**: Generated by rules from the target graph
- **Dynamic**: Can vary based on configuration
- **Fine-grained**: Many actions per target

View action details:
```bash
# Show what commands ran for a build
buck2 log what-ran

# Show failed actions
buck2 log what-failed

# Explain why a target needs rebuilding
buck2 explain //src/app:binary
```

**Action graph characteristics**:
- **Content-addressed**: Actions identified by input hashes
- **Parallelizable**: Independent actions run concurrently
- **Cacheable**: Outputs cached by action hash
- **Remote executable**: Actions can run on remote workers

### Configuration and Resolution

Between parsing BUILD files and executing actions, Buck2 performs **configuration**:

1. **Parse phase**: Read BUILD files, construct unconfigured target graph
2. **Configuration phase**: Resolve `select()`, apply platform settings, determine toolchains
3. **Action phase**: Generate action graph and execute

This is why there are two query commands:
- `buck2 uquery`: Query unconfigured targets (before `select()` resolution)
- `buck2 cquery`: Query configured targets (after `select()` resolution)

Example difference:
```bash
# Unconfigured: see the select() expression
buck2 uquery 'filter(srcs, //src/app:binary)' --output-attribute=srcs

# Configured: see the resolved sources for current platform
buck2 cquery 'filter(srcs, //src/app:binary)' --output-attribute=srcs
```

**Why two phases?**
- **Unconfigured**: Represents what's in BUILD files literally
- **Configured**: Represents what will actually build for a specific platform/mode
- This separation enables:
  - Cross-platform builds from the same BUILD files
  - Multiple configurations from one target definition
  - Efficient caching across configurations

### Graph Comparison: Target vs Action

| Aspect | Target Graph | Action Graph |
|--------|--------------|--------------|
| **Definition** | Defined in BUILD files | Generated by rules |
| **Nodes** | Targets (binaries, libraries) | Build commands (compile, link) |
| **Edges** | Dependencies | Data flow |
| **Granularity** | Coarse (per target) | Fine (per file/action) |
| **Query** | `buck2 query` | `buck2 log what-ran` |
| **Visibility** | Explicit in BUILD | Generated by Buck2 |
| **Caching** | Target-level | Action-level |

---

## Target Patterns and Addressing

### Fully Qualified Target Names (FQTN)

The most explicit syntax for referring to a target:

```
cell//path/to/package:target-name
```

Example: `third-party//rust:serde`

Components:
- `cell`: The cell name (e.g., `third-party`, `root`, `depot`)
- `path/to/package`: Path from cell root to package directory
- `target-name`: Name of the target in the BUILD file

FQTNs work anywhere in the source tree and are unambiguous.

### Shorthand Patterns

Buck2 supports convenient shorthand for target references:

| Pattern | Meaning | Example |
|---------|---------|---------|
| `cell//pkg:target` | Fully qualified | `third-party//rust:serde` |
| `//pkg:target` | Default to current cell | `//src/app:binary` |
| `//pkg:` | All targets in package | `//src/app:` |
| `//pkg` | Default target (`:pkg`) | `//src/app` → `//src/app:app` |
| `//pkg/...` | All targets recursively | `//src/...` |
| `:target` | Target in current package | `:lib` |
| `:` | All targets in current dir | `:` |

**Important convention**: The default cell for unqualified targets is `root` (the primary cell).

### Recursive Patterns

The `...` wildcard matches all packages recursively:

```bash
# Build everything under src/
buck2 build //src/...

# Test everything in the entire repository
buck2 test root//...

# List all targets in third-party cell
buck2 targets third-party//...
```

**Performance note**: Recursive patterns can be slow on large monorepos. Use target determination (tdutil) for changed targets instead.

**When to use recursion**:
- Quality checks across the repo: `buck2 test depot//buck/tests/...`
- Initial builds: `buck2 build //src/...`
- Target discovery: `buck2 targets //...`

**When to avoid recursion**:
- Incremental development (use `tdutil` instead)
- CI/CD (build only affected targets)
- Large monorepos (can timeout or OOM)

---

## Monorepo Cell Structure

This monorepo uses Buck2 cells to organize code logically:

### Cell Organization

| Cell | Purpose | Example Targets |
|------|---------|----------------|
| `root` (depot) | Main source code and projects | `//src/app:binary` |
| `cellar` | Bootstrap toolchain | `//rust:rustc` |
| `mode` | Build mode configurations | `@mode//debug`, `@mode//release` |
| `toolchains` | Language toolchains | `@toolchains//rust:toolchain` |
| `third-party` | External dependencies | `third-party//rust:serde` |

### Cross-Cell Dependencies

Targets can depend on targets from other cells:

```starlark
depot.rust_binary(
    name = "myapp",
    srcs = glob(["src/**/*.rs"]),
    deps = [
        ":lib",                           # Same package
        "//src/utils:helpers",            # Same cell (root)
        "third-party//rust:serde",        # Different cell
        "third-party//rust:tokio",
        "third-party//by-name/mi/mimalloc:rust",     # Custom allocator
    ],
)
```

**Cell boundaries and visibility**:
- Cells enforce visibility rules
- Cross-cell dependencies must be explicitly allowed
- Third-party cell is typically PUBLIC visibility
- Main cells may restrict visibility for internal targets

### The Shim System

**Critical**: All BUILD files in this monorepo automatically load `buck/shims/noprelude.bzl`, which **blocks** direct use of native Buck2 rules.

You MUST use the centralized shims:

```starlark
# Load shims (required in all BUILD files)
load("@root//buck/shims:shims.bzl", depot = "shims")

# ✓ Correct: Use depot.* wrappers
depot.rust_binary(name = "app", ...)
depot.cxx_library(name = "lib", ...)

# ✗ Blocked: Direct native rules fail
rust_binary(name = "app", ...)      # ERROR: Symbol not found
cxx_library(name = "lib", ...)       # ERROR: Symbol not found
```

The shim system provides:
- Consistent defaults (Rust edition 2024, optimized flags)
- Automatic environment variables (`DEPOT_VERSION`, `DEPOT_PACKAGE_VERSION`)
- Package-level metadata integration
- Build mode selection (debug/release)

**Why shims?** The shim system enforces consistency:
- All Rust targets use the same edition by default
- All C++ targets use the same optimization flags
- Environment variables are injected automatically
- Metadata from PACKAGE files propagates to all targets

### Package Metadata System

`PACKAGE` files define package-level metadata using `pkg.info()`:

```starlark
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", pkg = "pkg")

pkg.info(
    copyright = ["© 2024-2026 Austin Seipp"],
    license = "Apache-2.0",
    description = "My awesome project",
    version = "1.0.0",  # Must be semver
)
```

This metadata:
- Enforces SPDX headers in source files
- Provides version info to binaries (`DEPOT_PACKAGE_VERSION` env var)
- Enables OSV vulnerability tracking
- Controls default visibility and compatibility

**Metadata propagation**:
- `version` → `DEPOT_PACKAGE_VERSION` environment variable
- `license` → Enforced SPDX header checks
- `copyright` → Required in all source files
- `description` → Documentation generation

---

## Configuration System

Buck2's configuration system allows targets to adapt to different build contexts (platforms, modes, features).

### Build Modes

This monorepo uses build modes to control optimization levels:

```bash
# Debug build (default): fast compilation, debug symbols
buck2 build @mode//debug //src/app

# Release build: optimizations, no debug symbols
buck2 build @mode//release //src/app
```

Build modes are implemented as cell modifiers that affect configuration:
- `@mode//debug`: `-Cdebuginfo=2`, `-Copt-level=0`, incremental compilation enabled
- `@mode//release`: `-Copt-level=3`, `-Cdebuginfo=none`, LTO enabled

To read the current build mode in BUILD files:

```starlark
build_mode = read_choice("project", "buildmode", ["debug", "release"], "debug")

rustc_flags = select({
    "mode//:debug": ["-Cdebuginfo=2"],
    "mode//:release": ["-Copt-level=3", "-Clto=thin"],
})
```

**Build mode implications**:
- Debug: Fast iteration, large binaries, debuggable
- Release: Slow compilation, small binaries, optimized
- Different cache entries (debug and release don't share artifacts)

### Platform Selection with `select()`

`select()` enables platform-specific configuration:

```starlark
# Platform-specific dependencies
deps = [
    "third-party//rust:anyhow",
] + select({
    "toolchains//cfg/target:x86_64-linux": ["third-party//rust:native-linux"],
    "toolchains//cfg/target:aarch64-linux": ["third-party//rust:native-aarch64"],
    "DEFAULT": [],
})

# Platform-specific source files
srcs = glob(["src/common/**/*.rs"]) + select({
    "toolchains//cfg/target:x86_64-linux": glob(["src/x86_64/**/*.rs"]),
    "toolchains//cfg/target:aarch64-linux": glob(["src/aarch64/**/*.rs"]),
})

# Platform-specific compiler flags
cxx_flags = ["-Wall", "-Wextra"] + select({
    "toolchains//cfg/target:x86_64-linux": ["-march=x86-64-v3"],
    "toolchains//cfg/target:aarch64-linux": ["-march=armv8-a"],
})
```

### Constraint System

Buck2 uses a constraint system to model platforms and compatibility:

**Constraint Settings** (categories):
- `os`: linux, macos, windows
- `cpu`: x86_64, aarch64, arm
- `libc`: glibc, musl

**Constraint Values** (specific values):
- `os:linux`
- `cpu:x86_64`
- `libc:glibc`

**Platforms** (combinations of constraints):
- `x86_64-unknown-linux-gnu`: linux + x86_64 + glibc
- `aarch64-unknown-linux-gnu`: linux + aarch64 + glibc
- `x86_64-apple-darwin`: macos + x86_64

Targets can declare compatibility:

```starlark
depot.rust_binary(
    name = "linux-only-app",
    srcs = ["main.rs"],
    target_compatible_with = [
        "toolchains//cfg/target:linux",
    ],
)

depot.cxx_library(
    name = "x86-only",
    srcs = ["x86_intrinsics.cpp"],
    target_compatible_with = [
        "toolchains//cfg/target:x86_64",
    ],
)
```

Buck2 will skip incompatible targets during recursive builds:

```bash
# Skips linux-only-app on macOS
buck2 build //src/...
```

**Compatibility checking**:
- Happens during configuration phase
- Incompatible targets are skipped (not errors)
- Useful for platform-specific code in cross-platform repos
- Can be queried: `buck2 cquery "filter(compatible_with, //src/...)"`

### Conditional Compilation

Combine `select()` with feature flags for conditional compilation:

```starlark
# Enable experimental features conditionally
crate_features = select({
    "//config:experimental": ["experimental", "unstable"],
    "DEFAULT": [],
})

depot.rust_binary(
    name = "app",
    srcs = glob(["src/**/*.rs"]),
    crate_features = crate_features,
)

# Conditional dependencies
deps = [
    "third-party//rust:serde",
] + select({
    "//config:async": ["third-party//rust:tokio"],
    "DEFAULT": [],
})
```

**Feature flags**: Can be defined via:
- `.buckconfig` sections
- Command-line: `buck2 build //app --config=config.experimental=true`
- Mode cells: `@mode//release` implies certain flags

---

## Query System

Buck2's query system is a powerful tool for exploring the build graph. There are three query commands:

- `buck2 targets`: List targets (fast, simple)
- `buck2 uquery`: Query unconfigured target graph
- `buck2 cquery`: Query configured target graph

### Basic Queries

```bash
# List all targets in a package
buck2 targets //src/app:

# List all targets recursively
buck2 targets //src/...

# List targets matching a pattern
buck2 targets //src/... | grep test

# Count targets
buck2 targets //src/... | wc -l

# Show target names only
buck2 targets //src/... --output-format=simple
```

### Target Graph Queries (uquery/cquery)

#### Finding Dependencies

```bash
# Direct dependencies of a target
buck2 query "deps('//src/app:binary', 1)"

# All transitive dependencies
buck2 query "deps('//src/app:binary')"

# Dependencies from a specific cell
buck2 query "filter('third-party', deps('//src/app:binary'))"

# Only test dependencies
buck2 query "kind('.*_test', deps('//src/app:binary'))"

# Show dependency depth
buck2 query "deps('//src/app:binary', 3)"  # Up to depth 3
```

#### Reverse Dependencies

```bash
# What depends on this target?
buck2 query "rdeps('//src/...', '//src/utils:helpers')"

# Only direct reverse dependencies
buck2 query "rdeps('//src/...', '//src/utils:helpers', 1)"

# Find all tests depending on a library
buck2 query "kind('.*_test', rdeps('//src/...', '//src/utils:helpers'))"

# Impact analysis: what breaks if I change this?
buck2 query "rdeps('//...', '//src/core:lib')"
```

#### Filtering and Set Operations

```bash
# Union of two sets
buck2 query "deps('//app:a') + deps('//app:b')"

# Intersection (common dependencies)
buck2 query "deps('//app:a') ^ deps('//app:b')"

# Difference (in A but not B)
buck2 query "deps('//app:a') - deps('//app:b')"

# Filter by kind (type of rule)
buck2 query "kind('rust_binary', //src/...)"
buck2 query "kind('.*_test', //src/...)"  # All test targets

# Filter by attribute value
buck2 query "attrfilter(visibility, PUBLIC, //src/...)"
buck2 query "attrfilter(edition, 2024, //src/...)"  # Rust edition 2024

# Filter by name pattern
buck2 query "filter('.*binary$', //src/...)"  # Names ending in "binary"
```

---

## Advanced Query Patterns

### Complex Dependency Analysis

```bash
# Find all Rust binaries that depend on a specific library
buck2 query "kind('rust_binary', rdeps('//src/...', '//src/common:logging'))"

# Find unused targets (no reverse deps in src/)
buck2 query "//src/utils:all - rdeps('//src/...', '//src/utils:all')"

# Show dependency path between two targets
buck2 query "somepath('//src/app:binary', '//third-party/rust:serde')"
buck2 query "allpaths('//src/app:binary', '//third-party/rust:serde')"  # All paths

# Find common dependencies of two targets
buck2 query "deps('//app:a') ^ deps('//app:b')"

# Find divergence point in dependency graphs
buck2 query "(deps('//app:a') + deps('//app:b')) - (deps('//app:a') ^ deps('//app:b'))"
```

### Inspecting Target Attributes

```bash
# Show all attributes of a target
buck2 uquery '//src/app:binary' --output-attribute=.*

# Show specific attributes
buck2 uquery '//src/app:binary' --output-attribute=srcs
buck2 uquery '//src/app:binary' --output-attribute=deps
buck2 uquery '//src/app:binary' --output-attribute=visibility

# Show resolved attributes (after select())
buck2 cquery '//src/app:binary' --output-attribute=srcs
buck2 cquery '//src/app:binary' --output-attribute=rustc_flags

# Compare unconfigured vs configured
diff \
  <(buck2 uquery '//src/app:binary' --output-attribute=srcs) \
  <(buck2 cquery '//src/app:binary' --output-attribute=srcs)
```

### Set Operations and Filtering

```bash
# All Rust targets except tests (covers both configured runner rule kinds)
buck2 uquery "kind('rust_.*', //src/...) - kind('rust_test.*', //src/...)"

# Third-party dependencies not in stdlib
buck2 uquery "filter('third-party//rust:', deps('//src/...')) - filter('third-party//rust:std', deps('//src/...'))"

# Targets with visibility restrictions
buck2 uquery "attrfilter(visibility, '^(?!PUBLIC).*$', //src/...)"

# Find targets using specific features
buck2 uquery "attrfilter(crate_features, experimental, //src/...)" --output-attribute=crate_features
```

### Output Formats

```bash
# JSON output (useful for scripting)
buck2 cquery "deps('//src/app:binary')" --output-format=json | jq '.["//src/app:binary"]'

# DOT graph (for visualization)
buck2 cquery "deps('//src/app:binary')" --output-format=dot > graph.dot
dot -Tpng graph.dot -o graph.png

# Starlark (for copy-paste into BUILD files)
buck2 cquery "deps('//src/app:binary')" --output-format=starlark

# Simple list (just target names)
buck2 cquery "deps('//src/app:binary')"
```

### Practical Query Examples

#### Finding Circular Dependencies

```bash
# Buck2 forbids cycles, but you can find potential issues
buck2 cquery "allpaths('//src/app:lib', '//src/app:lib')"
# If this returns anything, you have a cycle
```

#### Impact Analysis

```bash
# What needs to rebuild if I change this library?
buck2 query "rdeps('//src/...', '//src/common:utils')"

# How many targets depend on third-party library X?
buck2 query "rdeps('//src/...', '//third-party/rust:serde')" | wc -l

# What tests will run if I change this file?
# (Use target determination for accurate results)
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" --universe depot//src/...
buck2 query "kind('.*_test', %Ss)" "@$TARGETS_FILE"
```

#### Dependency Audit

```bash
# Find all third-party dependencies used by src/
buck2 query "filter('third-party', deps('//src/...'))"

# Check if any src/ targets directly use deprecated library
buck2 query "rdeps('//src/...', '//third-party/rust:deprecated-crate', 1)"

# Find all targets using a specific allocator
buck2 query "attrfilter(deps, '.*mimalloc.*', //src/...)"

# List all test targets
buck2 query "kind('.*_test', //src/...)"

# Find binaries with specific features enabled
buck2 uquery "attrfilter(crate_features, 'async', //src/...)" --output-attribute=name
```

#### Build Graph Analysis

```bash
# Find leaf targets (no rdeps)
buck2 query "//src/... - rdeps('//src/...', '//src/...')"

# Find root targets (no deps outside own package)
buck2 query "filter('//src/app:.*', //src/app:) - rdeps('//src/app:...', filter('//src/(?!app).*', //src/...))"

# Find targets with most dependencies
buck2 query "deps('//src/...')" --output-format=json | \
  jq -r 'to_entries | map({target: .key, count: (.value | length)}) | sort_by(.count) | reverse | .[0:10]'

# Find targets depended on by most others
for target in $(buck2 targets //src/...); do
  echo "$target $(buck2 query "rdeps('//src/...', '$target')" | wc -l)"
done | sort -k2 -rn | head -10
```

#### Configuration Comparison

```bash
# Compare dependencies across platforms
diff \
  <(buck2 cquery "deps('//src/app:binary')" --target-platforms=//toolchains:x86_64-linux) \
  <(buck2 cquery "deps('//src/app:binary')" --target-platforms=//toolchains:aarch64-linux)

# See what changes between debug and release
diff \
  <(buck2 cquery "deps('//src/app:binary')" @mode//debug) \
  <(buck2 cquery "deps('//src/app:binary')" @mode//release)
```

---

## Common Commands and Workflows

### Building

```bash
# Build specific target
buck2 build //src/app:binary

# Build all targets in package
buck2 build //src/app:

# Build recursively
buck2 build //src/...

# Build with specific mode
buck2 build @mode//release //src/app:binary

# Show output paths
buck2 build //src/app:binary --show-output

# Build multiple targets
buck2 build //src/app:binary //src/tools:cli //src/lib:core

# Build and show all outputs
buck2 build //src/... --show-output --show-full-output

# Build with verbose output
buck2 build //src/app:binary -v 2

# Build without remote cache
buck2 build //src/app:binary --no-remote-cache
```

### Testing

```bash
# Run specific test
buck2 test //src/app:tests

# Run all tests in package
buck2 test //src/app:

# Run all tests recursively
buck2 test //src/...

# Pass arguments to test binary
buck2 test //src/app:tests -- --nocapture

# Run specific test by name (for Rust)
buck2 test //src/app:tests -- test_name

# Run tests matching pattern
buck2 test //src/app:tests -- --filter=integration

# Continue testing after failures
buck2 test //src/... --keep-going

# Show test output even on success
buck2 test //src/app:tests -v 2

# Run tests with environment variables
buck2 test //src/app:tests -- --test-threads=1

# Show only failed tests
buck2 test //src/... 2>&1 | grep -A 10 FAILED
```

### Local Resources Pattern

Buck2 provides a **local resources** pattern for tests that depend on external processes or services (databases, HTTP servers, message queues, Unix sockets, etc.). This pattern uses **broker processes** that Buck2 starts automatically before running tests and cleans up afterward.

#### Why Local Resources?

Traditional testing approaches for service-dependent tests have limitations:

**Problem scenarios**:
- Integration tests need a database instance
- Tests require an HTTP server to make requests against
- Tests communicate via Unix domain sockets
- Tests need message queues, cache servers, or other services

**Traditional solutions (and their problems)**:
- **System services**: Tests depend on system state (not hermetic)
- **Docker containers**: Heavyweight, slow, require Docker daemon
- **Manual setup scripts**: Easy to forget cleanup, leak processes
- **Test fixtures in code**: Can't parallelize, port conflicts

**Buck2's local resources solution**:
- Buck2 manages the lifecycle (start, provide connection info, cleanup)
- Each test gets isolated resource instances (parallel execution safe)
- Hermetic (no system dependencies beyond the broker script)
- Automatic cleanup (Buck2 kills broker processes after tests)
- Environment variables pass connection info from broker to test

#### Core Components

The local resources pattern has three parts:

**1. Broker Script**

A shell script (or binary) that:
- Starts the external service/process in the background
- Outputs JSON to stdout with process info and connection details
- Format: `{"pid": <process_id>, "resources": [{<key>: <value>, ...}]}`

Example broker script (`start-server.sh`):
```bash
#!/usr/bin/env bash
set -euo pipefail

# Start HTTP server on random available port
python3 -m http.server 0 &
SERVER_PID=$!

# Wait for server to start and get port
sleep 0.5
PORT=$(lsof -ti:8000 -sTCP:LISTEN | head -1)

# Output JSON with PID and connection info
echo "{\"pid\": $SERVER_PID, \"resources\": [{\"port\": \"$PORT\", \"url\": \"http://localhost:$PORT\"}]}"
```

**Key requirements**:
- Process MUST run in background (`&` in bash)
- Output MUST be valid JSON on stdout
- JSON MUST include `pid` (for Buck2 to track and kill)
- JSON MUST include `resources` array with connection details
- Resource keys become available as environment variables

**2. Broker Rule**

A Buck2 rule that wraps the broker script and provides `LocalResourceInfo`:

```starlark
# In defs.bzl
_http_broker = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args(ctx.attrs._script[DefaultInfo].default_outputs[0])),
        LocalResourceInfo(
            setup = cmd_args(ctx.attrs._script[DefaultInfo].default_outputs[0]),
            resource_env_vars = {
                "HTTP_PORT": "port",      # Map JSON "port" → $HTTP_PORT env var
                "HTTP_URL": "url",        # Map JSON "url" → $HTTP_URL env var
            },
        ),
    ],
    attrs = {
        "_script": attrs.default_only(attrs.exec_dep(default = "//pkg:start-server"))
    }
)
```

**`LocalResourceInfo` provider**:
- `setup`: Command to run (the broker script)
- `resource_env_vars`: Dict mapping environment variable names to JSON keys
  - Keys = environment variable names (what test sees)
  - Values = JSON keys from broker output (what broker provides)
  - Example: `{"HTTP_PORT": "port"}` means broker's `resources[0].port` → test's `$HTTP_PORT`

**3. Test Rule**

A Buck2 test that consumes the local resource:

```starlark
# In defs.bzl
_http_test = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args([ctx.attrs.script[DefaultInfo].default_outputs[0]])),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [cmd_args([ctx.attrs.script[DefaultInfo].default_outputs[0]])],
            local_resources = {
                'http': ctx.attrs.http_broker.label  # Name → broker target
            },
            required_local_resources = [
                RequiredTestLocalResource("http", listing = False, execution = True),
            ],
        ),
    ],
    attrs = {
        "script": attrs.source(),
        "http_broker": attrs.exec_dep(providers = [LocalResourceInfo]),
    }
)
```

**`ExternalRunnerTestInfo` provider**:
- `type`: Test type (usually `"custom"` for local resources)
- `command`: The test command to run
- `local_resources`: Dict mapping names to broker targets
  - Keys = resource names (arbitrary, for reference)
  - Values = broker target labels
- `required_local_resources`: List of `RequiredTestLocalResource`
  - First arg = resource name (must match key in `local_resources`)
  - `listing`: Whether resource needed during `buck2 targets` (usually `False`)
  - `execution`: Whether resource needed during test execution (usually `True`)

#### Complete Example: HTTP Server Test

Here's a complete working example:

**Broker script** (`http-broker.sh`):
```bash
#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

TMPDIR=${TMPDIR:-/tmp}
mkdir -p "$TMPDIR/http-test"
echo "Hello from HTTP server" > "$TMPDIR/http-test/index.html"

cd "$TMPDIR/http-test"
python3 -m http.server 8888 > /dev/null 2>&1 &
HTTP_PID=$!

# Give server time to start
sleep 0.5

echo "{\"pid\": $HTTP_PID, \"resources\": [{\"port\": \"8888\", \"url\": \"http://localhost:8888\"}]}"
```

**Test script** (`http-test.sh`):
```bash
#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Environment variables provided by broker via resource_env_vars
echo "Testing HTTP server at $HTTP_URL"

# Make request to server
RESPONSE=$(curl -s "$HTTP_URL/index.html")

if [[ "$RESPONSE" == "Hello from HTTP server" ]]; then
    echo "✓ HTTP test passed"
    exit 0
else
    echo "✗ HTTP test failed: unexpected response"
    echo "Expected: 'Hello from HTTP server'"
    echo "Got: '$RESPONSE'"
    exit 1
fi
```

**Buck2 rules** (`defs.bzl`):
```starlark
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Broker rule
_http_broker_rule = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args(ctx.attrs._script[DefaultInfo].default_outputs[0])),
        LocalResourceInfo(
            setup = cmd_args(ctx.attrs._script[DefaultInfo].default_outputs[0]),
            resource_env_vars = {
                "HTTP_PORT": "port",
                "HTTP_URL": "url",
            },
        ),
    ],
    attrs = {
        "_script": attrs.default_only(attrs.exec_dep(default = "//pkg:http-broker"))
    }
)

# Test rule
_http_test_rule = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args([ctx.attrs.script[DefaultInfo].default_outputs[0]])),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [cmd_args([ctx.attrs.script[DefaultInfo].default_outputs[0]])],
            local_resources = {
                'http': ctx.attrs.http_broker.label
            },
            required_local_resources = [
                RequiredTestLocalResource("http", listing = False, execution = True),
            ],
        ),
    ],
    attrs = {
        "script": attrs.source(),
        "http_broker": attrs.exec_dep(providers = [LocalResourceInfo]),
    }
)

exports = struct(
    http_broker = _http_broker_rule,
    http_test = _http_test_rule,
)
```

**BUILD file**:
```starlark
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(":defs.bzl", "exports")
load("@root//buck/shims:shims.bzl", depot = "shims")

# Export broker script
depot.export_file(
    name = "http-broker",
    src = "http-broker.sh",
)

# Create broker target
exports.http_broker(
    name = "http-broker-resource",
)

# Create test target
exports.http_test(
    name = "http-test",
    script = "http-test.sh",
    http_broker = ":http-broker-resource",
)
```

**Running the test**:
```bash
buck2 test //pkg:http-test
```

**What happens**:
1. Buck2 identifies that `http-test` needs the `http-broker-resource`
2. Buck2 runs `http-broker.sh`, which starts the HTTP server
3. Broker outputs JSON: `{"pid": 12345, "resources": [{"port": "8888", "url": "http://localhost:8888"}]}`
4. Buck2 parses JSON and sets environment variables based on `resource_env_vars`:
   - `HTTP_PORT=8888`
   - `HTTP_URL=http://localhost:8888`
5. Buck2 runs `http-test.sh` with these environment variables
6. Test script uses `$HTTP_URL` to make requests
7. After test completes, Buck2 kills process 12345 (automatic cleanup)

#### Multiple Resources Example

Tests can depend on multiple local resources simultaneously:

```starlark
_multi_resource_test = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args([ctx.attrs.script[DefaultInfo].default_outputs[0]])),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [cmd_args([ctx.attrs.script[DefaultInfo].default_outputs[0]])],
            local_resources = {
                'http': ctx.attrs.http_broker.label,
                'db': ctx.attrs.db_broker.label,
                'redis': ctx.attrs.redis_broker.label,
            },
            required_local_resources = [
                RequiredTestLocalResource("http", listing = False, execution = True),
                RequiredTestLocalResource("db", listing = False, execution = True),
                RequiredTestLocalResource("redis", listing = False, execution = True),
            ],
        ),
    ],
    attrs = {
        "script": attrs.source(),
        "http_broker": attrs.exec_dep(providers = [LocalResourceInfo]),
        "db_broker": attrs.exec_dep(providers = [LocalResourceInfo]),
        "redis_broker": attrs.exec_dep(providers = [LocalResourceInfo]),
    }
)
```

The test script will have access to all environment variables from all brokers:
```bash
# From http broker
echo "HTTP server at: $HTTP_URL"

# From db broker
echo "Database at: $DB_PATH"

# From redis broker
echo "Redis at: $REDIS_PORT"
```

#### Real-World Example: QEMU with TPM

The `qemu-static` package demonstrates a sophisticated use of local resources:

**Broker**: `buck/third-party/qemu-static/run-swtpm`
```bash
#!/usr/bin/env bash
set -euo pipefail

TMPDIR=${TMPDIR:-/tmp}
mkdir -p "$TMPDIR/swtpm"
swtpm socket --tpm2 \
    --tpmstate dir=$TMPDIR \
    --ctrl type=unixio,path=$TMPDIR/swtpm/socket \
    --log file=$TMPDIR/swtpm/log,level=20 > /dev/null &
TPM=$!

echo "{\"pid\": $TPM, \"resources\": [{\"socket_path\": \"$TMPDIR/swtpm/socket\"}]}"
```

**Broker rule**: `buck/third-party/qemu-static/defs.bzl`
```starlark
_swtpm_cmd = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args(ctx.attrs._script[DefaultInfo].default_outputs[0])),
        LocalResourceInfo(
            setup = cmd_args(ctx.attrs._script[DefaultInfo].default_outputs[0]),
            resource_env_vars = {
                "SWTPM_SOCKET": "socket_path"
            },
        ),
    ],
    attrs = {
        "_script": attrs.default_only(attrs.exec_dep(default = "third-party//by-name/qe/qemu-static:run-swtpm"))
    }
)
```

**Test (QEMU consuming the TPM)**: `buck/third-party/qemu-static/defs.bzl`
```starlark
_run_qemu_impl = lambda ctx: [
    DefaultInfo(),
    RunInfo(args = cmd_args(['/usr/bin/env', 'bash', '-c',
        cmd_args([
            'qemu-system-' + ctx.attrs.system,
            '-nographic',
            '-chardev', 'socket,id=swtpm,path="$SWTPM_SOCKET"',  # Uses env var
            '-tpmdev emulator,id=tpm0,chardev=swtpm',
            '-device', 'tpm-tis-device,tpmdev=tpm0',
        ] + ctx.attrs.args, delimiter = " ")
    ])),
    ExternalRunnerTestInfo(
        type = "custom",
        command = [cmd_args([...])],
        local_resources = {
            'swtpm': ctx.attrs.swtpm_broker.label
        },
        required_local_resources = [
            RequiredTestLocalResource("swtpm", listing = False, execution = True),
        ],
    ),
]
```

This allows QEMU tests to use a software TPM without system dependencies.

#### Common Patterns and Best Practices

**1. Use `$TMPDIR` for isolation**

Brokers should use temporary directories to avoid conflicts:
```bash
TMPDIR=${TMPDIR:-/tmp}
WORKDIR="$TMPDIR/my-service-$$"  # $$ = process ID for uniqueness
mkdir -p "$WORKDIR"
```

**2. Wait for services to be ready**

Services often need time to start. Add health checks:
```bash
# Start service
my_service &
PID=$!

# Wait for service to be ready
for i in {1..30}; do
    if lsof -ti:8000 >/dev/null 2>&1; then
        break
    fi
    sleep 0.1
done

echo "{\"pid\": $PID, ...}"
```

**3. Handle port allocation**

Use random/dynamic ports to avoid conflicts:
```bash
# Let OS assign random port
python3 -m http.server 0 &  # Port 0 = random available port
PID=$!

# Discover assigned port
sleep 0.2
PORT=$(lsof -ti -sTCP:LISTEN -a -p $PID)

echo "{\"pid\": $PID, \"resources\": [{\"port\": \"$PORT\"}]}"
```

**4. Use Unix sockets for simplicity**

Unix domain sockets avoid port conflicts entirely:
```bash
SOCKET="$TMPDIR/my-service.sock"
my_service --socket="$SOCKET" &
PID=$!

echo "{\"pid\": $PID, \"resources\": [{\"socket_path\": \"$SOCKET\"}]}"
```

**5. Cleanup is automatic**

Buck2 kills broker processes (by PID) after tests complete. No manual cleanup needed.

**6. Errors and debugging**

If a broker fails:
- Buck2 shows broker script output (stdout/stderr)
- Check broker script runs standalone: `bash broker.sh`
- Validate JSON output: `bash broker.sh | jq .`
- Ensure process backgrounds correctly (`&`)
- Check resource keys match `resource_env_vars`

**7. Parallel test execution**

Buck2 can run multiple tests in parallel. Each test gets its own broker instance, so resource isolation is critical:
- Use unique temp directories
- Use dynamic port allocation or Unix sockets
- Avoid hardcoded paths/ports

#### Troubleshooting

**"Resource not available"**

Cause: `local_resources` dict or `required_local_resources` list has mismatched names.

Fix: Ensure names match exactly:
```starlark
local_resources = {
    'myservice': ctx.attrs.broker.label,  # Name: 'myservice'
},
required_local_resources = [
    RequiredTestLocalResource("myservice", ...),  # Must match
],
```

**"Invalid JSON from broker"**

Cause: Broker script outputs malformed JSON or extra output.

Fix: Validate broker output:
```bash
bash broker.sh | jq .
```

Ensure ONLY JSON goes to stdout. Redirect logs to stderr or files:
```bash
my_service > /dev/null 2>&1 &  # Suppress service output
echo "{\"pid\": $!, ...}"  # Only JSON to stdout
```

**"Environment variable not set"**

Cause: Mismatch between JSON keys and `resource_env_vars`.

Fix: Check mapping:
- Broker outputs: `"resources": [{"my_key": "value"}]`
- Rule must map: `resource_env_vars = {"MY_ENV_VAR": "my_key"}`
- Test receives: `$MY_ENV_VAR=value`

**"Process already running"**

Cause: Previous test didn't clean up (Buck2 crashed or was killed).

Fix: Manually kill processes:
```bash
# Find processes
ps aux | grep my-service

# Kill them
pkill -f my-service
```

Prevent by ensuring broker uses unique temp directories.

**"Port already in use"**

Cause: Hardcoded ports conflict between parallel tests.

Fix: Use dynamic port allocation (port 0) or Unix sockets.

#### When to Use Local Resources

**Good use cases**:
- Integration tests needing databases (SQLite, PostgreSQL, Redis)
- HTTP/REST API testing (start server, make requests)
- Message queue testing (Kafka, RabbitMQ, NATS)
- Unix socket communication testing
- Service orchestration testing (multiple services interacting)
- Tests requiring external processes (compilers, interpreters, tools)

**Bad use cases**:
- Simple unit tests (no external dependencies needed)
- Tests that can use in-memory alternatives (use in-memory DB instead of PostgreSQL)
- Heavy services (avoid Docker-in-Docker or VMs; too slow)
- System-dependent services (breaks hermeticity)

**Alternatives**:
- **Unit tests**: Test logic without external services
- **Mocking**: Use test doubles instead of real services
- **In-memory**: Use in-memory databases/queues when possible
- **Command tests**: Use `depot.command_test()` for simple command execution

#### Summary

The local resources pattern enables hermetic, parallelizable integration tests by having Buck2 manage service lifecycles. Key points:

1. **Broker script**: Starts service, outputs JSON with PID and connection info
2. **Broker rule**: Wraps script with `LocalResourceInfo`, maps JSON → env vars
3. **Test rule**: Uses `ExternalRunnerTestInfo` to declare resource dependencies
4. **Execution**: Buck2 starts brokers, sets env vars, runs tests, cleans up
5. **Isolation**: Each test gets its own broker instance (parallel-safe)
6. **Hermeticity**: No system dependencies, reproducible, cacheable

For examples, see:
- `buck/third-party/qemu-static/` - QEMU with TPM emulator
- `buck/tests/local-resources/` - Example tests (HTTP, sockets, multi-resource)

### Running Binaries

```bash
# Run a binary target
buck2 run //src/app:binary

# Pass arguments to binary
buck2 run //src/app:binary -- --config=dev.toml --verbose

# Run with specific build mode
buck2 run @mode//release //src/app:binary -- --benchmark

# Run and capture output
buck2 run //src/app:binary -- --help > help.txt

# Run with environment variables
ENV_VAR=value buck2 run //src/app:binary
```

### Querying and Inspection

```bash
# List all targets
buck2 targets //src/...

# Show dependencies
buck2 query "deps('//src/app:binary')"

# Show reverse dependencies
buck2 query "rdeps('//src/...', '//src/lib:core')"

# Inspect target attributes
buck2 uquery '//src/app:binary' --output-attribute=.*

# Show cell configuration
buck2 audit cell

# Show Buck2 configuration
buck2 audit config

# Show toolchain providers
buck2 audit providers //toolchains/rust:toolchain

# Show action cache statistics
buck2 audit cache-stats

# Explain why target needs rebuilding
buck2 explain //src/app:binary
```

### At-File Syntax for Large Target Lists

The `buck2` CLI supports **at-file syntax** where `@path/to/file` expands to the contents of the file, one argument per line:

```bash
# Create file with targets
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/buck-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
echo "//src/app:binary" > "$TARGETS_FILE"
echo "//src/tools:cli" >> "$TARGETS_FILE"

# Build all targets in file
buck2 build "@$TARGETS_FILE"

# Combine with command output
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' depot//src/... > "$TARGETS_FILE"
buck2 test "@$TARGETS_FILE"
```

**Use case**: `tdutil` writes targets to stdout by default. Use `--output` when
you want an at-file for a later Buck2 command:

```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT

# Find changed targets
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" '@-' '@' depot//src/...

# Build only changed targets
buck2 build "@$TARGETS_FILE"

# Test only affected tests
buck2 test "@$TARGETS_FILE"
```

**Important**: At-file syntax is essential when target lists exceed command-line length limits (which can happen in large monorepos).

The default `text` format is one target per line. `--format json` emits one
metadata object, and `--format json-lines` emits machine-readable records.

### Target Determination (tdutil)

The `tdutil` tool analyzes jj revisions and determines which Buck2 targets are affected by changes:

```bash
# Compare @ with its fork point with trunk()
buck2 run root//buck/tools/tdutil:tdutil

# Use the same default revisions over only src/
buck2 run root//buck/tools/tdutil:tdutil -- depot//src/...

# Compare working copy with trunk
buck2 run root//buck/tools/tdutil:tdutil -- \
  --from 'trunk()' --to '@' --universe depot//src/...

# Full repository scan
buck2 run root//buck/tools/tdutil:tdutil -- --from 'root()' --to '@'

# Specific subdirectory only
buck2 run root//buck/tools/tdutil:tdutil -- depot//src/myproject/...
```

**Note**: Always use the `root//` cell prefix with tdutil to avoid ambiguous cell references.

Typical workflow:

```bash
# Make changes
jj new -m "feat: implement feature"
# ... edit files ...

# Test affected targets
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" --universe depot//src/...
buck2 test "@$TARGETS_FILE"

# If tests pass, commit
jj commit -m "feat: implement feature"
```

**How tdutil works**:
1. Computes file changes between two jj revisions
2. Builds Buck2 target graph at both revisions
3. Identifies targets whose BUILD files or sources changed
4. Compares hashes, inputs, packages, and transitive rule imports, then walks reverse dependencies
5. Outputs sorted affected targets to stdout or `--output`
6. You can use at-file syntax to build/test only those targets

---

## Debugging and Troubleshooting

### Build Failures

When a build fails, Buck2 shows the failing action and command:

```bash
# Build with verbose output
buck2 build //src/app:binary -v 2

# Show what commands ran
buck2 log what-ran

# Show only failed commands
buck2 log what-failed

# Show command details for specific target
buck2 explain //src/app:binary

# Show build timeline
buck2 log show-build-time

# Show slowest actions
buck2 log what-ran --sort=duration | head -20
```

#### Reading Build Errors

Buck2 error messages typically include:

1. **Target** that failed: `//src/app:binary (release)`
2. **Action** that failed: `rustc compile src/main.rs`
3. **Command** that ran: Full compiler invocation
4. **Output**: Compiler error messages

Example:

```
Error: Build failure for //src/app:binary (release)

Action: rustc compile src/main.rs
Command: /path/to/rustc --crate-type bin src/main.rs -o binary

Stderr:
error[E0425]: cannot find value `foo` in this scope
 --> src/main.rs:10:5
  |
10|     foo();
  |     ^^^ not found in this scope
```

**How to debug**:
1. Read the actual error message (not Buck2's wrapper)
2. Check the exact command that ran (`buck2 log what-ran`)
3. Try running the command manually to isolate Buck2 vs compiler issues
4. Verify inputs exist and are correct
5. Check for typos in BUILD files

### Cache Issues

Buck2 uses content-addressed caching. Cache issues are rare but can occur:

```bash
# Clean local cache
rm -rf buck-out/

# Force rebuild without cache
buck2 build //src/app:binary --no-remote-cache

# Show cache statistics
buck2 audit cache-stats

# Clear action cache
buck2 clean

# Verify cache integrity
buck2 audit cache-stats --verify
```

**Note**: If you see "cache corruption" errors, cleaning `buck-out/` usually resolves them.

**Common cache issues**:
- **Corrupt cache entries**: Clean `buck-out/`
- **Clock skew**: Ensure system time is correct
- **Non-hermetic builds**: Check for system dependencies
- **Hash collisions**: Extremely rare, report if suspected

### Debugging Target Configuration

When targets behave unexpectedly, check their resolved configuration:

```bash
# Show unconfigured target (with select() expressions)
buck2 uquery '//src/app:binary' --output-attribute=.*

# Show configured target (after select() resolution)
buck2 cquery '//src/app:binary' --output-attribute=.*

# Compare differences
buck2 uquery '//src/app:binary' --output-attribute=srcs
buck2 cquery '//src/app:binary' --output-attribute=srcs

# Check platform configuration
buck2 cquery '//src/app:binary' --output-attribute=target_compatible_with

# See exact compiler flags
buck2 cquery '//src/app:binary' --output-attribute=rustc_flags
```

### Debugging Dependency Issues

```bash
# Show full dependency tree
buck2 query "deps('//src/app:binary')" --output-format=dot > deps.dot
dot -Tpng deps.dot -o deps.png

# Find why target X depends on target Y
buck2 query "somepath('//src/app:binary', '//third-party/rust:unwanted-dep')"

# Check if dependency is direct or transitive
buck2 query "deps('//src/app:binary', 1)" | grep unwanted-dep

# Show all paths between two targets
buck2 query "allpaths('//src/app:binary', '//third-party/rust:serde')"

# Find who introduced a transitive dependency
for target in $(buck2 query "deps('//src/app:binary', 1)"); do
  if buck2 query "deps('$target')" | grep -q unwanted-dep; then
    echo "$target depends on unwanted-dep"
  fi
done
```

### Visibility Errors

If you get "target is not visible" errors:

```bash
# Check target's visibility
buck2 uquery '//src/lib:internal' --output-attribute=visibility

# See what targets can access it
buck2 query "attrfilter(visibility, PUBLIC, //src/lib:)"

# Check within_view restrictions
buck2 uquery '//src/lib:internal' --output-attribute=within_view
```

Fix by updating `visibility` in BUILD file:

```starlark
depot.rust_library(
    name = "internal",
    srcs = ["internal.rs"],
    visibility = [
        "//src/app:binary",  # Only this target can use it
    ],
    # Or make it public:
    # visibility = ["PUBLIC"],
)
```

**Visibility patterns**:
- `["PUBLIC"]`: Anyone can depend on this
- `[]`: Only same package (default)
- `["//src/app:"]`: Only targets in //src/app package
- `["//src/..."]`: Only targets under //src recursively

### Performance Debugging

```bash
# Profile build performance
buck2 build //src/app:binary --profile

# Show build timeline (Chrome trace format)
buck2 build //src/app:binary --profile=trace
# Open chrome://tracing and load trace.json

# Show slow actions
buck2 log what-ran --sort=duration

# Count cache hits/misses
buck2 audit cache-stats

# Show critical path
buck2 log critical-path

# Analyze parallel efficiency
buck2 log show-build-time --show-slowest-targets
```

### Common Error Patterns

#### "No such file or directory"

Usually caused by:
- `glob()` not matching files (check patterns)
- Files not committed to jj (Buck2 only sees committed files)
- Incorrect paths in `srcs` or `deps`
- Generated files not declared as deps

Fix: Verify files exist and are tracked by jj:
```bash
jj status  # Check uncommitted files
jj diff    # Verify file contents
```

#### "Cycle in dependency graph"

Buck2 forbids circular dependencies. Example:

```
//src/app:binary → //src/lib:core → //src/app:helpers → //src/app:binary
```

Fix: Refactor to break the cycle (extract shared code to new target).

**How to debug cycles**:
```bash
# Find the cycle
buck2 query "allpaths('//src/app:binary', '//src/app:binary')"

# Visualize the cycle
buck2 query "allpaths('//src/app:binary', '//src/app:binary')" --output-format=dot | \
  dot -Tpng -o cycle.png
```

#### "Could not find cell"

Cell reference is incorrect or cell not defined in `.buckconfig`.

Fix: Check `.buckconfig` and use correct cell name:
```bash
buck2 audit cell  # List all cells
```

#### "Target is not visible to //src/app:binary"

The target you're trying to depend on has restricted visibility.

Fix options:
1. Add your target to the dependency's `visibility` list
2. Make the dependency `PUBLIC` if appropriate
3. Restructure to avoid the dependency

#### "Starlark evaluation error"

Syntax error or undefined symbol in BUILD file.

Common causes:
- Typo in target name or attribute
- Missing `load()` statement
- Undefined variable
- Invalid Starlark syntax

Fix: Read error message carefully, check BUILD file syntax.

---

## Performance and Caching

Buck2's performance comes from aggressive caching and parallelization. Understanding how it works helps optimize builds.

### Caching Levels

Buck2 caches at multiple levels:

1. **Action cache** (local): Stores outputs of individual actions (compile, link)
2. **Target cache** (local): Stores final target outputs
3. **Remote cache** (optional): Shared cache across machines/CI
4. **Remote execution** (optional): Offload actions to remote workers

**Cache hierarchy**:
```
Local action cache → Local target cache → Remote cache → Execute action
```

Each level is checked before falling back to the next. Cache hits skip all downstream levels.

### Content-Addressed Artifacts

Every artifact is identified by a SHA256 hash of:
- Input files (sources, dependencies)
- Build command (compiler, flags)
- Toolchain (compiler version, system libraries)
- Environment variables (if declared)

If any input changes, the hash changes, and Buck2 rebuilds. If hash matches, Buck2 reuses cached artifact.

**Hash calculation**:
```
action_hash = SHA256(
  source_files_content +
  dependency_hashes +
  compiler_path +
  compiler_flags +
  environment_vars
)
```

**Implications**:
- Changing a comment doesn't change the hash (if compiler strips it)
- Changing whitespace might change the hash (depends on language)
- Changing compiler version always changes the hash
- Hermetic builds ensure consistent hashes

### Incremental Builds

Buck2 rebuilds only what's necessary:

```
Change src/lib.rs
→ Recompile src/lib.rs → lib.rlib
→ Relink binary (depends on lib.rlib)
→ Skip unaffected targets
```

**Example**:
```
Repository with 1000 targets
Change one source file
Buck2 rebuilds: 1 compile action + 1 link action = 2 actions
(Not 1000 targets!)
```

**Best practices for incremental builds**:
- Keep libraries small and focused (better granularity)
- Avoid unnecessary dependencies (less rebuilding)
- Use `visibility` to prevent accidental deps (catches issues early)
- Minimize header changes in C++ (use forward declarations)

### Parallelization

Buck2 automatically parallelizes:
- Independent actions run concurrently
- Bounded by CPU cores (`-j` flag, defaults to ncpu)
- Respects action dependencies (compile before link)

```bash
# Use 8 parallel jobs
buck2 build //src/... -j 8

# Use all available cores (default)
buck2 build //src/...

# Limit parallelism (useful for memory-constrained systems)
buck2 build //src/... -j 2
```

**Parallelization efficiency**:
- Best case: Linear speedup with core count
- Typical: Sub-linear due to dependencies and I/O
- Worst case: Serialized by long critical path

**Critical path**: The longest chain of dependent actions. Reducing critical path length improves parallel efficiency:
```bash
# Show critical path
buck2 log critical-path
```

### Cache Statistics

```bash
# Show cache hit rate
buck2 audit cache-stats

# Example output:
# Local cache hits: 1234
# Local cache misses: 56
# Hit rate: 95.6%
# Cache size: 2.3 GB
```

High hit rate (>90%) indicates good caching. Low hit rate suggests:
- Frequent changes to dependencies
- Non-hermetic builds (system dependencies changing)
- Cache cleared recently
- Large-scale refactoring

**Monitoring cache health**:
- Check hit rate regularly
- Watch cache size growth
- Identify frequently rebuilt targets
- Investigate low hit rates

### Performance Tips

**1. Use hermetic toolchains**

System toolchains (gcc, clang from PATH) can cause cache misses if system state changes. Hermetic toolchains (bundled compilers) ensure consistent hashes.

```starlark
# Bad: System toolchain (hash includes system state)
system_rust_toolchain(name = "rust")

# Good: Hermetic toolchain (hash is stable)
rust_toolchain(
    name = "rust",
    compiler = ":rustc-binary",  # Bundled compiler
)
```

**2. Minimize dependencies**

Fewer dependencies = less rebuilding when dependencies change:

```starlark
# Bad: depends on entire utility library
deps = ["//src/utils:all"]

# Good: depend only on what you use
deps = ["//src/utils:logging", "//src/utils:parsing"]
```

**3. Use `select()` wisely**

`select()` can avoid compiling unused code:

```starlark
# Only compile platform-specific code for current platform
srcs = glob(["src/common/**/*.rs"]) + select({
    "toolchains//cfg/target:x86_64-linux": glob(["src/x86_64/**/*.rs"]),
    "toolchains//cfg/target:aarch64-linux": glob(["src/aarch64/**/*.rs"]),
})
```

This ensures x86_64 code isn't compiled on aarch64 systems, reducing build time.

**4. At-file syntax for large builds**

Use at-file syntax when building many targets (avoids command-line length limits and speeds up Buck2 initialization):

```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/buck-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
printf '%s\n' //a:1 //a:2 //a:3 //z:1000 > "$TARGETS_FILE"

# Slow: Buck2 parses all targets as CLI args
buck2 build //a:1 //a:2 //a:3 ... //z:1000

# Fast: Buck2 reads from file
buck2 build "@$TARGETS_FILE"
```

**5. Target determination**

Only build/test affected targets:

```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" '@-' '@' depot//src/...
buck2 test "@$TARGETS_FILE"
```

This can reduce build times by 10-100x on incremental changes.

**6. Remote caching (if available)**

Remote caches dramatically speed up CI and clean builds:

```bash
# Enable remote cache (if configured)
buck2 build //src/... --remote-cache=enabled
```

**Benefits**:
- Share cache across team members
- CI builds can use local developer caches
- Clean builds become incremental

**7. Profile and optimize**

Identify bottlenecks:

```bash
# Profile a build
buck2 build //src/... --profile=trace

# Open chrome://tracing and load trace
# Look for:
# - Long-running actions (optimize or parallelize)
# - Serialized dependencies (refactor to reduce coupling)
# - Cache misses (investigate why)
```

**8. Keep libraries focused**

Smaller libraries = better caching granularity:

```starlark
# Bad: One giant library
depot.rust_library(
    name = "utils",
    srcs = glob(["src/**/*.rs"]),  # 100 files
)

# Good: Multiple focused libraries
depot.rust_library(
    name = "logging",
    srcs = glob(["src/logging/**/*.rs"]),
)

depot.rust_library(
    name = "parsing",
    srcs = glob(["src/parsing/**/*.rs"]),
)
```

If you change one logging file, only `logging` rebuilds, not all 100 files.

---

## Best Practices

### BUILD File Organization

**Keep BUILD files simple and declarative**:

```starlark
# SPDX headers at top
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Load statements
load("@root//buck/shims:shims.bzl", depot = "shims")

# Constants (for reuse)
COMMON_DEPS = [
    "third-party//rust:anyhow",
    "third-party//rust:clap",
]

# Targets (organized logically)
depot.rust_library(name = "lib", ...)
depot.rust_binary(name = "binary", ...)
depot.rust_test(name = "tests", ...)
```

**Group related constants**:

```starlark
# Dependencies
COMMON_DEPS = [
    "third-party//rust:anyhow",
    "third-party//rust:serde",
]
TEST_DEPS = [
    "third-party//rust:insta",
    "third-party//rust:proptest",
] + COMMON_DEPS

# Compiler flags
COMMON_FLAGS = ["-Wall", "-Wextra"]
DEBUG_FLAGS = COMMON_FLAGS + ["-g"]
RELEASE_FLAGS = COMMON_FLAGS + ["-O3"]

# Tests
ALL_TESTS = [
    ":unit-tests",
    ":integration-tests",
]
```

### Dependency Management

**1. Explicit dependencies**

Always list direct dependencies explicitly:

```starlark
# ✓ Good: explicit
deps = [
    "third-party//rust:serde",
    "third-party//rust:anyhow",
]

# ✗ Bad: relying on transitive deps
deps = [
    "third-party//rust:big-crate",  # Don't assume it pulls in serde
]
```

**Why?** Transitive dependencies can change:
- Library authors remove dependencies
- Versions change and drop features
- Explicit deps make BUILD files self-documenting

**2. Minimal dependencies**

Depend only on what you use:

```starlark
# ✓ Good: minimal
deps = ["//src/utils:logging"]

# ✗ Bad: over-broad
deps = ["//src/utils:"]  # All targets in package
```

**Why?** Over-broad dependencies:
- Increase build times (more to rebuild)
- Hide actual dependencies (hard to refactor)
- Cause unnecessary cache invalidation

**3. Visibility control**

Use `visibility` to prevent accidental dependencies:

```starlark
# Internal library (only app can use it)
depot.rust_library(
    name = "internal",
    srcs = ["internal.rs"],
    visibility = ["//src/app:binary"],
)

# Public library (anyone can use)
depot.rust_library(
    name = "public",
    srcs = ["public.rs"],
    visibility = ["PUBLIC"],
)

# Package-private (default, only same package)
depot.rust_library(
    name = "private",
    srcs = ["private.rs"],
    # visibility = [],  # Default
)
```

**Visibility patterns**:
- Start restrictive, expand as needed
- Use `["PUBLIC"]` sparingly (hard to restrict later)
- Document why targets are PUBLIC
- Use visibility to enforce architecture boundaries

### Testing Patterns

**Co-locate tests with code**:

```starlark
depot.rust_library(
    name = "lib",
    srcs = glob(["src/**/*.rs"]),
)

depot.rust_test(
    name = "tests",
    srcs = glob(["src/**/*.rs", "tests/**/*.rs"]),
    deps = [
        ":lib",
        "third-party//rust:insta",
    ],
)
```

**Register tests with targets**:

```starlark
depot.rust_binary(
    name = "app",
    srcs = ["main.rs"],
    deps = [":lib"],
    tests = [":tests"],  # Associated tests
)
```

**Separate test types**:

```starlark
# Unit tests (fast, isolated)
depot.rust_test(
    name = "unit-tests",
    srcs = glob(["src/**/*.rs"]),
    deps = [":lib"],
)

# Integration tests (slower, comprehensive)
depot.rust_test(
    name = "integration-tests",
    srcs = glob(["tests/**/*.rs"]),
    deps = [":lib", "third-party//rust:tempfile"],
)

# Benchmark tests (performance)
depot.rust_test(
    name = "benchmarks",
    srcs = glob(["benches/**/*.rs"]),
    deps = [":lib", "third-party//rust:criterion"],
)
```

### Common Patterns

**Multiple binaries from one library**:

```starlark
depot.rust_library(
    name = "lib",
    srcs = glob(["src/lib/**/*.rs"]),
)

[
    depot.rust_binary(
        name = bin.removesuffix(".rs"),
        srcs = [bin],
        deps = [":lib"],
    )
    for bin in glob(["src/bin/*.rs"])
]
```

**Conditional features**:

```starlark
features = [] + (["experimental"] if read_choice("myapp", "experimental") else [])

depot.rust_binary(
    name = "app",
    srcs = glob(["src/**/*.rs"]),
    crate_features = features,
)
```

**Platform-specific code**:

```starlark
srcs = glob(["src/common/**/*.rs"]) + select({
    "toolchains//cfg/target:linux": glob(["src/linux/**/*.rs"]),
    "toolchains//cfg/target:macos": glob(["src/macos/**/*.rs"]),
    "DEFAULT": [],
})
```

**Shared test utilities**:

```starlark
depot.rust_library(
    name = "test-utils",
    srcs = glob(["test_utils/**/*.rs"]),
    deps = [
        "third-party//rust:tempfile",
        "third-party//rust:proptest",
    ],
    visibility = ["//src/..."],  # Available to all tests
)

depot.rust_test(
    name = "tests",
    srcs = glob(["tests/**/*.rs"]),
    deps = [":lib", ":test-utils"],
)
```

### SPDX Headers

**All source files** in this monorepo must include SPDX headers:

```rust
// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
```

The syntax varies by language:
- Rust/C/C++/Java: `//` comments
- Python/Bash/Starlark: `#` comments
- OCaml: `(* *)` comments

This is enforced by `PACKAGE` file metadata and quality tests.

**Why SPDX?**
- Legal compliance (copyright and license clear)
- Automated license scanning
- OSV vulnerability tracking
- Supply chain security

### Glob Best Practices

**Do**:
- Use `glob()` for source files: `srcs = glob(["src/**/*.rs"])`
- Exclude test files from libraries: `exclude = ["**/*_test.rs"]`
- Use multiple patterns: `glob(["*.rs", "*.toml"])`
- Be specific to avoid surprises: `glob(["src/core/*.rs"])` not `glob(["src/**/*.rs"])`

**Don't**:
- Glob across package boundaries (use explicit deps)
- Glob in `deps` (always explicit)
- Use `glob()` for generated files (use explicit paths)
- Assume `glob()` sees uncommitted files (it doesn't)

**Common patterns**:

```starlark
# All Rust sources except tests
srcs = glob(["src/**/*.rs"], exclude = ["src/**/*_test.rs"])

# Multiple subdirectories
srcs = glob([
    "src/core/**/*.rs",
    "src/utils/**/*.rs",
    "src/api/**/*.rs",
])

# Include non-Rust files
data = glob(["data/**/*.json", "data/**/*.toml"])
```

### Code Organization

**Package structure**:

```
src/myproject/
├── BUILD              # Main targets
├── PACKAGE            # Metadata
├── src/               # Source code
│   ├── lib.rs        # Library root
│   ├── main.rs       # Binary root
│   └── modules/      # Submodules
├── tests/             # Integration tests
│   └── integration.rs
└── benches/           # Benchmarks
    └── bench.rs
```

**Target naming**:
- Default target: Same name as package (`:myproject`)
- Binaries: Descriptive names (`:cli`, `:server`)
- Libraries: Often just `:lib`
- Tests: `:tests`, `:unit-tests`, `:integration-tests`

**Dependency layers**:

```
Binaries (src/bin/)
    ↓
Main library (src/lib.rs)
    ↓
Internal modules (src/*/lib.rs)
    ↓
Third-party dependencies
```

---

## Integration with jj Workflows

Buck2 and jj (Jujutsu) work seamlessly together. Common patterns:

### Development Workflow

```bash
# Start new work
jj new trunk() -m "feat: implement feature"

# Make changes, build/test iteratively
buck2 build //src/app:binary
buck2 test //src/app:

# Test affected targets before committing
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" '@-' '@' depot//src/...
buck2 test "@$TARGETS_FILE"

# Commit if tests pass
jj commit -m "feat: implement feature"
```

### Target Determination with jj Revsets

The `tdutil` tool uses jj revsets to determine changed targets:

```bash
# Compare two revisions
buck2 run root//buck/tools/tdutil:tdutil -- \
  --from 'REV1' --to 'REV2' --universe depot//src/...

# Common patterns:
# - Current vs parent: '@-' '@'
# - Working copy vs trunk: 'trunk()' '@'
# - Entire history: 'root()' '@'
# - Between specific commits: 'abc123' 'def456'
# - Last 3 commits: '@---' '@'
```

**Advanced revset patterns**:

```bash
# All changes in current branch
buck2 run root//buck/tools/tdutil:tdutil -- 'trunk()' '@' depot//src/...

# Changes in specific commit
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' depot//src/...

# All uncommitted changes
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' depot//src/...

# Changes across multiple commits
buck2 run root//buck/tools/tdutil:tdutil -- '@----' '@' depot//src/...
```

### Pre-commit Checks

Run quality checks before committing:

```bash
# Test Buck2 system quality
buck2 test depot//buck/tests/...

# Test affected targets
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" '@-' '@' depot//src/...
buck2 test "@$TARGETS_FILE"

# Build affected targets to catch compile errors
buck2 build "@$TARGETS_FILE"
```

**Automated pre-commit workflow**:

```bash
#!/bin/bash
# save as .git/hooks/pre-commit (if using colocated git)

set -e

echo "Running pre-commit checks..."

# Determine affected targets
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" '@-' '@' depot//src/...

# Build affected targets
echo "Building affected targets..."
buck2 build "@$TARGETS_FILE"

# Test affected targets
echo "Testing affected targets..."
buck2 test "@$TARGETS_FILE"

# Run quality checks
echo "Running quality checks..."
buck2 test depot//buck/tests/...

echo "All checks passed!"
```

### Working with jj Workspaces

jj workspaces allow parallel development:

```bash
# Create workspace for feature development
jj workspace add ../feature-workspace -r trunk()

# In feature workspace
cd ../feature-workspace
jj new -m "feat: new feature"

# Build in feature workspace
buck2 build //src/app:binary

# Test changes
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" 'trunk()' '@' depot//src/...
buck2 test "@$TARGETS_FILE"

# Changes in feature workspace don't affect main workspace
cd ../main-workspace
buck2 build //src/app:binary  # Still builds trunk version
```

**Use cases**:
- Long-running feature development
- Testing multiple approaches in parallel
- Running builds while working on other changes
- Isolating experimental work

See `$ROOT/a/work/README.md` for more on jj workspaces.

---

## Additional Resources

- **Official Buck2 Documentation**: https://buck2.build/docs/
- **Buck2 GitHub**: https://github.com/facebook/buck2
- **Buck2 Prelude**: https://github.com/facebook/buck2-prelude
- **Starlark Language**: https://github.com/bazelbuild/starlark
- **Reindeer (Rust/Cargo integration)**: https://github.com/facebookincubator/reindeer
- **Tweag Buck2 Tour**: https://www.tweag.io/blog/2023-07-06-buck2/
- **Tweag Buck2 Codelab**: https://github.com/tweag/buck2_codelab

For monorepo-specific workflows, see:
- `$ROOT/a/CLAUDE.md` - Development workflows and commit patterns
- `$ROOT/a/docs/jj.md` - Jujutsu version control reference
- `$ROOT/a/work/README.md` - Using jj workspaces for parallel development

---

## Summary

Buck2 is a powerful, hermetic build system designed for large-scale multi-language monorepos. Key takeaways:

**Core strengths**:
- Hermetic, reproducible builds
- Fine-grained caching and incrementality
- Parallel execution
- Multi-language support
- Powerful query system

**This monorepo's patterns**:
- Use `depot.*` shims, never native rules
- SPDX headers in all files
- Target determination with `tdutil`
- Build modes: `@mode//debug`, `@mode//release`
- Cells: `root//`, `third-party//`, `toolchains//`, etc.

**Common commands**:
```bash
buck2 build //src/app:binary
buck2 test //src/...
buck2 run //src/app:binary -- args
buck2 query "deps('//src/app:binary')"
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" '@-' '@' depot//src/...
buck2 test "@$TARGETS_FILE"
```

**Performance tips**:
- Use hermetic toolchains for consistent caching
- Minimize dependencies for faster incremental builds
- Use `select()` to avoid compiling unused code
- Leverage target determination for incremental workflows
- Profile slow builds with `--profile=trace`

**Best practices**:
- Keep BUILD files simple and declarative
- Always use explicit dependencies
- Control visibility to enforce boundaries
- Co-locate tests with code
- Use SPDX headers in all files
