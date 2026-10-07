#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check that a Lean module depends on the modules it imports, not on the
targets they belong to.

`:granular-lib` has one module, Granular.Abc, which imports Granular.Xyz
from `:granular-other`; that library also has Granular.Unused, which
nothing imports. The action graph behind Granular.Abc (`buck2 aquery`,
which lays out the dynamic actions as a build would) must hold the elab
actions of Abc and Xyz and not Unused's: the compile step of a library runs
once its import headers are parsed, and each module's action takes the
artifacts of the modules it imports. So Abc compiles as soon as Xyz has,
whatever else `:granular-other` is still building. The query runs in a Buck
daemon of its own, which this stops at the end.
"""

import json
import subprocess
import sys

ISOLATION_DIR = ".lean-granular-tests"
MODULE = "toolchains//lean/tests:granular-lib--lean[Granular.Abc]"


def fail(msg: str):
    print("FAIL: " + msg, file=sys.stderr)
    sys.exit(1)


def buck(root: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["buck2", "--isolation-dir", ISOLATION_DIR, *args],
        cwd=root,
        capture_output=True,
        text=True,
    )


def main():
    root = subprocess.run(
        ["buck2", "root", "--kind", "project"], capture_output=True, text=True, check=True
    ).stdout.strip()
    try:
        query = buck(
            root,
            "aquery",
            "deps('{}')".format(MODULE),
            "--output-attribute",
            "category",
            "--output-attribute",
            "identifier",
            "--json",
        )
    finally:
        buck(root, "kill")
    if query.returncode != 0:
        fail("aquery failed:\n" + query.stderr)

    # Keyed by action: `(target: ..., id: ...)` for the actions, the queried
    # label for the analysis node that has them. Only the elab actions
    # matter here; the others compile the helper tool and parse imports.
    actions = json.loads(query.stdout)
    elabs = sorted(
        "{} {}".format(key.split(" (cfg")[0].split("`")[1] if "`" in key else key, attrs["identifier"])
        for key, attrs in actions.items()
        if attrs.get("category") == "lean_elab"
    )
    print("elab actions behind {}:\n  ".format(MODULE) + "\n  ".join(elabs))
    modules = sorted(e.split(" ")[1] for e in elabs)
    if modules != ["Granular.Abc", "Granular.Xyz"]:
        fail("expected the elab actions of Granular.Abc and Granular.Xyz only, got {}".format(modules))
    print("OK")


if __name__ == "__main__":
    main()
