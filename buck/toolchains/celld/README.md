<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# celld toolchain

This package supplies checksum-pinned celld 0.5.1 binaries and reusable Buck
rules for prebundled Workers. It has no Orchestra dependency and does not run
Wrangler or esbuild. The current release supports Linux x86-64/ARM64 and macOS
ARM64; configured execution-platform constraints select the matching binary.

`toolchains//:celld` is the default toolchain alias. `CelldToolchain.celld`
contains the executable command; `default_info` exposes its binary and
`[archive]` outputs. Custom rules consume it using
`attrs.toolchain_dep(default = "toolchains//:celld", providers = [CelldToolchain])`.
Versions and release SHA-256 digests live in [BUILD](BUILD), not in applications.
Unpacking requires Bash, gzip, and chmod on the execution host.

## Application rules

`celld.binary` exposes the configured CLI and binary artifacts.
`celld.project` packages a bundled ESM file, generated `wrangler.jsonc`, and
optional assets into a self-contained directory. Despite that filename, no
Wrangler executable is involved: `no_bundle: true` tells celld to deploy the
input JavaScript verbatim. `celld.worker` (see [TypeScript units](#typescript-units))
bundles TypeScript for it.

`celld.deploy` provides a runnable deployment command.
`celld.serve` exposes celld's default node command and forwards additional
arguments. Neither starts a server or modifies storage during a Buck build.
`celld.deploy_test` runs the real CLI with `deploy --dry-run --json`; it checks
project packaging/configuration without contacting storage, but does not
execute handlers or verify their behavior. **Container projects still invoke
the configured Docker/Podman CLI to build or pull images, even with
`--dry-run`.** Building `celld.project` itself only copies files and never
contacts a container engine.

```python
load("@toolchains//celld:defs.bzl", "celld")

celld.worker(
    name = "worker",
    main = "src/index.ts",
    srcs = glob(["src/**/*.ts"]),
    deps = ["root//src/celld/assert:assert"],
)

celld.project(
    name = "project",
    src = ":worker",
    script_name = "example",
    bindings = {"COUNTER": "Counter"},
    kv_namespaces = {"CACHE": "example-cache-v1"},
    r2_buckets = {"ARTIFACTS": "example-artifacts"},
)

celld.deploy(name = "deploy", project = ":project")
celld.serve(name = "serve")
celld.deploy_test(name = "deploy-test", project = ":project")
```

`celld.project` takes any bundled ESM file as `src`; `celld.worker` below is
the usual way to produce one from TypeScript.

## TypeScript units

`celld.library`, `celld.test` and `celld.worker` build TypeScript for celld.
Each declares its own `srcs` and its `deps` on libraries; the toolchain
generates every Deno config and import map, so applications write no
`deno.json` and never load `@toolchains//deno:defs.bzl`. Everything is first
party: there are no npm, JSR or remote imports and no lockfile.

```python
celld.library(
    name = "segment",
    srcs = glob(["src/*.ts"]),
    import_name = "@wormspace/segment",
    exports = {
        ".": "src/mod.ts",
        "./types": "src/types.ts",
    },
    deps = ["root//src/celld/assert:assert"],
    visibility = ["PUBLIC"],
)

celld.test(
    name = "core-test",
    srcs = ["tests/core_test.ts"],
    deps = [":segment", "root//src/celld/assert:assert"],
)
```

- `import_name` is the bare specifier other code imports (`import { eq } from
  "@celld/assert"`). `exports` maps `"."` and `"./sub"` subpaths to files
  (default `{".": "mod.ts"}`); `"./sub"` becomes `@celld/assert/sub`. Only
  these entry points are importable; exported files join `srcs` implicitly.
  Two libraries in one closure may not claim the same specifier.
- Building a library type-checks it, like a compiler: its default output is a
  check stamp. `celld.worker` bundles `main` into `<name>.js` with
  `deno bundle --platform browser --format esm`, keeping `cloudflare:*`
  external, for `celld.project(src = ...)`; `minify = True` shrinks it.
- `celld.test` runs `deno test` over the `*_test.ts` files in `srcs` (all of
  `srcs` when none match), with `data`, `env` (`$(location)` values allowed)
  and `permissions` (`["read"]` becomes `--allow-read`). With
  `fake_runtime = True`, `"cloudflare:workers"` maps to
  [`testing/workers.ts`](testing/workers.ts), constructor-only stand-ins for
  `DurableObject`, `WorkerEntrypoint` and `WorkflowEntrypoint`, so tests can
  import modules that define Durable Objects. Without it a test may import
  runtime modules only with `import type`.
- Every unit gets `[check]` (graph and type check) and `[lint]` (`deno lint`)
  tests, which `buck2 test` runs through the `tests` attribute, plus
  `[config]` (its generated Deno config) and `[ide]` (its editor fragment,
  which `celld-project` reads).

### Strict dependencies

[`celldc.py`](celldc.py) drives every action. It writes the unit's Deno config
(the import map of its whole closure, `strict` compiler options, and
[`types/celld.d.ts`](types/celld.d.ts) as ambient types), then runs
`deno info --json --no-remote --no-npm` over the unit's sources and fails when
a module:

- imports a specifier that is not exported by a **direct** dependency of the
  module's own unit (declare the dependency, do not lean on a transitive one);
- reaches a file outside its unit's `srcs` through a relative import, such as
  `../../other/src/x.ts` (import the other library's specifier instead);
- is not in the `srcs` of any unit in the closure, which keeps Buck's inputs
  complete;
- imports `npm:`, `jsr:`, `http(s):` or `node:` modules, or any builtin other
  than `cloudflare:*`.

Only then does it run `deno check`, `deno test --no-check` (the stamp already
checked the same graph) or `deno bundle`. `tests/lib/` holds a library chain,
a worker, a fake-runtime test, and `graph_test.py`, which runs the driver over
units that must fail.

### Typed native RPC

`DurableObjectNamespace<T>` propagates an application's class instance or method
contract through `get()`, `getByName()`, and `jurisdiction()`. Its
`DurableObjectStub<T>` checks method names and arguments and returns
`Promise<Awaited<Result>>`; synchronous methods become asynchronous and nullable
results retain their null branch. `ServiceBinding<T>` provides the corresponding
method-call surface for a Worker entrypoint. Omit `T` to keep the HTTP-only
surface without inventing application methods:

```typescript
interface CounterAPI {
  increment(amount: number): number;
  read(): Promise<number | null>;
}

interface Env {
  COUNTER: DurableObjectNamespace<CounterAPI>;
  OPERATIONS: ServiceBinding<CounterAPI>;
}

async function increment(env: Env): Promise<number> {
  return await env.COUNTER.getByName("shared").increment(1);
}
```

These are method-only contracts, not authorization, argument validation, or
serialization schemas. They intentionally do not advertise property pipelining
or capability transfer: pass structured-clone data and await the returned values.
Use runtime `#private` helpers; TypeScript's `private` modifier is erased.
celld 0.5.0 notably uses different dispatch rules for the two transports:

- DO RPC accepts callable instance members, including own function fields and
  lifecycle methods such as `alarm()`. Its typed projection retains these when
  the supplied contract declares them, excluding the stub's local identity,
  inherited JavaScript members, and HTTP transport names.
- Service RPC accepts public prototype methods and rejects own instance members
  and reserved lifecycle names. The projection excludes fields and lifecycle
  names, but TypeScript cannot distinguish a function-valued field from a
  prototype method: implement service APIs as ordinary class methods.

An application-owned narrow interface documents the intended surface; it does
not prevent a JavaScript caller from invoking another public method. Keep domain
contracts with the application, and retain runtime validation, lease fencing,
serialization, and explicit durable acknowledgements when replacing HTTP calls.
celld retries remote RPC only when a failed peer attempt did not start the
method; application retries still need stable operation IDs.

`CelldProjectInfo.directory` is the package consumed by deployment or custom
E2E rules. The project's `[config]` and `[worker]` subtargets expose its JSON
configuration and JavaScript separately.

### Editors

Deno's language server reads `deno.json` files, which celld units do not have.
[`buck/bin/celld-project`](../../bin/celld-project) stands in for it the way
`rust-project` does for rust-analyzer: editors run `celld-project lsp`, and
nothing is written into the source tree.

- It is a proxy ([`project/`](project), a static Go binary) in front of the
  toolchain's `deno lsp`. It keeps one Deno config at
  `buck-out/celld-project-lsp/<pid>/deno.json` with absolute paths, and adds
  its path as the `config` setting to `initialize`, to the editor's answers to
  `workspace/configuration` and to `workspace/didChangeConfiguration`, merged
  into the editor's own settings. Deno applies it to every file no nearer
  `deno.json` claims, so the hand-written Deno packages keep their configs.
- When the editor opens a file that no known unit covers, the proxy runs
  [`project.bxl`](project.bxl) with `--isolation-dir=celld-project` (its own
  daemon, so it does not wait for or disturb the user's builds). The BXL
  finds the units that own the file (an owner query; a file no target lists
  yet gets its package's units) and builds their `[ide]` fragments.
  `celldc fragment` writes each one from the unit's manifest with the same
  code that writes the build's config: the closure's import map, the `lib`,
  `strict` and `types` (celld.d.ts) compiler options, and the closure's
  files. The proxy merges the fragments it has (a specifier two units map to
  different files is reported as a warning in the editor's log and the first
  wins), rewrites the config, and tells Deno through
  `workspace/didChangeWatchedFiles`. It remembers the directories it has
  asked about and every file of the known closures, so opening a dependency's
  file asks nothing. It never queries `root//...`.
- The document being looked up reaches Deno only after Deno reports the
  reload (`deno/didChangeDenoConfiguration`), or after 15 seconds
  (`--hold`); messages about other documents are not held. Deno 2.9 keeps an
  already open document's old module resolution for go-to-definition until
  that document is edited, even though it re-checks it after a reload, so an
  early open would leave navigation stale.
- The proxy registers editor watchers for `BUILD` and `PACKAGE` files. When
  one changes (or is saved), it forgets what it found and looks up the open
  documents again.
- Any arguments but `lsp` go to Deno, so `celld-project` can stand in for a
  `deno` executable (`celld-project --version`).

The wrapper finds the project root from the working directory (or its own
location), then execs the command `buck2 --isolation-dir=celld-project run
--emit-shell toolchains//celld:project` prints, which it caches in
`buck-out/celld-project-lsp/command`. It rebuilds when a file under
`buck/toolchains/celld/project`, the celld or Deno toolchain definitions is
newer than the cache, or when the binary is gone; otherwise it starts in about
10 ms.

The root `.helix/languages.toml` runs it for TypeScript and JavaScript (with
`buck/bin` on `PATH`, as the `.envrc` sets up); `.zed/settings.json` sets
`lsp.deno.binary`; `.vscode/settings.json` sets `deno.path` (the extension
resolves a relative path against the workspace folder). All three keep
`deno.enablePaths` (`src/`, `tilde/`, `buck/toolchains/`) and
`deno.documentPreloadLimit` 5000: the forced config does not help Deno find
the hand-written `deno.json` packages, which it looks for by walking the
workspace, and `buck-out/` and `work/` use up the default 1000 entries before
it reaches them. A relative import of a file that the unit's import map also
exports shows an `import-map-remap` hint; keep the relative import, since a
library cannot import itself by name.

`:celld-project-test` covers the proxy with a fake server;
`:celld-project-lsp-test` runs it in front of the real `deno lsp` over
`tests/lib`'s fragments: an undiscovered file settles with no diagnostics,
TS2322 on a broken file, go-to-definition landing in the dependency's
source, and a nested `deno.json` package resolving its own imports.

## Project attributes

`src` (bundled ESM source) and `script_name` are required. Every collection
below defaults to empty; a Worker needs no Durable Object bindings.

| Attribute | Meaning |
| --- | --- |
| `bindings` | Map of environment binding to local Durable Object class; emits SQLite migrations. |
| `d1_databases` | Map of binding to database name. |
| `d1_database_ids` | Optional stable IDs keyed by declared D1 binding. |
| `kv_namespaces` | Map of binding to stable namespace ID. |
| `r2_buckets` | Map of binding to logical bucket name within the fleet bucket. |
| `services` | Map of binding to script name. |
| `service_entrypoints` | Optional named entrypoints keyed by declared service binding. |
| `queue_producers` | List of objects containing `binding`, `queue`, and optional `delivery_delay` seconds. |
| `queue_consumers` | List of objects containing `queue` and the consumer settings described below. |
| `workflows` | List of objects containing `binding`, `name`, `class_name`, and optional `script_name`. |
| `worker_loaders` | List of environment binding names for Dynamic Workers; each gets an independent loader cache. |
| `containers` | List of container declarations containing `class_name`, `image`, and optional `name`, `instance_type`, `max_instances`, and celld-specific `runtime`. |
| `container_context` | Optional directory artifact copied to `container/` in the project; reference its Dockerfile as `container/Dockerfile`. Requires a container declaration. |
| `crons` | Cron expression list. |
| `vars` | Map of string-valued environment variables. |
| `compatibility_date` | Date string, defaulting to `2026-08-20`. |
| `compatibility_flags` | Compatibility flag string list. |

Consumer settings are optional `max_batch_size`, `max_batch_timeout` seconds,
`max_retries`, `dead_letter_queue`, `max_concurrency`, and `retry_delay`
seconds. celld validates allowed keys and numerical limits at deployment.
A queue has one consumer script, and that script cannot export `fetch`.
Workflows must execute in their declaring script, so an explicit `script_name`
must equal the project's name. Workflow `retention` and `locationHint` are
runtime `create()`/`createBatch()` options, **not deployment keys**. Retention
defaults to 30 days and cannot exceed 30 days; location hints do not override
fleet ownership. Workflow schedules, R2 jurisdiction, and Queue pull consumers
are unavailable. Loader deployment entries accept only a binding name.
Dynamic Worker `limits` (`cpuMs`/`subRequests`) belong in `WorkerLoaderCode` or
`getEntrypoint()` options; when both set a limit the lower value applies.
`WorkerLoaderCode.tails` accepts Service Binding Fetchers for post-fetch
invocation reports. `getDurableObjectClass()` accepts only `props`, and
`allowExperimental` remains unsupported. KV writes accept byte streams in
0.5.1, buffering them with the same 25 MiB limit as other values.

Container classes must be declared in `bindings`, which also generates their
required SQLite migration. An `image` is a registry reference or a Dockerfile
path relative to the packaged project. For a local Dockerfile, package its
entire build context as a directory artifact in `container_context`:

```python
celld.project(
    name = "container-project",
    src = ":worker",
    script_name = "example-container",
    bindings = {"SANDBOX": "Sandbox"},
    container_context = ":docker-context",
    containers = [{
        "class_name": "Sandbox",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
        "runtime": "runsc",
    }],
)
```

Containers are experimental. Deployment uses `docker` on `PATH` (or
`CELLD_DOCKER`, including a Podman CLI), defaults to `linux/amd64` unless
`CELLD_CONTAINER_PLATFORM` is set, and builds/pulls the application and fleet
fence images. Serving a container requires an engine and the requested OCI
runtime on each eligible node; no rule installs or starts these dependencies.
The default `dev` instance has 1/16 CPU and 256 MiB memory. Container disks are
ephemeral, fleet-wide instance limits can briefly overshoot, and ordinary
containers are a shared-kernel isolation boundary. Choose an appropriate
runtime for untrusted code; the Buck package makes no stronger isolation
guarantee. Consult celld's compatibility/security documentation before serving
container workloads.

`assets` optionally supplies a directory artifact. Its related attributes are
`assets_binding`, `assets_html_handling`, `assets_not_found_handling`,
`assets_run_worker_first` (boolean), and `assets_run_worker_first_routes`
(route list). Asset options require `assets`; choose the boolean or route-list
form of worker-first routing, not both.

The bindings and minimal fixtures in [tests/BUILD](tests/BUILD) exercise these
configurations using the pinned CLI. `:packaging-test` checks generated JSON,
assets, preserved runtime imports, dry-run binding output, and explicit
rejections of unsupported loader/workflow/AI/container configuration. Its
container fixture is checked only as packaged files; invalid container
declarations fail before image resolution, with the Docker CLI disabled as
an additional guard. No test in this package needs a container engine or
downloads an image. The same package owns `:types-test`,
which checks positive and negative TypeScript contracts against the shared
declarations without invoking real bindings. Application domain types remain
in their own source trees.

`:runtime-test` runs the pinned binary with `celld dev` against three fresh,
temporary projects. It checks cross-request promise-tail ownership and real
Workflow create/get, retained duplicate create/createBatch, short success/error
retention, deletion, and stale-handle behavior. The promise-tail fixture is the
original two-request `Serial` reproduction, unchanged from Orchestra's earlier
report; platform regressions now live here rather than in the application.
The native RPC fixture checks independent structured-clone arguments/results
(including typed arrays, Maps, Dates, null, and undefined), the distinct DO and
service method-visibility rules, and an acknowledged SQLite write read again
after restarting the entire dev supervisor against the same local storage.
These tests need only loopback sockets and temporary local storage. They start
and stop their own supervisors, use bounded startup/request/shutdown waits, and
do not contact a fleet, S3 server, or container engine.

The lifecycle tests pin two important distinctions for callers and their fakes:
`get()` eagerly checks existence, and missing/expired `get()`, `status()`, and
`delete()` reject with `Error("WORKFLOW_ERROR: instance does not exist")`, not
an artificial Workflow status or a typed `NotFoundError`. Handles address an
instance ID, not a generation: deletion makes an old handle fail, but recreating
the same ID makes that handle address the replacement. Keep application-level
run identity/fencing outside Workflow handles.

## Known celld runtime limitations

These are bugs or gaps in the pinned celld 0.5.1 binary, not in the
toolchain; libraries work around them or fail with a clear error. Each was
reproduced with a one-file Worker (`no_bundle: true`) under `celld dev`.

- **Ed25519 signatures cannot be verified.** Generating an Ed25519 key and
  signing work (a 64-byte signature), but verifying rejects:

  ```javascript
  const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const data = new TextEncoder().encode("hello");
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, k.privateKey, data);
  await crypto.subtle.verify({ name: "Ed25519" }, k.publicKey, sig, data);
  // NotSupportedError: unsupported verify algorithm: ED25519
  ```

  `@celld/jwt` reports this as `runtime_unsupported` rather than a bad
  signature, and `@celld/oauth` leaves Ed25519 out of its default DPoP
  algorithms.
- **Symmetric JWKs cannot be imported.** A `kty: "oct"` JWK is refused,
  while the same key imported as `raw` bytes works:

  ```javascript
  await crypto.subtle.importKey("jwk", { kty: "oct", k: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I", alg: "HS256" },
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // NotSupportedError: unsupported key import
  ```

  Decode `k` with base64url and import the bytes as `raw` instead.
- **An alarm more than about 2.18 years ahead kills the node.** A
  deadline past 2^36 ms (68,719,476,736 ms) from now panics celld's core
  thread and aborts the whole node, every Worker on it included, with the
  request getting no answer. 68,000,000,000 ms still works:

  ```javascript
  // in a Durable Object method
  await this.ctx.storage.setAlarm(Date.now() + 69_000_000_000);
  // thread 'celld-core' panicked at crates/celld/actor.rs:1213:26:
  // invalid deadline; err=Invalid
  // Error: the local celld node exited with signal: 6 (SIGABRT)
  ```

  The alarm is not stored, so the node starts again cleanly. Clamp alarm
  times well inside that bound (a year is plenty) and reschedule.
- **`.dev.vars` reads no escapes.** `celld dev` splits each line at the
  first `=`, trims both sides and removes one pair of matching `'` or `"`
  around the value, and nothing more: `"a\"b"` arrives as `a\"b`, `#`
  does not start a comment, `$NAME` is not expanded, a quoted value cannot
  span lines, lines without `=` are ignored, and `export NAME=...` is an
  invalid binding name. A value between single quotes arrives verbatim,
  JSON included, which is how the [example harness](../../../src/celld/examples)
  writes them.

## Upgrading from 0.5.0

The [official 0.5.1 release](https://github.com/denoland/celld/releases/tag/v0.5.1)
supports rolling upgrades: replace one node, wait for its replacement to report
healthy, then continue to the next node. The binaries and all three compressed
asset checksums are pinned from that release's metadata.

Orchestra's event-mode diagnostic still reproduces `storage.transaction:
database is locked` on 0.5.1; keep its default polling workaround. This is
separate from the cross-request promise-tail regression, which passes on 0.5.1.
See [Orchestra's release check](../../../tilde/aseipp/orchestra/DESIGN.md#celld-051-revalidation-2026-09-20).

## Upgrading from 0.4.1

This is a **stopped-fleet upgrade**, not a rolling update. Stop application
traffic, deployment writers, every old node, and their supervisors; wait for
the old node leases to expire. Back up both the fleet bucket and node data
directories (a follower disk can contain acknowledged writes not yet in the
bucket). Prevent old binaries from returning, then start 0.5.0 with the same
node identities, addresses, configuration, and data directories. Startup
migrates the wake format before serving. Resume traffic after the fleet is
healthy. Never start 0.4.1 against the upgraded bucket; rollback requires a
complete stopped-fleet backup. See upstream's
[wake-format upgrade contract](https://github.com/denoland/celld/blob/v0.5.0/docs/guarantees.md#start-a-fleet-with-this-format).

Workers AI was removed: 0.5.0 rejects `CELLD_AI_URL`, `CELLD_AI_BINDING`, and
an `ai` deployment declaration. Remove the old process variables and call
your AI provider directly from application code. The shared declarations no
longer advertise an `Ai` binding.

## Commands

```console
$ buck2 run toolchains//celld:cli -- --version
$ buck2 test toolchains//celld/tests:tests
$ buck2 run //path/to/app:deploy -- --dry-run --json
$ buck2 run //path/to/app:deploy -- --bucket s3://example
$ buck2 run //path/to/app:serve -- --bucket s3://example --listen 127.0.0.1:8080
```

Storage credentials, `CELLD_BUCKET`, and endpoint overrides remain runtime
configuration; the toolchain embeds no credentials or local storage paths.
