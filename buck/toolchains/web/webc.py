#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Driver for runtime-neutral TypeScript units, with Deno as the build backend.

Every build action and editor fragment goes through this file, so builds and
language servers resolve imports the same way. Buck writes a JSON manifest;
its paths are relative to the project root, the working directory of actions.
The root platform profile supplies ambient types, optional fake module
replacements, external patterns, compiler libs and the bundle platform.

Subcommands:
  config    write the Deno config (import map, compiler options) for one unit
  check     check the unit's import graph, then `deno check` its sources
  bundle    bundle a checked server or browser entry into one ESM file
  assets    bundle a browser entry and package its reachable component CSS
  stamp     print a check stamp (the body of a `[check]` test)
  lint      native authored-source lint, optionally with Deno's lint policy
  format    native authored-source formatting (check or explicit write)
  fragment  write the unit's editor fragment

The import-graph check rejects undeclared dependency exports, relative imports
outside a unit's srcs, undeclared files and imports not supplied by the profile.
External patterns permit target-runtime imports in server graphs; browser value
graphs reject them. Type-only browser imports do not become runtime edges.

A library's wasm specifier maps to a shim exporting a compiled
WebAssembly.Module. Under Deno (check, test, editor) the shim uses a source-phase
import typed by an adjacent declaration. In a bundle it imports an external
`./<module>.wasm`, which the target runtime loads beside the output JavaScript.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

import svelte
import assets
import quality
import imports as import_graph

COMPILER_OPTIONS = {"strict": True}

# Sources that are code: roots of `deno check`, `deno test` and `deno lint`.
# Anything else in srcs (JSON, say) is a module only other modules import.
CODE_EXTENSIONS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")


GraphError = import_graph.GraphError


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
    """Maps each exported specifier to (file, owning label), and each wasm
    specifier to (wasm file, owning label).

    This is the one place a closure's specifiers are checked: two libraries
    of a closure may not export the same specifier.
    """
    result: dict[str, tuple[str, str]] = {}
    for library in libraries:
        entries = list(library["exports"].items())
        entries += [(spec, wasm["path"]) for spec, wasm in library.get("wasm", {}).items()]
        for spec, path in entries:
            previous = result.get(spec)
            if previous and previous[1] != library["label"]:
                raise GraphError(
                    "specifier {} is claimed by both {} and {}; give one of them another import_name "
                    "or drop one from the dependencies".format(spec, previous[1], library["label"])
                )
            result[spec] = (norm(path), library["label"])
    return result


def closure_specifiers(manifest: dict) -> dict[str, tuple[str, str]]:
    """`import_map` over the closure plus the unit's own wasm specifiers,
    which it imports by name."""
    unit = manifest["unit"]
    own = {"exports": {}, "label": unit["label"], "wasm": unit.get("wasm", {})}
    return import_map(manifest["libraries"] + [own])


def wasm_modules(manifest: dict) -> dict[str, dict]:
    """Each wasm specifier of the closure, the unit's own included (a
    library imports its own module by name), mapped to its module name and
    file."""
    return {
        spec: {"module": wasm["module"], "path": norm(wasm["path"])}
        for unit in units(manifest)
        for spec, wasm in unit.get("wasm", {}).items()
    }


# The type of every wasm shim's default export.
WASM_DECLARATION = """\
declare const module: WebAssembly.Module;
export default module;
"""


def write_wasm_shims(manifest: dict, directory: str, runtime: bool) -> None:
    """Writes `<module>.js` (and, for Deno, its declaration) per wasm module.

    For Deno the shim is a source-phase import, which yields the compiled
    module without linking the wasm's own imports; `@ts-self-types` keeps
    TypeScript from parsing syntax it does not know. For a bundle the shim
    imports the module by its file name for the target runtime to load.
    """
    os.makedirs(directory, exist_ok=True)
    for wasm in wasm_modules(manifest).values():
        module = wasm["module"]
        if runtime:
            text = "import m from {};\nexport default m;\n".format(json.dumps("./" + module))
        else:
            with open(os.path.join(directory, module + ".d.ts"), "w") as f:
                f.write(WASM_DECLARATION)
            text = '// @ts-self-types="./{}.d.ts"\nimport source m from {};\nexport default m;\n'.format(
                module, json.dumps(relative_to(wasm["path"], directory))
            )
        with open(os.path.join(directory, module + ".js"), "w") as f:
            f.write(text)


