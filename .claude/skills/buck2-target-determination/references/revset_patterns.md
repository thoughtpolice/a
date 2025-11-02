# JJ Revset Patterns for Target Determination

This reference provides comprehensive jj revset patterns for use with Buck2 target determination (`quicktd`).

## Basic Revset Syntax

A revset is a jj expression that selects one or more commits. The `quicktd` tool accepts two revsets to define a range.

### Common Revset Symbols

- `@` - Current working copy commit
- `@-` - Parent of current commit
- `@--` - Grandparent of current commit
- `@-N` - N commits back from current
- `trunk()` - The trunk branch (usually `main@origin`)
- `root()` - The root commit (empty repo state)
- `'COMMIT_ID'` - Specific commit by ID

### Revset Operators

- `A..B` - Commits between A and B (exclusive of A)
- `A::B` - Commits from A to B (inclusive)
- `A | B` - Union (commits in A or B)
- `A & B` - Intersection (commits in A and B)
- `A ~ B` - Difference (commits in A but not B)

## Patterns for quicktd

### Development Workflows

#### Current Commit Changes (Most Common)
```bash
buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/...
```
Compares parent commit to current commit. Use this after making changes to test what you modified.

#### Changes Since Trunk
```bash
buck2 run root//buck/tools/quicktd -- 'trunk()' '@' depot//src/...
```
Compares trunk (main branch) to current commit. Use this to see all changes in your branch.

#### Last N Commits
```bash
# Last 2 commits
buck2 run root//buck/tools/quicktd -- '@--' '@' depot//src/...

# Last 3 commits
buck2 run root//buck/tools/quicktd -- '@---' '@' depot//src/...

# Last 5 commits
buck2 run root//buck/tools/quicktd -- '@-----' '@' depot//src/...
```
Compares N commits back to current. Use for testing a series of related commits.

#### Specific Commit Range
```bash
buck2 run root//buck/tools/quicktd -- 'abc123' 'def456' depot//src/...
```
Compares two specific commits by their change IDs. Use for analyzing specific changes.

#### All Uncommitted Changes
```bash
buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/...
```
Since `@` is the working copy, this shows uncommitted changes. Files must be in jj's view (run `jj status` to verify).

### CI/CD Workflows

#### Pull Request Changes
```bash
buck2 run root//buck/tools/quicktd -- 'trunk()' '@' depot//...
```
Compares PR branch to main. Use in CI to test only PR changes.

#### Full Repository Build
```bash
buck2 run root//buck/tools/quicktd -- 'root()' '@' depot//...
```
Compares empty repo to current state. Effectively builds everything. Use for full verification.

#### Release Branch Changes
```bash
buck2 run root//buck/tools/quicktd -- 'release-v1.0' '@' depot//...
```
Compares release branch to current. Use to see what changed since last release.

### Advanced Patterns

#### Multiple Branches
```bash
# Compare feature branch to develop branch
buck2 run root//buck/tools/quicktd -- 'develop@origin' '@' depot//src/...
```

#### Specific Commit to Working Copy
```bash
buck2 run root//buck/tools/quicktd -- 'abc123' '@' depot//src/...
```
Compares a specific commit to your current work.

#### Between Two Remote Branches
```bash
buck2 run root//buck/tools/quicktd -- 'main@origin' 'develop@origin' depot//...
```
Compares two remote branches.

## Scope Patterns

### Directory Scopes

```bash
# Only src/ directory
buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/...

# Specific subdirectory
buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/myproject/...

# Multiple directories
buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/... depot//tools/...

# Everything in repository
buck2 run root//buck/tools/quicktd -- '@-' '@' depot//...
```

### Cell-Specific Scopes

```bash
# Only third-party dependencies
buck2 run root//buck/tools/quicktd -- '@-' '@' third-party//...

# Only toolchains
buck2 run root//buck/tools/quicktd -- '@-' '@' toolchains//...

# Main code only (no third-party)
buck2 run root//buck/tools/quicktd -- '@-' '@' root//src/...
```

