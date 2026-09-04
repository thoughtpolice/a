# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Pinned celld executables, TypeScript units, and Worker packaging/run rules.

A CelldToolchain supplies the executable for the configured execution platform,
plus the Deno toolchain and the `celldc` driver that build TypeScript units.
`celld.library`, `celld.test` and `celld.worker` are those units: they declare
`deps` on libraries, and the driver generates their Deno configs, checks that
code imports only what it declares, and type-checks it. CelldProjectInfo
carries a self-contained, prebundled Worker directory; project rules do not
invoke a JavaScript bundler or require the Wrangler CLI.
"""

load("@prelude//:paths.bzl", "paths")
load("@toolchains//deno:defs.bzl", "DenoToolchain")

CelldToolchain = provider(
    doc = "The celld command and its downloadable artifacts for an execution platform.",
    fields = {
        "celld": provider_field(typing.Any),
        "celldc": provider_field(typing.Any),
        "default_info": provider_field(typing.Any),
        "deno": provider_field(typing.Any),
        "testing": provider_field(typing.Any),
        "types": provider_field(typing.Any),
    },
)

CelldProjectInfo = provider(
    doc = "A self-contained directory accepted by celld deploy.",
    fields = {"directory": provider_field(typing.Any)},
)

def _download_celld_impl(ctx: AnalysisContext) -> list[Provider]:
    archive = ctx.actions.declare_output("celld.gz")
    ctx.actions.download_file(
        archive.as_output(),
        "https://github.com/denoland/celld/releases/download/v{}/celld-{}.gz".format(ctx.attrs.version, ctx.attrs.triple),
        sha256 = ctx.attrs.sha256,
    )
    binary = ctx.actions.declare_output("celld")
    ctx.actions.run(
        ["bash", ctx.attrs._gunzip, archive, binary.as_output()],
        category = "celld_unpack",
    )
    return [
        DefaultInfo(
            default_output = binary,
            sub_targets = {"archive": [DefaultInfo(default_output = archive)]},
        ),
        RunInfo(args = cmd_args(binary)),
    ]

download_celld = rule(
    impl = _download_celld_impl,
    attrs = {
        "sha256": attrs.string(),
        "triple": attrs.string(),
        "version": attrs.string(),
        "_gunzip": attrs.source(default = "toolchains//celld:gunzip"),
    },
    doc = "Downloads and unpacks a checksum-verified upstream release for one triple.",
)

def _celld_toolchain_impl(ctx: AnalysisContext) -> list[Provider]:
    return [
        DefaultInfo(),
        CelldToolchain(
            celld = ctx.attrs.celld[RunInfo].args,
            celldc = ctx.attrs.celldc[RunInfo].args,
            default_info = ctx.attrs.celld[DefaultInfo],
            deno = ctx.attrs.deno[DenoToolchain].deno,
            testing = ctx.attrs.testing,
            types = ctx.attrs.types,
        ),
    ]

celld_toolchain = rule(
    impl = _celld_toolchain_impl,
    attrs = {
        "celld": attrs.exec_dep(providers = [RunInfo]),
        "celldc": attrs.exec_dep(providers = [RunInfo], default = "toolchains//celld:celldc"),
        "deno": attrs.toolchain_dep(providers = [DenoToolchain], default = "toolchains//:deno"),
        # The fake "cloudflare:workers" that `celld.test(fake_runtime = True)` maps in.
        "testing": attrs.source(default = "toolchains//celld:testing"),
        # The ambient platform declarations every unit type-checks against.
        "types": attrs.source(default = "toolchains//celld:types"),
    },
    is_toolchain_rule = True,
    doc = "Registers a celld executable selected for the execution platform.",
)

def _toolchain_attr():
    return attrs.toolchain_dep(default = "toolchains//:celld", providers = [CelldToolchain])

def _celld_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    toolchain = ctx.attrs._celld_toolchain[CelldToolchain]
    return [toolchain.default_info, RunInfo(args = toolchain.celld)]

celld_binary = rule(
    impl = _celld_binary_impl,
    attrs = {"_celld_toolchain": _toolchain_attr()},
    doc = "Exposes the toolchain CLI, binary output, and checksum-verified [archive].",
)

def _service_configs(ctx: AnalysisContext) -> list[dict[str, typing.Any]]:
    for binding in ctx.attrs.service_entrypoints:
        if binding not in ctx.attrs.services:
            fail("service entrypoint specified for undeclared binding {}".format(binding))
    result = []
    for binding, service in ctx.attrs.services.items():
        config = {
            "binding": binding,
            "service": service,
        }
        if binding in ctx.attrs.service_entrypoints:
            config["entrypoint"] = ctx.attrs.service_entrypoints[binding]
        result.append(config)
    return result

def _d1_configs(ctx: AnalysisContext) -> list[dict[str, str]]:
    for binding in ctx.attrs.d1_database_ids:
        if binding not in ctx.attrs.d1_databases:
            fail("D1 database ID specified for undeclared binding {}".format(binding))
    result = []
    for binding, database_name in ctx.attrs.d1_databases.items():
        config = {
            "binding": binding,
            "database_name": database_name,
        }
        if binding in ctx.attrs.d1_database_ids:
            config["database_id"] = ctx.attrs.d1_database_ids[binding]
        result.append(config)
    return result

def _assets_config(ctx: AnalysisContext) -> dict[str, typing.Any] | None:
    if ctx.attrs.assets == None:
        if (ctx.attrs.assets_binding or
            ctx.attrs.assets_html_handling or
            ctx.attrs.assets_not_found_handling or
            ctx.attrs.assets_run_worker_first or
            ctx.attrs.assets_run_worker_first_routes):
            fail("asset options require the assets attribute")
        return None
    if ctx.attrs.assets_run_worker_first and ctx.attrs.assets_run_worker_first_routes:
        fail("set either assets_run_worker_first or assets_run_worker_first_routes, not both")
    config = {"directory": "assets"}
    if ctx.attrs.assets_binding:
        config["binding"] = ctx.attrs.assets_binding
    if ctx.attrs.assets_html_handling:
        config["html_handling"] = ctx.attrs.assets_html_handling
    if ctx.attrs.assets_not_found_handling:
        config["not_found_handling"] = ctx.attrs.assets_not_found_handling
    if ctx.attrs.assets_run_worker_first_routes:
        config["run_worker_first"] = ctx.attrs.assets_run_worker_first_routes
    elif ctx.attrs.assets_run_worker_first:
        config["run_worker_first"] = True
    return config

def _celld_project_impl(ctx: AnalysisContext) -> list[Provider]:
    if ctx.attrs.container_context != None and not ctx.attrs.containers:
        fail("container_context requires at least one containers entry")
    classes = sorted({class_name: True for class_name in ctx.attrs.bindings.values()}.keys())
    config = {
        "name": ctx.attrs.script_name,
        "main": "index.js",
        "no_bundle": True,
        "compatibility_date": ctx.attrs.compatibility_date,
        "compatibility_flags": ctx.attrs.compatibility_flags,
        "durable_objects": {
            "bindings": [
                {
                    "name": binding,
                    "class_name": class_name,
                }
                for binding, class_name in ctx.attrs.bindings.items()
            ],
        },
        "migrations": [{
            "tag": "v1",
            "new_sqlite_classes": classes,
        }],
        "d1_databases": _d1_configs(ctx),
        "services": _service_configs(ctx),
        "kv_namespaces": [
            {"binding": binding, "id": namespace_id}
            for binding, namespace_id in ctx.attrs.kv_namespaces.items()
        ],
        "r2_buckets": [
            {"binding": binding, "bucket_name": bucket_name}
            for binding, bucket_name in ctx.attrs.r2_buckets.items()
        ],
        "queues": {
            "producers": ctx.attrs.queue_producers,
            "consumers": ctx.attrs.queue_consumers,
        },
        "workflows": ctx.attrs.workflows,
        "worker_loaders": [{"binding": binding} for binding in ctx.attrs.worker_loaders],
        "containers": ctx.attrs.containers,
        "triggers": {
            "crons": ctx.attrs.crons,
        },
        "vars": ctx.attrs.vars,
    }
    assets = _assets_config(ctx)
    if assets != None:
        config["assets"] = assets
    config_file = ctx.actions.declare_output("wrangler.jsonc")
    ctx.actions.write(config_file, json.encode(config))
    directory = ctx.actions.declare_output(ctx.label.name, dir = True)
    files = {
        "index.js": ctx.attrs.src,
        "wrangler.jsonc": config_file,
    }
    if ctx.attrs.assets != None:
        files["assets"] = ctx.attrs.assets
    if ctx.attrs.container_context != None:
        files["container"] = ctx.attrs.container_context
    directory = ctx.actions.copied_dir(directory, files)
    return [
        DefaultInfo(
            default_output = directory,
            sub_targets = {
                "config": [DefaultInfo(default_output = config_file)],
                "worker": [DefaultInfo(default_output = directory.project("index.js"))],
            },
        ),
        CelldProjectInfo(directory = directory),
    ]

_celld_project = rule(
    impl = _celld_project_impl,
    attrs = {
        "assets": attrs.option(attrs.source(), default = None),
        "assets_binding": attrs.string(default = ""),
        "assets_html_handling": attrs.string(default = ""),
        "assets_not_found_handling": attrs.string(default = ""),
        "assets_run_worker_first": attrs.bool(default = False),
        "assets_run_worker_first_routes": attrs.list(attrs.string(), default = []),
        "bindings": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "compatibility_date": attrs.string(default = "2026-08-20"),
        "compatibility_flags": attrs.list(attrs.string(), default = []),
        "container_context": attrs.option(attrs.source(), default = None),
        "containers": attrs.list(attrs.dict(attrs.string(), attrs.any()), default = []),
        "crons": attrs.list(attrs.string(), default = []),
        "d1_database_ids": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "d1_databases": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "kv_namespaces": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "queue_consumers": attrs.list(attrs.dict(attrs.string(), attrs.any()), default = []),
        "queue_producers": attrs.list(attrs.dict(attrs.string(), attrs.any()), default = []),
        "r2_buckets": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "script_name": attrs.string(),
        "services": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "service_entrypoints": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "src": attrs.source(),
        "vars": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "worker_loaders": attrs.list(attrs.string(), default = []),
        "workflows": attrs.list(attrs.dict(attrs.string(), attrs.string()), default = []),
    },
)

def celld_project(name: str, **kwargs):
    """Packages one bundled ESM source and its celld bindings into a deployment.

    See README.md for attribute schemas. The [config] and [worker] subtargets
    expose generated JSON and JavaScript independently for inspection.
    """
    _celld_project(name = name, **kwargs)

def _celld_deploy_impl(ctx: AnalysisContext) -> list[Provider]:
    args = cmd_args([
        ctx.attrs._celld_toolchain[CelldToolchain].celld,
        "deploy",
        ctx.attrs.project[CelldProjectInfo].directory,
    ])
    return [DefaultInfo(), RunInfo(args = args)]

_celld_deploy = rule(
    impl = _celld_deploy_impl,
    attrs = {
        "_celld_toolchain": _toolchain_attr(),
        "project": attrs.dep(providers = [CelldProjectInfo]),
    },
)

def celld_deploy(name: str, **kwargs):
    """Runs celld deploy for a CelldProjectInfo; runtime flags follow Buck's --."""
    _celld_deploy(name = name, **kwargs)

