# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//utils:buckconfig.bzl", "read_choice")
load("@prelude//cfg/modifier:conditional_modifier.bzl", "conditional_modifier")

load("@root//buck/lib/tar:defs.bzl", "tar_file")
load("@root//buck/lib/oci:defs.bzl", "oci_image", "oci_pull", "oci_push")
load("@toolchains//golang:defs.bzl", "go_binary", "go_library")

# MARK: Package metadata handling

def _apply_package_target_compatible_with(kwargs):
    """Apply target_compatible_with from package metadata if not explicitly provided."""
    # If user explicitly sets target_compatible_with to None, we respect that and don't apply defaults
    if 'target_compatible_with' in kwargs and kwargs['target_compatible_with'] == None:
        # Remove the None value so it doesn't get passed to the rule
        kwargs.pop('target_compatible_with')
        return kwargs

    # If user provides their own target_compatible_with, use it
    if 'target_compatible_with' in kwargs:
        return kwargs

    # Otherwise, check for package default
    pkg_compat = read_package_value('meta.target_compatible_with')
    if pkg_compat != None:
        kwargs['target_compatible_with'] = pkg_compat

    return kwargs

def _fix_kwargs(_rule_name: str, kwargs):
    """Apply all package-level defaults and fixes to rule kwargs.

    Args:
        _rule_name: The name of the rule being called (e.g., "rust_library", "cxx_binary") - currently unused but reserved for future use
        kwargs: The keyword arguments passed to the rule

    This is the central place to add new package-level defaults that should
    be applied to rules. Add new fixes here as needed, and they can be
    customized per rule type.
    """
    kwargs = _apply_package_target_compatible_with(kwargs)

    # Add more fixes here as needed in the future
    # Example of rule-specific handling:
    # if rule_name.startswith("rust_"):
    #     kwargs = _apply_rust_specific_fixes(kwargs)
    # elif rule_name.startswith("cxx_"):
    #     kwargs = _apply_cxx_specific_fixes(kwargs)

    return kwargs

# MARK: Basic shims

DEPOT_VERSION = '2025.0+0'

# wrap native.rust_*, but provide some extra default args
def _depot_rust_rule(rule_name: str, **kwargs):
    kwargs = _fix_kwargs(rule_name, kwargs)

    edition = kwargs.pop('edition', '2021')
    env = {
        'DEPOT_VERSION': DEPOT_VERSION,
    } | kwargs.pop('env', {})
    rustc_flags = [
        #'--cfg=buck_build',
    ] + kwargs.pop('rustc_flags', [])

    build_config = read_choice("project", "buildmode", [
        "debug",
        "release",
    ], "debug")

    fn = getattr(native, rule_name)
    fn(
        edition = edition,
        env = env,
        rustc_flags = rustc_flags,
        incremental_enabled = build_config == "debug",
        **kwargs,
    )

def _depot_rust_library(**kwargs):
    _depot_rust_rule('rust_library', **kwargs)

def _depot_rust_binary(**kwargs):
    allow_cache_upload = kwargs.pop('allow_cache_upload', True)
    kwargs['allow_cache_upload'] = allow_cache_upload
    _depot_rust_rule('rust_binary', **kwargs)

def _depot_rust_test(**kwargs):
    _depot_rust_rule('rust_test', **kwargs)

def _depot_cxx_library(**kwargs):
    kwargs = _fix_kwargs("cxx_library", kwargs)
    allow_cache_upload = kwargs.pop('allow_cache_upload', True)
    kwargs['allow_cache_upload'] = allow_cache_upload
    native.cxx_library(**kwargs)

def _depot_cxx_binary(**kwargs):
    kwargs = _fix_kwargs("cxx_binary", kwargs)
    allow_cache_upload = kwargs.pop('allow_cache_upload', True)
    kwargs['allow_cache_upload'] = allow_cache_upload
    native.cxx_binary(**kwargs)

def _depot_cxx_genrule(**kwargs):
    native.cxx_genrule(**kwargs)

def _depot_prebuilt_cxx_library(**kwargs):
    kwargs = _fix_kwargs("prebuilt_cxx_library", kwargs)
    allow_cache_upload = kwargs.pop('allow_cache_upload', True)
    kwargs['allow_cache_upload'] = allow_cache_upload
    native.prebuilt_cxx_library(**kwargs)

def _depot_export_file(**kwargs):
    kwargs = _fix_kwargs("export_file", kwargs)
    native.export_file(**kwargs)

def _depot_genrule(**kwargs):
    kwargs = _fix_kwargs("genrule", kwargs)
    native.genrule(**kwargs)

def _depot_filegroup(**kwargs):
    kwargs = _fix_kwargs("filegroup", kwargs)
    native.filegroup(**kwargs)

# MARK: Supplemental rules

def _write_file_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.write(output, "\n".join(ctx.attrs.contents))
    return [
        DefaultInfo(default_output = output),
    ]

_write_file_rule = rule(
    impl = _write_file_impl,
    attrs = {
        "contents": attrs.list(attrs.string()),
    }
)

def _write_file(**kwargs):
    kwargs = _fix_kwargs("write_file", kwargs)
    _write_file_rule(**kwargs)

def _copy_files_impl(ctx: AnalysisContext) -> list[Provider]:
    srcs = {
        name: src
        for name, src in ctx.attrs.srcs.items()
    }

    outdir = ctx.actions.declare_output(ctx.label.name, dir = True)
    outdir = ctx.actions.copied_dir(
        outdir,
        srcs,
    )

    return [
        DefaultInfo(
            default_output = outdir,
            sub_targets = {
                name: [ DefaultInfo(default_output = outdir.project(name)) ]
                for name in ctx.attrs.srcs.keys()
            }
        ),
    ]

