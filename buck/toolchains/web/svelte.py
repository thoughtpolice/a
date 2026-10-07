#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Manifest views for native Svelte output and pinned runtime declarations."""

import copy
import json
import os
import pathlib
import re
import urllib.parse


def records(manifest):
    return [manifest["unit"], *manifest["libraries"]]


def enabled(manifest):
    return any(unit.get("generated") or unit.get("svelte_runtime") for unit in records(manifest))


def generated_path(generated, source, view):
    for item in generated["files"]:
        if item["source"] == source:
            name = item["name"]
            if name.endswith(".svelte"):
                name += ".tsx" if view == "check" else ".js"
            elif view != "check" and name.endswith(".svelte.ts"):
                name = name[:-3] + ".js"
            return os.path.join(generated["directory"], view, name)
    return source


def manifest_view(manifest, view="check"):
    result = copy.deepcopy(manifest)
    for unit in records(result):
        generated = unit.get("generated")
        if not generated:
            continue
        unit["original_srcs"] = list(unit["srcs"])
        unit["srcs"] = [generated_path(generated, source, view) for source in unit["srcs"]]
        unit["exports"] = {name: generated_path(generated, source, view) for name, source in unit["exports"].items()}
    result["view"] = view
    return result


def file_url(path):
    return pathlib.Path(os.path.abspath(path)).as_uri()


def source_aliases(manifest):
    """Resolve authored relative SFC/data paths inside each generated tree."""
    view = manifest.get("view", "check")
    imports = {}
    for unit in records(manifest):
        generated = unit.get("generated")
        if not generated:
            continue
        for item in generated["files"] + generated.get("data", []):
            source = item["source"]
            destination = generated_path(generated, source, view)
            imports[file_url(source)] = destination
            # .svelte imports intentionally keep their authored extension;
            # JSON/data modules remain original, declared source artifacts.
            imports[file_url(os.path.join(generated["directory"], view, item["name"]))] = destination
    return imports


def _select(entry, conditions):
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        for condition in conditions:
            if condition in entry:
                selected = _select(entry[condition], conditions)
                if selected:
                    return selected
    return None


def runtime_imports(manifest):
    if not enabled(manifest):
        return {}
    packages = manifest["runtime"]
    view = manifest.get("view", "check")
    svelte = packages["svelte"]
    with open(os.path.join(svelte, "package.json")) as stream:
        metadata = json.load(stream)
    server_conditions = manifest.get("platform", {}).get("server_conditions", ["default"])
    conditions = ["types", "default"] if view == "check" else (["browser", "default"] if view == "client" else server_conditions)
    imports = {}
    for name, entry in metadata["exports"].items():
        if name in ("./compiler", "./package.json"):
            continue
        selected = _select(entry, conditions)
        if selected:
            imports["svelte" + (name[1:] if name != "." else "")] = os.path.join(svelte, selected)
    imports.update({
        "clsx": os.path.join(packages["clsx"], "clsx.d.mts" if view == "check" else "dist/clsx.mjs"),
        "esm-env": os.path.join(packages["esm-env"], "index.js"),
        "esm-env/browser": os.path.join(packages["esm-env"], "true.js" if view == "client" else "false.js"),
        "esm-env/development": os.path.join(packages["esm-env"], "false.js"),
        "esm-env/node": os.path.join(packages["esm-env"], "true.js" if view == "server" and "node" in server_conditions else "false.js"),
        "devalue": os.path.join(packages["devalue"], "types/index.d.ts" if view == "check" else "index.js"),
        "esrap": os.path.join(packages["esrap"], "types/index.d.ts"),
        "estree": os.path.join(packages["estree"], "index.d.ts"),
        "magic-string": os.path.join(packages["magic-string"], "dist/magic-string.cjs.d.ts"),
        "locate-character": os.path.join(packages["locate-character"], "types/index.d.ts"),
        "@jridgewell/sourcemap-codec": os.path.join(packages["sourcemap-codec"], "types/sourcemap-codec.d.mts"),
    })
    # Svelte's internal JSDoc type imports are part of its pinned package,
    # not additional imports applications may use to escape their deps.
    for name, entry in metadata.get("imports", {}).items():
        selected = _select(entry, ["types", "default"])
        if selected:
            imports[name] = os.path.join(svelte, selected)
    return imports


def runtime_types(manifest):
    if not enabled(manifest):
        return []
    packages = manifest["runtime"]
    result = [os.path.join(packages["svelte"], "types/index.d.ts")]
    if any(unit.get("generated") for unit in records(manifest)):
        result.extend(os.path.join(packages["svelte2tsx"], name) for name in ("svelte-shims-v4.d.ts", "svelte-jsx-v4.d.ts"))
    return result


def public_runtime_import(specifier):
    return specifier == "svelte" or specifier.startswith("svelte/") and not specifier.startswith(("svelte/compiler", "svelte/internal"))


def _byte_offset(source, line, column):
    lines = source.splitlines(keepends=True)
    if line < 1 or line > len(lines):
        return None
    offset = sum(len(text.encode("utf-8")) for text in lines[:line - 1])
    units = 0
    for character in lines[line - 1]:
        if units >= column:
            break
        units += len(character.encode("utf-16-le")) // 2
        offset += len(character.encode("utf-8"))
    return offset


def _position(source, byte_offset):
    prefix = source.encode("utf-8")[:byte_offset].decode("utf-8")
    line = prefix.count("\n") + 1
    column = len(prefix.rsplit("\n", 1)[-1].encode("utf-16-le")) // 2
    return line, column + 1


def rewrite_diagnostics(manifest, text):
    projections = {}
    for unit in records(manifest):
        generated = unit.get("generated")
        if generated:
            for item in generated["files"]:
                path = generated_path(generated, item["source"], "check")
                projections[os.path.abspath(path)] = (item, generated)

    def replace(match):
        path = urllib.parse.unquote(urllib.parse.urlparse(match[1]).path)
        entry = projections.get(os.path.abspath(path))
        if entry is None:
            return match[0]
        item, generated = entry
        source = item["source"]
        if not source.endswith(".svelte"):
            return "{}:{}:{}".format(file_url(source), match[2], match[3])
        with open(path) as stream:
            projection = stream.read()
        offset = _byte_offset(projection, int(match[2]), int(match[3]) - 1)
        facts_path = os.path.join(generated["directory"], "facts", item["name"] + ".json")
        with open(facts_path) as stream:
            facts = json.load(stream)
        for mapping in facts.get("projection", {}).get("exact_mappings", []):
            begin, end = mapping["generated"]["start"], mapping["generated"]["end"]
            if offset is not None and begin <= offset < end:
                original_offset = mapping["source"]["start"] + offset - begin
                with open(source) as stream:
                    original = stream.read()
                line, column = _position(original, original_offset)
                return "{}:{}:{}".format(file_url(source), line, column)
        # A helper-generated type failure must not claim an authored span.
        return "{} [generated projection {}:{}:{}]".format(file_url(source), match[1], match[2], match[3])

    return re.sub(r"(file://[^\s\x1b]+?):(\d+):(\d+)", replace, text)
