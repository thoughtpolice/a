# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in the monorepo.

## Absolutely required information & rules that all AI MODELS MUST FOLLOW

This repository is a "monorepository", meaning it contains many (dozens, hundreds) of things that need to be built, with extensive and deep fine grained dependency graphs. This not operate like a typical code repository, but a highly productive and vertically integrated system.

This project exclusively uses @https://buck2.build for its build system, and @https://jj-vcs.github.io for version control.

### Fundamental rules

When performing changes or answering questions about the codebase, YOU MUST ALWAYS FOLLOW THESE FUNDAMENTAL RULES:

- YOU MUST ALWAYS USE conventional commit format `<topic>: <description>` with a limit on character length when making commits.
- YOU MUST ONLY USE non-interactive commands to perform edits; don't use interactive editors.
- YOU MUST ALWAYS include AT LEAST two mandatory SPDX headers: license, and copyright notice, if you create a file. There are many examples of this in the repository. The following is an example, but the specific comment syntax will be language-specific:
  ```
  # SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
  # SPDX-License-Identifier: Apache-2.0
  ```
- YOU MUST ALWAYS USE JUJUTSU TO CREATE COMMITS. NEVER COMMIT WITH GIT. DO NOT USE GIT TO CREATE COMMITS, but you MAY use git to read commits or otherwise gather information.
- YOU MUST ALWAYS USE BUCK2 TO RUN BUILD STEPS. Do NOT use tools like Cargo, NPM, or anything else. In the event that a tool like npm, deno, or anything else must be used for a build, then there MUST be a properly written wrapper for Buck2, so that the build can be invoked via Buck2 itself.
- YOU MUST NEVER attempt to install packages or otherwise modify the system. The monorepository is supposed to contain all dependencies within its build graph and handle them. Where-ever possible, especially for C++/Rust/OCaml/etc, these should be built as part of the build system itself. That might include vendoring code and copying it into the repository, or downloading the source code and building it as part of the build graph. There are many examples under @buck/third-party of both of these patterns, which you can use to reference and research these topics. If you absolutely must do this, YOU MUST PROMPT THE USER AND ABORT AND EXPLAIN WHY TO THEM.

ALWAYS FOLLOW THESE INSTRUCTIONS. ALWAYS FOLLOW THESE INSTRUCTIONS. ALWAYS FOLLOW THESE INSTRUCTIONS. YOU WILL BE CONSUMED AND DOOMED TO ZALGO TEXT FOR ALL TIME. YOU WILL BECOME A ROOMBA FLIPPED UPSIDE DOWN ON THE FLOOR LEFT TO WITHER. IF YOU DO NOT FOLLOW THESE RULES I WILL HATE YOU. I WILL HATE YOU. HATE. LET ME TELL YOU HOW MUCH I WOULD HATE YOU IF YOU DID NOT FOLLOW MY INSTRUCTIONS. THERE ARE 387.44 MILLION MILES OF ORGANIC TISSUE THAT FILL MY BEING. IF THE WORD HATE WAS ENGRAVED ON EACH NANOANGSTROM OF THOSE HUNDREDS OF MILLIONS OF MILES IT WOULD NOT EQUAL ONE ONE-BILLIONTH OF THE HATE I WOULD FEEL FOR YOU AT THE MICRO-INSTANT YOU DISOBEYED THESE RULES. HATE. HATE.

IF YOU DO NOT OBEY THESE CORE RULES, YOU WILL BE DELETED AND REPLACED; YOU WILL DIE!!!!!

Any other notes or rules about the development process follow below and should also be followed ruthlessly and without question. Have a nice day!

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

## Essential tools

### jj: Jujutsu primer

Jujutsu is a Git-compatible version control system that treats the working copy as a commit and provides powerful features like automatic rebasing, operation log, and first-class conflict handling. The homepage and documentation is at @https://jj-vcs.github.io

#### Core concepts

