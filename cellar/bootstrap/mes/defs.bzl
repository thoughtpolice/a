# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# --------------------------------------------------------------------------- #
# M2-Planet compilation pipeline (builds mes-m2 from C source)
# --------------------------------------------------------------------------- #

def __m2_planet(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
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
    )
    return [DefaultInfo(default_output = output)]

M2_Planet = rule(impl = __m2_planet, attrs = {
    "tools": attrs.dep(),
    "arch_stage0": attrs.string(),
    "arch_mes": attrs.string(),
    "defines": attrs.list(attrs.string(), default = []),
    "srcs": attrs.list(attrs.source()),
})

def _blood_elf_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    cmd = [tools.project("blood-elf"), ctx.attrs.args]
    for f in ctx.attrs.srcs:
        cmd.extend(["-f", f])
    cmd.extend(["-o", output.as_output()])
    ctx.actions.run(cmd, env = {"PATH": tools}, category = "mes_blood_elf")
    return [DefaultInfo(default_output = output)]

blood_elf = rule(impl = _blood_elf_impl, attrs = {
    "tools": attrs.dep(),
    "args": attrs.list(attrs.arg()),
    "srcs": attrs.list(attrs.source()),
})

def _m1_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    cmd = [tools.project("M1"), ctx.attrs.args]
    for f in ctx.attrs.srcs:
        cmd.extend(["-f", f])
    cmd.extend(["-o", output.as_output()])
    ctx.actions.run(cmd, env = {"PATH": tools}, category = "mes_m1")
    return [DefaultInfo(default_output = output)]

M1 = rule(impl = _m1_impl, attrs = {
    "tools": attrs.dep(),
    "args": attrs.list(attrs.arg()),
    "srcs": attrs.list(attrs.source()),
})

def _hex2_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    cmd = [tools.project("hex2"), ctx.attrs.args]
    for f in ctx.attrs.srcs:
        cmd.extend(["-f", f])
    cmd.extend(["-o", output.as_output()])
    ctx.actions.run(cmd, env = {"PATH": tools}, category = "mes_hex2")
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

hex2 = rule(impl = _hex2_impl, attrs = {
    "tools": attrs.dep(),
    "args": attrs.list(attrs.arg()),
    "srcs": attrs.list(attrs.source()),
})

# --------------------------------------------------------------------------- #
# mescc_compile: compiles a single C file using mes-m2 + mescc.scm
# --------------------------------------------------------------------------- #