def _celld_deploy_test_impl(ctx: AnalysisContext) -> list[Provider]:
    command = [
        ctx.attrs._celld_toolchain[CelldToolchain].celld,
        "deploy",
        ctx.attrs.project[CelldProjectInfo].directory,
        "--dry-run",
        "--json",
    ]
    return [
        DefaultInfo(),
        RunInfo(args = cmd_args(command)),
        ExternalRunnerTestInfo(type = "custom", command = command),
    ]

celld_deploy_test = rule(
    impl = _celld_deploy_test_impl,
    attrs = {
        "project": attrs.dep(providers = [CelldProjectInfo]),
        "_celld_toolchain": _toolchain_attr(),
    },
    doc = "Runs celld deploy --dry-run without storage. Container projects still build/pull images using Docker or Podman.",
)

def _celld_serve_impl(ctx: AnalysisContext) -> list[Provider]:
    return [DefaultInfo(), RunInfo(args = ctx.attrs._celld_toolchain[CelldToolchain].celld)]

_celld_serve = rule(
    impl = _celld_serve_impl,
    attrs = {
        "_celld_toolchain": _toolchain_attr(),
    },
)

def celld_serve(name: str, **kwargs):
    """Runs the toolchain CLI (whose default command starts a fleet node)."""
    _celld_serve(name = name, **kwargs)

