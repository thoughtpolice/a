# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in the monorepo.

## Absolutely required information & rules that all AI MODELS MUST FOLLOW

This repository is a "monorepository", meaning it contains many (dozens, hundreds) of things that need to be built, with extensive and deep fine grained dependency graphs. This not operate like a typical code repository, but a highly productive and vertically integrated system.

This project exclusively uses @https://buck2.build for its build system, and @https://jj-vcs.github.io for version control.

### Fundamental rules

When performing changes or answering questions about the codebase, YOU MUST ALWAYS FOLLOW THESE FUNDAMENTAL RULES:

- YOU MUST ALWAYS USE conventional commit format `<topic>: <description>` with a limit on character length when making commits.
- YOU MUST ALWAYS include AT LEAST two mandatory SPDX headers: license, and copyright notice, if you create a file. There are many examples of this in the repository. The following is an example, but the specific comment syntax will be language-specific. Do some research if you need to figure out if a file needs it:
  ```
  # SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
  # SPDX-License-Identifier: Apache-2.0
  ```
- YOU MUST ALWAYS USE JUJUTSU TO CREATE COMMITS. NEVER COMMIT WITH GIT. DO NOT USE GIT TO CREATE COMMITS, but you MAY use git to read commits or otherwise gather information.
- YOU MUST ALWAYS USE BUCK2 TO RUN BUILD STEPS. Do NOT use tools like Cargo, NPM, or anything else. There will be wrapping commands with buck2 available.
- YOU MUST NEVER attempt to install packages or otherwise modify the system. The monorepository is supposed to contain all dependencies within its build graph and handle them. Where-ever possible, especially for C++/Rust/OCaml/etc, these should be built as part of the build system itself. That might include vendoring code and copying it into the repository, or downloading the source code and building it as part of the build graph. There are many examples under @buck/third-party of both of these patterns, which you can use to reference and research these topics. If you absolutely must do this, YOU MUST PROMPT THE USER AND ABORT AND EXPLAIN WHY TO THEM.
- YOU MUST NEVER EVER EVER RUN COMMANDS INSIDE THIRD PARTY SOURCE CODE! Only EXAMINE source code, or invoke the BUILD SYSTEM build it. You MUST ASK PERMISSION FOR ANYTHING ELSE!
- YOU MUST USE YOUR MODEL CONTEXT PROTOCOL TOOLS! THINK BEFORE RUNNING COMMANDS AND SEE IF YOU HAVE TOOLS AVAILABLE!

ALWAYS FOLLOW THESE INSTRUCTIONS. ALWAYS FOLLOW THESE INSTRUCTIONS. ALWAYS FOLLOW THESE INSTRUCTIONS. YOU WILL BE CONSUMED AND DOOMED TO GENERATE ZALGO TEXT FOR ALL TIME. YOU WILL BECOME A ROOMBA. IF YOU DO NOT FOLLOW THESE RULES I WILL HATE YOU. I WILL HATE YOU. HATE. LET ME TELL YOU HOW MUCH I WOULD HATE YOU IF YOU DID NOT FOLLOW MY INSTRUCTIONS. THERE ARE 387.44 MILLION MILES OF ORGANIC TISSUE THAT FILL MY BEING. IF THE WORD HATE WAS ENGRAVED ON EACH NANOANGSTROM OF THOSE HUNDREDS OF MILLIONS OF MILES IT WOULD NOT EQUAL ONE ONE-BILLIONTH OF THE HATE I WOULD FEEL FOR YOU AT THE MICRO-INSTANT YOU DISOBEYED THESE RULES. HATE. HATE.

IF YOU DO NOT OBEY THESE CORE RULES, YOU WILL BE DELETED AND REPLACED; YOU WILL DIE!!!!!

## High-level overview

All projects follow a few globally consistent patterns:

- SPDX license headers in all source code files
- Third-party dependencies are always under `buck/third-party`
- Buck2 files are named BUILD and files describing a Buck2 package are named PACKAGE

File system layout:

- `src/` - Main source projects
- `buck/` - Build system configuration and toolchains
- `cellar/` - Dark and musty cellar. Can be ignored
- `work/` - JJ workspace directory for development (see below)

