# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:toolchain.bzl", "DenoToolchain")
load("@toolchains//web:toolchain.bzl", "WebToolchain", "web_toolchain_attr")
load(":providers.bzl", "JsLibraryInfo", "JsLibraryTSet", "record_json")

def target_label(label) -> str:
    return str(label.raw_target())

def specifiers(label: str, import_name: str, exports: dict[str, Artifact]) -> dict[str, Artifact]:
    if not import_name or import_name.startswith(".") or ":" in import_name or import_name.endswith("/"):
        fail("{}: import_name {} must be a bare specifier such as @web/core".format(label, repr(import_name)))
    result = {}
    for subpath, src in exports.items():
        if subpath == ".":
            result[import_name] = src
        elif subpath.startswith("./") and len(subpath) > 2:
            result[import_name + subpath[1:]] = src
        else:
            fail("{}: export key {} must be \".\" or start with \"./\"".format(label, repr(subpath)))
    return result

def wasm_modules(label: str, import_name: str, wasm: dict[str, Artifact]) -> dict[str, (str, Artifact)]:
    """Each wasm specifier mapped to (module file name, file). The module
    name is the specifier spelled as a file name, `@app/core/wasm` becoming
    `app_core_wasm.wasm`; a bundle imports it as `./<module>`."""
    result = {}
    for specifier, src in specifiers(label, import_name, wasm).items():
        module = "".join([c if c.isalnum() or c in "-." else "_" for c in specifier.removeprefix("@").elems()])
        result[specifier] = (module + ".wasm", src)
    return result

def merge_wasm(label: str, maps: list[dict[str, Artifact]]) -> dict[str, Artifact]:
    """The union of wasm module maps; two files may not share a name, since
    both would be `./<module>` beside the bundle."""
    result = {}
    for modules in maps:
        for module, artifact in modules.items():
            previous = result.get(module)
            if previous != None and previous != artifact:
                fail("{}: two wasm modules of the closure are named {}; give one of their libraries another import_name".format(label, module))
            result[module] = artifact
    return result

def dedupe(artifacts: list[Artifact]) -> list[Artifact]:
    return {artifact: True for artifact in artifacts}.keys()

# Extensions of code files, the rest (JSON, say) being modules only other
# modules import; webc.py has the same list.
_CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

def is_code(path: str) -> bool:
    for suffix in _CODE_EXTENSIONS:
        if path.endswith(suffix):
            return True
    return False

def uses_svelte(record: struct, closure) -> bool:
    if record.generated or record.svelte_runtime:
        return True
    for dependency in closure.traverse():
        if dependency.generated or dependency.svelte_runtime:
            return True
    return False

