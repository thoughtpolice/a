# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//utils:buckconfig.bzl", "read_choice")
load("@root//buck/shims:shims.bzl", "shims")

def _platform_impl(ctx: AnalysisContext) -> list[Provider]:
    constraints = dict()
    constraints.update(ctx.attrs.cpu_configuration[ConfigurationInfo].constraints)
    constraints.update(ctx.attrs.os_configuration[ConfigurationInfo].constraints)
    for x in ctx.attrs.constraints:
        constraints.update(x[ConfigurationInfo].constraints)
    return [
        DefaultInfo(),
        PlatformInfo(
            label = str(ctx.label.raw_target()),
            configuration = ConfigurationInfo(constraints = constraints, values = {}),
        ),
    ]

# One cpu and os, the configuration every executor of them presents. A target
# that must build for a particular cpu and os on any client, like the x86_64
# bootstrap in cellar//bootstrap, takes it as its target platform.
__platform = rule(
    impl = _platform_impl,
    attrs = {
        "cpu_configuration": attrs.dep(providers = [ConfigurationInfo]),
        "os_configuration": attrs.dep(providers = [ConfigurationInfo]),
        "constraints": attrs.list(attrs.dep(providers = [ConfigurationInfo]), default = []),
    },
)

# RE platform properties name the cpu as Go and OCI do, which is what
# BuildBuddy's executors register.
_RE_ARCH = {
    "arm64": "arm64",
    "x86_64": "amd64",
}

def _execution_platform_impl(ctx: AnalysisContext) -> list[Provider]:
    name = ctx.attrs.platform.label.raw_target()
    cfg = ctx.attrs.platform[PlatformInfo].configuration
    re_enabled = ctx.attrs.remote_enabled
    cache_enabled = ctx.attrs.cache_enabled
    local_enabled = ctx.attrs.local_enabled

    # TODO FIXME (aseipp): support macos/windows RE
    re_enabled = re_enabled if ctx.attrs.os == "linux" else False

    # TODO FIXME (aseipp): weaken this?
    if re_enabled and not cache_enabled:
        fail("Remote execution cannot be enabled without caching enabled")
    if not (local_enabled or re_enabled):
        fail("An execution platform must execute either locally or remotely")

    cec_args = {}  # arguments to pass to CommandExecutorConfig

    # Run actions on this machine. Only an executor for the host's own cpu and
    # os may; the others exist to send actions to remote workers.
    cec_args["local_enabled"] = local_enabled

    # Default to no RE. Will be overridden if RE is enabled.
    cec_args["remote_enabled"] = False

    # Whether to use Windows path separators in command line arguments
    cec_args["use_windows_path_separators"] = ctx.attrs.os == "windows"

    # EXPERIMENTAL(aseipp): enable sandboxing of local actions for this executor
    # if asked. 'symlink' or 'landlock'. linux only right now.
    sandbox_choice = read_root_config("buck2", "local_sandbox_mode", "disabled")
    if sandbox_choice != "disabled":
        cec_args["local_sandbox_mode"] = sandbox_choice

        # Paths that replace Buck's default lists of what a sandboxed action
        # may read or write beyond its own inputs and outputs.
        if ctx.attrs.sandbox_read_paths != None:
            cec_args["local_sandbox_read_paths"] = ctx.attrs.sandbox_read_paths
        if ctx.attrs.sandbox_write_paths != None:
            cec_args["local_sandbox_write_paths"] = ctx.attrs.sandbox_write_paths

    if cache_enabled:
        # Use and query the RE cache
        cec_args["remote_cache_enabled"] = True

        # Cache dep files, too
        cec_args["remote_dep_file_cache_enabled"] = True

        # Whether to upload local actions to the RE cache
        cec_args["allow_cache_uploads"] = (read_root_config("buck2_re_client", "cache_upload", "false") == "true")

        # How to express output paths to RE. This is used internally for the
        # FB RE implementation and the FOSS implementation; strict means that
        # the RE implementation should expect the output paths to be specified
        # as files or directories in all cases, and that's what the Remote
        # Execution API expects. So this will never change.
        cec_args["remote_output_paths"] = "strict"

    if re_enabled:
        # Whether or not to force remote execution. If true, all eligible
        # actions will be sent to RE. Otherwise, the hybrid executor will be
        # used, and actions will be mixed between local and remote execution.
        force_remote_exe = read_root_config(
            "buck2_re_client",
            "force_remote",
            "false",
        ) == "true"

        # If true, then if the preferred executor fails, the other executor will
        # be tried. This is mostly useful for remote-to-local fallback.
        allow_local_fallback = read_root_config(
            "buck2_re_client",
            "allow_local_fallback",
            "false",
        ) == "true"

        # If true, then if the preferred executor fails, the other executor will
        allow_local_fallback_on_failure = read_root_config(
            "buck2_re_client",
            "allow_local_fallback_on_failure",
            "false",
        ) == "true"

        # Enable remote execution for this platform
        cec_args["remote_enabled"] = True

        # The use case to use when communicating with RE.
        cec_args["remote_execution_use_case"] = "buck2-default"

        # Max file size that the RE system can support
        cec_args["remote_execution_max_input_files_mebibytes"] = None  # default: 30 * 1024 * 1024 * 1024

        # Max time we're willing to wait in the RE queue
        cec_args["remote_execution_queue_time_threshold_s"] = None

        # Properties for remote execution for this platform. BuildBarn will
        # match these properties against the properties of the remote workers it
        # has attached; all fields must match. Arch keeps one cpu's actions off
        # another's workers, now that a client registers remote executors for
        # cpus besides its own.
        if ctx.attrs.os == "linux":
            cec_args["remote_execution_properties"] = {
                "OSFamily": "Linux",
                "Arch": _RE_ARCH[ctx.attrs.cpu],
                "container-image": ctx.attrs.container_image,
            }
        elif ctx.attrs.os == "macos":
            cec_args["remote_execution_properties"] = {
                "OSFamily": "Darwin",
                # ...
            }
        elif ctx.attrs.os == "windows":
            cec_args["remote_execution_properties"] = {
                "OSFamily": "Windows",
                # ...
            }
        else:
            fail("Invalid OS for remote execution: {}".format(ctx.attrs.os))

        # Whether to use the "limited" hybrid executor. If the hybrid executor
        # is active, by default, it will race the two executors to completion
        # until one finishes. If the limited hybrid executor is enabled, then
        # both are exposed, but only the preferred one is chosen
        cec_args["use_limited_hybrid"] = force_remote_exe or not local_enabled

        # Fallback to local execution if the preferred executor fails.
        cec_args["allow_limited_hybrid_fallbacks"] = allow_local_fallback and local_enabled
        cec_args["allow_hybrid_fallbacks_on_failure"] = allow_local_fallback_on_failure and local_enabled

        # Apply the experimental low pass filter to local actions during hybrid
        # remote execution scenarios. In this case, RE-eligible actions that
        # have higher concurrency than the number of local daemon threads
        # available will be sent to RE.
        cec_args["experimental_low_pass_filter"] = not force_remote_exe and local_enabled

    exe_platform = ExecutionPlatformInfo(
        label = name,
        configuration = cfg,
        executor_config = CommandExecutorConfig(**cec_args),
    )

    return [
        DefaultInfo(),
        exe_platform,
        PlatformInfo(label = str(name), configuration = cfg),
        ExecutionPlatformRegistrationInfo(platforms = [exe_platform]),
    ]

