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


def run(cmd, cwd):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        print(
            f"Warning: {' '.join(cmd)} exited with {result.returncode}: "
            f"{result.stderr.strip()}",
            file=sys.stderr,
        )
    return result


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

    if not os.path.isdir(worktree_path):
        print(
            f"Error: worktree_path {worktree_path!r} is not a directory",
            file=sys.stderr,
        )
        return 1

    buck_bin = os.path.join(worktree_path, "buck", "bin", "buck2")
    if not os.path.exists(buck_bin):
        print(
            f"Error: buck2 binary {buck_bin!r} does not exist",
            file=sys.stderr,
        )
        return 1

    # snapshot to preserve changes
    run(["jj", "status"], cwd=worktree_path)

    # remove the workspace
    workspace_name = f"claude/{os.path.basename(worktree_path)}"
    run(["jj", "workspace", "forget", workspace_name], cwd=worktree_path)

    # kill buck2 daemons rooted in the worktree to release file handles before
    # the directory is removed. Use the buck2 in this specific worktree; a
    # newer version may exist elsewhere.
    run([buck_bin, "kill"], cwd=worktree_path)

    # clear the workspace
    shutil.rmtree(worktree_path, ignore_errors=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