_copy_files_rule = rule(
    impl = _copy_files_impl,
    attrs = {
        "srcs": attrs.dict(attrs.string(), attrs.source()),
    }
)

def _copy_files(**kwargs):
    kwargs = _fix_kwargs("copy_files", kwargs)
    _copy_files_rule(**kwargs)

_command_test_rule = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args(ctx.attrs.cmd)),
        ExternalRunnerTestInfo(
            type = "custom",
            command = ctx.attrs.cmd,
        )
    ],
    attrs = {
        "cmd": attrs.list(attrs.arg()),
    }
)

def _command_test(**kwargs):
    kwargs = _fix_kwargs("command_test", kwargs)
    _command_test_rule(**kwargs)

_command_rule = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args(ctx.attrs.cmd)),
    ],
    attrs = {
        "cmd": attrs.list(attrs.arg()),
    }
)

def _command(**kwargs):
    kwargs = _fix_kwargs("command", kwargs)
    _command_rule(**kwargs)

_run_test_rule = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args(ctx.attrs.dep[RunInfo].args)),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [ ctx.attrs.dep[RunInfo].args ],
        )
    ],
    attrs = {
        "dep": attrs.dep(providers = [RunInfo])
    }
)

def _run_test(**kwargs):
    kwargs = _fix_kwargs("run_test", kwargs)
    _run_test_rule(**kwargs)

# starlark has no 'rjust', and 'format' does not support padding with
# zeros, so we have to do this manually.
def rjust(s: str, pad: str, width: int) -> str:
    if len(s) >= width:
        return s
    return pad * (width - len(s)) + s

# MARK: Utilities

def _hash_chance(seed: typing.Any, percent: int) -> bool:
    """
    Given a probability `p` to describe an event happening, and input seed `s`,
    return `True` if the event should happen, or `False` otherwise.
    """
    s = seed if isinstance(seed, str) else str(seed)
    h = hash(s)
    h = -h if h < 0 else h
    return (True if (h % 100) < percent else False)

def _hash_chance_ctx(ctx: AnalysisContext, percent: int) -> bool:
    """
    Given a probability `p` to describe an event happening, and input `ctx` object,
    return `True` if the event should happen, or `False` otherwise.
    """
    return _hash_chance(ctx.label, percent=percent)

def _enforce_starlark_memory_limit(bytes: [None, int] = None):
    """
    Set the peak memory usage for a BUILD file. This is mostly useful as a diagnostic tool when
    writing BUILD files since it can be included conveniently; it is not intended to be used
    everywhere all the time, at least not for now.
    """
    root_config_value = read_config("buck2", "default_starlark_peak_memory")
    if root_config_value != None:
        root_config_value = int(root_config_value)
    else:
        root_config_value = 0

    bytes = bytes if bytes != None else root_config_value

    if bytes > 0:
        set_starlark_peak_allocated_byte_limit(bytes)

# Easier setting of constraints and values
def _constraint(name, values):
    """Declare a constraint setting with a set of values."""
    native.constraint_setting(name = name)
    for value in values:
        native.constraint_value(
            name = value,
            constraint_setting = ":{}".format(name),
        )

def _platform(**kwargs):
    native.platform(**kwargs)

def _alias(**kwargs):
    native.alias(**kwargs)

def _config_setting(**kwargs):
    native.config_setting(**kwargs)

def _toolchain_alias(**kwargs):
    native.toolchain_alias(**kwargs)

def _http_archive(**kwargs):
    native.http_archive(**kwargs)

def _git_fetch(**kwargs):
    native.git_fetch(**kwargs)

def _test_suite(**kwargs):
    kwargs = _fix_kwargs("test_suite", kwargs)
    native.test_suite(**kwargs)

# MARK: Public API

shims = struct(
    rust_library = _depot_rust_library,
    rust_binary = _depot_rust_binary,
    rust_test = _depot_rust_test,

    ocaml_binary = lambda **kwargs: native.ocaml_binary(**_fix_kwargs("ocaml_binary", kwargs)),
    ocaml_library = lambda **kwargs: native.ocaml_library(**_fix_kwargs("ocaml_library", kwargs)),

    go_binary = lambda **kwargs: go_binary(**_fix_kwargs("go_binary", kwargs)),
    go_library = lambda **kwargs: go_library(**_fix_kwargs("go_library", kwargs)),

    cxx_library = _depot_cxx_library,
    prebuilt_cxx_library = _depot_prebuilt_cxx_library,
    cxx_binary = _depot_cxx_binary,
    cxx_genrule = _depot_cxx_genrule,

    tar_file = tar_file,
    oci = struct(
        pull = oci_pull,
        push = oci_push,
        image = oci_image,
    ),

    write_file = _write_file,
    copy_files = _copy_files,
    export_file = _depot_export_file,
    genrule = _depot_genrule,
    filegroup = _depot_filegroup,

    constraint = _constraint,
    platform = _platform,
    alias = _alias,
    config_setting = _config_setting,
    toolchain_alias = _toolchain_alias,

    command_test = _command_test,
    run_test = _run_test,
    command = _command,
    rjust = rjust,

    chance = _hash_chance,
    chance_ctx = _hash_chance_ctx,
    starlark_memory_limit = _enforce_starlark_memory_limit,

    modifiers = struct(
        conditional = conditional_modifier,
    ),
    select = select,
    http_archive = _http_archive,
    git_fetch = _git_fetch,
    test_suite = _test_suite,
)
