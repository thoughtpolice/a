# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load(
    ":sources.bzl",
    "MES_SOURCES",
    "libc_mini_sources",
    "libc_sources",
    "libc_tcc_sources",
    "libmescc_sources",
)

# --------------------------------------------------------------------------- #
# Basic utility rules
# --------------------------------------------------------------------------- #

def __write_file(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.write(output, ctx.attrs.content)
    return [DefaultInfo(default_output = output)]

write_file = rule(impl = __write_file, attrs = {
    "content": attrs.string(),
})

def __download_file(ctx: AnalysisContext) -> list[Provider]:
    if len(ctx.attrs.urls) != 1:
        fail("expected exactly one URL to download")

    hash = ctx.attrs.hash
    if hash == None or hash == "":
        hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        warning("expected a hash for the tarball, this will always fail")

    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.download_file(
        output,
        ctx.attrs.urls[0],
        sha256 = hash,
    )

    return [
        DefaultInfo(default_output = output),
    ]

download_file = rule(impl = __download_file, attrs = {
    "urls": attrs.list(attrs.string()),
    "hash": attrs.option(attrs.string(), default = None),
})

def __ungz(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.run(
        [
            ctx.attrs.ungz[DefaultInfo].default_outputs[0],
            "--file",
            ctx.attrs.input[DefaultInfo].default_outputs[0],
            "--output",
            output.as_output(),
        ],
        category = "mes_stage0_ungz",
    )
    return [DefaultInfo(default_output = output)]

ungz = rule(impl = __ungz, attrs = {
    "ungz": attrs.dep(),
    "input": attrs.dep(),
})

def __untar(ctx: AnalysisContext) -> list[Provider]:
    # The tar contains a top-level directory (e.g. mes-0.27/) so we extract
    # into a parent directory and project the actual output from it.
    # chdirenv creates the directory if it doesn't exist, then cds into it.
    parent = ctx.actions.declare_output("_untar_work", dir = True)
    output = parent.project(ctx.label.name)
    chdirenv = ctx.attrs.chdirenv[DefaultInfo].default_outputs[0]
    untar_tool = ctx.attrs.untar[DefaultInfo].default_outputs[0]
    input_tar = ctx.attrs.input[DefaultInfo].default_outputs[0]

    ctx.actions.run(
        [
            chdirenv,
            parent.as_output(),
            cmd_args(untar_tool, relative_to = parent),
            "--non-strict",
            "--file",
            cmd_args(input_tar, relative_to = parent),
        ],
        category = "mes_stage0_untar",
    )
    return [
        DefaultInfo(
            default_output = output,
            sub_targets = {
                path: [DefaultInfo(default_output = output.project(path))]
                for path in ctx.attrs.files
            },
        ),
    ]

untar = rule(impl = __untar, attrs = {
    "chdirenv": attrs.dep(),
    "untar": attrs.dep(),
    "input": attrs.dep(),
    "files": attrs.list(attrs.string(), default = []),
})

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
# Source preparation: patches the extracted mes source tree
# --------------------------------------------------------------------------- #

def _mes_prepare_src_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name, dir = True)
    src = ctx.attrs.src[DefaultInfo].default_outputs[0]
    chdirenv = ctx.attrs.chdirenv[DefaultInfo].default_outputs[0]
    prepare = ctx.attrs.prepare[DefaultInfo].default_outputs[0]
    replace = ctx.attrs.replace[DefaultInfo].default_outputs[0]
    cp = ctx.attrs.cp[DefaultInfo].default_outputs[0]
    mkdir = ctx.attrs.mkdir[DefaultInfo].default_outputs[0]
    rm = ctx.attrs.rm[DefaultInfo].default_outputs[0]
    mes_cpu = ctx.attrs.mes_cpu
    version = ctx.attrs.version

    ctx.actions.run(
        [
            chdirenv,
            output.as_output(),
            cmd_args(prepare, relative_to = output),
            cmd_args(src, relative_to = output),
            cmd_args(replace, relative_to = output),
            cmd_args(cp, relative_to = output),
            cmd_args(mkdir, relative_to = output),
            cmd_args(rm, relative_to = output),
            mes_cpu,
            version,
        ],
        category = "mes_prepare_src",
    )
    return [DefaultInfo(default_output = output)]

mes_prepare_src = rule(impl = _mes_prepare_src_impl, attrs = {
    "src": attrs.dep(),
    "tools": attrs.dep(),
    "nyacc": attrs.dep(),
    "mes_cpu": attrs.string(),
    "version": attrs.string(),
    "replace": attrs.dep(),
    "chdirenv": attrs.dep(),
    "prepare": attrs.dep(),
    "cp": attrs.dep(),
    "mkdir": attrs.dep(),
    "rm": attrs.dep(),
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

    # Archive all .o files into .a
    archive = ctx.actions.declare_output(ctx.label.name)
    cmd = [catm, archive.as_output()] + obj_files
    ctx.actions.run(cmd, category = "mescc_archive")

    # Concatenate all .s files
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

_mes = rule(impl = _mes_bin_impl, attrs = {
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
            cmd_args("includedir=", src_prefix, format = "{}/include", delimiter = ""),
            cmd_args("libdir=", lib_dir, delimiter = ""),
            "MES_UNINSTALLED=1",
            "MES_ARENA=100000000",
            "MES_MAX_ARENA=100000000",
            "MES_STACK=6000000",
            cmd_args("M1=", tools, format = "{}/M1", delimiter = ""),
            cmd_args("HEX2=", tools, format = "{}/hex2", delimiter = ""),
            cmd_args("BLOOD_ELF=", tools, format = "{}/blood-elf", delimiter = ""),
            "--",
            mes_m2,
            "-e",
            "main",
            cmd_args(src_prefix, format = "{}/bin/mescc.scm"),
            "--",
        ])),
    ]

_mescc = rule(impl = _mescc_bin_impl, attrs = {
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

# --------------------------------------------------------------------------- #
# create_all: main entry point called from BUILD
# --------------------------------------------------------------------------- #

_VERSION = "0.27"
_NYACC_VERSION = "1.00.2"
_TOOLS_EXTRA = "cellar//bootstrap/stage0-posix/mescc-tools-extra"
_CELLAR_EXTRA = "cellar//bootstrap/stage0-posix/cellar-extra"
_LINUX_COMPAT = ["cellar//bootstrap/platforms:linux"]

def _create_mescc_stage(stage, mes_m2, MES_CPU, NYACC, TOOLS):
    """Create a full mescc compilation stage (crt1 + libs + mes binary)."""
    mescc_compile(
        name = "{}-crt1".format(stage),
        target_compatible_with = _LINUX_COMPAT,
        src_prefix = ":mes-src",
        mes_m2 = mes_m2,
        source_path = select({
            "cellar//bootstrap/platforms:amd64": "lib/linux/x86_64-mes-mescc/crt1.c",
            "cellar//bootstrap/platforms:aarch64": "lib/linux/arm-mes-mescc/crt1.c",
        }),
        mes_cpu = MES_CPU,
        nyacc = NYACC,
        tools = TOOLS,
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
    )

    for lib_name, sources_fn in [
        ("libc-mini.a", libc_mini_sources),
        ("libmescc.a", libmescc_sources),
        ("libc.a", libc_sources),
        ("libc+tcc.a", libc_tcc_sources),
    ]:
        mescc_build_lib(
            name = "{}-{}".format(stage, lib_name),
            target_compatible_with = _LINUX_COMPAT,
            sources = select({
                "cellar//bootstrap/platforms:amd64": sources_fn("x86_64"),
                "cellar//bootstrap/platforms:aarch64": sources_fn("arm"),
            }),
            src_prefix = ":mes-src",
            mes_m2 = mes_m2,
            mes_cpu = MES_CPU,
            catm = _TOOLS_EXTRA + ":catm",
            nyacc = NYACC,
            tools = TOOLS,
            chdirenv = _CELLAR_EXTRA + ":chdirenv",
        )

    crt1 = ":{}-crt1".format(stage)
    mes_libs(
        name = "{}-libs".format(stage),
        target_compatible_with = _LINUX_COMPAT,
        libs = {
            "crt1.o": "{}[crt1.o]".format(crt1),
            "crt1.s": "{}[crt1.s]".format(crt1),
            "libc-mini.a": ":{}-libc-mini.a".format(stage),
            "libc-mini.s": ":{}-libc-mini.a[s]".format(stage),
            "libmescc.a": ":{}-libmescc.a".format(stage),
            "libmescc.s": ":{}-libmescc.a[s]".format(stage),
            "libc.a": ":{}-libc.a".format(stage),
            "libc.s": ":{}-libc.a[s]".format(stage),
            "libc+tcc.a": ":{}-libc+tcc.a".format(stage),
            "libc+tcc.s": ":{}-libc+tcc.a[s]".format(stage),
        },
        mes_cpu = MES_CPU,
    )

    mescc_build_mes(
        name = "{}-mes".format(stage),
        target_compatible_with = _LINUX_COMPAT,
        sources = MES_SOURCES,
        src_prefix = ":mes-src",
        mes_m2 = mes_m2,
        lib_dir = ":{}-libs".format(stage),
        crt1 = "{}[crt1.o]".format(crt1),
        mes_cpu = MES_CPU,
        nyacc = NYACC,
        tools = TOOLS,
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
    )

def create_all():
    VERSION = _VERSION

    # On aarch64, we cross-compile mes to 32-bit ARM (armv7l). Upstream GNU
    # Mes 0.27 has full ARM support but no aarch64 support. The aarch64 Linux
    # kernel runs 32-bit ARM binaries natively via its compat layer. The
    # aarch64 stage0 tools (M2-Planet, M1, hex2) support cross-compilation
    # to armv7l via --architecture armv7l.
    #
    # stage0_cpu: architecture flag for M2-Planet/M1/hex2 (--architecture)
    # mes_cpu: mes source tree directory prefix (arm-mes-m2, x86_64-mes-m2)
    # cc_cpu: C preprocessor define (__arm__, __x86_64__)

    CPU_0 = select({
        "cellar//bootstrap/platforms:amd64": "amd64",
        "cellar//bootstrap/platforms:aarch64": "armv7l",
    })
    MES_CPU = select({
        "cellar//bootstrap/platforms:amd64": "x86_64",
        "cellar//bootstrap/platforms:aarch64": "arm",
    })
    TOOLS = select({
        "cellar//bootstrap/platforms:amd64": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
        "cellar//bootstrap/platforms:aarch64": "cellar//bootstrap/stage0-posix/seeds/linux-arm64:bins",
    })

    # --- Download and extract ---

    download_file(
        name = "mes-{}.tar.gz".format(VERSION),
        target_compatible_with = _LINUX_COMPAT,
        hash = "033ee656d98cfc04a826eab27eed6e6a276d15bbb980a7cd71d00f30227aaaa8",
        urls = ["https://ftp.gnu.org/gnu/mes/mes-{}.tar.gz".format(VERSION)],
    )

    ungz(
        name = "mes-{}.tar".format(VERSION),
        target_compatible_with = _LINUX_COMPAT,
        input = ":mes-{}.tar.gz".format(VERSION),
        ungz = _TOOLS_EXTRA + ":ungz",
    )

    _M2_FILES_AMD64 = [
        "include/mes/lib-mini.h",
        "include/mes/lib.h",
        "include/linux/x86_64/syscall.h",
        "include/errno.h",
        "include/fcntl.h",
        "include/time.h",
        "include/sys/time.h",
        "include/m2/types.h",
        "include/sys/types.h",
        "include/sys/utsname.h",
        "include/mes/mes.h",
        "include/mes/builtins.h",
        "include/mes/constants.h",
        "include/mes/symbols.h",
        "include/linux/m2/kernel-stat.h",
        "include/sys/stat.h",
        "include/sys/ioctl.h",
        "include/signal.h",
        "include/sys/resource.h",
        "include/limits.h",
        "lib/linux/x86_64-mes-m2/crt1.c",
        "lib/mes/__init_io.c",
        "lib/linux/x86_64-mes-m2/_exit.c",
        "lib/linux/x86_64-mes-m2/_write.c",
        "lib/mes/globals.c",
        "lib/m2/cast.c",
        "lib/stdlib/exit.c",
        "lib/mes/write.c",
        "lib/linux/x86_64-mes-m2/syscall.c",
        "lib/stub/__raise.c",
        "lib/linux/brk.c",
        "lib/linux/malloc.c",
        "lib/string/memset.c",
        "lib/linux/read.c",
        "lib/mes/fdgetc.c",
        "lib/stdio/getchar.c",
        "lib/stdio/putchar.c",
        "lib/stub/__buffered_read.c",
        "lib/linux/_open3.c",
        "lib/linux/open.c",
        "lib/mes/mes_open.c",
        "lib/string/strlen.c",
        "lib/mes/eputs.c",
        "lib/mes/fdputc.c",
        "lib/mes/eputc.c",
        "lib/mes/__assert_fail.c",
        "lib/mes/assert_msg.c",
        "lib/string/strncmp.c",
        "lib/posix/getenv.c",
        "lib/mes/fdputs.c",
        "lib/mes/ntoab.c",
        "lib/ctype/isdigit.c",
        "lib/ctype/isxdigit.c",
        "lib/ctype/isspace.c",
        "lib/ctype/isnumber.c",
        "lib/mes/abtol.c",
        "lib/stdlib/atoi.c",
        "lib/string/memcpy.c",
        "lib/stdlib/free.c",
        "lib/stdlib/realloc.c",
        "lib/string/strcpy.c",
        "lib/mes/itoa.c",
        "lib/mes/ltoa.c",
        "lib/mes/fdungetc.c",
        "lib/posix/setenv.c",
        "lib/linux/access.c",
        "lib/linux/chmod.c",
        "lib/linux/ioctl3.c",
        "lib/m2/isatty.c",
        "lib/linux/fork.c",
        "lib/m2/execve.c",
        "lib/m2/execv.c",
        "lib/linux/wait4.c",
        "lib/linux/waitpid.c",
        "lib/linux/gettimeofday.c",
        "lib/linux/clock_gettime.c",
        "lib/m2/time.c",
        "lib/linux/_getcwd.c",
        "lib/m2/getcwd.c",
        "lib/linux/dup.c",
        "lib/linux/dup2.c",
        "lib/string/strcmp.c",
        "lib/string/memcmp.c",
        "lib/linux/uname.c",
        "lib/linux/unlink.c",
        "src/builtins.c",
        "src/core.c",
        "src/display.c",
        "src/eval-apply.c",
        "src/gc.c",
        "src/hash.c",
        "src/lib.c",
        "src/m2.c",
        "src/math.c",
        "src/mes.c",
        "src/module.c",
        "src/posix.c",
        "src/reader.c",
        "src/stack.c",
        "src/string.c",
        "src/struct.c",
        "src/symbol.c",
        "src/variable.c",
        "src/vector.c",
        "lib/m2/x86_64/x86_64_defs.M1",
        "lib/x86_64-mes/x86_64.M1",
        "lib/linux/x86_64-mes-m2/crt1.M1",
    ]

    # --- M2-Planet source lists ---
    # These must be defined before untar() since they determine which files
    # to extract. The file order matters for M2-Planet: syscall.h must come
    # before files that use SYS_* defines (like _open3.c).

    _M2_SRCS_AMD64 = [
        "include/mes/lib-mini.h",
        "include/mes/lib.h",
        "lib/linux/x86_64-mes-m2/crt1.c",
        "lib/mes/__init_io.c",
        "lib/linux/x86_64-mes-m2/_exit.c",
        "lib/linux/x86_64-mes-m2/_write.c",
        "lib/mes/globals.c",
        "lib/m2/cast.c",
        "lib/stdlib/exit.c",
        "lib/mes/write.c",
        "include/linux/x86_64/syscall.h",
        "lib/linux/x86_64-mes-m2/syscall.c",
        "lib/stub/__raise.c",
        "lib/linux/brk.c",
        "lib/linux/malloc.c",
        "lib/string/memset.c",
        "lib/linux/read.c",
        "lib/mes/fdgetc.c",
        "lib/stdio/getchar.c",
        "lib/stdio/putchar.c",
        "lib/stub/__buffered_read.c",
        "include/errno.h",
        "include/fcntl.h",
        "lib/linux/_open3.c",
        "lib/linux/open.c",
        "lib/mes/mes_open.c",
        "lib/string/strlen.c",
        "lib/mes/eputs.c",
        "lib/mes/fdputc.c",
        "lib/mes/eputc.c",
        "include/time.h",
        "include/sys/time.h",
        "include/m2/types.h",
        "include/sys/types.h",
        "include/sys/utsname.h",
        "include/mes/mes.h",
        "include/mes/builtins.h",
        "include/mes/constants.h",
        "include/mes/symbols.h",
        "lib/mes/__assert_fail.c",
        "lib/mes/assert_msg.c",
        "lib/string/strncmp.c",
        "lib/posix/getenv.c",
        "lib/mes/fdputs.c",
        "lib/mes/ntoab.c",
        "lib/ctype/isdigit.c",
        "lib/ctype/isxdigit.c",
        "lib/ctype/isspace.c",
        "lib/ctype/isnumber.c",
        "lib/mes/abtol.c",
        "lib/stdlib/atoi.c",
        "lib/string/memcpy.c",
        "lib/stdlib/free.c",
        "lib/stdlib/realloc.c",
        "lib/string/strcpy.c",
        "lib/mes/itoa.c",
        "lib/mes/ltoa.c",
        "lib/mes/fdungetc.c",
        "lib/posix/setenv.c",
        "lib/linux/access.c",
        "include/linux/m2/kernel-stat.h",
        "include/sys/stat.h",
        "lib/linux/chmod.c",
        "lib/linux/ioctl3.c",
        "include/sys/ioctl.h",
        "lib/m2/isatty.c",
        "include/signal.h",
        "lib/linux/fork.c",
        "lib/m2/execve.c",
        "lib/m2/execv.c",
        "include/sys/resource.h",
        "lib/linux/wait4.c",
        "lib/linux/waitpid.c",
        "lib/linux/gettimeofday.c",
        "lib/linux/clock_gettime.c",
        "lib/m2/time.c",
        "lib/linux/_getcwd.c",
        "include/limits.h",
        "lib/m2/getcwd.c",
        "lib/linux/dup.c",
        "lib/linux/dup2.c",
        "lib/string/strcmp.c",
        "lib/string/memcmp.c",
        "lib/linux/uname.c",
        "lib/linux/unlink.c",
        "src/builtins.c",
        "src/core.c",
        "src/display.c",
        "src/eval-apply.c",
        "src/gc.c",
        "src/hash.c",
        "src/lib.c",
        "src/m2.c",
        "src/math.c",
        "src/mes.c",
        "src/module.c",
        "src/posix.c",
        "src/reader.c",
        "src/stack.c",
        "src/string.c",
        "src/struct.c",
        "src/symbol.c",
        "src/variable.c",
        "src/vector.c",
    ]

    # ARM M2-Planet sources: same as kaem.run order with arm-mes-m2 paths
    _M2_SRCS_ARM = [
        "include/mes/lib-mini.h",
        "include/mes/lib.h",
        "lib/linux/arm-mes-m2/crt1.c",
        "lib/mes/__init_io.c",
        "lib/linux/arm-mes-m2/_exit.c",
        "lib/linux/arm-mes-m2/_write.c",
        "lib/mes/globals.c",
        "lib/m2/cast.c",
        "lib/stdlib/exit.c",
        "lib/mes/write.c",
        "include/linux/arm/syscall.h",
        "lib/linux/arm-mes-m2/syscall.c",
        "lib/stub/__raise.c",
        "lib/linux/brk.c",
        "lib/linux/malloc.c",
        "lib/string/memset.c",
        "lib/linux/read.c",
        "lib/mes/fdgetc.c",
        "lib/stdio/getchar.c",
        "lib/stdio/putchar.c",
        "lib/stub/__buffered_read.c",
        "include/errno.h",
        "include/fcntl.h",
        "lib/linux/_open3.c",
        "lib/linux/open.c",
        "lib/mes/mes_open.c",
        "lib/string/strlen.c",
        "lib/mes/eputs.c",
        "lib/mes/fdputc.c",
        "lib/mes/eputc.c",
        "include/time.h",
        "include/sys/time.h",
        "include/m2/types.h",
        "include/sys/types.h",
        "include/sys/utsname.h",
        "include/mes/mes.h",
        "include/mes/builtins.h",
        "include/mes/constants.h",
        "include/mes/symbols.h",
        "lib/mes/__assert_fail.c",
        "lib/mes/assert_msg.c",
        "lib/string/strncmp.c",
        "lib/posix/getenv.c",
        "lib/mes/fdputs.c",
        "lib/mes/ntoab.c",
        "lib/ctype/isdigit.c",
        "lib/ctype/isxdigit.c",
        "lib/ctype/isspace.c",
        "lib/ctype/isnumber.c",
        "lib/mes/abtol.c",
        "lib/stdlib/atoi.c",
        "lib/string/memcpy.c",
        "lib/stdlib/free.c",
        "lib/stdlib/realloc.c",
        "lib/string/strcpy.c",
        "lib/mes/itoa.c",
        "lib/mes/ltoa.c",
        "lib/mes/fdungetc.c",
        "lib/posix/setenv.c",
        "lib/linux/access.c",
        "include/linux/m2/kernel-stat.h",
        "include/sys/stat.h",
        "lib/linux/chmod.c",
        "lib/linux/ioctl3.c",
        "include/sys/ioctl.h",
        "lib/m2/isatty.c",
        "include/signal.h",
        "lib/linux/fork.c",
        "lib/m2/execve.c",
        "lib/m2/execv.c",
        "include/sys/resource.h",
        "lib/linux/wait4.c",
        "lib/linux/waitpid.c",
        "lib/linux/gettimeofday.c",
        "lib/linux/clock_gettime.c",
        "lib/m2/time.c",
        "lib/linux/_getcwd.c",
        "include/limits.h",
        "lib/m2/getcwd.c",
        "lib/linux/dup.c",
        "lib/linux/dup2.c",
        "lib/string/strcmp.c",
        "lib/string/memcmp.c",
        "lib/linux/uname.c",
        "lib/linux/unlink.c",
        "src/builtins.c",
        "src/core.c",
        "src/display.c",
        "src/eval-apply.c",
        "src/gc.c",
        "src/hash.c",
        "src/lib.c",
        "src/m2.c",
        "src/math.c",
        "src/mes.c",
        "src/module.c",
        "src/posix.c",
        "src/reader.c",
        "src/stack.c",
        "src/string.c",
        "src/struct.c",
        "src/symbol.c",
        "src/variable.c",
        "src/vector.c",
    ]

    _M2_FILES_ARM = _M2_SRCS_ARM + [
        "lib/m2/arm/arm_defs.M1",
        "lib/arm-mes/arm.M1",
        "lib/linux/arm-mes-m2/crt1.M1",
    ]

    # --- Extract and prepare ---

    untar(
        name = "mes-{}".format(VERSION),
        target_compatible_with = _LINUX_COMPAT,
        input = ":mes-{}.tar".format(VERSION),
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
        untar = _TOOLS_EXTRA + ":untar",
        files = select({
            "cellar//bootstrap/platforms:amd64": _M2_FILES_AMD64,
            "cellar//bootstrap/platforms:aarch64": _M2_FILES_ARM,
        }),
    )

    write_file(
        name = "config.h",
        target_compatible_with = _LINUX_COMPAT,
        content = '#undef SYSTEM_LIBC\n#define MES_VERSION "{}"\n'.format(VERSION),
    )

    # --- M2-Planet pipeline ---

    M2_Planet(
        name = "mes.M1",
        target_compatible_with = _LINUX_COMPAT,
        tools = TOOLS,
        arch_stage0 = CPU_0,
        arch_mes = MES_CPU,
        defines = select({
            "cellar//bootstrap/platforms:amd64": ["__x86_64__=1", "__linux__=1"],
            "cellar//bootstrap/platforms:aarch64": ["__arm__=1", "__linux__=1"],
        }),
        srcs = [":config.h"] + select({
            "cellar//bootstrap/platforms:amd64": [
                ":mes-{}[{}]".format(VERSION, f)
                for f in _M2_SRCS_AMD64
            ],
            # ARM sources follow the same order as kaem.run: arch-specific
            # crt1/_exit/_write before shared libc, syscall.h before _open3.c
            "cellar//bootstrap/platforms:aarch64": [
                ":mes-{}[{}]".format(VERSION, f)
                for f in _M2_SRCS_ARM
            ],
        }),
    )

    blood_elf(
        name = "mes.blood-elf-M1",
        target_compatible_with = _LINUX_COMPAT,
        args = select({
            "cellar//bootstrap/platforms:amd64": ["--64", "--little-endian"],
            "cellar//bootstrap/platforms:aarch64": ["--little-endian"],
        }),
        tools = TOOLS,
        srcs = [":mes.M1"],
    )

    M1(
        name = "mes.hex2",
        target_compatible_with = _LINUX_COMPAT,
        tools = TOOLS,
        args = select({
            "cellar//bootstrap/platforms:amd64": ["--architecture", "amd64", "--little-endian"],
            "cellar//bootstrap/platforms:aarch64": ["--architecture", "armv7l", "--little-endian"],
        }),
        srcs = select({
            "cellar//bootstrap/platforms:amd64": [
                "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
                ":mes-{}[lib/x86_64-mes/x86_64.M1]".format(VERSION),
                ":mes-{}[lib/linux/x86_64-mes-m2/crt1.M1]".format(VERSION),
            ],
            "cellar//bootstrap/platforms:aarch64": [
                "cellar//bootstrap/stage0-posix/m2-libc:armv7l/armv7l_defs.M1",
                ":mes-{}[lib/arm-mes/arm.M1]".format(VERSION),
                ":mes-{}[lib/linux/arm-mes-m2/crt1.M1]".format(VERSION),
            ],
        }) + [":mes.M1", ":mes.blood-elf-M1"],
    )

    hex2(
        name = "mes.bin",
        target_compatible_with = _LINUX_COMPAT,
        tools = TOOLS,
        args = select({
            "cellar//bootstrap/platforms:amd64": ["--architecture", "amd64", "--little-endian", "--base-address", "0x1000000"],
            "cellar//bootstrap/platforms:aarch64": ["--architecture", "armv7l", "--little-endian", "--base-address", "0x1000000"],
        }),
        srcs = select({
            "cellar//bootstrap/platforms:amd64": ["cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64.hex2"],
            "cellar//bootstrap/platforms:aarch64": ["cellar//bootstrap/stage0-posix/m2-libc:armv7l/ELF-armv7l.hex2"],
        }) + [":mes.hex2"],
    )

    # --- Source preparation ---

    mes_prepare_src(
        name = "mes-src",
        target_compatible_with = _LINUX_COMPAT,
        src = ":mes-{}".format(VERSION),
        tools = TOOLS,
        nyacc = "cellar//bootstrap/nyacc:nyacc-{}".format(_NYACC_VERSION),
        mes_cpu = MES_CPU,
        version = VERSION,
        replace = _TOOLS_EXTRA + ":replace",
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
        prepare = _CELLAR_EXTRA + ":prepare-mes-src",
        cp = _TOOLS_EXTRA + ":cp",
        mkdir = _TOOLS_EXTRA + ":mkdir",
        rm = _TOOLS_EXTRA + ":rm",
    )

    # --- mescc libraries ---

    NYACC = "cellar//bootstrap/nyacc:nyacc-{}".format(_NYACC_VERSION)

    mescc_compile(
        name = "mescc-crt1",
        target_compatible_with = _LINUX_COMPAT,
        src_prefix = ":mes-src",
        mes_m2 = ":mes.bin",
        source_path = select({
            "cellar//bootstrap/platforms:amd64": "lib/linux/x86_64-mes-mescc/crt1.c",
            "cellar//bootstrap/platforms:aarch64": "lib/linux/arm-mes-mescc/crt1.c",
        }),
        mes_cpu = MES_CPU,
        nyacc = NYACC,
        tools = TOOLS,
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
    )

    mescc_build_lib(
        name = "libc-mini.a",
        target_compatible_with = _LINUX_COMPAT,
        sources = select({
            "cellar//bootstrap/platforms:amd64": libc_mini_sources("x86_64"),
            "cellar//bootstrap/platforms:aarch64": libc_mini_sources("arm"),
        }),
        src_prefix = ":mes-src",
        mes_m2 = ":mes.bin",
        mes_cpu = MES_CPU,
        catm = _TOOLS_EXTRA + ":catm",
        nyacc = NYACC,
        tools = TOOLS,
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
    )

    mescc_build_lib(
        name = "libmescc.a",
        target_compatible_with = _LINUX_COMPAT,
        sources = select({
            "cellar//bootstrap/platforms:amd64": libmescc_sources("x86_64"),
            "cellar//bootstrap/platforms:aarch64": libmescc_sources("arm"),
        }),
        src_prefix = ":mes-src",
        mes_m2 = ":mes.bin",
        mes_cpu = MES_CPU,
        catm = _TOOLS_EXTRA + ":catm",
        nyacc = NYACC,
        tools = TOOLS,
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
    )

    mescc_build_lib(
        name = "libc.a",
        target_compatible_with = _LINUX_COMPAT,
        sources = select({
            "cellar//bootstrap/platforms:amd64": libc_sources("x86_64"),
            "cellar//bootstrap/platforms:aarch64": libc_sources("arm"),
        }),
        src_prefix = ":mes-src",
        mes_m2 = ":mes.bin",
        mes_cpu = MES_CPU,
        catm = _TOOLS_EXTRA + ":catm",
        nyacc = NYACC,
        tools = TOOLS,
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
    )

    mescc_build_lib(
        name = "libc+tcc.a",
        target_compatible_with = _LINUX_COMPAT,
        sources = select({
            "cellar//bootstrap/platforms:amd64": libc_tcc_sources("x86_64"),
            "cellar//bootstrap/platforms:aarch64": libc_tcc_sources("arm"),
        }),
        src_prefix = ":mes-src",
        mes_m2 = ":mes.bin",
        mes_cpu = MES_CPU,
        catm = _TOOLS_EXTRA + ":catm",
        nyacc = NYACC,
        tools = TOOLS,
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
    )

    mes_libs(
        name = "mes-m2-libs",
        target_compatible_with = _LINUX_COMPAT,
        libs = {
            "crt1.o": ":mescc-crt1[crt1.o]",
            "crt1.s": ":mescc-crt1[crt1.s]",
            "libc-mini.a": ":libc-mini.a",
            "libc-mini.s": ":libc-mini.a[s]",
            "libmescc.a": ":libmescc.a",
            "libmescc.s": ":libmescc.a[s]",
            "libc.a": ":libc.a",
            "libc.s": ":libc.a[s]",
            "libc+tcc.a": ":libc+tcc.a",
            "libc+tcc.s": ":libc+tcc.a[s]",
        },
        mes_cpu = MES_CPU,
    )

    # --- Full mes binary ---

    mescc_build_mes(
        name = "mes-full",
        target_compatible_with = _LINUX_COMPAT,
        sources = MES_SOURCES,
        src_prefix = ":mes-src",
        mes_m2 = ":mes.bin",
        lib_dir = ":mes-m2-libs",
        crt1 = ":mescc-crt1[crt1.o]",
        mes_cpu = MES_CPU,
        nyacc = NYACC,
        tools = TOOLS,
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
    )

    # --- Mescc self-hosting fixed point ---

    _create_mescc_stage("s2", ":mes-full", MES_CPU, NYACC, TOOLS)
    _create_mescc_stage("s3", ":s2-mes", MES_CPU, NYACC, TOOLS)

    mescc_fixed_point_test(
        name = "mes-fixed-point",
        target_compatible_with = _LINUX_COMPAT,
        stage2 = ":s2-mes",
        stage3 = ":s3-mes",
        bytecmp = _CELLAR_EXTRA + ":bytecmp",
    )

    # --- Wrapper targets ---

    _mes(
        name = "mes",
        target_compatible_with = _LINUX_COMPAT,
        src_prefix = "cellar//bootstrap/mes:mes-src",
        bin = "cellar//bootstrap/mes:s3-mes",
        nyacc = NYACC,
        envexec = _CELLAR_EXTRA + ":envexec",
    )

    _mescc(
        name = "mescc",
        target_compatible_with = _LINUX_COMPAT,
        src_prefix = "cellar//bootstrap/mes:mes-src",
        mes_m2 = "cellar//bootstrap/mes:s3-mes",
        lib_dir = "cellar//bootstrap/mes:s3-libs",
        nyacc = NYACC,
        tools = TOOLS,
        envexec = _CELLAR_EXTRA + ":envexec",
    )

    # --- Tests ---

    export_file(
        name = "hello.c",
        target_compatible_with = _LINUX_COMPAT,
    )
    mescc_test(
        name = "hello-test",
        target_compatible_with = _LINUX_COMPAT,
        src = ":hello.c",
        src_prefix = ":mes-src",
        mes_m2 = ":mes.bin",
        lib_dir = ":mes-m2-libs",
        crt1 = ":mescc-crt1[crt1.o]",
        mes_cpu = MES_CPU,
        nyacc = NYACC,
        tools = TOOLS,
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
    )