# MARK: TypeScript units

def _record_json(record: struct) -> dict[str, typing.Any]:
    return {
        "deps": record.deps,
        "exports": record.exports,
        "import_name": record.import_name,
        "label": record.label,
        "srcs": record.srcs,
    }

def _record_srcs(record: struct) -> list[Artifact]:
    return record.srcs

# One record per library: its label, import name, exported specifiers (each
# mapped to a file), sources and direct dependencies. The JSON projection is
# the closure a driver manifest lists; the args projection is every source
# file, which each action takes as hidden inputs.
CelldLibraryTSet = transitive_set(
    args_projections = {"srcs": _record_srcs},
    json_projections = {"json": _record_json},
)

CelldLibraryInfo = provider(
    doc = "A TypeScript library: its import name and the transitive set of its closure.",
    fields = {
        "import_name": provider_field(str),
        "tset": provider_field(typing.Any),
    },
)

def _target_label(label) -> str:
    return str(label.raw_target())

def _specifiers(label: str, import_name: str, exports: dict[str, Artifact]) -> dict[str, Artifact]:
    if not import_name or import_name.startswith(".") or ":" in import_name or import_name.endswith("/"):
        fail("{}: import_name {} must be a bare specifier such as @celld/assert".format(label, repr(import_name)))
    result = {}
    for subpath, src in exports.items():
        if subpath == ".":
            result[import_name] = src
        elif subpath.startswith("./") and len(subpath) > 2:
            result[import_name + subpath[1:]] = src
        else:
            fail("{}: export key {} must be \".\" or start with \"./\"".format(label, repr(subpath)))
    return result