def relative_to(path: str, directory: str) -> str:
    """`path` relative to `directory`, spelled as Deno wants a relative
    path in a config: starting with "./" or "../" (".dir/x.ts" would be a
    bare specifier)."""
    rel = os.path.relpath(path, directory)
    if rel == ".." or rel.startswith("../"):
        return rel
    return "./" + rel


def fake_modules(manifest: dict) -> dict[str, str]:
    """Each module the fake runtime replaces, mapped to its fake's path."""
    return {module: norm(path) for module, path in import_graph.platform(manifest)["modules"].items()}


def is_code(path: str) -> bool:
    return path.endswith(CODE_EXTENSIONS)


def deno_config(manifest: dict, directory: str, fake_runtime: bool, wasm_dir: str | None = None) -> dict:
    """A Deno config whose paths are relative to `directory`; wasm
    specifiers map to the shims in `wasm_dir`."""
    imports = {spec: relative_to(path, directory) for spec, (path, _) in sorted(closure_specifiers(manifest).items())}
    additions = {**svelte.runtime_imports(manifest), **svelte.source_aliases(manifest)}
    for specifier, path in additions.items():
        if specifier in imports:
            raise GraphError("reserved Svelte runtime specifier {} is exported by a dependency".format(specifier))
        imports[specifier] = relative_to(path, directory)
    profile = import_graph.platform(manifest)
    import_graph.check_external_bindings(imports, profile)
    wasm = wasm_modules(manifest)
    if wasm and wasm_dir is None:
        raise GraphError("the closure has wasm modules but no --wasm-dir was given")
    for spec, module in wasm.items():
        imports[spec] = relative_to(os.path.join(wasm_dir, module["module"] + ".js"), directory)
    if fake_runtime:
        for module, path in sorted(fake_modules(manifest).items()):
            if module in imports:
                raise GraphError("reserved platform module specifier {} is exported by a dependency or runtime".format(module))
            imports[module] = relative_to(path, directory)
    options = dict(COMPILER_OPTIONS)
    options["lib"] = list(profile["compiler_libs"])
    options["checkJs"] = profile["check_js"]
    options["types"] = [relative_to(norm(path), directory) for path in profile["types"]]
    options["types"].extend(relative_to(path, directory) for path in svelte.runtime_types(manifest))
    if svelte.enabled(manifest):
        # Classic JSX avoids Deno's implicit react/jsx-runtime graph edge.
        # Projections use Svelte's official declaration helper namespace.
        options["jsx"] = "react"
        options["jsxFactory"] = "svelteHTML.createElement"
    return {
        "lock": False,
        "nodeModulesDir": "none",
        "compilerOptions": options,
        "imports": imports,
    }


def cmd_config(args: argparse.Namespace) -> None:
    manifest = svelte.manifest_view(load_manifest(args.manifest), args.view)
    # Paths are relative to the config and computed from the working directory
    # (the project root), so the config is the same on every machine.
    out, wasm_dir = args.out, None
    if args.out_dir:
        # The config and the wasm shims it maps, in one output directory.
        out, wasm_dir = os.path.join(args.out_dir, "deno.json"), os.path.join(args.out_dir, "wasm")
        os.makedirs(args.out_dir, exist_ok=True)
    try:
        config = deno_config(manifest, os.path.dirname(out) or ".", args.fake_runtime, wasm_dir)
    except GraphError as e:
        print("web: {}".format(e), file=sys.stderr)
        sys.exit(1)
    if wasm_dir:
        write_wasm_shims(manifest, wasm_dir, runtime=False)
    with open(out, "w") as f:
        json.dump(config, f, indent=2, sort_keys=True)
        f.write("\n")


def run_deno(deno: list[str], argv: list[str], capture: bool = False) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["DENO_NO_UPDATE_CHECK"] = "1"
    env.setdefault("NO_COLOR", "1")
    return subprocess.run(deno + argv, env=env, capture_output=capture, text=True)

