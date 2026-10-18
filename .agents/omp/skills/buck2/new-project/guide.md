<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Create a Buck2 project

Start from a nearby project of the same language and purpose. Choose the package
path, target name, dependencies, and intended consumers before creating files.
Use existing packages when appropriate; do not create a second build convention.

## 1. Generate the supported starting files

Invoke the OMP filesystem tool `buck2_new_project` from the repository root:

```json
{
  "type": "rust_binary",
  "name": "mytool",
  "path": "src/tools/mytool",
  "description": "Describe the tool's purpose",
  "author": "Austin Seipp"
}
```

Supported types are `rust_binary`, `rust_library`, and `deno_binary`. The tool
creates SPDX-headed BUILD, PACKAGE, and source files; Deno projects also receive
`deno.jsonc` and a machine-readable `deno.lock`. It returns the created file
paths and Buck2 target. It refuses existing directories and symlink ancestors,
and confines paths to the working directory. Edit an existing package manually
rather than deleting it to force generation.

Optional fields are `description` (defaults to `<name> project`), `author`
(`Austin Seipp`), `license` (`Apache-2.0`), `version` (`1.0.0`), and
`visibility` (a string array, default `["PUBLIC"]`). Deno-only `permissions`
is a string array of `--allow-*` values, defaulting to no permissions.
Use the repository's license policy and the narrowest useful visibility.

## 2. Review and complete the generated files

Review the generated package for the requested behavior:

- Keep the existing `depot.*` wrappers for Rust/C++. PACKAGE uses
  `load("@root//buck/shims:package.bzl", "pkg")` and `pkg.info` with
  copyright, license, description, and version metadata.
- Replace the greeting implementation with the requested behavior. Declare all
  source and runtime inputs, real dependencies, and appropriate visibility.
- Add meaningful tests following the nearby package's rules. The scaffolder
  does not generate behavioral tests for greeting examples.

### Rust

Use `depot.rust_binary`, `depot.rust_library`, and `depot.rust_test`. Source paths
are package-relative. The wrappers default to edition 2024 and supply package
version environment metadata. Inspect existing third-party BUILD targets before
adding crates or features.

The binary scaffolder adds `third-party//by-name/mi/mimalloc:rust` and selects
the repository allocator in source:

```rust
#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;
```

Keep reusable code in a library and make separate binaries depend on it when
that matches the project. Match existing test crate roots, source lists, and
dependencies rather than assuming every test should depend on a binary target.

### Deno

Use `load("@toolchains//deno:defs.bzl", "deno")` and `deno.binary`.
The tool creates a CLI with `type = "run"`; change to `type = "serve"` when
implementing a server. Grant only permissions the implementation needs.
Add imported files to `srcs`; use the rule's `config` attribute for
configuration, not an invented binary `data` attribute. The macro attaches a
lint test; use `deno.test` for behavioral tests.

### C++

There is no C++ generator or bundled C++ template. Create BUILD, PACKAGE, and
sources manually from a matching repository package. Use `depot.cxx_binary` or
`depot.cxx_library`; declare `srcs`, private `headers` or public
`exported_headers`, `deps`, and visibility as needed. Set the header namespace
and compiler/linker flags only when the project requires them. The existing
`src/fozzie/runtime/BUILD` demonstrates library, binary, and command-test rules.

## 3. Validate the actual project

```bash
buck2 targets "depot//$PROJECT_PATH:"
buck2 build "depot//$PROJECT_PATH:$NAME"
```

Run the executable or exercise the library's new behavior, then use the
[test workflow](../test-workflow/guide.md) for package and downstream
coverage. Do not assume generation means the project builds or tests exist.

## Bundled resources

- Native project tool: `buck2_new_project`; read `xd://buck2_new_project` for its schema.
- [Rust binary template](assets/templates/rust_binary/main.rs)
- [Rust library template](assets/templates/rust_library/lib.rs)
- [Deno binary template](assets/templates/deno_binary/main.ts)

Templates are examples; the native tool emits source directly rather than
reading them. Keep both in mind when inspecting generated content.
