---
name: buck2
description: Build, test, query, and debug this monorepo with Buck2. Use for changed-target selection, dependency analysis, build failures, Rust/Deno/C++ project creation, managed test resources, and repository verification.
license: Apache-2.0
---

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Buck2 workflows

Read the topic guide matching the task, not the entire group. Follow repository
policies in `AGENTS.md`; use real cell-qualified targets and the build graph.

| Task | Guide | Native OMP tool |
| --- | --- | --- |
| Create Rust, Deno, or C++ packages | [New project](new-project/guide.md) | `buck2_new_project` for Rust/Deno |
| Inspect dependencies, consumers, kinds, or attributes | [Query helper](query-helper/guide.md) | `buck2_query` |
| Select changed/affected targets using jj revisions | [Target determination](target-determination/guide.md) | `buck2_targets` |
| Diagnose an existing build failure | [Troubleshooting](build-troubleshoot/guide.md) | `buck2_build_doctor` |
| Verify changes and downstream behavior | [Test workflow](test-workflow/guide.md) | Buck2 tests and runtime smoke |
| Give tests managed processes/services/databases | [Local resources](local-resources/guide.md) | Buck2 resource rules |

## Native tools

The tools are discovered from `.omp/tools/` in fresh OMP sessions. Read
`xd://<tool-name>` for its schema, then write JSON arguments there to invoke it
when xdev is enabled; otherwise call the advertised tool directly. They use
structured parameters and return structured details, not interactive CLI prompts.
Subprocesses receive the session cwd and cancellation signal. Query and diagnostic
tools are read-only; project creation requires write approval and target actions
require execution approval.

Do not confuse a diagnostic or successful graph load with a verified build.
Use the test workflow after changing code or rules. Broaden the target-selection
universe when build metadata or downstream consumers lie outside a source package.

## Resource access

Topic directories contain guides, detailed references, and source templates, not
nested discoverable skills. For example, read `skill://buck2/query-helper/guide.md`
or `skill://buck2/target-determination/references/revset_patterns.md`.
For isolated jj workspaces or upstream source workflows, read `skill://jj`.