def cmd_check(args: argparse.Namespace) -> None:
    manifest = svelte.manifest_view(load_manifest(args.manifest))
    deno = [args.deno]
    try:
        roots = import_graph.check_graph(manifest, [args.native], args.wasm_dir)
    except GraphError as e:
        print("web: import graph check failed for {}:\n{}".format(manifest["unit"]["label"], e), file=sys.stderr)
        sys.exit(1)
    result = run_deno(deno, ["check", "--quiet", "--no-remote", "--no-npm", "--config", args.config] + roots, capture=True) if roots else None
    if result is not None:
        sys.stdout.write(result.stdout)
        sys.stderr.write(svelte.rewrite_diagnostics(manifest, result.stderr))
    if result is not None and result.returncode != 0:
        print("web: type check failed for {}".format(manifest["unit"]["label"]), file=sys.stderr)
        sys.exit(result.returncode)
    with open(args.stamp, "w") as f:
        f.write("checked {}\n".format(manifest["unit"]["label"]))
        for root in roots:
            f.write("  {}\n".format(root))


def bundle(args: argparse.Namespace) -> tuple[int, dict, set[str]]:
    manifest = svelte.manifest_view(load_manifest(args.manifest), args.view)
    profile = import_graph.platform(manifest)
    if profile["bundle_platform"] not in ("browser", "deno"):
        raise GraphError("unsupported bundle platform {}".format(profile["bundle_platform"]))
    with tempfile.TemporaryDirectory(prefix="webc-bundle-") as tmp:
        config = args.config
        if wasm_modules(manifest) or svelte.enabled(manifest):
            # The checked config's shims load the file under Deno; the
            # bundle's import the module the target runtime loads beside it. The
            # bundle names each shim's path in a comment, so the directory
            # is Buck's scratch directory rather than a random one.
            scratch = os.environ.get("BUCK_SCRATCH_PATH")
            if scratch:
                tmp = os.path.join(scratch, "web-bundle")
                shutil.rmtree(tmp, ignore_errors=True)
            shims = os.path.join(tmp, "wasm")
            write_wasm_shims(manifest, shims, runtime=True)
            config = os.path.join(tmp, "deno.json")
            with open(config, "w") as f:
                json.dump(deno_config(manifest, tmp, fake_runtime=False, wasm_dir=shims), f)
        reachable = import_graph.check_browser_graph(manifest, [args.native], args.main) if args.view == "client" else set()
        argv = [
            "bundle",
            "--quiet",
            "--no-remote",
            "--no-npm",
            "--config",
            config,
            "--external",
            "*.wasm",
        ]
        for pattern in profile["externals"]:
            argv += ["--external", pattern]
        # Deno accepts multiple values after --external. End that list with
        # another flag before the entry path, or the entry becomes external.
        argv += ["--format", "esm", "--platform", profile["bundle_platform"]]
        # Keep the intermediate beside the final output so relative authored
        # source-map URLs remain valid after native map composition.
        intermediate = args.out + ".unminified.js" if args.minify else args.out
        emit_map = args.minify or getattr(args, "sourcemap", False)
        if emit_map:
            argv.append("--sourcemap=external" if args.minify else "--sourcemap=linked")
        argv += [args.main, "--output", intermediate]
        try:
            result = run_deno([args.deno], argv)
            if not result.returncode and args.minify:
                result = subprocess.run([
                    args.native, "minify", "--input", intermediate,
                    "--output", args.out, "--input-map", intermediate + ".map",
                    "--output-map", args.out + ".map",
                ])
        finally:
            if args.minify:
                for path in (intermediate, intermediate + ".map"):
                    if os.path.exists(path):
                        os.remove(path)
    return result.returncode, manifest, reachable


def cmd_bundle(args: argparse.Namespace) -> None:
    try:
        status, _, _ = bundle(args)
    except GraphError as error:
        print("web: {}".format(error), file=sys.stderr)
        sys.exit(1)
    sys.exit(status)


def cmd_assets(args: argparse.Namespace) -> None:
    os.makedirs(args.out_dir, exist_ok=True)
    args.view, args.out, args.sourcemap = "client", os.path.join(args.out_dir, "app.js"), True
    try:
        status, manifest, reachable = bundle(args)
        if status:
            sys.exit(status)
        assets.write_styles(manifest, reachable, args.out_dir, args.styles)
    except GraphError as error:
        print("web: {}".format(error), file=sys.stderr)
        sys.exit(1)