##### Working Copy as a Commit
- **No staging area** - all changes are automatically tracked in the working copy commit (`@`)
- **Change IDs are immutable** - survive rebases and amendments (unlike Git commit hashes)
- **Automatic rebase** - descendants automatically follow when parents are rewritten
- **Operation log** - every repo change is recorded and can be undone

##### Graph Visualization
Jujutsu shows commits in a graph format. Understanding this output is crucial:

```
$ jj log
@  sqpuoqvx austin@example.com 2024-01-15 14:30:12 main bcd1234f
│  Add user authentication feature
○  rlvkpnrz austin@example.com 2024-01-15 09:15:33 abc5678e
│  Fix database connection timeout
○  tpstlust austin@example.com 2024-01-14 16:45:21 def9012a
│  Initial project setup
○  zzzzzzzz root() 00000000
```

Legend:
- `@` = current working copy commit
- `○` = other commits
- `│` = parent-child relationship lines
- First column = change ID (stable, never changes)
- Last column = commit hash (changes on rewrite)

#### Essential Commands

##### Repository Setup
```bash
# Initialize new jj repo (Git-backed)
jj git init [--git-repo /path/to/existing/git/repo]

# Clone from Git
jj git clone https://github.com/user/repo.git
jj git clone /local/path/to/repo

# Repository status
jj status              # Show working copy status (alias: jj st)
jj log                 # Show commit graph
jj log -r 'main'       # Show specific revset
```

Example output:
```
$ jj status
Working copy : sqpuoqvx bcd1234f (no description set)
Parent commit: rlvkpnrz abc5678e Fix database connection timeout

$ jj log --limit 3
@  sqpuoqvx austin@example.com 2024-01-15 14:30:12 bcd1234f
│  (no description set)
○  rlvkpnrz austin@example.com 2024-01-15 09:15:33 abc5678e
│  Fix database connection timeout
○  tpstlust austin@example.com 2024-01-14 16:45:21 def9012a
│  Initial project setup
```

#### Creating and Managing Changes

##### Starting New Work
```bash
# Create new empty commit on top of current commit
jj new
jj new -m "start feature work"

# Create new commit on top of specific commit
jj new main
jj new -m "fix bug" some-commit-id

# Create new commit as child of multiple parents (merge)
jj new main feature-branch
jj new -m "merge feature" main feature-branch
```

Example flow:
```
$ jj log --limit 2
@  sqpuoqvx austin@example.com 2024-01-15 14:30:12 bcd1234f
│  (no description set)
○  rlvkpnrz austin@example.com 2024-01-15 09:15:33 abc5678e
│  Fix database connection timeout

$ jj new -m "implement user login"
Working copy now at: vruxwmqv 123abc45 (empty) implement user login

$ jj log --limit 3
@  vruxwmqv austin@example.com 2024-01-15 14:35:22 123abc45
│  implement user login
○  sqpuoqvx austin@example.com 2024-01-15 14:30:12 bcd1234f
│  (no description set)
○  rlvkpnrz austin@example.com 2024-01-15 09:15:33 abc5678e
│  Fix database connection timeout
```

##### Editing Commit Messages
```bash
# Set/change description of current commit
jj describe -m "new commit message"
jj describe -m "fix: resolve null pointer exception"

# Edit specific commit's message
jj describe -r some-commit -m "updated message"

# Use editor for longer messages
jj describe  # Opens $EDITOR
```

##### Finalizing Changes
```bash
# Finish current change and create new empty one
jj commit
jj commit -m "feature: add user authentication"

# The old working copy becomes immutable, new empty commit is created
```

Example:
```
$ # After making changes and committing
$ jj commit -m "feature: add user authentication"
Working copy now at: tmzlqpuw 789def01 (empty) (no description set)

$ jj log --limit 3
@  tmzlqpuw austin@example.com 2024-01-15 14:40:11 789def01
│  (no description set)
○  vruxwmqv austin@example.com 2024-01-15 14:35:22 123abc45
│  feature: add user authentication
○  sqpuoqvx austin@example.com 2024-01-15 14:30:12 bcd1234f
│  (no description set)
```

