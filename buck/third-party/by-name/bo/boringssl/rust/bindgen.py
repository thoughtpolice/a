# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Runs bindgen, from PATH, after checking that it is the release expected.

Bindgen's output differs between releases, so a developer's or CI image's
bindgen of another version fails the build rather than silently changing
the bindings.

Usage: bindgen.py VERSION ARGS...
"""

import shutil
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: bindgen.py VERSION ARGS...", file=sys.stderr)
        return 2
    expected = "bindgen " + sys.argv[1]
    bindgen = shutil.which("bindgen")
    if bindgen is None:
        print("bindgen is not on PATH: install bindgen-cli " + sys.argv[1], file=sys.stderr)
        return 1
    found = subprocess.run([bindgen, "--version"], capture_output=True, text=True).stdout.strip()
    if found != expected:
        print(f"expected {expected}, found {found}", file=sys.stderr)
        return 1
    return subprocess.run([bindgen, *sys.argv[2:]]).returncode


if __name__ == "__main__":
    sys.exit(main())
