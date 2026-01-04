#!/usr/bin/env python3

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
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


def main(file_name: str):
    """Check a single .exe file to verify it's a valid dotslash Windows shim."""
    file_path = Path(file_name)
    print(f"Checking {file_path.name}...")

    try:
        actual_size = file_path.stat().st_size
        if actual_size != EXPECTED_SIZE:
            print(f"  ERROR: Size mismatch")
            print(f"         Expected: {EXPECTED_SIZE} bytes")
            print(f"         Actual:   {actual_size} bytes")
            return 1

        with open(file_path, 'rb') as f:
            file_data = f.read()

        actual_hash = hashlib.sha256(file_data).hexdigest()
        if actual_hash not in VALID_SHIM_HASHES:
            print(f"  ERROR: Hash mismatch")
            print(f"         Expected one of: {VALID_SHIM_HASHES}")
            print(f"         Actual:          {actual_hash}")
            return 1

        print(f"  ✓ Size: {actual_size} bytes")
        print(f"  ✓ Hash: {actual_hash}")
        return 0

    except Exception as e:
        print(f"  ERROR: Failed to process {file_path.name}: {e}")
        return 1


if __name__ == "__main__":
    if len(sys.argv) < 1:
        print("ERROR: must provide file name of .exe file!")
        sys.exit(1)

    sys.exit(main(sys.argv[1]))
