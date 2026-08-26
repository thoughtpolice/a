<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hurl

Checksum-pinned [Hurl 8.0.1](https://github.com/Orange-OpenSource/hurl/releases/tag/8.0.1)
for Linux and macOS, on x86-64 and AArch64. Hurl is an ordinary Buck tool,
consumed through `attrs.exec_dep`, with no toolchain registration or custom
provider. No globally installed Hurl or package-manager invocation is needed.
Archive digests come from the official GitHub release metadata.

```console
buck2 run root//buck/tools/hurl:hurl -- --version
buck2 test root//buck/tools/hurl/...
```

## Runtime requirements

These are upstream **dynamically linked** executables, not hermetic static
binaries. Linux requires glibc (upstream builds on Ubuntu 22.04), libgcc,
`libcurl.so.4`, `libxml2.so.2`, and their transitive dependencies. In particular,
newer libxml2 installations that provide only `libxml2.so.16` do not suffice;
upstream's Arch tests install `libxml2-legacy`. The macOS distributions use
system libraries and are built/tested upstream on macOS 15. TLS capabilities,
trust roots, and optional HTTP features depend on the host libcurl. The Buck
rules neither install nor silently download unpinned host libraries.

The `version-check` test verifies that the selected executable starts and
identifies the pinned release. `tests:default-arguments` and
`tests:custom-arguments` substitute a strict recording executable to check the
test rule's flags, environment, argument boundaries, and generated-file inputs.
Only Linux x86-64 is exercised by our current
development host; the other release digests and platform mappings are declared
but are not substitutes for native-host testing. See the pinned upstream
[packaging workflow](https://github.com/Orange-OpenSource/hurl/blob/8.0.1/.github/workflows/package.yml).

## Buck APIs

```starlark
load("@root//buck/tools/hurl:defs.bzl", "hurl")

hurl.test(
    name = "objects",
    src = "tests/objects.hurl",
    variables = {"bucket": "objects-test"},
    file_root = ":generated-fixtures",
    data = ["tests/extra-input.json"],
    local_resources = {"server": ":test-server"},
)
```

`root//buck/tools/hurl:hurl` exposes `RunInfo` and the executable as its default
output. Its `[distribution]` subtarget contains the upstream distribution,
including `bin/hurlfmt`, manuals, and completions. Other rules can use this target
directly as an executable dependency or through `$(exe ...)`; no wrapper target
is needed. Platform selection follows the dependency's configuration, so
`hurl.test` uses an execution dependency to select the host executable.

`hurl.test` runs exactly one scenario as one Buck test, with uncolored output
and long diagnostics that include error response bodies. `connect_timeout`
defaults to `"5s"`; `max_time` defaults to `"30s"` **per request**, not per file.
Both use [Hurl duration syntax](https://hurl.dev/docs/manual.html).
Automatic retries are explicitly disabled, including inherited `HURL_RETRY`.
Individual `[Options]` sections can override CLI options; do not add retries to
state-changing contract tests. HTTP test-result caching is disabled because
responses depend on live state.

`variables` are static `--variable name=value` arguments. `file_root` supplies
Hurl's `--file-root` directory for binary bodies and file predicates. It and
any artifact-valued variables are tracked Buck inputs; additional files read
by relative path belong in `data`. Test commands run from the project root.
The rule also accepts ordinary `env`, `labels`, and `contacts` attributes.

`local_resources` maps arbitrary names to dependencies providing Buck's
`LocalResourceInfo`. These are target-configuration dependencies so a release
build tests a release server; Hurl itself is an execution dependency.
Resources are required only for execution, not test listing. To inject dynamic
Hurl variables, map the resource fields to `HURL_VARIABLE_name` environment
variables. For example, `HURL_VARIABLE_endpoint` makes `{{endpoint}}` available
in a scenario. This keeps the rule independent of chaos3 or any other server.
Use `buck2 test` to get resource provisioning; `buck2 run` exposes the same Hurl
command but expects the caller to provide its server and environment.

Keep server lifecycle outside Hurl. Each scenario must either own a private
fixture or use disjoint names so parallel tests cannot interfere. Hurl should
assert structured HTTP behavior directly (status, headers, JSONPath/XPath,
captures, and binary bodies); FileCheck is more appropriate for CLI output.