def cmd_stamp(args: argparse.Namespace) -> None:
    with open(args.stamp) as f:
        sys.stdout.write(f.read())


def cmd_lint(args: argparse.Namespace) -> None:
    manifest = load_manifest(args.manifest) if args.manifest else {}
    deno_lint = args.deno_lint or import_graph.platform(manifest)["deno_lint"]
    try:
        status = quality.lint(args.native, args.deno, args.config, args.srcs, deno_lint=deno_lint)
    except ValueError as error:
        print("web: {}".format(error), file=sys.stderr)
        sys.exit(1)
    sys.exit(status)


def cmd_format(args: argparse.Namespace) -> None:
    sys.exit(quality.format(args.native, args.srcs, check=args.check, write=args.write))


def editor_fragment(manifest: dict, wasm_dir: str | None = None) -> dict:
    """An editor fragment for one unit.

    `config` uses project-relative paths (each starts with "./"); `srcs` are
    the unit's own files and `files` every file of its closure. Fake runtime
    replacements are omitted; configured ambient types describe the platform.
    """
    return {
        "config": deno_config(manifest, ".", fake_runtime=False, wasm_dir=wasm_dir),
        "files": sorted({norm(p) for unit in units(manifest) for p in unit["srcs"]}),
        "label": manifest["unit"]["label"],
        "srcs": sorted(norm(p) for p in manifest["unit"]["srcs"]),
    }


def cmd_fragment(args: argparse.Namespace) -> None:
    try:
        fragment = editor_fragment(svelte.manifest_view(load_manifest(args.manifest)), args.wasm_dir)
    except GraphError as e:
        print("web: {}".format(e), file=sys.stderr)
        sys.exit(1)
    with open(args.out, "w") as f:
        json.dump(fragment, f, indent=2, sort_keys=True)
        f.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("config")
    p.add_argument("--manifest", required=True)
    out = p.add_mutually_exclusive_group(required=True)
    out.add_argument("--out", help="the config file")
    out.add_argument("--out-dir", help="a directory for deno.json and the wasm/ shims")
    p.add_argument("--fake-runtime", action="store_true")
    p.add_argument("--view", choices=("check", "server", "client"), default="check")
    p.set_defaults(fn=cmd_config)

    p = sub.add_parser("check")
    p.add_argument("--manifest", required=True)
    p.add_argument("--config", required=True)
    p.add_argument("--deno", required=True)
    p.add_argument("--native", required=True)
    p.add_argument("--stamp", required=True)
    p.add_argument("--wasm-dir")
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser("bundle")
    p.add_argument("--manifest", required=True)
    p.add_argument("--config", required=True)
    p.add_argument("--deno", required=True)
    p.add_argument("--native", required=True)
    p.add_argument("--main", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--minify", action="store_true")
    p.add_argument("--view", choices=("server", "client"), default="server")
    p.set_defaults(fn=cmd_bundle)

    p = sub.add_parser("assets")
    p.add_argument("--manifest", required=True)
    p.add_argument("--config", required=True)
    p.add_argument("--deno", required=True)
    p.add_argument("--native", required=True)
    p.add_argument("--main", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--minify", action="store_true")
    p.add_argument("--style", dest="styles", action="append", default=[])
    p.set_defaults(fn=cmd_assets)

    p = sub.add_parser("stamp")
    p.add_argument("stamp")
    p.set_defaults(fn=cmd_stamp)

    p = sub.add_parser("lint")
    p.add_argument("--manifest", help="optional platform profile for lint policy")
    p.add_argument("--config", help="Deno config, required only with Deno lint")
    p.add_argument("--deno", help="Deno executable, required only with Deno lint")
    p.add_argument("--deno-lint", action="store_true", help="explicitly enable Deno's lint policy")
    p.add_argument("--native", required=True)
    p.add_argument("srcs", nargs="*")
    p.set_defaults(fn=cmd_lint)

    p = sub.add_parser("format")
    p.add_argument("--native", required=True)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    p.add_argument("srcs", nargs="*")
    p.set_defaults(fn=cmd_format)

    p = sub.add_parser("fragment")
    p.add_argument("--manifest", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--wasm-dir")
    p.set_defaults(fn=cmd_fragment)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
