# JavaScript libraries and packages

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

Separate source identity, executable runtime and release format:

| Concern | Rule |
| --- | --- |
| Reusable declared JS/TS modules | `js.library` |

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
all package bytes are declared artifact inputs. This is not a
registry install rule.
