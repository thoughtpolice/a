# Jujutsu (jj) - Version Control System

Jujutsu (jj) is a powerful, Git-compatible version control system designed for ease of use and efficiency. It reimagines version control with innovative concepts like treating the working copy as a commit, automatic rebasing, and first-class conflict handling.

**Key differentiators:**
- **No staging area** - Changes are automatically tracked in the working copy
- **Immutable change IDs** - Survive rebases and history rewrites
- **Anonymous branches** - Work without naming branches until needed
- **Automatic rebasing** - Descendants follow when ancestors change
- **First-class conflicts** - Conflicts can be committed and resolved later
- **Operation log** - Every change is recorded and can be undone
- **Powerful revset language** - Query and manipulate commits with precision

Homepage and official documentation: <https://jj-vcs.github.io>

## Core Concepts

### The Working Copy as a Commit

Unlike Git, jj treats your working directory as a real commit (represented by `@`). This eliminates the staging area and makes every change immediately part of the commit graph:

```bash
# In Git, you would:
git add file.txt
git commit -m "message"

# In jj, you simply:
# (changes are already in @ commit)
jj commit -m "message"  # Creates new empty @ on top
```

### Change IDs vs Commit Hashes

Every commit has two identifiers:
- **Change ID**: Stable 8-character identifier that never changes (e.g., `sqpuoqvx`)
- **Commit Hash**: Git-compatible SHA that changes when history is rewritten

This allows jj to track commits across rebases and other history modifications.

### Understanding the Commit Graph

Jj visualizes commits in an intuitive graph format:

```
@  sqpuoqvx austin@example.com 2024-01-15 14:30:12 bcd1234f
│  work: implement new feature
○  rlvkpnrz austin@example.com 2024-01-15 09:15:33 abc5678e
│  fix: resolve database timeout
◆  tpstlust austin@example.com 2024-01-14 16:45:21 main def9012a
│  initial: project setup
◆  zzzzzzzz root() 00000000
```

**Legend:**
- `@` = Current working copy commit
- `○` = Regular commits
- `◆` = Immutable commits (protected from modification)
- `│` = Parent-child relationships
- First column = Change ID (permanent)
- Last column = Commit hash (changes on rewrite)

### Bookmarks (Branches)

Jujutsu uses "bookmarks" instead of Git's branches. Bookmarks are movable pointers to commits:
- Local bookmarks track your work
- Remote bookmarks track upstream state
- No "current branch" concept - you work on anonymous branches

### Colocated Repositories

Jj can share a repository with Git (colocated mode), maintaining bidirectional compatibility:
- `.jj/` directory coexists with `.git/`
- Changes are automatically synchronized
- Use Git tools when needed

## Getting Started

### Installation

```bash
# macOS/Linux with Homebrew
brew install jj

# With Cargo
cargo install jj-cli

# From source
cargo install --git https://github.com/martinvonz/jj.git jj-cli
```

### Repository Setup

```bash
# Initialize new jj repository (Git-colocated)
jj git init --colocate

# Clone existing repository
jj git clone https://github.com/user/repo.git
cd repo

# Import existing Git repository
cd existing-git-repo
jj git init --colocate
```

### Initial Configuration

```bash
# Set user identity
jj config set --user user.name "Your Name"
jj config set --user user.email "you@example.com"

# Configure editor
jj config set --user ui.editor "vim"

# Enable colored output
jj config set --user ui.color "always"

# Set up diff tool
jj config set --user ui.diff-editor "meld"
```

## Essential Commands

### Viewing Repository State

```bash
# Show commit graph
jj log                      # Full history
jj log -r @                 # Current commit only
jj log -r @-..@            # Current and parent
jj log -r 'main..@'        # Commits between main and current

# Show working copy status
jj status                   # Alias: jj st
jj diff                     # Changes in working copy
jj diff --stat             # Summary of changes
jj diff -r @-              # Compare with parent

# Show specific commit details
jj show                     # Current commit with diff
jj show CHANGE_ID          # Specific commit
jj show -s                 # Summary only
```

### Creating and Modifying Commits