## Common Use Cases

### Pre-Commit Testing
```bash
# Test what you're about to commit
TARGETS=$(buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/...)
buck2 test @$TARGETS
```

### Feature Branch Review
```bash
# See all changes in feature branch vs main
TARGETS=$(buck2 run root//buck/tools/quicktd -- 'trunk()' '@' depot//src/...)
buck2 build @$TARGETS
```

### Impact Analysis
```bash
# What's affected by a specific commit?
TARGETS=$(buck2 run root//buck/tools/quicktd -- 'abc123^' 'abc123' depot//...)
cat $TARGETS
```

### Incremental CI
```bash
# In CI, test only PR changes
TARGETS=$(buck2 run root//buck/tools/quicktd -- 'trunk()' '@' depot//...)
buck2 test @$TARGETS
```

## Troubleshooting Revsets

### "Revset not found" Errors

```bash
# ✗ Wrong: Single quotes in shell need escaping
buck2 run root//buck/tools/quicktd -- @- @ depot//src/...

# ✓ Correct: Quote revsets
buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/...
```

### Empty Revset Results

If quicktd returns no targets:
- Verify revsets resolve: `jj log -r '@-' -r '@'`
- Check what changed: `jj diff -r '@-..@'`
- Ensure files are committed: `jj status`
- Expand scope: `depot//src/...` → `depot//...`

### Working with Bookmarks

```bash
# Compare current to a bookmark
buck2 run root//buck/tools/quicktd -- 'feature-branch' '@' depot//src/...

# Compare two bookmarks
buck2 run root//buck/tools/quicktd -- 'main' 'feature-branch' depot//src/...
```

## Best Practices

1. **Always quote revsets** - Shell parsing can break unquoted revsets
2. **Test revsets first** - Use `jj log -r 'REVSET'` to verify
3. **Start narrow** - Use `depot//src/myproject/...` then expand if needed
4. **Commit before testing** - Buck2 only sees committed changes
5. **Use trunk() for branches** - More reliable than hardcoding `main@origin`
6. **Cache the output** - Store `$TARGETS` to reuse across multiple commands

## Quick Reference Table

| Use Case | Pattern | Example |
|----------|---------|---------|
| Current changes | `'@-' '@'` | Test uncommitted work |
| Branch changes | `'trunk()' '@'` | PR or feature branch |
| Last N commits | `'@-N' '@'` | `'@---' '@'` for last 3 |
| Specific range | `'abc' 'def'` | Between two commits |
| Full build | `'root()' '@'` | Everything from scratch |
| Since release | `'v1.0' '@'` | Changes since tag |

## Examples with Real Workflows

### Daily Development
```bash
# Morning: sync with main
jj git fetch
jj rebase -d trunk()

# Work on feature
jj new -m "feat: implement auth"
# ... code ...

# Test your changes
TARGETS=$(buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/...)
buck2 test @$TARGETS

# More changes
# ... code ...
TARGETS=$(buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/...)
buck2 test @$TARGETS

# Final test before committing
jj commit -m "feat: implement authentication"
```

### Code Review
```bash
# Reviewer checks out PR
jj git fetch
jj new pr-branch@origin

# See what changed
TARGETS=$(buck2 run root//buck/tools/quicktd -- 'trunk()' '@' depot//src/...)

# Analyze affected targets
cat $TARGETS
wc -l $TARGETS

# Build and test
buck2 build @$TARGETS
buck2 test @$TARGETS
```

### Release Testing
```bash
# Compare release branch to current state
TARGETS=$(buck2 run root//buck/tools/quicktd -- 'release-v2.0' 'trunk()' depot//...)

# Full test suite on changes
buck2 test @$TARGETS

# Build release artifacts
buck2 build @$TARGETS @mode//release
```

## Further Reading

- jj documentation: https://jj-vcs.github.io/jj/latest/revsets/
- Repository jj docs: `docs/jj.md`
- Repository Buck2 docs: `docs/buck2.md`
