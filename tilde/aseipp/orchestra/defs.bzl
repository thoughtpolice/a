# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Orchestra agent launchers and its Buck-managed local E2E test resources.

Reusable Worker packaging, runtime downloads, and deployment live in the celld
toolchain. chaos3 owns its shared local-resource setup. These rules only compose
Orchestra's client, tdutil, Buck, and the supplied S3 resource.
"""

load("@toolchains//celld:defs.bzl", "CelldProjectInfo", "CelldToolchain")

def _host_platform() -> str:
    host = host_info()
    if host.os.is_linux:
        os = "linux"
    elif host.os.is_macos:
        os = "macos"
    else:
        fail("Orchestra has no default platform for host OS {}".format(host.os))

    if host.arch.is_x86_64:
        arch = "x86_64"
    elif host.arch.is_aarch64:
        arch = "aarch64"
    else:
        fail("Orchestra has no default platform for host architecture {}".format(host.arch))
    return "{}-{}".format(os, arch)

def _orchestra_deploy_impl(ctx: AnalysisContext) -> list[Provider]:
    command = [
        ctx.attrs.runner[RunInfo].args,
        "deploy",
        ctx.attrs._celld_toolchain[CelldToolchain].celld,
        ctx.attrs.consumer_project[CelldProjectInfo].directory,
        ctx.attrs.project[CelldProjectInfo].directory,
    ]
    return [DefaultInfo(), RunInfo(args = cmd_args(command))]

_orchestra_deploy = rule(
    impl = _orchestra_deploy_impl,
    attrs = {
        "_celld_toolchain": attrs.toolchain_dep(default = "toolchains//:celld", providers = [CelldToolchain]),
        "consumer_project": attrs.dep(providers = [CelldProjectInfo]),
        "project": attrs.dep(providers = [CelldProjectInfo]),
        "runner": attrs.exec_dep(providers = [RunInfo]),
    },
)

def orchestra_deploy(name: str, **kwargs):
    """Deploys the Queue consumer before the public API in the same celld fleet.

    Each celld deploy changes the fleet's HTTP entrypoint. Publishing the API
    last keeps it primary while its Queue attachment loads the consumer as a
    cohosted script. Arguments after Buck's ``--`` apply to both deployments.
    """
    _orchestra_deploy(name = name, **kwargs)

def _celld_e2e_test_impl(ctx: AnalysisContext) -> list[Provider]:
    command = [
        ctx.attrs.runner[RunInfo].args,
        "test",
        ctx.attrs._celld_toolchain[CelldToolchain].celld,
        ctx.attrs.consumer_project[CelldProjectInfo].directory,
        ctx.attrs.project[CelldProjectInfo].directory,
        ctx.attrs.orchestra[RunInfo].args,
    ]
    return [
        DefaultInfo(),
        RunInfo(args = cmd_args(command)),
        ExternalRunnerTestInfo(
            type = "custom",
            command = command,
            local_resources = {
                "chaos3": ctx.attrs.chaos3.label,
            },
            required_local_resources = [
                RequiredTestLocalResource("chaos3", listing = False, execution = True),
            ],
            supports_test_execution_caching = False,
        ),
    ]

_celld_e2e_test = rule(
    impl = _celld_e2e_test_impl,
    attrs = {
        "_celld_toolchain": attrs.toolchain_dep(default = "toolchains//:celld", providers = [CelldToolchain]),
        "consumer_project": attrs.dep(providers = [CelldProjectInfo]),
        "chaos3": attrs.dep(providers = [LocalResourceInfo]),
        "orchestra": attrs.exec_dep(providers = [RunInfo]),
        "project": attrs.dep(providers = [CelldProjectInfo]),
        "runner": attrs.exec_dep(providers = [RunInfo]),
    },
)

def celld_e2e_test(name: str, **kwargs):
    """Runs a deployed celld Worker against Buck-provisioned local storage."""
    _celld_e2e_test(name = name, **kwargs)

def _orchestra_tdutil_impl(ctx: AnalysisContext) -> list[Provider]:
    if not ctx.attrs.universes:
        fail("orchestra_tdutil requires at least one Buck universe")
    args = cmd_args(ctx.attrs.orchestra[RunInfo].args)
    args.add(ctx.attrs.command)
    if ctx.attrs.command == "agent":
        args.add("--planner", "tdutil")
    args.add("--tdutil", ctx.attrs.tdutil[RunInfo].args)
    args.add("--buck", ctx.attrs.buck)
    for universe in ctx.attrs.universes:
        args.add("--universe", universe)
    args.add("--platform", ctx.attrs.platform or _host_platform())
    return [DefaultInfo(), RunInfo(args = args)]

_orchestra_tdutil = rule(
    impl = _orchestra_tdutil_impl,
    attrs = {
        "buck": attrs.source(),
        "command": attrs.enum(["agent", "plan"]),
        "orchestra": attrs.exec_dep(providers = [RunInfo]),
        "platform": attrs.string(default = ""),
        "tdutil": attrs.exec_dep(providers = [RunInfo]),
        "universes": attrs.list(attrs.string()),
    },
)

def orchestra_tdutil(name: str, **kwargs):
    """Runs Orchestra planning or queue draining with Buck-built tdutil and Buck2."""
    _orchestra_tdutil(name = name, **kwargs)

def _orchestra_buck_impl(ctx: AnalysisContext) -> list[Provider]:
    platform = ctx.attrs.platform or _host_platform()
    args = cmd_args(ctx.attrs.orchestra[RunInfo].args)
    args.add(ctx.attrs.command)
    args.add("--buck", ctx.attrs.buck)
    args.add("--buck-mode", ctx.attrs.buck_mode)
    args.add("--platform", platform)

    if ctx.attrs.command == "agent":
        if ctx.attrs.tdutil == None:
            fail("the Orchestra Buck agent requires tdutil")
        if not ctx.attrs.universes:
            fail("the Orchestra Buck agent requires at least one Buck universe")
        args.add("--planner", "tdutil")
        args.add("--tdutil", ctx.attrs.tdutil[RunInfo].args)
        args.add("--executor", "buck")
        for universe in ctx.attrs.universes:
            args.add("--universe", universe)
    elif ctx.attrs.tdutil != None or ctx.attrs.universes:
        fail("tdutil and universes only apply to an Orchestra Buck agent")

    return [DefaultInfo(), RunInfo(args = args)]

_orchestra_buck = rule(
    impl = _orchestra_buck_impl,
    attrs = {
        "buck": attrs.source(),
        "buck_mode": attrs.enum(["default", "local", "remote"], default = "local"),
        "command": attrs.enum(["agent", "execute"]),
        "orchestra": attrs.exec_dep(providers = [RunInfo]),
        "platform": attrs.string(default = ""),
        "tdutil": attrs.option(attrs.exec_dep(providers = [RunInfo]), default = None),
        "universes": attrs.list(attrs.string(), default = []),
    },
)

def orchestra_buck(name: str, **kwargs):
    """Runs a Buck-built Orchestra client with the repository's Buck2 tool.

    The ``execute`` form is a standalone batch harness. The ``agent`` form
    composes tdutil planning and Buck execution into one queue-draining client;
    celld remains the durable control plane and never invokes Buck itself.
    """
    _orchestra_buck(name = name, **kwargs)
