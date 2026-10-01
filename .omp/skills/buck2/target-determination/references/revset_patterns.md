# JJ Revset Patterns for Target Determination

This reference provides comprehensive jj revset patterns for use with Buck2 target determination (`tdutil`).

## Basic Revset Syntax

A revset is a jj expression that selects commits. Each `tdutil` endpoint must resolve to exactly one commit.

The default comparison is `fork_point(trunk() | @)` to `@`, over `depot//...`
in this repository. Scope-only arguments keep those endpoints. Use explicit
endpoints for current-commit selection; `@-` must resolve to a single parent.

### Common Revset Symbols

- `@` - Current working copy commit
- `@-` - Parent of current commit
- `@--` - Grandparent of current commit
- `@---` - Three commits back (repeat `-` for other distances)
- `trunk()` - The trunk branch (usually `main@origin`)
- `root()` - The root commit (empty repo state)
- `'COMMIT_ID'` - Specific commit by ID

### Revset Operators

- `A..B` - Commits between A and B (exclusive of A)
- `A::B` - Commits from A to B (inclusive)
- `A | B` - Union (commits in A or B)
- `A & B` - Intersection (commits in A and B)
- `A ~ B` - Difference (commits in A but not B)

## Patterns for tdutil

### Development Workflows

#### Current Commit Changes (Most Common)
```bash
buck2 run root//buck/tools/tdutil:tdutil -- --from '@-' --to '@' --universe depot//src/...
```
Compares parent commit to current commit. Use this after making changes to test what you modified.

#### Changes Since Trunk
```bash
buck2 run root//buck/tools/tdutil:tdutil -- \
  --from 'trunk()' --to '@' --universe depot//src/...
```
Compares the current trunk tree directly to the working copy. This can include
differences caused by trunk advancing; use the default fork-point comparison
to select only branch changes since divergence.

#### Last N Commits
```bash
# Last 2 commits
buck2 run root//buck/tools/tdutil:tdutil -- '@--' '@' depot//src/...

# Last 3 commits
buck2 run root//buck/tools/tdutil:tdutil -- '@---' '@' depot//src/...

# Last 5 commits
buck2 run root//buck/tools/tdutil:tdutil -- '@-----' '@' depot//src/...
```
Compares N commits back to current. Use for testing a series of related commits.

#### Specific Commit Range
```bash
buck2 run root//buck/tools/tdutil:tdutil -- \
  --from 'abc123' --to 'def456' --universe depot//src/...
```
Compares two specific commits by their change IDs. Use for analyzing specific changes.

#### All Uncommitted Changes
```bash
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' depot//src/...
```
Since `@` is the working copy, this includes uncommitted changes; tdutil asks JJ
to snapshot the working copy before resolving it.

### CI/CD Workflows

#### Pull Request Changes
```bash
buck2 run root//buck/tools/tdutil:tdutil -- --universe depot//...
```
Uses the default fork point of trunk and the working copy as the base.

#### Full Repository Build
```bash
buck2 test depot//...
```
For full verification, test the universe directly (or build it for artifact
validation). JJ's `root()` is an empty tree without Buck configuration; it is
not a reliable historical endpoint for a full-graph comparison.

#### Release Branch Changes
```bash
buck2 run root//buck/tools/tdutil:tdutil -- 'release-v1.0' '@' depot//...
```
Compares release branch to current. Use to see what changed since last release.

### Advanced Patterns

#### Multiple Branches
```bash
# Compare feature branch to develop branch
buck2 run root//buck/tools/tdutil:tdutil -- 'develop@origin' '@' depot//src/...
```

#### Specific Commit to Working Copy
```bash
buck2 run root//buck/tools/tdutil:tdutil -- 'abc123' '@' depot//src/...
```
Compares a specific commit to your current work.

#### Between Two Remote Branches
```bash
buck2 run root//buck/tools/tdutil:tdutil -- 'main@origin' 'develop@origin' depot//...
```
Compares two remote branches.

## Scope Patterns

### Directory Scopes

```bash
# Only src/ directory
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' depot//src/...

# Specific subdirectory
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' depot//src/myproject/...

# Multiple directories
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' depot//src/... depot//tools/...

# Everything in repository
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' depot//...
```

### Cell-Specific Scopes

```bash
# Only third-party dependencies
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' third-party//...

# Only toolchains
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' toolchains//...

# Main code only (no third-party)
buck2 run root//buck/tools/tdutil:tdutil -- '@-' '@' depot//src/...
```