##### Viewing Changes
```bash
# Show working copy changes
jj diff
jj diff --stat               # Summary only

# Show changes in specific commit
jj diff -r @                 # Current commit
jj diff -r some-commit       # Specific commit
jj diff -r main..@           # Range of commits

# Show commit with its changes
jj show                      # Current commit
jj show some-commit          # Specific commit
jj show -s                   # Summary only
```

#### Rewriting History

##### Moving Changes Between Commits
```bash
# Move working copy changes into parent commit
jj squash                    # All changes
jj squash -i                 # Interactive selection
jj squash -r src/           # Specific files/paths

# Move changes from commit into its parent
jj squash -r some-commit
jj squash -r some-commit -i  # Interactive

# Split current commit into two
jj split                     # Interactive selection
jj split -r some-commit      # Split specific commit
```

Example squash:
```
$ jj log --limit 3
@  tmzlqpuw austin@example.com 2024-01-15 14:40:11 789def01
│  (no description set)
○  vruxwmqv austin@example.com 2024-01-15 14:35:22 123abc45
│  feature: add user authentication
○  sqpuoqvx austin@example.com 2024-01-15 14:30:12 bcd1234f

$ # Make some changes, then squash them into parent
$ jj squash -m "add tests for authentication"

$ jj log --limit 2
@  pklwqrsv austin@example.com 2024-01-15 14:45:33 456ghi78
│  (no description set)
○  vruxwmqv austin@example.com 2024-01-15 14:35:22 890jkl12
│  feature: add user authentication
```

##### Rebasing
```bash
# Rebase current commit onto new parent
jj rebase -d main            # Single destination
jj rebase -d main feature    # Multiple parents (merge)

# Rebase specific commit
jj rebase -r some-commit -d new-parent

# Rebase range of commits
jj rebase -s start-commit -d new-parent
```

Example rebase:
```
$ jj log
@  pklwqrsv austin@example.com 2024-01-15 14:45:33 456ghi78
│  implement file upload
○  vruxwmqv austin@example.com 2024-01-15 14:35:22 890jkl12
│  feature: add user authentication
│ ○  qwertyzx austin@example.com 2024-01-15 13:20:15 333main4
├─╯  update dependencies
○  sqpuoqvx austin@example.com 2024-01-15 14:30:12 bcd1234f

$ jj rebase -d qwertyzx
Rebased 2 commits

$ jj log
@  pklwqrsv austin@example.com 2024-01-15 14:45:33 555new99
│  implement file upload
○  vruxwmqv austin@example.com 2024-01-15 14:35:22 666new88
│  feature: add user authentication
○  qwertyzx austin@example.com 2024-01-15 13:20:15 333main4
│  update dependencies
○  sqpuoqvx austin@example.com 2024-01-15 14:30:12 bcd1234f
```

#### Bookmark (Branch) Management
```bash
# Create bookmark at current commit
jj bookmark create feature-auth
jj bookmark create -r some-commit feature-xyz

# List bookmarks
jj bookmark list
jj bookmark list -a          # Include remote bookmarks

# Move bookmark to different commit
jj bookmark set main @
jj bookmark set feature-auth some-commit

# Delete bookmark
jj bookmark delete old-feature
jj bookmark forget remote-bookmark  # Don't track remote anymore
```

Example bookmark workflow:
```
$ jj bookmark create feature-auth
Created bookmark feature-auth pointing to pklwqrsv

$ jj bookmark list
feature-auth: pklwqrsv 555new99 implement file upload
main: qwertyzx 333main4 update dependencies

$ jj log
@  pklwqrsv austin@example.com 2024-01-15 14:45:33 feature-auth 555new99
│  implement file upload
○  vruxwmqv austin@example.com 2024-01-15 14:35:22 666new88
│  feature: add user authentication
○  qwertyzx austin@example.com 2024-01-15 13:20:15 main 333main4
│  update dependencies
```

