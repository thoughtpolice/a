#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Merge first-party exports into an import map without moving Deno config."""

import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

import svelte
import webc


def load_jsonc(path):
    if urllib.parse.urlsplit(path).scheme in ("http", "https"):
        with urllib.request.urlopen(path) as response:
            text = response.read().decode("utf-8-sig")
    else:
        with open(path, encoding="utf-8-sig") as stream:
            text = stream.read()
    # Preserve strings and line positions while removing JSONC comments.
    characters = list(text)
    index = 0
    quoted = False
    while index < len(text):
        character = text[index]
        if quoted:
            if character == "\\":
                index += 2
                continue
            if character == '"':
                quoted = False
        elif character == '"':
            quoted = True
        elif text.startswith("//", index):
            end = text.find("\n", index)
            end = len(text) if end < 0 else end
            characters[index:end] = " " * (end - index)
            index = end
            continue
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise ValueError("{}: unterminated JSONC block comment".format(path))
            end += 2
            characters[index:end] = [c if c in "\r\n" else " " for c in text[index:end]]
            index = end
            continue
        index += 1
    # Remove trailing commas only outside strings, after comment removal.
    text = "".join(characters)
    index = 0
    quoted = False
    while index < len(text):
        character = text[index]
        if quoted:
            if character == "\\":
                index += 2
                continue
            if character == '"':
                quoted = False
        elif character == '"':
            quoted = True
        elif character == ",":
            end = index + 1
            while end < len(text) and text[end].isspace():
                end += 1
            if end < len(text) and text[end] in "}]":
                characters[index] = " "
        index += 1
    result = json.loads("".join(characters))
    if not isinstance(result, dict):
        raise ValueError("{}: config/import map must be an object".format(path))
    return result


def relocate(value, source_dir, output_dir):
    if not isinstance(value, str):
        return value
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme:
        return value
    if not value.startswith(("./", "../", "/")):
        return value
    if urllib.parse.urlsplit(source_dir).scheme in ("http", "https"):
        return urllib.parse.urljoin(source_dir, value)
    if value.startswith("/"):
        return value
    path = webc.relative_to(os.path.join(source_dir, parsed.path), output_dir)
    if parsed.path.endswith("/") and not path.endswith("/"):
        path += "/"
    return urllib.parse.urlunsplit(("", "", path, parsed.query, parsed.fragment))


def relocate_map(mapping, source_dir, output_dir):
    return {
        relocate(key, source_dir, output_dir): relocate(value, source_dir, output_dir)
        for key, value in mapping.items()
    }


def check_reserved(mapping, reserved, context):
    for key in mapping:
        for dependency in reserved:
            if key == dependency or (key.endswith("/") and dependency.startswith(key)) or (dependency.endswith("/") and key.startswith(dependency)):
                raise ValueError("{} import {!r} conflicts with reserved dependency/runtime export {!r}".format(context, key, dependency))


def config_import_map(config_path, output_dir):
    original = load_jsonc(config_path) if config_path else {}
    directory = (os.path.dirname(config_path) or ".") if config_path else "."
    if "importMap" in original:
        reference = original["importMap"]
        parsed = urllib.parse.urlsplit(reference)
        if parsed.scheme in ("http", "https"):
            path = reference
            directory = urllib.parse.urljoin(reference, ".")
        else:
            path = urllib.parse.unquote(parsed.path) if parsed.scheme == "file" else os.path.join(directory, reference)
            directory = os.path.dirname(path) or "."
        original = load_jsonc(path)
        extended = False
    else:
        # deno.json expands bare npm/jsr aliases to package subpath mappings;
        # external import maps follow the standard and do not do this.
        extended = True

    def mappings(values):
        result = relocate_map(values, directory, output_dir)
        if extended:
            for key, value in list(result.items()):
                if not key.endswith("/") and isinstance(value, str) and value.startswith(("npm:", "jsr:")):
                    scheme, target = value.split(":", 1)
                    result.setdefault(key + "/", scheme + ":/" + target.lstrip("/").rstrip("/") + "/")
        return result

    return {
        "imports": mappings(original.get("imports", {})),
        "scopes": {
            relocate(scope, directory, output_dir): mappings(values)
            for scope, values in original.get("scopes", {}).items()
        },
    }


