#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Pre-commit test hook for Claude Code.

This script runs target determination to find affected targets and tests them
before allowing a commit. It only uses the Python standard library for maximum
portability.

Usage:
  As a PreToolUse hook in Claude Code settings.json:
  {
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "Bash",
          "hooks": [
            {
              "type": "command",
              "command": ".claude/hooks/pre-commit-test.py",
              "timeout": 600
            }
          ]
        }
      ]
    }
  }

Exit codes:
  0 - All tests passed, allow commit
  2 - Tests failed, block commit (stderr fed back to Claude)
"""

import subprocess
import sys
import os
import json


def run_command(cmd, description="", capture=True, check=True):
    """
    Run a command and handle errors.

    Args:
        cmd: Command to run (list of strings)
        description: Human-readable description
        capture: Whether to capture output
        check: Whether to raise on non-zero exit

    Returns:
        subprocess.CompletedProcess result
    """
    if description:
        print(f"→ {description}", file=sys.stderr)

    try:
        if capture:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False
            )
        else:
            # Don't capture output - let it stream to terminal
            result = subprocess.run(
                cmd,
                check=False
            )

        if check and result.returncode != 0:
            if capture and result.stderr:
                print(result.stderr, file=sys.stderr)
            raise subprocess.CalledProcessError(
                result.returncode,
                cmd,
                result.stdout if capture else None,
                result.stderr if capture else None
            )

        return result
    except FileNotFoundError as e:
        print(f"Error: Command not found: {cmd[0]}", file=sys.stderr)
        raise


def count_lines(filepath):
    """Count lines in a file."""
    try:
        with open(filepath, 'r') as f:
            return sum(1 for _ in f)
    except (FileNotFoundError, IOError):
        return 0


def validate_tool_input():
    """
    Read and validate tool input from stdin.

    Returns:
        bool: True if this is a 'jj commit' command that should be tested, False otherwise
    """
    try:
        # Read JSON from stdin
        tool_data = json.load(sys.stdin)

        # Extract the command from tool_input
        tool_input = tool_data.get('tool_input', {})
        command = tool_input.get('command', '')

        # Validate it's a jj commit command
        if not command.strip().startswith('jj commit'):
            print(f"→ Skipping: Not a 'jj commit' command (got: {command[:50]}...)", file=sys.stderr)
            return False

        print(f"→ Detected jj commit command", file=sys.stderr)
        return True

    except json.JSONDecodeError as e:
        print(f"Error: Failed to parse JSON from stdin: {e}", file=sys.stderr)
        # If we can't parse the input, safer to allow the operation
        return False
    except Exception as e:
        print(f"Error: Unexpected error reading tool input: {e}", file=sys.stderr)
        # If something goes wrong, safer to allow the operation
        return False


def main():
    """Main entry point for pre-commit test hook."""

    print("=" * 60, file=sys.stderr)
    print("PRE-COMMIT TEST HOOK", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    print(file=sys.stderr)

    # Step 0: Validate this is actually a jj commit command
    if not validate_tool_input():
        print("Allowing operation (not a jj commit).", file=sys.stderr)
        print(file=sys.stderr)
        return 0

    print(file=sys.stderr)

    # Step 1: Run target determination to find affected targets
    print("Step 1: Finding affected targets...", file=sys.stderr)
    print(file=sys.stderr)

    try:
        quicktd_cmd = [
            "buck2", "run", "root//buck/tools/quicktd", "--",
            "@-",           # From: parent commit
            "@",            # To: current working copy
            "depot//..."    # Universe: entire depot
        ]

        result = run_command(
            quicktd_cmd,
            "Running target determination",
            capture=True,
            check=True
        )

        # The output is the path to the targets file
        targets_file = result.stdout.strip()

        if not targets_file:
            print("Error: quicktd did not return a targets file path", file=sys.stderr)
            return 2

        if not os.path.exists(targets_file):
            print(f"Error: Targets file does not exist: {targets_file}", file=sys.stderr)
            return 2

        # Count affected targets
        target_count = count_lines(targets_file)

        print(file=sys.stderr)
        if target_count == 0:
            print("✓ No targets affected by changes", file=sys.stderr)
            print("  Commit allowed (no tests to run)", file=sys.stderr)
            print(file=sys.stderr)
            print("=" * 60, file=sys.stderr)
            return 0

        print(f"✓ Found {target_count} affected target(s)", file=sys.stderr)
        print(file=sys.stderr)

        # Step 2: Run tests on affected targets
        print(f"Step 2: Testing {target_count} affected target(s)...", file=sys.stderr)
        print(file=sys.stderr)

        test_cmd = ["buck2", "test", f"@{targets_file}"]

        # Don't capture output - let buck2 output stream to terminal
        result = run_command(
            test_cmd,
            "Running tests",
            capture=False,
            check=False
        )

        print(file=sys.stderr)

        if result.returncode != 0:
            print("=" * 60, file=sys.stderr)
            print("✗ TESTS FAILED", file=sys.stderr)
            print("=" * 60, file=sys.stderr)
            print(file=sys.stderr)
            print("Commit blocked due to test failures.", file=sys.stderr)
            print("Please fix the failing tests before committing.", file=sys.stderr)
            print(file=sys.stderr)
            print(f"To see affected targets: cat {targets_file}", file=sys.stderr)
            print(f"To rerun tests: buck2 test @{targets_file}", file=sys.stderr)
            print(file=sys.stderr)
            return 2  # Block commit

        # Success!
        print("=" * 60, file=sys.stderr)
        print("✓ ALL TESTS PASSED", file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        print(file=sys.stderr)
        print(f"Tested {target_count} target(s) successfully.", file=sys.stderr)
        print("Commit allowed.", file=sys.stderr)
        print(file=sys.stderr)

        return 0  # Allow commit

    except subprocess.CalledProcessError as e:
        print(file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        print("✗ ERROR DURING PRE-COMMIT CHECKS", file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        print(file=sys.stderr)
        print(f"Command failed with exit code {e.returncode}", file=sys.stderr)
        print(f"Command: {' '.join(e.cmd)}", file=sys.stderr)
        print(file=sys.stderr)
        print("Commit blocked due to error.", file=sys.stderr)
        print(file=sys.stderr)
        return 2  # Block commit

    except Exception as e:
        print(file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        print("✗ UNEXPECTED ERROR", file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        print(file=sys.stderr)
        print(f"Error: {e}", file=sys.stderr)
        print(file=sys.stderr)
        print("Commit blocked due to unexpected error.", file=sys.stderr)
        print(file=sys.stderr)
        return 2  # Block commit


if __name__ == '__main__':
    sys.exit(main())
