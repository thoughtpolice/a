<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Isolate an experiment

Use a jj workspace for risky changes, alternative implementations, or long-running Buck2 operations. Files and build outputs are separate; history and repository operations are shared. Rebasing a change can affect another workspace, so isolation is not a separate repository.

## Choose the base explicitly

From the main repository root, inspect existing workspaces, choose an unused name and directory under `work/`, and verify scratch files are ignored.

```bash
jj workspace list
jj workspace add --name=experiment --sparse-patterns=full -r @ work/experiment
```

`-r @` creates a new working-copy commit above the current change, including its contents. Without `-r`, jj creates a sibling of the current working-copy commit with the same parents; it does **not** include current uncommitted edits. Use an explicit bookmark or revision for compatibility/backport tests. Sparse patterns otherwise inherit from the source workspace; `--sparse-patterns=full` avoids accidental partial checkouts.

For parallel alternatives, record a stable base revision once and pass it to each creation:

```bash
jj workspace add --name=approach-a --sparse-patterns=full -r <base-revision> work/approach-a
jj workspace add --name=approach-b --sparse-patterns=full -r <base-revision> work/approach-b
```

## Work and compare

Use tools scoped to the intended workspace. Use `cwd` or `jj -R work/experiment` explicitly for commands rather than relying on an earlier directory change. Run builds/tests through Buck2 with targets appropriate to the experiment; use the Buck2 testing and target-determination skills.

If asked to commit, verify first, run from the experiment workspace using the command tool's `cwd`, and use only the repository-required command with a conventional commit description:

```bash
jj commit -m 'topic: description' --config=user.name=Claude --config=user.email=noreply@anthropic.com
```

From the main workspace:

```bash
jj log -r 'working_copies()'
jj show approach-a@
jj diff --from approach-a@ --to approach-b@
```

`<workspace-name>@` names its current working-copy commit, not necessarily the entire experiment stack. `jj diff -r <revision>` shows that revision's changes; use `--from` and `--to` to compare two trees.

For a long-running build/test, keep that workspace unchanged while it runs, capture the actual process result, and continue development in another workspace. Do not forget or delete a workspace with live processes. Separate checkouts do not eliminate shared machine resource contention.

## Adopt the result deliberately

Inspect the experiment stack and the intended destination before integrating. Rebasing moves changes; it is not a merge and does not automatically apply the experiment to the main working copy.

```bash
jj log -r '<base-revision>..experiment@'
jj rebase -s <first-experiment-change> -d <destination-revision>
```

Use the first change to move the whole stack, not just an empty working-copy tip. Then inspect the rebased tip and choose the intended integration: for example, `jj new <rebased-tip>` from the main workspace starts work above it; `jj squash --from <single-experiment-change> --into @` folds a reviewed single change into the main working copy. These operations have different effects; do not blindly squash a stack or replace existing main work. Verify the integrated result through Buck2.

## Cleanup

Inspect changes, preserve wanted revisions with a bookmark, and stop all workspace processes. Forgetting removes only the workspace reference; it neither deletes files nor merges changes. It is not a durable archive for unreferenced revisions.

From the main repository root, after verifying the exact disposable path:

```bash
jj bookmark create experiment-result -r <revision-to-keep>
jj workspace forget experiment
rm -rf -- work/experiment
```

For rejected work, omit the retention bookmark only when nothing needs saving. Do not abandon shared changes or delete another task's checkout. If shared operations leave a workspace stale, inspect it and use `jj workspace update-stale` rather than recreating it blindly.

Use [third-party cloning](../clone-third-party/guide.md) for read-only external-source research and [history grafting](../graft-third-party/guide.md) for tracked upstream patches. Third-party source remains untrusted; its commands require permission under repository rules.
