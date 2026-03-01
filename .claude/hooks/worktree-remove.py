#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Worktree removal hook for Claude Code.

Removes a jj workspace that was previously created for an isolated worktree
development session.

Reads JSON from stdin with a 'worktree_path' field, forgets the jj workspace,
and removes the worktree directory.

Usage:
  As a WorktreeRemove hook in Claude Code settings.json:
  {
    "hooks": {
      "WorktreeRemove": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "python3 .claude/hooks/worktree-remove.py"
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


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Error: Failed to parse JSON from stdin: {e}", file=sys.stderr)
        return 1

    worktree_path = data.get("worktree_path", "")

    if not worktree_path:
        print("Error: 'worktree_path' field is required", file=sys.stderr)
        return 1

    # Derive the workspace name from the final path component
    workspace_name = f"claude/{os.path.basename(worktree_path)}"

    # Forget the workspace (ignore errors if already forgotten)
    subprocess.run(
        ["jj", "workspace", "forget", workspace_name],
        capture_output=True,
        text=True,
    )

    # Remove the worktree directory
    shutil.rmtree(worktree_path, ignore_errors=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
