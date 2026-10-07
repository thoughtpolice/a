#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Stage declared inputs and invoke upstream; never extract class candidates here."""

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import shutil
import subprocess
import sys
import tempfile


class InputError(ValueError):
    pass


def skip_comment(text, start):
    end = text.find("*/", start + 2)
    if end < 0:
        raise InputError("unterminated CSS comment")
    return end + 2


def quoted_end(text, start):
    quote = text[start]
    i = start + 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
        elif text[i] == quote:
            return i + 1
        else:
            i += 1
    raise InputError("unterminated CSS string")


def at_rules(text):
    """Read at-rule headers only, respecting CSS comments, strings and functions.

    This is ownership validation, not a CSS compiler or a candidate extractor.
    Bodies and all CSS feature semantics are left to the upstream compiler.
    """
    i = 0
    while i < len(text):
        if text.startswith("/*", i):
            i = skip_comment(text, i)
        elif text[i] in "\"'":
            i = quoted_end(text, i)
        elif text[i] == "@":
            start = i
            i += 1
            while i < len(text) and (text[i].isalpha() or text[i] == "-"):
                i += 1
            if i < len(text) and text[i] == "\\":
                raise InputError("escaped at-rule names are not supported in declared CSS")
            name = text[start:i]
            parts = []
            depth = 0
            while i < len(text):
                if text.startswith("/*", i):
                    i = skip_comment(text, i)
                    parts.append(" ")
                    continue
                if text[i] in "\"'":
                    end = quoted_end(text, i)
                    parts.append(text[i:end])
                    i = end
                    continue
                if text[i] in ";{}" and depth == 0:
                    break
                if text[i] == "(":
                    depth += 1
                elif text[i] == ")":
                    depth -= 1
                parts.append(text[i])
                i += 1
            yield name, "".join(parts).strip()
        else:
            i += 1


def words(params):
    tokens = []
    i = 0
    while i < len(params):
        if params[i].isspace():
            i += 1
        elif params[i] in "\"'":
            end = quoted_end(params, i)
            tokens.append(params[i:end])
            i = end
        elif params[i] in "()":
            tokens.append(params[i])
            i += 1
        else:
            start = i
            while i < len(params) and not params[i].isspace() and params[i] not in "()\"'":
                i += 1
            tokens.append(params[start:i])
    return tokens


def path_name(name):
    # Paths also become upstream @source patterns. Disallow glob/escape syntax
    # so an individual artifact cannot turn into a directory or wildcard scan.
    if (not name or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-" for c in name)
            or PurePosixPath(name).is_absolute()
            or any(part in ("", ".", "..") for part in name.split("/"))):
        raise InputError(f"unsupported declared input path: {name!r}")
    return name


def string_value(token):
    if len(token) < 2 or token[0] not in "\"'" or token[-1] != token[0] or "\\" in token:
        raise InputError("ownership paths must be plain quoted strings without CSS escapes")
    return token[1:-1]


