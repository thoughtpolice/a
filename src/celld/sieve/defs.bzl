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

The rule generates a bootstrap with a literal import of `module`. A checked
`celld.worker` unit gives its import map (`[config]`) and type-check stamp
(`[check]`); the toolchain's Deno runs that bootstrap against the config.
The worker's bundle is never built.
"""

load("@toolchains//celld:defs.bzl", "celld")
load("@toolchains//deno:toolchain.bzl", "DenoToolchain")
load("@toolchains//js:providers.bzl", "JsLibraryInfo")

_SIEVE = "root//src/celld/sieve:sieve"
_EMITTER = "root//src/celld/sieve:emit-main"

def _schema_entry_impl(ctx: AnalysisContext) -> list[Provider]:
    entry = ctx.actions.write(
        "emit.ts",
        "// SPDX-FileCopyrightText: © 2026 Austin Seipp\n" +
        "// SPDX-License-Identifier: Apache-2.0\n" +
        "import * as schemas from {};\n".format(json.encode(ctx.attrs.module)) +
        'import { parseArgs } from "@celld/sieve/emitter";\n' +
        'import { toJSONSchemaBundle } from "@celld/sieve/json-schema";\n' +
        "const { out, options } = parseArgs(Deno.args);\n" +
        "await Deno.writeTextFile(out, JSON.stringify(toJSONSchemaBundle(schemas, options), null, 2) + '\\n');\n",
    )
    return [DefaultInfo(default_output = entry)]

_schema_entry = rule(
    impl = _schema_entry_impl,
    attrs = {"module": attrs.string()},
)

def _first_output(dep: Dependency, sub_target: str) -> Artifact:
    return dep[DefaultInfo].sub_targets[sub_target][DefaultInfo].default_outputs[0]

def _sieve_json_schema_impl(ctx: AnalysisContext) -> list[Provider]:
    deno = ctx.attrs._deno_toolchain[DenoToolchain].deno
    out = ctx.actions.declare_output(ctx.attrs.out or "{}.json".format(ctx.label.name))
    options = []
    if ctx.attrs.io:
        options += ["--io", ctx.attrs.io]
    if ctx.attrs.unrepresentable:
        options += ["--unrepresentable", ctx.attrs.unrepresentable]
    ctx.actions.run(
        cmd_args(
            deno,
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
                # Complete declared inputs of the checked unit, including types.
                ctx.attrs.unit[DefaultInfo].sub_targets["ide"][DefaultInfo].other_outputs,
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
        "deps": attrs.list(attrs.dep(providers = [JsLibraryInfo])),
        "io": attrs.option(attrs.enum(["input", "output"]), default = None),
        "main": attrs.source(),
        "module": attrs.string(),
        "out": attrs.option(attrs.string(), default = None),
        "unit": attrs.dep(),
        "unrepresentable": attrs.option(attrs.enum(["throw", "any"]), default = None),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
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
    unit_deps = [_SIEVE, _EMITTER] + [dep for dep in deps if dep not in [_SIEVE, _EMITTER]]
    entry = "{}-entry".format(unit)
    _schema_entry(name = entry, module = module)
    celld.worker(
        name = unit,
        main = ":{}".format(entry),
        deps = unit_deps,
    )
    _sieve_json_schema(
        name = name,
        deps = unit_deps,
        io = io,
        main = ":{}".format(entry),
        module = module,
        out = out,
        unit = ":{}".format(unit),
        unrepresentable = unrepresentable,
        visibility = visibility,
    )
