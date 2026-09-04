#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Negative cases for the celld driver's import-graph and type checks.

A failing unit cannot be a Buck target (building the package would fail), so
this runner writes each unit's manifest itself, in the format the rules emit,
and runs the driver's `config` and `check` steps directly. Every case but the
control must fail with the named diagnostic.

Usage: graph_test.py DRIVER DENO TYPES TESTING BAD_DIR
"""

import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest

DRIVER, DENO, TYPES, TESTING, BAD = sys.argv[1:6]


def library(name: str, deps: list[str]) -> dict:
    path = os.path.join(BAD, name, "mod.ts")
    return {
        "deps": deps,
        "exports": {"@bad/" + name: path},
        "import_name": "@bad/" + name,
        "label": "bad//:" + name,
        "srcs": [path],
    }


DEP = library("dep", [])
MID = library("mid", ["bad//:dep"])


# An `npm:` import cannot live in the tree: Deno's language server preloads
# every source it finds and would fetch the package on each start.
NPM_CASE = """\
// npm packages are not part of the first-party build graph.
import leftPad from "npm:left-pad@1.3.0";

export const VALUE = leftPad("x", 2);
"""


def run(
    srcs: list[str],
    deps: list[str],
    libraries: list[dict],
    written: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory(prefix="celld-graph-") as tmp:
        paths = [os.path.join(BAD, "cases", src) for src in srcs]
        for name, text in (written or {}).items():
            # Relative, like every path the rules hand the driver.
            paths.append(os.path.relpath(os.path.join(tmp, name)))
            with open(paths[-1], "w") as f:
                f.write(text)
        manifest = {
            "libraries": libraries,
            "testing": TESTING,
            "types": TYPES,
            "unit": {
                "deps": deps,
                "exports": {},
                "import_name": None,
                "label": "bad//:case",
                "srcs": paths,
            },
        }
        path = os.path.join(tmp, "manifest.json")
        with open(path, "w") as f:
            json.dump(manifest, f)
        config = os.path.join(tmp, "deno.json")
        driver = shlex.split(DRIVER)
        result = subprocess.run(
            driver + ["config", "--manifest", path, "--out", config],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return result
        return subprocess.run(
            driver
            + [
                "check",
                "--manifest",
                path,
                "--config",
                config,
                "--deno",
                DENO,
                "--stamp",
                os.path.join(tmp, "stamp"),
            ],
            capture_output=True,
            text=True,
            env=dict(os.environ, NO_COLOR="1"),
        )


class GraphTest(unittest.TestCase):
    def assert_fails(self, result: subprocess.CompletedProcess, *needles: str) -> None:
        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0, output)
        for needle in needles:
            self.assertIn(needle, output)

    def test_control_passes(self) -> None:
        result = run(["good.ts"], [MID["label"]], [MID, DEP])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_transitive_import(self) -> None:
        result = run(["transitive.ts"], [MID["label"]], [MID, DEP])
        self.assert_fails(result, '"@bad/dep" comes from bad//:dep, which is not a direct dependency of bad//:case')

    def test_relative_escape(self) -> None:
        result = run(["escape.ts"], [DEP["label"]], [DEP])
        self.assert_fails(result, 'relative import "../dep/mod.ts" leaves the srcs of bad//:case')

    def test_undeclared_file(self) -> None:
        result = run(["undeclared.ts"], [], [])
        self.assert_fails(result, "helper.ts: not in the srcs of any target", 'relative import "./helper.ts"')

    def test_npm_import(self) -> None:
        result = run([], [], [], written={"npm.ts": NPM_CASE})
        self.assert_fails(result, 'unsupported import "npm:left-pad@1.3.0"')

    def test_node_builtin(self) -> None:
        result = run(["node.ts"], [], [])
        self.assert_fails(result, 'unsupported import "node:fs"', "unsupported node module")

    def test_type_error(self) -> None:
        result = run(["types.ts"], [], [])
        self.assert_fails(result, "TS2322", "type check failed for bad//:case")

    def test_duplicate_specifier(self) -> None:
        clash = dict(DEP, label="bad//:other")
        result = run(["good.ts"], [MID["label"]], [MID, DEP, clash])
        self.assert_fails(result, "specifier @bad/dep is claimed by both bad//:dep and bad//:other")


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1])
