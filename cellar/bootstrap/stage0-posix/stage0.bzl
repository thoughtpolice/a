load(
    "@cellar//bootstrap:defs.bzl",
    "export_file",
    "filegroup",
    "stage0_answer_test",
)

def __hex0(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.run(
        [
            ctx.attrs.bin,
            ctx.attrs.src,
            output.as_output(),
        ],
        category = "stage0_hex012",
    )
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

hex0 = rule(impl = __hex0, attrs = {
    "bin": attrs.source(),
    "src": attrs.source(),
})

# hex1 and hex2 have the same APIs
hex1 = hex0
hex2_0 = hex0

# catm removes the need for cat or shell support for redirection by providing
# equivalent functionality via catm output_file input1 input2 ... inputN
def __catm(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.run(
        [
            ctx.attrs.bin,
            output.as_output(),
        ] + ctx.attrs.inputs,
        category = "stage0_catm",
    )
    return [
        DefaultInfo(default_output = output),
    ]

catm = rule(impl = __catm, attrs = {
    "bin": attrs.source(),
    "inputs": attrs.list(attrs.source()),
})

def __M0(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.run(
        [
            ctx.attrs.bin,
            ctx.attrs.src,
            output.as_output(),
        ],
        category = "stage0_m0",
    )
    return [
        DefaultInfo(default_output = output),
    ]

M0 = rule(impl = __M0, attrs = {
    "bin": attrs.source(),
    "src": attrs.source(),
})

def __cc(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.run(
        [
            ctx.attrs.bin,
            ctx.attrs.src,
            output.as_output(),
        ],
        category = "stage0_cc",
    )
    return [
        DefaultInfo(default_output = output),
    ]

cc = rule(impl = __cc, attrs = {
    "bin": attrs.source(),
    "src": attrs.source(),
})

def __M2(ctx: AnalysisContext) -> list[Provider]:
    cmd = [
        ctx.attrs.bin,
        "--architecture",
        ctx.attrs.arch,
    ]
    for src in ctx.attrs.srcs:
        cmd.extend(["-f", src])
    if ctx.attrs.bootstrap:
        cmd.append("--bootstrap-mode")
    if ctx.attrs.debug:
        cmd.append("--debug")
    output = ctx.actions.declare_output(ctx.label.name)
    cmd.extend(["-o", output.as_output()])

    ctx.actions.run(cmd, category = "stage0_m2")
    return [
        DefaultInfo(default_output = output),
    ]

M2 = rule(impl = __M2, attrs = {
    "bin": attrs.source(),
    "arch": attrs.string(),
    "srcs": attrs.list(attrs.source()),
    "bootstrap": attrs.bool(default = False),
    "debug": attrs.bool(default = False),
})

def __blood_elf(ctx: AnalysisContext) -> list[Provider]:
    cmd = [
        ctx.attrs.bin,
    ]
    if ctx.attrs.sixtyfour:
        cmd.append("--64")
    if ctx.attrs.little_endian:
        cmd.append("--little-endian")
    for src in ctx.attrs.srcs:
        cmd.extend(["-f", src])
    output = ctx.actions.declare_output(ctx.label.name)
    cmd.extend(["-o", output.as_output()])

    ctx.actions.run(cmd, category = "stage0_blood_elf")
    return [
        DefaultInfo(default_output = output),
    ]

blood_elf = rule(impl = __blood_elf, attrs = {
    "bin": attrs.source(),
    "sixtyfour": attrs.bool(),
    "little_endian": attrs.bool(),
    "srcs": attrs.list(attrs.source()),
})

def __m1_0(ctx: AnalysisContext) -> list[Provider]:
    cmd = [
        ctx.attrs.bin,
        "--architecture",
        ctx.attrs.arch,
    ]
    if ctx.attrs.little_endian:
        cmd.append("--little-endian")
    for src in ctx.attrs.srcs:
        cmd.extend(["-f", src])
    output = ctx.actions.declare_output(ctx.label.name)
    cmd.extend(["-o", output.as_output()])

    ctx.actions.run(cmd, category = "stage0_m1_zero")
    return [
        DefaultInfo(default_output = output),
    ]

M1_0 = rule(impl = __m1_0, attrs = {
    "bin": attrs.source(),
    "arch": attrs.string(),
    "little_endian": attrs.bool(),
    "srcs": attrs.list(attrs.source()),
})

def __hex2_1(ctx: AnalysisContext) -> list[Provider]:
    cmd = [
        ctx.attrs.bin,
        "--architecture",
        ctx.attrs.arch,
    ]
    if ctx.attrs.little_endian:
        cmd.append("--little-endian")
    if ctx.attrs.base_address:
        cmd.extend(["--base-address", ctx.attrs.base_address])
    for src in ctx.attrs.srcs:
        cmd.extend(["-f", src])
    output = ctx.actions.declare_output(ctx.label.name)
    cmd.extend(["-o", output.as_output()])

    ctx.actions.run(cmd, category = "stage0_hex2_one")
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

hex2_1 = rule(impl = __hex2_1, attrs = {
    "bin": attrs.source(),
    "arch": attrs.string(),
    "little_endian": attrs.bool(),
    "base_address": attrs.string(),
    "srcs": attrs.list(attrs.source()),
})

M1 = M1_0
hex2 = hex2_1

# -----------------------------------------------------------------------------
# stage0_binaries: generate the full phase 0-15 build graph for a single target
# architecture. Called from each seeds/linux-<arch>/BUILD with architecture
# parameters; all the heavy lifting (source file lists, rule wiring) lives here
# so the per-arch BUILD files stay small.
#
# Arguments:
#   arch            architecture identifier passed to M2/M1/hex2 rules
#                   ("amd64", "aarch64", ...).
#   m2libc_dir      subdirectory within m2-libc for this arch's libc
#                   ("amd64", "aarch64", ...). Only differs from `arch` in
#                   capitalization on some architectures; kept separate for
#                   clarity and future-proofing.
#   catm_src        name of the hand-written catm source file in the current
#                   package. On amd64 this is "catm.hex2" (built with hex2-0);
#                   on aarch64 it is "catm.hex1" (built with hex1). Upstream
#                   stage0-posix chose the earlier hex level for aarch64 for
#                   historical reasons, so we match it.
#   catm_bin        target to use to assemble `catm_src` — ":hex2-0" on amd64
#                   and ":hex1" on aarch64.
def stage0_binaries(
        arch,
        m2libc_dir,
        catm_src,
        catm_bin,
        compat = {}):
    m2libc = "cellar//bootstrap/stage0-posix/m2-libc"
    m2planet = "cellar//bootstrap/stage0-posix/m2-planet"
    m2mesoplanet = "cellar//bootstrap/stage0-posix/m2-mesoplanet"
    mescctools = "cellar//bootstrap/stage0-posix/mescc-tools"

    # Source lists that show up verbatim in the upstream kaem scripts for every
    # phase from 8 onward. Everything except the final few hand-written sources
    # is shared across architectures; the arch-specific libc pieces are pulled
    # from m2-libc via `m2libc_dir`.
    arch_linux_sources = [
        m2libc + ":sys/types.h",
        m2libc + ":stddef.h",
        m2libc + ":sys/utsname.h",
        m2libc + ":" + m2libc_dir + "/linux/unistd.c",
        m2libc + ":" + m2libc_dir + "/linux/fcntl.c",
        m2libc + ":fcntl.c",
        m2libc + ":" + m2libc_dir + "/linux/sys/stat.c",
        m2libc + ":ctype.c",
        m2libc + ":stdlib.c",
        m2libc + ":stdarg.h",
        m2libc + ":stdio.h",
        m2libc + ":stdio.c",
        m2libc + ":bootstrappable.c",
    ]

    # Same list as above but without `sys/stat.c`; used by phases that build
    # M1 / kaem / M2-Mesoplanet where libc/string.c is needed instead.
    arch_linux_sources_no_stat = [
        m2libc + ":sys/types.h",
        m2libc + ":stddef.h",
        m2libc + ":" + m2libc_dir + "/linux/fcntl.c",
        m2libc + ":fcntl.c",
        m2libc + ":sys/utsname.h",
        m2libc + ":" + m2libc_dir + "/linux/unistd.c",
        m2libc + ":stdarg.h",
        m2libc + ":string.c",
        m2libc + ":ctype.c",
        m2libc + ":stdlib.c",
        m2libc + ":stdio.h",
        m2libc + ":stdio.c",
        m2libc + ":bootstrappable.c",
    ]

    # Source list for phases 14/15 (get_machine, M2-Planet rebuild): no stat,
    # no string.c, and the "unistd before fcntl" ordering that arch_linux_sources
    # uses.
    arch_linux_sources_core = [
        m2libc + ":sys/types.h",
        m2libc + ":stddef.h",
        m2libc + ":sys/utsname.h",
        m2libc + ":" + m2libc_dir + "/linux/unistd.c",
        m2libc + ":" + m2libc_dir + "/linux/fcntl.c",
        m2libc + ":fcntl.c",
        m2libc + ":ctype.c",
        m2libc + ":stdlib.c",
        m2libc + ":stdarg.h",
        m2libc + ":stdio.h",
        m2libc + ":stdio.c",
        m2libc + ":bootstrappable.c",
    ]

    # Source list for kaem: same as arch_linux_sources_no_stat but reordered
    # and without fcntl.c-twice pattern; matches upstream exactly.
    kaem_linux_sources = [
        m2libc + ":sys/types.h",
        m2libc + ":stddef.h",
        m2libc + ":sys/utsname.h",
        m2libc + ":" + m2libc_dir + "/linux/unistd.c",
        m2libc + ":" + m2libc_dir + "/linux/fcntl.c",
        m2libc + ":fcntl.c",
        m2libc + ":ctype.c",
        m2libc + ":stdlib.c",
        m2libc + ":string.c",
        m2libc + ":stdarg.h",
        m2libc + ":stdio.h",
        m2libc + ":stdio.c",
        m2libc + ":bootstrappable.c",
    ]

    # Final set of filegroup outputs: these are what the `:bins` filegroup
    # exposes to downstream (namely mescc-tools-extra).
    defs_m1 = m2libc + ":" + m2libc_dir + "/" + m2libc_dir + "_defs.M1"
    libc_core_m1 = m2libc + ":" + m2libc_dir + "/libc-core.M1"
    libc_full_m1 = m2libc + ":" + m2libc_dir + "/libc-full.M1"
    elf_hex2 = m2libc + ":" + m2libc_dir + "/ELF-" + m2libc_dir + ".hex2"
    elf_debug_hex2 = m2libc + ":" + m2libc_dir + "/ELF-" + m2libc_dir + "-debug.hex2"

    filegroup(
        name = "bins",
        srcs = [
            ":M1",
            ":hex2",
            ":M2-Mesoplanet",
            ":blood-elf",
            ":get_machine",
            ":M2-Planet",
        ],
        **compat
    )

    # Phase 0a: build hex0 from the bootstrap binary
    hex0(name = "hex0", bin = "hex0-seed", src = "hex0.hex0", **compat)

    # Phase 1: build hex1 from hex0
    hex0(name = "hex1", bin = ":hex0", src = "hex1.hex0", **compat)

    # Phase 2a: build hex2 from hex1
    hex1(name = "hex2-0", bin = ":hex1", src = "hex2.hex1", **compat)

    # Phase 2b: build catm. On amd64 this uses hex2-0 + catm.hex2; on aarch64
    # it uses hex1 + catm.hex1 (see docstring above).
    hex2_0(name = "catm", bin = catm_bin, src = catm_src, **compat)

    # Phase 3: build M0 from hex2
    catm(
        name = "M0.hex2",
        bin = ":catm",
        inputs = [
            "ELF.hex2",
            "M0.hex2",
        ],
        **compat
    )
    hex2_0(name = "M0", bin = ":hex2-0", src = ":M0.hex2", **compat)

    # Phase 4: build architecture-specific cc from M0
    M0(name = "cc.hex2", bin = ":M0", src = "cc.M1", **compat)
    catm(
        name = "cc-0.hex2",
        bin = ":catm",
        inputs = [
            "ELF.hex2",
            ":cc.hex2",
        ],
        **compat
    )
    hex2_0(name = "cc", bin = ":hex2-0", src = ":cc-0.hex2", **compat)

    # Phase 5: build M2-Planet from cc
    catm(
        name = "M2-0.c",
        bin = ":catm",
        inputs = [
            "bootstrap.c",
            m2planet + ":cc.h",
            m2libc + ":bootstrappable.c",
            m2planet + ":cc_globals.c",
            m2planet + ":cc_reader.c",
            m2planet + ":cc_strings.c",
            m2planet + ":cc_types.c",
            m2planet + ":cc_emit.c",
            m2planet + ":cc_core.c",
            m2planet + ":cc_macro.c",
            m2planet + ":cc.c",
        ],
        **compat
    )
    cc(name = "M2-0.M1", bin = ":cc", src = ":M2-0.c", **compat)
    catm(
        name = "M2-0-0.M1",
        bin = ":catm",
        inputs = [
            "defs.M1",
            "libc-core.M1",
            ":M2-0.M1",
        ],
        **compat
    )
    M0(name = "M2-0.hex2", bin = ":M0", src = ":M2-0-0.M1", **compat)
    catm(
        name = "M2-0-0.hex2",
        bin = ":catm",
        inputs = [
            "ELF.hex2",
            ":M2-0.hex2",
        ],
        **compat
    )
    hex2_0(name = "M2", bin = ":hex2-0", src = ":M2-0-0.hex2", **compat)

    # Phase 6: build blood-elf0 from C sources. This is the last stage where
    # the binaries will not have debug info and the last piece built that
    # isn't part of the output binaries.
    M2(
        name = "blood-elf-0.M1",
        bin = ":M2",
        arch = arch,
        bootstrap = True,
        srcs = [
            "bootstrap.c",
            m2libc + ":bootstrappable.c",
            mescctools + ":stringify.c",
            mescctools + ":blood-elf.c",
        ],
        **compat
    )
    catm(
        name = "blood-elf-0-0.M1",
        bin = ":catm",
        inputs = [
            defs_m1,
            libc_core_m1,
            ":blood-elf-0.M1",
        ],
        **compat
    )
    M0(name = "blood-elf-0.hex2", bin = ":M0", src = ":blood-elf-0-0.M1", **compat)
    catm(
        name = "blood-elf-0-0.hex2",
        bin = ":catm",
        inputs = [
            elf_hex2,
            ":blood-elf-0.hex2",
        ],
        **compat
    )
    hex2_0(name = "blood-elf-0", bin = ":hex2-0", src = ":blood-elf-0-0.hex2", **compat)

    # Phase 7: build M1-0 from C sources
    M2(
        name = "M1-macro-0.M1",
        bin = ":M2",
        arch = arch,
        bootstrap = True,
        debug = True,
        srcs = [
            "bootstrap.c",
            m2libc + ":bootstrappable.c",
            mescctools + ":stringify.c",
            mescctools + ":M1-macro.c",
        ],
        **compat
    )
    blood_elf(
        name = "M1-macro-0-footer.M1",
        bin = ":blood-elf-0",
        sixtyfour = True,
        little_endian = True,
        srcs = [":M1-macro-0.M1"],
        **compat
    )
    catm(
        name = "M1-macro-0-0.M1",
        bin = ":catm",
        inputs = [
            defs_m1,
            libc_core_m1,
            ":M1-macro-0.M1",
            ":M1-macro-0-footer.M1",
        ],
        **compat
    )
    M0(name = "M1-macro-0.hex2", bin = ":M0", src = ":M1-macro-0-0.M1", **compat)
    catm(
        name = "M1-macro-0-0.hex2",
        bin = ":catm",
        inputs = [
            elf_debug_hex2,
            ":M1-macro-0.hex2",
        ],
        **compat
    )
    hex2_0(name = "M1-0", bin = ":hex2-0", src = ":M1-macro-0-0.hex2", **compat)

    # Phase 8: build hex2-1 from C sources. This is the last stage where catm
    # will need to be used and the last stage where M0 is used, as we will be
    # using its much more powerful and cross-platform version with a bunch of
    # extra goodies.
    M2(
        name = "hex2_linker-1.M1",
        bin = ":M2",
        arch = arch,
        debug = True,
        srcs = arch_linux_sources + [
            mescctools + ":hex2.h",
            mescctools + ":hex2_linker.c",
            mescctools + ":hex2_word.c",
            mescctools + ":hex2.c",
        ],
        **compat
    )
    blood_elf(
        name = "hex2_linker-1-footer.M1",
        bin = ":blood-elf-0",
        sixtyfour = True,
        little_endian = True,
        srcs = [":hex2_linker-1.M1"],
        **compat
    )
    M1_0(
        name = "hex2_linker-1.hex2",
        bin = ":M1-0",
        arch = arch,
        little_endian = True,
        srcs = [
            defs_m1,
            libc_core_m1,
            ":hex2_linker-1.M1",
            ":hex2_linker-1-footer.M1",
        ],
        **compat
    )
    catm(
        name = "hex2_linker-1-0.hex2",
        bin = ":catm",
        inputs = [
            "ELF.hex2",
            ":hex2_linker-1.hex2",
        ],
        **compat
    )
    hex2_0(name = "hex2-1", bin = ":hex2-0", src = ":hex2_linker-1-0.hex2", **compat)

    # Phase 9: build M1 from C sources
    M2(
        name = "M1-macro-1.M1",
        bin = ":M2",
        arch = arch,
        debug = True,
        srcs = arch_linux_sources_no_stat + [
            mescctools + ":stringify.c",
            mescctools + ":M1-macro.c",
        ],
        **compat
    )
    blood_elf(
        name = "M1-macro-1-footer.M1",
        bin = ":blood-elf-0",
        sixtyfour = True,
        little_endian = True,
        srcs = [":M1-macro-1.M1"],
        **compat
    )
    M1_0(
        name = "M1-macro-1.hex2",
        bin = ":M1-0",
        arch = arch,
        little_endian = True,
        srcs = [
            defs_m1,
            libc_full_m1,
            ":M1-macro-1.M1",
            ":M1-macro-1-footer.M1",
        ],
        **compat
    )
    hex2_1(
        name = "M1",
        bin = ":hex2-1",
        arch = arch,
        little_endian = True,
        base_address = "0x00600000",
        srcs = [
            elf_debug_hex2,
            ":M1-macro-1.hex2",
        ],
        **compat
    )

    # Phase 10: build hex2 from C sources
    M2(
        name = "hex2_linker-2.M1",
        bin = ":M2",
        arch = arch,
        debug = True,
        srcs = arch_linux_sources + [
            mescctools + ":hex2.h",
            mescctools + ":hex2_linker.c",
            mescctools + ":hex2_word.c",
            mescctools + ":hex2.c",
        ],
        **compat
    )
    blood_elf(
        name = "hex2_linker-2-footer.M1",
        bin = ":blood-elf-0",
        sixtyfour = True,
        little_endian = True,
        srcs = [":hex2_linker-2.M1"],
        **compat
    )
    M1(
        name = "hex2_linker-2.hex2",
        bin = ":M1",
        arch = arch,
        little_endian = True,
        srcs = [
            defs_m1,
            libc_full_m1,
            ":hex2_linker-2.M1",
            ":hex2_linker-2-footer.M1",
        ],
        **compat
    )
    hex2_1(
        name = "hex2",
        bin = ":hex2-1",
        arch = arch,
        little_endian = True,
        base_address = "0x00600000",
        srcs = [
            elf_debug_hex2,
            ":hex2_linker-2.hex2",
        ],
        **compat
    )

    # Phase 11: build kaem from C sources
    M2(
        name = "kaem.M1",
        bin = ":M2",
        arch = arch,
        debug = True,
        srcs = kaem_linux_sources + [
            mescctools + ":Kaem/kaem.h",
            mescctools + ":Kaem/variable.c",
            mescctools + ":Kaem/kaem_globals.c",
            mescctools + ":Kaem/kaem.c",
        ],
        **compat
    )
    blood_elf(
        name = "kaem-footer.M1",
        bin = ":blood-elf-0",
        sixtyfour = True,
        little_endian = True,
        srcs = [":kaem.M1"],
        **compat
    )
    M1(
        name = "kaem.hex2",
        bin = ":M1",
        arch = arch,
        little_endian = True,
        srcs = [
            defs_m1,
            libc_full_m1,
            ":kaem.M1",
            ":kaem-footer.M1",
        ],
        **compat
    )
    hex2(
        name = "kaem",
        bin = ":hex2",
        arch = arch,
        little_endian = True,
        base_address = "0x00600000",
        srcs = [
            elf_debug_hex2,
            ":kaem.hex2",
        ],
        **compat
    )

    # Phase 12: build M2-Mesoplanet from M2-Planet
    M2(
        name = "M2-Mesoplanet-1.M1",
        bin = ":M2",
        arch = arch,
        debug = True,
        srcs = [
            m2libc + ":sys/types.h",
            m2libc + ":stddef.h",
            m2libc + ":" + m2libc_dir + "/linux/fcntl.c",
            m2libc + ":fcntl.c",
            m2libc + ":sys/utsname.h",
            m2libc + ":" + m2libc_dir + "/linux/unistd.c",
            m2libc + ":" + m2libc_dir + "/linux/sys/stat.c",
            m2libc + ":ctype.c",
            m2libc + ":stdlib.c",
            m2libc + ":stdarg.h",
            m2libc + ":stdio.h",
            m2libc + ":stdio.c",
            m2libc + ":string.c",
            m2libc + ":bootstrappable.c",
            m2mesoplanet + ":cc.h",
            m2mesoplanet + ":cc_globals.c",
            m2mesoplanet + ":cc_env.c",
            m2mesoplanet + ":cc_reader.c",
            m2mesoplanet + ":cc_spawn.c",
            m2mesoplanet + ":cc_core.c",
            m2mesoplanet + ":cc_macro.c",
            m2mesoplanet + ":cc.c",
        ],
        **compat
    )
    blood_elf(
        name = "M2-Mesoplanet-1-footer.M1",
        bin = ":blood-elf-0",
        sixtyfour = True,
        little_endian = True,
        srcs = [":M2-Mesoplanet-1.M1"],
        **compat
    )
    M1(
        name = "M2-Mesoplanet-1.hex2",
        bin = ":M1",
        arch = arch,
        little_endian = True,
        srcs = [
            defs_m1,
            libc_full_m1,
            ":M2-Mesoplanet-1.M1",
            ":M2-Mesoplanet-1-footer.M1",
        ],
        **compat
    )
    hex2(
        name = "M2-Mesoplanet",
        bin = ":hex2",
        arch = arch,
        little_endian = True,
        base_address = "0x00600000",
        srcs = [
            elf_debug_hex2,
            ":M2-Mesoplanet-1.hex2",
        ],
        **compat
    )

    # Phase 13: build final blood-elf from C sources
    M2(
        name = "blood-elf-1.M1",
        bin = ":M2",
        arch = arch,
        debug = True,
        srcs = [
            m2libc + ":sys/types.h",
            m2libc + ":stddef.h",
            m2libc + ":" + m2libc_dir + "/linux/fcntl.c",
            m2libc + ":fcntl.c",
            m2libc + ":sys/utsname.h",
            m2libc + ":" + m2libc_dir + "/linux/unistd.c",
            m2libc + ":ctype.c",
            m2libc + ":stdlib.c",
            m2libc + ":stdarg.h",
            m2libc + ":stdio.h",
            m2libc + ":stdio.c",
            m2libc + ":bootstrappable.c",
            mescctools + ":stringify.c",
            mescctools + ":blood-elf.c",
        ],
        **compat
    )
    blood_elf(
        name = "blood-elf-1-footer.M1",
        bin = ":blood-elf-0",
        sixtyfour = True,
        little_endian = True,
        srcs = [":blood-elf-1.M1"],
        **compat
    )
    M1(
        name = "blood-elf-1.hex2",
        bin = ":M1",
        arch = arch,
        little_endian = True,
        srcs = [
            defs_m1,
            libc_full_m1,
            ":blood-elf-1.M1",
            ":blood-elf-1-footer.M1",
        ],
        **compat
    )
    hex2(
        name = "blood-elf",
        bin = ":hex2",
        arch = arch,
        little_endian = True,
        base_address = "0x00600000",
        srcs = [
            elf_debug_hex2,
            ":blood-elf-1.hex2",
        ],
        **compat
    )

    # Now we have our shipping debuggable blood-elf; the rest will be downhill
    # from here as we have ALL of the core pieces of compiling and assembling
    # debuggable programs in a debuggable form with corresponding C source code.

    # Phase 14: build get_machine from C sources
    M2(
        name = "get_machine.M1",
        bin = ":M2",
        arch = arch,
        debug = True,
        srcs = arch_linux_sources_core + [
            mescctools + ":get_machine.c",
        ],
        **compat
    )
    blood_elf(
        name = "get_machine-footer.M1",
        bin = ":blood-elf",
        sixtyfour = True,
        little_endian = True,
        srcs = [":get_machine.M1"],
        **compat
    )
    M1(
        name = "get_machine.hex2",
        bin = ":M1",
        arch = arch,
        little_endian = True,
        srcs = [
            defs_m1,
            libc_full_m1,
            ":get_machine.M1",
            ":get_machine-footer.M1",
        ],
        **compat
    )
    hex2(
        name = "get_machine",
        bin = ":hex2",
        arch = arch,
        little_endian = True,
        base_address = "0x00600000",
        srcs = [
            elf_debug_hex2,
            ":get_machine.hex2",
        ],
        **compat
    )

    # Phase 15: build final M2-Planet from M2-Planet
    M2(
        name = "M2-1.M1",
        bin = ":M2",
        arch = arch,
        debug = True,
        srcs = arch_linux_sources_core + [
            m2planet + ":cc.h",
            m2planet + ":cc_globals.c",
            m2planet + ":cc_reader.c",
            m2planet + ":cc_strings.c",
            m2planet + ":cc_types.c",
            m2planet + ":cc_emit.c",
            m2planet + ":cc_core.c",
            m2planet + ":cc_macro.c",
            m2planet + ":cc.c",
        ],
        **compat
    )
    blood_elf(
        name = "M2-1-footer.M1",
        bin = ":blood-elf",
        sixtyfour = True,
        little_endian = True,
        srcs = [":M2-1.M1"],
        **compat
    )
    M1(
        name = "M2-1.hex2",
        bin = ":M1",
        arch = arch,
        little_endian = True,
        srcs = [
            defs_m1,
            libc_full_m1,
            ":M2-1.M1",
            ":M2-1-footer.M1",
        ],
        **compat
    )
    hex2(
        name = "M2-Planet",
        bin = ":hex2",
        arch = arch,
        little_endian = True,
        base_address = "0x00600000",
        srcs = [
            elf_debug_hex2,
            ":M2-1.hex2",
        ],
        **compat
    )

# -----------------------------------------------------------------------------
# stage0_platform: the single entry point each seeds/linux-<arch>/BUILD calls.
# It:
#   1) creates the exported `:answers` file target;
#   2) invokes `stage0_binaries` to wire up the full build graph;
#   3) assembles the platform-specific filegroup (named via `filegroup_name`)
#      laying out the produced binaries under `<arch_dir_upper>/bin/`, mirroring
#      the upstream stage0-posix directory layout that `<arch>.answers` expects;
#   4) declares the `:check` test that runs sha256sum over that filegroup
#      against the golden answers.
#
# All targets are gated via `target_compatible_with` constraints from
# cellar//bootstrap/platforms so they are skipped on incompatible hosts
# instead of failing at build time.
#
# Arguments:
#   arch              target architecture passed to M2/M1/hex2 rules.
#   m2libc_dir        subdirectory within m2-libc for this arch's libc.
#   arch_dir_upper    layout directory under the answers file ("AMD64",
#                     "AArch64", ...). Matches upstream stage0-posix naming.
#   filegroup_name    name of the filegroup that holds the binaries + answers.
#   catm_src          hand-written catm source file (see stage0_binaries).
#   catm_bin          target to assemble catm_src with (see stage0_binaries).
def stage0_platform(
        arch,
        m2libc_dir,
        arch_dir_upper,
        filegroup_name,
        catm_src,
        catm_bin):
    compat = {"target_compatible_with": [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:" + arch,
    ]}

    export_file(name = "answers", **compat)

    stage0_binaries(
        arch = arch,
        m2libc_dir = m2libc_dir,
        catm_src = catm_src,
        catm_bin = catm_bin,
        compat = compat,
    )

    mtex = "cellar//bootstrap/stage0-posix/mescc-tools-extra"
    bindir = arch_dir_upper + "/bin"
    filegroup(
        name = filegroup_name,
        srcs = {
            "answers": ":answers",
            bindir + "/blood-elf": ":blood-elf",
            bindir + "/catm": mtex + ":catm",
            bindir + "/chmod": mtex + ":chmod",
            bindir + "/cp": mtex + ":cp",
            bindir + "/get_machine": ":get_machine",
            bindir + "/hex2": ":hex2",
            bindir + "/kaem": ":kaem",
            bindir + "/M1": ":M1",
            bindir + "/M2-Mesoplanet": ":M2-Mesoplanet",
            bindir + "/M2-Planet": ":M2-Planet",
            bindir + "/match": mtex + ":match",
            bindir + "/mkdir": mtex + ":mkdir",
            bindir + "/replace": mtex + ":replace",
            bindir + "/rm": mtex + ":rm",
            bindir + "/sha256sum": mtex + ":sha256sum",
            bindir + "/ungz": mtex + ":ungz",
            bindir + "/unbz2": mtex + ":unbz2",
            bindir + "/unxz": mtex + ":unxz",
            bindir + "/untar": mtex + ":untar",
        },
        **compat
    )

    stage0_answer_test(
        name = "check",
        command = mtex + ":sha256sum",
        chdirexec = mtex + ":chdirexec",
        input = ":" + filegroup_name,
        args = ["--check", "answers"],
        **compat
    )