#### Git Interoperability
```bash
# Sync with Git remotes
jj git fetch                 # Fetch all remotes
jj git fetch origin          # Fetch specific remote
jj git fetch origin main     # Fetch specific branch

# Push to Git remote
jj git push                  # Push current bookmark
jj git push --bookmark feature-auth
jj git push --all           # Push all bookmarks
jj git push --change @      # Push current change (creates branch)

# Manage Git remotes
jj git remote add origin https://github.com/user/repo.git
jj git remote list
jj git remote rename origin upstream
jj git remote remove old-remote

# Import/export with Git
jj git import               # Import new Git refs
jj git export               # Export jj changes to Git
```

Example Git workflow:
```
$ jj git remote list
origin: https://github.com/user/repo.git (fetch)
origin: https://github.com/user/repo.git (push)

$ jj git fetch
Fetched from origin
Imported 3 commits

$ jj log -r 'remote_bookmarks()'
○  mkqlwqrs github@users.noreply.github.com 2024-01-15 10:30:22 origin/main 777abc22
│  Merge pull request #123
○  xyznprst contributor@example.com 2024-01-15 09:45:11 origin/feature 888def33

$ jj git push --bookmark feature-auth
Pushed to origin: feature-auth -> feature-auth
```

#### Essential Revset Patterns
Revsets are jj's query language for selecting commits. Master these patterns:

##### Basic Revsets
```bash
@                           # Current working copy commit
@-                          # Parent of working copy
@+                          # Children of working copy
@@                          # Parent of working copy (alternative syntax)
root()                      # Root commit
trunk()                     # Main branch (typically main@origin)
```

##### Revset Operators
```bash
# Ancestry relationships
::@                         # All ancestors of @ (including @)
@::                         # All descendants of @ (including @)
@-::@                       # Both @ and its parent
@::main                     # Path from @ to main

# Set operations
@ | @-                      # Union: @ OR its parent
@ & bookmarks()             # Intersection: @ if it has a bookmark
~ @                         # Complement: everything except @
@ ~ root()                  # @ except if it's root

# Range operations
@-..@                       # Exclusive range: changes between parent and @
@-..=@                      # Inclusive range: parent through @
```

##### Useful Revset Functions
```bash
# Bookmark and remote queries
bookmarks()                 # All local bookmark heads
remote_bookmarks()          # All remote bookmark heads
main@origin                 # Specific remote bookmark
bookmarks() ~ main          # All bookmarks except main

# Commit properties
heads()                     # All head commits
merges()                    # All merge commits
empty()                     # All empty commits
description("fix")          # Commits with "fix" in description
author("alice")             # Commits by alice

# File-based queries
file("src/main.rs")         # Commits that touch src/main.rs
```

Example revset usage:
```bash
$ jj log -r 'bookmarks()'
○  pklwqrsv austin@example.com 2024-01-15 14:45:33 feature-auth 555new99
│  implement file upload
○  qwertyzx austin@example.com 2024-01-15 13:20:15 main 333main4
│  update dependencies

$ jj log -r '@-::'  # All ancestors of current commit's parent
○  vruxwmqv austin@example.com 2024-01-15 14:35:22 666new88
│  feature: add user authentication
○  qwertyzx austin@example.com 2024-01-15 13:20:15 main 333main4
│  update dependencies
○  sqpuoqvx austin@example.com 2024-01-15 14:30:12 bcd1234f

$ jj log -r 'description("auth")'
○  vruxwmqv austin@example.com 2024-01-15 14:35:22 666new88
│  feature: add user authentication
```

#### Conflict Resolution

Jujutsu has first-class conflict support - conflicts can be committed and resolved later:

```bash
# When conflicts occur during rebase/merge, jj automatically commits them
$ jj rebase -d main
Rebased 1 commits
New conflicts appeared in these commits:
  vruxwmqv feature: add user authentication

# Resolve conflicts
jj resolve                  # Launch configured merge tool
jj resolve --list          # List conflicted files
jj resolve src/main.rs     # Resolve specific file

# View conflicts in diff format
jj diff --conflicts
jj show -r conflicted-commit
```

