#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Real native/Deno boundary regressions: QUALITY NATIVE DENO DRIVER commands.

The parent Buck target supplies tool artifacts. No npm, Cargo, mocks or ad-hoc
compiler installs participate. These tests must run after slice integration.
"""

import importlib.util
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import unittest

QUALITY, NATIVE, DENO, DRIVER = sys.argv[1:5]
NATIVE = shlex.split(NATIVE)
DENO = shlex.split(DENO)
DRIVER = shlex.split(DRIVER)
spec = importlib.util.spec_from_file_location("web_quality", QUALITY)
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


class NativeQuality(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="web-native-quality-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.config = self.root / "deno.json"
        self.config.write_text(json.dumps({"lint": {"rules": {"include": ["no-explicit-any"]}}}))

    def source(self, name, text):
        path = self.root / name
        path.write_text(text)
        return path

    def run_tool(self, command, *args):
        env = dict(os.environ, DENO_NO_UPDATE_CHECK="1", NO_COLOR="1")
        return subprocess.run(command + [os.fspath(arg) for arg in args],
                              text=True, capture_output=True, env=env)

    def expect_success(self, command, *args):
        result = self.run_tool(command, *args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_bundle_minification_preserves_effects_live_exports_and_public_abi(self):
        entry = self.source("entry.ts", """
export const effects: string[] = [];
const watched = { get value() { effects.push("get"); return 7; } };
watched.value;
effects.push("start");
export let count = 0;
export function advance() { count++; effects.push("advance"); }
export class Counter { rpc() { return count; } }
export function attempt() {
  try { effects.push("try"); throw new Error("boom"); }
  finally { effects.push("finally"); }
}
await Promise.resolve().then(() => effects.push("await"));
export default { fetch() { return 42; }, retainedProperty: "🧭" };
""")
        bundle = self.root / "bundle.mjs"
        bundle_map = self.root / "bundle.mjs.map"
        self.expect_success(DENO, "bundle", "--quiet", "--format", "esm", "--platform", "browser",
                            "--sourcemap=external", "--output", bundle, entry)
        output = self.root / "minified.mjs"
        output_map = self.root / "minified.mjs.map"
        self.expect_success(NATIVE, "minify", "--input", bundle, "--output", output,
                            "--input-map", bundle_map, "--output-map", output_map)
        runner = self.source("observe.mjs", """
const module = await import(Deno.args[0]);
module.advance();
let message;
try { module.attempt(); } catch (error) { message = error.message; }
console.log(JSON.stringify({
  exports: Object.keys(module).sort(), effects: module.effects, count: module.count,
  rpc: new module.Counter().rpc(), fetch: module.default.fetch(),
  property: module.default.retainedProperty, error: message,
  names: [module.advance.name, module.Counter.name]
}));
""")
        expected = {
            "exports": ["Counter", "advance", "attempt", "count", "default", "effects"],
            "effects": ["get", "start", "await", "advance", "try", "finally"],
            "count": 1, "rpc": 1, "fetch": 42, "property": "🧭", "error": "boom",
            "names": ["advance", "Counter"],
        }
        for module in (bundle, output):
            observed = self.expect_success(DENO, "run", "--quiet", "--no-config", "--allow-read", runner, module.as_uri())
            self.assertEqual(json.loads(observed.stdout), expected)

    def test_unused_external_import_still_reports_missing_export(self):
        self.source("external.mjs", "export const present = 1;")
        bundle = self.source("external-bundle.mjs",
                             'import { missing } from "./external.mjs"; export const alive = true;')
        output = self.root / "external-minified.mjs"
        self.expect_success(NATIVE, "minify", "--input", bundle, "--output", output)
        runner = self.source("load.mjs", """
