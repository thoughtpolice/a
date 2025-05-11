
def __hex0(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.run(
        [
            ctx.attrs.bin,
            ctx.attrs.src,
            output.as_output(),
        ],
        category = "stage0_hex012"
    )
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

hex0 = rule(impl = __hex0, attrs = {
    'bin': attrs.source(),
    'src': attrs.source(),
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
        category = "stage0_catm"
    )
    return [
        DefaultInfo(default_output = output),
    ]

catm = rule(impl = __catm, attrs = {
    'bin': attrs.source(),
    'inputs': attrs.list(attrs.source()),
})

def __M0(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.run(
        [
            ctx.attrs.bin,
            ctx.attrs.src,
            output.as_output(),
        ],
        category = "stage0_m0"
    )
    return [
        DefaultInfo(default_output = output),
    ]

M0 = rule(impl = __M0, attrs = {
    'bin': attrs.source(),
    'src': attrs.source(),
})

def __cc(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.run(
        [
            ctx.attrs.bin,
            ctx.attrs.src,
            output.as_output(),
        ],
        category = "stage0_cc"
    )
    return [
        DefaultInfo(default_output = output),
    ]

cc = rule(impl = __cc, attrs = {
    'bin': attrs.source(),
    'src': attrs.source(),
})

def __M2(ctx: AnalysisContext) -> list[Provider]:
    cmd = [
        ctx.attrs.bin,
        "--architecture", ctx.attrs.arch,
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
    'bin': attrs.source(),
    'arch': attrs.string(),
    'srcs': attrs.list(attrs.source()),
    'bootstrap': attrs.bool(default = False),
    'debug': attrs.bool(default = False),
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
    'bin': attrs.source(),
    'sixtyfour': attrs.bool(),
    'little_endian': attrs.bool(),
    'srcs': attrs.list(attrs.source()),
})

def __m1_0(ctx: AnalysisContext) -> list[Provider]:
    cmd = [
        ctx.attrs.bin,
        "--architecture", ctx.attrs.arch,
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
    'bin': attrs.source(),
    'arch': attrs.string(),
    'little_endian': attrs.bool(),
    'srcs': attrs.list(attrs.source()),
})

def __hex2_1(ctx: AnalysisContext) -> list[Provider]:
    cmd = [
        ctx.attrs.bin,
        "--architecture", ctx.attrs.arch,
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
    'bin': attrs.source(),
    'arch': attrs.string(),
    'little_endian': attrs.bool(),
    'base_address': attrs.string(),
    'srcs': attrs.list(attrs.source()),
})

M1 = M1_0
hex2 = hex2_1