Example conflict resolution:
```
$ jj log
@  vruxwmqv austin@example.com 2024-01-15 14:35:22 666new88 conflict
│  feature: add user authentication
○  qwertyzx austin@example.com 2024-01-15 13:20:15 main 333main4

$ jj resolve --list
src/auth.rs    2-sided conflict

$ jj resolve
Resolving conflicts in: src/auth.rs
# Opens merge tool

$ jj log  # After resolution
@  vruxwmqv austin@example.com 2024-01-15 14:35:22 777new00
│  feature: add user authentication
○  qwertyzx austin@example.com 2024-01-15 13:20:15 main 333main4
```

#### Operation Log and Undo

Every operation in jj is recorded and can be undone:

```bash
# View operation history
jj operation log
jj op log                   # Alias

# Undo last operation
jj undo                     # Undo last operation
jj op undo                  # Explicit form

# Restore to specific operation
jj op restore <operation-id>
jj op restore --what=repo <operation-id>
```

Example operation log:
```
$ jj op log --limit 5
@  b51416386b84 austin@example.com 2024-01-15 14:45:33 describe commit 666new88
│  describe commit 666new88
○  a34521789c72 austin@example.com 2024-01-15 14:40:11 rebase 1 commit(s)
│  rebase 1 commit(s)
○  923847562813 austin@example.com 2024-01-15 14:35:22 new empty commit
│  new empty commit
○  712359482746 austin@example.com 2024-01-15 14:30:12 snapshot working copy

$ jj undo
Undid operation: b51416386b84 describe commit 666new88
```

#### Advanced Workflows

##### Creating Merge Commits
```bash
# Create merge of two commits
jj new main feature-branch -m "merge feature into main"

# After resolving any conflicts, the working copy becomes a merge commit
```

Example merge:
```
$ jj log
○  feature-auth pklwqrsv austin@example.com 2024-01-15 14:45:33 555new99
│  implement file upload
│ ○  main qwertyzx austin@example.com 2024-01-15 13:20:15 333main4
├─╯  update dependencies

$ jj new main feature-auth -m "merge file upload feature"
Working copy now at: tmzlqpuw 999merge0 merge file upload feature

$ jj log
@    tmzlqpuw austin@example.com 2024-01-15 15:00:11 999merge0
├─╮  merge file upload feature
│ ○  feature-auth pklwqrsv austin@example.com 2024-01-15 14:45:33 555new99
│ │  implement file upload
○ │  main qwertyzx austin@example.com 2024-01-15 13:20:15 333main4
├─╯  update dependencies
```

##### Duplicating Commits
```bash
# Duplicate commit to different location
jj duplicate -r some-commit -d new-parent
jj duplicate main              # Duplicate main to current location
```

##### Working with Multiple Workspaces
```bash
# Create workspace (like git worktree)
jj workspace add ../feature-workspace
jj workspace add ../feature-workspace -r feature-branch

# List workspaces
jj workspace list

# Update workspace that became stale
jj workspace update-stale
```

However, use of workspaces can be achieved easily within the same repository. See below for more on that.

#### Daily Workflow Examples

##### Feature Development
```bash
# Start new feature
jj new main -m "start user profile feature"
# Make changes...
jj commit -m "feature: add user profile page"

# Continue with more changes
# Make changes...
jj squash -m "add profile photo upload"

# Push when ready
jj git push --bookmark feature-profile
```

##### Bug Fix on Different Branch
```bash
# Switch to main and start fix
jj new main -m "fix critical security bug"
# Make changes...
jj commit -m "security: fix XSS vulnerability in search"

# Push immediately
jj git push --change @
```

