# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Exercises what the cellar's scripts and CPython's generators use: the
# standard library found from the executable, its build configuration, the
# built-in modules, hashing, JSON, regular expressions, dataclasses,
# subprocesses and threads. It runs in its output directory and writes
# result there.

import argparse
import ast
import dataclasses
import decimal
import hashlib
import json
import pathlib
import re
import struct
import subprocess
import sys
import tempfile
import threading
import sysconfig
import unicodedata
import xml.etree.ElementTree as ElementTree
import zoneinfo


@dataclasses.dataclass
class Point:
    x: int
    y: int


def recurse(depth):
    return depth if depth == 0 else recurse(depth - 1)


def main():
    assert sys.version_info[:2] == (3, 14), sys.version_info
    assert sys.platform == "linux", sys.platform
    assert sys.implementation._multiarch == "x86_64-linux-musl"
    assert sysconfig.get_config_var("SOABI") == "cpython-314-x86_64-linux-musl"
    assert sysconfig.get_config_var("HAVE_FORK") == 1
    assert sysconfig.get_config_var("Py_GIL_DISABLED") == 0
    assert zoneinfo.TZPATH, zoneinfo.TZPATH
    assert pathlib.Path(sys.prefix, "lib", "python3.14", "os.py").is_file(), sys.prefix
    assert sys.prefix == sys.exec_prefix, (sys.prefix, sys.exec_prefix)
    assert hashlib.sha256(b"abc").hexdigest().startswith("ba7816bf8f01cfea")
    assert hashlib.md5(b"").hexdigest() == "d41d8cd98f00b204e9800998ecf8427e"
    assert hashlib.blake2b(b"").hexdigest().startswith("786a02f742015903")
    assert json.loads(json.dumps({"a": [1, 2.5, None]})) == {"a": [1, 2.5, None]}
    assert re.fullmatch(r"(\w+)-(\d+)", "llvm-23").groups() == ("llvm", "23")
    assert struct.pack("<IH", 1, 2) == b"\x01\x00\x00\x00\x02\x00"
    assert Point(1, 2) == Point(1, 2)
    assert str(decimal.Decimal(1) / decimal.Decimal(7))[:8] == "0.142857"
    assert unicodedata.name("\N{GREEK SMALL LETTER ALPHA}") == "GREEK SMALL LETTER ALPHA"
    assert ElementTree.fromstring("<a><b/></a>")[0].tag == "b"
    assert isinstance(ast.parse("x = 1").body[0], ast.Assign)
    assert argparse.ArgumentParser().parse_args([]) is not None

    # Deep recursion in a new thread needs the stack the linker asked for.
    results = []
    thread = threading.Thread(target=lambda: results.append(recurse(500)))
    thread.start()
    thread.join()
    assert results == [0], results

    with tempfile.TemporaryDirectory(dir=".") as directory:
        path = pathlib.Path(directory, "child.py")
        path.write_text("import sys\nsys.stdout.write('child')\n")
        child = subprocess.run([sys.executable, str(path)], capture_output=True, check=True)
        assert child.stdout == b"child", child

    pathlib.Path("result").write_text("ok\n")


main()