def make_unit(
        ctx: AnalysisContext,
        srcs: list[Artifact],
        exports: dict[str, Artifact],
        import_name: str | None,
        fake_runtime: bool,
        wasm: dict[str, (str, Artifact)] = {},
        generated = None) -> struct:
    """The actions every unit shares: manifest, Deno config, graph and type
    check, and lint. Returns them with the unit's own library record."""
    native_toolchain = ctx.attrs._web_toolchain[WebToolchain]
    toolchain = struct(
        native = native_toolchain.native,
        driver = native_toolchain.driver,
        svelte_runtime = native_toolchain.svelte_runtime,
        deno = ctx.attrs._deno_toolchain[DenoToolchain].deno,
    )
    label = target_label(ctx.label)
    children = [dep[JsLibraryInfo].tset for dep in ctx.attrs.deps]
    closure = ctx.actions.tset(JsLibraryTSet, children = children)
    wasm_modules = merge_wasm(label, [dep[JsLibraryInfo].wasm for dep in ctx.attrs.deps] + [
        {module: artifact for module, artifact in wasm.values()},
    ])

    # Specifier collisions in the closure are the driver's to report (its
    # `config` step fails), so analysis stays linear in the closure.
    record = struct(
        deps = [dep[JsLibraryInfo].label for dep in ctx.attrs.deps],
        exports = exports,
        externals = ctx.attrs.externals,
        import_name = import_name,
        label = label,
        srcs = srcs,
        wasm = wasm,
        generated = generated,
        svelte_runtime = ctx.attrs.svelte_runtime or generated != None,
    )
    has_svelte = uses_svelte(record, closure)
    runtime_inputs = toolchain.svelte_runtime.values() if has_svelte else []
    manifest = ctx.actions.write_json("web/manifest.json", {
        "libraries": closure.project_as_json("json"),
        "platform": {
            "name": ctx.attrs.platform_name,
            "types": ctx.attrs.types,
            "modules": ctx.attrs.runtime_modules,
            "externals": ctx.attrs.externals,
            "compiler_libs": ctx.attrs.lib,
            "deno_lint": ctx.attrs.deno_lint,
            "check_js": ctx.attrs.check_js,
            "bundle_platform": ctx.attrs.bundle_platform,
            "server_conditions": ctx.attrs.server_conditions,
        },
        "runtime": toolchain.svelte_runtime if has_svelte else {},
        "unit": record_json(record),
    })

    # A wasm specifier maps to a shim the config step writes: Deno would
    # otherwise link a `.wasm` import as an ES module and type it by its
    # exports, where the target runtime gives the compiled `WebAssembly.Module`. The
    # shims share the config's directory, since each output of an action
    # gets its own content-hashed directory and the config points at them.
    if wasm_modules:
        config_dir = ctx.actions.declare_output("web/config", dir = True)
        config = config_dir.project("deno.json")
        shims = config_dir.project("wasm")
        out = ["--out-dir", config_dir.as_output()]
    else:
        config = ctx.actions.declare_output("web/deno.json")
        shims = None
        out = ["--out", config.as_output()]
    ctx.actions.run(
        cmd_args(
            toolchain.driver,
            "config",
            "--manifest",
            manifest,
            out,
            ["--fake-runtime"] if fake_runtime else [],
            hidden = runtime_inputs,
        ),
        category = "web_config",
    )

    # The shims import the modules by path, so the unit's own modules are
    # inputs too (the closure's come with its sources).
    own_wasm = [artifact for _, artifact in wasm.values()]
    inputs = [srcs, own_wasm, closure.project_as_args("srcs"), ctx.attrs.types, ctx.attrs.runtime_modules.values(), runtime_inputs] + ([generated.directory] if generated else []) + ([shims] if shims else [])
    stamp = ctx.actions.declare_output("web/check.stamp")
    ctx.actions.run(
        cmd_args(
            toolchain.driver,
            "check",
            "--manifest",
            manifest,
            "--config",
            config,
            "--deno",
            toolchain.deno,
            "--native",
            toolchain.native,
            "--stamp",
            stamp.as_output(),
            ["--wasm-dir", shims] if shims else [],
            hidden = inputs,
        ),
        category = "web_check",
        allow_cache_upload = True,
    )

    # Editor fragments share the checked import map and carry generated inputs.
    fragment = ctx.actions.declare_output("web/editor.json")
    ctx.actions.run(
        cmd_args(
            toolchain.driver,
            "fragment",
            "--manifest",
            manifest,
            "--out",
            fragment.as_output(),
            ["--wasm-dir", shims] if shims else [],
            hidden = runtime_inputs,
        ),
        category = "web_fragment",
    )

    # Quality always sees authored files, never compiler projections.
    lint = cmd_args(
        toolchain.driver,
        "lint",
        "--manifest",
        manifest,
        ["--config", config, "--deno", toolchain.deno] if ctx.attrs.deno_lint else [],
        "--native",
        toolchain.native,
        srcs,
    )
    formatter = cmd_args(toolchain.driver, "format", "--native", toolchain.native, srcs)
    env = {"DENO_NO_UPDATE_CHECK": "1"}
    sub_targets = {
        "check": [
            DefaultInfo(default_output = stamp),
            ExternalRunnerTestInfo(
                type = "custom",
                command = [cmd_args(toolchain.driver, "stamp", stamp)],
            ),
        ],
        "config": [DefaultInfo(default_output = config)],
        "ide": [DefaultInfo(default_output = fragment, other_outputs = [cmd_args(inputs)])],
        "lint": [
            DefaultInfo(),
            ExternalRunnerTestInfo(type = "custom", command = [lint], env = env),
        ],
        "format": [
            DefaultInfo(),
            RunInfo(args = formatter),
            ExternalRunnerTestInfo(type = "custom", command = [cmd_args(formatter, "--check")], env = env),
        ],
    }
    if generated:
        sub_targets["generated"] = [DefaultInfo(default_output = generated.directory)]
    return struct(
        closure = closure,
        children = children,
        config = config,
        env = env,
        inputs = inputs,
        manifest = manifest,
        record = record,
        stamp = stamp,
        sub_targets = sub_targets,
        toolchain = toolchain,
        wasm_modules = wasm_modules,
    )

UNIT_ATTRS = {
    "deps": attrs.list(attrs.dep(providers = [JsLibraryInfo]), default = []),
    "srcs": attrs.list(attrs.source(), default = []),
    "svelte_runtime": attrs.bool(default = False),
    "types": attrs.list(attrs.source(), default = []),
    "runtime_modules": attrs.dict(attrs.string(), attrs.source(), default = {}),
    "externals": attrs.list(attrs.string(), default = []),
    "lib": attrs.list(attrs.string(), default = ["dom", "dom.iterable", "esnext"]),
    "deno_lint": attrs.bool(default = False),
    "check_js": attrs.bool(default = False),
    "platform_name": attrs.string(default = "web"),
    "bundle_platform": attrs.enum(["browser", "deno"], default = "browser"),
    "server_conditions": attrs.list(attrs.string(), default = ["default"]),
    "_web_toolchain": web_toolchain_attr(),
    "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
}

def make_library(ctx: AnalysisContext, generated = None) -> list[Provider]:
    label = target_label(ctx.label)
    exports = specifiers(label, ctx.attrs.import_name, ctx.attrs.exports)
    srcs = dedupe(ctx.attrs.srcs + ctx.attrs.exports.values())
    wasm = wasm_modules(label, ctx.attrs.import_name, ctx.attrs.wasm)
    for specifier in wasm:
        if specifier in exports:
            fail("{}: {} is both an export and a wasm module".format(label, specifier))
    unit = make_unit(ctx, srcs, exports, ctx.attrs.import_name, False, wasm, generated)
    tset = ctx.actions.tset(JsLibraryTSet, value = unit.record, children = unit.children)
    return [
        DefaultInfo(default_output = unit.stamp, sub_targets = unit.sub_targets),
        JsLibraryInfo(
            import_name = ctx.attrs.import_name,
            label = unit.record.label,
            tset = tset,
            wasm = unit.wasm_modules,
        ),
    ]

LIBRARY_ATTRS = UNIT_ATTRS | {
    "exports": attrs.dict(attrs.string(), attrs.source()),
    "import_name": attrs.string(),
    # Subpaths whose default export is a compiled WebAssembly.Module.
    "wasm": attrs.dict(attrs.string(), attrs.source(), default = {}),
}

def with_tests(name: str, kwargs: dict[str, typing.Any], subtargets: list[str]) -> dict[str, typing.Any]:
    tests = list(kwargs.pop("tests", []))
    for sub in subtargets:
        test = ":{}[{}]".format(name, sub)
        if test not in tests:
            tests.append(test)
    kwargs["tests"] = tests
    return kwargs
