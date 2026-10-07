#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run native compilation, then the real Deno checker and ownership guard."""

import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import unittest

DRIVER, DENO, NATIVE, RUNTIME = sys.argv[1:5]
with open(RUNTIME) as stream:
    PACKAGES = json.load(stream)


def command(executable, *arguments):
    return subprocess.run(shlex.split(executable) + list(arguments), capture_output=True, text=True, env=dict(os.environ, NO_COLOR="1"))


def check(component, consumer=None, helper=None, declared_helper=True):
    with tempfile.TemporaryDirectory(prefix="web-svelte-check-") as temporary:
        root = pathlib.Path(temporary)
        page = root / "Page.svelte"
        page.write_text(component)
        files = [{"source": os.path.relpath(page), "name": "case/Page.svelte"}]
        if helper is not None:
            path = root / "helper.ts"
            path.write_text(helper)
            if declared_helper:
                files.append({"source": os.path.relpath(path), "name": "case/helper.ts"})
        native_manifest = root / "native.json"
        native_manifest.write_text(json.dumps({"files": files}))
        output = root / "generated"
        compiled = command(NATIVE, "compile", "--manifest", str(native_manifest), "--out-dir", str(output))
        if compiled.returncode:
            return compiled
        unit = {"label": "case//:page", "import_name": "@fixture/page", "deps": [], "srcs": [item["source"] for item in files], "exports": {"@fixture/page": os.path.relpath(page)}, "generated": {"directory": os.path.relpath(output), "files": files}, "svelte_runtime": True}
        manifest = {"unit": unit, "libraries": [], "runtime": PACKAGES}
        if consumer is not None:
            path = root / "consumer.ts"
            path.write_text(consumer)
            manifest["libraries"] = [unit]
            manifest["unit"] = {"label": "case//:consumer", "import_name": None, "deps": [unit["label"]], "srcs": [os.path.relpath(path)], "exports": {}, "svelte_runtime": True}
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest))
        config = root / "deno.json"
        configured = command(DRIVER, "config", "--manifest", str(manifest_path), "--out", str(config))
        if configured.returncode:
            return configured
        return command(DRIVER, "check", "--manifest", str(manifest_path), "--config", str(config), "--deno", DENO, "--native", NATIVE, "--stamp", str(root / "stamp"))


class CheckedSvelte(unittest.TestCase):
    def test_declared_neighbor_and_props_are_checked(self):
        result = check('<script lang="ts">import type { Props } from "./helper.ts"; let { count }: Props = $props();</script><p>{count}</p>', 'import Page from "@fixture/page"; import type { ComponentProps } from "svelte"; export const props: ComponentProps<typeof Page> = { count: 3 };', 'export interface Props { count: number }')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_exported_component_rejects_wrong_prop(self):
        result = check('<script lang="ts">let { count }: {count: number} = $props();</script><p>{count}</p>', 'import Page from "@fixture/page"; import type { ComponentProps } from "svelte"; export const props: ComponentProps<typeof Page> = { count: "wrong" };')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("TS2322", result.stderr)

    def test_authored_type_error_retains_original_svelte_location(self):
        result = check('<script lang="ts">\nconst greeting = "😀"; let count: number = "wrong";\n</script><p>{greeting}{count}</p>')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("TS2322", result.stderr)
        self.assertIn("Page.svelte:2:", result.stderr)

    def test_undeclared_neighbor_is_not_admitted_by_generation(self):
        result = check('<script lang="ts">import { count } from "./helper.ts";</script><p>{count}</p>', helper='export const count = 3;', declared_helper=False)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("import graph check failed", result.stderr)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
