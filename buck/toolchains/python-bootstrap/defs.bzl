# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(
    "@prelude//python_bootstrap:toolchain.bzl",
    "PythonBootstrapToolchainInfo",
)

def _simple_exe_download(ctx):
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.download_file(
        output.as_output(),
        ctx.attrs.url,
        sha256 = ctx.attrs.sha256,
        is_executable = True,
    )
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args([output])),
    ]

simple_exe_download = rule(
    impl = _simple_exe_download,
    attrs = {
        "url": attrs.string(),
        "sha256": attrs.string(),
    },
)

def _standalone_python_download(ctx):
    output = ctx.actions.declare_output("tar", ctx.label.name)
    ctx.actions.download_file(
        output.as_output(),
        ctx.attrs.url,
        sha256 = ctx.attrs.sha256,
    )

    out_dir = ctx.actions.declare_output("dir", ctx.label.name, dir = True)
    ctx.actions.run(
        cmd_args([
            ctx.attrs.smoltar[DefaultInfo].default_outputs[0],
            "-x",
            output,
            out_dir.as_output(),
        ]),
        category = "system_tar",
    )

    bin = out_dir.project(ctx.attrs.exe)
    return [
        DefaultInfo(
            default_output = out_dir,
            sub_targets = {
                "tar": [DefaultInfo(default_output = output)],
                ctx.attrs.exe: [DefaultInfo(default_output = bin)],
            },
        ),
        RunInfo(args = cmd_args([bin])),
    ]

standalone_python_download = rule(
    impl = _standalone_python_download,
    attrs = {
        "url": attrs.string(),
        "sha256": attrs.string(),
        "exe": attrs.string(),
        "smoltar": attrs.exec_dep(),
    },
)

def _windows_python_download(ctx):
    archive = ctx.actions.declare_output("zip", ctx.label.name + ".zip")
    ctx.actions.download_file(
        archive.as_output(),
        ctx.attrs.url,
        sha256 = ctx.attrs.sha256,
    )

    # Windows' own bsdtar reads zip files, and its cmd's mkdir makes the
    # directory and its parents. The embeddable package's ._pth file is left
    # out: while it is there, Python runs isolated, without the script's own
    # directory on sys.path, where a bootstrap binary's modules are, and
    # ignoring PYTHONPATH. Without it, the interpreter finds its standard
    # library in the zip beside it, and its extension modules beside that.
    out_dir = ctx.actions.declare_output("dir", ctx.label.name, dir = True)
    ctx.actions.run(
        cmd_args(
            "cmd.exe",
            "/c",
            "mkdir",
            out_dir.as_output(),
            "&&",
            "%SystemRoot%\\System32\\tar.exe",
            "-x",
            "-f",
            archive,
            "-C",
            out_dir.as_output(),
            "--exclude",
            "*._pth",
        ),
        category = "unzip_python",
    )

    python = out_dir.project("python.exe")
    return [
        DefaultInfo(
            default_output = out_dir,
            sub_targets = {
                "python.exe": [DefaultInfo(default_output = python)],
            },
        ),
        RunInfo(args = cmd_args(python, hidden = out_dir)),
    ]

# The embeddable package of a python.org release for Windows: a zip of the
# interpreter, its DLLs and extension modules, and its standard library,
# compiled and zipped again. python-build-standalone has no Windows arm64
# build of the release the other platforms use; python.org has both.
windows_python_download = rule(
    impl = _windows_python_download,
    attrs = {
        "url": attrs.string(),
        "sha256": attrs.string(),
    },
)

def _standalone_python_runtime(ctx: AnalysisContext) -> list[Provider]:
    install = ctx.attrs.python[DefaultInfo].default_outputs[0].project("python")
    out = ctx.actions.declare_output("runtime", dir = True)
    ctx.actions.run(
        cmd_args(
            # The install's own interpreter, which needs the rest of the
            # install to start.
            cmd_args(install.project("bin/python3"), hidden = install),
            "-I",
            ctx.attrs.script,
            install,
            out.as_output(),
        ),
        category = "python_runtime",
    )
    python = out.project("bin/python3")
    return [
        DefaultInfo(default_output = out, sub_targets = {
            "python": [DefaultInfo(default_output = python)],
        }),
        RunInfo(args = cmd_args(python, hidden = out)),
    ]

# The smallest runtime of a python-build-standalone install that runs the
# prelude's bootstrap scripts: its interpreter, libpython and the standard
# library, compiled and zipped (see make_runtime.py). Every action that runs a
# bootstrap script takes the interpreter's files as inputs, and a remote worker
# lays them out for each one, so a whole install, at thousands of files, costs
# every such action.
standalone_python_runtime = rule(
    impl = _standalone_python_runtime,
    attrs = {
        "python": attrs.dep(),
        "script": attrs.source(),
    },
)

def _standalone_python_bootstrap(ctx):
    args = cmd_args([ctx.attrs.interpreter])
    return [
        DefaultInfo(),
        RunInfo(args = args),
        PythonBootstrapToolchainInfo(interpreter = args),
    ]

standalone_python_bootstrap_toolchain = rule(
    impl = _standalone_python_bootstrap,
    attrs = {
        "interpreter": attrs.arg(),
    },
    is_toolchain_rule = True,
)
