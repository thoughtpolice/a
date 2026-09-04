<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# celld toolchain

This package supplies checksum-pinned celld binaries and reusable Buck
rules for prebundled Workers. It has no Orchestra dependency and does not run
Wrangler or esbuild. The current release supports Linux x86-64/ARM64 and macOS
ARM64; configured execution-platform constraints select the matching binary.

`toolchains//:celld` is the default toolchain alias. `CelldToolchain.celld`
contains the executable command; `default_info` exposes its binary and
`[archive]` outputs. Custom rules consume it using
`attrs.toolchain_dep(default = "toolchains//:celld", providers = [CelldToolchain])`.
Versions and release SHA-256 digests live in [BUILD](BUILD), not in applications.
celld's bugs and quirks, and what each release changed, are in
[AGENTS.md](AGENTS.md); the rest of the tree states platform behaviour
without version numbers and links there.
Unpacking requires Bash, gzip, and chmod on the execution host.

Source tooling belongs to the separate [web toolchain](../web/README.md).
`celld.library`, `celld.svelte_library`, `celld.worker`, `celld.browser` and
`celld.test` inject Worker policy into its shared rules: ambient celld types,
`cloudflare:*` externals, Worker Svelte conditions, optional constructor fakes,
and the existing Deno lint policy. Generic [`js.library`](../js/README.md)
dependencies are usable directly; `celld.project` accepts `WebBundleInfo` ESM.

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
    deps = ["root//src/celld/core:core"],
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
the usual way to produce one from TypeScript, and a worker's `src` brings its
[wasm modules](#wasm-modules) along.

## TypeScript units

`celld.library`, `celld.test` and `celld.worker` build TypeScript for celld.
Each declares its own `srcs` and its `deps` on libraries; the toolchain
generates every Deno config and import map, so applications write no
`deno.json` and never load `@toolchains//deno:defs.bzl`. Dependencies are declared
source libraries, including reusable archive-backed `js.library` vendor targets;
there is no npm/JSR/remote resolution or application lockfile in Worker checking
or bundling. Vendor libraries do not implicitly add Node or Deno globals.

```python
celld.library(
    name = "segment",
    srcs = glob(["src/*.ts"]),
    import_name = "@wormspace/segment",
    exports = {
        ".": "src/mod.ts",
        "./types": "src/types.ts",
    },
    deps = ["root//src/celld/core:core"],
    visibility = ["PUBLIC"],
)

celld.test(
    name = "core-test",
    srcs = ["tests/core_test.ts"],
    deps = [":segment", "root//src/celld/core:core"],
)
```

- `import_name` is the bare specifier other code imports (`import { eq } from
  "@celld/core/assert"` for `import_name = "@celld/core"`). `exports` maps `"."`
  and `"./sub"` subpaths to files (default `{".": "mod.ts"}`); `"./sub"` becomes
  `@celld/core/sub`. Only
  these entry points are importable; exported files join `srcs` implicitly.
  Two libraries in one closure may not claim the same specifier.
- Building a library type-checks it, like a compiler: its default output is a
  check stamp. `celld.worker` bundles `main` into `<name>.js` with
  `deno bundle --platform browser --format esm`, keeping `cloudflare:*`
  external, for `celld.project(src = ...)`. With `minify = True`, native Oxc
  compresses/mangles the completed bundle, not Deno's JavaScript minifier.
  `[map]` exposes the composed authored map; projects copy it beside `index.js`
  under the name its source-map URL references.
- `srcs` may hold JSON files, which code imports with
  `import data from "./data.json" with { type: "json" }`. They are modules,
  not roots: `deno check`, `deno test` and `deno lint` see only code.
- `celld.test` runs `deno test` over the `*_test.ts` files in `srcs` (all of
  its code when none match), with `data`, `env` (`$(location)` values allowed)
  and `permissions` (`["read"]` becomes `--allow-read`). With
  `fake_runtime = True`, each `cloudflare:*` module that
  [`types/celld.d.ts`](types/celld.d.ts) declares maps to its stand-in in
  [`testing/`](testing): `cloudflare:workers` (the `DurableObject`,
  `WorkerEntrypoint` and `WorkflowEntrypoint` constructors, an empty `env`
  and `exports` a test can fill, `RpcTarget`, an `RpcStub` that makes members
  asynchronous, `waitUntil`), `cloudflare:workflows` (`NonRetryableError`)
  and `cloudflare:sockets` (a `connect` that throws). They emulate no
  platform behaviour; they let tests import modules that use the runtime.
  `graph-test` fails when a declared export has no stand-in. Without
  `fake_runtime` a test may import runtime modules only with `import type`.
- Every unit gets `[check]` (graph and type check) and `[lint]` tests, which
  `buck2 test` runs through the `tests` attribute, plus `[config]` (its generated
  Deno config) and `[ide]` (its editor fragment, which `celld-project` reads).
  Lint sees authored JS/TS/rune/component sources: native Oxc/rsvelte runs first,
  then the existing configured Deno policy runs on JS/TS even if native lint
  failed. Declarations and data have nothing to lint.
- `[format]` uses the native formatter over the unit's explicit authored files.
  `buck2 run 'TARGET[format]'` prints formatted source as JSON without writing;
  append `-- --check` for a read-only check or `-- --write` to update those files.
  `buck2 test 'TARGET[format]'` performs the read-only check. Formatting is
  deliberately opt-in, not a new mandatory style gate for existing units.

### Native Svelte units

`celld.svelte_library` owns `.svelte` components, `.svelte.ts`/`.svelte.js` rune
modules and their declared neighbors. Its `exports` and `deps` have the same
strict meaning as `celld.library`; components are not ambient wildcard modules.

```python
celld.svelte_library(
    name = "views",
    import_name = "@app/views",
    exports = {".": "Page.svelte", "./counter": "counter.svelte.ts"},
    srcs = ["props.ts"],
    deps = ["root//src/celld/core:core"],
)
```

The native [`web`](../web/README.md#native-executable) driver produces
separate client/server JavaScript, CSS, authored-source maps, import facts and
check-only TSX projections. `[generated]` exposes that directory. Ordinary
declared JS/TS neighbors retain their exact bytes in each view; rune TypeScript
is erased only in runtime views. Real `deno check --no-remote --no-npm` checks
the projection and exported prop contracts, not merely parsing/transpilation.
Exact projection spans map checker locations back to the authored `.svelte`;
helper-generated failures are explicitly labeled as generated, never assigned
invented source coordinates.

The web toolchain supplies checksum-pinned official Svelte runtime sources and
official Svelte/svelte2tsx declaration helpers. Neither npm installation nor a
JavaScript compiler/formatter/linter bridge is involved. Runtime/type files
are a separate, bounded toolchain trust domain—not undeclared application
dependencies. Components may import public Svelte APIs; ordinary adapter
libraries must opt in with `svelte_runtime = True`. That does not admit arbitrary
`clsx`, runtime-private, npm, Node or remote imports. Worker bundles and tests
resolve server output; the check/editor view remains a projection. Classic JSX
checking uses Svelte's declaration factory and introduces no React runtime.

`celld.browser(main = ..., deps = ...)` selects client compilation and emits an
asset directory containing `app.js`, `app.css` and their source maps. Feed that
target directly to `celld.project(assets = ...)`. Deno performs the actual ESM
bundle; reachable component CSS and its native maps accompany it. Browser
value imports of `cloudflare:*` or Svelte's server runtime are refused, while
server-only type imports and unused server exports are not bundled.
See [`@celld/web/kit`](../../../src/celld/web/kit/README.md) for Worker SSR,
safe boot serialization and hydration.

With `minify = True`, the browser action bundles an intermediate ESM/map pair
beside the final files, then uses native Oxc minification and map composition.
`app.js.map` still contains authored component/rune/TypeScript sources and
`app.css.map` retains native CSS mappings. Intermediate files are removed;
there is no npm/NAPI/WASM JavaScript minifier or silent Deno minification fallback.

### Tailwind and global styles

Tailwind runs directly as a checksum-pinned standalone compiler in the build
graph. There is no npm installation, PostCSS configuration or browser-side CSS
compiler. Use its normal CSS-first theme/utility/variant features:

```python
load("@toolchains//tailwind:defs.bzl", "tailwind")

view_sources = ["Page.svelte", "draft.svelte.ts"] + glob(["components/*.svelte"])
tailwind.css(
    name = "styles",
    src = "styles.css",
    srcs = view_sources,
    minify = True,
)
celld.browser(
    name = "browser",
    main = "browser.ts",
    deps = [":views", "root//src/celld/web/kit:kit"],
    styles = [":styles"],
)
```

The CSS entry must disable automatic discovery:

```css
@import "tailwindcss" source(none);

@theme {
  --color-accent: #2563eb;
}
```

`srcs` is the complete declared candidate set, including child components.
The upstream scanner reads those files in fresh staging, never the checkout at
large. Tailwind still requires complete class names; use its inline sources for
explicit safelists. Declare relative CSS imports in `css_srcs`. File-based
`@source` directives may name only declared individual candidates; checkout
globs, external CSS and JavaScript `@plugin`/`@config` loaders are not supported
by this CSS-only rule. Compiler errors fail the action rather than emitting a
fallback stylesheet.

`celld.browser(styles = [...])` prepends global CSS artifacts in supplied order,
then appends reachable component CSS. Its indexed CSS map preserves native
component mappings at their shifted offsets. Tailwind's generated CSS occupies
an explicitly unmapped section; no utility-to-Svelte coordinates are invented.
The same packaged `/app.css` styles SSR, hydrated and JavaScript-disabled pages.




### Strict dependencies

[`webc.py`](../web/webc.py) drives the shared source actions. Celld supplies its
ambient [`types/celld.d.ts`](types/celld.d.ts) and Worker import policy;
[`imports.py`](../web/imports.py) walks native Oxc/rsvelte import facts offline and fails
when a module:

- imports a specifier that is not exported by a **direct** dependency of the
  module's own unit (declare the dependency, do not lean on a transitive one;
  a dependency written through an `alias` counts as the library it names);
- reaches a file outside its unit's `srcs` through a relative import, such as
  `../../other/src/x.ts` (import the other library's specifier instead);
- is not in the `srcs` of any unit in the closure, which keeps Buck's inputs
  complete;
- imports `npm:`, `jsr:`, `http(s):` or `node:` modules, or any builtin other
  than `cloudflare:*`.
- has a computed dynamic import, malformed source, or an unresolved literal
  edge. Code/type imports, re-exports, import-type metadata, source directives
  and literal dynamic imports all participate. Relative ownership uses real
  filesystem identities, so a symlink cannot escape declared inputs.

Before any of that, writing the config fails when two libraries of the
closure export the same specifier.

Only then does real Deno checking, testing or bundling run. Native inspection
does not replace type checking or resolution inside the Deno bundler.
Browser validation begins at `main`, follows only value edges, and reports
reachable owned client sources for CSS extraction; unrelated owned files,
unused server exports and type-only server imports are not shipped.
Pinned runtime and WASM shims have bounded origin exceptions; first-party files
never inherit trust merely by sharing a runtime directory.

`tests/lib/` retains the library chain, runtime fakes, declarations, JSON,
space-containing paths, generated sources and WASM boundaries.
`graph_test.py` exercises the driver and real Deno checker;
The web toolchain's [`native_graph_test.py`](../web/tests/native_graph_test.py)
exercises native ownership, directives, browser reachability and confinement.

### Wasm modules

A library can carry WebAssembly. `wasm` maps subpaths, like `exports`, to
`.wasm` files, and each becomes a specifier whose default export is the
compiled `WebAssembly.Module`:

```python
celld.library(
    name = "cedar",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/sec/cedar",
    wasm = {"./wasm": "third-party//by-name/ce/cedar-wasm:wasm"},
)
```

```typescript
import cedarWasm from "@celld/sec/cedar/wasm";

const instance = new WebAssembly.Instance(cedarWasm, imports);
```

The library imports its own module by name (there is no relative path to
it), and other units import it as a direct dependency, like any export. The
specifier is a module, not bytes, because that is how celld hands a Worker
its wasm: `celld.worker` keeps `import m from "./<module>.wasm"` external,
`celld.project(src = <a celld.worker>)` copies every wasm module of the
worker's closure beside `index.js`, and celld compiles each once per node
(keyed by content) and gives the Worker the `WebAssembly.Module`. The module
file name is the specifier spelled as a file name, `celld_sec_cedar_wasm.wasm`
here; two modules of one closure may not share one.

Deno (`[check]`, `celld.test`, the editor) would link a `.wasm` import as
an ES module and type it by its exports, so the config step maps each wasm
specifier to a shim beside the config instead: a source-phase import
(`import source m from "..."`), which compiles without linking and needs
no permissions, typed as `WebAssembly.Module` through `@ts-self-types`.
`tests/lib`'s `wasm` library covers both paths: `wasm-test` under Deno and
the `runtime-test` Worker under `celld dev`.

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
celld notably uses different dispatch rules for the two transports:

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
  `webc fragment` writes each one from the unit's manifest with the same
  code that writes the build's config: the closure's import map, the `lib`,
  `strict` and `types` (celld.d.ts) compiler options, and the closure's
  files. The BXL also builds those files, so a generated source exists in
  the proxy's `buck-out` when Deno follows the import map to it. A file no
  target lists is matched to its package by the build file names
  `buildfile.name` configures (`BUILD` and `BUCK` here). The proxy merges the fragments it has (a specifier two units map to
  different files is reported as a warning in the editor's log and the first
  wins), rewrites the config, and tells Deno through
  `workspace/didChangeWatchedFiles`. It remembers the files it has asked
  about and every file of the known closures, so opening a dependency's file
  asks nothing; another file of the same directory may belong to another
  unit (a library's test), so it is asked about. A lookup that fails (Buck
  busy, a broken BUILD file) is forgotten: editing or saving the document
  asks again once a delay has passed, 2 seconds doubling up to 5 minutes. It
  never queries `root//...`.
- The document being looked up reaches Deno only after Deno reports the
  reload (`deno/didChangeDenoConfiguration`), or after 15 seconds
  (`--hold`); messages about other documents are not held. Deno's report
  does not say which write it saw, so one reload is in flight at a time: the
  next lookup's write waits for the report. Writes to Deno and to the editor
  go through queues, so a peer that stops reading holds up nothing else. Deno 2.9 keeps an
  already open document's old module resolution for go-to-definition until
  that document is edited, even though it re-checks it after a reload, so an
  early open would leave navigation stale.
- The proxy registers editor watchers for the build files the root
  `.buckconfig` names, `PACKAGE` files and `.bzl` files. When one changes (or
  is saved), it forgets what it found and looks up the open documents again.
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
| `bindings` | Map of environment binding to local Durable Object class; emits SQLite migrations (see below). |
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
| `vars` | Map of string-valued environment variables. They ship with the project as plain values, so keep secrets and development-only switches out of them: put those in `.dev.vars` or deployment secrets (the example harness writes its spec `vars` there for tests). |
| `compatibility_date` | Date string, defaulting to `2026-08-20`. |
| `compatibility_flags` | Compatibility flag string list. |

Every class in `bindings` is SQLite-backed: the generated config has one
migration, tag `v1`, whose `new_sqlite_classes` lists them all. That is
complete for celld, which does not keep Wrangler's migration history.
Checked against the pinned binary (dry runs, and real deploys in sequence to
one chaos3 bucket):

- It accepts only `tag` and `new_sqlite_classes` in a step. `new_classes`,
  `renamed_classes`, `deleted_classes` and `transferred_classes` fail with
  "`celld deploy` does not support these migration keys", so a rename,
  delete or transfer is not expressible whatever the toolchain emits.
- Tags must be non-empty and unique, and a class may appear in only one
  step; beyond that they carry nothing. `v1: [A, B]` and
  `v1: [A], v2: [B]` deploy as the same content version, and a deploy is
  never compared with the bucket's current one: adding a class to `v1`,
  renaming a tag, or dropping a class are all accepted.
- A bound class in no step is served as a non-SQLite Durable Object, which
  is why every bound class is listed.
- An exported Durable Object class that is not in `bindings` gets no
  migration, so `ctx.exports` holds it as a `DurableObjectClass`: a facet
  can start from it (`ctx.facets.get(name, () => ({ class:
  ctx.exports.Child }))`) and runs in its root's isolate. A bound class is
  a namespace there and cannot start a facet.

So a history of tagged steps would change nothing celld stores, and the
project rule takes no `migrations` attribute. Dropping a class from
`bindings` removes it from the config without any `deleted_classes` check;
what celld does with that class's stored objects is its own contract.

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
`allowExperimental` remains unsupported. `WorkerLoaderCode` requires
`compatibilityDate`, and a wasm module is `{ wasm: bytes }`; bare bytes are
refused. KV writes accept byte streams, buffering them with the same 25 MiB
limit as other values.

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
containers are a shared-kernel isolation boundary: `runc`, the usual default,
is not a boundary for hostile code. Request `runsc` (gVisor) for untrusted
code and verify that it starts containers on every eligible node; on some
hosts (an ARM64 / Linux 7.0 development machine, for one) `runsc` fails at
container creation under celld, so a class that requires it must fail closed
rather than fall back to `runc`. The Buck package makes no stronger isolation
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

`:runtime-test` runs the pinned binary with `celld dev` against six fresh,
temporary projects. It checks cross-request promise-tail ownership and real
Workflow create/get, retained duplicate create/createBatch, short success/error
retention, deletion, and stale-handle behavior. The promise-tail fixture is the
original two-request `Serial` reproduction, unchanged from Orchestra's earlier
report; platform regressions now live here rather than in the application.
The native RPC fixture checks independent structured-clone arguments/results
(including typed arrays, Maps, Dates, null, and undefined), the distinct DO and
service method-visibility rules, and an acknowledged SQLite write read again
after restarting the entire dev supervisor against the same local storage.
The release fixture pins what the declarations encode: a `transactionSync()`
callback gets no argument and nests through the root handle, invalid UTF-8
`TEXT` reads as U+FFFD, a facet starts from a `ctx.exports` class (whose
`ctx.exports.Child({ props })` form sets startup `props`), a named
`DurableObjectId` keeps its name in a facet and a string ID stays a string,
`ctx.exports` holds `default` (whose `fetch()` is HTTP), entrypoints,
namespaces and classes, `WorkerCode` needs a date and wrapped wasm, a named
Dynamic Worker load is released for every stub by `dispose()`, an unfinished
`kv.list()` iterator does not block later writes, and Ed25519/X25519 work.
The WebSocket fixture pins hibernatable-socket ordering: frames keep send
order between `webSocketMessage()` and RPC (with 500 frames from each side),
and a later message runs while an earlier handler awaits. Its client is a
minimal RFC 6455 implementation in the runner, since Python's standard
library has none. [AGENTS.md](AGENTS.md#fixed) lists which upstream issue
each of these reproduces.
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

Bugs and gaps in celld itself, not in the toolchain, are catalogued in
[AGENTS.md](AGENTS.md#open) with a reproduction for each and how the
libraries cope; libraries work around them or fail with a clear error.
Upgrade steps for each release are in [AGENTS.md](AGENTS.md#release-notes).

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