_execution_platform_rule = rule(
    impl = _execution_platform_impl,
    attrs = {
        "platform": attrs.dep(providers = [PlatformInfo]),
        "cpu": attrs.string(),
        "os": attrs.string(),
        "cache_enabled": attrs.bool(),
        "local_enabled": attrs.bool(),
        "remote_enabled": attrs.bool(),
        "container_image": attrs.string(),
        "sandbox_read_paths": attrs.option(attrs.list(attrs.string()), default = None),
        "sandbox_write_paths": attrs.option(attrs.list(attrs.string()), default = None),
    },
)

def _sandbox_paths(kind: str) -> list[str] | None:
    paths = read_root_config("buck2", "local_sandbox_{}_paths".format(kind), "")
    return [p.strip() for p in paths.split(",")] if paths else None

def __execution_platform(**kwargs):
    _execution_platform_rule(
        # The image remote Linux actions run in.
        container_image = read_root_config("buck2_re_client", "container_image", "nix-bb-runner"),
        # Comma-separated paths that replace Buck's default lists of what a
        # sandboxed action may read or write. The full-source bootstrap in
        # cellar//bootstrap, say, reads nothing from the host, so a sandbox
        # there can grant just /proc/self.
        sandbox_read_paths = _sandbox_paths("read"),
        sandbox_write_paths = _sandbox_paths("write"),
        **kwargs
    )

def _execution_platforms_impl(ctx: AnalysisContext) -> list[Provider]:
    platforms = []
    for dep in ctx.attrs.registrations:
        platforms.extend(dep[ExecutionPlatformRegistrationInfo].platforms)
    return [DefaultInfo(), ExecutionPlatformRegistrationInfo(platforms = platforms)]