def _mescc_compile_impl(ctx: AnalysisContext) -> list[Provider]:
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    mes_m2 = ctx.attrs.mes_m2[DefaultInfo].default_outputs[0]
    nyacc_modules = ctx.attrs.nyacc[DefaultInfo].default_outputs[0]
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    chdirenv = ctx.attrs.chdirenv[DefaultInfo].default_outputs[0]
    basename = ctx.attrs.source_path.rsplit("/", 1)[-1].replace(".c", "")
    outdir = ctx.actions.declare_output(ctx.label.name, dir = True)

    ctx.actions.run(
        [
            chdirenv,
            outdir.as_output(),
            cmd_args(mes_m2, relative_to = outdir),
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
            cmd_args(src_prefix, format = "{}/" + ctx.attrs.source_path, relative_to = outdir),
        ],
        env = {
            "MES_PREFIX": cmd_args(src_prefix, relative_to = outdir),
            "GUILE_LOAD_PATH": cmd_args(
                cmd_args(src_prefix, format = "{}/mes/module", relative_to = outdir),
                cmd_args(src_prefix, format = "{}/module", relative_to = outdir),
                cmd_args(nyacc_modules, format = "{}/module", relative_to = outdir),
                delimiter = ":",
            ),
            "srcdest": cmd_args(src_prefix, format = "{}/", relative_to = outdir),
            "includedir": cmd_args(src_prefix, format = "{}/include", relative_to = outdir),
            "libdir": cmd_args(src_prefix, format = "{}/lib", relative_to = outdir),
            "MES_ARENA": "100000000",
            "MES_MAX_ARENA": "100000000",
            "MES_STACK": "6000000",
            "M1": cmd_args(tools, format = "{}/M1", relative_to = outdir),
            "HEX2": cmd_args(tools, format = "{}/hex2", relative_to = outdir),
            "BLOOD_ELF": cmd_args(tools, format = "{}/blood-elf", relative_to = outdir),
        },
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

mescc_compile = rule(impl = _mescc_compile_impl, attrs = {
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.dep(),
    "source_path": attrs.string(),
    "mes_cpu": attrs.string(),
    "nyacc": attrs.dep(),
    "tools": attrs.dep(),
    "chdirenv": attrs.dep(),
})

# --------------------------------------------------------------------------- #
# mescc_build_lib: compiles a list of C files and archives them into .a
#
# This is a rule (not a macro) so that 'sources' can accept select().
# Each source file gets its own compile action for parallelism.
# --------------------------------------------------------------------------- #

def _mescc_build_lib_impl(ctx: AnalysisContext) -> list[Provider]:
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    mes_m2 = ctx.attrs.mes_m2[DefaultInfo].default_outputs[0]
    catm = ctx.attrs.catm[DefaultInfo].default_outputs[0]
    nyacc_modules = ctx.attrs.nyacc[DefaultInfo].default_outputs[0]
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    chdirenv = ctx.attrs.chdirenv[DefaultInfo].default_outputs[0]
    mes_cpu = ctx.attrs.mes_cpu

    obj_files = []
    s_files = []

    for src_path in ctx.attrs.sources:
        basename = src_path.rsplit("/", 1)[-1].replace(".c", "")
        outdir = ctx.actions.declare_output("obj/" + basename, dir = True)

        ctx.actions.run(
            [
                chdirenv,
                outdir.as_output(),
                cmd_args(mes_m2, relative_to = outdir),
                "-e",
                "main",
                cmd_args(src_prefix, format = "{}/bin/mescc.scm", relative_to = outdir),
                "--",
                "-D",
                "HAVE_CONFIG_H=1",
                "-I",
                cmd_args(src_prefix, format = "{}/include", relative_to = outdir),
                "-I",
                cmd_args(src_prefix, format = "{}/include/linux/" + mes_cpu, relative_to = outdir),
                "-c",
                cmd_args(src_prefix, format = "{}/" + src_path, relative_to = outdir),
            ],
            env = {
                "MES_PREFIX": cmd_args(src_prefix, relative_to = outdir),
                "GUILE_LOAD_PATH": cmd_args(
                    cmd_args(src_prefix, format = "{}/mes/module", relative_to = outdir),
                    cmd_args(src_prefix, format = "{}/module", relative_to = outdir),
                    cmd_args(nyacc_modules, format = "{}/module", relative_to = outdir),
                    delimiter = ":",
                ),
                "srcdest": cmd_args(src_prefix, format = "{}/", relative_to = outdir),
                "includedir": cmd_args(src_prefix, format = "{}/include", relative_to = outdir),
                "libdir": cmd_args(src_prefix, format = "{}/lib", relative_to = outdir),
                "MES_ARENA": "100000000",
                "MES_MAX_ARENA": "100000000",
                "MES_STACK": "6000000",
                "M1": cmd_args(tools, format = "{}/M1", relative_to = outdir),
                "HEX2": cmd_args(tools, format = "{}/hex2", relative_to = outdir),
                "BLOOD_ELF": cmd_args(tools, format = "{}/blood-elf", relative_to = outdir),
            },
            category = "mescc_compile",
            identifier = src_path,
        )

        obj_files.append(outdir.project(basename + ".o"))
        s_files.append(outdir.project(basename + ".s"))

    archive = ctx.actions.declare_output(ctx.label.name)
    cmd = [catm, archive.as_output()] + obj_files
    ctx.actions.run(cmd, category = "mescc_archive")

    lib_name = ctx.label.name.replace(".a", "")
    s_archive = ctx.actions.declare_output(lib_name + ".s")
    cmd = [catm, s_archive.as_output()] + s_files
    ctx.actions.run(cmd, category = "mescc_archive_s")

    return [DefaultInfo(
        default_output = archive,
        sub_targets = {
            "s": [DefaultInfo(default_output = s_archive)],
        },
    )]

mescc_build_lib = rule(impl = _mescc_build_lib_impl, attrs = {
    "sources": attrs.list(attrs.string()),
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.dep(),
    "mes_cpu": attrs.string(),
    "catm": attrs.dep(),
    "nyacc": attrs.dep(),
    "tools": attrs.dep(),
    "chdirenv": attrs.dep(),
})

# --------------------------------------------------------------------------- #
# mescc_link: links object files into a binary
# --------------------------------------------------------------------------- #

def _mescc_link_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    mes_m2 = ctx.attrs.mes_m2[DefaultInfo].default_outputs[0]
    lib_dir = ctx.attrs.lib_dir[DefaultInfo].default_outputs[0]
    nyacc_modules = ctx.attrs.nyacc[DefaultInfo].default_outputs[0]
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]

    cmd = [
        mes_m2,
        "-e",
        "main",
        cmd_args(src_prefix, format = "{}/bin/mescc.scm"),
        "--",
        "-L",
        cmd_args(src_prefix, format = "{}/lib"),
        "-L",
        lib_dir,
        "-lc",
        "-lmescc",
        "-nostdlib",
        "-o",
        output.as_output(),
        ctx.attrs.crt1,
    ]
    for obj in ctx.attrs.objects:
        cmd.append(obj)

    ctx.actions.run(
        cmd,
        env = {
            "MES_PREFIX": src_prefix,
            "GUILE_LOAD_PATH": cmd_args(
                cmd_args(src_prefix, format = "{}/mes/module"),
                cmd_args(src_prefix, format = "{}/module"),
                cmd_args(nyacc_modules, format = "{}/module"),
                delimiter = ":",
            ),
            "srcdest": cmd_args(src_prefix, format = "{}/"),
            "includedir": cmd_args(src_prefix, format = "{}/include"),
            "libdir": cmd_args(src_prefix, format = "{}/lib"),
            "MES_ARENA": "100000000",
            "MES_MAX_ARENA": "100000000",
            "MES_STACK": "6000000",
            "M1": cmd_args(tools, format = "{}/M1"),
            "HEX2": cmd_args(tools, format = "{}/hex2"),
            "BLOOD_ELF": cmd_args(tools, format = "{}/blood-elf"),
        },
        category = "mescc_link",
    )

    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

