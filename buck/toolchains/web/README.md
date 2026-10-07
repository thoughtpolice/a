# web toolchain

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

`toolchains//web/native:web` is an in-process, runtime-neutral Rust tool. It
invokes no npm, Cargo, Deno, Node, external formatter, or JavaScript compiler
subprocess. Build and test it through Buck2; `toolchains//web/native:tests`
contains boundary, malformed-source, projection, composed-map, lint and
formatting-transition regressions.

## Native executable

All native commands can be used directly without the Python driver, a runtime,
or generated configuration. The driver target is `toolchains//web:webc`.

## Compile protocol

```text
web compile --manifest inputs.json --out-dir generated
```

The manifest is strict JSON:

```json
{"files":[{"source":"/actual/artifact/Widget.svelte","name":"src/app/Widget.svelte"},{"source":"/actual/artifact/model.svelte.ts","name":"src/app/model.svelte.ts"}]}
```

`source` is a readable UTF-8 filesystem path; `name` is the stable, normalized,
slash-separated relative source name, usually Buck's complete `short_path`.
Absolute names, traversal, empty path segments and generated-output collisions
are rejected before writing. Input order is preserved. Source filenames embedded
in maps and diagnostics are `name`, not sandbox paths.

For `name = src/app/Widget.svelte`, artifacts relative to `--out-dir` are:

| Artifact | Path |
| --- | --- |
| Client JavaScript and map | `client/src/app/Widget.svelte.js`, `.js.map` |
| Server JavaScript and map | `server/src/app/Widget.svelte.js`, `.js.map` |
| Extracted CSS and map, if present | `client/src/app/Widget.svelte.css`, `.css.map`; server equivalents when emitted |
| TypeScript/TSX projection and map | `check/src/app/Widget.svelte.tsx`, `.tsx.map` |
| Analysis and projection facts | `facts/src/app/Widget.svelte.json` |

Components are prepared once, and both runtime targets share that analysis.
CSS is extracted, not injected. Projection facts include props, optionality,
bindability, exports, events and `projection.exact_mappings`; each exact mapping
has half-open UTF-8 byte ranges `source:{start,end}` and
`generated:{start,end}`. Compiler facts also expose script/style source regions,
CSS scope and legacy/runes usage.

Rune `.svelte.ts` modules have TypeScript erased by Oxc before rsvelte's
JavaScript-only `compile_module` API is called separately for client and server.
For `src/app/model.svelte.ts`, runtime files are
`client/src/app/model.svelte.js` and `server/src/app/model.svelte.js`, with maps;
`check/src/app/model.svelte.ts` retains the original checked source. `.svelte.js`
modules retain their runtime basename. Rune maps **compose** the rsvelte
transformation with the Oxc erasure map, so they refer to original TypeScript,
not an intermediate JavaScript file. Module diagnostics are remapped as well.
Module facts are at `facts/<name>.json`.

Ordinary `.ts`, `.js`, `.tsx`, `.jsx`, `.mts`, `.mjs`, `.cts` and `.cjs` inputs
are preserved verbatim as `client/<name>`, `server/<name>`, `check/<name>`.
These unchanged files need no transformation maps. This preserves relative
module resolution in every view; the driver does not pretend to type-check or
bundle them.

The command writes `manifest.json` and `diagnostics.json` at the output root and
prints the manifest report as JSON. The report is
`{schema:1,success,files:[{name,source,artifacts:[relative paths]}],diagnostics}`.
File/compiler errors produce nonzero status, with successful files still
reported; a failed file emits no partial artifacts. The output directory should
be fresh for each action: the driver does not remove stale outputs from an old
invocation. It does not commit or validate partially emitted output on a caller's
behalf.

Diagnostics contain original `path`, `severity`, `code`, `message`, optional
`start`/`end` UTF-8 byte offsets, `location`/`end_location` with one-based `line`
and zero-based UTF-16 `column`, and optional `help`. Missing source attribution
is JSON `null`, never an invented location. Runtime JS and CSS include relative
source-map URLs; projections expose a separate map and exact facts for the host's
reverse-diagnostic mapping.

## Ownership inspection

```text
web inspect src/app/main.ts src/app/Widget.svelte
```

The result is `{files:[{path,imports,references,computed_imports,comments,
diagnostics,self_types?}]}`. `imports` contains
`{specifier,kind:"code"|"type",dynamic:boolean,start,end,attributes?,phase?}`. Spans are
half-open UTF-8 bytes in the original source and include the string literal's
quotes. Module-record import/re-export entries distinguish entirely type-only
clauses from mixed value/type clauses. Oxc AST traversal captures literal runtime
dynamic imports, TypeScript import types and external import-equals references.
A computed `import(expression)` is not treated as a resolved path: it goes in
`computed_imports` as `{start,end,dynamic:true,expression}`. The ownership host
must reject or otherwise explicitly handle those entries.