def type_wrapper(source, type_source, directory, index, type_roots, default=False, bare_types=False):
    """Pair real runtime exports with their authored/compiler public types."""
    os.makedirs(directory, exist_ok=True)
    module = os.path.join(directory, "{}.js".format(index))
    declaration = os.path.join(directory, "{}.d.ts".format(index))

    def exports(destination):
        text = "export * from {};\n".format(json.dumps(destination))
        if default:
            text += "export {{ default }} from {};\n".format(json.dumps(destination))
        return text

    with open(module, "w", encoding="utf-8") as stream:
        stream.write('// @ts-self-types="./{}.d.ts"\n'.format(index))
        stream.write(exports(webc.relative_to(source, directory)))
    with open(declaration, "w", encoding="utf-8") as stream:
        for root in type_roots:
            stream.write("/// <reference path={} />\n".format(json.dumps(webc.relative_to(root, directory))))
        stream.write(exports(type_source if bare_types else webc.relative_to(type_source, directory)))
    return module, declaration


def source_aliases(manifest, output_dir, replacements):
    return {
        webc.relative_to(urllib.parse.unquote(urllib.parse.urlsplit(specifier).path), output_dir): replacements.get(source, source)
        for specifier, source in svelte.source_aliases(manifest).items()
    }


def runtime_view(manifest, output_dir):
    view = svelte.manifest_view(manifest, "server")
    check = svelte.manifest_view(manifest, "check")
    type_roots = svelte.runtime_types(check)
    replacements, facades = {}, {}
    if type_roots:
        wrapper_dir = os.path.join(output_dir, "types")
        for unit in webc.units(view):
            for authored, source in zip(unit.get("original_srcs", []), unit["srcs"]):
                # The official check projection preserves exact component props,
                # bindings and exports; the SSR function signature does not.
                if authored.endswith(".svelte"):
                    projection = svelte.generated_path(unit["generated"], authored, "check")
                    module, declaration = type_wrapper(source, projection, wrapper_dir, len(replacements), type_roots, default=True)
                    replacements[source], facades[source] = module, declaration
    runtime = svelte.runtime_imports(view)
    type_runtime = svelte.runtime_imports(check)
    api_facades = []
    for index, (specifier, source) in enumerate(sorted(runtime.items())):
        if svelte.public_runtime_import(specifier) or specifier in ("clsx", "devalue"):
            type_source = type_runtime[specifier]
            roots = type_roots + ([type_source] if specifier == "devalue" else [])
            module, declaration = type_wrapper(
                source, type_source if specifier == "clsx" else specifier,
                os.path.join(output_dir, "runtime-types"), index, roots,
                default = specifier == "clsx",
                bare_types = specifier != "clsx",
            )
            runtime[specifier] = module
            api_facades.append(declaration)
    # Type-only APIs such as svelte/elements have no runtime implementation.
    for specifier, source in type_runtime.items():
        runtime.setdefault(specifier, source)
    return view, check, replacements, facades, runtime, type_runtime, api_facades


def denied(specifier):
    """An unsupported scheme rejects the edge without import-map diagnostics."""
    return "buck2-undeclared:" + urllib.parse.quote(specifier, safe="")