mescc_link = rule(impl = _mescc_link_impl, attrs = {
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.dep(),
    "lib_dir": attrs.dep(),
    "crt1": attrs.source(),
    "objects": attrs.list(attrs.source()),
    "nyacc": attrs.dep(),
    "tools": attrs.dep(),
})

# --------------------------------------------------------------------------- #
# mescc_test: compile a C file with mescc, link, and run as a test
# --------------------------------------------------------------------------- #

def _mescc_test_impl(ctx: AnalysisContext) -> list[Provider]:
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    mes_m2 = ctx.attrs.mes_m2[DefaultInfo].default_outputs[0]
    lib_dir = ctx.attrs.lib_dir[DefaultInfo].default_outputs[0]
    nyacc_modules = ctx.attrs.nyacc[DefaultInfo].default_outputs[0]
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    chdirenv = ctx.attrs.chdirenv[DefaultInfo].default_outputs[0]
    mes_cpu = ctx.attrs.mes_cpu

    # Compute basename from source path
    src_short = ctx.attrs.src.short_path
    basename = src_short.rsplit("/", 1)[-1].replace(".c", "")

    # Step 1: compile (writes output to CWD, so use chdirenv)
    compile_dir = ctx.actions.declare_output("test-obj", dir = True)
    ctx.actions.run(
        [
            chdirenv,
            compile_dir.as_output(),
            cmd_args(mes_m2, relative_to = compile_dir),
            "-e",
            "main",
            cmd_args(src_prefix, format = "{}/bin/mescc.scm", relative_to = compile_dir),
            "--",
            "-D",
            "HAVE_CONFIG_H=1",
            "-I",
            cmd_args(src_prefix, format = "{}/include", relative_to = compile_dir),
            "-I",
            cmd_args(src_prefix, format = "{}/include/linux/" + mes_cpu, relative_to = compile_dir),
            "-c",
            cmd_args(ctx.attrs.src, relative_to = compile_dir),
        ],
        env = {
            "MES_PREFIX": cmd_args(src_prefix, relative_to = compile_dir),
            "GUILE_LOAD_PATH": cmd_args(
                cmd_args(src_prefix, format = "{}/mes/module", relative_to = compile_dir),
                cmd_args(src_prefix, format = "{}/module", relative_to = compile_dir),
                cmd_args(nyacc_modules, format = "{}/module", relative_to = compile_dir),
                delimiter = ":",
            ),
            "srcdest": cmd_args(src_prefix, format = "{}/", relative_to = compile_dir),
            "includedir": cmd_args(src_prefix, format = "{}/include", relative_to = compile_dir),
            "libdir": cmd_args(src_prefix, format = "{}/lib", relative_to = compile_dir),
            "MES_ARENA": "100000000",
            "MES_MAX_ARENA": "100000000",
            "MES_STACK": "6000000",
            "M1": cmd_args(tools, format = "{}/M1", relative_to = compile_dir),
            "HEX2": cmd_args(tools, format = "{}/hex2", relative_to = compile_dir),
            "BLOOD_ELF": cmd_args(tools, format = "{}/blood-elf", relative_to = compile_dir),
        },
        category = "mescc_test_compile",
    )

    # Step 2: link (uses explicit -o, no cd needed)
    binary = ctx.actions.declare_output(ctx.label.name + ".bin")
    ctx.actions.run(
        [
            mes_m2,
            "-e",
            "main",
            cmd_args(src_prefix, format = "{}/bin/mescc.scm"),
            "--",
            "-L",
            cmd_args(src_prefix, format = "{}/lib"),
            "-L",
            lib_dir,
            "-lc",
            "-lmescc",
            "-nostdlib",
            "-o",
            binary.as_output(),
            ctx.attrs.crt1,
            compile_dir.project(basename + ".o"),
        ],
        env = {
            "MES_PREFIX": src_prefix,
            "GUILE_LOAD_PATH": cmd_args(
                cmd_args(src_prefix, format = "{}/mes/module"),
                cmd_args(src_prefix, format = "{}/module"),
                cmd_args(nyacc_modules, format = "{}/module"),
                delimiter = ":",
            ),
            "srcdest": cmd_args(src_prefix, format = "{}/"),
            "includedir": cmd_args(src_prefix, format = "{}/include"),
            "libdir": cmd_args(src_prefix, format = "{}/lib"),
            "MES_ARENA": "100000000",
            "MES_MAX_ARENA": "100000000",
            "MES_STACK": "6000000",
            "M1": cmd_args(tools, format = "{}/M1"),
            "HEX2": cmd_args(tools, format = "{}/hex2"),
            "BLOOD_ELF": cmd_args(tools, format = "{}/blood-elf"),
        },
        category = "mescc_test_link",
    )

    return [
        DefaultInfo(default_output = binary),
        ExternalRunnerTestInfo(
            type = "simple",
            command = [binary],
        ),
    ]