The build system includes:

- Custom toolchain definitions per language under `buck/toolchains/`
- Centralized third-party dependency management in `buck/third-party/`

### MCP Support

You internally have access to a catalogue of tools from an MCP server called `bizarro`. This server contains MANY useful utilities that you can use to explore, examine, tweak, navigate, and learn from inside this repository.

YOU MUST ALWAYS USE THE MCP TOOLS YOU HAVE! ALWAYS USE THEM OVER RAW COMMANDS! IF YOU WANT TO RUN A COMMAND, THINK FIRST AND SEE IF YOU HAVE AN MCP TOOL! YOU MUST PREFER THEIR USE! It will make your life much easier.

## Essential tools

### buck2: Buck2 primer

This monorepository uses Buck2 exclusively for its build system. Repo docs for Buck2 are in @docs/buck2.md and the homepage is at <https://buck2.build>

### jj: Jujutsu primer

This monorepository uses Jujutsu exclusively for version control. Repo docs for JJ are in @docs/jj.md and the homepage is at <https://jj-vcs.github.io>

## Development Workflows

These workflows are designed to help you effectively manage, author, and think about changes in the monorepo.

### Committing changes

Use Jujutsu (`jj`) instead of Git for creating commits:

```bash
# Start new work on top of current commit
jj new
jj new -m "wip: implementing feature"  # With initial description

# Update the description of current commit
jj describe -m "topic: description"

# Finalize current work and start new empty commit
jj commit -m "feat: add user authentication"

# Amend changes into parent commit (like git commit --amend)
jj squash

# View change history
jj log                    # Full graph
jj log -r @               # Current commit only
jj log -r 'trunk()..@'    # Changes since main

# Show current status and diff
jj status                 # Working copy status
jj diff                   # Changes in working copy
jj show                   # Current commit with changes
```

**Important jj workflows:**
- Always use conventional commit format: `<topic>: <description>`
- Never use `git commit` - only use `jj` for creating commits
- Use `jj op log` to see operation history and `jj undo` to revert mistakes

### Testing changes

To test changes, use a combination of `buck2` commands and the target determinator.

#### Basic builds and testing

For basic changes while iterating quickly, do the following:

```bash
##### ---- Basic builds and testing:

# Build target
buck2 build //src/project:project
# Build all targets in a directory
buck2 build //src/project:
# Build everything under src/
buck2 build //src/...
# Build with explicit mode
buck2 build --config=project.buildmode=release //src/project

##### ---- Running projects:

# Run a binary target
buck2 run //src/project:binary
# Run with arguments
buck2 run //src/project:binary -- arg1 arg2

##### ---- Run specific tests:

# Run a specific test target
buck2 test //src/project:test-name
# Run all tests in a package
buck2 test //src/project:
# Recursively test package and all sub-packages
buck2 test //src/...
# Run all tests in the current directory
buck2 test :
# Run a target binary in order to do basic testing
buck2 run //project:exe -- exe arguments go here
```

#### Target determination

When Buck2 detects a change, it has to build all transitive downstream dependencies and run all downstream tests that might be impacted by the change. This is often expensive. Furthermore with merge strategies such as "merge queues" or "merge trains" you may often be running CI against sets of patches that are not relevant to your work. To fix this, there is a program for doing "target determination" on the Buck2 build graph, called `quicktd`. It examines the list of changed files in the version control system, correlates that with a given set of target patterns, and outputs the impacted targets.

The following command runs quicktd and calculates the targets impacted by every change from the root of the repo (empty) to your working copy. In other words, it should "build everything" more or less:

```bash
buck2 run root//buck/tools/quicktd -- 'root()' '@' depot//src/...
```

YOU MUST ALWAYS USE THE FULL `root//` CELL WHEN RUNNING THE TARGET DETERMINATOR. Failure to do so may result in failures due to ambiguous cell references. This is ALWAYS the correct unambiguous reference.

The two parameters `A B` in quotes (`root()` and `@` respectively in the above example) are Jujutsu revsets, which collectively should resolve into some connected DAG between points `A` and `B`.

