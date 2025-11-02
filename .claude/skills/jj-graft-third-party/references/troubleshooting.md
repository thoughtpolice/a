# Troubleshooting Jj Graft Third Party

This document covers common issues when grafting third-party repositories into the monorepo.

## Common Issues

### Issue: "No such revision: <branch>@<remote>"

**Symptom:** When creating a workspace, jj reports that the branch doesn't exist.

**Cause:** The branch name doesn't match what the upstream repository uses.

**Solution:**
1. Run `jj git fetch --remote=<remote-name>` and check the output for available branches
2. Look for lines like `remote: <remote-name>/<branch-name>`
3. Use the correct branch name (common names: `main`, `master`, `trunk`, `develop`)

**Example:**
```bash
jj git fetch --remote=tokio
# Output shows: remote: tokio/main
# Use: jj workspace add --name=tokio -r main@tokio work/tokio
```

### Issue: Remote fetch fails with authentication error

**Symptom:** `jj git fetch --remote=<name>` fails with authentication or permission errors.

**Cause:** Private repository or network/auth configuration issues.

**Solution:**
1. Verify the repository URL is correct and publicly accessible
2. For private repos, ensure SSH keys or credentials are configured
3. Try cloning the repo with plain git first to verify access:
   ```bash
   git clone <repository-url> /tmp/test-clone
   rm -rf /tmp/test-clone
   ```

### Issue: Workspace creation fails with "already exists"

**Symptom:** `jj workspace add` reports that a workspace with that name already exists.

**Cause:** A workspace with the same name already exists (possibly forgotten but not removed).

**Solution:**
1. List all workspaces: `jj workspace list`
2. Either:
   - Choose a different name for the new workspace
   - Remove the existing workspace: `jj workspace forget <workspace-name>`

### Issue: Changes in workspace don't appear in main repo

**Symptom:** Commits made in the workspace aren't visible in `jj log` from the main repo.

**Cause:** This is actually expected behavior until you switch to the workspace's commits or reference them.

**Solution:**
- Changes are visible in the main repo's log, but may not be in your current view
- Use `jj log` from within the workspace to see all commits
- From the main repo, reference the workspace: `jj log -r <workspace-name>@`
- The commits exist and are tracked; workspace commits are just like any other commits in the unified history

### Issue: Unable to rebase workspace onto updated upstream

**Symptom:** `jj rebase` fails with conflicts or errors.

**Cause:** Local modifications conflict with upstream changes.

**Solution:**
1. Fetch latest upstream: `jj git fetch --remote=<remote-name>`
2. View the conflicts: `jj status`
3. Resolve conflicts manually in affected files
4. Continue the rebase: `jj rebase --continue`

### Issue: Large repository causes slow operations

**Symptom:** Fetching or working with the grafted repository is very slow.

**Cause:** The upstream repository is large (many commits, large files).

**Solution:**
1. For examination only, use `jj-clone-third-party` instead
2. If grafting is necessary, consider:
   - Using a shallow clone (though jj doesn't directly support this)
   - Fetching specific tags/commits instead of the full history
   - Only grafting when absolutely necessary for development

### Issue: Workspace forget doesn't remove directory

**Symptom:** After `jj workspace forget`, the directory still exists.

**Cause:** `jj workspace forget` only removes the workspace reference, not the files.

**Solution:**
This is expected. Remove the directory manually:
```bash
rm -rf work/<directory-name>
```

## Best Practices to Avoid Issues

### 1. Verify Repository Access First

Before grafting, verify you can access the repository:
```bash
git ls-remote <repository-url>
```

### 2. Check Branch Names

After fetching, verify available branches before creating workspace:
```bash
jj git fetch --remote=<name>
# Check output for branch names
```

### 3. Use Descriptive Workspace Names

Avoid conflicts by using descriptive, unique workspace names:
- Good: `tokio`, `tokio-testing`, `tokio-v1.0`
- Poor: `test`, `temp`, `ws`

### 4. Clean Up Regularly

Remove unused workspaces and remotes:
```bash
jj workspace list  # Check active workspaces
jj workspace forget <unused-workspace>
rm -rf work/<unused-directory>
jj git remote remove <unused-remote>  # Optional
```

### 5. Document Workspace Purpose

Keep notes on why each workspace exists and what changes it contains, especially for long-running workspaces.
