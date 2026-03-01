#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Worktree creation hook for Claude Code.

Creates a jj workspace for isolated worktree-based development sessions.

Reads JSON from stdin with 'name' and 'cwd' fields, creates the worktree
under .claude/worktrees/<name>, and prints the worktree path to stdout.

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
import subprocess


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Error: Failed to parse JSON from stdin: {e}", file=sys.stderr)
        return 1

    name = data.get("name", "")
    cwd = data.get("cwd", "")

    if not name or not cwd:
        print("Error: 'name' and 'cwd' fields are required", file=sys.stderr)
        return 1

    worktree_dir = os.path.join(cwd, ".claude", "worktrees")
    worktree_path = os.path.join(worktree_dir, name)

    os.makedirs(worktree_dir, exist_ok=True)

    workspace_name = f"claude/{name}"

    result = subprocess.run(
        ["jj", "workspace", "add", worktree_path, "--name", workspace_name, "-r", "trunk()"],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"Error: jj workspace add failed: {result.stderr}", file=sys.stderr)
        return 1

    print(worktree_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
