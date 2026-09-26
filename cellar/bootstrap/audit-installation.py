#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""Host-side installed-artifact validation; never a bootstrap action input.

Check native static executable format, reject installed symlinks and embedded
workspace paths, and optionally compare every installed file across workspaces.
ELF checks parse the file itself, without executing ldd or host binutils.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys


def inspect(root, workspace=None):
    root = Path(root).resolve()
    files, executables, errors = {}, [], []
    for path in sorted(root.rglob('*')):
        name = str(path.relative_to(root))
        if path.is_symlink():
            errors.append('installed symlink: ' + name)
        if not path.is_file():
            continue
        content = path.read_bytes()
        files[name] = {'sha256': hashlib.sha256(content).hexdigest(),
                       'mode': path.stat().st_mode & 0o777}
        if workspace and workspace.encode() in content:
            errors.append('embedded absolute workspace path: ' + name)
        if not content.startswith(b'\x7fELF'):
            continue
        if len(content) < 64 or content[4:6] != b'\x02\x01':
            errors.append('not ELF64 little endian: ' + name)
            continue
        kind, machine = struct.unpack_from('<HH', content, 16)
        if machine != 62:
            errors.append('not native x86_64 ELF: ' + name)
        if kind == 1:  # Installed CRT objects.
            continue
        if kind != 2:
            errors.append('not a static ET_EXEC executable: ' + name)
            continue
        if not path.stat().st_mode & 0o111:
            errors.append('nonexecutable ELF program: ' + name)
        phoff = struct.unpack_from('<Q', content, 32)[0]
        phsize, phnum = struct.unpack_from('<HH', content, 54)
        loads = 0
        for index in range(phnum):
            off = phoff + index * phsize
            if phsize < 56 or off + phsize > len(content):
                errors.append('invalid program header: ' + name)
                break
            ptype = struct.unpack_from('<I', content, off)[0]
            if ptype == 1:
                loads += 1
            if ptype == 3:
                errors.append('ELF interpreter: ' + name)
            if ptype == 2:
                start, size = struct.unpack_from('<Q', content, off + 8)[0], struct.unpack_from('<Q', content, off + 32)[0]
                if start + size > len(content) or size % 16:
                    errors.append('invalid dynamic segment: ' + name)
                    continue
                for entry in range(start, start + size, 16):
                    tag = struct.unpack_from('<q', content, entry)[0]
                    if tag == 1:
                        errors.append('dynamic dependency: ' + name)
        if not loads:
            errors.append('no loadable ELF segment: ' + name)
        executables.append(name)
    if not files or not executables:
        errors.append('installation must contain files and executable programs')
    return files, executables, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--workspace')
    parser.add_argument('--compare')
    parser.add_argument('--compare-workspace')
    args = parser.parse_args()
    files, executables, errors = inspect(args.root, args.workspace)
    if args.compare:
        other, _, other_errors = inspect(args.compare, args.compare_workspace)
        errors += ['comparison: ' + error for error in other_errors]
        for name in sorted(files.keys() | other.keys()):
            if files.get(name) != other.get(name):
                errors.append('workspace artifact mismatch: ' + name)
    print(json.dumps({'installed_files': len(files), 'static_executable_entries': len(executables),
                      'unique_static_executables': len({files[p]['sha256'] for p in executables}),
                      'compared_files': len(files) if args.compare else 0, 'errors': errors}, indent=2))
    return bool(errors)


if __name__ == '__main__':
    sys.exit(main())