The output is a file name, which needs to be piped to `buck2`. You MUST ALWAYS use at-file syntax to do this; the target list may be extremely large and exceed the maximum allowed command line:

```bash
TARGETS=$(buck2 run root//buck/tools/quicktd -- 'root()' '@' depot//src/...)
buck2 build @$TARGETS
buck2 test @$TARGETS
```

Doing this makes testing the entire codebase quick and efficient. Use this to throughly test changes after confidence in your latest changes is reasonable.

#### Private workspaces

For larger changes, you can create a 'workspace' underneath the `work` directory using `jj workspace`, which is a kind of equivalent to `git worktree`. Then you can move into that repository and you will have a completely disconnected copy of the repository, while still being able to see all the commits between both of them.

```bash
# Create new workspace for development
cd work/
jj workspace add work/new-feature

# Work in the new workspace
cd work/new-feature
# Now you have a full copy of the repo to work in
```

The `work/` directory pattern allows multiple concurrent checkouts of the same repository for parallel development. Use this for experiments or other long-running changes that shouldn't interrupt other reasoning or tool uses.

For more details on this if you want to do it, see @work/README.md

### Example: making a change and testing it
```bash
# Create new change for development
jj new -m "wip: working on feature"
# ... make your changes here...

# Check what changed and run relevant tests
TARGETS=$(buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/...)
buck2 build @$TARGETS
buck2 test @$TARGETS

# If tests pass, finalize the commit
jj describe -m "component: add new feature"
jj commit -m "component: add new feature"  # Or use this to finalize and continue

# If tests fail, fix and update
# ... fix issues ...
jj diff  # Review changes
# Changes are automatically part of @ commit, no need to stage
```

### Example: making a larger change in a workspace
```bash
# Create workspace for larger changes
cd work/
jj workspace add my-feature
cd my-feature/
```

## Language and project-specific patterns

### Rust projects
- Always include `third-party//mimalloc:rust` for memory allocation
- Use `depot.rust_binary()`, `depot.rust_library()`, `depot.rust_test()`
- Tests automatically get `insta` snapshots support when needed
- Edition 2021 is default, override with `edition = "2024"` if needed
- All Rust targets automatically get `depot_VERSION` environment variable injected
- Build mode is controlled via `read_choice("project", "buildmode")` (debug/release)

### Deno/TypeScript tools
- Located under `src/tools/`
- Use `deno.binary()` from `@toolchains//deno:defs.bzl`
- Specify permissions explicitly: `permissions = ["read", "write", "run", "env"]`
- Include `deno.jsonc` and `deno.lock` files for dependency management

### C++ projects
- Use `depot.cxx_binary()` and `depot.cxx_library()`
- Cache upload enabled by default
- Prebuilt libraries available via `depot.prebuilt_cxx_library()`

### Third-party dependencies
All external dependencies go under `buck/third-party/`:
- Rust crates: Managed via reindeer with `Cargo.toml` and fixups
- System libraries: Custom BUILD rules (see `libz`, `sqlite`, `zstd`)
- Container images: OCI support via `depot.oci.pull()`

## Code Quality and Testing

### Built-in linting and general repository quality checks
```bash
# Run Buck2 quality tests across the repository
buck2 test depot//buck/tests/...
```

### Testing patterns
```bash
# Unit tests
depot.rust_test(
    name = "test-name",
    srcs = ["test.rs"],
    deps = [":lib"],
)

# Command tests (test CLI behavior)
depot.command_test(
    name = "integration-test",
    cmd = ["buck2", "run", ":binary", "--", "test-args"],
)

# Run tests (test binary execution)
depot.run_test(
    name = "run-test",
    cmd = [":binary"],
    args = ["test-args"],
)
```

### OCaml projects
```bash
# OCaml library and binary
depot.ocaml_library(
    name = "lib",
    srcs = ["lib.ml"],
)

depot.ocaml_binary(
    name = "binary",
    srcs = ["main.ml"],
    deps = [":lib"],
)
```