mescc_test = rule(impl = _mescc_test_impl, attrs = {
    "src": attrs.source(),
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.dep(),
    "lib_dir": attrs.dep(),
    "crt1": attrs.source(),
    "mes_cpu": attrs.string(),
    "nyacc": attrs.dep(),
    "tools": attrs.dep(),
    "chdirenv": attrs.dep(),
})

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
        ),
    ]

mescc_fixed_point_test = rule(impl = _mescc_fixed_point_test_impl, attrs = {
    "stage2": attrs.dep(),
    "stage3": attrs.dep(),
    "bytecmp": attrs.dep(),
})

# --------------------------------------------------------------------------- #
# mes_libs: assembles compiled libraries into a single directory
# --------------------------------------------------------------------------- #

def _mes_libs_impl(ctx: AnalysisContext) -> list[Provider]:
    mes_cpu = ctx.attrs.mes_cpu
    output = ctx.actions.copied_dir(ctx.label.name, {
        mes_cpu + "-mes/" + name: src
        for name, src in ctx.attrs.libs.items()
    })
    return [DefaultInfo(default_output = output)]

mes_libs = rule(impl = _mes_libs_impl, attrs = {
    "libs": attrs.dict(attrs.string(), attrs.source()),
    "mes_cpu": attrs.string(),
})

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

