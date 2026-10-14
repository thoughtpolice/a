#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Regenerates cases_test.go by asking an installed git what it does.

    python3 tests/gen-cases.py > cases_test.go

The checkout cases build a repository with exact blob contents, clone it,
and record the files git checks out. The match cases record which paths a
.gitattributes line applies to, according to `git check-attr`. git runs
with no system or global configuration, as git-fetch does.
"""

import os
import subprocess
import sys
import tempfile

LF = b"one\ntwo\nthree\n"
MIXED = b"crlf\r\nlf\nlast"
CONTROL = bytes(range(1, 8)) + b"\x0e\x0f\x10\x11\x12\x13\n" + b"x" * 64 + b"\n"
IDENT = (
    b"$Id$\n"
    b"$Id: stale $\n"
    b"$Id: from another vcs $\n"
    b"$Id:$ $Id: $\n"
    b"$Id: split\nacross lines $\n"
    b"$Id$Id$\n"
    b"$I$ $Idx$ $$Id$\n"
    b"unterminated $Id: here"
)
# Where git's streaming and in-memory ident conversions differ.
IDENT_QUIRKS = (
    b"$$Id$ $$Id: x $\n"
    b"$Idx$Id:$ keeps going\n"
    b"$Id: tab\there $ $Id: tab\t$\n"
    b"$Id\0$Id$\n"
    b"$I$Id$ $Id$Id: $\n"
    b"$Id"
)

# (name, [(path, mode, contents)]); a str is encoded as UTF-8.
CHECKOUT_CASES = [
    ("eol=crlf converts lone LFs", [
        (".gitattributes", 0o100644, "*.bat eol=crlf\n"),
        ("a.bat", 0o100644, LF),
        ("a.txt", 0o100644, LF),
        ("mixed.bat", 0o100644, MIXED),
        ("empty.bat", 0o100644, b""),
        ("no-newline.bat", 0o100644, b"x"),
        ("exec.bat", 0o100755, LF),
    ]),
    ("text eol=crlf converts even binary-looking files", [
        (".gitattributes", 0o100644, "* text eol=crlf\n"),
        ("nul.bin", 0o100644, b"a\0b\nc\n"),
        ("cr.txt", 0o100644, b"a\rb\nc\n"),
    ]),
    ("text=auto eol=crlf skips binary files and files with CRs", [
        (".gitattributes", 0o100644, "* text=auto eol=crlf\n"),
        ("text.txt", 0o100644, LF),
        ("nul.bin", 0o100644, b"a\0\nb\n"),
        ("lone-cr.txt", 0o100644, b"a\rb\nc\n"),
        ("has-crlf.txt", 0o100644, b"a\r\nb\n"),
        ("control.txt", 0o100644, CONTROL),
        ("few-control.txt", 0o100644, b"\x01" + b"x" * 200 + b"\n"),
        ("dos-eof.txt", 0o100644, b"a\nb\n\x1a"),
        ("delete.txt", 0o100644, b"\x7f\x7f\n"),
        ("high-bytes.txt", 0o100644, "naïve façade\n"),
    ]),
    ("text eol=lf keeps LF", [
        (".gitattributes", 0o100644, "* text eol=lf\n"),
        ("a.txt", 0o100644, MIXED),
    ]),
    ("-text wins over eol", [
        (".gitattributes", 0o100644, "* -text eol=crlf\n"),
        ("a.txt", 0o100644, LF),
    ]),
    ("binary macro", [
        (".gitattributes", 0o100644, "* eol=crlf\n*.bin binary\n"),
        ("a.bin", 0o100644, LF),
        ("a.txt", 0o100644, LF),
    ]),
    ("binary then text on one line", [
        (".gitattributes", 0o100644, "* binary text eol=crlf\n"),
        ("a.txt", 0o100644, LF),
    ]),
    ("text then binary on one line", [
        (".gitattributes", 0o100644, "* text binary eol=crlf\n"),
        ("a.txt", 0o100644, LF),
    ]),
    ("legacy crlf attribute", [
        (".gitattributes", 0o100644, "a.txt crlf eol=crlf\nb.txt -crlf eol=crlf\nc.txt crlf=input eol=crlf\nd.txt crlf\ne.txt crlf=auto eol=crlf\nf.txt -text crlf eol=crlf\n"),
        ("a.txt", 0o100644, LF),
        ("b.txt", 0o100644, LF),
        ("c.txt", 0o100644, LF),
        ("d.txt", 0o100644, LF),
        ("e.txt", 0o100644, LF),
        ("f.txt", 0o100644, LF),
    ]),
    ("text values", [
        (".gitattributes", 0o100644, "a.txt text=input eol=crlf\nb.txt text=bogus eol=crlf\nc.txt text=auto\nd.txt text=input\ne.txt text= eol=crlf\n"),
        ("a.txt", 0o100644, LF),
        ("b.txt", 0o100644, LF),
        ("c.txt", 0o100644, LF),
        ("d.txt", 0o100644, LF),
        ("e.txt", 0o100644, LF),
    ]),
    ("eol values", [
        (".gitattributes", 0o100644, "a.txt eol=crlf\nb.txt text eol=bogus\nc.txt eol\nd.txt -eol\ne.txt eol=CRLF\n"),
        ("a.txt", 0o100644, LF),
        ("b.txt", 0o100644, LF),
        ("c.txt", 0o100644, LF),
        ("d.txt", 0o100644, LF),
        ("e.txt", 0o100644, LF),
    ]),
    ("later lines win", [
        (".gitattributes", 0o100644, "*.txt eol=crlf\n*.txt -text\n*.md -text\n*.md eol=crlf\n"),
        ("a.txt", 0o100644, LF),
        ("a.md", 0o100644, LF),
    ]),
    ("unspecified hides earlier lines", [
        (".gitattributes", 0o100644, "* eol=crlf\n*.txt !eol\n"),
        ("a.txt", 0o100644, LF),
        ("a.md", 0o100644, LF),
    ]),
    ("deeper files win", [
        (".gitattributes", 0o100644, "* eol=crlf\n*.md -text\n"),
        ("sub/.gitattributes", 0o100644, "*.txt -text\n*.md text eol=crlf\n"),
        ("a.txt", 0o100644, LF),
        ("a.md", 0o100644, LF),
        ("sub/a.txt", 0o100644, LF),
        ("sub/a.md", 0o100644, LF),
        ("sub/deeper/a.txt", 0o100644, LF),
    ]),
    ("deeper unspecified", [
        (".gitattributes", 0o100644, "* eol=crlf\n"),
        ("sub/.gitattributes", 0o100644, "*.txt !eol\n"),
        ("sub/a.txt", 0o100644, LF),
        ("sub/a.md", 0o100644, LF),
    ]),
    ("macros", [
        (".gitattributes", 0o100644, "[attr]win text eol=crlf\n*.cmd win\n*.unset -win eol=lf\n*.late later\n[attr]later eol=crlf\n[attr]nested win\n*.nested nested\n"),
        ("a.cmd", 0o100644, LF),
        ("a.unset", 0o100644, LF),
        ("a.late", 0o100644, LF),
        ("a.nested", 0o100644, LF),
    ]),
    ("macros defined below the top are ignored", [
        ("sub/.gitattributes", 0o100644, "[attr]win text eol=crlf\n*.cmd win\n"),
        ("sub/a.cmd", 0o100644, LF),
    ]),
    ("macro set by a deeper file", [
        (".gitattributes", 0o100644, "[attr]win text eol=crlf\n*.cmd -text\n"),
        ("sub/.gitattributes", 0o100644, "*.cmd win\n"),
        ("a.cmd", 0o100644, LF),
        ("sub/a.cmd", 0o100644, LF),
    ]),
    ("redefined binary macro", [
        (".gitattributes", 0o100644, "[attr]binary text eol=crlf\n*.bin binary\n"),
        ("a.bin", 0o100644, LF),
    ]),
    ("anchored and nested patterns", [
        (".gitattributes", 0o100644, "/top.txt eol=crlf\nsub/*.txt eol=crlf\n**/deep/*.md eol=crlf\nx/**/y.txt eol=crlf\n"),
        ("top.txt", 0o100644, LF),
        ("sub/top.txt", 0o100644, LF),
        ("sub/a.txt", 0o100644, LF),
        ("sub/x/a.txt", 0o100644, LF),
        ("deep/c.md", 0o100644, LF),
        ("a/b/deep/c.md", 0o100644, LF),
        ("x/y.txt", 0o100644, LF),
        ("x/a/b/y.txt", 0o100644, LF),
    ]),
    ("patterns below the top are relative to their directory", [
        ("sub/.gitattributes", 0o100644, "/a.txt eol=crlf\nx/*.txt eol=crlf\n*.md eol=crlf\n"),
        ("a.txt", 0o100644, LF),
        ("a.md", 0o100644, LF),
        ("sub/a.txt", 0o100644, LF),
        ("sub/b/a.txt", 0o100644, LF),
        ("sub/x/c.txt", 0o100644, LF),
        ("sub/y/z.md", 0o100644, LF),
    ]),
    ("directory patterns", [
        (".gitattributes", 0o100644, "dir/ eol=crlf\nother/** eol=crlf\n"),
        ("dir/a.txt", 0o100644, LF),
        ("other/a.txt", 0o100644, LF),
        ("other/b/c.txt", 0o100644, LF),
    ]),
    ("negative patterns are ignored", [
        (".gitattributes", 0o100644, "!*.txt eol=crlf\n\"!*.md\" eol=crlf\n\\!x.txt eol=crlf\n"),
        ("a.txt", 0o100644, LF),
        ("a.md", 0o100644, LF),
        ("!x.txt", 0o100644, LF),
    ]),
    ("quoted patterns", [
        (".gitattributes", 0o100644, '"a b.txt" eol=crlf\n"tab\\tname.txt" eol=crlf\n"oct\\101l.txt" eol=crlf\n"bad\\q.txt" eol=crlf\n"unterminated eol=crlf\n"close"eol=crlf\n'),
        ("a b.txt", 0o100644, LF),
        ("tab\tname.txt", 0o100644, LF),
        ("octAl.txt", 0o100644, LF),
        ("bad\\q.txt", 0o100644, LF),
        ('"bad\\q.txt"', 0o100644, LF),
        ("close", 0o100644, LF),
    ]),
    ("invalid lines are dropped whole", [
        (".gitattributes", 0o100644, "*.txt eol=crlf bad%name\n*.md eol=crlf\n*.c builtin_objectmode eol=crlf\n*.h - eol=crlf\n[attr]bad%macro eol=crlf\n*.rs eol=crlf =\n"),
        ("a.txt", 0o100644, LF),
        ("a.md", 0o100644, LF),
        ("a.c", 0o100644, LF),
        ("a.h", 0o100644, LF),
        ("a.rs", 0o100644, LF),
    ]),
    ("long lines are ignored", [
        (".gitattributes", 0o100644, "*.txt eol=crlf" + " " * 2034 + "\n*.md eol=crlf" + " " * 2034 + "\n"),
        ("a.txt", 0o100644, LF),
        ("a.md", 0o100644, LF),
    ]),
    ("comments, blank lines and CRLF", [
        (".gitattributes", 0o100644, "# *.txt eol=crlf\n\n   \t\n  *.md eol=crlf\r\n\t*.c\teol=crlf\t\r\n"),
        ("a.txt", 0o100644, LF),
        ("a.md", 0o100644, LF),
        ("a.c", 0o100644, LF),
    ]),
    ("byte order mark", [
        (".gitattributes", 0o100644, "﻿*.txt eol=crlf\n"),
        ("a.txt", 0o100644, LF),
    ]),
    ("NUL ends the file", [
        (".gitattributes", 0o100644, b"*.md eol=crlf\n\0*.txt eol=crlf\n"),
        ("a.txt", 0o100644, LF),
        ("a.md", 0o100644, LF),
    ]),
    ("symlinked .gitattributes", [
        (".gitattributes", 0o120000, "*.txt eol=crlf"),
        ("sub/.gitattributes", 0o120000, "*.md eol=crlf"),
        ("a.txt", 0o100644, LF),
        ("sub/a.md", 0o100644, LF),
    ]),
    ("ident", [
        (".gitattributes", 0o100644, "*.c ident\n*.h ident=yes\n*.rs ident eol=crlf\n"),
        ("a.c", 0o100644, IDENT),
        ("a.h", 0o100644, IDENT),
        ("a.rs", 0o100644, IDENT),
        ("none.c", 0o100644, b"no keywords\n"),
    ]),
    ("ident in memory and streamed", [
        (".gitattributes", 0o100644, "*.c ident\n*.auto ident text=auto eol=crlf\n*.lf ident text=auto\n*.crlf ident text eol=crlf\n"),
        ("a.c", 0o100644, IDENT_QUIRKS),
        ("a.auto", 0o100644, IDENT_QUIRKS),
        ("a.lf", 0o100644, IDENT_QUIRKS),
        ("a.crlf", 0o100644, IDENT_QUIRKS),
        ("b.auto", 0o100644, IDENT),
        ("c.auto", 0o100644, IDENT_QUIRKS.replace(b"\0", b"0")),
    ]),
    ("UTF-8 working-tree-encoding does nothing", [
        (".gitattributes", 0o100644, "*.txt working-tree-encoding=UTF-8 eol=crlf\n*.md working-tree-encoding=utf8\n*.c working-tree-encoding=\n*.h !working-tree-encoding\n"),
        ("a.txt", 0o100644, "naïve\n"),
        ("a.md", 0o100644, "naïve\n"),
        ("a.c", 0o100644, "naïve\n"),
        ("a.h", 0o100644, "naïve\n"),
    ]),
    ("working-tree-encoding must have a value", [
        (".gitattributes", 0o100644, "*.txt working-tree-encoding\n"),
        ("a.txt", 0o100644, LF),
    ]),
    ("filters without drivers do nothing", [
        (".gitattributes", 0o100644, "*.txt filter=lfs diff=lfs merge=lfs -text\n*.md filter=missing eol=crlf\n"),
        ("a.txt", 0o100644, "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n"),
        ("a.md", 0o100644, LF),
    ]),
    ("patterns are case-sensitive", [
        (".gitattributes", 0o100644, "*.TXT eol=crlf\n"),
        ("a.txt", 0o100644, LF),
        ("B.TXT", 0o100644, LF),
    ]),
    ("symlinks and submodules are not converted", [
        (".gitattributes", 0o100644, "* text eol=crlf\n"),
        ("link", 0o120000, "target\nwith newline"),
        ("a.txt", 0o100644, LF),
    ]),
]

# .gitattributes lines; each assigns x to whatever its pattern matches.
MATCH_LINES = [
    "*.txt", "*", "?.txt", "a*", "*a", "a/*", "a/**", "**/b", "**/b/*.txt",
    "a/**/c", "/a.txt", "/a/*.txt", "a/", "b/", "*.[ch]", "*.[!ch]",
    "*.[^ch]", "[a-c].txt", "[]].txt", "[!]].txt", "[a-].txt", "[-a].txt",
    "[z-a].txt", "x[[:digit:]]y", "x[[:alpha:][:digit:]]y", "x[[:space:]]y",
    "x[[:punct:]]y", "x[[:xdigit:]]y", "x[[:upper:]]y", "x[[:lower:]]y",
    "x[[:alnum:]]y", "x[[:graph:]]y", "x[[:print:]]y", "x[[:blank:]]y",
    "x[[:cntrl:]]y", "x[[:bogus:]]y", "x[[:digit:]y", "x[[:dig", "x[[]y",
    "x[\\]]y", "x[a\\-z]y", "\\*.txt", "a\\b", "\\a", "foo\\", "a/b", "a/b/",
    "**", "**/", "a/**/", "***/b", "a/***", "a**b", "**b", "a/*/c",
    "a/*b/c", "*/b", "**/*", "a/?/c", '"a b.txt"', '"a\\tb.txt"', "a[/]b",
    "*/", ".*", "*.TXT", "a/**/b/**/c", "**/a/**", "a*/b", "*b*", "b*/**",
    "[[:alpha:]]", "a?", "\\[.txt", "[.txt",
]

MATCH_PATHS = [
    "a.txt", "b.txt", "A.TXT", "a", "ab", "ba", "a/b", "a/b.txt", "a/b/c",
    "a/b/c.txt", "a/x/c", "a/x/y/c", "b/a.txt", "x/b/c.txt", "x/b/y.txt",
    "a.c", "a.h", "a.o", "].txt", "-.txt", "x1y", "xay", "x y", "x.y",
    "xAy", "x\ty", "x-y", "x[y", "x]y", "*.txt", "a\\b", "a b.txt",
    "a\tb.txt", ".hidden", "a/.hidden", "[.txt", "a/b/c/d/e.txt", "foo",
    "a/b/b/c", "x/a/y/b/z/c", "ab/b", "b/c/d",
]

# Lines in sub/.gitattributes, against paths under sub/ and outside it.
SUB_MATCH_LINES = ["*.txt", "/a.txt", "b/*", "**/c", "b/", "/b/**", "x/../a.txt", "sub/a.txt"]
SUB_MATCH_PATHS = ["a.txt", "sub/a.txt", "sub/b/a.txt", "sub/b/c", "sub/x/y/c", "sub/b", "sub/sub/a.txt"]


def git(args, cwd, env, input=None):
    return subprocess.run(["git", *args], cwd=cwd, env=env, input=input,
                          capture_output=True, check=True).stdout


def checkout(case_files, tmp, env):
    """Builds a commit holding exactly case_files and returns what
    `git clone` checks out of it, or None if git fails to."""
    src = os.path.join(tmp, "src")
    git(["init", "-q", "src"], tmp, env)
    for path, mode, contents in case_files:
        blob = git(["hash-object", "-w", "--no-filters", "--stdin"], src, env, contents).strip().decode()
        git(["update-index", "--add", "--cacheinfo", f"{mode:o},{blob},{path}"], src, env)
    tree = git(["write-tree"], src, env).strip().decode()
    commit = git(["commit-tree", "-m", "case", tree], src, env).strip().decode()
    git(["update-ref", "HEAD", commit], src, env)
    result = subprocess.run(["git", "clone", "-q", "src", "dst"], cwd=tmp, env=env, capture_output=True)
    if result.returncode != 0:
        return None
    files = {}
    dst = os.path.join(tmp, "dst")
    for root, dirs, names in os.walk(dst):
        dirs[:] = [d for d in dirs if not (root == dst and d == ".git")]
        for name in names:
            full = os.path.join(root, name)
            if not os.path.islink(full):
                with open(full, "rb") as f:
                    files[os.path.relpath(full, dst)] = f.read()
    return files


def matches(name, lines, paths, attr_path, tmp, env):
    """Returns, for each line, a string of 1s and 0s saying which paths
    `git check-attr` finds it applies to."""
    out = []
    for i, line in enumerate(lines):
        repo = os.path.join(tmp, f"{name}{i}")
        git(["init", "-q", repo], tmp, env)
        os.makedirs(os.path.dirname(os.path.join(repo, attr_path)), exist_ok=True)
        with open(os.path.join(repo, attr_path), "w") as f:
            f.write(line + " x\n")
        stdin = b"".join(p.encode() + b"\0" for p in paths)
        fields = git(["check-attr", "-z", "--stdin", "x"], repo, env, stdin).split(b"\0")
        values = {fields[j].decode(): fields[j + 2].decode() for j in range(0, len(fields) - 2, 3)}
        out.append("".join("1" if values[p] == "set" else "0" for p in paths))
    return out


def go_string(b):
    if isinstance(b, str):
        b = b.encode()
    out = []
    for c in b:
        if c == 0x22 or c == 0x5C:
            out.append("\\" + chr(c))
        elif 0x20 <= c < 0x7F:
            out.append(chr(c))
        else:
            out.append(f"\\x{c:02x}")
    return '"' + "".join(out) + '"'


def main():
    with tempfile.TemporaryDirectory() as tmp:
        env = {
            "PATH": os.environ["PATH"],
            "HOME": tmp,
            "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "A",
            "GIT_AUTHOR_EMAIL": "a@example.com",
            "GIT_AUTHOR_DATE": "1700000000 +0000",
            "GIT_COMMITTER_NAME": "A",
            "GIT_COMMITTER_EMAIL": "a@example.com",
            "GIT_COMMITTER_DATE": "1700000000 +0000",
        }
        version = git(["version"], tmp, env).decode().strip()
        w = sys.stdout.write
        w("// SPDX-FileCopyrightText: © 2026 Austin Seipp\n")
        w("// SPDX-License-Identifier: Apache-2.0\n\n")
        w(f"// Code generated by tests/gen-cases.py from {version}; DO NOT EDIT.\n\n")
        w("package main\n\n")
        w("var checkoutCases = []checkoutCase{\n")
        for n, (name, files) in enumerate(CHECKOUT_CASES):
            case_tmp = os.path.join(tmp, f"case{n}")
            os.mkdir(case_tmp)
            files = [(p, m, c.encode() if isinstance(c, str) else c) for p, m, c in files]
            want = checkout(files, case_tmp, env)
            w(f"\t{{\n\t\tname: {go_string(name)},\n\t\tfiles: []caseFile{{\n")
            for path, mode, contents in files:
                w(f"\t\t\t{{{go_string(path)}, 0o{mode:o}, {go_string(contents)}}},\n")
            w("\t\t},\n")
            if want is None:
                w("\t\tfails: true,\n")
            else:
                w("\t\twant: []wantFile{\n")
                for path in sorted(want):
                    w(f"\t\t\t{{{go_string(path)}, {go_string(want[path])}}},\n")
                w("\t\t},\n")
            w("\t},\n")
        w("}\n\n")
        for name, lines, paths, attr_path in [
            ("attrMatch", MATCH_LINES, MATCH_PATHS, ".gitattributes"),
            ("subAttrMatch", SUB_MATCH_LINES, SUB_MATCH_PATHS, "sub/.gitattributes"),
        ]:
            w(f"var {name}Paths = []string{{\n")
            for p in paths:
                w(f"\t{go_string(p)},\n")
            w("}\n\n")
            w(f"// {name}Cases pairs a line with which of {name}Paths it matches.\n")
            w(f"var {name}Cases = []struct{{ line, matches string }}{{\n")
            for line, m in zip(lines, matches(name, lines, paths, attr_path, tmp, env)):
                w(f"\t{{{go_string(line)}, {go_string(m)}}},\n")
            w("}\n")
            if name == "attrMatch":
                w("\n")


if __name__ == "__main__":
    main()
