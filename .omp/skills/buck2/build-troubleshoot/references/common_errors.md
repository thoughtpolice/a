# Common Buck2 Build Errors and Solutions

Comprehensive reference of Buck2 build errors, their causes, and fixes.

## Target Not Found Errors

### Error: "No such target"

```
Error: No targets found matching //src/tools:missing
```

**Causes:**
- Typo in target name
- Target not defined in BUILD file
- Wrong package path
- BUILD file doesn't exist

**Solutions:**
```bash
# List available targets in package
buck2 targets //src/tools:

# Check BUILD file exists
ls -la src/tools/BUILD

# Search across all targets
buck2 targets //... | grep missing

# Check target pattern syntax
# Correct: //src/tools:mytool
# Wrong: //src/tools/mytool (missing colon)
```

## Visibility Errors

### Error: "Target not visible"

```
Error: //src/app:app cannot depend on //src/lib:internal (not visible)
```

**Cause:** Target has restricted visibility that doesn't include the dependent.

**Solution:**
```python
# In //src/lib:internal BUILD file:
depot.rust_library(
    name = "internal",
    visibility = [
        "//src/app/...",  # Allow src/app to see this
        # or
        "PUBLIC",  # Allow everyone
    ],
)
```

**Quick fix for development:**
```python
# Temporarily make PUBLIC
visibility = ["PUBLIC"]

# But prefer specific visibility for production
visibility = [
    "//src/app/...",
    "//src/lib/...",
]
```

## Dependency Errors

### Error: "Unresolved import" (Rust)

```
Error: unresolved import `foo::bar`
```

**Cause:** Missing dependency in BUILD file.

**Solution:**
```python
# Add to deps in BUILD file:
depot.rust_binary(
    name = "app",
    deps = [
        "//src/lib:foo",  # Internal dependency
        "third-party//crate:crate",  # External crate
    ],
)
```

### Error: "Circular dependency"

```
Error: cycle detected in dependency graph
  //src/lib/a:a -> //src/lib/b:b -> //src/lib/a:a
```

**Cause:** Two or more targets depend on each other, creating a cycle.

**Diagnosis:**
```bash
# Find the cycle path
buck2 query "allpaths('//src/lib/a', '//src/lib/b')"
buck2 query "allpaths('//src/lib/b', '//src/lib/a')"
```

**Solutions:**
1. **Extract common code:**
   ```python
   # Create new shared library
   depot.rust_library(
       name = "common",
       srcs = ["common.rs"],
   )

   # Both a and b depend on common
   depot.rust_library(name = "a", deps = [":common"])
   depot.rust_library(name = "b", deps = [":common"])
   ```

2. **Use dependency injection:**
   Pass dependencies as parameters instead of importing directly.

3. **Restructure code:**
   Merge the two libraries or split differently.

## Compilation Errors

### Error: "rustc failed"

```
Error: rustc failed with exit code 1
error[E0425]: cannot find function `foo` in this scope
```

**Causes:**
- Syntax errors in Rust code
- Missing imports
- Wrong function signatures
- Type mismatches

**Solutions:**
1. Read the full error message (scroll up in logs)
2. Fix the Rust code errors
3. Ensure all imports are correct
4. Check BUILD file has correct srcs

```bash
# View full error
buck2 build //target -v 2

# Check source files
buck2 query "//target" --output-attribute srcs
```

### Error: "Cannot find module"

```
Error: cannot find module `foo` in crate root
```

**Causes:**
- Missing `mod foo;` declaration
- File in wrong location
- Should be a dependency, not a module

**Solutions:**
```rust
// In lib.rs or main.rs:
mod foo;  // For foo.rs in same directory

// Or for subdirectory:
mod foo;  // For foo/mod.rs or foo.rs

// Or add as dependency in BUILD:
deps = ["//path/to:foo"]
```

## Linking Errors

### Error: "Undefined reference"

```
Error: undefined reference to `symbol_name`
```

**Causes:**
- Missing library dependency
- Wrong link order (C++ specific)
- ABI mismatch
- Symbol not exported

**Solutions:**
```python
# Add missing library
deps = [
    "//lib/that/defines:symbol",
]

# For system libraries:
deps = [
    "third-party//system:lib",
]
```

## BUILD File Errors

### Error: "Glob matched no files"

```
Warning: glob(["src/**/*.rs"]) matched no files
```

**Causes:**
- Wrong glob pattern
- Files in wrong location
- Source directory doesn't exist

**Solutions:**
```bash
# Check directory structure
ls -la src/

# Verify file locations
# Rust binary needs: src/main.rs
# Rust library needs: src/lib.rs

# Fix glob pattern:
# For single file:
srcs = ["main.rs"]

# For all rs files:
srcs = glob(["src/**/*.rs"])

# For specific pattern:
srcs = glob(["src/**/*.rs"], exclude=["src/**/test_*.rs"])
```

### Error: "Invalid BUILD file syntax"

```
Error: Evaluation error: name 'depot' is not defined
```

**Cause:** Missing load statement for depot shims.

**Solution:**
```python
# Add at top of BUILD file:
load("@root//buck/shims:shims.bzl", depot = "shims")

# Then use:
depot.rust_binary(...)  # Not rust_binary(...)
```

### Error: "Function not found"

```
Error: rust_binary() is not defined
```

**Cause:** Using native rule instead of depot shim.