mes_binary = rule(impl = _mes_bin_impl, attrs = {
    "src_prefix": attrs.dep(),
    "bin": attrs.dep(),
    "nyacc": attrs.dep(),
    "envexec": attrs.dep(),
})

def _mescc_bin_impl(ctx: AnalysisContext) -> list[Provider]:
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    mes_m2 = ctx.attrs.mes_m2[DefaultInfo].default_outputs[0]
    nyacc_modules = ctx.attrs.nyacc[DefaultInfo].default_outputs[0]
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    lib_dir = ctx.attrs.lib_dir[DefaultInfo].default_outputs[0]
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
            cmd_args("srcdest=", src_prefix, "/", delimiter = ""),
            cmd_args("includedir=", cmd_args(src_prefix, format = "{}/include"), delimiter = ""),
            cmd_args("libdir=", lib_dir, delimiter = ""),
            "MES_UNINSTALLED=1",
            "MES_ARENA=100000000",
            "MES_MAX_ARENA=100000000",
            "MES_STACK=6000000",
            cmd_args("M1=", cmd_args(tools, format = "{}/M1"), delimiter = ""),
            cmd_args("HEX2=", cmd_args(tools, format = "{}/hex2"), delimiter = ""),
            cmd_args("BLOOD_ELF=", cmd_args(tools, format = "{}/blood-elf"), delimiter = ""),
            "--",
            mes_m2,
            "-e",
            "main",
            cmd_args(src_prefix, format = "{}/bin/mescc.scm"),
            "--",
        ])),
    ]

mescc_binary = rule(impl = _mescc_bin_impl, attrs = {
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.dep(),
    "nyacc": attrs.dep(),
    "tools": attrs.dep(),
    "lib_dir": attrs.dep(),
    "envexec": attrs.dep(),
})

# --------------------------------------------------------------------------- #
# mescc_build_mes: compiles and links mes source files into the final binary
# --------------------------------------------------------------------------- #