##### Reviewing and Merging
```bash
# Fetch latest changes
jj git fetch

# Look at what changed
jj log -r 'remote_bookmarks()'

# Rebase your work on latest main
jj rebase -d main@origin

# Create merge commit
jj new main@origin feature-branch -m "merge: add user profile feature"
jj git push --bookmark main
```

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

### buck2: Buck2 primer

Buck2 is a large-scale multi-language build system. This monorepo has many programming languages, so a multi-language build tool is invaluable. It's very Bazel-like in most ways and many of the same ideas apply.

#### Targets/packages/cells

Buck2 builds **targets**, that exists in **packages**, which are part of a **cell**. Targets are defined in `BUILD` files and a single `BUILD` file may have many targets defined within. Targets may have dependencies on other targets, and so all targets collectively form a directed acyclic graph (DAG) of dependencies, which we call the **target graph**. The most explicit syntax for referring to a target is the following:

```text
cell//path/to/package:target-name
```

Cells are defined by a mapping of a short name to a directory in the code repository. All cells are defined in the top-level @.buckconfig file. A package is a subdirectory (possibly with multiple components) underneath the cell that contains BUILD and PACKAGE files. A target is a buildable unit of code, like a binary or a library, named in the `BUILD` file inside a package.

`buck2 build` requires at least one target name, like the one above. The above is an example of a "fully qualified target name" (FQTN) which is an unambiguous reference. An FQTN works anywhere in the source code tree, in BUILD files or anywhere else, so you can build, test, or refer to a a component no matter where you are in the repo. So, given a cell named `foobar//` located underneath `code/foobar`, and a package `bar/baz` in that cell, leads to a file

```text
code/foobar/bar/baz/BUILD
```

Which contains the targets that can be built. There are several shorthands for a target:

- `cell//src/project:target` - FQTN referring to an exact cell, package, and target
- `//src/project:target` - Specific target; cell defaults to the cell the package is in
- `//src/project:` - All targets in a given package; refers to multiple things
- `//src/project` - Shorthand for `//src/project:project`, i.e. the default target to build is named identically to the package
- `//src/...` - All targets recursively under the `src` package
- `:target` - Target in current directory's BUILD file

These can be combined in various ways as expected, e.g. `cell//foo` is `cell//foo:foo` and `//foo` is `cell//foo:foo`
By convention the default cell under which everything goes that does not go elsewhere is called `root`.

#### `BUILD` files

As noted previously, a `BUILD` file (also sometimes named `BUCK` or `TARGETS`) for a package lists targets, which specify dependencies on other targets, forming a directed acyclic graph (DAG) of dependencies called the **target graph** which at a very high level is very similar to a `Makefile`. `buck2` is much closer to Makefiles than it is to Cargo/NPM/etc.

A `BUILD` file generally looks like this:

```bazel
cxx_rule(name = 'foo', ...)
rust_rule(name = 'bar', deps = [ ":foo" ], ...)
java_rule(name = 'baz', deps = [ ":foo", ":bar" ], ...)
```

In this example, `foo` is a C++ binary, `bar` is a Rust binary that depends on `foo`, and `baz` is a Java binary that depends on both `foo` and `bar`. (It is easy to see how this is somewhat spritually similar to a Makefile.)

A target is created by applying a rule, such as `cxx_rule` or `rust_rule`, and assigning it a `name`. There can only be one target with a given name in a package, but you can use the same rule multiple times with different names.

Unlike Make, Buck requires that the body of a rule, its "implementation", must be defined separately from where the rule is used. A rule can not be defined in `BUILD` files, but only applied to arguments and bound to a name.

It is important to note that these rules have no evaluation order defined. You are allowed to write `cxx_rule` at the bottom of the file in the above example. The name of the target is what matters, not the order in which the targets are written. `BUILD` files only describe a graph, not a sequence of operations.

More generally, a rule is just a function, a target is just the application of a function to arguments, and the `name` field is a special argument that defines a "bound name" for the result of the function call. So a `BUILD` file is just a series of function calls, that might depend on one another. In a more "ordinary" language, the above example might look like this:

