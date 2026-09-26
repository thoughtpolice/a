#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""Negative fixtures for installed-format and relocation verification."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('audit_installation', Path(__file__).with_name('audit-installation.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def elf(interpreter=False, dynamic=False, machine=62):
    types = [1] + ([3] if interpreter else []) + ([2] if dynamic else [])
    data = bytearray(64 + 56 * len(types) + 32)
    data[:6] = b'\x7fELF\x02\x01'
    struct.pack_into('<HH', data, 16, 2, machine)
    struct.pack_into('<Q', data, 32, 64)
    struct.pack_into('<HH', data, 54, 56, len(types))
    for index, kind in enumerate(types):
        start = 64 + index * 56
        struct.pack_into('<I', data, start, kind)
        if kind == 2:
            struct.pack_into('<Q', data, start + 8, len(data) - 32)
            struct.pack_into('<Q', data, start + 32, 32)
            struct.pack_into('<q', data, len(data) - 32, 1)
    return data


class InstallationBoundary(unittest.TestCase):
    def test_dynamic_dependencies_and_machine_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'program'
            path.write_bytes(elf())
            path.chmod(0o755)
            self.assertEqual(audit.inspect(temp)[2], [])
            path.write_bytes(elf(interpreter=True, dynamic=True, machine=3))
            errors = audit.inspect(temp)[2]
            self.assertIn('not native x86_64 ELF: program', errors)
            self.assertIn('ELF interpreter: program', errors)
            self.assertIn('dynamic dependency: program', errors)

    def test_workspace_paths_symlinks_and_byte_mode_comparison(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            left, right = root / 'left', root / 'right'
            left.mkdir(); right.mkdir()
            for directory in [left, right]:
                p = directory / 'program'
                p.write_bytes(elf()); p.chmod(0o755)
            self.assertEqual(audit.inspect(left)[0], audit.inspect(right)[0])
            (right / 'program').chmod(0o700)
            self.assertNotEqual(audit.inspect(left)[0], audit.inspect(right)[0])
            (right / 'program').write_bytes(elf() + b'/absolute/workspace/source.c')
            (right / 'alias').symlink_to('program')
            errors = audit.inspect(right, '/absolute/workspace')[2]
            self.assertIn('installed symlink: alias', errors)
            self.assertIn('embedded absolute workspace path: program', errors)


if __name__ == '__main__':
    unittest.main()
