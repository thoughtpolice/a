#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Consumer-visible regressions against the pinned standalone compiler via Buck."""

import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

RUNNER = [str(Path(arg).resolve()) if Path(arg).exists() else arg
          for arg in shlex.split(sys.argv[1])]
COMPILER = str(Path(sys.argv[2]).resolve())


class CompilerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tailwind-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.entry = self.source("app/styles.css", '@import "tailwindcss" source(none);\n')
        self.page = self.source("app/Page.svelte", '<div class="flex"></div>')
        self.css = []

    def source(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return {"name": name, "path": str(path)}

    def compile(self, minify=False):
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps({"entry": self.entry, "css": self.css,
                                        "candidates": [self.page]}), encoding="utf-8")
        output = self.root / "result.css"
        output.unlink(missing_ok=True)
        command = RUNNER + ["--compiler", COMPILER, "--manifest", str(manifest), "--output", str(output)]
        if minify:
            command.append("--minify")
        result = subprocess.run(command, cwd=self.root, capture_output=True, text=True)
        return result, output

    def test_real_scanner_variants_arbitrary_theme_imports_and_isolation(self):
        self.entry = self.source("app/styles.css", '''
@import "tailwindcss" source(none);
@import "./css/theme.css";
@source inline("underline");
@custom-variant pressed (&:active);
@utility paper { box-shadow: 0 0 0 3px var(--color-note); }
''')
        self.css = [self.source("app/css/theme.css", '''
@theme { --color-note: #123456; }
/* z-555 must not become a candidate just because this CSS is declared. */
''')]
        self.page = self.source("app/Page.svelte", '''
<div class="flex sm:hover:bg-note w-[37px] pressed:paper"></div>
''')
        self.source("app/Undeclared.svelte", '<div class="z-9876 opacity-[0.123]"></div>')
        for minify in (False, True):
            with self.subTest(minify=minify):
                result, output = self.compile(minify)
                self.assertEqual(result.returncode, 0, result.stderr)
                text = output.read_text(encoding="utf-8")
                self.assertIn(".flex", text)
                self.assertIn(".sm\\:hover\\:bg-note", text)
                self.assertIn(".w-\\[37px\\]", text)
                self.assertIn("37px", text)
                self.assertIn(".pressed\\:paper", text)
                self.assertIn(":active", text)
                self.assertIn("--color-note", text)
                self.assertIn("#123456", text)
                self.assertIn(".underline", text)
                self.assertNotIn(".z-9876", text)
                self.assertNotIn(".z-555", text)
                self.assertNotIn(".opacity-", text)
                self.assertNotIn(self.temporary.name, text)
                self.assertNotIn("buck-tailwind-", text)
                again, second = self.compile(minify)
                self.assertEqual(again.returncode, 0, again.stderr)
                self.assertEqual(second.read_text(encoding="utf-8"), text)

    def test_declared_file_sources_preserve_inline_exclusion_precedence(self):
        self.entry = self.source("app/styles.css", '''
@import "tailwindcss" source(none);
@source "./Page.svelte";
@source inline("font-bold");
@source not inline("underline");
''')
        self.page = self.source("app/Page.svelte", '<div class="flex underline"></div>')
        result, output = self.compile()
        self.assertEqual(result.returncode, 0, result.stderr)
        text = output.read_text(encoding="utf-8")
        self.assertIn(".flex", text)
        self.assertIn(".font-bold", text)
        self.assertNotIn(".underline", text)

    def test_ownership_and_automatic_scanning_fail_closed(self):
        cases = [
            '@import "tailwindcss";',
            '@import "tailwindcss" source("../");',
            '@import "tailwindcss" source( none );',
            '@import "tailwindcss" source\t(none);',
            '@import "../../outside.css";',
            '@import "./undeclared.css";',
            '@import "https://example.com/style.css";',
            '@import url("./undeclared.css");',
            '@source "../../";',
            '@source "./Undeclared.svelte";',
            '@source "./*.svelte";',
            '@media source("/") { @tailwind utilities; }',
            '@plugin "../plugin.js";',
            '@config "../config.js";',
        ]
        for directive in cases:
            with self.subTest(directive=directive):
                self.entry = self.source("app/styles.css", '@import "tailwindcss" source(none);\n' + directive)
                result, output = self.compile()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("app/styles.css", result.stderr)
                self.assertFalse(output.exists())

    def test_transitive_css_must_be_declared_and_is_validated(self):
        self.entry = self.source("app/styles.css", '@import "tailwindcss" source(none);\n@import "css/theme.css";')
        self.css = [self.source("app/css/theme.css", '@import "../../outside.css";')]
        result, output = self.compile()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("app/css/theme.css", result.stderr)
        self.assertFalse(output.exists())

    def test_compiler_errors_are_not_successful_empty_css(self):
        self.entry = self.source("app/styles.css", '@import "tailwindcss" source(none);\n@utility bad*name { color: red; }')
        result, output = self.compile()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("app/styles.css", result.stderr)
        self.assertNotIn("buck-tailwind-", result.stderr)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
