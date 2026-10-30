#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check that a release build compiles the generated C with NDEBUG.

Lake compiles a release build's C with `-O3 -DNDEBUG`. Here `-O3` comes from
the C++ toolchain's flags in release mode, and the Lean rules add `NDEBUG`,
which turns off `lean.h`'s assertions. The C targets of a library, a binary
and an executable test must carry it in release mode and not in debug mode.
The query (`buck2 cquery`, the flags as configured in each mode) runs in a
Buck daemon of its own, which this stops at the end.
"""

import json
import subprocess
import sys

ISOLATION_DIR = ".lean-build-mode-tests"
TARGETS = [
    "toolchains//lean/tests:greeting--native",
    "toolchains//lean/tests:hello",
    "toolchains//lean/tests:hello-test--bin",
]


def fail(msg: str):
    print("FAIL: " + msg, file=sys.stderr)
    sys.exit(1)


def flags(root: str, mode: list[str]) -> dict[str, list[str]]:
    query = subprocess.run(
        ["buck2", "--isolation-dir", ISOLATION_DIR, "cquery", *mode, "set({})".format(" ".join(TARGETS)),
         "--output-attribute", "compiler_flags", "--json"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if query.returncode != 0:
        fail("cquery failed:\n" + query.stderr)
    return {key.split(" (cfg")[0]: attrs["compiler_flags"] for key, attrs in json.loads(query.stdout).items()}


def main():
    root = subprocess.run(
        ["buck2", "root", "--kind", "project"], capture_output=True, text=True, check=True
    ).stdout.strip()
    try:
        debug = flags(root, [])
        release = flags(root, ["-m", "release"])
    finally:
        subprocess.run(["buck2", "--isolation-dir", ISOLATION_DIR, "kill"], cwd=root, capture_output=True)
    if len(debug) != len(TARGETS) or len(release) != len(TARGETS):
        fail("expected {} targets, got {} and {}".format(len(TARGETS), sorted(debug), sorted(release)))
    for target in sorted(debug):
        print("{}: debug {}, release {}".format(target, "-DNDEBUG" in debug[target], "-DNDEBUG" in release[target]))
        if "-DNDEBUG" in debug[target]:
            fail("{} is compiled with NDEBUG in debug mode".format(target))
        if "-DNDEBUG" not in release[target]:
            fail("{} is compiled without NDEBUG in release mode".format(target))
    print("OK")


if __name__ == "__main__":
    main()