**Solution:**
```python
# Wrong:
rust_binary(name = "app")

# Right:
load("@root//buck/shims:shims.bzl", depot = "shims")
depot.rust_binary(name = "app")
```

## Test Errors

### Error: "No tests found"

```
Error: No tests found in //src/lib:test
```

**Causes:**
- No test target defined
- Test target has wrong type
- No test functions in code

**Solutions:**
```python
# Define test target in BUILD:
depot.rust_test(
    name = "test",
    srcs = glob(["src/**/*.rs"]),
)
```

```rust
// In Rust code:
#[cfg(test)]
mod tests {
    #[test]
    fn test_something() {
        assert_eq!(2 + 2, 4);
    }
}
```

### Error: "Test failed"

```
Error: test test_foo ... FAILED
```

**Diagnosis:**
```bash
# Run test with output
buck2 test //target -- --nocapture

# Run specific test
buck2 test //target -- test_name --nocapture

# Verbose mode
buck2 test //target -v 2
```

## Cache and Daemon Errors

### Error: "Buck daemon error"

```
Error: Buck daemon is not running
```

**Solutions:**
```bash
# Start daemon
buck2 status

# Or kill and restart
buck2 kill
buck2 status

# Check daemon logs
buck2 log daemon
```

### Error: "Cache error"

```
Error: Failed to fetch from cache
```

**Solutions:**
```bash
# Skip cache
buck2 build //target --no-remote-cache

# Clear local cache
buck2 clean

# Check cache configuration
buck2 audit config cache
```

### Error: "Output already in use"

```
Error: output directory already being used by another process
```

**Causes:**
- Multiple buck2 instances running
- Stale lock files
- Previous build didn't clean up

**Solutions:**
```bash
# Kill all buck2 processes
buck2 kill
pkill -9 buck2

# Clean and rebuild
buck2 clean
buck2 build //target
```

## Configuration Errors

### Error: "Invalid configuration"

```
Error: Unknown configuration option: foo
```

**Solutions:**
```bash
# Check configuration
buck2 audit config

# View specific section
buck2 audit config rust

# Check .buckconfig syntax
cat .buckconfig
```

### Error: "Cell not found"

```
Error: Cell `foo` not found
```

**Cause:** Cell alias not defined in .buckconfig.

**Solution:**
```ini
# Add to .buckconfig [cells] section:
[cells]
foo = path/to/foo
```

## Platform-Specific Errors

### Error: "Platform not supported"

```
Error: No matching platform for target
```

**Solutions:**
```python
# Add platform constraints to BUILD:
depot.rust_binary(
    name = "app",
    compatible_with = [
        "config//os:linux",
        "config//os:macos",
    ],
)
```

### Error: "Architecture mismatch"

```
Error: Cannot execute arm64 binary on x86_64
```

**Cause:** Cross-compilation issue or wrong platform selected.

**Solutions:**
```bash
# Build for specific platform
buck2 build //target --target-platforms=//platforms:x86_64-linux

# Check current platform
buck2 audit config platform
```

## Remote Execution Errors

### Error: "Remote execution failed"

```
Error: Remote execution error: connection timeout
```

**Solutions:**
```bash
# Disable remote execution
buck2 build //target --no-remote-execution

# Check RE configuration
buck2 audit config re

# Use local execution
buck2 build //target --local-only
```

## Incremental Build Issues

### Error: "Buck keeps rebuilding"

**Symptoms:** Every build rebuilds the same targets.

**Causes:**
- Non-deterministic build
- Timestamps in output
- Generated files in source tree
- Cache disabled

**Diagnosis:**
```bash
# Check why rebuilding
buck2 explain //target

# Compare two builds
buck2 build //target
buck2 build //target  # Should be cached
```

**Solutions:**
- Ensure reproducible builds
- Don't generate files in source tree
- Check for timestamp dependencies
- Verify cache is enabled

## Debugging Techniques

### Get verbose output

```bash
# Level 1: Basic verbose
buck2 build //target -v

# Level 2: More verbose
buck2 build //target -v 2

# Save to file
buck2 build //target -v 2 2>&1 | tee build.log
```

### Check what actually ran

```bash
# Show executed commands
buck2 log what-ran

# Show failed commands
buck2 log what-failed

# Full last build log
buck2 log last
```

### Inspect target configuration

```bash
# Show all attributes
buck2 query "//target" --json | jq

# Specific attributes
buck2 query "//target" --output-attribute srcs,deps,visibility

# Show target type
buck2 query "//target" --output-attribute buck.type
```

### Test in isolation

```bash
# Single target
buck2 build //target

# With clean state
buck2 clean && buck2 build //target

# Skip remote execution
buck2 build //target --no-remote-execution --no-remote-cache

# Local only
buck2 build //target --local-only
```

## Quick Fixes Cheat Sheet

```bash
# 1. Clean build
buck2 clean && buck2 build //target

# 2. Restart daemon
buck2 kill && buck2 build //target

# 3. Skip cache
buck2 build //target --no-remote-cache

# 4. Verbose mode
buck2 build //target -v 2

# 5. Check what failed
buck2 log what-failed

# 6. View last log
buck2 log last

# 7. Explain rebuild
buck2 explain //target

# 8. Verify target exists
buck2 targets //path:

# 9. Check dependencies
buck2 query "deps('//target', 1)"

# 10. Find cycles
buck2 query "allpaths('//a', '//b')"
```