```bash
# Start new work (create empty commit on top)
jj new                      # New commit on @
jj new -m "description"    # With message
jj new REVISION            # On top of specific revision
jj new REV1 REV2          # Merge commit with multiple parents

# Update commit description
jj describe -m "new message"              # Current commit
jj describe -r REVISION -m "message"      # Specific commit

# Finalize current work and start new
jj commit -m "feat: add new feature"      # Close @ and create new empty

# Amend changes into parent commit
jj squash                   # Move all changes to parent
jj squash -i               # Interactive selection
jj squash -r REVISION      # Squash specific revision

# Split commits
jj split                    # Interactive split of @
jj split -r REVISION       # Split specific revision
```

### Navigating History

```bash
# Move to different commits
jj edit REVISION           # Make REVISION the working copy
jj new REVISION           # Create new commit on top of REVISION

# Shortcuts for navigation
jj prev                    # Move to parent commit (alias for jj edit @-)
jj next                    # Move to child commit (alias for jj edit @+)
jj prev 3                 # Move back 3 commits
```

### Rewriting History

```bash
# Rebase commits
jj rebase -d DESTINATION   # Rebase @ onto DESTINATION
jj rebase -r REVISION -d DEST     # Rebase specific revision
jj rebase -s SOURCE -d DEST       # Rebase SOURCE and descendants

# Duplicate commits
jj duplicate REVISION      # Copy revision to current location
jj duplicate -r REV -d DEST       # Copy to specific destination

# Abandon commits
jj abandon                 # Abandon current revision
jj abandon REVISION       # Abandon specific revision

# Backout/revert changes
jj backout REVISION       # Apply inverse of revision
jj backout -r REV -d DEST        # Apply inverse on top of DEST
```

### Working with Bookmarks

```bash
# Create and manage bookmarks
jj bookmark create feature-name          # At current commit
jj bookmark create -r REV feature       # At specific revision
jj bookmark set feature-name REV        # Move bookmark
jj bookmark rename old-name new-name    # Rename
jj bookmark delete feature-name         # Delete local bookmark

# List bookmarks
jj bookmark list                        # Local bookmarks
jj bookmark list -a                     # All including remotes

# Track remote bookmarks
jj bookmark track feature@origin        # Start tracking
jj bookmark untrack feature@origin      # Stop tracking
```

### Git Integration

```bash
# Sync with remotes
jj git fetch                # Fetch all remotes
jj git fetch origin         # Specific remote
jj git fetch --all-remotes  # All configured remotes

# Push changes
jj git push                 # Push current bookmark
jj git push -b bookmark     # Push specific bookmark
jj git push --change @      # Create bookmark for change
jj git push --all           # Push all bookmarks

# Remote management
jj git remote add origin URL
jj git remote list
jj git remote remove origin
jj git remote rename old new

# Import/export with colocated Git
jj git import               # Import Git refs to jj
jj git export               # Export jj commits to Git
```

## Revsets - The Query Language

Revsets are jj's powerful query language for selecting commits.

### Basic Selectors

```bash
# Special commits
@                          # Working copy
root()                     # Root commit
none()                     # Empty set

# Relative navigation
@-                         # Parent of @
@--                        # Grandparent
@+                         # Children of @
@-3                        # 3 commits back

# Bookmarks and remotes
main                       # Local bookmark
main@origin                # Remote bookmark
trunk()                    # Trunk bookmark (usually main@origin)
```

### Set Operations

```bash
# Ranges
@-..@                      # From parent to current (exclusive)
main..@                    # From main to current
::@                        # @ and all ancestors
@::                        # @ and all descendants
@-::@                      # Parent through current

# Boolean operations
@ | @-                     # Union (OR)
@ & bookmarks()            # Intersection (AND)
@ ~ main                   # Difference (excluding)
~@                         # Everything except @

# Functions
heads(expr)                # Commits with no children in set
roots(expr)                # Commits with no parents in set
parents(expr)              # Direct parents
children(expr)             # Direct children
ancestors(expr)            # All ancestors
descendants(expr)          # All descendants
```

### Practical Revset Examples

```bash
# Your commits
author(me)                           # Your authored commits
committer(me)                        # Your committed commits
mine()                               # Alias for author(me)

# Finding commits
description("fix")                   # Message contains "fix"
author("alice")                      # By specific author
empty()                              # Empty commits
conflict()                           # Commits with conflicts
file("src/main.rs")                  # Touching specific file

# Useful queries
bookmarks() ~ remote_bookmarks()     # Local-only bookmarks
heads(all())                         # All head commits
trunk()..@ ~ empty()                 # Non-empty commits since trunk
immutable_heads()                    # Protected commits
```

