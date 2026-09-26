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
    remote = ctx.attrs.mode == "remote"
    if ctx.attrs.mode not in ["local", "remote"]:
        fail("bootstrap.execution must be local or remote")

    # An unsupported client may analyze a remote graph, but must never execute
    # these Linux ELF programs locally or fall back to an unspecified executor.
    if not remote and not ctx.attrs.native_host:
        return [DefaultInfo(), ExecutionPlatformRegistrationInfo(platforms = [], fallback = "error")]

    options = {
        "local_enabled": not remote,
        "remote_enabled": remote,
        "remote_cache_enabled": remote,
        "use_windows_path_separators": False,
        "use_persistent_workers": False,
    }
    if remote:
        properties = dict(ctx.attrs.remote_properties)
        properties["OSFamily"] = "Linux"

        # The Go and OCI name, which BuildBuddy's executors register. Its
        # scheduler folds the case of both values but leaves x86_64 unmatched.
        properties["Arch"] = "amd64"
        options.update({
            "remote_execution_properties": properties,
            "remote_execution_use_case": ctx.attrs.remote_use_case,
            "remote_output_paths": "strict",
        })
    else:
        options["local_sandbox_mode"] = ctx.attrs.sandbox
        options["local_sandbox_write_paths"] = _SANDBOX_WRITE_PATHS
        if ctx.attrs.sandbox_read_paths != None:
            options["local_sandbox_read_paths"] = ctx.attrs.sandbox_read_paths

    configuration = ctx.attrs.platform[PlatformInfo].configuration
    executor = ExecutionPlatformInfo(
        # Native tools and outputs share one configuration, avoiding duplicate
        # compiler chains along execution dependencies.
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
    "remote_properties": attrs.dict(attrs.string(), attrs.string()),
    "remote_use_case": attrs.string(),
    "sandbox": attrs.string(),
    "sandbox_read_paths": attrs.option(attrs.list(attrs.string()), default = None),
})

def execution_platform(name, platform, **kwargs):
    host = host_info()
    _execution_platform(
        name = name,
        platform = platform,
        mode = read_root_config("bootstrap", "execution", "local"),
        native_host = host.os.is_linux and host.arch.is_x86_64,
        remote_properties = json.decode(read_root_config("bootstrap", "remote_properties", "{}")),
        remote_use_case = read_root_config("bootstrap", "remote_use_case", "buck2-bootstrap"),
        sandbox = read_root_config("buck2", "local_sandbox_mode", "disabled"),
        **kwargs
    )