def merge_import_map(manifest, config_path, output_dir):
    result = config_import_map(config_path, output_dir)
    view, check, replacements, facades, runtime, type_runtime, api_facades = runtime_view(manifest, output_dir)
    bindings = webc.closure_specifiers(view)
    wasm_dir = os.path.join(output_dir, "wasm")
    shims = {
        specifier: os.path.join(wasm_dir, module["module"] + ".js")
        for specifier, module in webc.wasm_modules(view).items()
    }
    paths = {
        specifier: shims.get(specifier, replacements.get(source, source))
        for specifier, (source, _) in bindings.items()
    }
    aliases = source_aliases(view, output_dir, replacements)
    runtime_bindings = {**runtime, **aliases}
    for specifier in runtime_bindings:
        if specifier in bindings:
            raise ValueError("reserved Svelte runtime specifier {!r} is exported by a dependency".format(specifier))
    reserved = {**paths, **runtime_bindings}
    check_reserved(result["imports"], reserved, "config")
    for scope, values in result["scopes"].items():
        check_reserved(values, reserved, "scope {!r}".format(scope))
    result["imports"].update({
        specifier: webc.relative_to(source, output_dir)
        for specifier, source in runtime_bindings.items()
    })
    direct = set(manifest["unit"]["deps"])
    for specifier, (_, owner) in bindings.items():
        result["imports"][specifier] = webc.relative_to(paths[specifier], output_dir) if owner in direct else denied(specifier)

    # Each library sees only its own wasm and its declared direct dependencies.
    # Denial URLs also mask app-global siblings that it did not declare.
    checked_units = {unit["label"]: unit for unit in webc.units(check)}
    type_bindings = {**type_runtime, **source_aliases(check, output_dir, {})}
    type_mapping = {specifier: webc.relative_to(source, output_dir) for specifier, source in type_bindings.items()}
    for source in api_facades:
        result["scopes"].setdefault(webc.relative_to(source, output_dir), {}).update(type_mapping)
    for unit in webc.units(view)[1:]:
        dependencies = set(unit["deps"])
        mapping = {
            specifier: webc.relative_to(paths[specifier], output_dir)
            if owner in dependencies or specifier in unit.get("wasm", {}) else denied(specifier)
            for specifier, (_, owner) in bindings.items()
        }
        sources = unit["srcs"] + unit.get("original_srcs", [])
        sources += [replacements[source] for source in unit["srcs"] if source in replacements]
        for source in sources:
            # Deno normalizes these into file-URI importer scopes; relative
            # spelling keeps remote actions and cached maps host-independent.
            scope = webc.relative_to(source, output_dir)
            result["scopes"].setdefault(scope, {}).update(mapping)
        checked = checked_units[unit["label"]]
        type_sources = [
            source for original, source in zip(checked.get("original_srcs", []), checked["srcs"])
            if source != original
        ]
        type_sources += [facades[source] for source in unit["srcs"] if source in facades]
        for source in type_sources:
            result["scopes"].setdefault(webc.relative_to(source, output_dir), {}).update({**mapping, **type_mapping})
    webc.write_wasm_shims(view, wasm_dir, runtime=False)
    return result


def check_stamp(path, command):
    result = subprocess.run(command)
    if result.returncode == 0:
        with open(path, "w", encoding="utf-8") as stream:
            stream.write("checked\n")
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest")
    parser.add_argument("--config")
    parser.add_argument("--out-dir")
    parser.add_argument("--check-stamp")
    parser.add_argument("--show-stamp")
    parser.add_argument("--command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.show_stamp:
        if args.check_stamp or args.command or args.manifest or args.out_dir:
            parser.error("--show-stamp only reads a successful check receipt")
        with open(args.show_stamp, encoding="utf-8") as stream:
            sys.stdout.write(stream.read())
        return
    if args.check_stamp:
        if not args.command or args.manifest or args.out_dir:
            parser.error("--check-stamp requires --command and cannot generate a map")
        sys.exit(check_stamp(args.check_stamp, args.command))
    if not args.manifest or not args.out_dir or args.command:
        parser.error("map generation requires --manifest and --out-dir")
    try:
        os.makedirs(args.out_dir, exist_ok=True)
        config = merge_import_map(webc.load_manifest(args.manifest), args.config, args.out_dir)
        with open(os.path.join(args.out_dir, "import-map.json"), "w", encoding="utf-8") as stream:
            json.dump(config, stream, indent=2, sort_keys=True)
            stream.write("\n")
    except (ValueError, OSError, webc.GraphError) as error:
        print("deno dependency config: {}".format(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
