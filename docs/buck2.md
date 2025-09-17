Buck2 is a large-scale multi-language build system. This monorepo has many programming languages, so a multi-language build tool is invaluable. It's very Bazel-like in most ways and many of the same ideas apply.

#### Targets/packages/cells

Buck2 builds **targets**, that exists in **packages**, which are part of a **cell**. Targets are defined in `BUILD` files and a single `BUILD` file may have many targets defined within. Targets may have dependencies on other targets, and so all targets collectively form a directed acyclic graph (DAG) of dependencies, which we call the **target graph**. The most explicit syntax for referring to a target is the following:

```text
cell//path/to/package:target-name
```

Cells are defined by a mapping of a short name to a directory in the code repository. All cells are defined in the top-level @.buckconfig file. A package is a subdirectory (possibly with multiple components) underneath the cell that contains BUILD and PACKAGE files. A target is a buildable unit of code, like a binary or a library, named in the `BUILD` file inside a package.

`buck2 build` requires at least one target name, like the one above. The above is an example of a "fully qualified target name" (FQTN) which is an unambiguous reference. An FQTN works anywhere in the source code tree, in BUILD files or anywhere else, so you can build, test, or refer to a a component no matter where you are in the repo. So, given a cell named `foobar//` located underneath `code/foobar`, and a package `bar/baz` in that cell, leads to a file

```text
code/foobar/bar/baz/BUILD
```

Which contains the targets that can be built. There are several shorthands for a target:

- `cell//src/project:target` - FQTN referring to an exact cell, package, and target
- `//src/project:target` - Specific target; cell defaults to the cell the package is in
- `//src/project:` - All targets in a given package; refers to multiple things
- `//src/project` - Shorthand for `//src/project:project`, i.e. the default target to build is named identically to the package
- `//src/...` - All targets recursively under the `src` package
- `:target` - Target in current directory's BUILD file

These can be combined in various ways as expected, e.g. `cell//foo` is `cell//foo:foo` and `//foo` is `cell//foo:foo`
By convention the default cell under which everything goes that does not go elsewhere is called `root`.

#### `BUILD` files

As noted previously, a `BUILD` file (also sometimes named `BUCK` or `TARGETS`) for a package lists targets, which specify dependencies on other targets, forming a directed acyclic graph (DAG) of dependencies called the **target graph** which at a very high level is very similar to a `Makefile`. `buck2` is much closer to Makefiles than it is to Cargo/NPM/etc.

A `BUILD` file generally looks like this:

```bazel
cxx_rule(name = 'foo', ...)
rust_rule(name = 'bar', deps = [ ":foo" ], ...)
java_rule(name = 'baz', deps = [ ":foo", ":bar" ], ...)
```

In this example, `foo` is a C++ binary, `bar` is a Rust binary that depends on `foo`, and `baz` is a Java binary that depends on both `foo` and `bar`. (It is easy to see how this is somewhat spritually similar to a Makefile.)

A target is created by applying a rule, such as `cxx_rule` or `rust_rule`, and assigning it a `name`. There can only be one target with a given name in a package, but you can use the same rule multiple times with different names.

Unlike Make, Buck requires that the body of a rule, its "implementation", must be defined separately from where the rule is used. A rule can not be defined in `BUILD` files, but only applied to arguments and bound to a name.

It is important to note that these rules have no evaluation order defined. You are allowed to write `cxx_rule` at the bottom of the file in the above example. The name of the target is what matters, not the order in which the targets are written. `BUILD` files only describe a graph, not a sequence of operations.

More generally, a rule is just a function, a target is just the application of a function to arguments, and the `name` field is a special argument that defines a "bound name" for the result of the function call. So a `BUILD` file is just a series of function calls, that might depend on one another. In a more "ordinary" language, the above example might look like this:

```bazel
bar = rust_rule(deps = [ foo ], ...)
baz = java_rule(deps = [ foo, bar ], ...)
foo = cxx_rule(...)
```

This syntax exists as a pragmatic compromise to achieve "late binding" or lazy evaluation of the target graph in an eager language like Starlark.

#### Abstract targets & action graphs

Buck2 operates on two main graph structures:

1. **Target Graph**: The high-level dependency graph defined in BUILD files. This represents what needs to be built and the dependencies between targets.

2. **Action Graph**: The low-level graph of actual build commands. Buck2 transforms the target graph into concrete actions (compile, link, etc.) that can be executed.

This separation allows Buck2 to:
- Cache build artifacts efficiently
- Parallelize independent actions
- Provide reproducible builds
- Support remote execution

#### Target visibility

Every target can have an associated _visibility list_, which restricts who is capable of depending on the target. There are two types of visibility:

- `visibility` - The list of targets that can see and depend on this target.
- `within_view` - The list of targets that this target can see and depend on.

Visibility is a practical and powerful tool for avoiding accidental dependencies. For example, an experimental crate can have its `visibility` prevent general usage, except by specific other targets that are testing it before committing to a full migration.

#### Package files

In a package, there can exist a `PACKAGE` file alongside every `BUILD` file. The package file can specifie metadata about the package, and also control the default visibility of targets in the package. Look at the `PACKAGE` files in the tree and the code in @buck/shims/package.bzl to understand how PACKAGE files work.

#### At-file syntax

