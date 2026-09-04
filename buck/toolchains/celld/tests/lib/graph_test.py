#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Negative cases for the celld driver's import-graph and type checks.

A failing unit cannot be a Buck target (building the package would fail), so
this runner writes each unit's manifest itself, in the format the rules emit,
and runs the driver's `config` and `check` steps directly. Every case but the
control must fail with the named diagnostic.

Usage: graph_test.py DRIVER DENO NATIVE TYPES TESTING BAD_DIR
"""

import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
import unittest

DRIVER, DENO, NATIVE, TYPES, TESTING, BAD = sys.argv[1:7]


def platform() -> dict:
    return {
        "name": "celld",
        "types": [TYPES],
        "modules": {
            "cloudflare:" + name: os.path.join(TESTING, name + ".ts")
            for name in ("sockets", "workers", "workflows")
        },
        "externals": ["cloudflare:*"],
        "compiler_libs": ["deno.ns", "dom", "dom.iterable", "esnext"],
        "deno_lint": True,
        "server_conditions": ["worker", "default"],
    }


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


# An empty module (magic and version) for wasm specifiers.
EMPTY_WASM = bytes([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0])

# Imports the wasm module of @bad/mid, which the unit does not depend on.
WASM_TRANSITIVE_CASE = """\
import m from "@bad/mid/wasm";

export const VALUE: WebAssembly.Module = m;
"""

# Uses a direct dependency's wasm module: the control for the case above.
WASM_DIRECT_CASE = """\
import m from "@bad/mid/wasm";

export const VALUE: string[] = WebAssembly.Module.exports(m).map((e) => e.name);
"""


def with_wasm(library: dict, tmp: str) -> dict:
    """The library with a `./wasm` module, written to `tmp`."""
    path = os.path.relpath(os.path.join(tmp, "empty.wasm"))
    with open(path, "wb") as f:
        f.write(EMPTY_WASM)
    return dict(library, wasm={library["import_name"] + "/wasm": {"module": "bad_mid_wasm.wasm", "path": path}})


def driver(*argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(shlex.split(DRIVER) + list(argv), capture_output=True, text=True)


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
            "platform": platform(),
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
        # A closure with wasm modules gets its shims beside the config, in
        # one directory, as the rules lay it out.
        has_wasm = any(library.get("wasm") for library in libraries)
        out = os.path.join(tmp, "config")
        config = os.path.join(out, "deno.json") if has_wasm else os.path.join(tmp, "deno.json")
        if has_wasm:
            result = driver("config", "--manifest", path, "--out-dir", out)
        else:
            result = driver("config", "--manifest", path, "--out", config)
        if result.returncode != 0:
            return result
        return subprocess.run(
            shlex.split(DRIVER)
            + [
                "check",
                "--manifest",
                path,
                "--config",
                config,
                "--deno",
                DENO,
                "--native",
                NATIVE,
                "--stamp",
                os.path.join(tmp, "stamp"),
            ]
            + (["--wasm-dir", os.path.join(out, "wasm")] if has_wasm else []),
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
        # Analysis leaves this to the driver, whose config step reports it.
        clash = dict(DEP, label="bad//:other")
        result = run(["good.ts"], [MID["label"]], [MID, DEP, clash])
        self.assert_fails(result, "specifier @bad/dep is claimed by both bad//:dep and bad//:other")

    def test_direct_wasm_import_passes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="celld-wasm-") as tmp:
            mid = with_wasm(MID, tmp)
            result = run([], [mid["label"]], [mid, DEP], written={"direct.ts": WASM_DIRECT_CASE})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_transitive_wasm_import(self) -> None:
        with tempfile.TemporaryDirectory(prefix="celld-wasm-") as tmp:
            mid = with_wasm(MID, tmp)
            top = library("top", [mid["label"]])
            result = run([], [top["label"]], [top, mid, DEP], written={"wasm.ts": WASM_TRANSITIVE_CASE})
        self.assert_fails(result, '"@bad/mid/wasm" comes from bad//:mid, which is not a direct dependency of bad//:case')

    def test_wasm_specifier_clashes_with_an_export(self) -> None:
        with tempfile.TemporaryDirectory(prefix="celld-wasm-") as tmp:
            mid = with_wasm(MID, tmp)
            clash = dict(DEP, label="bad//:other", exports={"@bad/mid/wasm": DEP["srcs"][0]})
            result = run(["good.ts"], [mid["label"]], [mid, DEP, clash])
        self.assert_fails(result, "specifier @bad/mid/wasm is claimed by both")

    def test_config_paths_start_with_a_dot_segment(self) -> None:
        # ".hidden/mod.ts" is not relative to Deno; "./.hidden/mod.ts" is.
        with tempfile.TemporaryDirectory(prefix="celld-config-") as tmp:
            hidden = os.path.relpath(os.path.join(tmp, "out", ".hidden", "mod.ts"))
            manifest = os.path.join(tmp, "manifest.json")
            with open(manifest, "w") as f:
                json.dump(
                    {
                        "libraries": [dict(DEP, exports={"@bad/hidden": hidden})],
                        "platform": platform(),
                        "unit": {"deps": [], "exports": {}, "import_name": None, "label": "bad//:case", "srcs": []},
                    },
                    f,
                )
            out = os.path.join(tmp, "out", "deno.json")
            os.makedirs(os.path.dirname(out))
            result = driver("config", "--manifest", manifest, "--out", out)
            self.assertEqual(result.returncode, 0, result.stderr)
            with open(out) as f:
                imports = json.load(f)["imports"]
            self.assertEqual(imports["@bad/hidden"], "./.hidden/mod.ts")

    def test_fakes_cover_the_declared_runtime_modules(self) -> None:
        """Every value a `cloudflare:*` module of celld.d.ts exports has a
        fake in the testing directory, so a fake_runtime test can import
        whatever the real runtime offers."""
        with open(TYPES) as f:
            modules = sorted(set(re.findall(r'^declare module "(cloudflare:[^"]+)"', f.read(), re.M)))
        self.assertIn("cloudflare:workers", modules)
        fakes = {
            "cloudflare:sockets": "sockets.ts",
            "cloudflare:workers": "workers.ts",
            "cloudflare:workflows": "workflows.ts",
        }
        self.assertEqual(sorted(fakes), modules, "a declared module has no fake; add it to the celld adapter's runtime_modules")
        with tempfile.TemporaryDirectory(prefix="celld-fakes-") as tmp:
            lines = ["type Covered<Missing extends never> = Missing;"]
            for i, module in enumerate(modules):
                fake = pathlib.Path(os.path.abspath(os.path.join(TESTING, fakes[module]))).as_uri()
                lines.append("import type * as Fake{} from {};".format(i, json.dumps(fake)))
                lines.append(
                    "export type Missing{0} = Covered<Exclude<keyof typeof import({1}), keyof typeof Fake{0}>>;".format(
                        i, json.dumps(module)
                    )
                )
            check = os.path.join(tmp, "fakes.ts")
            with open(check, "w") as f:
                f.write("\n".join(lines) + "\n")
            config = os.path.join(tmp, "deno.json")
            with open(config, "w") as f:
                json.dump({"lock": False, "compilerOptions": {"strict": True, "types": [os.path.abspath(TYPES)]}}, f)
            result = subprocess.run(
                shlex.split(DENO) + ["check", "--quiet", "--no-remote", "--config", config, check],
                capture_output=True,
                text=True,
                env=dict(os.environ, NO_COLOR="1", DENO_NO_UPDATE_CHECK="1"),
            )
            self.assertEqual(result.returncode, 0, "a fake lacks a declared export:\n" + result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1])