def _dedupe(artifacts: list[Artifact]) -> list[Artifact]:
    return {artifact: True for artifact in artifacts}.keys()

def _is_test_file(path: str) -> bool:
    base = paths.basename(path)
    for suffix in [".ts", ".tsx", ".js", ".mjs", ".mts", ".jsx"]:
        if base.endswith(suffix):
            stem = base[:-len(suffix)]
            return stem == "test" or stem.endswith("_test") or stem.endswith(".test")
    return False

def _unit(
        ctx: AnalysisContext,
        srcs: list[Artifact],
        exports: dict[str, Artifact],
        import_name: str | None,
        fake_runtime: bool) -> struct:
    """The actions every unit shares: manifest, Deno config, graph and type
    check, and lint. Returns them with the unit's own library record."""
    toolchain = ctx.attrs._celld_toolchain[CelldToolchain]
    label = _target_label(ctx.label)
    children = [dep[CelldLibraryInfo].tset for dep in ctx.attrs.deps]
    closure = ctx.actions.tset(CelldLibraryTSet, children = children)

    claimed = {spec: label for spec in exports}
    for record in closure.traverse():
        for spec in record.exports:
            other = claimed.get(spec)
            if other != None and other != record.label:
                fail("{}: specifier {} is claimed by both {} and {}".format(label, spec, other, record.label))
            claimed[spec] = record.label

    record = struct(
        deps = [_target_label(dep.label) for dep in ctx.attrs.deps],
        exports = exports,
        import_name = import_name,
        label = label,
        srcs = srcs,
    )
    manifest = ctx.actions.write_json("celld/manifest.json", {
        "libraries": closure.project_as_json("json"),
        "testing": toolchain.testing,
        "types": toolchain.types,
        "unit": _record_json(record),
    })

    config = ctx.actions.declare_output("celld/deno.json")
    ctx.actions.run(
        cmd_args(
            toolchain.celldc,
            "config",
            "--manifest",
            manifest,
            "--out",
            config.as_output(),
            ["--fake-runtime"] if fake_runtime else [],
        ),
        category = "celld_config",
    )

    inputs = [srcs, closure.project_as_args("srcs"), toolchain.types, toolchain.testing]
    stamp = ctx.actions.declare_output("celld/check.stamp")
    ctx.actions.run(
        cmd_args(
            toolchain.celldc,
            "check",
            "--manifest",
            manifest,
            "--config",
            config,
            "--deno",
            toolchain.deno,
            "--stamp",
            stamp.as_output(),
            hidden = inputs,
        ),
        category = "celld_check",
        allow_cache_upload = True,
    )

    # What celld-project merges into the editor's Deno config.
    fragment = ctx.actions.declare_output("celld/editor.json")
    ctx.actions.run(
        cmd_args(toolchain.celldc, "fragment", "--manifest", manifest, "--out", fragment.as_output()),
        category = "celld_fragment",
    )

    lint = cmd_args(
        toolchain.deno,
        "lint",
        "--config",
        config,
        [src for src in srcs if not src.short_path.endswith(".d.ts")],
    )
    env = {"DENO_NO_UPDATE_CHECK": "1"}
    sub_targets = {
        "check": [
            DefaultInfo(default_output = stamp),
            ExternalRunnerTestInfo(
                type = "custom",
                command = [cmd_args(toolchain.celldc, "stamp", stamp)],
            ),
        ],
        "config": [DefaultInfo(default_output = config)],
        "ide": [DefaultInfo(default_output = fragment)],
        "lint": [
            DefaultInfo(),
            ExternalRunnerTestInfo(type = "custom", command = [lint], env = env),
        ],
    }
    return struct(
        children = children,
        config = config,
        env = env,
        inputs = inputs,
        record = record,
        stamp = stamp,
        sub_targets = sub_targets,
        toolchain = toolchain,
    )

