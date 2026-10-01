<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Determine affected targets

Use the first-party `root//buck/tools/tdutil:tdutil` target from the repository
root. It compares real Buck graphs at two JJ revisions, selects changed inputs
and definitions, and propagates impact through head-graph reverse dependencies
(including `ci_deps`). Output contains sorted, fully qualified targets that
still exist at the head revision—not just file owners or test targets.

## 1. Choose revisions and coverage

With no arguments, tdutil compares `fork_point(trunk() | @)` to `@` over the
repository root cell (`depot//...` here). This covers branch changes through the
working copy, not only the latest commit. It asks JJ to snapshot first; leave
that enabled so edits are included.

| Question | `--from` | `--to` |
| --- | --- | --- |
| Current commit only | `'@-'` | `'@'` |
| Branch since fork point (default) | `'fork_point(trunk() | @)'` | `'@'` |
| Compare directly to current trunk | `'trunk()'` | `'@'` |
| Several commits | `'@---'` (three parent steps) | `'@'` |
| Specific revisions | A real base revset | A real head revset |

Each endpoint must resolve to exactly one commit. At a merge, `@-` may select
multiple parents; choose one explicitly. Use `jj log -r 'REVSET'` and
`jj diff --from 'BASE' --to 'HEAD'` when the chosen comparison is unclear.
`trunk()` is not the fork point when trunk has advanced since branching.

Use repeatable `--universe PATTERN` or positional target patterns to limit
coverage. `depot//src/...` excludes build tooling and quality tests under
`depot//buck/tests/...`; it is not a full-repository validation universe. Choose
coverage that includes downstream consumers, not just the changed package.

Both endpoint graphs must accept each universe pattern. For a newly added target,
use its package pattern (for example, `depot//.omp/...`), not a target label that
does not exist in the base graph.

## 2. Select once and reuse the at-file

```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT

# Default branch comparison and full root-cell universe.
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" && {
  if [ -s "$TARGETS_FILE" ]; then
    buck2 test "@$TARGETS_FILE"
  else
    printf '%s\n' 'No affected targets in the selected comparison.'
  fi
}
```

Use `--from '@-' --to '@'` for current-commit selection. Add a narrower universe
only deliberately. Use `buck2 build "@$TARGETS_FILE"` instead when the task is
building artifacts, or for affected non-test outputs not covered by the test
run. Testing already builds test inputs; do not automatically build then test
the same selection. Keep at-file syntax to avoid shell splitting and argument
length limits. Never consume the file after a failed determination.

For impact analysis, omit `--output` to print labels, or use `--format json`
(revision metadata plus target records) or `--format json-lines` (one record per
target) to inspect `rule_type`, `depth`, `reason`, and `affected_dep`.

## 3. Know the correctness boundaries

- Full mode uses both revision graphs. Changes to inputs, BUILD files, inherited
  PACKAGE files, transitive rule imports, target hashes, and CI annotations can
  select targets. Build-configuration changes select the whole requested head
  universe. CI must-match gates, skip-upstream labels, and `--depth N` can limit
  propagation; a depth limit is not exhaustive downstream coverage.
- `--quick` consults only the working-copy graph. The head must match that tree;
  it misses removed-target dependents and precise definition-hash comparisons.
  Use it for an inner loop, not as equivalent proof to full mode.
- Both historical graphs must load. Bad revsets, configuration, or graph errors
  fail the run; empty output is not a successful fallback. Fix the error or
  explicitly test the intended universe, and report the selection failure.
- `root()` is JJ's empty tree, not a Buck-configured revision. Comparing from it
  is not a reliable full-build shortcut. For full coverage, build/test the
  universe directly.
- Stop editing while selection runs if you need a stable working-copy graph.
  `--no-head-in-place` pins the head in a temporary workspace; `--keep-workspaces`
  retains historical workspaces for diagnosis, including copied local config.
- Reusable snapshots (`--base-snapshot`, `--snapshot-head-to`) and `--cache`
  can avoid base collection. Identity mismatches/misses fall back to collection;
  they do not narrow selection. See `buck/tools/tdutil/README.md` and `--help`
  for cache configuration and graph options.

## Helper and troubleshooting

Use the native OMP tool `buck2_targets` (read `xd://buck2_targets` for its schema):

```json
{"pattern": "current", "scope": "depot//...", "test": true}
```

It defaults to `depot//src/...`; `current` compares `@-` to `@`,
`trunk` compares `trunk()` to `@`, and `full` requests `root()` to `@` (subject
to the empty-tree limitation above). These are tool choices, not tdutil's
current defaults. Use both `from` and `to` for explicit endpoints instead of a
pattern. `build`, `test`, and `preview` control actions/output; there are no
interactive prompts. Results include count, preview, actions, and `targetsFile`.
Nonempty private target lists survive later build/test failure for recovery.
Empty or incomplete selections are removed; remove retained files and their
private parent directories when finished.

If selection is empty, inspect the actual JJ diff, endpoints, universe, and
whether inputs or CI annotations declare the changed files. Do not assume the
working copy was unsnapshotted: normal tdutil runs snapshot it automatically.
For cell errors use the explicit `root//` tool label and inspect cell aliases.

- [Revset patterns](references/revset_patterns.md)
- [Test workflow](../test-workflow/guide.md)
