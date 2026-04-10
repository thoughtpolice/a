
def __cc(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]

    m2libc = ctx.attrs._m2_libc[DefaultInfo].default_outputs[0]
    ctx.actions.run(
        cmd_args(
            cmd_args(tools, format = "{}/M2-Mesoplanet"),
            "--operating-system", ctx.attrs.os,
            "--architecture", ctx.attrs.arch,
            "-f", ctx.attrs.src,
            '-o', output.as_output(),
        ),
        env = {
            'M2LIBC_PATH': m2libc,
            'PATH': tools,
        },
        category = "stage0_m2_mesoplanet",
        clear_environment = True,
    )
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

cc = rule(impl = __cc, attrs = {
    'os': attrs.string(),
    'arch': attrs.string(),
    'src': attrs.source(),
    'tools': attrs.dep(),
    '_m2_libc': attrs.default_only(
        attrs.dep(default = "cellar//bootstrap/stage0-posix/m2-libc:m2-libc")
    ),
})
