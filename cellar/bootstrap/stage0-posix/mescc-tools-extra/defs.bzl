load("@cellar//bootstrap:defs.bzl", "native_attrs")

# Where M2-Mesoplanet's hex2 step loads programs, by architecture.
_BASE_ADDRESS = {
    "amd64": "0x00600000",
}

def __cc(ctx: AnalysisContext) -> list[Provider]:
    """Compile one C program the way M2-Mesoplanet would, one action a step.

    M2-Mesoplanet is a driver: it preprocesses, then runs M2-Planet,
    blood-elf, M1 and hex2 on files it makes in TMPDIR (/tmp unless set),
    with names in 100-byte buffers, too small for any directory in
    buck-out. So it only preprocesses here, and each step after is an action
    of its own, with the arguments the driver would pass: a build needs no
    /tmp, and as everywhere else in the bootstrap, every step is declared.
    The programs come out the same, as the answers check.
    """
    name = ctx.label.name
    arch = ctx.attrs.arch
    tools = ctx.attrs.tools[DefaultInfo].default_outputs[0]
    m2libc = ctx.attrs._m2_libc[DefaultInfo].default_outputs[0]

    def tool(program):
        return cmd_args(tools, format = "{}/" + program)

    def libc(path):
        return cmd_args(m2libc, format = "{}/" + path.format(arch = arch))

    preprocessed = ctx.actions.declare_output(name + ".c")
    ctx.actions.run(
        cmd_args(
            tool("M2-Mesoplanet"),
            "--operating-system",
            ctx.attrs.os,
            "--architecture",
            arch,
            "-E",
            "-f",
            ctx.attrs.src,
            "-o",
            preprocessed.as_output(),
        ),
        env = {"M2LIBC_PATH": m2libc},
        category = "stage0_m2_mesoplanet",
        clear_environment = True,
    )

    # The driver compiles with debug information unless the target is UEFI.
    m1 = ctx.actions.declare_output(name + ".M1")
    ctx.actions.run(
        cmd_args(
            tool("M2-Planet"),
            "--file",
            preprocessed,
            "--output",
            m1.as_output(),
            "--architecture",
            arch,
            "--debug",
        ),
        category = "stage0_m2",
        clear_environment = True,
    )

    footer = ctx.actions.declare_output(name + "-footer.M1")
    ctx.actions.run(
        cmd_args(
            tool("blood-elf"),
            "--file",
            m1,
            "--little-endian",
            "--output",
            footer.as_output(),
            "--64",
        ),
        category = "stage0_blood_elf",
        clear_environment = True,
    )

    # Every one of these programs includes <stdio.h>, for which the driver
    # links the full libc rather than the core.
    hex2 = ctx.actions.declare_output(name + ".hex2")
    ctx.actions.run(
        cmd_args(
            tool("M1"),
            "--file",
            libc("{arch}/{arch}_defs.M1"),
            "--file",
            libc("{arch}/libc-full.M1"),
            "--file",
            m1,
            "--little-endian",
            "--architecture",
            arch,
            "--file",
            footer,
            "--output",
            hex2.as_output(),
        ),
        category = "stage0_m1",
        clear_environment = True,
    )

    output = ctx.actions.declare_output(name)
    ctx.actions.run(
        cmd_args(
            tool("hex2"),
            "--file",
            libc("{arch}/ELF-{arch}-debug.hex2"),
            "--file",
            hex2,
            "--output",
            output.as_output(),
            "--architecture",
            arch,
            "--base-address",
            _BASE_ADDRESS[arch],
            "--little-endian",
        ),
        category = "stage0_hex2",
        clear_environment = True,
    )
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

_cc_rule = rule(impl = __cc, attrs = {
    "os": attrs.string(),
    "arch": attrs.string(),
    "src": attrs.source(),
    "tools": attrs.exec_dep(),
    "_m2_libc": attrs.default_only(
        attrs.dep(default = "cellar//bootstrap/stage0-posix/m2-libc:m2-libc"),
    ),
})

def cc(**kwargs):
    _cc_rule(**native_attrs(kwargs))

def create_all(sources):
    """Create cc targets for all mescc-tools-extra C sources.

    BUILD supplies the source inventory; this helper applies the shared
    native compiler settings.
    """
    for src in sources:
        name = src.split(".")[0] if "." in src else src
        cc(
            name = name,
            src = src,
            os = "Linux",
            arch = "amd64",
            tools = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
        )
