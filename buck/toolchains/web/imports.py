#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Offline ownership checking over the native parser's authored-source facts.

Resolution is deliberately exact: no extension probing, package installation or
network lookup. Deno remains the type checker, not the dependency discoverer.
"""

import copy
import fnmatch
import json
import os
import pathlib
import subprocess
import urllib.parse


CODE_EXTENSIONS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
DEFAULT_PLATFORM = {
    "name": "web",
    "types": [],
    "modules": {},
    "externals": [],
    "compiler_libs": ["dom", "dom.iterable", "esnext"],
    "deno_lint": False,
    "check_js": False,
    "bundle_platform": "browser",
    "server_conditions": ["default"],
}


class GraphError(Exception):
    pass


def platform(manifest: dict) -> dict:
    """The root profile governs the entire checked dependency closure."""
    return {**DEFAULT_PLATFORM, **manifest.get("platform", {})}


def external(specifier: str, patterns: list[str]) -> bool:
    # Externals name runtime modules, never an exemption for source ownership.
    if specifier.startswith((".", "/")) or specifier.lower().startswith("file:"):
        return False
    return any(fnmatch.fnmatchcase(specifier, pattern) for pattern in patterns)


def check_external_bindings(specifiers, profile: dict) -> None:
    for specifier in sorted(specifiers):
        if external(specifier, profile["externals"]):
            raise GraphError('declared external "{}" conflicts with a dependency export or pinned runtime import'.format(specifier))


def _path(path):
    return os.path.normpath(os.path.relpath(os.path.abspath(path)))


def _identity(path):
    return os.path.realpath(path)


def _code(path):
    return path.endswith(CODE_EXTENSIONS + (".svelte",))


def _local(specifier, importer):
    if specifier.lower().startswith("file:"):
        parsed = urllib.parse.urlsplit(specifier)
        if parsed.netloc not in ("", "localhost") or parsed.query or parsed.fragment:
            raise GraphError('unsupported file URL "{}"'.format(specifier))
        return _path(urllib.parse.unquote(parsed.path))
    if specifier.startswith(("./", "../", "/")):
        return _path(os.path.join(os.path.dirname(importer), specifier))
    return None


def _inspect(command, paths):
    try:
        result = subprocess.run(command + ["inspect", *paths], capture_output=True, text=True)
    except OSError as error:
        raise GraphError("native import inspection failed: {}".format(error)) from error
    try:
        report = json.loads(result.stdout)
        files = {_identity(file["path"]): file for file in report["files"]}
        if set(files) != {_identity(path) for path in paths}:
            raise ValueError("inspection did not report every requested source")
        for file in files.values():
            for key in ("imports", "references", "computed_imports", "diagnostics"):
                if not isinstance(file[key], list):
                    raise ValueError("invalid {} facts".format(key))
    except (ValueError, KeyError, TypeError) as error:
        raise GraphError("native import inspection failed: {}\n{}".format(error, result.stderr)) from error
    # Parse errors are reported below with authored paths, but an otherwise
    # unexplained command failure must never be accepted as an empty graph.
    if result.returncode and not any(diagnostic.get("severity") == "error" for file in files.values() for diagnostic in file["diagnostics"]):
        raise GraphError("native import inspection failed:\n" + result.stderr)
    return files


def check_graph(manifest: dict, native_command: list[str], wasm_dir=None) -> list[str]:
    """Validate authored and check-view edges; return this unit's check roots.

    Accept either the original manifest or svelte.manifest_view(..., 'check').
    Pinned runtime packages are trusted only as origins; application imports
    still pass ownership/direct-dependency checks, including generated TSX.
    """
    return _check_graph(manifest, native_command, wasm_dir, browser=False)


def check_browser_graph(manifest: dict, native_command: list[str], entry: str) -> set[str]:
    """Check client value edges from entry; return reachable owned source paths."""
    return _check_graph(manifest, native_command, None, browser=True, entry=entry)


def _check_graph(manifest, native_command, wasm_dir, browser, entry=None):
    svelte = None

    def code_source(path):
        return _code(path) and (not browser or not path.endswith((".d.ts", ".d.mts", ".d.cts")))

    if any(unit.get("generated") or unit.get("svelte_runtime") for unit in [manifest["unit"], *manifest["libraries"]]):
        import svelte as svelte_module
        svelte = svelte_module
        view = "client" if browser else "check"
        if manifest.get("view") != view:
            manifest = copy.deepcopy(manifest)
            for unit in [manifest["unit"], *manifest["libraries"]]:
                if "original_srcs" in unit:
                    originals = dict(zip(unit["srcs"], unit["original_srcs"]))
                    unit["exports"] = {specifier: originals.get(path, path) for specifier, path in unit["exports"].items()}
                    unit["srcs"] = unit.pop("original_srcs")
            manifest = svelte.manifest_view(manifest, view)
    records = {}
    for unit in [manifest["unit"], *manifest["libraries"]]:
        records.setdefault(unit["label"], unit)
    owner, authored, partners, generated = {}, {}, {}, set()
    sources, direct, exports, wasm = {}, {}, {}, {}
    errors = []
    for label, unit in records.items():
        original = unit.get("original_srcs", unit["srcs"])
        if len(original) != len(unit["srcs"]):
            raise GraphError("{}: original/check source mappings disagree".format(label))
        sources[label] = {_identity(path) for path in [*original, *unit["srcs"]]}
        direct[label] = set(unit["deps"])
        for source, check in zip(original, unit["srcs"]):
            source, check = _path(source), _path(check)
            for path in (source, check):
                key = _identity(path)
                if key in owner and owner[key] != label:
                    raise GraphError("{} is in the srcs of both {} and {}".format(path, owner[key], label))
                owner[key] = label
                authored[key] = source
            if _identity(source) != _identity(check):
                partners[_identity(source)] = check
                partners[_identity(check)] = source
                generated.add(_identity(check))
        entries = [*(unit.get("exports", {}).items()), *((spec, module["path"]) for spec, module in unit.get("wasm", {}).items())]
        # As before, this unit's code is not importable by its own export name.
        for specifier, target in entries:
            if label == manifest["unit"]["label"] and specifier not in unit.get("wasm", {}):
                continue
            if specifier in exports and exports[specifier][1] != label:
                raise GraphError("specifier {} is claimed by both {} and {}; give one of them another import_name or drop one from the dependencies".format(specifier, exports[specifier][1], label))
            exports[specifier] = (_path(target), label)
        wasm.update({specifier: module for specifier, module in unit.get("wasm", {}).items()})
    profile = platform(manifest)
    modules = {specifier: _path(path) for specifier, path in profile["modules"].items()}
    toolchain = {_identity(path): _path(path) for path in [*profile["types"], *modules.values()]}
    shims = {}
    for specifier, module in wasm.items():
        if browser:
            continue
        if wasm_dir is None:
            raise GraphError("the closure has wasm modules but no --wasm-dir was given")
        shim = _path(os.path.join(wasm_dir, module["module"] + ".js"))
        declaration = _path(os.path.join(wasm_dir, module["module"] + ".d.ts"))
        shims[_identity(shim)] = _identity(module["path"])
        toolchain.update({_identity(shim): shim, _identity(declaration): declaration})
        exports[specifier] = (shim, exports[specifier][1])
    runtime = svelte.runtime_imports(manifest) if svelte else {}
    aliases = svelte.source_aliases(manifest) if svelte else {}
    check_external_bindings(set(exports) | set(runtime) | set(aliases), profile)
    for specifier in modules:
        if specifier in exports or specifier in runtime:
            raise GraphError("reserved platform module specifier {} is exported by a dependency or runtime".format(specifier))

    def runtime_source(path):
        # realpath confines even symlinked files to the declared pinned roots.
        if not svelte:
            return False
        absolute = _identity(path)
        return any(os.path.commonpath([absolute, _identity(directory)]) == _identity(directory) for directory in manifest["runtime"].values())

    def where(path, edge):
        display = authored.get(_identity(path), path)
        try:
            with open(path, "rb") as stream:
                prefix = stream.read(edge.get("start", 0))
            line = prefix.count(b"\n") + 1
            column = len(prefix.rsplit(b"\n", 1)[-1].decode("utf-8").encode("utf-16-le")) // 2 + 1
        except (OSError, UnicodeError):
            return display
        if _identity(path) in generated:
            return "{} (generated check {}:{}:{})".format(display, path, line, column)
        return "{}:{}:{}".format(display, line, column)

    roots = sorted(_path(path) for path in manifest["unit"]["srcs"] if path.endswith(CODE_EXTENSIONS) and code_source(path))
    if browser:
        entry = _path(entry)
        if owner.get(_identity(entry)) != manifest["unit"]["label"]:
            raise GraphError("{}: browser entry is not owned by {}".format(entry, manifest["unit"]["label"]))
        pending = {entry}
    else:
        pending = set(roots) | {_path(path) for path in manifest["unit"].get("original_srcs", manifest["unit"]["srcs"]) if code_source(path)}
        pending.update(toolchain.values())
        if svelte:
            pending.update(_path(path) for path in svelte.runtime_types(manifest))
    visited = set()
    reachable = set()
    while pending:
        paths = sorted(path for path in pending if _identity(path) not in visited)
        pending.clear()
        if not paths:
            break
        facts = _inspect(native_command, paths)
        for path in paths:
            key = _identity(path)
            if key in visited:
                continue
            visited.add(key)
            if browser and key in owner:
                reachable.add(path)
            if key in partners and _code(partners[key]):
                pending.add(partners[key])
            file = facts[key]
            label = owner.get(key)
            trusted = label is None and (key in toolchain or runtime_source(path))
            for diagnostic in file["diagnostics"]:
                if diagnostic.get("severity") == "error":
                    errors.append("{}: {}".format(where(path, diagnostic), diagnostic.get("message", "native parse failed")))
            if any(diagnostic.get("severity") == "error" for diagnostic in file["diagnostics"]):
                continue
            for edge in file["computed_imports"]:
                errors.append("{}: computed dynamic import {} is not allowed; use a literal module specifier".format(where(path, edge), edge.get("expression", "")))
            edges = list(file["imports"])
            if browser:
                edges = [edge for edge in edges if edge["kind"] == "code"]
            else:
                edges.extend(file["references"])
            for edge in edges:
                raw = edge["specifier"]
                location = where(path, edge)
                if browser and (external(raw, profile["externals"]) or raw == "svelte/server" or raw.startswith("svelte/server/") or raw == "svelte/internal/server" or raw.startswith("svelte/internal/server/")):
                    errors.append('{}: runtime import "{}" is not allowed in a browser graph'.format(location, raw))
                    continue
                if external(raw, profile["externals"]) and raw not in modules and raw not in exports and raw not in runtime:
                    continue
                try:
                    target = _local(raw, path)
                except GraphError as error:
                    errors.append("{}: {}".format(location, error))
                    continue
                if target is not None:
                    if key in generated and svelte:
                        alias = aliases.get(pathlib.Path(os.path.abspath(target)).as_uri())
                        if alias:
                            target = _path(alias)
                    target_key = _identity(target)
                    if key in shims and target_key == shims[key] and edge.get("phase") == "source":
                        continue
                    if trusted:
                        if target_key not in toolchain and not runtime_source(target):
                            errors.append('{}: relative import "{}" leaves the pinned toolchain inputs'.format(location, raw))
                            continue
                    elif target_key not in sources.get(label, set()):
                        errors.append('{}: relative import "{}" leaves the srcs of {}; import another target through its exported specifier'.format(location, raw, label))
                        if target_key not in owner:
                            errors.append("{}: not in the srcs of any target in the closure of {}".format(target, manifest["unit"]["label"]))
                        continue
                elif raw in exports and not trusted:
                    target, provider = exports[raw]
                    if provider != label and provider not in direct.get(label, set()):
                        errors.append('{}: "{}" comes from {}, which is not a direct dependency of {}'.format(location, raw, provider, label))
                        continue
                    if _identity(target) not in owner and _identity(target) not in toolchain and not (browser and raw in wasm):
                        errors.append("{}: not in the srcs of any target in the closure of {}".format(target, manifest["unit"]["label"]))
                        continue
                elif raw in modules:
                    target = modules[raw]
                elif raw in runtime and (trusted or key in generated or svelte.public_runtime_import(raw)):
                    target = _path(runtime[raw])
                    if not runtime_source(target):
                        errors.append('{}: runtime import "{}" leaves the pinned toolchain inputs'.format(location, raw))
                        continue
                else:
                    errors.append('{}: unsupported import "{}"; only relative paths, dependency exports, platform modules and declared externals are allowed{}'.format(location, raw, "; unsupported node module" if raw.startswith("node:") else ""))
                    continue
                if not os.path.isfile(target):
                    errors.append('{}: cannot resolve "{}": {} does not exist'.format(location, raw, target))
                elif code_source(target):
                    pending.add(target)
    if errors:
        raise GraphError("\n".join(sorted(set(errors))))
    return reachable if browser else roots