Comments are preserved as `{raw,start,end}`. Import assertions/attributes retain
`attributes:{raw,start,end,values?}`; source-phase imports retain `phase:"source"`.
No-substitution template dynamic imports are literal edges, not computed ones.
Source is never rewritten by inspection. Triple-slash path/types references,
`@ts-self-types`, `@ts-types`, `@deno-types`, and JSDoc `@import`/import-type
metadata are read from actual parser comments. `references` includes the
directive kind and authored UTF-8 spans; `self_types` also exposes self-type
metadata. Ordinary comment/string lookalikes and shadowed calls are not ESM
imports.

Components' script regions are inspected with original byte offsets. The TSX
projection's exact source mappings additionally identify literal/computed imports
in template expressions, while excluding generated runtime/helper imports.
Malformed source is reported with diagnostics and nonzero status. The ownership
host must not accept a file with errors as an empty dependency list.

## Native lint and format

```text
web lint [--deny-warnings] explicit.ts Explicit.svelte
web format explicit.ts Explicit.svelte
web format --check explicit.ts Explicit.svelte
web format --write explicit.ts Explicit.svelte
```

Lint returns `{files:[{path,diagnostics}],success}`. Svelte components and rune
modules use rsvelte's native recommended template/script/module rules and
compiler diagnostics. JS/TS also uses real Oxc syntax/semantic analysis and this
explicit error-level subset of recommended correctness rules:
`constructor-super`, `no-debugger`, `no-dupe-class-members`,
`no-dupe-keys`, `no-duplicate-case`, `no-func-assign`, `no-import-assign`,
`no-setter-return`, `no-this-before-super`, `no-unreachable`, `no-unsafe-finally`,
`valid-typeof`. No JS plugin host or type-aware external lint backend is started.
Duplicate arguments are rejected by Oxc's syntax/semantic checks, not a
nonexistent linter rule in this pinned version.
Errors fail; warnings fail only with `--deny-warnings`. Native lint is independent
of any additional platform-specific lint policy selected by the web driver.

Format uses rsvelte for Svelte markup and Oxc for JS/TS. Embedded brace-based
CSS/PostCSS/SCSS/Less uses the in-process Oxc CSS formatter through a strict
callback: parser/printer failures are diagnostics, not silent preservation.
Upstream's indented Sass/Stylus bodies are preserved rather than passed to a
brace-based CSS parser. The default result is
`{files:[{path,changed,code?,diagnostics}],success}` with formatted `code`.
`--check` writes nothing and fails on changed or malformed input. `--write`
writes changed files and omits `code`; write failures are file diagnostics.
`--check` and `--write` are mutually exclusive. Formatting errors never overwrite
the source with recovered or partial output.

## Native post-bundle minification

```text
web minify --input bundle.js --output app.js \
  --input-map bundle.js.map --output-map app.js.map
```

The input is a finished ESM JavaScript bundle, independent of its bundler or
deployment runtime. Oxc parses and validates it before native compression and
local-binding mangling. Public
property names, exported bindings, function/class names, console calls and
debugger statements are retained; external import failures remain observable.
Legal comments are emitted inline.

Maps are optional; `--input-map` requires `--output-map`. The generated map
composes through the bundle map to authored UTF-16 coordinates and retains
`sources`, `sourcesContent`, `names`, `sourceRoot` and ignore-list metadata.
Unmapped code stays unmapped. A stale bundle debug ID is discarded. The output
links its map with a relative, percent-encoded URL. Keep intermediate/final maps
beside their JavaScript when retaining relative authored source paths.

Malformed input fails before either output is written. When an input map has a
matching authored segment, diagnostics use that source and location; otherwise
they retain the honest bundle location. This is not TypeScript checking.


## Pins and overlay expectations

The dependency manifest and Reindeer fixups are integration-owned under
`buck/third-party/rust`; no fetched third-party checkout is edited by this tool.
The APIs here match:

- rsvelte Git revision `5ed8ea3a3401b9fbbe780d3b18d6f90073291d6b` (facade 0.12.6),
  with the `projection` feature;
- Oxc Git revision `60fa13878c3808413268c462ddadbceaf71c38bb` across compiler,
  parser, AST, semantic, codegen, transformer, lint and formatter crates;
- `oxc_sourcemap` 8.1.2, shared with Oxc/rsvelte. Erasure maps are composed
  through its native coordinate lookup, without cloning the input map.

The Oxc umbrella needs `semantic`, `cfg`, `ast_visit`, `codegen`, `transformer`,
`minifier` and source-map-capable code generation. `rsvelte_core` is a direct dependency
for rune compilation; `rsvelte_lint` needs its `native` feature, not its CLI
feature. Formatter and linter are direct dependencies. The integration overlay
must unify all Oxc identities and preserve the pinned rsvelte_core
borrow/data-lifetime fix needed by JSDoc analysis. Compiler-generated Svelte
runtime and projection-helper imports are a toolchain-managed exception, not a
general ownership bypass; this binary does not vendor or load the JS runtime.
