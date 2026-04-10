
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

def create_all(sources):
    """Create cc targets for all mescc-tools-extra C sources.

    Must be called from a BUILD file with glob() results since select() is
    only available as a built-in in .bzl files (the cellar cell's noprelude
    shim overrides it in BUILD files).
    """
    for src in sources:
        name = src.split(".")[0] if "." in src else src
        cc(
            name = name,
            src = src,
            os = "Linux",
            arch = select({
                "cellar//bootstrap/platforms:amd64": "amd64",
                "cellar//bootstrap/platforms:aarch64": "aarch64",
            }),
            tools = select({
                "cellar//bootstrap/platforms:amd64": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
                "cellar//bootstrap/platforms:aarch64": "cellar//bootstrap/stage0-posix/seeds/linux-arm64:bins",
            }),
            target_compatible_with = ["cellar//bootstrap/platforms:linux"],
        )