def relative_name(owner, value):
    if (not value or value.startswith("/")
            or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-" for c in value)):
        raise InputError(f"import/source path escapes declared ownership: {value!r}")
    result = posixpath.normpath(posixpath.join(posixpath.dirname(owner), value))
    if result == ".." or result.startswith("../"):
        raise InputError(f"import/source path escapes declared ownership: {value!r}")
    return result


def validate_css(name, text, css_names, candidate_names):
    disabled = False
    for directive, params in at_rules(text):
        tokens = words(params)
        if directive in ("@plugin", "@config"):
            raise InputError(f"{directive} requires undeclared JavaScript inputs and is not supported")
        if directive in ("@import", "@reference", "@tailwind", "@media"):
            has_none = False
            for i, token in enumerate(tokens):
                if token == "source":
                    if tokens[i:i + 4] != ["source", "(", "none", ")"]:
                        raise InputError("automatic source discovery is forbidden; use source(none) and srcs")
                    has_none = True
            # Upstream recognizes this keyword literally; tokenizing whitespace
            # must not misclassify an ignored annotation as disabled discovery.
            if params.count("source(none)") != tokens.count("source"):
                raise InputError("automatic discovery must be disabled with source(none)")
            if directive == "@media":
                continue
            if directive == "@tailwind":
                if tokens and tokens[0] == "utilities":
                    if not has_none:
                        raise InputError("@tailwind utilities must use source(none)")
                    disabled = True
                continue
            if not tokens:
                raise InputError(f"{directive} requires a declared relative CSS path")
            target = string_value(tokens[0])
            if target in ("tailwindcss", "tailwindcss/utilities.css"):
                if directive == "@import":
                    if not has_none:
                        raise InputError(f'@import "{target}" must use source(none)')
                    disabled = True
            elif target not in ("tailwindcss/theme.css", "tailwindcss/preflight.css"):
                resolved = relative_name(name, target)
                if resolved not in css_names:
                    raise InputError(f"CSS import {target!r} is not declared in css_srcs")
        elif directive == "@source":
            if tokens and tokens[0] == "not":
                tokens = tokens[1:]
            if tokens and tokens[0] == "inline":
                # Safelisting and brace expansion are CSS-local upstream features.
                # They do not read the filesystem; upstream validates their syntax.
                continue
            if len(tokens) != 1:
                raise InputError("@source must name one declared candidate or use inline(...)")
            target = string_value(tokens[0])
            if relative_name(name, target) not in candidate_names:
                raise InputError(f"@source {target!r} is not declared in srcs")
    return disabled


def compile_css(compiler, manifest, output, minify):
    entry = manifest["entry"]
    css = [entry] + manifest.get("css", [])
    candidates = manifest.get("candidates", [])
    declared = {}
    for item in css + candidates:
        name = path_name(item["name"])
        source = Path(item["path"]).resolve()
        if name in declared and declared[name] != source:
            raise InputError(f"two artifacts have the same staged path: {name}")
        declared[name] = source
    css_names = {item["name"] for item in css}
    candidate_names = {item["name"] for item in candidates}
    contents = {}
    disabled = False
    for item in css:
        name = item["name"]
        text = declared[name].read_text(encoding="utf-8")
        try:
            own_disabled = validate_css(name, text, css_names, candidate_names)
            if name == entry["name"]:
                disabled = own_disabled
        except InputError as error:
            raise InputError(f"{name}: {error}") from error
        contents[name] = text
    if not disabled:
        raise InputError(f'{entry["name"]}: entry CSS must import Tailwind with source(none)')

    compiler = os.fspath(Path(compiler).resolve())
    with tempfile.TemporaryDirectory(prefix="buck-tailwind-") as temporary:
        root = Path(temporary)
        for name, source in declared.items():
            staged = root / "owned" / name
            staged.parent.mkdir(parents=True, exist_ok=True)
            if name in contents:
                staged.write_text(contents[name], encoding="utf-8")
            else:
                shutil.copyfile(source, staged)
        staged_entry = root / "owned" / entry["name"]
        explicit = []
        for name in sorted(candidate_names):
            relative = posixpath.relpath(name, posixpath.dirname(entry["name"]) or ".")
            explicit.append(f'@source "{relative}";')
        with staged_entry.open("a", encoding="utf-8") as file:
            file.write("\n" + "\n".join(explicit) + "\n")
        command = [compiler, "--input", "owned/" + entry["name"], "--output", "-", "--cwd", ".", "--silent"]
        if minify:
            command.append("--minify")
        # Do not inherit Node/Bun module hooks or Tailwind debug/source settings.
        env = {"PATH": os.defpath, "HOME": temporary, "TMPDIR": temporary,
               "NO_COLOR": "1", "LC_ALL": "C"}
        result = subprocess.run(command, cwd=root, env=env, capture_output=True)
        diagnostics = result.stderr.decode("utf-8", errors="replace").replace(temporary + "/owned/", "").replace(temporary, ".")
        if diagnostics:
            sys.stderr.write(diagnostics)
        if result.returncode:
            raise InputError(f'{entry["name"]}: Tailwind compilation failed (exit {result.returncode})')
        Path(output).write_bytes(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--minify", action="store_true")
    args = parser.parse_args()
    try:
        manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
        compile_css(args.compiler, manifest, args.output, args.minify)
    except (InputError, OSError) as error:
        print(f"tailwind.css: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
