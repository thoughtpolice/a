# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check readable aliases against annotated wasm2c declarations."""

import importlib.machinery
import pathlib
import sys
import types
import unittest


source = sys.argv.pop(1) if len(sys.argv) > 1 else str(pathlib.Path(__file__).with_name("host_bindings.py"))
loader = importlib.machinery.SourceFileLoader("host_bindings", source)
bindings = types.ModuleType(loader.name)
loader.exec_module(bindings)


def imported(function="read-events", symbol="w2c_from_wasm2c", *, module="console:hal/raw@0.1.0", context="w2c_context"):
    return f"/* import: '{module}' '{function}' */\nvoid {symbol}(struct {context}*, u32);\n"


def exported(name, symbol):
    return f"/* export: '{name}' */\nvoid {symbol}(w2c_linked*);\n"


class HostBindingsTest(unittest.TestCase):
    def test_escaped_names_and_helpers_preserve_wasm2c_symbols(self):
        header = imported(r"read\2Devents", module=r"console\3Ahal\2Fraw\400.1.0")
        prefix = r"wlink\3Aimport\3Aconsole\3Ahal\2Fraw\400.1.0\23read\2Devents\3A"
        for helper, symbol in (("memory", "w2c_arbitrary_memory"),
                               ("realloc", "w2c_arbitrary_realloc"),
                               (r"post\2Dreturn", "w2c_arbitrary_post_return")):
            header += exported(prefix + helper, symbol)
        header += exported(r"game\3Amemory", "w2c_arbitrary_game_memory")
        header += exported("platform:memory", "w2c_arbitrary_platform_memory")
        header += exported(r"end\2Dframe", "w2c_arbitrary_end_frame")
        result = bindings.generate(header)
        self.assertIn('#include "linked.h"', result)
        self.assertIn("#define console_hal_context w2c_context\n", result)
        for alias, symbol in {
            "console_hal_read_events": "w2c_from_wasm2c",
            "console_hal_read_events_memory": "w2c_arbitrary_memory",
            "console_hal_read_events_realloc": "w2c_arbitrary_realloc",
            "console_hal_read_events_post_return": "w2c_arbitrary_post_return",
            "console_game_memory": "w2c_arbitrary_game_memory",
            "console_platform_memory": "w2c_arbitrary_platform_memory",
            "console_end_frame": "w2c_arbitrary_end_frame",
        }.items():
            self.assertIn(f"#define {alias} {symbol}\n", result)

    def test_duplicate_aliases_must_name_the_same_symbol(self):
        declaration = imported()
        self.assertEqual(bindings.generate(declaration), bindings.generate(declaration * 2))
        with self.assertRaisesRegex(ValueError, "ambiguous HAL binding: console_hal_read_events"):
            bindings.generate(declaration + imported(symbol="w2c_other"))
        with self.assertRaisesRegex(ValueError, "ambiguous HAL binding: console_hal_read_events"):
            bindings.generate(declaration + imported("read_events", "w2c_other"))

    def test_missing_hal_import_is_rejected(self):
        for header in ("", exported("game:memory", "w2c_memory")):
            with self.subTest(header=header), self.assertRaisesRegex(ValueError, "no annotated wasm2c HAL"):
                bindings.generate(header)

    def test_unexpected_import_is_rejected(self):
        for module in ("wasi_snapshot_preview1", "console:hal/other@0.1.0"):
            with self.subTest(module=module), self.assertRaisesRegex(ValueError, "unexpected console import"):
                bindings.generate(imported(module=module))

    def test_multiple_hal_contexts_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "one HAL import context"):
            bindings.generate(imported() + imported("arg", "w2c_arg", context="w2c_other_context"))

    def test_unrelated_exports_are_ignored(self):
        header = imported()
        other = exported("unrelated:memory", "w2c_unrelated") + exported("init", "w2c_init")
        self.assertEqual(bindings.generate(header), bindings.generate(header + other))


if __name__ == "__main__":
    unittest.main()