## Common Use Cases

### Pre-Commit Testing
```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
# Test what you're about to commit
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" '@-' '@' depot//src/...
buck2 test "@$TARGETS_FILE"
```

### Feature Branch Review
```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
# See all changes in feature branch vs main
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" --universe depot//src/...
buck2 build "@$TARGETS_FILE"
```

### Impact Analysis
```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
# What's affected by a specific commit?
buck2 run root//buck/tools/tdutil:tdutil -- \
  --output "$TARGETS_FILE" --from 'abc123-' --to 'abc123'
cat "$TARGETS_FILE"
```

### Incremental CI
```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
# In CI, test only PR changes
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" --universe depot//...
buck2 test "@$TARGETS_FILE"
```

## Troubleshooting Revsets

### "Revset not found" Errors

```bash
# Simple symbols work unquoted, but complex revsets can be parsed by the shell.
buck2 run root//buck/tools/tdutil:tdutil -- @- @ depot//src/...

# Consistently quote revsets and use named endpoints in automation.
buck2 run root//buck/tools/tdutil:tdutil -- \
  --from 'trunk()' --to '@' --universe depot//src/...
```

### Empty Revset Results

If tdutil returns no targets:
- Verify endpoints separately: `jj log -r '@-'` and `jj log -r '@'`; each must select one commit.
- Check what changed: `jj diff --from '@-' --to '@'`
- Normal tdutil snapshots the working copy; use `jj status` to inspect it, not as a required prerequisite.
- Expand scope: `depot//src/...` → `depot//...`

### Working with Bookmarks

```bash
# Compare current to a bookmark
buck2 run root//buck/tools/tdutil:tdutil -- 'feature-branch' '@' depot//src/...

# Compare two bookmarks
buck2 run root//buck/tools/tdutil:tdutil -- 'main' 'feature-branch' depot//src/...
```

## Best Practices

1. **Always quote revsets** - Shell parsing can break unquoted revsets
2. **Test revsets first** - Use `jj log -r 'REVSET'` to verify
3. **Choose a sufficient universe** - Include downstream consumers; a source-only scope omits build tooling and quality tests.
4. **Include working-copy changes** - Leave snapshotting enabled when comparing to `@`
5. **Use the fork point for branch changes** - The default excludes unrelated changes from an advanced trunk.
6. **Reuse one temporary output** - Keep `$TARGETS_FILE` for multiple commands in the workflow

## Quick Reference Table

| Use Case | Pattern | Example |
|----------|---------|---------|
| Current changes | `'@-' '@'` | Test uncommitted work |
| Branch changes | `'fork_point(trunk() | @)' '@'` (default) | PR or feature branch |
| Last N commits | N repeated `-` signs | `'@---' '@'` for last 3 |
| Specific range | `'abc' 'def'` | Between two commits |
| Full validation | `buck2 test depot//...` | Test the universe directly |
| Since release | `'v1.0' '@'` | Changes since tag |

## Examples with Real Workflows

### Daily Development
```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT

# Morning: sync with main
jj git fetch
jj rebase -d 'trunk()'

# Work on feature
jj new -m "feat: implement auth"
# ... code ...

# Test your changes
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" '@-' '@' depot//src/...
buck2 test "@$TARGETS_FILE"

# More changes
# ... code ...
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" '@-' '@' depot//src/...
buck2 test "@$TARGETS_FILE"

# Final test before committing
jj commit -m 'topic: description' --config=user.name=Claude --config=user.email=noreply@anthropic.com
```

### Code Review
```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT

# Reviewer checks out PR
jj git fetch
jj new pr-branch@origin

# See what changed
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" --universe depot//src/...

# Analyze affected targets
cat "$TARGETS_FILE"
wc -l "$TARGETS_FILE"

# Build and test
buck2 build "@$TARGETS_FILE"
buck2 test "@$TARGETS_FILE"
```

### Release Testing
```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT

# Compare release branch to current state
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" 'release-v2.0' 'trunk()' depot//...

# Full test suite on changes
buck2 test "@$TARGETS_FILE"

# Build release artifacts
buck2 build "@$TARGETS_FILE" @mode//release
```

## Further Reading

- jj documentation: https://jj-vcs.github.io/jj/latest/revsets/
- Repository jj docs: `docs/jj.md`
- Repository Buck2 docs: `docs/buck2.md`
