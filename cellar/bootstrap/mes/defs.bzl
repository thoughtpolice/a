load("@cellar//bootstrap:defs.bzl", "export_file")

def __write_file(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.write(output, ctx.attrs.content)
    return [ DefaultInfo(default_output = output) ]

write_file = rule(impl = __write_file, attrs = {
    'content': attrs.string(),
})

def __download_file(ctx: AnalysisContext) -> list[Provider]:
    if len(ctx.attrs.urls) != 1:
        # TODO FIXME (aseipp): support multiple URLs
        fail("expected exactly one URL to download")

    hash = ctx.attrs.hash
    if hash == None or hash == "":
        # NOTE(aseipp): this is useful for doing TOFU on hashes; it will always
        # fail but buck2 will tell us the real hash
        hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        warning("expected a hash for the tarball, this will always fail")

    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.download_file(
        output,
        ctx.attrs.urls[0],
        sha256 = hash,
    )

    return [
        DefaultInfo(default_output = output)
    ]

download_file = rule(impl = __download_file, attrs = {
    'urls': attrs.list(attrs.string()),
    'hash': attrs.option(attrs.string(), default = None),
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
    return [ DefaultInfo(default_output = output) ]

ungz = rule(impl = __ungz, attrs = {
    'ungz': attrs.dep(),
    'input': attrs.dep(),
})

def __untar(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name, dir = True)
    ctx.actions.run(
        [
            ctx.attrs.tarxf,
            ctx.attrs.chdirexec[DefaultInfo].default_outputs[0],
            cmd_args(ctx.attrs.untar[DefaultInfo].default_outputs[0], relative_to = output),
            output.as_output(),
            cmd_args(ctx.attrs.input[DefaultInfo].default_outputs[0], relative_to = output),
            "--non-strict",
            "--file",
        ],

        category = "mes_stage0_untar",
    )
    return [
        DefaultInfo(
            default_output = output,
            sub_targets = {
                path: [ DefaultInfo(default_output = output.project(path)) ]
                    for path in ctx.attrs.files
            },
        )
    ]

untar = rule(impl = __untar, attrs = {
    'chdirexec': attrs.dep(),
    'tarxf': attrs.source(),
    'untar': attrs.dep(),
    'input': attrs.dep(),
    'files': attrs.list(attrs.string(), default = []),
})

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
        env = {
            'PATH': tools,
        },
        category = "mes_m2_planet",
    )
    return [ DefaultInfo(default_output = output) ]

M2_Planet = rule(impl = __m2_planet, attrs = {
    'tools': attrs.dep(),
    'arch_stage0': attrs.string(),
    'arch_mes': attrs.string(),
    'defines': attrs.list(attrs.string(), default = []),
    'srcs': attrs.list(attrs.source()),
})

def _blood_elf_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    blood_elf = tools.project("blood-elf")

    cmd = [
        blood_elf,
        ctx.attrs.args,
    ]

    for f in ctx.attrs.srcs:
        cmd.extend(["-f", f])

    cmd.extend(["-o", output.as_output()])
    ctx.actions.run(
        cmd,
        env = {
            'PATH': tools,
        },
        category = "mes_blood_elf",
    )
    return [ DefaultInfo(default_output = output) ]

blood_elf = rule(impl = _blood_elf_impl, attrs = {
    'tools': attrs.dep(),
    'args': attrs.list(attrs.arg()),
    'srcs': attrs.list(attrs.source()),
})

def _m1_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    m1 = tools.project("M1")

    cmd = [
        m1,
        ctx.attrs.args,
    ]

    for f in ctx.attrs.srcs:
        cmd.extend(["-f", f])

    cmd.extend(["-o", output.as_output()])

    ctx.actions.run(
        cmd,
        env = {
            'PATH': tools,
        },
        category = "mes_m1",
    )
    return [ DefaultInfo(default_output = output) ]

M1 = rule(impl = _m1_impl, attrs = {
    'tools': attrs.dep(),
    'args': attrs.list(attrs.arg()),
    'srcs': attrs.list(attrs.source()),
})

def _hex2_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    hex2 = tools.project("hex2")

    cmd = [
        hex2,
        ctx.attrs.args,
    ]

    for f in ctx.attrs.srcs:
        cmd.extend(["-f", f])

    cmd.extend(["-o", output.as_output()])

    ctx.actions.run(
        cmd,
        env = {
            'PATH': tools,
        },
        category = "mes_hex2",
    )
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

hex2 = rule(impl = _hex2_impl, attrs = {
    'tools': attrs.dep(),
    'args': attrs.list(attrs.arg()),
    'srcs': attrs.list(attrs.source()),
})

def _mes_bin_impl(ctx: AnalysisContext) -> list[Provider]:
    cmd = [
        ctx.attrs.wrapper[DefaultInfo].default_outputs[0],
        ctx.attrs.prefix,
        ctx.attrs.bin[DefaultInfo].default_outputs[0],
    ]

    return [
        DefaultInfo(),
        RunInfo(args = cmd_args(cmd)),
    ]

_mes = rule(impl = _mes_bin_impl, attrs = {
    'wrapper': attrs.dep(),
    'prefix': attrs.default_only(attrs.arg(default = "$(location cellar//bootstrap/mes:mes-0.27)")),
    'bin': attrs.default_only(attrs.dep(default = "cellar//bootstrap/mes:mes.bin")),
})

def mes_bins():
    export_file(name = 'mes.sh')
    _mes(
        name = 'mes',
        wrapper = "cellar//bootstrap/mes:mes.sh",
    )
