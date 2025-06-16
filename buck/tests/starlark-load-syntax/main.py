#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

import os
import re
import sys
from pathlib import Path


def check_load_syntax(file_path):
    """Check if a file contains load statements with incorrect syntax."""
    errors = []

    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Pattern to match load statements
    # This regex captures load statements and extracts the path part
    load_pattern = r'load\s*\(\s*["\']([^"\']+)["\']'

    for line_num, line in enumerate(content.splitlines(), 1):
        matches = re.finditer(load_pattern, line)
        for match in matches:
            path = match.group(1)

            # Check if the path ends with .bzl
            if path.endswith(".bzl"):
                # Check if it already uses the colon syntax correctly
                if ":" in path:
                    # Already uses colon syntax - skip
                    continue

                # Check if this path contains // and needs colon syntax
                # ALL paths with // need colon syntax, even @cell//file.bzl -> @cell//:file.bzl
                if "//" in path:
                    # This needs colon syntax
                    errors.append(
                        {"line": line_num, "text": line.strip(), "path": path}
                    )

    return errors


def main():
    """Main function to check all BUILD, PACKAGE, and .bzl files."""
    # Get the repository root - this is a Buck2 test, so we need to find the actual repo root
    # The script runs from the Buck2 output directory, so we need to use an environment variable
    # or traverse up to find the repo root
    if "BUILD_WORKSPACE_DIRECTORY" in os.environ:
        repo_root = Path(os.environ["BUILD_WORKSPACE_DIRECTORY"])
    else:
        # Fallback: assume we're running from somewhere in the repo
        current = Path(__file__).resolve()
        while current != current.parent:
            if (current / ".buckconfig").exists():
                repo_root = current
                break
            current = current.parent
        else:
            print("ERROR: Could not find repository root (.buckconfig not found)")
            return 1

    failed_files = {}
    total_files = 0

    # Find all relevant files
    for pattern in ["**/BUILD", "**/PACKAGE", "**/*.bzl"]:
        for file_path in repo_root.rglob(pattern):
            # Skip directories
            if file_path.is_dir():
                continue
            # Skip files in hidden directories and work directory
            if any(part.startswith(".") for part in file_path.parts):
                continue
            if "work/" in str(file_path):
                continue
            # Skip buck-out directory
            if "buck-out/" in str(file_path):
                continue

            total_files += 1
            errors = check_load_syntax(file_path)

            if errors:
                failed_files[str(file_path.relative_to(repo_root))] = errors

    # Report results
    if failed_files:
        print(f"Found {len(failed_files)} files with incorrect load() syntax:")
        print("=" * 80)

        for file_path, errors in sorted(failed_files.items()):
            print(f"\n{file_path}:")
            for error in errors:
                print(f"  Line {error['line']}: {error['text']}")
                print(f'    Found: load("{error["path"]}", ...)')
                # Show what it should be
                path = error["path"]

                # Handle paths with // (absolute paths)
                double_slash_index = path.find("//")
                if double_slash_index >= 0:
                    # Split into cell/prefix and path after //
                    prefix = path[: double_slash_index + 2]  # includes //
                    after_double_slash = path[double_slash_index + 2 :]

                    # Find the last slash in the part after //
                    last_slash_index = after_double_slash.rfind("/")
                    if last_slash_index >= 0:
                        # Convert to colon syntax
                        package = after_double_slash[:last_slash_index]
                        filename = after_double_slash[last_slash_index + 1 :]
                        corrected = f"{prefix}{package}:{filename}"
                    else:
                        # No package path, need to add : directly after //
                        corrected = f"{prefix}:{after_double_slash}"
                else:
                    # This shouldn't happen since we only flag paths with //
                    corrected = path

                print(f'    Should be: load("{corrected}", ...)')

        print(f"\nTotal files checked: {total_files}")
        print(f"Files with errors: {len(failed_files)}")
        return 1
    else:
        print(f"✓ All {total_files} files use correct load() syntax")
        return 0


if __name__ == "__main__":
    sys.exit(main())
