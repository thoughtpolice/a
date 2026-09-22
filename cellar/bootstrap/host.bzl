# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# This file loads nothing. The parent project's execution platform depends on
# cellar//bootstrap/platforms, so keeping that package's loads small keeps
# unrelated cellar edits out of the parent's target determination.

def host_test_executor(dep: Dependency) -> CommandExecutorConfig | None:
    platform = dep.get(ExecutionPlatformInfo)
    return platform.executor_config if platform else None

def _host_python_test_impl(ctx: AnalysisContext) -> list[Provider]:
    return [
        DefaultInfo(),
        ExternalRunnerTestInfo(
            type = "simple",
            command = [
                "python3",
                cmd_args(ctx.attrs.src, hidden = ctx.attrs.resources),
            ] + ctx.attrs.args,
            labels = ctx.attrs.labels,
            default_executor = host_test_executor(ctx.attrs._executor),
            run_from_project_root = True,
            use_project_relative_paths = True,
        ),
    ]

# The audit scripts are host-side validation tools, never inputs to bootstrap
# actions, so their tests run with the client's python3 from PATH.
host_python_test = rule(impl = _host_python_test_impl, attrs = {
    "src": attrs.source(),
    "resources": attrs.list(attrs.source(), default = []),
    "args": attrs.list(attrs.string(), default = []),
    "labels": attrs.list(attrs.string(), default = []),
    "_executor": attrs.dep(default = "cellar//bootstrap/platforms:host-tests"),
})
