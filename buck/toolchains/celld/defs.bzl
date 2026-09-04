# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Pinned celld executables, Worker policy, and deployment packaging.

The runtime-neutral web toolchain owns source graphs, type checking, native
Svelte/Oxc tooling and ESM compilation. These adapters supply celld's platform
declarations, runtime imports, test stand-ins, and Worker packaging.
"""

load("@prelude//:paths.bzl", "paths")
load("@toolchains//deno:toolchain.bzl", "DenoToolchain")
load("@toolchains//js:defs.bzl", "js")
load("@toolchains//web:defs.bzl", "WebBundleInfo", "web")

CelldToolchain = provider(
    doc = "The celld command and its downloadable artifacts for an execution platform.",
    fields = {
        "celld": provider_field(typing.Any),
        "default_info": provider_field(typing.Any),
        "deno": provider_field(typing.Any),
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
            default_info = ctx.attrs.celld[DefaultInfo],
            deno = ctx.attrs.deno[DenoToolchain].deno,
        ),
    ]

celld_toolchain = rule(
    impl = _celld_toolchain_impl,
    attrs = {
        "celld": attrs.exec_dep(providers = [RunInfo]),
        "deno": attrs.toolchain_dep(providers = [DenoToolchain], default = "toolchains//:deno"),
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
        # celld keeps no migration history: it validates tags only for
        # uniqueness and serves the union of `new_sqlite_classes`, refusing
        # every other migration key. One step is therefore complete; see
        # README.md.
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
    files = {"wrangler.jsonc": config_file}
    if isinstance(ctx.attrs.src, Dependency):
        # celld serves each sibling `.wasm` file as a compiled module that
        # the bundle imports by its file name.
        worker = ctx.attrs.src[WebBundleInfo]
        files["index.js"] = worker.bundle
        if worker.sourcemap != None:
            # The bundle keeps its map URL when it is renamed to index.js.
            files[paths.basename(worker.sourcemap.short_path)] = worker.sourcemap
        for module, wasm in worker.wasm.items():
            files[module] = wasm
    else:
        files["index.js"] = ctx.attrs.src
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
        # A celld.worker (whose wasm modules come along) or a bundled file.
        "src": attrs.one_of(attrs.dep(providers = [WebBundleInfo]), attrs.source()),
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

# Worker policy is injected into the shared web rules, not implemented again.
def _worker_policy(kwargs: dict[str, typing.Any]) -> dict[str, typing.Any]:
    kwargs["platform_name"] = "celld"
    kwargs["types"] = ["toolchains//celld:types"]
    kwargs["externals"] = ["cloudflare:*"]
    kwargs["lib"] = ["deno.ns", "dom", "dom.iterable", "esnext"]
    kwargs["deno_lint"] = True
    kwargs["bundle_platform"] = "browser"
    kwargs["server_conditions"] = ["worker", "default"]
    return kwargs

def celld_library(name: str, **kwargs):
    """A strictly checked library targeting the celld platform."""
    if "exports" not in kwargs:
        kwargs["exports"] = {".": "mod.ts"}
    js.library(name = name, **_worker_policy(kwargs))

def celld_svelte_library(name: str, **kwargs):
    """Checked native Svelte output with celld's server runtime conditions."""
    web.svelte_library(name = name, **_worker_policy(kwargs))

def celld_test(name: str, **kwargs):
    """Explicit Deno execution with optional celld constructor stand-ins."""
    if kwargs.get("fake_runtime", False):
        kwargs["runtime_modules"] = {
            "cloudflare:sockets": "toolchains//celld:testing-sockets",
            "cloudflare:workers": "toolchains//celld:testing-workers",
            "cloudflare:workflows": "toolchains//celld:testing-workflows",
        }
    web.deno_test(name = name, **_worker_policy(kwargs))

def celld_worker(name: str, **kwargs):
    """ESM Worker bundle with runtime-owned imports and wasm left external."""
    web.bundle(name = name, **_worker_policy(kwargs))

def celld_browser(name: str, **kwargs):
    """Client ESM/CSS/maps; server-only value imports cannot enter the graph."""
    if "svelte_runtime" not in kwargs:
        kwargs["svelte_runtime"] = True
    web.browser(name = name, **_worker_policy(kwargs))

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
    browser = celld_browser,
    deploy = celld_deploy,
    deploy_test = celld_deploy_test,
    library = celld_library,
    svelte_library = celld_svelte_library,
    project = celld_project,
    serve = celld_serve,
    test = celld_test,
    worker = celld_worker,
)
