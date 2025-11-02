# Buck2 Query Patterns Reference

Common query patterns and examples for Buck2 dependency analysis.

## Basic Query Syntax

### Target Patterns

```bash
# Single target
//src/lib:mylib

# All targets in package
//src/lib:

# All targets recursively
//src/...

# Pattern matching by name
//src/...:test    # All targets named 'test'
```

### Query Functions

#### deps() - Dependencies

```bash
# All dependencies (transitive)
buck2 query "deps('//src/tools:mytool')"

# Direct dependencies only
buck2 query "deps('//src/tools:mytool', 1)"

# Limit depth to 2 levels
buck2 query "deps('//src/tools:mytool', 2)"
```

#### rdeps() - Reverse Dependencies

```bash
# What depends on this target (universe = all)
buck2 query "rdeps('//...', '//src/lib:common')"

# Within specific scope
buck2 query "rdeps('//src/...', '//src/lib:common')"

# Direct reverse deps only
buck2 query "rdeps('//src/...', '//src/lib:common', 1)"
```

#### kind() - Filter by Type

```bash
# Exact match
buck2 query "kind('rust_binary', '//src/...')"

# Regex pattern
buck2 query "kind('rust_.*', '//src/...')"
buck2 query "kind('.*_test', '//src/...')"
```

#### attrfilter() - Filter by Attribute

```bash
# By visibility
buck2 query "attrfilter(visibility, PUBLIC, //src/...)"

# By source file
buck2 query "attrfilter(srcs, main.rs, //src/...)"

# By dependency
buck2 query "attrfilter(deps, '//third-party//.*', //src/...)"
```

#### owner() - Find Target Owning Files

```bash
# Single file
buck2 query "owner('src/lib/foo.rs')"

# Multiple files
buck2 query "owner('src/lib/foo.rs') + owner('src/lib/bar.rs')"
```

#### allpaths() - Dependency Paths

```bash
# All paths from A to B
buck2 query "allpaths('//src/app', '//src/lib:common')"

# Shortest path
buck2 query "allpaths('//src/app', '//src/lib:common')" --output-attribute= | head -1
```

## Set Operations

### Union (+)

```bash
# Combine two sets
buck2 query "//src/lib:... + //src/tools:..."

# All targets in multiple packages
buck2 query "//src/lib/a:... + //src/lib/b:... + //src/lib/c:..."
```

### Intersection (^)

```bash
# Dependencies that are third-party
buck2 query "deps('//src/tools:mytool') ^ //third-party/..."

# Rust binaries in tools
buck2 query "kind('rust_binary', '//...') ^ //src/tools/..."
```

### Difference (-)

```bash
# All targets except tests
buck2 query "//src/... - kind('.*_test', '//src/...')"

# Dependencies excluding third-party
buck2 query "deps('//src/app') - //third-party/..."
```

## Common Patterns

### Find All Tests

```bash
# All test targets
buck2 query "kind('.*_test', '//src/...')"

# Tests for specific target
buck2 query "rdeps('//src/...', '//src/lib:mylib') ^ kind('.*_test', '//src/...')"
```

### Analyze Third-Party Dependencies

```bash
# All third-party deps used by src
buck2 query "deps('//src/...') ^ //third-party/..."

# Count third-party deps per target
for t in $(buck2 targets //src/tools:); do
  count=$(buck2 query "deps('$t') ^ //third-party/..." | wc -l)
  echo "$count $t"
done | sort -rn
```

### Find Unused Targets

```bash
# Targets with no reverse dependencies
# (might be unused or entry points)
for t in $(buck2 targets //src/lib:); do
  rdeps=$(buck2 query "rdeps('//src/...', '$t')" | wc -l)
  if [ $rdeps -eq 1 ]; then  # Only itself
    echo "Possibly unused: $t"
  fi
done
```

### Visibility Analysis

```bash
# All PUBLIC targets
buck2 query "attrfilter(visibility, PUBLIC, //src/...)"

# Targets visible to specific package
buck2 query "attrfilter(visibility, '//src/apps/.*', //src/lib/...)"
```

### Dependency Depth Analysis

```bash
# Targets with shallow dep trees (depth 1)
for t in $(buck2 targets //src/lib:); do
  count=$(buck2 query "deps('$t', 1)" | wc -l)
  echo "$count $t"
done | sort -n

# Targets with deep dep trees
for t in $(buck2 targets //src/lib:); do
  count=$(buck2 query "deps('$t')" | wc -l)
  echo "$count $t"
done | sort -rn | head -10
```