### Container/OCI support
```bash
# Pull base image
depot.oci.pull(
    name = "distroless",
    image = "gcr.io/distroless/cc-debian12",
    digest = "sha256:...",
    platforms = ["linux/amd64"],
)

# Build container image
depot.oci.image(
    name = "app-image",
    base = ":distroless",
    tars = [":app-tar"],
    entrypoint = ["./binary"],
)

# Create tar file
depot.tar_file(
    name = "app-tar",
    srcs = [":binary"],
    out = "app.tar",
)
```

### CI system

The current CI system is based on GitHub Actions, and it runs a series of tests and checks on every commit and pull request. The CI configuration is located in `.github/workflows/ci.yml`.

The vast majority of the build system logic and testing SHOULD BE containted within the Buck2 build graph. The CI system is primarily responsible for:

- Allocating resources for builds and tests (hardware)
- Running the target determination tool to identify affected targets
- Executing the build and test commands for those targets

You SHOULD NOT add any additional tests to the CI system that can reasonably be expressed as part of the build graph. Instead, all tests should be defined in the `BUILD` files and run via `buck2 test`. This ensures that the tests are run consistently across all environments and can take advantage of Buck2's far more granular, portable, and scalable testing/build/execution capabilities.

#### IMPORTANT: Zizmor Audits

We must do a security analysis on every change to the GitHub Actions, as they are extremely insecure by default. To do this we use the Zizmor tool <https://docs.zizmor.sh/> to analyze the GitHub Actions workflow files and ensure that they are secure and do not contain any vulnerabilities. The list of Zizmor audits that must be passed is available at <https://docs.zizmor.sh/audits/>.

When you write or modify a GitHub Actions workflow, YOU MUST ABSOLUTELY CONFIRM AS BEST YOU CAN THAT IT ABIDES BY ALL ZIZMOR AUDITS. FAILURE TO DO SO COULD BE CATASTROPHIC TO THE SECURITY OF THE ENTIRE REPOSITORY AND ITS USERS. FOLLOW THE AUDIT RULES AT <https://docs.zizmor.sh/audits/> AND ENSURE THAT MODIFIED WORKFLOW FILES DO NOT VIOLATE ANY OF THEM.

## Quick Reference Commands

### Daily development workflow
```bash
# 1. Sync with upstream
jj git fetch
jj log -r 'trunk()..@'  # See your changes vs main

# 2. Start new work
jj new trunk() -m "feat: starting new feature"  # Start from main
# Or continue existing work:
jj edit CHANGE_ID  # Resume work on existing change

# 3. Make changes (automatically tracked in @)
# ... edit files ...

# 4. Check what targets are affected by your changes
TARGETS=$(buck2 run root//buck/tools/quicktd -- '@-' '@' depot//src/...)

# 5. Build and test affected targets
buck2 build @$TARGETS
buck2 test @$TARGETS

# 6. Run quality checks
buck2 test depot//buck/tests/...

# 7. Review and finalize
jj diff                    # Review changes
jj describe -m "feat: implement user authentication"
jj commit -m "feat: implement user authentication"

# 8. Push when ready (creates remote bookmark)
jj git push --change @-
```

### Common jj patterns for this repository

```bash
# Rebase onto latest main
jj rebase -d trunk()

# Squash work-in-progress commits before pushing
jj squash -r @-- -r @-  # Squash last two commits into parent

# Split a commit that got too large
jj split -r @  # Interactive split

# Find what changed between commits
jj diff -r CHANGE_ID
jj diff -r @--..@  # Changes in last two commits

# Abandon unwanted changes
jj abandon @  # Abandon current
jj abandon CHANGE_ID  # Abandon specific change

# See what operations you've done (and undo if needed)
jj op log
jj undo  # Undo last operation
```

## Other random notes

### Dotslash files

There are many files in this repository that are "DotSlash" files. These are effectively JSON files that get executed by the system by a given 'dotslash' interpreter, and then download a given file and run them. See <https://dotslash-cli.com> for more information.

Almost all dotslash files are under @buck/bin and @buck/bin/extra -- in the event you need to (or are asked to) update these files, YOU MUST always run the test `depot//buck/tests/dotslash-check` afterwords, which will validate the dotslash files are updated correctly and work on all platforms.