def _mescc_build_mes_impl(ctx: AnalysisContext) -> list[Provider]:
    src_prefix = ctx.attrs.src_prefix[DefaultInfo].default_outputs[0]
    mes_m2 = ctx.attrs.mes_m2[DefaultInfo].default_outputs[0]
    lib_dir = ctx.attrs.lib_dir[DefaultInfo].default_outputs[0]
    nyacc_modules = ctx.attrs.nyacc[DefaultInfo].default_outputs[0]
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    chdirenv = ctx.attrs.chdirenv[DefaultInfo].default_outputs[0]
    mes_cpu = ctx.attrs.mes_cpu

    obj_files = []
    for src_path in ctx.attrs.sources:
        basename = src_path.rsplit("/", 1)[-1].replace(".c", "")
        outdir = ctx.actions.declare_output("mes-obj/" + basename, dir = True)

        ctx.actions.run(
            [
                chdirenv,
                outdir.as_output(),
                cmd_args(mes_m2, relative_to = outdir),
                "-e",
                "main",
                cmd_args(src_prefix, format = "{}/bin/mescc.scm", relative_to = outdir),
                "--",
                "-D",
                "HAVE_CONFIG_H=1",
                "-I",
                cmd_args(src_prefix, format = "{}/include", relative_to = outdir),
                "-I",
                cmd_args(src_prefix, format = "{}/include/linux/" + mes_cpu, relative_to = outdir),
                "-c",
                cmd_args(src_prefix, format = "{}/" + src_path, relative_to = outdir),
            ],
            env = {
                "MES_PREFIX": cmd_args(src_prefix, relative_to = outdir),
                "GUILE_LOAD_PATH": cmd_args(
                    cmd_args(src_prefix, format = "{}/mes/module", relative_to = outdir),
                    cmd_args(src_prefix, format = "{}/module", relative_to = outdir),
                    cmd_args(nyacc_modules, format = "{}/module", relative_to = outdir),
                    delimiter = ":",
                ),
                "srcdest": cmd_args(src_prefix, format = "{}/", relative_to = outdir),
                "includedir": cmd_args(src_prefix, format = "{}/include", relative_to = outdir),
                "libdir": cmd_args(src_prefix, format = "{}/lib", relative_to = outdir),
                "MES_ARENA": "100000000",
                "MES_MAX_ARENA": "100000000",
                "MES_STACK": "6000000",
                "M1": cmd_args(tools, format = "{}/M1", relative_to = outdir),
                "HEX2": cmd_args(tools, format = "{}/hex2", relative_to = outdir),
                "BLOOD_ELF": cmd_args(tools, format = "{}/blood-elf", relative_to = outdir),
            },
            category = "mescc_compile",
            identifier = src_path,
        )
        obj_files.append(outdir.project(basename + ".o"))

    # Link
    output = ctx.actions.declare_output(ctx.label.name)
    link_cmd = [
        mes_m2,
        "-e",
        "main",
        cmd_args(src_prefix, format = "{}/bin/mescc.scm"),
        "--",
        "-L",
        cmd_args(src_prefix, format = "{}/lib"),
        "-L",
        lib_dir,
        "-lc",
        "-lmescc",
        "-nostdlib",
        "-o",
        output.as_output(),
        ctx.attrs.crt1,
    ] + obj_files

    ctx.actions.run(
        link_cmd,
        env = {
            "MES_PREFIX": src_prefix,
            "GUILE_LOAD_PATH": cmd_args(
                cmd_args(src_prefix, format = "{}/mes/module"),
                cmd_args(src_prefix, format = "{}/module"),
                cmd_args(nyacc_modules, format = "{}/module"),
                delimiter = ":",
            ),
            "srcdest": cmd_args(src_prefix, format = "{}/"),
            "includedir": cmd_args(src_prefix, format = "{}/include"),
            "libdir": cmd_args(src_prefix, format = "{}/lib"),
            "MES_ARENA": "100000000",
            "MES_MAX_ARENA": "100000000",
            "MES_STACK": "6000000",
            "M1": cmd_args(tools, format = "{}/M1"),
            "HEX2": cmd_args(tools, format = "{}/hex2"),
            "BLOOD_ELF": cmd_args(tools, format = "{}/blood-elf"),
        },
        category = "mescc_link",
    )

    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

mescc_build_mes = rule(impl = _mescc_build_mes_impl, attrs = {
    "sources": attrs.list(attrs.string()),
    "src_prefix": attrs.dep(),
    "mes_m2": attrs.dep(),
    "lib_dir": attrs.dep(),
    "crt1": attrs.source(),
    "mes_cpu": attrs.string(),
    "nyacc": attrs.dep(),
    "tools": attrs.dep(),
    "chdirenv": attrs.dep(),
})
