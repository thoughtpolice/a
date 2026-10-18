<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate Buck2 changes

Choose coverage from the change and its consumers. Do not mechanically run the
same targets at every scope, or assume `buck2 test` on a binary/library proves
behavior. Finish the implementation before broad validation; during a fix, use
the specific regression or runtime scenario for fast feedback.

## 1. Identify and exercise the changed path

Run from the repository root. Use real cell-qualified labels and discover the
package's test targets and attached tests:

```bash
buck2 targets "$PACKAGE:"
buck2 uquery "$TARGET" --output-attribute 'buck.type|tests'
```

Set `PACKAGE` to the package label without a colon/name and `TARGET` to the
actual changed target. `buck2 test` runs test providers and associated tests;
it does not turn an arbitrary binary into a test. A passing command with no
relevant tests is not coverage. For a bug, retain a failing-before/passing-after
regression when practical. For an API/feature, exercise the new behavior; for
a CLI/UI, run the actual program and observe output/state. Tests alone do not
prove that the changed runtime surface works.

## 2. Select the smallest complete test scope

| Change | Coverage to choose |
| --- | --- |
| Isolated behavior or test fix | Relevant test target(s), then package coverage if siblings/integration paths can be affected. |
| New/changed BUILD or PACKAGE | Load the package with `buck2 targets`; test its relevant targets and inherited/subpackage behavior where applicable. |
| Library/API/dependency/refactor | Changed behavior plus downstream consumers, using full target determination with a sufficient universe. |
| Shared build rules/configuration | Relevant rule/quality tests and the affected universe; a source-only selection is insufficient. |
| Documentation/skills/resources | Repository checks that own those files and any changed executable helper path; do not rebuild unrelated applications. |

Package patterns have different meanings:

```bash
buck2 test "$PACKAGE:"       # Targets in this package only
buck2 test "$PACKAGE/..."    # This package and nested packages
```

Use recursion when nested packages are relevant, not as a mandatory duplicate
of a selection that already covers them. Rust test filters/arguments can follow
`--`, for example `buck2 test "$TEST_TARGET" -- test_name --nocapture`; use the
actual framework's options for other test types.

## 3. Cover affected consumers once

Follow [target determination](../target-determination/guide.md). Its default
comparison is `fork_point(trunk() | @)` to `@`, not `@-` to `@`; choose explicit
endpoints for the task. Full mode already propagates reverse dependencies.

```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" && {
  if [ -s "$TARGETS_FILE" ]; then
    buck2 test "@$TARGETS_FILE"
  else
    printf '%s\n' 'No affected targets in the selected comparison.'
  fi
}
```

A restricted universe such as `depot//src/...` can omit consumers and
`depot//buck/tests/...`. Include quality tests that own changed rules/resources,
or use the default full root-cell universe when appropriate. Do not repeat an
rdeps test pass when full determination already covers the intended consumers.
Do not consume a partial file on selection failure.

For a manual consumer check, choose `UNIVERSE` large enough to include the
relevant consumers, then inspect:

```bash
buck2 uquery "rdeps('$UNIVERSE', '$TARGET')"
```

The result includes the starting target. Depth 1 includes only direct consumers;
transitive public API impacts need the unrestricted form. Test the relevant
returned targets with an at-file for large lists. Do not equate a rule-name
`.*_test` filter with all coverage: suites and attached tests also matter.

`buck2 test` builds the inputs it needs. Add `buck2 build` only for requested
artifacts or affected non-test targets not exercised by the chosen tests.
This catches non-test compilation failures without blanket build-then-test work.

## 4. Interpret failures and report evidence

- Fix the actual failure and update all affected callers together; do not suppress
  an error or leave intentional breakage merely documented.
- If tests pass alone but fail together, investigate shared state, resources,
  ordering, and isolation. Use the local-resources skill for managed services.
- If determination fails, inspect its endpoint/graph diagnostics. Explicitly
  testing the intended universe can provide coverage, but does not make the
  failed selection successful.
- If selection is unexpectedly empty, check `jj diff`, revisions, declared
  inputs, CI metadata, and universe. Normal tdutil snapshots working-copy edits.
- For build/runner errors, use [build troubleshooting](../build-troubleshoot/guide.md).
  For graph questions, use [query help](../query-helper/guide.md).

Report the commands actually exercised, relevant results, runtime smoke proof,
and remaining gaps/blockers. Do not claim exhaustive coverage from one test,
an empty selection, or a passing command that ran no relevant tests.