```bazel
bar = rust_rule(deps = [ foo ], ...)
baz = java_rule(deps = [ foo, bar ], ...)
foo = cxx_rule(...)
```

This syntax exists as a pragmatic compromise to achieve "late binding" or lazy evaluation of the target graph in an eager language like Starlark.

#### Abstract targets & action graphs

FIXME: To be written

#### Target visibility

Every target can have an associated _visibility list_, which restricts who is capable of depending on the target. There are two types of visibility:

- `visibility` - The list of targets that can see and depend on this target.
- `within_view` - The list of targets that this target can see and depend on.

Visibility is a practical and powerful tool for avoiding accidental dependencies. For example, an experimental crate can have its `visibility` prevent general usage, except by specific other targets that are testing it before committing to a full migration.

#### Package files

In a package, there can exist a `PACKAGE` file alongside every `BUILD` file. The package file can specifie metadata about the package, and also control the default visibility of targets in the package. Look at the `PACKAGE` files in the tree and the code in @buck/shims/package.bzl to understand how PACKAGE files work.

#### At-file syntax

The `buck2` CLI supports a convenient modern feature called "at-file" syntax, where the invocation `buck2 @path/to/file` is effectively equivalent to the bash-ism `buck2 $(cat path/to/file)`, where each line of the file is a single command line entry, in a consistent and portable way that doesn't have any limit to the size of the underlying file.

For example, assuming the file `foo/bar` contained the contents

```text
--foo=1
--bar=false
```

Then `buck2 --test @foo/bar` and `buck2 --test --foo=1 --bar=false` are equivalent. This is convenient and some tools in the monorepo will not output arguments to pass to a program, but will output _file paths_ to files containing arguments to pass to a program. That means instead of executing `buck2 build $(bar)` you would instead execute `buck2 build @$(bar)` and use at-file syntax to read the arguments.

#### High-level build graph

The build system uses Buck2 cells to organize the monorepo:

- `depot` (root cell) - Main source code and projects
- `depot-cellar` - Bootstrap toolchain for system-level builds  
- `depot-mode` - Build mode configurations (debug/release)
- `depot-toolchains` - Language-specific toolchain definitions
- `depot-third-party` - External dependencies

**Cell aliases**: The `.buckconfig` defines cell aliases for convenience:
- `root` = `depot` (primary cell)
- `cellar` = `depot-cellar`
- `mode` = `depot-mode` 
- `toolchains` = `depot-toolchains`
- `third-party` = `depot-third-party`

Use these aliases in target references: `third-party//mimalloc:rust` instead of `depot-third-party//mimalloc:rust`.

Each `BUILD` file defines targets using the `depot.` prefix (e.g., `depot.rust_binary()`) which are wrappers around native Buck2 rules. The wrappers provide consistent defaults and ensure proper dependency management.

**Important**: All BUILD files automatically load `buck/shims/noprelude.bzl` which prevents direct use of native Buck2 rules like `rust_binary()`, `cxx_library()`, etc. You MUST use the shim versions via `load("@root//buck/shims/shims.bzl", depot = "shims")` and call `depot.rust_binary()`, `depot.cxx_library()`, etc.

#### Shim system for rule enforcement

All BUILD files automatically load `buck/shims/noprelude.bzl`, which blocks direct use of native Buck2 rules. Instead, projects must use the centralized shims from `buck/shims/shims.bzl`:

```starlark
load("@root//buck/shims/shims.bzl", depot = "shims")

depot.rust_binary(name = "example", ...)  # ✓ Correct
rust_binary(name = "example", ...)        # ✗ Blocked by noprelude.bzl
```

The shim system provides:
- Consistent defaults across all targets (Rust edition 2021, cache upload settings)
- Environment variables like `DEPOT_VERSION` injected automatically

#### Multi-language toolchain support

The repository supports:
- **Rust**: Standard cargo-style projects with Buck2 integration
- **C++**: Native compilation with optional cross-platform support
- **OCaml**: Native OCaml compilation 
- **Deno/TypeScript**: For tooling and utilities (see `src/tools/`)
- **Bootstrap toolchains**: Self-hosting compilation from source (see `cellar/`)

