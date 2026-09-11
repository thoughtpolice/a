# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check the standalone library as a foreign runtime would load it."""

import ctypes
from pathlib import Path
import re
import sys


def main():
    library, header, expected_version = sys.argv[1:]
    lib = ctypes.CDLL(str(Path(library).resolve()))
    declarations = re.sub(r"/\*.*?\*/", "", Path(header).read_text(), flags=re.S)
    symbols = set(re.findall(r"\b(hegel_\w+)\s*\([^;{}]*\);", declarations))
    if not symbols:
        raise RuntimeError("no C ABI declarations found in hegel.h")
    missing = sorted(symbol for symbol in symbols if not hasattr(lib, symbol))
    if missing:
        raise RuntimeError(f"missing C ABI exports: {missing}")

    lib.hegel_context_new.argtypes = []
    lib.hegel_context_new.restype = ctypes.c_void_p
    lib.hegel_context_free.argtypes = [ctypes.c_void_p]
    lib.hegel_context_free.restype = ctypes.c_int
    lib.hegel_version.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p)]
    lib.hegel_version.restype = ctypes.c_int

    ctx = lib.hegel_context_new()
    if not ctx:
        raise RuntimeError("hegel_context_new returned NULL")
    try:
        version = ctypes.c_char_p()
        if lib.hegel_version(ctx, ctypes.byref(version)) != 0:
            raise RuntimeError("hegel_version failed")
        if version.value != expected_version.encode():
            raise RuntimeError(f"unexpected engine version: {version.value!r}")
    finally:
        if lib.hegel_context_free(ctx) != 0:
            raise RuntimeError("hegel_context_free failed")
    print(f"loaded Hegel {expected_version}; all {len(symbols)} C ABI symbols exported")


if __name__ == "__main__":
    main()
