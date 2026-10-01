<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Shape commits and publish only when requested

## 1. Inspect the current stack

From the intended workspace, inspect `jj status`, a focused `jj diff`, and
`jj log`. Use current change IDs rather than remembered commit hashes: another
actor may already have rewritten or integrated the stack. Identify the source
commit for each change and separate unrelated user edits before moving anything.

Map changes by purpose, not file size. Build/tool changes belong with their
runtime contract and behavioral coverage; docs belong with the behavior they
explain. If the tree is already integrated, do not replay obsolete commits.

## 2. Create a tested logical commit

Exercise the changed runtime path and run the relevant Buck2 verification before
committing. Use the repository's exact identity/message convention:

```bash
jj commit -m 'topic: description' --config=user.name=Claude --config=user.email=noreply@anthropic.com
```

That command includes the current revision's changes. If unrelated edits are
present, first use an explicit fileset split and select the owned revision;
record the user's original working-copy change ID and restore that workspace
revision afterward. Inspect the split boundaries; never commit an advisor config,
other task's code, or a disposable research clone merely because it is adjacent.

## 3. Fold fixes into their source

Use stable current change IDs and explicit source/destination revisions. When
both descriptions are populated, `--use-destination-message` preserves the
original source commit description rather than opening an editor:

```text
jj squash --from <tested-fix-change> --into <source-change> --use-destination-message <owned-filesets>
```

The angle-bracket values are inputs to discover, not literal revision names.
Read `jj squash --help` for the installed version. Squashing may abandon an
emptied source and rebase descendants, including other workspaces; preserve all
unrelated changes and inspect any conflicts rather than dropping them. Check
that the final tree matches the tested content and that the intended source
commit now owns the fix. Do not duplicate a test run solely because IDs changed
when the relevant tree is identical.

## 4. Publish a bookmark and PR only with user intent

Creating a commit is not authorization to push, publish private artifacts, or
post a review. Inspect remote/bookmark state first. Use `jj bookmark` and
`jj git push --bookmark <name>` for an explicitly requested publication; never
use Git to checkout, add, commit, push, or manipulate worktrees.

If a PR is requested, use the available GitHub API/tool or `gh pr create` after
checking its installed help. Include the actual change, exercised verification,
and known gaps; do not claim CI passed before observing it. Report the real PR
URL returned by the service, not a constructed or guessed URL.

## 5. Retire stale bookmarks/workspaces safely

A disappeared remote bookmark does not prove a local workspace is disposable.
Inspect `jj bookmark list`, `jj workspace list`, each candidate revision, and
its working-copy changes. Preserve wanted revisions, stop owned processes, and
obtain approval for destructive cleanup. Follow
[workspace cleanup](../workspace-experiments/guide.md); forgetting a workspace
neither integrates its changes nor deletes its files. Never translate Git's
`worktree remove --force`/branch-deletion loop into a blanket jj cleanup loop.

## Source

Recovery-first, modified jj adaptation of the portable intent in Anthropic's
Apache-2.0 [commit commands](https://github.com/anthropics/claude-plugins-official/tree/ab024cdc/plugins/commit-commands).
The original Git commands, forced worktree deletion, one-turn tool restrictions,
and automatic push/PR side effects are deliberately not ported.
