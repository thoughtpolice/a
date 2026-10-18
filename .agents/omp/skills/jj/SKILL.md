---
name: jj
description: Use Jujutsu (jj) for isolated monorepo workspaces, logical commits and stack integration, requested PR publication, upstream source research, and dependency patches. Use when squashing fixes into their source, creating or integrating experiments under work/, cloning third-party repositories, grafting upstream history, or retiring workspaces safely.
license: Apache-2.0
---

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# jj workflows

Read the topic guide matching the task, not the entire group. Follow repository
policies in `AGENTS.md`; use jj rather than Git to write repository history.

| Task | Guide |
| --- | --- |
| Create and integrate isolated monorepo experiments | [Workspaces](workspace-experiments/guide.md) |
| Inspect upstream source in a separate clone | [Third-party cloning](clone-third-party/guide.md) |
| Import upstream history and maintain dependency patches | [History grafting](graft-third-party/guide.md) |
| Shape tested commits, squash fixes, or publish a requested PR | [Commit and PR workflow](commit-and-pr/guide.md) |

Keep third-party source read-only unless the user authorizes execution. Workspaces
share history even when files are isolated; inspect bases and destination changes
before rebasing or integrating. Preserve unrelated working-copy changes.

## Resource access

Topic directories contain guides and detailed references, not nested discoverable
skills. For example, read `skill://jj/workspace-experiments/guide.md` or
`skill://jj/graft-third-party/references/troubleshooting.md`.
For Buck2 graph analysis, changed-target selection, builds, and tests, read
`skill://buck2`.
