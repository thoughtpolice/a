<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Query the Buck2 graph

Run from the repository root. Choose the smallest universe that contains the
consumers you need to inspect; widen it when the question crosses packages or
cells. Use explicit labels: `depot//` for repository code, `root//buck/...` for
build tooling, and `third-party//` for external dependencies.

## Choose the query

Set `TARGET` to an existing target, `UNIVERSE` to the relevant target pattern,
and `FROM`/`TO` or `FILE` when needed. Discover names with `buck2 targets`
instead of assuming a directory's default target exists.

```bash
# Package targets versus recursive subtree targets
buck2 targets "$PACKAGE:"
buck2 targets "$PACKAGE/..."

# Direct dependencies (depth 1); both forms include the starting target
buck2 uquery "deps('$TARGET', 1)"
buck2 uquery "deps('$TARGET')"

# Reverse dependencies: universe first, target second; includes the target
buck2 uquery "rdeps('$UNIVERSE', '$TARGET', 1)"
buck2 uquery "rdeps('$UNIVERSE', '$TARGET')"

# Inspect attributes and rule types
buck2 uquery "$TARGET" --output-attribute 'srcs|deps|visibility|buck.type|tests'
buck2 uquery "kind('.*_test', '$UNIVERSE')"

# Find owners and dependency paths
buck2 uquery "owner('$FILE')"
buck2 uquery "allpaths('$FROM', '$TO')"
```

`uquery` examines the unconfigured graph; configuration-dependent questions
need `cquery` with the same platform/configuration as the failing build.
`allpaths` returns the targets on paths, not an ordered chain or shortest path.
An empty owner result does not prove a file cannot affect a build: imports,
PACKAGE metadata, configuration, and CI annotations can also matter.

## Combine sets and inspect output

Quote the full query so the shell does not interpret its operators.

```bash
# Third-party dependencies of a target
buck2 uquery "deps('$TARGET') ^ third-party//..."

# Exclude the starting target when counting consumers
buck2 uquery "rdeps('$UNIVERSE', '$TARGET') - '$TARGET'"

# Attribute patterns are regexes; JSON alone does not select all attributes
buck2 uquery "$TARGET" --output-attribute '.*' --json
buck2 uquery "deps('$TARGET', 1)" --output-attribute 'buck.type|deps' --json

# Graphviz output for relationships, not ordered text paths
buck2 uquery "deps('$TARGET', 2)" --dot
```

Use `+` for union, `^` for intersection, and `-` for difference. Attribute filters
inspect declared metadata, not source-level usage or actual visibility access.
Rule-type filters are a useful starting point, but not every runnable test has
an `_test` type: attached tests, suites, and test subtargets also matter.

## Native query tool

Use `buck2_query` for structured results. It runs `buck2 uquery` in the session's
working directory and has read approval. Pass labels and target patterns
literally, without shell quotes or query operators; use direct queries above
when composing arbitrary set expressions.

```json
{"operation":"deps","target":"depot//src/lib:common","depth":1,"showKind":true,"exclude":"third-party//..."}
{"operation":"rdeps","target":"depot//src/lib:common","scope":"depot//src/...","explain":true}
{"operation":"kind","pattern":"rust_.*","scope":"depot//src/..."}
{"operation":"attrs","target":"depot//src/lib:common","fields":"srcs|deps"}
{"operation":"path","fromTarget":"depot//src/tools:mytool","toTarget":"depot//src/lib:common"}
{"operation":"cycles","scope":"depot//src/..."}
```

Adapt these illustrative labels to existing targets. Required and optional
arguments depend on `operation`; irrelevant arguments are rejected:

| Operation | Required arguments | Optional arguments | Result details |
| --- | --- | --- | --- |
| `deps` | `target` | `depth`, `showKind`, `exclude` | `targets`; `kinds` when requested |
| `rdeps` | `target` | `scope` (default `//...`), `depth`, `showKind`, `exclude`, `explain` | `targets`, optional `kinds`, optional `explanations` |
| `kind` | `pattern`, `scope` | — | `targets` matching the rule-type regex |
| `attrs` | `target` | `fields` | `attributes`, a target-label-to-attributes JSON object |
| `path` | `fromTarget`, `toTarget` | — | `targets`, `pathExists`, and explicit unordered-set semantics |
| `cycles` | `scope` | — | `status: "no_cycles"` and `checkedTargets` after successful graph loading |

Every result includes `operation` and the executed `query`.

- `deps`/`rdeps` are transitive when `depth` is omitted. Depth must be a
  non-negative integer: `0` includes only starting targets; `1` includes
  immediate neighbors. Both include starting targets before subtraction.
  `exclude` subtracts a literal target pattern, not a query expression.
- `showKind` fetches `buck.type` metadata in the same query, rather than
  querying each result separately. It can be combined with `explain`.
- `explain` returns one `{target, pathTargets}` entry per consumer, excluding
  starting labels. Each `pathTargets` is the complete unordered `allpaths`
  target set, not an ordered chain or a truncated sample. This performs one
  additional query per consumer plus one to resolve the starting labels;
  choose a narrow universe for large graphs.
- `attrs` requests all attributes with `.*` when `fields` is omitted.
  `fields` is an attribute-name regex such as `srcs|deps`, not a comma-separated
  list. JSON is always parsed into structured attributes.
- `path` reports `pathExists: false` and an empty target set when no path
  exists. With multiple source/destination labels, it returns the union of
  targets on all connecting paths, not an ordered or shortest path.
- `cycles` actually loads `deps(scope)`, including dependencies outside the
  selected scope. Buck2 reports dependency cycles during graph loading.
  Success reports no cycles in that loaded unconfigured graph; cycles and
  other Buck2 failures propagate as errors rather than a fabricated success.
  This does not validate every configured platform graph.

Subprocess errors and cancellation propagate. There are no display-only
`verbose`, `raw`, `json`, or redundant `transitive` arguments.

The [pattern reference](references/query_patterns.md) offers more examples.
Adapt its illustrative labels to real repository targets, and check installed
Buck2 help for environment-specific options.

For changed-code impact, use [target determination](../target-determination/guide.md)
instead of parsing `jj diff --stat` or repeating rdeps for every affected target.
For validation, follow the [test workflow](../test-workflow/guide.md).
