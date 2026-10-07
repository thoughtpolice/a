# JavaScript libraries and packages

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

Separate source identity, executable runtime and release format:

| Concern | Rule |
| --- | --- |
| Reusable declared JS/TS modules | `js.library` |
| Unbundled npm or Deno distribution | `js.package` |

Source libraries share `JsLibraryInfo` from `@toolchains//js:providers.bzl`.
A runtime consumer takes `deps`; a distribution takes `library`. Neither needs
an adapter library, a second source graph, nor an alias of the old web provider.

## Source libraries

```python
load("@toolchains//js:defs.bzl", "js")

js.library(
    name = "core",
    import_name = "@example/core",
    exports = {".": "src/index.ts", "./math": "src/math.ts"},
    srcs = ["src/private.ts"],
    deps = [":support"],
    visibility = ["PUBLIC"],
)
```

`import_name` and `exports` are explicit. Exported files automatically join
`srcs`; all other owned implementation files and assets must be declared.
Relative imports name exact owned files, including extensions. Other targets
can import only exported specifiers of their direct `deps`; transitive shortcuts,
private-file imports, duplicate export identities and computed imports fail.
Literal dynamic imports and live exports retain ordinary module semantics.

The default type environment is ECMAScript (`lib = ["esnext"]`), without browser,
Deno or Worker globals. TypeScript is checked; `check_js = True` opts JavaScript
into strict JSDoc checking. Set `lib`, `types` and declared runtime `externals`
when intentionally targeting a host. `[check]`, `[lint]`, `[format]`, `[config]`
and `[ide]` are available; formatting is opt-in.

Third-party code follows the same declared source contract. Pin its archive and
SHA-256 in the Buck graph, expose the required ESM files as archive subtargets,
and wrap them in `js.library` with the registry's normal bare `import_name`.
`third-party//js/clsx:library` is a concrete example shared with the Svelte
runtime package; there is one checksum-pinned archive, not a package-manager
installation or a second loader/provider.

```python
js.library(
    name = "classes",
    import_name = "@example/classes",
    exports = {".": "classes.js"},
    deps = ["third-party//js/clsx:library"],
)
# classes.js: import clsx from "clsx";
```

Owned transitive modules must be declared by the vendor library just as for
repository libraries. Type-checking and bundling keep `--no-remote --no-npm`;
all package bytes are declared artifact inputs. Release dependency constraints
are a separate, explicit decision below. This is not a registry install rule.

## Distribution

```python
js.package(
    name = "npm",
    library = ":core",
    format = "npm",
    version = "1.2.0",
    dependencies = {"@example/support": "^1.0.0"},
    declarations = True,
)
js.package(
    name = "deno",
    library = ":core",
    format = "deno",
    version = "1.2.0",
    dependencies = {"@example/support": "jsr:@example/support@^1.0.0"},
)
```

- Default output: relocatable directory with owned sources under `modules/` and
  explicit exports. Dependencies remain external, never copied or bundled.
- npm: `package.json`, ESM JavaScript with rewritten relative extensions, authored
  source maps/embedded content, and deterministic `package.tgz` via `[tarball]`.
  Filesystem-valid long/Unicode filenames are supported by normalized PAX.
- `declarations = True`: native isolated `.d.ts`/`.d.mts` for TypeScript modules;
  public exports need explicit annotations where isolated declarations require
  them. JavaScript JSDoc is preserved, not converted into synthetic declarations.
- Deno: authored JS/TS bytes and assets preserved, plus `deno.json` with exports
  and release imports. No compiler erasure or stale map-producing literal edits.
- `dependencies` must cover direct first-party dependencies and imported external
  packages. Unused mappings, undeclared first-party shortcuts and unknown exports
  fail. Build-time archive pins are not inferred as publication constraints.
- npm values are semver constraints or `npm:` aliases. Deno values are explicit
  `npm:`/`jsr:` references, or relative package directories ending in `/` for
  first-party sibling distributions produced with this module layout.
- Packages are ESM `.js`/`.mjs`/`.ts`/`.mts`, not CommonJS, JSX, compiled Svelte or
  Wasm distributions. Generated/runtime-dependent library distributions fail
  explicitly; use the runtime bundle rules for those applications. No registry
  installation, archive upload or publishing occurs in `js.package`.

`JsPackageInfo` carries `directory`, `format` and optional `tarball`. An npm
consumer supplies normal package-manager installation/resolution; a Deno
consumer references the package's exports/import map. Build/test all fixtures
through `buck2 test toolchains//js/...`.
The package consumer regression compares mapped exception coordinates with an
actual execution of the authored source, so fixture edits cannot stale a pinned
line number.