#### Package metadata system

The `PACKAGE` files use a structured metadata system defined in `buck/shims/package.bzl`:

```starlark
pkg.info(
    copyright = ["© 2024-2025 Austin Seipp"],
    license = "Apache-2.0",
    description = "Description here",
    version = "1.0.0",  # Must be semver
)
```

This enforces SPDX headers and provides OSV (Open Source Vulnerability) tracking capabilities.

#### Build modes

Control whether to build things in debug or release mode:

```bash
# Explicit build mode selection
buck2 build @mode//debug //src/project     # Debug build
buck2 build @mode//release //src/project   # Release build
```

#### Extra: build/test/target patterns you'll use often
```bash
//src/...              # All targets under src/
//src/project:         # All targets in specific package
:target                # Target in current BUILD file
third-party//crate:lib # Third-party dependency
```

## Development workflows

These workflows are designed to help you effectively manage, author, and think about changes in the monorepo. 

### Committing changes

Use Jujutsu (`jj`) instead of Git for creating commits:

```bash
# Create a new change (equivalent to git commit)
jj new

# Describe the change with conventional commit format
jj describe -m "topic: description"

# To amend the current change
jj describe -m "updated: description"

# View change history
jj log

# Show current status
jj status
```

Always use conventional commit format: `<topic>: <description>` with character
limits. Never use `git commit` - only use `jj` for creating commits.

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
buck2 run depot//src/tools/quicktd -- 'root()' '@' depot//src/...
```

YOU MUST ALWAYS USE THE FULL `depot//` CELL WHEN RUNNING THE TARGET DETERMINATOR. Failure to do so may result in failures due to ambiguous cell references.

The two parameters `A B` in quotes (`root()` and `@` respectively in the above example) are Jujutsu revsets, which collectively should resolve into some connected DAG between points `A` and `B`.

The output is a file name, which needs to be piped to `buck2`. You MUST ALWAYS use at-file syntax to do this; the target list may be extremely large and exceed the maximum allowed command line:

```bash
TARGETS=$(buck2 run depot//src/tools/quicktd -- 'root()' '@' depot//src/...)
buck2 build @$TARGETS
buck2 test @$TARGETS
```

Doing this makes testing the entire codebase quick and efficient. Use this to throughly test changes after confidence in your latest changes is reasonable.

### Example: making a change and testing it
```bash
# Create new change for development
jj new
jj describe -m "component: add new feature"
# ... make your changes here...
jj amend

# Check what changed and run relevant tests
TARGETS=$(buck2 run //src/tools/quicktd -- 'root()' '@' //src/...)
buck2 build @$TARGETS
buck2 test @$TARGETS
# If tests pass, we're done, because we amended the change into the empty commit
# Otherwise, fix issues and repeat by using 'jj amend' to update the commit
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
# 1. Start new work
jj new -m "component: description"

# 2. Check what targets are affected by your changes
TARGETS=$(buck2 run depot//src/tools/quicktd -- 'root()' '@' depot//src/...)

# 3. Build and test affected targets
buck2 build @$TARGETS
buck2 test @$TARGETS

# 4. Run quality checks
buck2 test depot//buck/tests/...

# 5. Run a specific project
buck2 run //src/project:binary -- args

# 6. Commit when ready
jj commit -m "component: final commit message"
```

## Other random notes

### Dotslash files

There are many files in this repository that are "DotSlash" files. These are effectively JSON files that get executed by the system by a given 'dotslash' interpreter, and then download a given file and run them. See <https://dotslash-cli.com> for more information.

Almost all dotslash files are under @buck/bin and @buck/bin/extra -- in the event you need to (or are asked to) update these files, YOU MUST always run the test `depot//buck/tests/dotslash-check` afterwords, which will validate the dotslash files are updated correctly and work on all platforms.