_UNIT_ATTRS = {
    "deps": attrs.list(attrs.dep(providers = [CelldLibraryInfo]), default = []),
    "srcs": attrs.list(attrs.source(), default = []),
    "_celld_toolchain": _toolchain_attr(),
}

def _celld_library_impl(ctx: AnalysisContext) -> list[Provider]:
    label = _target_label(ctx.label)
    exports = _specifiers(label, ctx.attrs.import_name, ctx.attrs.exports)
    srcs = _dedupe(ctx.attrs.srcs + ctx.attrs.exports.values())
    unit = _unit(ctx, srcs, exports, ctx.attrs.import_name, False)
    tset = ctx.actions.tset(CelldLibraryTSet, value = unit.record, children = unit.children)
    return [
        DefaultInfo(default_output = unit.stamp, sub_targets = unit.sub_targets),
        CelldLibraryInfo(import_name = ctx.attrs.import_name, tset = tset),
    ]

_celld_library = rule(
    impl = _celld_library_impl,
    attrs = _UNIT_ATTRS | {
        "exports": attrs.dict(attrs.string(), attrs.source()),
        "import_name": attrs.string(),
    },
)

def _celld_test_impl(ctx: AnalysisContext) -> list[Provider]:
    unit = _unit(ctx, ctx.attrs.srcs, {}, None, ctx.attrs.fake_runtime)
    roots = [src for src in ctx.attrs.srcs if _is_test_file(src.short_path)] or ctx.attrs.srcs

    # The check stamp already type-checked this exact graph with this config.
    command = cmd_args(
        unit.toolchain.deno,
        "test",
        "--no-check",
        "--config",
        unit.config,
        ["--allow-{}".format(p) for p in ctx.attrs.permissions],
        roots,
        hidden = [unit.stamp, unit.inputs, ctx.attrs.data],
    )
    return [
        DefaultInfo(default_output = unit.stamp, sub_targets = unit.sub_targets),
        RunInfo(args = command),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [command],
            env = unit.env | ctx.attrs.env,
        ),
    ]

_celld_test = rule(
    impl = _celld_test_impl,
    attrs = _UNIT_ATTRS | {
        "data": attrs.list(attrs.source(allow_directory = True), default = []),
        # A `$(location ...)` value makes that artifact an input of the test.
        "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
        "fake_runtime": attrs.bool(default = False),
        "permissions": attrs.list(attrs.string(), default = []),
    },
)

