# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Runs llvm-ml, MASM's stand-in, with its response files expanded.

Buck gives every compiler its flags in response files (@FILE), as ml64.exe
reads them; llvm-ml does not, and takes @FILE for a source file of that
name. This expands them, with the Windows command line's quoting rules, as
ml64.exe would, and runs llvm-ml on the result.

It also leaves out what ml64.exe takes and llvm-ml does not: /Brepro, which
the prelude passes for reproducible objects, as llvm-ml's always are.

Usage: ml.py LLVM-ML ARGS...
"""

import subprocess
import sys


def split_windows(text: str) -> list[str]:
    """Splits text into arguments as CommandLineToArgvW does: whitespace
    separates them, double quotes group, and backslashes are literal except
    before a double quote, where each pair is one backslash and an odd one
    escapes the quote."""
    args = []
    current = []
    in_arg = False
    quoted = False
    i = 0
    while i < len(text):
        c = text[i]
        if c == "\\":
            n = 0
            while i < len(text) and text[i] == "\\":
                n += 1
                i += 1
            if i < len(text) and text[i] == '"':
                current.append("\\" * (n // 2))
                if n % 2:
                    current.append('"')
                    i += 1
            else:
                current.append("\\" * n)
            in_arg = True
            continue
        if c == '"':
            quoted = not quoted
            in_arg = True
        elif c in " \t\r\n" and not quoted:
            if in_arg:
                args.append("".join(current))
                current = []
                in_arg = False
        else:
            current.append(c)
            in_arg = True
        i += 1
    if in_arg:
        args.append("".join(current))
    return args


def expand(args: list[str], depth: int = 0) -> list[str]:
    out = []
    for arg in args:
        if arg.startswith("@") and depth < 16:
            with open(arg[1:], encoding="utf-8") as f:
                out.extend(expand(split_windows(f.read()), depth + 1))
        else:
            out.append(arg)
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: ml.py LLVM-ML ARGS...", file=sys.stderr)
        return 2
    args = [a for a in expand(sys.argv[2:]) if a.lower() != "/brepro"]
    return subprocess.run([sys.argv[1], *args]).returncode


if __name__ == "__main__":
    sys.exit(main())
