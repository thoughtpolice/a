#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Driver for celld TypeScript units: libraries, tests and workers.

Every build action and every editor fragment `celld-project` merges go
through this file, so the build and the language server resolve imports the
same way. A unit is described by a JSON manifest that the Buck rules write;
every path in it is relative to the project root, which is the working
directory of all actions.

Subcommands:
  config    write the Deno config (import map, compiler options) for one unit
  check     check the unit's import graph, then `deno check` its sources
  bundle    bundle a checked worker into one ESM file
  stamp     print a check stamp (the body of a `[check]` test)
  fragment  write the unit's editor fragment for `celld-project`

The import-graph check fails when a module
  - imports a specifier that no direct dependency of its unit exports,
  - reaches a file outside its own unit's srcs through a relative import,
  - is not declared in the srcs of any unit in the closure,
  - uses a remote, `npm:`, `jsr:` or `node:` import, or any builtin other
    than `cloudflare:*`.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

COMPILER_OPTIONS = {
    "lib": ["deno.ns", "dom", "dom.iterable", "esnext"],
    "strict": True,
}

# Modules the fake test runtime stands in for.
FAKE_RUNTIME_MODULES = ["cloudflare:workers"]


class GraphError(Exception):
    pass


def load_manifest(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def norm(path: str) -> str:
    return os.path.normpath(path)


def units(manifest: dict) -> list[dict]:
    """The unit itself first, then every library of its closure, once each."""
    seen = set()
    result = []
    for unit in [manifest["unit"]] + manifest["libraries"]:
        if unit["label"] in seen:
            continue
        seen.add(unit["label"])
        result.append(unit)
    return result


def import_map(libraries: list[dict]) -> dict[str, tuple[str, str]]:
    """Maps each exported specifier to (file, owning label)."""
    result: dict[str, tuple[str, str]] = {}
    for library in libraries:
        for spec, path in library["exports"].items():
            previous = result.get(spec)
            if previous and previous[1] != library["label"]:
                raise GraphError(
                    "specifier {} is claimed by both {} and {}".format(spec, previous[1], library["label"])
                )
            result[spec] = (norm(path), library["label"])
    return result


def relative_to(path: str, directory: str) -> str:
    rel = os.path.relpath(path, directory)
    if not rel.startswith("."):
        rel = "./" + rel
    return rel


def deno_config(manifests: list[dict], directory: str, fake_runtime: bool) -> dict:
    """A Deno config whose paths are relative to `directory`."""
    specs: dict[str, tuple[str, str]] = {}
    types = set()
    fakes = set()
    for manifest in manifests:
        for spec, entry in import_map(manifest["libraries"]).items():
            previous = specs.get(spec)
            if previous and previous != entry:
                raise GraphError("specifier {} maps to both {} ({}) and {} ({})".format(spec, previous[0], previous[1], entry[0], entry[1]))
            specs[spec] = entry
        types.add(norm(manifest["types"]))
        if fake_runtime and manifest.get("testing"):
            fakes.add(norm(manifest["testing"]))
    imports = {spec: relative_to(path, directory) for spec, (path, _) in sorted(specs.items())}
    for fake in sorted(fakes):
        for module in FAKE_RUNTIME_MODULES:
            imports[module] = relative_to(fake, directory)
    options = dict(COMPILER_OPTIONS)
    options["types"] = [relative_to(t, directory) for t in sorted(types)]
    return {
        "lock": False,
        "nodeModulesDir": "none",
        "compilerOptions": options,
        "imports": imports,
    }


def cmd_config(args: argparse.Namespace) -> None:
    manifest = load_manifest(args.manifest)
    # Paths are relative to the config and computed from the working directory
    # (the project root), so the config is the same on every machine.
    try:
        config = deno_config([manifest], os.path.dirname(args.out) or ".", args.fake_runtime)
    except GraphError as e:
        print("celld: {}".format(e), file=sys.stderr)
        sys.exit(1)
    with open(args.out, "w") as f:
        json.dump(config, f, indent=2, sort_keys=True)
        f.write("\n")


def run_deno(deno: list[str], argv: list[str], capture: bool = False) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["DENO_NO_UPDATE_CHECK"] = "1"
    env.setdefault("NO_COLOR", "1")
    return subprocess.run(deno + argv, env=env, capture_output=capture, text=True)


def module_graph(deno: list[str], config: str, roots: list[str]) -> dict:
    """`deno info --json` over every root at once, offline."""
    with tempfile.TemporaryDirectory(prefix="celldc-") as tmp:
        entry = os.path.join(tmp, "roots.ts")
        with open(entry, "w") as f:
            for root in roots:
                f.write('import "file://{}";\n'.format(os.path.abspath(root)))
        result = run_deno(
            deno,
            ["info", "--json", "--no-remote", "--no-npm", "--config", config, entry],
            capture=True,
        )
        if result.returncode != 0:
            raise GraphError("deno info failed:\n" + result.stderr)
        graph = json.loads(result.stdout)
        graph["entry"] = "file://" + entry
        return graph


def local_path(specifier: str) -> str | None:
    if not specifier.startswith("file://"):
        return None
    return norm(os.path.relpath(specifier[len("file://") :]))


def check_graph(manifest: dict, deno: list[str], config: str) -> list[str]:
    """Checks the unit's import graph; returns the unit's roots."""
    all_units = units(manifest)
    specs = import_map(manifest["libraries"])
    owner: dict[str, str] = {}
    srcs: dict[str, set[str]] = {}
    direct: dict[str, set[str]] = {}
    for unit in all_units:
        files = {norm(p) for p in unit["srcs"]}
        srcs[unit["label"]] = files
        direct[unit["label"]] = set(unit["deps"])
        for path in files:
            if path in owner and owner[path] != unit["label"]:
                raise GraphError("{} is in the srcs of both {} and {}".format(path, owner[path], unit["label"]))
            owner[path] = unit["label"]
    toolchain_files = {norm(manifest["types"])}
    if manifest.get("testing"):
        toolchain_files.add(norm(manifest["testing"]))

    roots = sorted(norm(p) for p in manifest["unit"]["srcs"])
    graph = module_graph(deno, config, roots)
    errors = []
    for module in graph["modules"]:
        specifier = module["specifier"]
        if specifier == graph["entry"]:
            continue
        if "error" in module:
            errors.append(module["error"])
            continue
        kind = module.get("kind")
        if kind == "external":
            if not specifier.startswith("cloudflare:"):
                errors.append("{}: only cloudflare:* builtins are allowed".format(specifier))
            continue
        if kind not in ("esm", "asserted"):
            errors.append("{}: unsupported {} module; celld code is first party only".format(specifier, kind))
            continue
        path = local_path(specifier)
        if path is None:
            errors.append("{}: remote modules are not allowed".format(specifier))
            continue
        if path in toolchain_files:
            continue
        label = owner.get(path)
        if label is None:
            errors.append("{}: not in the srcs of any target in the closure of {}".format(path, manifest["unit"]["label"]))
            continue
        for dependency in module.get("dependencies", []):
            raw = dependency["specifier"]
            for resolution in (dependency.get("code"), dependency.get("type")):
                if resolution is None:
                    continue
                where = "{}:{}".format(path, resolution.get("span", {}).get("start", {}).get("line", 0) + 1)
                if "error" in resolution:
                    errors.append("{}: {}".format(where, resolution["error"]))
                    continue
                if raw.startswith("cloudflare:"):
                    continue
                if raw.startswith(("./", "../", "/", "file:")):
                    target = local_path(resolution["specifier"])
                    if target not in srcs[label]:
                        errors.append(
                            '{}: relative import "{}" leaves the srcs of {}; import another target through its exported specifier'.format(
                                where, raw, label
                            )
                        )
                    continue
                if raw in specs:
                    provider = specs[raw][1]
                    if provider not in direct[label]:
                        errors.append(
                            '{}: "{}" comes from {}, which is not a direct dependency of {}'.format(where, raw, provider, label)
                        )
                    continue
                errors.append('{}: unsupported import "{}"; only relative paths, dependency exports and cloudflare:* are allowed'.format(where, raw))
    if errors:
        raise GraphError("\n".join(sorted(set(errors))))
    return roots


def cmd_check(args: argparse.Namespace) -> None:
    manifest = load_manifest(args.manifest)
    deno = [args.deno]
    try:
        roots = check_graph(manifest, deno, args.config)
    except GraphError as e:
        print("celld: import graph check failed for {}:\n{}".format(manifest["unit"]["label"], e), file=sys.stderr)
        sys.exit(1)
    result = run_deno(deno, ["check", "--quiet", "--config", args.config] + roots)
    if result.returncode != 0:
        print("celld: type check failed for {}".format(manifest["unit"]["label"]), file=sys.stderr)
        sys.exit(result.returncode)
    with open(args.stamp, "w") as f:
        f.write("checked {}\n".format(manifest["unit"]["label"]))
        for root in roots:
            f.write("  {}\n".format(root))


def cmd_bundle(args: argparse.Namespace) -> None:
    argv = [
        "bundle",
        "--quiet",
        "--config",
        args.config,
        "--external",
        "cloudflare:*",
        "--format",
        "esm",
        "--platform",
        "browser",
    ]
    if args.minify:
        argv.append("--minify")
    argv += [args.main, "--output", args.out]
    result = run_deno([args.deno], argv)
    sys.exit(result.returncode)


def cmd_stamp(args: argparse.Namespace) -> None:
    with open(args.stamp) as f:
        sys.stdout.write(f.read())


def editor_fragment(manifest: dict) -> dict:
    """What `celld-project` needs to serve one unit in an editor.

    `config` is the unit's Deno config with project-relative paths (each
    starts with "./"); `srcs` are the unit's own files and `files` every file
    of its closure. The fake runtime is left out: celld.d.ts declares
    "cloudflare:workers" for the editor.
    """
    return {
        "config": deno_config([manifest], ".", fake_runtime=False),
        "files": sorted({norm(p) for unit in units(manifest) for p in unit["srcs"]}),
        "label": manifest["unit"]["label"],
        "srcs": sorted(norm(p) for p in manifest["unit"]["srcs"]),
    }


def cmd_fragment(args: argparse.Namespace) -> None:
    try:
        fragment = editor_fragment(load_manifest(args.manifest))
    except GraphError as e:
        print("celld: {}".format(e), file=sys.stderr)
        sys.exit(1)
    with open(args.out, "w") as f:
        json.dump(fragment, f, indent=2, sort_keys=True)
        f.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("config")
    p.add_argument("--manifest", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--fake-runtime", action="store_true")
    p.set_defaults(fn=cmd_config)

    p = sub.add_parser("check")
    p.add_argument("--manifest", required=True)
    p.add_argument("--config", required=True)
    p.add_argument("--deno", required=True)
    p.add_argument("--stamp", required=True)
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser("bundle")
    p.add_argument("--config", required=True)
    p.add_argument("--deno", required=True)
    p.add_argument("--main", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--minify", action="store_true")
    p.set_defaults(fn=cmd_bundle)

    p = sub.add_parser("stamp")
    p.add_argument("stamp")
    p.set_defaults(fn=cmd_stamp)

    p = sub.add_parser("fragment")
    p.add_argument("--manifest", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_fragment)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
