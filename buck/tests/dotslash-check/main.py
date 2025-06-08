#!/usr/bin/env python3

# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Check that all dotslash files in buck/bin can be executed successfully.
"""

import subprocess
import sys
from pathlib import Path


def main():
    """Check all dotslash files in buck/bin directory"""

    # Find the repository root by looking for .buckroot
    current_dir = Path(__file__).parent
    repo_root = current_dir
    while repo_root != repo_root.parent:
        if (repo_root / ".buckroot").exists():
            break
        repo_root = repo_root.parent
    else:
        print("ERROR: Could not find repository root (no .buckroot found)")
        return 1

    buck_bin_dir = repo_root / "buck" / "bin"

    if not buck_bin_dir.exists():
        print(f"ERROR: buck/bin directory not found at {buck_bin_dir}")
        return 1

    # Get all files in buck/bin that are not directories and not BUILD/PACKAGE files
    dotslash_files = []
    for item in buck_bin_dir.iterdir():
        if (
            item.is_file()
            and item.name not in ["BUILD", "PACKAGE"]
            and not item.name.endswith(".exe")
        ):
            dotslash_files.append(item)

    if not dotslash_files:
        print("No dotslash files found to check")
        return 0

    print(f"Checking {len(dotslash_files)} dotslash files...")

    failed_files = []

    for dotslash_file in sorted(dotslash_files):
        print(f"Checking {dotslash_file.name}...", end=" ")

        try:
            # Try to run the dotslash file with --help
            result = subprocess.run(
                ["dotslash", str(dotslash_file), "--help"],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode == 0:
                print("✓")
            else:
                print("✗")
                print(f"  STDERR: {result.stderr.strip()}")
                failed_files.append(dotslash_file.name)

        except subprocess.TimeoutExpired:
            print("✗ (timeout)")
            failed_files.append(dotslash_file.name)
        except FileNotFoundError:
            print("✗ (dotslash not found)")
            print(
                "ERROR: 'dotslash' command not found. Please ensure dotslash is installed."
            )
            return 1
        except Exception as e:
            print(f"✗ (error: {e})")
            failed_files.append(dotslash_file.name)

    if failed_files:
        print(f"\n{len(failed_files)} files failed:")
        for failed_file in failed_files:
            print(f"  - {failed_file}")
        return 1

    print(f"\nAll {len(dotslash_files)} dotslash files passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
