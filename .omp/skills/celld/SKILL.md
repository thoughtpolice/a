---
name: celld
description: Create and test celld (Cloudflare Workers-compatible) projects in this monorepo with the @toolchains//celld rules - TypeScript libraries, Workers, Durable Objects, deployable projects, and tests against a real celld. Use when adding a celld library or app, writing celld tests, or relying on a celld platform behaviour.
license: Apache-2.0
---

<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# celld projects

celld TypeScript is built by `@toolchains//celld:defs.bzl`, not by
`deno.binary`. The toolchain writes every Deno config and import map, so a
celld package has **no `deno.json`, `deno.jsonc` or lockfile**, and no npm,
JSR, `node:` or remote imports. The reference is
`buck/toolchains/celld/README.md`; read the section a step names rather than
the whole file.

## 1. Choose the shape

| You are adding | Where | Rules |
| --- | --- | --- |
| A shared library | `src/celld/<group>/<lib>` (`<group>` is `sec`, `web`, `box` or `api`; foundations sit at the top level) | `celld.library`, `celld.test` |
| A Worker application | its own package, such as `tilde/<user>/<app>` | `celld.library` for its code, `celld.worker`, `celld.project`, `celld.deploy_test` |
| Tests of real runtime behaviour | next to the code they test | `celld.test` that starts `celld dev`, or a Python `command_test` |

Start from the nearest existing package of the same shape and copy its
layout. `buck/toolchains/celld/tests/lib/BUILD` has a small complete example:
a library chain, a worker, a project, a `deploy_test` and fake-runtime tests.

## 2. Write the BUILD file

```python
load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "widget",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/web/widget",
    exports = {".": "src/mod.ts"},
    deps = ["root//src/celld/core:core"],
    visibility = ["PUBLIC"],
)

celld.test(
    name = "widget-test",
    srcs = ["tests/widget_test.ts"],
    deps = [":widget", "root//src/celld/core:core"],
)
```

Add an SPDX-headed `PACKAGE` like its neighbours. Then:

- `import_name` follows the path (`src/celld/web/widget` is
  `@celld/web/widget`), and `exports` lists every importable entry point.
- Declare every direct dependency. A module may import only specifiers that
  its own unit's **direct** `deps` export, and relative imports may not leave
  the unit's `srcs` (README, "Strict dependencies").
- `celld.test` runs the `*_test.ts` files in `srcs`. Pass
  `fake_runtime = True` to import `cloudflare:workers` and friends as
  constructor stand-ins; without it, tests may only `import type` them.
- An application bundles with `celld.worker(main = ...)` and packages with
  `celld.project(src = ":worker", script_name = ..., bindings = {...})`.
  Every class in `bindings` is a SQLite-backed Durable Object (README,
  "Application rules" and "Project attributes").
- Shared code belongs in a library, not in a worker's `srcs`.

## 3. Use the platform as it is

- Write Durable Objects against `buck/toolchains/celld/types/celld.d.ts`,
  the ambient declarations every unit sees. Typed RPC goes through
  `DurableObjectNamespace<T>` (README, "Typed native RPC").
- celld has bugs and gaps that the code must work around or fail on
  clearly. `buck/toolchains/celld/AGENTS.md` catalogues each one, with the
  release it was seen or fixed in and how the existing libraries cope.
  Check it before you depend on a platform behaviour, and add an entry
  there, not in your package's docs, when you find a new one.
- Do not write celld version numbers in code or docs. State the behaviour,
  and link to the catalog for the bug.

## 4. Test against a real celld

Fake-runtime tests check your logic; behaviour that depends on celld (storage,
alarms, RPC copying, WebSockets, Workflows) needs the real runtime:

- A `celld.test` with `env = {"CELLD": "$(exe toolchains//celld:cli)",
  "PROJECT": "$(location :project)"}` and permissions such as `["run",
  "net=127.0.0.1", "read", "write", "env"]` can start `celld dev` on the
  packaged project and talk to it.
- A Python `command_test` can copy the `LocalRuntime` class of
  `buck/toolchains/celld/tests/runtime_test.py`. It reserves a port (`celld
  dev` refuses port 0), waits for the readiness log, and can restart the
  supervisor against the same storage.
- A library's examples run through the shared example harness under
  `src/celld/examples`, which serves a worker under `celld dev` and replays
  HTTP specs against it.
- A platform regression, as opposed to an application one, belongs in
  `buck/toolchains/celld/tests` (`:runtime-test`), so a celld release that
  breaks it fails there first.

## 5. Validate

```bash
buck2 targets "root//$PACKAGE:"
buck2 test "root//$PACKAGE/..."
buck2 test toolchains//celld/...   # after touching the toolchain or celld.d.ts
```

Every unit carries `[check]` and `[lint]` tests, so a `buck2 test` of the
package covers type checking and lint as well as behaviour. Then follow
`skill://buck2` (its test-workflow guide) for downstream consumers.

## Editors

Point the editor's Deno language server at `buck/bin/celld-project lsp`. It
feeds Deno each unit's import map from Buck, so imports resolve without a
`deno.json` (README, "Editors").