def _celld_worker_impl(ctx: AnalysisContext) -> list[Provider]:
    srcs = _dedupe([ctx.attrs.main] + ctx.attrs.srcs)
    unit = _unit(ctx, srcs, {}, None, False)
    output = ctx.actions.declare_output("{}.js".format(ctx.label.name))
    ctx.actions.run(
        cmd_args(
            unit.toolchain.celldc,
            "bundle",
            "--config",
            unit.config,
            "--deno",
            unit.toolchain.deno,
            "--main",
            ctx.attrs.main,
            "--out",
            output.as_output(),
            ["--minify"] if ctx.attrs.minify else [],
            hidden = [unit.stamp, unit.inputs],
        ),
        category = "celld_bundle",
        allow_cache_upload = True,
    )
    return [DefaultInfo(default_output = output, sub_targets = unit.sub_targets)]

_celld_worker = rule(
    impl = _celld_worker_impl,
    attrs = _UNIT_ATTRS | {
        "main": attrs.source(),
        # Strip comments and whitespace: fleet nodes fetch the script from the
        # bucket in chunks when they start, so a smaller file starts faster.
        "minify": attrs.bool(default = False),
    },
)

def _with_tests(name: str, kwargs: dict[str, typing.Any], subtargets: list[str]) -> dict[str, typing.Any]:
    tests = list(kwargs.pop("tests", []))
    for sub in subtargets:
        test = ":{}[{}]".format(name, sub)
        if test not in tests:
            tests.append(test)
    kwargs["tests"] = tests
    return kwargs

def celld_library(name: str, **kwargs):
    """A TypeScript library other units import as `import_name`.

    `exports` maps subpaths ("." or "./sub") to files; they are the only
    importable entry points. Building the library type-checks it; its
    `[check]` and `[lint]` tests run under `buck2 test`.
    """
    if "exports" not in kwargs:
        kwargs["exports"] = {".": "mod.ts"}
    _celld_library(name = name, **_with_tests(name, kwargs, ["check", "lint"]))

def celld_test(name: str, **kwargs):
    """`deno test` over the `*_test.ts` files in `srcs` (all of `srcs` if none
    match). `fake_runtime = True` maps "cloudflare:workers" to the toolchain's
    constructor fakes, so modules defining Durable Objects can be imported."""
    _celld_test(name = name, **_with_tests(name, kwargs, ["lint"]))

def celld_worker(name: str, **kwargs):
    """Bundles `main` into one ESM file for `celld.project(src = ...)`, keeping
    the runtime's `cloudflare:*` imports external."""
    _celld_worker(name = name, **_with_tests(name, kwargs, ["check", "lint"]))

def _celld_tool_impl(ctx: AnalysisContext) -> list[Provider]:
    toolchain = ctx.attrs._celld_toolchain[CelldToolchain]
    return [DefaultInfo(), RunInfo(args = getattr(toolchain, ctx.attrs.tool))]

celld_tool = rule(
    impl = _celld_tool_impl,
    attrs = {
        "tool": attrs.enum(["celldc", "deno"]),
        "_celld_toolchain": _toolchain_attr(),
    },
    doc = "Runs the toolchain's driver or Deno; for tests of the toolchain itself.",
)

def _celld_project_tool_impl(ctx: AnalysisContext) -> list[Provider]:
    toolchain = ctx.attrs._celld_toolchain[CelldToolchain]

    # "--" ends the proxy's own flags: what the editor appends is either
    # `lsp` or a Deno command line to pass through.
    args = cmd_args(ctx.attrs.proxy[RunInfo].args, "--deno", toolchain.deno, "--")
    return [DefaultInfo(), RunInfo(args = args)]

celld_project_tool = rule(
    impl = _celld_project_tool_impl,
    attrs = {
        "proxy": attrs.exec_dep(providers = [RunInfo]),
        "_celld_toolchain": _toolchain_attr(),
    },
    doc = "celld-project bound to the toolchain's Deno, for editors.",
)

# Public namespace for Worker applications; imports need no Orchestra dependency.
celld = struct(
    binary = celld_binary,
    deploy = celld_deploy,
    deploy_test = celld_deploy_test,
    library = celld_library,
    project = celld_project,
    serve = celld_serve,
    test = celld_test,
    worker = celld_worker,
)
