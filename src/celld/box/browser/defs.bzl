# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Ordinary Deno tests controlling a real celld/runsc browser fixture."""

load("@toolchains//celld:defs.bzl", "CelldProjectInfo", "CelldToolchain", "celld")

def _browser_test_impl(ctx: AnalysisContext) -> list[Provider]:
    toolchain = ctx.attrs._celld_toolchain[CelldToolchain]
    command = cmd_args(
        ctx.attrs._runner[RunInfo].args,
        "--celld",
        toolchain.celld,
        "--deno",
        toolchain.deno,
        "--project",
        ctx.attrs.project[CelldProjectInfo].directory,
        "--driver",
        ctx.attrs.driver,
    )
    return [
        DefaultInfo(),
        RunInfo(args = command),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [command],
            labels = ["browser", "needs-docker", "needs-runsc"],
        ),
    ]

_browser_test = rule(
    impl = _browser_test_impl,
    attrs = {
        "driver": attrs.source(),
        "project": attrs.dep(providers = [CelldProjectInfo]),
        "_celld_toolchain": attrs.toolchain_dep(default = "toolchains//:celld", providers = [CelldToolchain]),
        "_runner": attrs.exec_dep(default = "root//src/celld/box/browser:runner", providers = [RunInfo]),
    },
)

def browser_test(name: str, main: str, deps: list[str], srcs: list[str] = []):
    """Bundle a Deno.test driver, then run it against a fresh private fixture.

    Driver imports @celld/box/browser and uses withBrowserFixture. Buck supplies
    CELLD_BROWSER_ENDPOINT and CELLD_BROWSER_TOKEN. Only loopback network and
    those two environment variables are granted to the driver. No Docker socket,
    filesystem, subprocesses, external network, or production credentials.
    The default fixture always requires runsc; absence is a failure, not a skip.
    """
    celld.worker(name = name + "-driver", main = main, srcs = srcs, deps = deps)
    _browser_test(
        name = name,
        driver = ":" + name + "-driver",
        project = "root//src/celld/box/browser:fixture",
    )