### Advanced Revset Patterns

```bash
# Latest commits
latest(author(me), 5)                # Your 5 most recent commits

# Finding divergence
fork_point(main, @)                  # Where @ diverged from main

# Connected components
connected(@)                          # All connected to @
reachable(@, main..)                 # Reachable from @ within range

# Present/coalesce (handle missing)
present(bookmark("maybe-exists"))    # Returns none() if missing
coalesce(foo, bar, baz)              # First non-none() result
```

## Advanced Workflows

### Conflict Resolution

Jujutsu treats conflicts as first-class objects that can be committed:

```bash
# After a conflicting operation
$ jj rebase -d main
Rebased 1 commits
New conflicts appeared in these commits:
  vruxwmqv feature: add authentication

# View conflicts
jj diff --conflicts         # Show conflict markers
jj resolve --list          # List conflicted files

# Resolve conflicts
jj resolve                 # Opens merge tool
jj resolve src/main.rs    # Resolve specific file

# Alternative: manually edit and mark resolved
# Edit files to resolve...
jj squash                  # Moves resolution to parent
```

### Working with Immutable Commits

Protect important commits from accidental modification:

```bash
# Configure immutable heads (in config)
jj config set --user 'revset-aliases.immutable_heads()' \
  'builtin_immutable_heads() | main@origin'

# View immutable commits
jj log -r 'immutable()'

# These commands will fail on immutable commits:
jj edit IMMUTABLE          # Error
jj squash -r IMMUTABLE     # Error
```

### Parallel Development with Workspaces

Create multiple working copies of the same repository:

```bash
# Add workspace for feature
jj workspace add ../feature-workspace

# Add at specific revision
jj workspace add ../bugfix -r main

# List workspaces
jj workspace list

# Forget workspace
jj workspace forget feature-workspace

# Update stale workspace
cd ../feature-workspace
jj workspace update-stale
```

### Sparse Checkouts

Work with subsets of large repositories:

```bash
# Configure sparse patterns
jj sparse set --clear --add src/ --add docs/

# Edit sparse patterns interactively
jj sparse edit

# List current patterns
jj sparse list

# Reset to full checkout
jj sparse reset
```

### The Operation Log

Every operation in jj is recorded and can be undone:

```bash
# View operation history
jj operation log           # Full history
jj op log                 # Short alias

# Undo operations
jj undo                   # Undo last operation
jj op undo 3              # Undo last 3 operations

# Restore specific operation
jj op restore OPERATION_ID

# View repo at past operation
jj log --at-op OPERATION_ID
```

### Signing Commits

Configure commit signing for security:

```bash
# Configure signing backend
jj config set --user signing.backend "gpg"
jj config set --user signing.key "YOUR_KEY_ID"

# Sign commits
jj sign                    # Sign current revision
jj sign -r REVISION       # Sign specific revision

# Configure auto-signing
jj config set --user 'revsets.sign' '@'
```

## Configuration

### Configuration Files

Configuration is stored in TOML format at multiple levels:
1. User: `~/.config/jj/config.toml`
2. Repository: `.jj/repo/config.toml`
3. Override: `$JJ_CONFIG` environment variable

```bash
# Edit configuration
jj config edit --user      # Edit user config
jj config edit --repo      # Edit repo config

# View configuration
jj config list             # All settings
jj config get user.name    # Specific value
jj config path --user      # Config file location
```

### Essential Configuration

```toml
[user]
name = "Your Name"
email = "you@example.com"

[ui]
default-command = ["log", "--limit", "10"]
editor = "vim"
diff-editor = "meld"
color = "always"
paginate = "auto"

[ui.movement]
edit = true  # Make prev/next edit commits by default

[revsets]
log = "@ | ancestors(@, 10) | trunk()"  # Default for jj log
short-prefixes = "(main..@)::"          # Prioritize recent commits

[revset-aliases]
"mine()" = "author(me)"
"recent()" = "@ | ancestors(@-, 5)"

[templates]
log = """
concat(
  change_id.short(),
  " ",
  description.first_line(),
)
"""

[aliases]
l = ["log", "--limit", "10"]
s = ["status"]
d = ["diff"]
```

## Common Workflows

### Feature Development