try {
  await import(Deno.args[0]);
  console.log(JSON.stringify({ loaded: true }));
} catch (error) {
  console.log(JSON.stringify({ name: error.name }));
}
""")
        for module in (bundle, output):
            observed = self.expect_success(DENO, "run", "--quiet", "--no-config", "--allow-read", runner, module.as_uri())
            self.assertEqual(json.loads(observed.stdout), {"name": "SyntaxError"})

    def test_malformed_bundle_reports_authored_location_without_writing_outputs(self):
        bundle = self.source("broken.mjs", "export const value = ;")
        # AAAA: generated (0,0) -> source 0 (0,0). A coarse authored map is
        # intentional: no generated bundle filename should replace ownership.
        input_map = self.source("broken.mjs.map", json.dumps({
            "version": 3, "sources": ["src/authored.ts"], "sourcesContent": ["bad source"],
            "names": [], "mappings": "AAAA",
        }))
        output = self.root / "rejected.mjs"
        output_map = self.root / "rejected.mjs.map"
        result = self.run_tool(NATIVE, "minify", "--input", bundle, "--output", output,
                               "--input-map", input_map, "--output-map", output_map)
        self.assertNotEqual(result.returncode, 0)
        report = json.loads(result.stdout)
        self.assertFalse(report["success"])
        self.assertEqual(report["diagnostics"][0]["path"], "src/authored.ts")
        self.assertEqual(report["diagnostics"][0]["location"], {"line": 1, "column": 0})
        self.assertFalse(output.exists())
        self.assertFalse(output_map.exists())

    def test_deno_specific_policy_remains_enforced_after_native_lint(self):
        source = self.source("deno_policy.ts", "export function identity(value: any) { return value; }\n")
        self.expect_success(NATIVE, "lint", source)
        deno = self.run_tool(DENO, "lint", "--config", self.config, source)
        self.assertNotEqual(deno.returncode, 0)
        self.assertIn("no-explicit-any", deno.stdout + deno.stderr)
        self.assertNotEqual(quality.lint(NATIVE, DENO, self.config, [source], deno_lint=True), 0)

    def test_relative_authored_paths_are_linted_with_the_unit_config(self):
        # Buck sources are cwd-relative, unlike the absolute temporary paths above.
        source = self.source("relative_policy.ts", "export function identity(value: any) { return value; }\n")
        result = self.run_tool(DRIVER, "lint", "--native", NATIVE[0], "--deno", DENO[0],
                               "--deno-lint", "--config", self.config, os.path.relpath(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no-explicit-any", result.stdout + result.stderr)

    def test_native_quality_does_not_require_a_runtime_or_deno_policy(self):
        source = self.source("portable.ts", "export function identity(value: any) { return value; }\n")
        result = self.run_tool(DRIVER, "lint", "--native", NATIVE[0], source)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        broken = self.source("broken.ts", "export const result = ;\n")
        result = self.run_tool(DRIVER, "lint", "--native", NATIVE[0], broken)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("broken.ts", result.stdout + result.stderr)

    def test_component_diagnostics_fail_quality_lint(self):
        component = self.source("Broken.svelte", "<script>let = ;</script><p>broken</p>")
        self.assertNotEqual(quality.lint(NATIVE, DENO, self.config, [component], deno_lint=True), 0)

    def test_declarations_and_data_are_not_linted(self):
        declaration = self.source("types.d.ts", "declare const value: any;\n")
        data = self.source("payload.json", "{broken data")
        unsupported = self.source("notes.txt", "<broken")
        self.assertEqual(quality.lint(NATIVE, DENO, self.config, [declaration, data, unsupported], deno_lint=True), 0)

    def test_format_check_and_write_reach_fixed_point_without_touching_data(self):
        component = self.source("Widget.svelte", "<script>let count=1;</script><p>{count}</p>")
        data = self.source("payload.json", "{\"a\":1}")
        before_component, before_data = component.read_bytes(), data.read_bytes()
        self.assertNotEqual(quality.format(NATIVE, [component, data], check=True), 0)
        self.assertEqual(component.read_bytes(), before_component)
        self.assertEqual(quality.format(NATIVE, [component, data], write=True), 0)
        self.assertEqual(quality.format(NATIVE, [component, data], check=True), 0)
        self.assertEqual(data.read_bytes(), before_data)

    def test_malformed_formatter_input_is_not_overwritten(self):
        source = self.source("broken.ts", "export const value: = 1;")
        before = source.read_bytes()
        self.assertNotEqual(quality.format(NATIVE, [source], write=True), 0)
        self.assertEqual(source.read_bytes(), before)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