The `buck2` CLI supports a convenient modern feature called "at-file" syntax, where the invocation `buck2 @path/to/file` is effectively equivalent to the bash-ism `buck2 $(cat path/to/file)`, where each line of the file is a single command line entry, in a consistent and portable way that doesn't have any limit to the size of the underlying file.

For example, assuming the file `foo/bar` contained the contents

```text
--foo=1
--bar=false
```

Then `buck2 --test @foo/bar` and `buck2 --test --foo=1 --bar=false` are equivalent. This is convenient and some tools in the monorepo will not output arguments to pass to a program, but will output _file paths_ to files containing arguments to pass to a program. That means instead of executing `buck2 build $(bar)` you would instead execute `buck2 build @$(bar)` and use at-file syntax to read the arguments.

#### High-level build graph

The build system uses Buck2 cells to organize the monorepo:

- `depot` (root cell) - Main source code and projects
- `depot-cellar` - Bootstrap toolchain for system-level builds
- `depot-mode` - Build mode configurations (debug/release)
- `depot-toolchains` - Language-specific toolchain definitions
- `depot-third-party` - External dependencies

**Cell aliases**: The `.buckconfig` defines cell aliases for convenience:
- `root` = `depot` (primary cell)
- `cellar` = `depot-cellar`
- `mode` = `depot-mode`
- `toolchains` = `depot-toolchains`
- `third-party` = `depot-third-party`

Use these aliases in target references: `third-party//mimalloc:rust` instead of `depot-third-party//mimalloc:rust`.

Each `BUILD` file defines targets using the `depot.` prefix (e.g., `depot.rust_binary()`) which are wrappers around native Buck2 rules. The wrappers provide consistent defaults and ensure proper dependency management.

**Important**: All BUILD files automatically load `buck/shims/noprelude.bzl` which prevents direct use of native Buck2 rules like `rust_binary()`, `cxx_library()`, etc. You MUST use the shim versions via `load("@root//buck/shims/shims.bzl", depot = "shims")` and call `depot.rust_binary()`, `depot.cxx_library()`, etc.

#### Shim system for rule enforcement

All BUILD files automatically load `buck/shims/noprelude.bzl`, which blocks direct use of native Buck2 rules. Instead, projects must use the centralized shims from `buck/shims/shims.bzl`:

```starlark
load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_binary(name = "example", ...)  # ✓ Correct
rust_binary(name = "example", ...)        # ✗ Blocked by noprelude.bzl
```

The shim system provides:
- Consistent defaults across all targets (Rust edition 2021, cache upload settings)
- Environment variables like `DEPOT_VERSION` injected automatically

#### Multi-language toolchain support

The repository supports:
- **Rust**: Standard cargo-style projects with Buck2 integration
- **C++**: Native compilation with optional cross-platform support
- **OCaml**: Native OCaml compilation
- **Deno/TypeScript**: For tooling and utilities (see `src/tools/`)
- **Bootstrap toolchains**: Self-hosting compilation from source (see `cellar/`)

#### Package metadata system

The `PACKAGE` files use a structured metadata system defined in `buck/shims/package.bzl`:

```starlark
pkg.info(
    copyright = ["© 2024-2025 Austin Seipp"],
    license = "Apache-2.0",
    description = "Description here",
    version = "1.0.0",  # Must be semver
)
```

This enforces SPDX headers and provides OSV (Open Source Vulnerability) tracking capabilities.

#### Build modes

Control whether to build things in debug or release mode:

```bash
# Explicit build mode selection
buck2 build @mode//debug //src/project     # Debug build
buck2 build @mode//release //src/project   # Release build
```

#### Common Buck2 commands and patterns

##### Target patterns
```bash
//src/...              # All targets recursively under src/
//src/project:         # All targets in src/project package
//src/project          # Default target (//src/project:project)
:target                # Target in current directory's BUILD file
:                      # All targets in current directory
cell//path:target      # Fully qualified target
```

##### Useful Buck2 commands
```bash
# Building
buck2 build //target           # Build specific target
buck2 build //target --show-output  # Show output paths
buck2 build @mode//debug //target   # Debug build
buck2 build @mode//release //target # Release build

# Testing
buck2 test //target            # Run tests
buck2 test //target -- --nocapture  # Pass args to test
buck2 test //src/... --no-ignore-broken-targets  # Test everything, report failures

# Running
buck2 run //target             # Run binary target
buck2 run //target -- args     # Pass arguments

# Querying
buck2 targets //src/...        # List all targets
buck2 query "deps('//target')" # Show dependencies
buck2 query "rdeps('//src/...', '//lib:foo')"  # Reverse dependencies
buck2 audit cell               # Show cell configuration
buck2 audit config             # Show Buck2 configuration

# Debugging builds
buck2 build //target -v 2      # Verbose output
buck2 explain //target         # Explain why target needs rebuilding
buck2 log what-ran             # Show what commands ran
```

##### Integration with jj workflows
```bash
# Test changes before committing
jj new trunk() -m "feat: new feature"
# ... make changes ...
TARGETS=$(buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/...)
buck2 test @$TARGETS
jj commit -m "feat: new feature"

# Debug build failures
buck2 build //failing:target -v 2
buck2 log what-ran
buck2 log what-failed
```
