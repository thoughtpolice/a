#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""Build a relocatable source distribution; never install or publish packages."""

import argparse
import fnmatch
import gzip
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
from urllib.parse import quote, unquote, urlsplit


CODE_EXTENSIONS = {".js", ".mjs", ".ts", ".mts"}
PACKAGE_NAME = re.compile(r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*\Z")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\Z")


def fail(message):
    raise ValueError(message)


def safe_relative(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or "\\" in value or any(p in {".", ".."} for p in value.split("/")):
        fail(f"unsafe package path: {value!r}")
    return path


def source_path(value):
    path = Path(os.path.abspath(value))
    if not path.is_file():
        fail(f"missing package input: {value}")
    return path


def declaration_path(path):
    return path.with_suffix(".d.mts" if path.suffix == ".mjs" else ".d.ts")


def layout(record, format):
    if record.get("generated") or record.get("svelte_runtime") or record.get("wasm"):
        fail(f"{record['import_name']}: generated Svelte/runtime and wasm distribution is unsupported")
    paths = list(dict.fromkeys(source_path(p) for p in record["srcs"]))
    if not paths:
        fail(f"{record['import_name']}: package needs own source files")
    common = Path(os.path.commonpath([str(p.parent) for p in paths]))
    result = {}
    used = set()
    for source in paths:
        if source.suffix in {".cjs", ".cts", ".jsx", ".tsx", ".svelte"}:
            fail(f"unsupported distribution source: {source.name}")
        target = PurePosixPath("modules") / safe_relative(source.relative_to(common).as_posix())
        if "buck-out" in target.parts:
            fail("mixed source/staging roots cannot expose Buck paths; package sources need a common logical source directory")
        if format == "npm" and source.suffix in {".ts", ".mts"} and not is_declaration(source):
            target = target.with_suffix(".mjs" if source.suffix == ".mts" else ".js")
        if target in used:
            fail(f"colliding emitted source paths: {target}")
        used.add(target)
        result[source] = target
    return result


def is_declaration(path):
    return path.name.endswith((".d.ts", ".d.mts"))


def exported(record, paths=None):
    name = record["import_name"]
    if not PACKAGE_NAME.fullmatch(name):
        fail(f"invalid package name: {name!r}")
    result = {}
    for specifier, file in record["exports"].items():
        if specifier == name:
            key = "."
        elif specifier.startswith(name + "/"):
            suffix = specifier[len(name) + 1:]
            safe_relative(suffix)
            if any(c in suffix for c in "*?#%"):
                fail(f"non-literal package export: {specifier}")
            key = "./" + suffix
        else:
            fail(f"export {specifier!r} is outside package {name!r}")
        source = source_path(file) if paths is not None else Path(os.path.abspath(file))
        if paths is not None and (source not in paths or source.suffix not in CODE_EXTENSIONS or is_declaration(source)):
            fail(f"export {specifier!r} must name an owned executable source")
        if key in result:
            fail(f"ambiguous export {specifier}")
        result[key] = paths[source] if paths is not None else source
    if not result:
        fail(f"{name}: explicit package exports are required")
    return result


def relative_dependency_exports(record):
    """Resolve only public targets; private source kinds are another release's policy."""
    sources = {Path(os.path.abspath(path)) for path in record["srcs"]}
    if not sources:
        fail(f"{record['import_name']}: relative package mapping needs a known source layout")
    common = Path(os.path.commonpath([str(source.parent) for source in sources]))
    result = {}
    for specifier, file in record["exports"].items():
        source = Path(os.path.abspath(file))
        if source not in sources:
            fail(f"relative package mapping needs an authored source target for {specifier}")
        target = PurePosixPath("modules") / safe_relative(source.relative_to(common).as_posix())
        if "buck-out" in target.parts:
            fail(f"relative package export layout would leak Buck staging paths: {specifier}")
        result[specifier] = target
    return result


def package_specifier(specifier):
    """Return package, subpath and optional authored registry version."""
    registry = None
    if specifier.startswith(("npm:", "jsr:")):
        registry, specifier = specifier.split(":", 1)
    if specifier.startswith("@"):
        parts = specifier.split("/")
        if len(parts) < 2:
            fail(f"invalid scoped import: {specifier}")
        package = "/".join(parts[:2])
        subpath = "/".join(parts[2:])
        version_at = package.find("@", 1)
    else:
        package, _, subpath = specifier.partition("/")
        version_at = package.find("@")
    version = None
    if version_at >= 0:
        if registry is None:
            fail(f"version in bare module specifier: {specifier}")
        package, version = package[:version_at], package[version_at + 1:]
        if not version:
            fail(f"empty import version: {specifier}")
    if not PACKAGE_NAME.fullmatch(package):
        fail(f"invalid package import: {specifier}")
    if subpath:
        safe_relative(subpath)
        if any(c in subpath for c in "*?#%"):
            fail(f"non-literal package subpath: {specifier}")
    return package, subpath, version, registry


def authored_target(source, specifier):
    parsed = urlsplit(specifier)
    if parsed.query or parsed.fragment or "\\" in parsed.path or re.search(r"%2f|%5c", parsed.path, re.IGNORECASE):
        fail(f"relative import URLs with encoded separators/query/fragments are unsupported: {specifier}")
    decoded = unquote(parsed.path, encoding="utf-8", errors="strict")
    return Path(os.path.abspath(source.parent / decoded))


def relative_target(source, specifier, paths):
    candidate = authored_target(source, specifier)
    candidates = [candidate]
    if candidate.suffix == ".js":
        candidates.append(candidate.with_suffix(".ts"))
    elif candidate.suffix == ".mjs":
        candidates.append(candidate.with_suffix(".mts"))
    elif not candidate.suffix:
        candidates += [candidate.with_suffix(ext) for ext in sorted(CODE_EXTENSIONS)]
        candidates += [candidate / ("index" + ext) for ext in sorted(CODE_EXTENSIONS)]
    matches = [p for p in candidates if p in paths]
    # Exact authored paths take precedence; extensionless resolution must be unique.
    if candidate in paths:
        return candidate
    if len(matches) != 1:
        fail(f"{source.name}: relative import {specifier!r} is missing or ambiguous among owned sources")
    return matches[0]


def deno_relative_target(source, specifier, paths):
    # The checked graph resolves relative edges exactly, without extension or
    # index probing. It treats '%' as a filename byte, unlike a runtime URL;
    # reject that disagreement instead of modifying authored source/maps.
    if "%" in specifier:
        fail(f"Deno distribution requires an exact unescaped relative source path: {specifier}")
    candidate = authored_target(source, specifier)
    if candidate not in paths:
        fail(f"{source.name}: Deno relative import must exactly name an owned source: {specifier}")
    return candidate


def relative_import(origin, target):
    value = os.path.relpath(str(target), str(origin.parent)).replace(os.sep, "/")
    if not value.startswith("."):
        value = "./" + value
    return "/".join(quote(part, safe=".-_~") for part in value.split("/"))


def module_url(path):
    return quote(str(path), safe="/.-_~")


def native_json(native, *args):
    completed = subprocess.run([native, *map(str, args)], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def deno_base(value):
    if value.startswith(("./", "../")) and value.endswith("/"):
        if "\\" in value or any(c in value for c in "?#%"):
            fail(f"invalid relative Deno package base: {value!r}")
        return "relative"
    if value.startswith(("npm:", "jsr:")):
        package_specifier(value.rstrip("/"))
        return "registry"
    parsed = urlsplit(value)
    if parsed.scheme in {"http", "https"} and parsed.netloc and not parsed.query and not parsed.fragment:
        return "url"
    fail(f"Deno dependency needs npm:/jsr:/HTTP(S) or trailing-slash relative package base: {value!r}")


def release_value(value, format):
    if not isinstance(value, str) or not value or any(c.isspace() and c not in " \t" for c in value):
        fail("release mappings must be nonempty strings")
    if format == "deno":
        return deno_base(value)
    # npm supports versions, ranges, tags, and npm aliases, but not local/build paths.
    if value.startswith("npm:"):
        package, subpath, version, registry = package_specifier(value)
        if subpath or not version:
            fail(f"invalid npm release alias: {value}")
    elif not re.fullmatch(r"[0-9A-Za-z*^~<>=|+., \t-]+", value) or value.startswith(("file", "link", "workspace")):
        fail(f"npm release mapping must be a registry version/range/tag: {value!r}")
    return "registry"


def write_bytes(root, relative, content):
    path = root.joinpath(*safe_relative(str(relative)).parts)
    if any(p.is_symlink() for p in [path, *path.parents]):
        fail(f"symlink output path: {relative}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def tarball(root, target):
    entries = sorted(root.rglob("*"), key=lambda p: p.relative_to(root).as_posix())
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink() or any(p.is_symlink() for p in target.parents):
        fail("tarball path must not contain symlinks")
    with target.open("wb") as stream, gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for path in entries:
                if path.is_symlink() or not (path.is_dir() or path.is_file()):
                    fail(f"unsafe tar member: {path}")
                relative = safe_relative(path.relative_to(root).as_posix())
                info = tarfile.TarInfo("package/" + str(relative))
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                info.mode = 0o755 if path.is_dir() else 0o644
                if path.is_dir():
                    info.type = tarfile.DIRTYPE
                    archive.addfile(info)
                else:
                    content = path.read_bytes()
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))


def build(manifest, native, out_dir, archive=None):
    format = manifest["format"]
    if format not in {"npm", "deno"}:
        fail(f"unknown package format: {format}")
    if archive is not None and format != "npm":
        fail("tarballs are supported only for npm distributions")
    version = manifest["version"]
    if not VERSION.fullmatch(version):
        fail(f"invalid release version: {version!r}")
    root = manifest["unit"]
    own = layout(root, format)
    exports = exported(root, own)
    records = {}
    names = {}
    all_exports = {}
    for record in [root, *manifest["libraries"]]:
        label = record["label"]
        if label in records:
            if records[label] != record:
                fail(f"conflicting library records for {label}")
            continue
        # External releases supply identities/exports, not sources to distribute.
        # Their private source syntax and generated views cannot veto this root.
        exported(record)
        if record["import_name"] in names:
            fail(f"ambiguous package name {record['import_name']}")
        records[label] = record
        names[record["import_name"]] = record
        for specifier, path in record["exports"].items():
            if specifier in all_exports:
                fail(f"ambiguous exported module {specifier}")
            all_exports[specifier] = (record, own[source_path(path)] if label == root["label"] else None)
    direct = set()
    for label in root["deps"]:
        if label not in records:
            fail(f"missing direct dependency record {label}")
        direct.add(records[label]["import_name"])
    releases = manifest["dependencies"]
    release_kinds = {}
    for name, value in releases.items():
        if not PACKAGE_NAME.fullmatch(name) or name == root["import_name"]:
            fail(f"invalid release dependency {name!r}")
        release_kinds[name] = release_value(value, format)
    missing = direct - releases.keys()
    if missing:
        fail(f"missing direct dependency release mappings: {sorted(missing)}")
    if format == "deno":
        for name, kind in release_kinds.items():
            if kind == "relative" and name in names:
                for specifier, path in relative_dependency_exports(names[name]).items():
                    all_exports[specifier] = (names[name], path)
    used = set(direct)
    imports = {}
    modules = []
    code = [p for p in own if p.suffix in CODE_EXTENSIONS]
    facts = native_json(native, "inspect", *code)["files"] if code else []
    by_source = {source_path(f["path"]): f for f in facts}
    for source, output in own.items():
        if source.suffix not in CODE_EXTENSIONS:
            continue
        file = by_source[source]
        if file.get("diagnostics"):
            fail(f"{source.name}: native import inspection failed")
        if file.get("computed_imports"):
            fail(f"{source.name}: computed dynamic imports cannot be dependency-validated or relocated")
        if file.get("references"):
            fail(f"{source.name}: triple-slash reference directives are unsupported in distributions")
        rewrites = {}
        for fact in file["imports"]:
            specifier = fact["specifier"]
            if fact.get("phase"):
                fail(f"unsupported import phase: {specifier}")
            if specifier.startswith(("./", "../")):
                target = (deno_relative_target(source, specifier, own) if format == "deno"
                          else relative_target(source, specifier, own))
                if is_declaration(target) and fact["kind"] != "type":
                    fail(f"declaration files cannot be imported as executable modules: {specifier}")
                if format == "npm":
                    rewrites[specifier] = relative_import(output, own[target])
                continue
            if specifier.startswith(("node:", "cloudflare:")):
                if not any(fnmatch.fnmatchcase(specifier, pattern) for pattern in root.get("externals", [])):
                    fail(f"runtime builtin is not declared external: {specifier}")
                continue
            if specifier.startswith(("/", "#")) or ":" in specifier and not specifier.startswith(("npm:", "jsr:")):
                fail(f"non-relocatable or unmapped import: {specifier}")
            package, subpath, authored_version, registry = package_specifier(specifier)
            bare = package + ("/" + subpath if subpath else "")
            if package == root["import_name"]:
                if bare not in all_exports:
                    fail(f"unknown self export: {specifier}")
                if format == "deno":
                    imports[specifier] = "./" + module_url(all_exports[bare][1])
                elif registry:
                    rewrites[specifier] = bare
                continue
            if package not in releases:
                fail(f"imported package has no release mapping: {package}")
            if package in names and package not in direct:
                fail(f"imported first-party package is not a declared direct dependency: {package}")
            if package in names and bare not in all_exports:
                fail(f"unknown dependency export: {bare}")
            used.add(package)
            value = releases[package]
            if format == "npm":
                if registry == "jsr":
                    fail("jsr: imports cannot be emitted in an npm distribution")
                if authored_version is not None and authored_version != value:
                    fail(f"authored import version conflicts with release mapping: {specifier}")
                if registry:
                    rewrites[specifier] = bare
            elif release_kinds[package] == "relative":
                if package not in names:
                    fail(f"relative Deno release mapping requires a known first-party export: {package}")
                imports[specifier] = value + module_url(all_exports[bare][1])
            else:
                if authored_version is not None and release_kinds[package] == "registry":
                    mapped_package, _, mapped_version, mapped_registry = package_specifier(value.rstrip("/"))
                    if (mapped_package, mapped_version, mapped_registry) != (package, authored_version, registry):
                        fail(f"authored import version conflicts with release mapping: {specifier}")
                imports[specifier] = value.rstrip("/") + ("/" + subpath if subpath else "")
        modules.append({"input": str(source), "output": str(output), "rewrites": rewrites})
    unused = releases.keys() - used
    if unused:
        fail(f"unused release dependencies: {sorted(unused)}")
    if format == "deno":
        for name in direct:
            value = releases[name]
            for specifier in names[name]["exports"]:
                subpath = specifier[len(name):]
                imports[specifier] = (value + module_url(all_exports[specifier][1]) if release_kinds[name] == "relative"
                                      else value.rstrip("/") + subpath)
    if out_dir.is_symlink() or any(p.is_symlink() for p in out_dir.parents):
        fail("output directory must not contain symlinks")
    if out_dir.exists() and any(out_dir.iterdir()):
        fail("output directory must be empty")
    out_dir.mkdir(parents=True, exist_ok=True)
    declarations = manifest["declarations"]
    occupied = set(own.values())
    if format == "npm":
        for source, output in own.items():
            if source.suffix not in CODE_EXTENSIONS or is_declaration(source):
                continue
            additions = [PurePosixPath(str(output) + ".map")]
            if declarations and source.suffix in {".ts", ".mts"}:
                additions.append(declaration_path(output))
            for extra in additions:
                if extra in occupied:
                    fail(f"colliding generated package artifact: {extra}")
                occupied.add(extra)
    executable_modules = [m for m in modules if not is_declaration(Path(m["input"]))]
    def authored(module):
        source = Path(module["input"])
        content = source.read_bytes()
        # Native inspection spans are UTF-8 byte offsets, not Unicode indices.
        patches = [(f["start"], f["end"], json.dumps(module["rewrites"][f["specifier"]], ensure_ascii=False).encode())
                   for f in by_source[source]["imports"] if f["specifier"] in module["rewrites"]]
        for start, end, replacement in sorted(set(patches), reverse=True):
            content = content[:start] + replacement + content[end:]
        return content

    if format == "npm":
        with tempfile.TemporaryDirectory(prefix="js-emit-") as temporary:
            emit_manifest = Path(temporary) / "manifest.json"
            emit_manifest.write_text(json.dumps({"modules": executable_modules, "declarations": declarations}), encoding="utf-8")
            native_json(native, "emit", "--manifest", emit_manifest, "--out-dir", out_dir)
    else:
        for module in modules:
            # Preserve bytes and any authored source map exactly; registry
            # identities are rebased in deno.json, never in source literals.
            write_bytes(out_dir, module["output"], Path(module["input"]).read_bytes())
    for source, output in own.items():
        if source.suffix not in CODE_EXTENSIONS:
            write_bytes(out_dir, output, source.read_bytes())
        elif format == "npm" and is_declaration(source):
            module = next(m for m in modules if m["input"] == str(source))
            write_bytes(out_dir, output, authored(module))
    if format == "npm":
        export_metadata = {}
        for key, output in exports.items():
            source = next(p for p, target in own.items() if target == output)
            types = declaration_path(output)
            if declarations and source.suffix in {".ts", ".mts"}:
                if not out_dir.joinpath(*types.parts).is_file():
                    fail(f"missing emitted declaration for {key}")
                export_metadata[key] = {"types": "./" + module_url(types), "import": "./" + module_url(output), "default": "./" + module_url(output)}
            else:
                export_metadata[key] = "./" + module_url(output)
        metadata = {"name": root["import_name"], "version": version, "type": "module", "exports": export_metadata,
                    "dependencies": releases, "license": manifest["license"]}
        metadata_name = "package.json"
    else:
        metadata = {"name": root["import_name"], "version": version,
                    "exports": {key: "./" + module_url(path) for key, path in exports.items()}, "imports": imports, "license": manifest["license"]}
        metadata_name = "deno.json"
    write_bytes(out_dir, metadata_name, (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode())
    if archive is not None:
        if archive == out_dir or out_dir in archive.parents:
            fail("tarball must be outside the package directory")
        tarball(out_dir, archive)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--native", required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--tarball", type=Path)
    args = parser.parse_args()
    try:
        build(json.loads(args.manifest.read_text(encoding="utf-8")), args.native, args.out_dir, args.tarball)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        parser.exit(1, f"js.package: {detail}\n")


if __name__ == "__main__":
    main()
