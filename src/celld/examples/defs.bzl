# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Standalone celld example Workers, each with its own runtime test.

See README.md in this directory for the convention.
"""

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")
load("@toolchains//deno:defs.bzl", "DenoToolchain")

_HARNESS = "root//src/celld/examples:harness"
_CELLD = "toolchains//celld:cli"

def _library_name():
    """`jev` for src/celld/api/jev/examples: the default script name prefix."""
    parts = native.package_name().split("/")
    if len(parts) >= 2 and parts[-1] == "examples":
        return parts[-2]
    return parts[-1]

def _upstream_impl(ctx: AnalysisContext) -> list[Provider]:
    command = cmd_args(
        ctx.attrs._deno_toolchain[DenoToolchain].deno,
        "run",
        "--no-config",
        "--no-prompt",
        # Listening and connecting on loopback is all a fake may do.
        "--allow-net=127.0.0.1,localhost",
        ["--allow-run={}".format(",".join(ctx.attrs.run))] if ctx.attrs.run else [],
        ctx.attrs.bundle,
    )
    return [DefaultInfo(default_output = ctx.attrs.bundle), RunInfo(args = command)]

_upstream = rule(
    impl = _upstream_impl,
    attrs = {
        "bundle": attrs.source(),
        "run": attrs.list(attrs.string(), default = []),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    },
)

def _labelled_test_impl(ctx: AnalysisContext) -> list[Provider]:
    command = [ctx.attrs.dep[RunInfo].args] + ctx.attrs.args
    return [
        DefaultInfo(),
        RunInfo(args = cmd_args(command)),
        ExternalRunnerTestInfo(
            type = "custom",
            command = command,
            env = ctx.attrs.env,
            labels = ctx.attrs.labels,
        ),
    ]

# A test running `dep` with `args`, with labels for test selection (such as
# `needs-docker`), which the rules celld_example otherwise uses do not take.
_labelled_test = rule(
    impl = _labelled_test_impl,
    attrs = {
        "args": attrs.list(attrs.arg(), default = []),
        "dep": attrs.dep(providers = [RunInfo]),
        "env": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "labels": attrs.list(attrs.string(), default = []),
    },
)

def celld_example_upstream(
        name: str,
        main: str,
        deps: list[str],
        srcs: list[str] = [],
        run: list[str] = []):
    """A fake upstream for a package's examples: `main` calls `serveUpstream`
    from `@celld/examples/upstream` around the library's own test double.

    Bundled like a Worker (strict deps, no deno.json) and started with Deno,
    allowed only to listen and connect on loopback, and to run the programs
    in `run` (such as `/bin/sh` for a fake VM). Its first argument is a
    scratch directory the harness owns and removes.
    """
    celld.worker(
        name = name + "-bundle",
        main = main,
        srcs = srcs,
        deps = deps + ["root//src/celld/examples:upstream"],
    )
    _upstream(
        name = name,
        bundle = ":{}-bundle".format(name),
        run = run,
    )

def celld_example(
        name: str,
        main: str,
        deps: list[str],
        spec: str | None = None,
        upstream: str | None = None,
        srcs: list[str] = [],
        script_name: str | None = None,
        labels: list[str] = [],
        **project_kwargs):
    """One example Worker in `main`, and everything to run and test it:

    - `:<name>`: the packaged `celld.project` (`project_kwargs` are its
      bindings, `kv_namespaces`, `workflows`, `vars`, ...);
    - `:<name>-worker`: the bundle, with its `[check]` and `[lint]` tests;
    - `:<name>-deploy-test`: `celld deploy --dry-run` over the project;
    - `:<name>-test`: the harness runs `spec` (default `<name>.json`)
      against the project under `celld dev`, with `upstream` (a
      `celld_example_upstream`) started first when given;
    - `:<name>-dev`: `buck2 run` it to leave the example running on
      127.0.0.1:9876 against the same fake (`-- --live` for the real service,
      `-- --help` for the rest).

    `labels` go on the `-test` and `-deploy-test` targets, such as
    `needs-docker` for an example with a container (both build its image).
    """
    spec = spec or name + ".json"
    celld.worker(
        name = name + "-worker",
        main = main,
        srcs = srcs,
        deps = deps,
    )
    celld.project(
        name = name,
        src = ":{}-worker".format(name),
        script_name = script_name or "{}-example-{}".format(_library_name(), name),
        **project_kwargs
    )
    if labels:
        # The same dry run as celld.deploy_test, carrying the labels. It
        # builds images (celld's fence image has a RUN step) for the host,
        # not celld's linux/amd64 default, so it needs no emulation.
        _labelled_test(
            name = name + "-deploy-test",
            dep = _CELLD,
            args = ["deploy", "$(location :{})".format(name), "--dry-run", "--json"],
            env = {"CELLD_CONTAINER_PLATFORM": "linux/arm64" if host_info().arch.is_aarch64 else "linux/amd64"},
            labels = labels,
        )
    else:
        celld.deploy_test(
            name = name + "-deploy-test",
            project = ":" + name,
        )
    depot.export_file(
        name = name + "-spec",
        src = spec,
    )
    args = [
        "--celld",
        "$(exe {})".format(_CELLD),
        "--project",
        "$(location :{})".format(name),
        "--spec",
        "$(location :{}-spec)".format(name),
    ]
    if upstream:
        args += ["--upstream", "$(exe {})".format(upstream)]
    if labels:
        _labelled_test(
            name = name + "-test",
            dep = _HARNESS,
            args = ["test"] + args,
            labels = labels,
        )
    else:
        depot.run_test(
            name = name + "-test",
            dep = _HARNESS,
            args = ["test"] + args,
        )
    depot.command(
        name = name + "-dev",
        dep = _HARNESS,
        args = ["dev"] + args,
    )
