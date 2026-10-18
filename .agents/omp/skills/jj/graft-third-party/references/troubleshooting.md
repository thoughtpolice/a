<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Troubleshooting Jj Graft Third Party

This document covers common issues when grafting third-party repositories into the monorepo.

## Common Issues

### Issue: "No such revision: <branch>@<remote>"

**Symptom:** When creating a workspace, jj reports that the branch doesn't exist.

**Cause:** The branch name doesn't match what the upstream repository uses.

**Solution:**
1. Run `jj git fetch --remote=<remote-name>`.
2. List remote bookmarks with `jj bookmark list --remote=<remote-name>`.
3. Use the correct branch name (common names: `main`, `master`, `trunk`, `develop`)

**Example:**
```bash
jj git fetch --remote=tokio
# Verify main@tokio with: jj bookmark list --remote=tokio
# Use: jj workspace add --name=tokio -r main@tokio work/tokio
```

### Issue: Remote fetch fails with authentication error

**Symptom:** `jj git fetch --remote=<name>` fails with authentication or permission errors.

**Cause:** Private repository or network/auth configuration issues.

**Solution:**
1. Verify the repository URL is correct and publicly accessible
2. For private repos, ensure SSH keys or credentials are configured
3. Retry with `jj git fetch --remote=<name>` after fixing access. Do not use Git to write repositories or run commands inside third-party source without permission.

### Issue: Workspace creation fails with "already exists"

**Symptom:** `jj workspace add` reports that a workspace with that name already exists.

**Cause:** The workspace name is registered, or the destination directory already exists.

**Solution:**
1. List all workspaces: `jj workspace list`
2. Choose a fresh name and destination. Do not overwrite an existing directory.
3. If retiring an old workspace, inspect and preserve its changes before forgetting it; forgetting does not remove its directory.

### Issue: Changes in workspace don't appear in main repo

**Symptom:** Commits made in the workspace aren't visible in `jj log` from the main repo.

**Cause:** This is actually expected behavior until you switch to the workspace's commits or reference them.

**Solution:**
- Changes are visible in the main repo's log, but may not be in your current view
- Use `jj log -r 'ancestors(@)'` from within the workspace to inspect its ancestry.
- From the main repo, reference the workspace: `jj log -r <workspace-name>@`
- The commits exist and are tracked; workspace commits are just like any other commits in the unified history

### Issue: Unable to rebase workspace onto updated upstream

**Symptom:** `jj rebase` fails with conflicts or errors.

**Cause:** Local modifications conflict with upstream changes.

**Solution:**
1. Fetch latest upstream: `jj git fetch --remote=<remote-name>`.
2. Inspect the error. jj records conflicts in commits; there is no `jj rebase --continue`.
3. Inspect the affected local revision with `jj show <revision>`. With permission to operate in third-party source, use `jj -R work/<directory> status` and resolve affected files there.
4. Snapshot resolved files with `jj -R work/<directory> status`; inspect the diff and run the permitted Buck2 verification.

### Issue: Large repository causes slow operations

**Symptom:** Fetching or working with the grafted repository is very slow.

**Cause:** The upstream repository is large (many commits, large files).

**Solution:**
1. For examination only, use the [third-party cloning guide](../../clone-third-party/guide.md) instead
2. If grafting is necessary, consider:
   - Limiting refs with `jj git fetch --remote=<name> --branch=<branch>` (this still fetches that branch's ancestry)
   - Fetching a known tag with `--tag=<tag>`; resolve its imported revision rather than assuming `<tag>@<remote>` syntax
   - Only grafting when absolutely necessary for development

### Issue: Workspace forget doesn't remove directory

**Symptom:** After `jj workspace forget`, the directory still exists.

**Cause:** `jj workspace forget` only removes the workspace reference, not the files.

**Solution:**
This is expected. First preserve wanted revisions with a bookmark, stop workspace processes, and verify the exact disposable directory from the main repository root:
```bash
rm -rf work/<directory-name>
```

## Best Practices to Avoid Issues

### 1. Verify Repository Access First

From the main repository root, verify access without writing with Git:
```bash
git ls-remote <repository-url>
```

### 2. Check Branch Names

After fetching, verify available branches before creating workspace:
```bash
jj git fetch --remote=<name>
jj bookmark list --remote=<name>
```

### 3. Use Descriptive Workspace Names

Avoid conflicts by using descriptive, unique workspace names:
- Good: `tokio`, `tokio-testing`, `tokio-v1.0`
- Poor: `test`, `temp`, `ws`

### 4. Clean Up Regularly

Inspect changes and preserve wanted revisions with bookmarks before forgetting. Stop processes and verify each disposable directory before deleting it; removing a remote is optional:
```bash
jj workspace list  # Check active workspaces
jj workspace forget <unused-workspace>
rm -rf work/<unused-directory>
jj git remote remove <unused-remote>  # Optional
```

### 5. Document Workspace Purpose

Keep notes on why each workspace exists and what changes it contains, especially for long-running workspaces.