### Find Circular Dependencies

```bash
# Buck2 will error on circular deps during build
# To investigate specific paths:
buck2 query "allpaths('//src/lib:a', '//src/lib:b')"
buck2 query "allpaths('//src/lib:b', '//src/lib:a')"

# If both return results, there's a cycle
```

### Refactoring Impact Analysis

```bash
# What breaks if I remove this target?
buck2 query "rdeps('//src/...', '//src/lib:old-api')"

# What breaks if I change this file?
buck2 query "rdeps('//src/...', owner('src/lib/api.rs'))"
```

### Find Targets by Source Files

```bash
# Targets using specific file
buck2 query "attrfilter(srcs, config.json, //src/...)"

# Targets in src directory with main.rs
buck2 query "attrfilter(srcs, main.rs, //src/...)"
```

## Output Formatting

### Default Output

```bash
# List of targets (one per line)
buck2 query "deps('//target')"
```

### JSON Output

```bash
# Structured JSON
buck2 query "deps('//target')" --json

# Pretty print with jq
buck2 query "deps('//target')" --json | jq
```

### Attribute Output

```bash
# Show specific attributes
buck2 query "deps('//target')" --output-attribute srcs

# Multiple attributes
buck2 query "deps('//target')" --output-attribute srcs,deps,visibility

# All attributes
buck2 query "//target" --json
```

### Graphviz Output

```bash
# Generate dependency graph
buck2 query "deps('//src/app')" --dot > deps.dot
dot -Tpng deps.dot > deps.png

# Reverse dependency graph
buck2 query "rdeps('//src/...', '//src/lib:common', 2)" --dot > rdeps.dot
dot -Tpng rdeps.dot > rdeps.png
```

## Advanced Patterns

### Combine Multiple Operations

```bash
# Rust binaries that depend on specific lib
buck2 query "kind('rust_binary', deps(rdeps('//src/...', '//src/lib:common')))"

# Third-party deps of all tests
buck2 query "deps(kind('.*_test', '//src/...')) ^ //third-party/..."
```

### Filter Chain

```bash
# PUBLIC Rust libraries in src/lib
buck2 query "kind('rust_library', '//src/lib/...') ^ attrfilter(visibility, PUBLIC, '//src/lib/...')"
```

### Dependency Analysis Pipeline

```bash
# Find targets with most dependencies
for t in $(buck2 targets //src/lib:); do
  echo "$(buck2 query "deps('$t')" | wc -l) $t"
done | sort -rn | head -20

# Find most depended-on targets
for t in $(buck2 targets //src/lib:); do
  echo "$(buck2 query "rdeps('//src/...', '$t')" | wc -l) $t"
done | sort -rn | head -20
```

### Target Metadata Extraction

```bash
# Extract all source files from target
buck2 query "//target" --output-attribute srcs --json | \
  jq -r '.[].srcs | .[]'

# Extract all deps with their types
buck2 query "deps('//target', 1)" --output-attribute buck.type --json | \
  jq -r '.[] | "\(.name) [\(."buck.type")]"'
```

## Performance Tips

1. **Narrow scope early**: Use `//src/lib/...` instead of `//...`
2. **Limit depth**: Use depth parameters to avoid deep traversal
3. **Cache results**: Save query output for reuse
4. **Use JSON for parsing**: More reliable than text parsing
5. **Combine queries**: Use set operations instead of multiple calls

## Common Mistakes

### Missing Quotes

```bash
# Wrong - shell will interpret special chars
buck2 query deps('//target')

# Right - quote the entire query
buck2 query "deps('//target')"
```

### Wrong Scope Format

```bash
# Wrong - missing colon
buck2 query //src/lib

# Right - explicit target or pattern
buck2 query //src/lib:
buck2 query //src/lib/...
```

### Confusing rdeps Parameters

```bash
# Wrong order - target should be second
buck2 query "rdeps('//target', '//scope')"

# Right - scope first, target second
buck2 query "rdeps('//scope', '//target')"
```

### Not Escaping Regex

```bash
# Wrong - dot matches any char
buck2 query "kind('rust.binary', '//src/...')"

# Right - escape special regex chars
buck2 query "kind('rust_binary', '//src/...')"
# Or use .* for pattern matching
buck2 query "kind('rust_.*', '//src/...')"
```