```bash
# Start feature from main
jj new main -m "start: user authentication feature"

# Work on feature...
# Changes are automatically in @

# Create checkpoint
jj commit -m "feat: add login endpoint"

# Continue working...
# More changes accumulate in new @

# Review changes
jj diff
jj log -r main..@

# Clean up history before push
jj rebase -d main@origin    # Update to latest
jj squash -i                # Combine related commits

# Push feature
jj git push --change @
```

### Quick Bug Fix

```bash
# Create fix on main
jj new main@origin -m "fix: null pointer in search"

# Make fix...

# Push directly
jj commit -m "fix: handle null search query"
jj git push --change @-
```

### Stacked Changes

```bash
# Create stack of dependent changes
jj new main -m "refactor: extract validation"
# Make changes...
jj commit -m "refactor: extract validation logic"

jj new -m "feat: add email validation"
# Make changes...
jj commit -m "feat: add email validation"

jj new -m "test: add validation tests"
# Make changes...

# Review stack
jj log -r main..@

# Modify middle commit
jj edit @--  # Go to middle commit
# Make changes...
jj squash    # Updates propagate up automatically
```

### Collaborative Workflows

```bash
# Fetch colleague's changes
jj git fetch

# Review their work
jj log -r 'remote_bookmarks() ~ main'
jj diff -r colleague-feature@origin

# Integrate changes
jj new main@origin colleague-feature@origin -m "merge: colleague's feature"

# Or rebase your work
jj rebase -d colleague-feature@origin
```

## Tips and Best Practices

### Commit Hygiene

1. **Use descriptive messages**: Follow conventional commits or your team's standard
2. **Keep commits focused**: One logical change per commit
3. **Squash before pushing**: Clean up experimental commits
4. **Sign important commits**: Especially for releases

### Revset Aliases

Create aliases for common queries:

```toml
[revset-aliases]
"wip()" = "description(regex:'^wip')"
"recent()" = "@ | ancestors(@, 10)"
"my-branches()" = "bookmarks() & mine() & ~remote_bookmarks()"
```

### Integration with Tools

```bash
# Use with GitHub CLI
gh pr create --base main --head "$(jj log --no-graph -r @ -T 'change_id')"

# Git bisect equivalent
jj log -r 'ancestors(@) & ~ancestors(known-good)' --reversed

# Find lost commits
jj op log  # Find operation
jj log --at-op OPERATION_ID -r all()
```

### Performance Tips

1. **Use sparse checkouts** for large repos
2. **Limit log output**: `jj log --limit 20`
3. **Configure default revsets** to show relevant commits
4. **Use colocated mode** for Git tool compatibility

## Troubleshooting

### Common Issues

**Working copy is stale:**
```bash
jj workspace update-stale
```

**Conflicts won't resolve:**
```bash
# Abandon problematic commit and recreate
jj abandon @
jj new @- -m "recreate change"
```

**Lost commits:**
```bash
# Find in operation log
jj op log
jj op restore OPERATION_ID
```

**Colocated repo out of sync:**
```bash
jj git import  # Import Git changes
jj git export  # Export jj changes
```

### Migration from Git

```bash
# Import existing Git repo
cd git-repo
jj git init --colocate

# Continue using Git tools
git log  # Still works
git status  # Shows Git's view

# Gradually adopt jj
jj log  # jj's view
jj st   # jj's status
```

## Differences from Git

| Git | Jujutsu |
|-----|---------|
| `git add` + `git commit` | `jj commit` |
| `git commit --amend` | `jj squash` |
| `git checkout branch` | `jj edit branch` |
| `git branch feature` | `jj bookmark create feature` |
| `git merge branch` | `jj new @ branch` |
| `git rebase -i` | `jj rebase` + `jj squash`/`split` |
| `git stash` | `jj new @-` (just start new commit) |
| `git cherry-pick` | `jj duplicate` |
| `git reset --hard` | `jj abandon` |
| `git reflog` | `jj op log` |

## Further Resources

- Official Documentation: <https://jj-vcs.github.io>
- GitHub Repository: <https://github.com/martinvonz/jj>
- Discord Community: <https://discord.gg/dkmfj3aGQN>
- Tutorial: <https://jj-vcs.github.io/jj/latest/tutorial>
- Revset Reference: <https://jj-vcs.github.io/jj/latest/revsets>
- Config Reference: <https://jj-vcs.github.io/jj/latest/config>
