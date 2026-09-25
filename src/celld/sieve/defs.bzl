# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Build-time JSON Schema for `@celld/sieve` schemas.

`sieve_json_schema` writes one JSON Schema document whose `$defs` hold every
named schema (`.meta({ id })`) a module exports. The module is a bare
specifier exported by one of `deps`, so the schemas are type-checked and
owned by their library, not by the generator:

```python
load("@root//src/celld/sieve:defs.bzl", "sieve_json_schema")

sieve_json_schema(
    name = "api-schema",
    module = "@celld/example/schemas",
    deps = ["root//src/celld/example:example"],
)
```

It uses only the celld toolchain's pieces: a `celld.worker` unit whose main
is `tools/emit.ts` gives the import map (its `[config]`) and the type check
(its `[check]` stamp), and the toolchain's Deno runs the emitter against
that config. The worker's bundle is never built.
"""

load("@toolchains//celld:defs.bzl", "CelldLibraryInfo", "CelldToolchain", "celld")

_SIEVE = "root//src/celld/sieve:sieve"
_EMITTER = "root//src/celld/sieve:emit-main"

def _first_output(dep: Dependency, sub_target: str) -> Artifact:
    return dep[DefaultInfo].sub_targets[sub_target][DefaultInfo].default_outputs[0]

def _sieve_json_schema_impl(ctx: AnalysisContext) -> list[Provider]:
    toolchain = ctx.attrs._celld_toolchain[CelldToolchain]
    out = ctx.actions.declare_output(ctx.attrs.out or "{}.json".format(ctx.label.name))
    options = []
    if ctx.attrs.io:
        options += ["--io", ctx.attrs.io]
    if ctx.attrs.unrepresentable:
        options += ["--unrepresentable", ctx.attrs.unrepresentable]
    ctx.actions.run(
        cmd_args(
            toolchain.deno,
            "run",
            "--quiet",
            "--no-remote",
            "--no-npm",
            "--config",
            _first_output(ctx.attrs.unit, "config"),
            "--allow-read",
            "--allow-write",
            ctx.attrs.main,
            ctx.attrs.module,
            out.as_output(),
            options,
            hidden = [
                _first_output(ctx.attrs.unit, "check"),
                toolchain.types,
                [dep[CelldLibraryInfo].tset.project_as_args("srcs") for dep in ctx.attrs.deps],
                # The libraries' check stamps: emit only from code that type-checks.
                [dep[DefaultInfo].default_outputs for dep in ctx.attrs.deps],
            ],
        ),
        env = {"DENO_NO_UPDATE_CHECK": "1", "NO_COLOR": "1"},
        category = "sieve_json_schema",
    )
    return [DefaultInfo(default_output = out)]

_sieve_json_schema = rule(
    impl = _sieve_json_schema_impl,
    attrs = {
        "deps": attrs.list(attrs.dep(providers = [CelldLibraryInfo])),
        "io": attrs.option(attrs.enum(["input", "output"]), default = None),
        "main": attrs.source(),
        "module": attrs.string(),
        "out": attrs.option(attrs.string(), default = None),
        "unit": attrs.dep(),
        "unrepresentable": attrs.option(attrs.enum(["throw", "any"]), default = None),
        "_celld_toolchain": attrs.toolchain_dep(default = "toolchains//:celld", providers = [CelldToolchain]),
    },
)

def sieve_json_schema(
        name: str,
        module: str,
        deps: list[str],
        io: str | None = None,
        unrepresentable: str | None = None,
        out: str | None = None,
        visibility: list[str] = []):
    """Writes `<name>.json` (or `out`): the named schemas `module` exports.

    `module` is a specifier one of `deps` exports; `io` and
    `unrepresentable` are `toJSONSchema`'s options.
    """
    unit = "{}-emitter".format(name)
    unit_deps = [_SIEVE] + [dep for dep in deps if dep != _SIEVE]
    celld.worker(
        name = unit,
        main = _EMITTER,
        deps = unit_deps,
    )
    _sieve_json_schema(
        name = name,
        deps = unit_deps,
        io = io,
        main = _EMITTER,
        module = module,
        out = out,
        unit = ":{}".format(unit),
        unrepresentable = unrepresentable,
        visibility = visibility,
    )
