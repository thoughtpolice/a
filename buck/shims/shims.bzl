# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//utils/buckconfig.bzl", "read_choice")
load("@prelude//cfg/modifier:conditional_modifier.bzl", "conditional_modifier")

load("@root//buck/lib/tar:defs.bzl", "tar_file")
load("@root//buck/lib/oci:defs.bzl", "oci_image", "oci_pull", "oci_push")

# MARK: Basic shims

DEPOT_VERSION = '2025.0+0'

# wrap native.rust_*, but provide some extra default args
def _depot_rust_rule(rule_name: str, **kwargs):
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
    allow_cache_upload = kwargs.pop('allow_cache_upload', True)
    kwargs['allow_cache_upload'] = allow_cache_upload
    native.cxx_library(**kwargs)

def _depot_cxx_binary(**kwargs):
    allow_cache_upload = kwargs.pop('allow_cache_upload', True)
    kwargs['allow_cache_upload'] = allow_cache_upload
    native.cxx_binary(**kwargs)

def _depot_prebuilt_cxx_library(**kwargs):
    allow_cache_upload = kwargs.pop('allow_cache_upload', True)
    kwargs['allow_cache_upload'] = allow_cache_upload
    native.prebuilt_cxx_library(**kwargs)

def _depot_export_file(**kwargs):
    native.export_file(**kwargs)

def _depot_genrule(**kwargs):
    native.genrule(**kwargs)

def _depot_filegroup(**kwargs):
    native.filegroup(**kwargs)

# MARK: Supplemental rules

def _write_file_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.write(output, "\n".join(ctx.attrs.contents))
    return [
        DefaultInfo(default_output = output),
    ]

_write_file = rule(
    impl = _write_file_impl,
    attrs = {
        "contents": attrs.list(attrs.string()),
    }
)

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

_copy_files = rule(
    impl = _copy_files_impl,
    attrs = {
        "srcs": attrs.dict(attrs.string(), attrs.source()),
    }
)

_command_test = rule(
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

_command = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args(ctx.attrs.cmd)),
    ],
    attrs = {
        "cmd": attrs.list(attrs.arg()),
    }
)

_run_test = rule(
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

# starlark has no 'rjust', and 'format' does not support padding with
# zeros, so we have to do this manually.
def rjust(s: str, pad: str, width: int) -> str:
    if len(s) >= width:
        return s
    return pad * (width - len(s)) + s

# Easier setting of constraints and values
def _constraint(name, values):
    """Declare a constraint setting with a set of values."""
    native.constraint_setting(name = name)
    for value in values:
        native.constraint_value(
            name = value,
            constraint_setting = ":{}".format(name),
        )

# MARK: Public API

shims = struct(
    rust_library = _depot_rust_library,
    rust_binary = _depot_rust_binary,
    rust_test = _depot_rust_test,

    ocaml_binary = native.ocaml_binary,
    ocaml_library = native.ocaml_library,

    cxx_library = _depot_cxx_library,
    prebuilt_cxx_library = _depot_prebuilt_cxx_library,
    cxx_binary = _depot_cxx_binary,

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

    command_test = _command_test,
    run_test = _run_test,
    command = _command,
    rjust = rjust,

    modifiers = struct(
        conditional = conditional_modifier,
    )
)
