#!/usr/bin/env python3

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

import os
import re
import sys
from pathlib import Path


def check_final_newline(file_path):
    """Check if a file ends with a newline character."""
    try:
        with open(file_path, "rb") as f:
            content = f.read()
            if len(content) == 0:
                return True  # Empty files are OK
            return content.endswith(b"\n")
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return False


def check_trailing_whitespace(file_path):
    """Check if a file has trailing whitespace on any line."""
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
            for line_num, line in enumerate(lines, 1):
                # Remove the final newline to check trailing whitespace
                line_content = line.rstrip("\n\r")
                if line_content != line_content.rstrip():
                    return False, line_num
        return True, None
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return False, None


# Skip binary files and certain extensions
SKIP_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".ico",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".bz2",
    ".xz",
    ".7z",
    ".bin",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".a",
    ".lock",
    ".hex0",
    ".hex1",
    ".hex2",
    ".M1",
    ".pyc",
    ".pyo",
    ".pyd",
    ".json",
    ".jsonl",
    ".jsonc",
    ".wasm",
    ".o",
    ".obj",
}

# Skip certain path prefixes (regex patterns)
SKIP_PATTERNS = [
    r"^\.jj/",
    r"^\.git/",
    r"^buck-out/",
    r"^\.direnv/",
    r"^\.vscode/extensions/[^/]+/out/",
    r"^cellar/",
    r"node_modules",  # anywhere in path
    r"^\.ruff_cache/",
    r"^buck/third-party/zuo/lib",
    r"^buck/third-party/zuo/local",
    r"^buck/third-party/zuo/zuo.*",
    r"^work/",  # work directory
]


def should_skip_dir(dir_path):
    """Determine if the walk should descend into a directory at all.

    Every pattern above is anchored at a path prefix, so a directory one of them
    matches can only hold files it would also match. Pruning the walk rather than
    rejecting those files one at a time is what keeps the ~170k build outputs
    under buck-out out of the traversal entirely.
    """
    # The trailing slash stops a prefix like '^work/' matching a sibling
    # directory such as 'workspace/'.
    path_str = str(Path(dir_path)).replace("\\", "/") + "/"
    return any(re.search(pattern, path_str) for pattern in SKIP_PATTERNS)


def should_check_file(file_path):
    """Determine if a file should be checked for whitespace issues."""
    path = Path(file_path)
    path_str = str(path).replace("\\", "/")  # normalize for Windows

    # Check if the path matches any skip pattern
    for pattern in SKIP_PATTERNS:
        if re.search(pattern, path_str):
            return False

    # Check file extension
    if path.suffix.lower() in SKIP_EXTENSIONS:
        return False

    # Skip dotslash files (they're binary-ish)
    if path.name.startswith(".") and not path.suffix:
        return False

    return True


def main():
    """Main function to check whitespace in source files."""
    repo_root = "."
    errors = []

    # Find all files in the repository
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if not should_skip_dir(Path(root) / d)]
        for file in files:
            file_path = Path(root) / file

            if not should_check_file(file_path):
                continue

            print(f"Checking file {file_path}")
            # Check for missing final newline
            if not check_final_newline(file_path):
                errors.append(
                    f"{file_path.relative_to(repo_root)}: Missing final newline"
                )

            # Check for trailing whitespace
            no_trailing, line_num = check_trailing_whitespace(file_path)
            if not no_trailing and line_num is not None:
                errors.append(
                    f"{file_path.relative_to(repo_root)}:{line_num}: Trailing whitespace"
                )

    if errors:
        print("Whitespace errors found:")
        for error in sorted(errors):
            print(f"  {error}")
        sys.exit(1)
    else:
        print("All source files have proper whitespace formatting")
        sys.exit(0)


if __name__ == "__main__":
    main()
