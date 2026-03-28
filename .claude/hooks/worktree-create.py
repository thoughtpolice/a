#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Worktree creation hook for Claude Code.

Creates a jj workspace for isolated worktree-based development sessions.

Reads JSON from stdin with 'name' and 'cwd' fields, creates the worktree
under ~/.local/share/claude/worktrees/<repo_name>/<name>, and prints the
worktree path to stdout.

Usage:
  As a WorktreeCreate hook in Claude Code settings.json:
  {
    "hooks": {
      "WorktreeCreate": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "python3 .claude/hooks/worktree-create.py"
            }
          ]
        }
      ]
    }
  }
"""

import sys

sys.dont_write_bytecode = True

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class WorktreeConfig:
    # base directory for worktrees (supports ~); final path is <base>/<repo_name>/<name>
    base_dir: str = "~/.local/share/claude/worktrees"
    # jj revset for the initial working-copy parent
    revision: str = "trunk()"
    # shell commands to run in the new worktree after creation
    run: list[str] = field(default_factory=list)
    # repo-root-relative paths to symlink into the worktree
    symlinks: list[str] = field(default_factory=list)


def load_worktree_config(repo_root):
    """Loads worktree config, with .local.json values taking precedence."""
    config_dir = os.path.join(repo_root, ".claude")
    raw = {}
    for name in ("worktree.json", "worktree.local.json"):
        path = os.path.join(config_dir, name)
        if os.path.exists(path):
            with open(path) as f:
                raw.update(json.load(f))
    return WorktreeConfig(**raw)


def jj_repo_root(cwd):
    """Returns the jj repo root, resolving through workspace indirection.

    `jj root` returns the workspace root, which differs from the repo root in
    workspaces. The actual repo root is found by inspecting .jj/repo: if it's a
    directory, we're already at the repo root; if it's a file, it contains a
    relative path (from .jj/) to $ROOT/.jj/repo.
    """
    result = subprocess.run(
        ["jj", "root"],
        capture_output=True,
        text=True,
        cwd=cwd,
    )
    if result.returncode != 0:
        raise RuntimeError(f"not in a jj repository: {result.stderr}")
    workspace_root = result.stdout.strip()

    jj_repo = os.path.join(workspace_root, ".jj", "repo")
    if os.path.isfile(jj_repo):
        with open(jj_repo) as f:
            pointer = f.read().strip()
        resolved = os.path.realpath(os.path.join(workspace_root, ".jj", pointer))
        return os.path.dirname(os.path.dirname(resolved))
    return workspace_root


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Error: Failed to parse JSON from stdin: {e}", file=sys.stderr)
        return 2

    name = data.get("name", "")
    cwd = data.get("cwd", "")

    if not name or not cwd:
        print("Error: 'name' and 'cwd' fields are required", file=sys.stderr)
        return 2

    try:
        repo_root = jj_repo_root(cwd)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2

    config = load_worktree_config(repo_root)

    repo_name = os.path.basename(repo_root)
    worktree_dir = os.path.join(
        os.path.expanduser(config.base_dir), repo_name
    )
    worktree_path = os.path.join(worktree_dir, name)

    os.makedirs(worktree_dir, exist_ok=True)
    workspace_name = f"claude/{name}"

    result = subprocess.run(
        ["jj", "workspace", "add", worktree_path, "--name", workspace_name,
         "-r", config.revision],
        capture_output=True,
        text=True,
        cwd=repo_root,
    )

    if result.returncode != 0:
        print(f"Error: jj workspace add failed: {result.stderr}", file=sys.stderr)
        return 2

    def cleanup():
        subprocess.run(
            ["jj", "workspace", "forget", workspace_name],
            capture_output=True, text=True, cwd=repo_root,
        )
        shutil.rmtree(worktree_path, ignore_errors=True)

    for cmd in config.run:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            cwd=worktree_path,
        )
        if result.returncode != 0:
            print(f"Error: run command failed: {cmd}\n{result.stderr}", file=sys.stderr)
            cleanup()
            return 2

    for link in config.symlinks:
        src = os.path.join(repo_root, link)
        dst = os.path.join(worktree_path, link)
        if os.path.exists(src) and not os.path.exists(dst):
            os.symlink(src, dst)

    print(worktree_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
