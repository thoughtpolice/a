# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check what a browser package may hold and what --check refuses."""

import importlib.machinery
import json
import pathlib
import sys
import tempfile
import types
import unittest

source = sys.argv.pop(1) if len(sys.argv) > 1 else str(
    pathlib.Path(__file__).with_name("web_package.py"))
loader = importlib.machinery.SourceFileLoader("web_package", source)
packager = types.ModuleType(loader.name)
loader.exec_module(packager)


class WebPackageTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="web-package-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)
        self.module = self.directory / "linked.wasm"
        self.module.write_bytes(b"\0asm\x01\0\0\0rest")
        self.index = self.directory / "index.html"
        self.index.write_text("<title>page</title>")
        self.script = self.directory / "console.js"
        self.script.write_text("export {};")
        self.worklet = self.directory / "worklet.js"
        self.worklet.write_text("export {};")
        self.pak = self.directory / "pak0.pak"
        self.pak.write_bytes(b"PACK" + bytes(60))
        self.out = self.directory / "package"

    def build(self, *extra, out=None):
        packager.main([
            str(out or self.out),
            "--name", "quake2",
            "--title", "Quake II",
            "--frames-per-second", "60",
            "--module", str(self.module),
            "--script", str(self.script),
            "--worklet", str(self.worklet),
            "--index", str(self.index),
            *extra,
        ])

    def manifest(self, out=None):
        return json.loads(((out or self.out) / "manifest.json").read_text())

    def test_a_nested_mount_lands_at_its_virtual_path(self):
        self.build("--mount", f"baseq2/pak0.pak={self.pak}", "--option", "pak",
                   "--arg", "+map", "--arg", "demo1")
        self.assertEqual((self.out / "baseq2" / "pak0.pak").read_bytes(), self.pak.read_bytes())
        self.assertEqual((self.out / "linked.wasm").read_bytes(), self.module.read_bytes())
        self.assertEqual((self.out / "index.html").read_text(), self.index.read_text())
        manifest = self.manifest()
        self.assertEqual(manifest["mounts"], [
            {"path": "baseq2/pak0.pak", "file": "baseq2/pak0.pak", "size": 64},
        ])
        self.assertEqual(manifest["option"], "pak")
        self.assertEqual(manifest["args"], ["+map", "demo1"])
        self.assertEqual(manifest["module"], "linked.wasm")
        self.assertEqual(manifest["title"], "Quake II")
        self.assertEqual(manifest["aspect"], "4:3")

    def test_a_package_without_assets_lists_no_mounts(self):
        self.build()
        self.assertEqual(self.manifest()["mounts"], [])
        self.assertIsNone(self.manifest()["option"])

    def test_a_title_defaults_to_the_name(self):
        packager.main([
            str(self.out), "--name", "game", "--module", str(self.module),
            "--script", str(self.script), "--worklet", str(self.worklet),
            "--index", str(self.index),
        ])
        self.assertEqual(self.manifest()["title"], "game")

    def test_a_mount_path_must_be_one_the_guest_can_open(self):
        for path in ("/absolute", "", "a//b", "a/./b", "a/../b", "back\\slash", "x" * 256,
                     "index.html", "console.js/inner", "manifest.json"):
            with self.subTest(path=path):
                with self.assertRaisesRegex(packager.PackageError, "mount path|collides|PATH=FILE"):
                    self.build("--mount", f"{path}={self.pak}")

    def test_a_mount_needs_a_source(self):
        for mount in ("nosource", "=source", "path="):
            with self.subTest(mount=mount), self.assertRaisesRegex(
                    packager.PackageError, "PATH=FILE"):
                self.build("--mount", mount)

    def test_the_same_path_may_not_be_mounted_twice(self):
        with self.assertRaisesRegex(packager.PackageError, "mounted twice"):
            self.build("--mount", f"a.pak={self.pak}", "--mount", f"a.pak={self.module}")

    def test_an_option_replaces_exactly_one_mount(self):
        with self.assertRaisesRegex(packager.PackageError, "exactly one mount"):
            self.build("--option", "pak")
        with self.assertRaisesRegex(packager.PackageError, "exactly one mount"):
            self.build("--option", "pak", "--mount", f"a.pak={self.pak}",
                       "--mount", f"b.pak={self.pak}")

    def test_the_module_must_be_webassembly(self):
        self.module.write_bytes(b"not a module")
        with self.assertRaisesRegex(packager.PackageError, "not a WebAssembly module"):
            self.build()

    def test_a_frame_rate_is_one_to_a_thousand(self):
        for rate in ("0", "1001"):
            with self.subTest(rate=rate), self.assertRaisesRegex(packager.PackageError, "1 to 1000"):
                self.build("--frames-per-second", rate)

    def test_building_needs_every_part_of_a_package(self):
        with self.assertRaisesRegex(packager.PackageError, "needs .*worklet"):
            packager.main([
                str(self.out), "--name", "game", "--module", str(self.module),
                "--script", str(self.script), "--index", str(self.index),
            ])

    def test_check_accepts_the_package_it_described(self):
        self.build("--mount", f"baseq2/pak0.pak={self.pak}", "--option", "pak")
        packager.main([
            "--check", str(self.out), "--module", str(self.module),
            "--mount", f"baseq2/pak0.pak={self.pak}",
        ])

    def test_check_refuses_a_mount_that_no_longer_matches(self):
        self.build("--mount", f"baseq2/pak0.pak={self.pak}")
        (self.out / "baseq2" / "pak0.pak").write_bytes(b"PACK")
        with self.assertRaisesRegex(packager.PackageError, "not the file it was built from"):
            packager.main([
                "--check", str(self.out), "--mount", f"baseq2/pak0.pak={self.pak}",
            ])

    def test_check_refuses_a_manifest_whose_sizes_drifted(self):
        self.build("--mount", f"baseq2/pak0.pak={self.pak}")
        manifest = self.manifest()
        manifest["mounts"][0]["size"] = 1
        (self.out / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(packager.PackageError, "wrong size"):
            packager.main([
                "--check", str(self.out), "--mount", f"baseq2/pak0.pak={self.pak}",
            ])

    def test_check_refuses_a_module_that_was_replaced(self):
        self.build()
        (self.out / "linked.wasm").write_bytes(b"\0asm\x01\0\0\0other")
        with self.assertRaisesRegex(packager.PackageError, "not the module it was built from"):
            packager.main(["--check", str(self.out), "--module", str(self.module)])

    def test_check_refuses_a_package_missing_a_part(self):
        self.build()
        (self.out / "worklet.js").unlink()
        with self.assertRaisesRegex(packager.PackageError, "no worklet.js"):
            packager.main(["--check", str(self.out)])

    def test_check_refuses_a_mount_set_that_does_not_match(self):
        self.build("--mount", f"a.pak={self.pak}")
        with self.assertRaisesRegex(packager.PackageError, "the manifest mounts"):
            packager.main(["--check", str(self.out), "--mount", f"b.pak={self.pak}"])


if __name__ == "__main__":
    unittest.main()
