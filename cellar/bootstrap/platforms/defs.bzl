# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Cellar-owned configuration providers; no prelude rules are required."""

def _constraint_setting_impl(ctx):
    return [DefaultInfo(), ConstraintSettingInfo(label = ctx.label.raw_target())]

constraint_setting = rule(impl = _constraint_setting_impl, attrs = {}, is_configuration_rule = True)

def _constraint_value_impl(ctx):
    setting = ctx.attrs.setting[ConstraintSettingInfo]
    value = ConstraintValueInfo(setting = setting, label = ctx.label.raw_target())
    return [
        DefaultInfo(),
        value,
        ConfigurationInfo(constraints = {setting.label: value}, values = {}),
    ]

constraint_value = rule(impl = _constraint_value_impl, is_configuration_rule = True, attrs = {
    "setting": attrs.dep(providers = [ConstraintSettingInfo]),
})

def _platform_impl(ctx):
    constraints = {}
    for dep in ctx.attrs.constraint_values:
        value = dep[ConstraintValueInfo]
        if value.setting.label in constraints:
            fail("duplicate constraint setting: {}".format(value.setting.label))
        constraints[value.setting.label] = value
    return [
        DefaultInfo(),
        PlatformInfo(
            label = str(ctx.label.raw_target()),
            configuration = ConfigurationInfo(constraints = constraints, values = {}),
        ),
    ]

platform = rule(impl = _platform_impl, is_configuration_rule = True, attrs = {
    "constraint_values": attrs.list(attrs.dep(providers = [ConstraintValueInfo])),
})

# Bootstrap programs are static and read only their declared inputs, which
# Buck already exposes. musl's realpath resolves through /proc/self/fd.
# Setting either list replaces Buck's defaults.
BOOTSTRAP_READ_PATHS = ["/proc/self"]

# Buck's default Landlock write list plus the pseudo-terminal devices, so a
# test can drive an interactive shell.
_SANDBOX_WRITE_PATHS = [
    "/dev/null",
    "/dev/zero",
    "/dev/urandom",
    "/dev/random",
    "/dev/ptmx",
    "/dev/pts",
]

def _execution_platform_impl(ctx):
    remote = ctx.attrs.mode == "remote" or (ctx.attrs.mode == "auto" and ctx.attrs.cpu in ctx.attrs.remote_cpus)
    local = ctx.attrs.mode != "remote" and ctx.attrs.native_host
    if ctx.attrs.mode not in ["local", "remote", "auto"]:
        fail("bootstrap.execution must be local, remote or auto")

    # An unsupported client may analyze a remote graph, but must never execute
    # these Linux ELF programs locally or fall back to an unspecified executor.
    if not remote and not local:
        return [DefaultInfo(), ExecutionPlatformRegistrationInfo(platforms = [], fallback = "error")]

    options = {
        "local_enabled": local,
        "remote_enabled": remote,
        "remote_cache_enabled": ctx.attrs.mode != "local",
        "use_windows_path_separators": False,
        "use_persistent_workers": False,
    }
    if ctx.attrs.mode != "local":
        properties = dict(ctx.attrs.remote_properties)
        properties["OSFamily"] = "Linux"

        # The Go and OCI name, which BuildBuddy's executors register. Its
        # scheduler folds the case of both values but leaves x86_64 unmatched.
        properties["Arch"] = ctx.attrs.cpu
        options.update({
            # Local cache actions and remote actions must use identical RE
            # metadata, and cache reads alone do not enable result uploads.
            "allow_cache_uploads": ctx.attrs.cache_uploads,
            "remote_execution_properties": properties,
            "remote_execution_use_case": ctx.attrs.remote_use_case,
            "remote_output_paths": "strict",
        })
    if local:
        options["local_sandbox_mode"] = ctx.attrs.sandbox
        options["local_sandbox_write_paths"] = _SANDBOX_WRITE_PATHS
        if ctx.attrs.sandbox_read_paths != None:
            options["local_sandbox_read_paths"] = ctx.attrs.sandbox_read_paths

    configuration = ctx.attrs.platform[PlatformInfo].configuration
    executor = ExecutionPlatformInfo(
        # Tools and outputs of one ABI share one configuration, avoiding
        # duplicate compiler chains along execution dependencies.
        label = ctx.attrs.platform.label.raw_target(),
        configuration = configuration,
        executor_config = CommandExecutorConfig(**options),
    )
    return [
        DefaultInfo(),
        executor,
        ExecutionPlatformRegistrationInfo(platforms = [executor], fallback = "error"),
    ]

_execution_platform = rule(impl = _execution_platform_impl, is_configuration_rule = True, attrs = {
    "platform": attrs.dep(providers = [PlatformInfo]),
    "mode": attrs.string(),
    "native_host": attrs.bool(),
    "cpu": attrs.string(),
    "remote_cpus": attrs.list(attrs.string()),
    "cache_uploads": attrs.bool(),
    "remote_properties": attrs.dict(attrs.string(), attrs.string()),
    "remote_use_case": attrs.string(),
    "sandbox": attrs.string(),
    "sandbox_read_paths": attrs.option(attrs.list(attrs.string()), default = None),
})

def execution_platform(name, platform, cpu = "amd64", **kwargs):
    host = host_info()
    mode = read_root_config("bootstrap", "execution", "local")
    _execution_platform(
        name = name,
        platform = platform,
        mode = mode,
        cpu = cpu,
        native_host = host.os.is_linux and (host.arch.is_x86_64 if cpu == "amd64" else host.arch.is_aarch64 if cpu == "arm64" else False),
        remote_cpus = read_root_config("bootstrap", "remote_cpus", "amd64").split(","),
        cache_uploads = read_root_config("buck2_re_client", "cache_upload", "true") == "true",
        remote_properties = json.decode(read_root_config("bootstrap", "remote_properties", "{}")),
        remote_use_case = read_root_config("bootstrap", "remote_use_case", "buck2-bootstrap"),
        sandbox = read_root_config("buck2", "local_sandbox_mode", "native" if mode == "auto" else "disabled"),
        **kwargs
    )

def _execution_platforms_impl(ctx):
    return [DefaultInfo(), ExecutionPlatformRegistrationInfo(
        platforms = [platform for dep in ctx.attrs.platforms for platform in dep[ExecutionPlatformRegistrationInfo].platforms],
        fallback = "error",
    )]

execution_platforms = rule(impl = _execution_platforms_impl, is_configuration_rule = True, attrs = {
    "platforms": attrs.list(attrs.dep(providers = [ExecutionPlatformRegistrationInfo])),
})

def _platform_transition_impl(ctx):
    destination = ctx.attrs.platform[PlatformInfo]

    def change_platform(platform):
        _ = platform
        return destination

    return [DefaultInfo(), TransitionInfo(impl = change_platform)]

# A fixed bootstrap predecessor must retain its configuration even when an
# aarch64 target consumes its sources or cross compiler.
platform_transition = rule(impl = _platform_transition_impl, is_configuration_rule = True, attrs = {
    "platform": attrs.dep(providers = [PlatformInfo]),
})

def _alias_impl(ctx):
    return ctx.attrs.actual.providers

amd64_dep = rule(impl = _alias_impl, attrs = {
    "actual": attrs.transition_dep(cfg = "cellar//bootstrap/platforms:to-amd64"),
})

alias = rule(impl = _alias_impl, attrs = {"actual": attrs.dep()})
