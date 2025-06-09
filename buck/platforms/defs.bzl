# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//utils:buckconfig.bzl", "read_choice")
load("@root//buck/shims/shims.bzl", depot = "shims")

def constraint_with_values(name, values, **_kwargs):
    """Declare a constraint setting with a set of values."""
    depot.constraint(name, values)

def _execution_platform_impl(ctx: AnalysisContext) -> list[Provider]:
    name = ctx.label.raw_target()
    re_enabled = ctx.attrs.remote_enabled
    cache_enabled = ctx.attrs.cache_enabled

    constraints = dict()
    constraints.update(ctx.attrs.cpu_configuration[ConfigurationInfo].constraints)
    constraints.update(ctx.attrs.os_configuration[ConfigurationInfo].constraints)
    for x in ctx.attrs.constraints:
        constraints.update(x[ConfigurationInfo].constraints)
    cfg = ConfigurationInfo(constraints = constraints, values = {})

    # TODO FIXME (aseipp): support macos/windows RE
    re_enabled = re_enabled if ctx.attrs.os == "linux" else False

    # TODO FIXME (aseipp): weaken this?
    if re_enabled and not cache_enabled:
        fail("Remote execution cannot be enabled without caching enabled")

    cec_args = {} # arguments to pass to CommandExecutorConfig

    # Enable local execution
    cec_args["local_enabled"] = True
    # Default to no RE. Will be overridden if RE is enabled.
    cec_args["remote_enabled"] = False
    # Whether to use Windows path separators in command line arguments
    cec_args["use_windows_path_separators"] = ctx.attrs.os == "windows"

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
            "false"
        ) == "true"

        # If true, then if the preferred executor fails, the other executor will
        # be tried. This is mostly useful for remote-to-local fallback.
        allow_local_fallback = read_root_config(
            "buck2_re_client",
            "allow_local_fallback",
            "false"
        ) == "true"

        # If true, then if the preferred executor fails, the other executor will
        allow_local_fallback_on_failure = read_root_config(
            "buck2_re_client",
            "allow_local_fallback_on_failure",
            "false"
        ) == "true"

        # Enable remote execution for this platform
        cec_args["remote_enabled"] = True

        # The use case to use when communicating with RE.
        cec_args["remote_execution_use_case"] = "buck2-default"
        # Max file size that the RE system can support
        cec_args["remote_execution_max_input_files_mebibytes"] = None # default: 30 * 1024 * 1024 * 1024
        # Max time we're willing to wait in the RE queue
        cec_args["remote_execution_queue_time_threshold_s"] = None

        # Properties for remote execution for this platform. BuildBarn will
        # match these properties against the properties of the remote workers it
        # has attached; all fields must match.
        if ctx.attrs.os == "linux":
            cec_args["remote_execution_properties"] = {
                "OSFamily": "Linux",
                "container-image": "nix-bb-runner",
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
        cec_args["use_limited_hybrid"] = force_remote_exe

        # Fallback to local execution if the preferred executor fails.
        cec_args["allow_limited_hybrid_fallbacks"] = allow_local_fallback
        cec_args["allow_hybrid_fallbacks_on_failure"] = allow_local_fallback_on_failure

        # Apply the experimental low pass filter to local actions during hybrid
        # remote execution scenarios. In this case, RE-eligible actions that
        # have higher concurrency than the number of local daemon threads
        # available will be sent to RE.
        cec_args["experimental_low_pass_filter"] = not force_remote_exe

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

__execution_platform = rule(
    impl = _execution_platform_impl,
    attrs = {
        "cpu_configuration": attrs.dep(providers = [ConfigurationInfo]),
        "os_configuration": attrs.dep(providers = [ConfigurationInfo]),
        "constraints": attrs.list(attrs.dep(providers = [ConfigurationInfo]), default = []),
        "cpu": attrs.string(),
        "os": attrs.string(),

        "cache_enabled": attrs.bool(),
        "remote_enabled": attrs.bool(),
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

def generate_platforms(variants, constraints=[]):
    """Generate execution platforms for the given variants, as well as a default
    execution platform matching the host platform."""

    # We want to generate a remote-execution capable variant of every supported
    # platform (-re suffix) as well as a local variant (-local suffix) for the
    # current execution platform that buck2 is running on.
    default_alias_prefix = "none//fake:nonexistent"
    for (cpu, os) in variants:
        cpu_configuration = "config//cpu:{}".format(cpu)
        os_configuration = "config//os:{}".format(os)

        # always generate generate a remote-execution variant
        __execution_platform(
            name = "{}-{}-remote".format(cpu, os),
            cpu_configuration = cpu_configuration,
            os_configuration = os_configuration,
            constraints = constraints,
            remote_enabled = True,
            cache_enabled = True,
            cpu = cpu,
            os = os,
        )

        # and, if it matches the host platform: generate a -local variant and a
        # -cached variant, for locally uncached and cached builds, respectively
        if _host_cpu_configuration() == cpu_configuration and _host_os_configuration() == os_configuration:
            default_alias_prefix = "root//buck/platforms:{}-{}".format(cpu, os)
            __execution_platform(
                name = "{}-{}-local".format(cpu, os),
                cpu_configuration = cpu_configuration,
                os_configuration = os_configuration,
                constraints = constraints,
                remote_enabled = False,
                cache_enabled = False,
                cpu = cpu,
                os = os,
            )

            __execution_platform(
                name = "{}-{}-cached".format(cpu, os),
                cpu_configuration = cpu_configuration,
                os_configuration = os_configuration,
                constraints = constraints,
                remote_enabled = False,
                cache_enabled = True,
                cpu = cpu,
                os = os,
            )

    re_choice = read_choice(
        "buck2_re_client", "default_mode",
        ["full-remote", "cache-only", "none"],
        default = "none",
    )

    if re_choice == "full-remote":
        suffix = 'remote' if host_info().os.is_linux and not host_info().arch.is_aarch64 else 'cached'
        depot.alias(
            name = 'default',
            actual = f'{default_alias_prefix}-{suffix}',
        )
    elif re_choice == "cache-only":
        depot.alias(
            name = 'default',
            actual = f'{default_alias_prefix}-cached',
        )
    elif re_choice == "none":
        depot.alias(
            name = 'default',
            actual = f'{default_alias_prefix}-local',
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
