# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# --------------------------------------------------------------------------- #
# M2-Planet compilation pipeline (builds mes-m2 from C source)
# --------------------------------------------------------------------------- #

load("@cellar//bootstrap/platforms:rules.bzl", "native_attrs")

def __m2_planet(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    m2_planet = tools.project("M2-Planet")

    cmd = [
        m2_planet,
        "--debug",
        "--architecture",
        ctx.attrs.arch_stage0,
    ]

    for d in ctx.attrs.defines:
        cmd.extend(["-D", d])
    for f in ctx.attrs.srcs:
        cmd.extend(["-f", f])

    cmd.extend(["-o", output.as_output()])

    ctx.actions.run(
        cmd,
        env = {"PATH": tools},
        category = "mes_m2_planet",
        clear_environment = True,
    )
    return [DefaultInfo(default_output = output)]

_M2_Planet_rule = rule(impl = __m2_planet, attrs = {
    "tools": attrs.exec_dep(),
    "arch_stage0": attrs.string(),
    "arch_mes": attrs.string(),
    "defines": attrs.list(attrs.string(), default = []),
    "srcs": attrs.list(attrs.source()),
})

def M2_Planet(**kwargs):
    _M2_Planet_rule(**native_attrs(kwargs))

def _blood_elf_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    cmd = [tools.project("blood-elf"), ctx.attrs.args]
    for f in ctx.attrs.srcs:
        cmd.extend(["-f", f])
    cmd.extend(["-o", output.as_output()])
    ctx.actions.run(cmd, env = {"PATH": tools}, category = "mes_blood_elf", clear_environment = True)
    return [DefaultInfo(default_output = output)]

_blood_elf_rule = rule(impl = _blood_elf_impl, attrs = {
    "tools": attrs.exec_dep(),
    "args": attrs.list(attrs.arg()),
    "srcs": attrs.list(attrs.source()),
})

def blood_elf(**kwargs):
    _blood_elf_rule(**native_attrs(kwargs))

def _m1_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    cmd = [tools.project("M1"), ctx.attrs.args]
    for f in ctx.attrs.srcs:
        cmd.extend(["-f", f])
    cmd.extend(["-o", output.as_output()])
    ctx.actions.run(cmd, env = {"PATH": tools}, category = "mes_m1", clear_environment = True)
    return [DefaultInfo(default_output = output)]

_M1_rule = rule(impl = _m1_impl, attrs = {
    "tools": attrs.exec_dep(),
    "args": attrs.list(attrs.arg()),
    "srcs": attrs.list(attrs.source()),
})

def M1(**kwargs):
    _M1_rule(**native_attrs(kwargs))

def _hex2_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    cmd = [tools.project("hex2"), ctx.attrs.args]
    for f in ctx.attrs.srcs:
        cmd.extend(["-f", f])
    cmd.extend(["-o", output.as_output()])
    ctx.actions.run(cmd, env = {"PATH": tools}, category = "mes_hex2", clear_environment = True)
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

_hex2_rule = rule(impl = _hex2_impl, attrs = {
    "tools": attrs.exec_dep(),
    "args": attrs.list(attrs.arg()),
    "srcs": attrs.list(attrs.source()),
})

def hex2(**kwargs):
    _hex2_rule(**native_attrs(kwargs))

# --------------------------------------------------------------------------- #
# Shared mescc invocations
# --------------------------------------------------------------------------- #

def _object_name(path: str) -> str:
    """Name of the object mescc writes for a C source path, without suffix."""
    name = path.rsplit("/", 1)[-1]
    if not name.endswith(".c"):
        fail("mescc source must end in .c: " + path)
    return name[:-2]

def _unique_object_names(paths: list[str]) -> list[str]:
    names = []
    seen = {}
    for path in paths:
        name = _object_name(path)
        if name in seen:
            fail("mescc sources {} and {} both produce {}.o".format(seen[name], path, name))
        seen[name] = path
        names.append(name)
    return names

def _path(value, fmt, relative_to):
    if relative_to == None:
        return cmd_args(value, format = fmt)
    return cmd_args(value, format = fmt, relative_to = relative_to)

def _mescc_env(src_prefix, nyacc_modules, tools, libdir = None, relative_to = None) -> dict:
    """Environment for mescc.scm, with paths relative to `relative_to` if set."""
    return {
        "MES_PREFIX": _path(src_prefix, "{}", relative_to),
        "GUILE_LOAD_PATH": cmd_args(
            _path(src_prefix, "{}/mes/module", relative_to),
            _path(src_prefix, "{}/module", relative_to),
            _path(nyacc_modules, "{}/module", relative_to),
            delimiter = ":",
        ),
        "srcdest": _path(src_prefix, "{}/", relative_to),
        "includedir": _path(src_prefix, "{}/include", relative_to),
        "libdir": _path(src_prefix, "{}/lib", relative_to) if libdir == None else libdir,
        "MES_ARENA": "100000000",
        "MES_MAX_ARENA": "100000000",
        "MES_STACK": "6000000",
        "M1": _path(tools, "{}/M1", relative_to),
        "HEX2": _path(tools, "{}/hex2", relative_to),
        "BLOOD_ELF": _path(tools, "{}/blood-elf", relative_to),
    }

def _mescc_compile_action(ctx, outdir, source, category, identifier = None):
    """Run `mescc -c`, which writes <name>.o and <name>.s into `outdir`."""
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    ctx.actions.run(
        [
            ctx.attrs.chdirenv[DefaultInfo].default_outputs[0],
            outdir.as_output(),
            cmd_args(ctx.attrs.mes_m2[DefaultInfo].default_outputs[0], relative_to = outdir),
            "-e",
            "main",
            cmd_args(src_prefix, format = "{}/bin/mescc.scm", relative_to = outdir),
            "--",
            "-D",
            "HAVE_CONFIG_H=1",
            "-I",
            cmd_args(src_prefix, format = "{}/include", relative_to = outdir),
            "-I",
            cmd_args(src_prefix, format = "{}/include/linux/" + ctx.attrs.mes_cpu, relative_to = outdir),
            "-c",
            source,
        ],
        env = _mescc_env(
            src_prefix,
            ctx.attrs.nyacc[DefaultInfo].default_outputs[0],
            ctx.attrs.tools[DefaultInfo].default_outputs[0],
            relative_to = outdir,
        ),
        category = category,
        identifier = identifier,
        clear_environment = True,
    )

def _mescc_link_action(ctx, output, objects, category):
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    ctx.actions.run(
        [
            ctx.attrs.mes_m2[DefaultInfo].default_outputs[0],
            "-e",
            "main",
            cmd_args(src_prefix, format = "{}/bin/mescc.scm"),
            "--",
            "-L",
            cmd_args(src_prefix, format = "{}/lib"),
            "-L",
            ctx.attrs.lib_dir[DefaultInfo].default_outputs[0],
            "-lc",
            "-lmescc",
            "-nostdlib",
            "-o",
            output.as_output(),
            ctx.attrs.crt1,
        ] + objects,
        env = _mescc_env(
            src_prefix,
            ctx.attrs.nyacc[DefaultInfo].default_outputs[0],
            ctx.attrs.tools[DefaultInfo].default_outputs[0],
        ),
        category = category,
        clear_environment = True,
    )

# --------------------------------------------------------------------------- #
# mescc_compile: compiles a single C file using mes-m2 + mescc.scm
# --------------------------------------------------------------------------- #

def _mescc_compile_impl(ctx: AnalysisContext) -> list[Provider]:
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    basename = _object_name(ctx.attrs.source_path)
    outdir = ctx.actions.declare_output(ctx.label.name, dir = True, has_content_based_path = False)
    _mescc_compile_action(
        ctx,
        outdir,
        cmd_args(src_prefix, format = "{}/" + ctx.attrs.source_path, relative_to = outdir),
        category = "mescc_compile",
        identifier = ctx.attrs.source_path,
    )

    return [
        DefaultInfo(
            default_output = outdir,
            sub_targets = {
                basename + ".o": [DefaultInfo(default_output = outdir.project(basename + ".o"))],
                basename + ".s": [DefaultInfo(default_output = outdir.project(basename + ".s"))],
            },
        ),
    ]

_mescc_compile_rule = rule(impl = _mescc_compile_impl, attrs = {
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.exec_dep(),
    "source_path": attrs.string(),
    "mes_cpu": attrs.string(),
    "nyacc": attrs.dep(),
    "tools": attrs.exec_dep(),
    "chdirenv": attrs.exec_dep(),
})

def mescc_compile(**kwargs):
    _mescc_compile_rule(**native_attrs(kwargs))

# --------------------------------------------------------------------------- #
# mescc_build_lib: compiles a list of C files and archives them into .a
#
# This is a rule (not a macro) so that 'sources' can accept select().
# Each source file gets its own compile action for parallelism.
# --------------------------------------------------------------------------- #

def _mescc_build_lib_impl(ctx: AnalysisContext) -> list[Provider]:
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    catm = ctx.attrs.catm[DefaultInfo].default_outputs[0]

    obj_files = []
    s_files = []
    for src_path, basename in zip(ctx.attrs.sources, _unique_object_names(ctx.attrs.sources)):
        outdir = ctx.actions.declare_output("obj/" + basename, dir = True, has_content_based_path = False)
        _mescc_compile_action(
            ctx,
            outdir,
            cmd_args(src_prefix, format = "{}/" + src_path, relative_to = outdir),
            category = "mescc_compile",
            identifier = src_path,
        )
        obj_files.append(outdir.project(basename + ".o"))
        s_files.append(outdir.project(basename + ".s"))

    archive = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
    cmd = [catm, archive.as_output()] + obj_files
    ctx.actions.run(cmd, category = "mescc_archive", clear_environment = True)

    lib_name = ctx.label.name.replace(".a", "")
    s_archive = ctx.actions.declare_output(lib_name + ".s", has_content_based_path = False)
    cmd = [catm, s_archive.as_output()] + s_files
    ctx.actions.run(cmd, category = "mescc_archive_s", clear_environment = True)

    return [DefaultInfo(
        default_output = archive,
        sub_targets = {
            "s": [DefaultInfo(default_output = s_archive)],
        },
    )]

_mescc_build_lib_rule = rule(impl = _mescc_build_lib_impl, attrs = {
    "sources": attrs.list(attrs.string()),
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.exec_dep(),
    "mes_cpu": attrs.string(),
    "catm": attrs.exec_dep(),
    "nyacc": attrs.dep(),
    "tools": attrs.exec_dep(),
    "chdirenv": attrs.exec_dep(),
})

def mescc_build_lib(**kwargs):
    _mescc_build_lib_rule(**native_attrs(kwargs))

# --------------------------------------------------------------------------- #
# mescc_link: links object files into a binary
# --------------------------------------------------------------------------- #

def _mescc_link_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
    _mescc_link_action(ctx, output, ctx.attrs.objects, category = "mescc_link")
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

_mescc_link_rule = rule(impl = _mescc_link_impl, attrs = {
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.exec_dep(),
    "lib_dir": attrs.dep(),
    "crt1": attrs.source(),
    "objects": attrs.list(attrs.source()),
    "nyacc": attrs.dep(),
    "tools": attrs.exec_dep(),
})

def mescc_link(**kwargs):
    _mescc_link_rule(**native_attrs(kwargs))

# --------------------------------------------------------------------------- #
# mescc_test: compile a C file with mescc, link, and run as a test
# --------------------------------------------------------------------------- #

def _mescc_test_impl(ctx: AnalysisContext) -> list[Provider]:
    basename = _object_name(ctx.attrs.src.short_path)

    # mescc writes the object into its working directory.
    compile_dir = ctx.actions.declare_output("test-obj", dir = True, has_content_based_path = False)
    _mescc_compile_action(
        ctx,
        compile_dir,
        cmd_args(ctx.attrs.src, relative_to = compile_dir),
        category = "mescc_test_compile",
    )

    binary = ctx.actions.declare_output(ctx.label.name + ".bin", has_content_based_path = False)
    _mescc_link_action(ctx, binary, [compile_dir.project(basename + ".o")], category = "mescc_test_link")

    return [
        DefaultInfo(default_output = binary),
        ExternalRunnerTestInfo(
            type = "simple",
            command = [binary],
            run_from_project_root = True,
            use_project_relative_paths = True,
        ),
    ]

_mescc_test_rule = rule(impl = _mescc_test_impl, attrs = {
    "src": attrs.source(),
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.exec_dep(),
    "lib_dir": attrs.dep(),
    "crt1": attrs.source(),
    "mes_cpu": attrs.string(),
    "nyacc": attrs.dep(),
    "tools": attrs.exec_dep(),
    "chdirenv": attrs.exec_dep(),
})

def mescc_test(**kwargs):
    _mescc_test_rule(**native_attrs(kwargs))

# --------------------------------------------------------------------------- #
# mescc_fixed_point_test: compare two mes binaries for byte-identity
# --------------------------------------------------------------------------- #

def _mescc_fixed_point_test_impl(ctx: AnalysisContext) -> list[Provider]:
    bin_a = ctx.attrs.stage2[DefaultInfo].default_outputs[0]
    bin_b = ctx.attrs.stage3[DefaultInfo].default_outputs[0]
    bytecmp = ctx.attrs.bytecmp[DefaultInfo].default_outputs[0]

    return [
        DefaultInfo(),
        ExternalRunnerTestInfo(
            type = "simple",
            command = [bytecmp, bin_a, bin_b],
            run_from_project_root = True,
            use_project_relative_paths = True,
        ),
    ]

_mescc_fixed_point_test_rule = rule(impl = _mescc_fixed_point_test_impl, attrs = {
    "stage2": attrs.dep(),
    "stage3": attrs.dep(),
    "bytecmp": attrs.exec_dep(),
})

def mescc_fixed_point_test(**kwargs):
    _mescc_fixed_point_test_rule(**native_attrs(kwargs))

# --------------------------------------------------------------------------- #
# mes_libs: assembles compiled libraries into a single directory
# --------------------------------------------------------------------------- #

def _mes_libs_impl(ctx: AnalysisContext) -> list[Provider]:
    mes_cpu = ctx.attrs.mes_cpu
    output = ctx.actions.copied_dir(ctx.label.name, {
        mes_cpu + "-mes/" + name: src
        for name, src in ctx.attrs.libs.items()
    }, has_content_based_path = False)
    return [DefaultInfo(default_output = output)]

_mes_libs_rule = rule(impl = _mes_libs_impl, attrs = {
    "libs": attrs.dict(attrs.string(), attrs.source()),
    "mes_cpu": attrs.string(),
})

def mes_libs(**kwargs):
    _mes_libs_rule(**native_attrs(kwargs))

# --------------------------------------------------------------------------- #
# Wrapper rules
# --------------------------------------------------------------------------- #

def _mes_bin_impl(ctx: AnalysisContext) -> list[Provider]:
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    mes_bin = ctx.attrs.bin[DefaultInfo].default_outputs[0]
    nyacc_modules = ctx.attrs.nyacc[DefaultInfo].default_outputs[0]
    envexec = ctx.attrs.envexec[DefaultInfo].default_outputs[0]

    return [
        DefaultInfo(),
        RunInfo(args = cmd_args([
            envexec,
            cmd_args("MES_PREFIX=", src_prefix, delimiter = ""),
            cmd_args(
                "GUILE_LOAD_PATH=",
                cmd_args(src_prefix, format = "{}/mes/module"),
                ":",
                cmd_args(src_prefix, format = "{}/module"),
                ":",
                cmd_args(nyacc_modules, format = "{}/module"),
                delimiter = "",
            ),
            "MES_ARENA=100000000",
            "MES_MAX_ARENA=100000000",
            "MES_STACK=6000000",
            "--",
            mes_bin,
        ])),
    ]

_mes_binary_rule = rule(impl = _mes_bin_impl, attrs = {
    "src_prefix": attrs.dep(),
    "bin": attrs.exec_dep(),
    "nyacc": attrs.dep(),
    "envexec": attrs.exec_dep(),
})

def mes_binary(**kwargs):
    _mes_binary_rule(**native_attrs(kwargs))

def _mescc_bin_impl(ctx: AnalysisContext) -> list[Provider]:
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    env = _mescc_env(
        src_prefix,
        ctx.attrs.nyacc[DefaultInfo].default_outputs[0],
        ctx.attrs.tools[DefaultInfo].default_outputs[0],
        libdir = ctx.attrs.lib_dir[DefaultInfo].default_outputs[0],
    )
    env["MES_UNINSTALLED"] = "1"

    return [
        DefaultInfo(),
        RunInfo(args = cmd_args(
            [ctx.attrs.envexec[DefaultInfo].default_outputs[0]] +
            [cmd_args(key, "=", value, delimiter = "") for key, value in env.items()] +
            [
                "--",
                ctx.attrs.mes_m2[DefaultInfo].default_outputs[0],
                "-e",
                "main",
                cmd_args(src_prefix, format = "{}/bin/mescc.scm"),
                "--",
            ],
        )),
    ]

_mescc_binary_rule = rule(impl = _mescc_bin_impl, attrs = {
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.exec_dep(),
    "nyacc": attrs.dep(),
    "tools": attrs.exec_dep(),
    "lib_dir": attrs.dep(),
    "envexec": attrs.exec_dep(),
})

def mescc_binary(**kwargs):
    _mescc_binary_rule(**native_attrs(kwargs))

# --------------------------------------------------------------------------- #
# mescc_build_mes: compiles and links mes source files into the final binary
# --------------------------------------------------------------------------- #

def _mescc_build_mes_impl(ctx: AnalysisContext) -> list[Provider]:
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]

    obj_files = []
    for src_path, basename in zip(ctx.attrs.sources, _unique_object_names(ctx.attrs.sources)):
        outdir = ctx.actions.declare_output("mes-obj/" + basename, dir = True, has_content_based_path = False)
        _mescc_compile_action(
            ctx,
            outdir,
            cmd_args(src_prefix, format = "{}/" + src_path, relative_to = outdir),
            category = "mescc_compile",
            identifier = src_path,
        )
        obj_files.append(outdir.project(basename + ".o"))

    output = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
    _mescc_link_action(ctx, output, obj_files, category = "mescc_link")

    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

_mescc_build_mes_rule = rule(impl = _mescc_build_mes_impl, attrs = {
    "sources": attrs.list(attrs.string()),
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.exec_dep(),
    "lib_dir": attrs.dep(),
    "crt1": attrs.source(),
    "mes_cpu": attrs.string(),
    "nyacc": attrs.dep(),
    "tools": attrs.exec_dep(),
    "chdirenv": attrs.exec_dep(),
})

def mescc_build_mes(**kwargs):
    _mescc_build_mes_rule(**native_attrs(kwargs))
