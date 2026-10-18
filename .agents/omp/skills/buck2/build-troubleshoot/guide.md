<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Diagnose Buck2 failures

Work from the reported failure. Do not rerun a known failing command just to
confirm it, clean caches by default, or broaden the build before understanding
the error. Run commands from the repository root; set `TARGET` to the actual
cell-qualified target from the failure.

## 1. Collect the evidence

```bash
buck2 log what-failed
buck2 log what-ran
buck2 log last
```

Read the first actionable compiler, linker, Starlark, or runner error, not only
the final summary. Keep the failed target, command, exit status, and relevant
stderr. `buck2 log last` identifies the last event log; it is not a substitute
for reading the command's diagnostics.

Use the read-only OMP `buck2_build_doctor` tool to summarize the evidence:

```json
{
  "targets": ["depot//path/to:target"],
  "showLogs": true
}
```

Omit `targets` to inspect labels extracted from recent failed-action identities.
Add `checkVisibility`, `checkCache`, `checkCycles`, or `allChecks` only when
relevant. Pass actual reported error text as `diagnosticLog` when action logs do
not contain it, particularly for Starlark, target-loading, or analysis failures.
Do not pass the path printed by `buck2 log last` as diagnostic text.

The tool returns structured commands with exit statuses and captured output,
evidence, issues, suggestions, and log details. It reads `log what-failed`
JSON records and `log what-ran --failed --show-std-err` before other diagnostic
commands. `showLogs` additionally includes the parsed action records and supplied
diagnostic text; command output is always preserved as evidence.

Private visibility is an observation, not a diagnosed violation. Cache checks
inspect configuration, not artifact integrity or connectivity. Cycle checks
actually load the transitive unconfigured graph with `uquery deps(...)`: a
successful load means Buck reported no cycle in that graph, while failed loads
remain inconclusive unless Buck emits a cycle diagnostic. Configuration-specific
behavior still requires the failing build's configuration. The tool never assumes
a repository-wide target scope, builds targets, cleans caches, or kills daemons.
Failed or unsupported diagnostic commands are reported explicitly. Findings are
diagnostic evidence, not proof that a build is broken or fixed.

## 2. Inspect the smallest relevant graph

```bash
buck2 targets "$TARGET"
buck2 uquery "$TARGET" --output-attribute 'srcs|deps|visibility|buck.type'
buck2 uquery "deps('$TARGET', 1)"
```

| Failure | Check and fix |
| --- | --- |
| Target or cell missing | List the actual package with `buck2 targets "$PACKAGE:"`; inspect its BUILD and cell aliases. Use `root//buck/...` for build tooling. |
| Starlark evaluation or empty glob | Check loads, rule attributes, and package-relative source paths. Use the existing `depot.*` wrappers. |
| Rust import/module/feature error | Distinguish a missing module declaration from a missing dependency or disabled feature. Find the real third-party target; do not invent a crate label or feature syntax. |
| Visibility | Inspect the provider's visibility and allow only the required consumer scope. Do not make everything PUBLIC. |
| Dependency cycle | Read Buck's cycle trace. Query `allpaths('$FROM', '$TO')` in both directions when the graph can load; remove the cyclic dependency or extract shared code. |
| Undefined symbol | Locate the defining library, declared dependencies, ABI, and linker inputs. |
| No tests or runner failure | Inspect `buck.type` and the target's `tests` attribute; a binary/library is not itself necessarily a test. Follow the test-workflow skill. |

The [error reference](references/common_errors.md) contains additional error
patterns. Treat its example targets and environment-specific flags as examples,
not commands to run blindly; check the installed command's `--help` first.

## 3. Isolate environmental failures only when evidence points there

- For remote execution/platform failures, inspect the execution platform and
  `buck2 audit config`; declare missing inputs instead of relying on local paths.
  A targeted `buck2 build --local-only "$TARGET"` can distinguish remote from
  local execution where supported.
- For cache failures, inspect cache configuration and the reported transport or
  artifact error. Use the installed Buck2 cache controls only for the failing
  target. `buck2 clean` discards useful state; reserve it for diagnosed local
  corruption, after preserving logs.
- For daemon/lock failures, check active work before `buck2 kill`; do not kill
  unrelated processes or delete lock files blindly.
- For repeated rebuilds, inspect `buck2 log what-ran` and action inputs for
  nondeterminism, timestamps, or generated files changing in the source tree.

## 4. Prove the fix

After changing the cause, rerun the specific failed command. Use `-v 2` if the
remaining diagnostics need more detail. Exercise the changed runtime behavior,
then choose affected tests with the [test workflow](../test-workflow/guide.md).
Report the evidence, fix, verification, and any remaining blocker; do not hide
failures with `--keep-going` or treat a heuristic diagnosis as verification.
