---
name: buck2-target-determination
description: This skill should be used when determining which Buck2 targets are affected by code changes for incremental builds and tests. Use this when users ask to test/build changed code, find affected targets, or run incremental workflows with jj revisions.
---

# Buck2 Target Determination

## Overview

Target determination identifies which Buck2 targets are affected by code changes between two jj revisions. This enables incremental workflows that only build/test what changed, dramatically reducing build times (often 10-100x faster than full builds).

## When to Use This Skill

Use this skill when:
- User wants to "test what changed" or "test my changes"
- User asks to "build only affected targets"
- User requests "incremental build/test"
- Setting up CI/CD workflows that should only test affected code
- Analyzing impact of changes before committing
- User mentions `tdutil` or target determination

## How Target Determination Works

The `tdutil` tool:
1. Accepts two single-commit jj revsets (e.g., `'@-'` and `'@'`)
2. Computes file changes between those revisions
3. Builds Buck2 target graphs at both revisions
4. Identifies targets whose BUILD files or sources changed
5. Outputs sorted affected targets to stdout, or to a file with `--output`

**Critical**: Always use the `root//` cell prefix with tdutil to avoid ambiguous cell references.

## Basic Usage Pattern

```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT

# Defaults to parent (@-) versus current (@); limit the universe to src/.
buck2 run root//buck/tools/tdutil:tdutil -- \
  --output "$TARGETS_FILE" --universe depot//src/...

# Build affected targets
buck2 build "@$TARGETS_FILE"

# Test affected targets
buck2 test "@$TARGETS_FILE"
```

**Why at-file syntax (`@path`)?** Target lists can be extremely large (thousands of targets), exceeding command-line length limits. At-file syntax loads targets from a file. `mktemp` avoids collisions between concurrent workflows, and the trap removes the file when the shell exits.

## Common Revset Patterns

### Development Workflows

```bash
# Changes in current commit (most common)
buck2 run root//buck/tools/tdutil:tdutil -- depot//src/...

# Changes since trunk
buck2 run root//buck/tools/tdutil:tdutil -- \
  --from 'trunk()' --to '@' --universe depot//src/...

# Last 3 commits
buck2 run root//buck/tools/tdutil:tdutil -- \
  --from '@---' --to '@' --universe depot//src/...

# Specific commit range
buck2 run root//buck/tools/tdutil:tdutil -- \
  --from 'abc123' --to 'def456' --universe depot//src/...
```

### CI/CD Workflows

```bash
# Changes in pull request (compared to main)
buck2 run root//buck/tools/tdutil:tdutil -- --from 'trunk()' --to '@'

# Full repository scan
buck2 run root//buck/tools/tdutil:tdutil -- --from 'root()' --to '@'
```

### Scope Limiting

```bash
# Only specific directory
buck2 run root//buck/tools/tdutil:tdutil -- depot//src/myproject/...

# Multiple directories
buck2 run root//buck/tools/tdutil:tdutil -- depot//src/... depot//tools/...
```

## Complete Workflow Examples

### Pre-Commit Testing

```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT

# 1. Make changes
jj new -m "feat: implement feature"
# ... edit files ...

# 2. Find affected targets
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" --universe depot//src/...

# 3. Build affected targets
buck2 build "@$TARGETS_FILE"

# 4. Test affected targets
buck2 test "@$TARGETS_FILE"

# 5. If passing, commit
jj commit -m "feat: implement feature"
```

### Impact Analysis

```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT

# See what targets are affected
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" --universe depot//src/...

# Count affected targets
wc -l "$TARGETS_FILE"

# Show affected targets
cat "$TARGETS_FILE"

# Find which are tests
buck2 query "kind('.*_test', %Ss)" "@$TARGETS_FILE"

# Find which are binaries
buck2 query "kind('.*_binary', %Ss)" "@$TARGETS_FILE"
```

## Helper Script Usage

Use `scripts/tdutil_helper.py` for simplified invocations:

```bash
# Interactive mode - prompts for revsets
python3 scripts/tdutil_helper.py

# Quick patterns
python3 scripts/tdutil_helper.py --pattern current    # '@-' to '@'
python3 scripts/tdutil_helper.py --pattern trunk      # 'trunk()' to '@'
python3 scripts/tdutil_helper.py --pattern full       # 'root()' to '@'

# Custom revsets
python3 scripts/tdutil_helper.py --from '@---' --to '@' --scope depot//src/myproject/...

# Auto-build affected targets
python3 scripts/tdutil_helper.py --pattern current --build

# Auto-test affected targets
python3 scripts/tdutil_helper.py --pattern current --test

# Both build and test
python3 scripts/tdutil_helper.py --pattern trunk --build --test
```

The helper provides:
- Better error messages
- Target count and preview
- Optional auto-build/test
- Common pattern shortcuts
- Private temporary at-files that are retained when nonempty, with an explicit cleanup command

## Troubleshooting

### "No targets affected"

Possible causes:
- No files changed (check `jj diff`)
- Changes only to files not in any BUILD target
- Scope too narrow (expand from `depot//src/myproject/...` to `depot//src/...`)
- The working copy has not been snapshotted yet (check `jj status`)

Solution:
```bash
# Check what changed
jj diff

# Ask jj to snapshot and show the working copy
jj status

# Expand scope
buck2 run root//buck/tools/tdutil:tdutil
```

### "Could not find cell" error

The `root//` prefix is missing. Always use:

```bash
# ✓ Correct
buck2 run root//buck/tools/tdutil:tdutil -- ...

# ✗ Wrong
buck2 run //buck/tools/tdutil:tdutil -- ...
```

### Large target lists cause failures

Use at-file syntax (`@filename`) instead of passing targets directly:

```bash
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT

# ✓ Correct
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" --universe depot//src/...
buck2 test "@$TARGETS_FILE"

# ✗ Wrong (may exceed command-line limits)
buck2 test $(cat "$TARGETS_FILE")
```

## Performance Benefits

Real-world example:
```bash
# Without target determination (builds everything)
time buck2 test depot//src/...
# → 1847 actions, 15m 23s

# With target determination (1 file changed)
TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
trap 'rm -f -- "$TARGETS_FILE"' EXIT
buck2 run root//buck/tools/tdutil:tdutil -- --output "$TARGETS_FILE" --universe depot//src/...
time buck2 test "@$TARGETS_FILE"
# → 12 actions, 8.3s
# → 111x faster!
```

## Best Practices

1. **Always use `root//` prefix** - Prevents cell reference errors
2. **Use at-file syntax** - Required for large target lists
3. **Scope appropriately** - Balance coverage vs speed
4. **Include working-copy changes** - Leave snapshotting enabled when comparing to `@`
5. **Reuse one temporary output** - Keep `$TARGETS_FILE` for multiple commands in the workflow
6. **Check target count** - `wc -l "$TARGETS_FILE"` to verify results
7. **Run quality tests separately** - `depot//buck/tests/...` aren't in tdutil scope

## Resources

### scripts/tdutil_helper.py
Python helper script that wraps tdutil with common patterns and better output formatting.

### references/revset_patterns.md
Comprehensive guide to jj revset patterns for use with tdutil.
