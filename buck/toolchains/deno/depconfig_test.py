#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Consumer-visible import-map conflicts and JSONC relocation regressions."""

import json
import os
import tempfile
import unittest
import subprocess
import sys
from pathlib import Path

import depconfig


def manifest(source):
    return {
        "unit": {"label": "root//:app", "exports": {}, "srcs": [], "wasm": {}, "deps": ["root//:core"]},
        "libraries": [{"label": "root//:core", "exports": {"@fixture/core": str(source)}, "srcs": [str(source)], "wasm": {}, "deps": []}],
        "runtime": {},
    }


class DependencyConfigTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.output = self.root / "generated" / "config"
        self.output.mkdir(parents=True)
        self.config = self.source / "deno.jsonc"
        self.library = self.source / "core.js"
        self.library.write_text("export const answer = 42;\n")

    def merge(self, text):
        self.config.write_text(text)
        return depconfig.merge_import_map(manifest(self.library), str(self.config), str(self.output))

    def resolve(self, path):
        return Path(os.path.normpath(self.output / path))

    def test_jsonc_import_map_relative_origins(self):
        config = self.merge('''{
          // The URL and comment-looking literal must not become comments.
          "imports": {"alias": "./alias.ts", "remote": "https://example.test/a//b", "pattern": "npm:pkg",},
          "scopes": {"./nested/": {"alias": "../outside.ts",},},
          "compilerOptions": {"strict": false, "types": ["./globals.d.ts", "npm:pkg"],},
          "lint": {"exclude": ["generated/**"], "rules": {"exclude": ["no-explicit-any"]}},
          "lock": {"path": "./locks/deno.lock", "frozen": true},
          "tasks": {"hello": "echo /* not a comment */,}"},
        }''')
        self.assertEqual(self.resolve(config["imports"]["alias"]), self.source / "alias.ts")
        self.assertEqual(config["imports"]["remote"], "https://example.test/a//b")
        self.assertEqual(config["imports"]["pattern"], "npm:pkg")
        self.assertEqual(self.resolve(config["imports"]["@fixture/core"]), self.library)
        scope, mappings = next(iter(config["scopes"].items()))
        self.assertTrue(scope.endswith("/"))
        self.assertEqual(self.resolve(scope), self.source / "nested")
        self.assertEqual(self.resolve(mappings["alias"]), self.root / "outside.ts")

    def test_exact_and_prefix_scope_conflicts_are_errors(self):
        for config in (
            {"imports": {"@fixture/core": "./other.ts"}},
            {"imports": {"@fixture/": "./other/"}},
            {"scopes": {"./nested/": {"@fixture/core": "./other.ts"}}},
        ):
            with self.subTest(config=config), self.assertRaises(ValueError):
                self.merge(json.dumps(config))

    def test_library_export_collision_is_rejected(self):
        graph = manifest(self.library)
        graph["libraries"].append({"label": "root//:other", "exports": {"@fixture/core": str(self.source / "other.js")}})
        with self.assertRaises(depconfig.webc.GraphError):
            depconfig.merge_import_map(graph, None, str(self.output))

    def test_local_import_map_keeps_its_own_origin(self):
        maps = self.source / "maps"
        maps.mkdir()
        (maps / "imports.jsonc").write_text('{"imports": {"alias": "./entry.ts",}, "scopes": {"./nested/": {"alias": "../other.ts"}}}')
        config = self.merge('{"importMap": "./maps/imports.jsonc", "imports": {"ignored": "./ignored.ts"}, "lock": false}')
        self.assertNotIn("importMap", config)
        self.assertNotIn("ignored", config["imports"])
        self.assertEqual(self.resolve(config["imports"]["alias"]), maps / "entry.ts")
        scope, mapping = next(iter(config["scopes"].items()))
        self.assertEqual(self.resolve(scope), maps / "nested")
        self.assertEqual(self.resolve(mapping["alias"]), self.source / "other.ts")

    def test_remote_map_relative_targets_keep_remote_origin(self):
        self.assertEqual(depconfig.relocate("../entry.ts", "https://example.test/maps/", str(self.output)), "https://example.test/entry.ts")
        self.assertEqual(depconfig.relocate("/entry.ts", "https://example.test/maps/", str(self.output)), "https://example.test/entry.ts")
        self.assertEqual(depconfig.relocate("npm:pkg", "https://example.test/maps/", str(self.output)), "npm:pkg")

    def test_config_package_alias_subpaths_are_preserved(self):
        result = self.merge('{"imports": {"@std/assert": "jsr:@std/assert@^1", "pkg": "npm:pkg@^2"}}')
        self.assertEqual(result["imports"]["@std/assert/"], "jsr:/@std/assert@^1/")
        self.assertEqual(result["imports"]["pkg/"], "npm:/pkg@^2/")

    def test_direct_and_transitive_dependencies_have_importer_scopes(self):
        leaf = self.source / "leaf.js"
        leaf.write_text("export const leaf = 41;\n")
        self.library.write_text('import { leaf } from "@fixture/leaf"; export const answer = leaf + 1;\n')
        graph = manifest(self.library)
        graph["libraries"][0]["deps"] = ["root//:leaf"]
        graph["libraries"].append({
            "label": "root//:leaf", "exports": {"@fixture/leaf": str(leaf)},
            "srcs": [str(leaf)], "wasm": {}, "deps": [],
        })
        entry = self.source / "entry.js"
        map_path = self.output / "import-map.json"

        def run(source):
            entry.write_text(source)
            mapping = depconfig.merge_import_map(graph, None, str(self.output))
            map_path.write_text(json.dumps(mapping))
            return subprocess.run(
                [DENO, "run", "--no-config", "--no-lock", "--import-map", str(map_path), str(entry)],
                text=True, capture_output=True, env={**os.environ, "DENO_NO_UPDATE_CHECK": "1"},
            )

        result = run('import { answer } from "@fixture/core"; console.log(answer);\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "42")
        result = run('import { leaf } from "@fixture/leaf"; console.log(leaf);\n')
        self.assertNotEqual(result.returncode, 0)
        graph["unit"]["deps"].append("root//:leaf")
        result = run('import { leaf } from "@fixture/leaf"; console.log(leaf);\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "41")
        # Root-global direct deps do not leak into libraries that lack that edge.
        graph["libraries"][0]["deps"] = []
        result = run('import { answer } from "@fixture/core"; console.log(answer);\n')
        self.assertNotEqual(result.returncode, 0)

    def test_check_stamp_requires_all_original_root_types_to_pass(self):
        first = self.source / "first.ts"
        second = self.source / "second.ts"
        first.write_text('export const name: string = "first";\n')
        second.write_text("export const name: string = 42;\n")
        stamp = self.output / "check.stamp"
        command = [DENO, "check", "--no-config", "--no-lock", str(first), str(second)]
        self.assertNotEqual(depconfig.check_stamp(str(stamp), command), 0)
        self.assertFalse(stamp.exists())
        second.write_text('export const name: string = "second";\n')
        self.assertEqual(depconfig.check_stamp(str(stamp), command), 0)
        self.assertTrue(stamp.is_file())



if __name__ == "__main__":
    DENO = sys.argv.pop(1)
    unittest.main()