# Buck reads one build.execution_platforms target and gives each target the
# first of its platforms that the target's exec_compatible_with and exec deps
# accept.
__execution_platforms = rule(
    impl = _execution_platforms_impl,
    attrs = {
        "registrations": attrs.list(attrs.dep(providers = [ExecutionPlatformRegistrationInfo])),
    },
)

def _host_cpu_configuration() -> str:
    arch = host_info().arch
    if arch.is_aarch64:
        return "config//cpu:arm64"
    else:
        return "config//cpu:x86_64"

def _host_os_configuration() -> str:
    os = host_info().os
    if os.is_macos:
        return "config//os:macos"
    elif os.is_windows:
        return "config//os:windows"
    else:
        return "config//os:linux"

def generate_platforms(variants, constraints = []):
    """Generate a platform and execution platforms for each of the given
    variants, a default execution platform matching the host platform, and the
    list of execution platforms this client registers."""

    re_choice = read_choice(
        "buck2_re_client",
        "default_mode",
        ["full-remote", "cache-only", "none"],
        default = "none",
    )

    # We want to generate a remote-execution capable variant of every supported
    # platform (-remote suffix) as well as a local variant (-local suffix) for
    # the current execution platform that buck2 is running on.
    default_alias_prefix = "none//fake:nonexistent"
    foreign_remote = []
    for (cpu, os) in variants:
        cpu_configuration = "config//cpu:{}".format(cpu)
        os_configuration = "config//os:{}".format(os)
        platform = ":{}-{}".format(cpu, os)
        host = _host_cpu_configuration() == cpu_configuration and _host_os_configuration() == os_configuration

        __platform(
            name = "{}-{}".format(cpu, os),
            cpu_configuration = cpu_configuration,
            os_configuration = os_configuration,
            constraints = constraints,
        )

        # generate a remote-execution variant of the host and of every Linux
        # platform, the only os with remote workers. Only the host's also runs
        # actions locally.
        if host or os == "linux":
            __execution_platform(
                name = "{}-{}-remote".format(cpu, os),
                platform = platform,
                local_enabled = host,
                remote_enabled = True,
                cache_enabled = True,
                cpu = cpu,
                os = os,
            )
        if not host and os == "linux":
            foreign_remote.append("{}-remote".format(platform))

        # and, if it matches the host platform: generate a -local variant and a
        # -cached variant, for locally uncached and cached builds, respectively
        if host:
            default_alias_prefix = "root//buck/platforms:{}-{}".format(cpu, os)
            __execution_platform(
                name = "{}-{}-local".format(cpu, os),
                platform = platform,
                local_enabled = True,
                remote_enabled = False,
                cache_enabled = False,
                cpu = cpu,
                os = os,
            )

            __execution_platform(
                name = "{}-{}-cached".format(cpu, os),
                platform = platform,
                local_enabled = True,
                remote_enabled = False,
                cache_enabled = True,
                cpu = cpu,
                os = os,
            )

    if re_choice == "full-remote":
        suffix = "remote" if host_info().os.is_linux and not host_info().arch.is_aarch64 else "cached"
        shims.alias(
            name = "default",
            actual = "{default_alias_prefix}-{suffix}".format(default_alias_prefix = default_alias_prefix, suffix = suffix),
        )
    elif re_choice == "cache-only":
        shims.alias(
            name = "default",
            actual = "{default_alias_prefix}-cached".format(default_alias_prefix = default_alias_prefix),
        )
    elif re_choice == "none":
        shims.alias(
            name = "default",
            actual = "{default_alias_prefix}-local".format(default_alias_prefix = default_alias_prefix),
        )

    # The host's executor comes first, and takes every target that does not ask
    # for another cpu or os. With remote execution on, the Linux workers of
    # every other cpu follow, so a target that requires one, such as the
    # x86_64 stages of cellar//bootstrap built from an arm64 client, runs there
    # and never on the client. Without it, such a target finds no executor.
    __execution_platforms(
        name = "execution",
        registrations = [":default"] + (foreign_remote if re_choice == "full-remote" else []),
    )

# NOTE: keep the list of default platforms here instead of in BUILD. why?
# because it keeps all the internal specifics like _host_cpu_configuration and
# _host_os_configuration literals all in one spot.
default_platforms = [
    ("arm64", "linux"),
    ("arm64", "macos"),
    #("arm64", "windows"),
    ("x86_64", "linux"),
    #("x86_64", "macos"),
    ("x86_64", "windows"),
]
