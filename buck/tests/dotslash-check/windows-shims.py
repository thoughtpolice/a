#!/usr/bin/env python3

# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Check that all .exe files in buck/bin are valid dotslash Windows shims
by verifying their size and SHA256 hash.
"""

import hashlib
import sys
from pathlib import Path


VALID_SHIM_HASHES = [
    "174387691274630e4b56b7146d164afcaf3e1d96733cd0e1979e3ad829b13721",
]

EXPECTED_SIZE = 4096


def check_exe_file(file_path: Path) -> bool:
    """Check a single .exe file to verify it's a valid dotslash Windows shim."""
    print(f"Checking {file_path.name}...")

    try:
        actual_size = file_path.stat().st_size
        if actual_size != EXPECTED_SIZE:
            print(f"  ERROR: Size mismatch")
            print(f"         Expected: {EXPECTED_SIZE} bytes")
            print(f"         Actual:   {actual_size} bytes")
            return False

        with open(file_path, 'rb') as f:
            file_data = f.read()

        actual_hash = hashlib.sha256(file_data).hexdigest()
        if actual_hash not in VALID_SHIM_HASHES:
            print(f"  ERROR: Hash mismatch")
            print(f"         Expected one of: {VALID_SHIM_HASHES}")
            print(f"         Actual:          {actual_hash}")
            return False

        print(f"  ✓ Size: {actual_size} bytes")
        print(f"  ✓ Hash: {actual_hash}")
        return True

    except Exception as e:
        print(f"  ERROR: Failed to process {file_path.name}: {e}")
        return False


def main():
    """Check all .exe files in buck/bin directory"""

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
    buck_bin_extra_dir = repo_root / "buck" / "bin" / "extra"

    exe_files = []

    for directory in [buck_bin_dir, buck_bin_extra_dir]:
        if not directory.exists():
            continue

        for item in directory.iterdir():
            if item.is_file() and item.name.endswith(".exe"):
                exe_files.append(item)

    if not exe_files:
        print("No .exe files found to check")
        return 0

    print(f"Found {len(exe_files)} .exe files to verify")
    print()

    failed_files = []

    for exe_file in sorted(exe_files):
        if not check_exe_file(exe_file):
            failed_files.append(exe_file.name)
        print()

    if failed_files:
        print(f"{len(failed_files)} files failed verification:")
        for failed_file in failed_files:
            print(f"  - {failed_file}")
        return 1

    print(f"All {len(exe_files)} .exe files passed verification!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
