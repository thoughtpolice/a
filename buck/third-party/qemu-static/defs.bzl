# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

_swtpm_cmd = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args(ctx.attrs._script[DefaultInfo].default_outputs[0])),
        LocalResourceInfo(
            setup = cmd_args(ctx.attrs._script[DefaultInfo].default_outputs[0]),
            resource_env_vars = {
                "SWTPM_SOCKET": "socket_path"
            },
        ),
    ],
    attrs = {
        "_script": attrs.default_only(attrs.exec_dep(default = "third-party//qemu-static:run-swtpm"))
    }
)

def _run_qemu_impl(ctx: AnalysisContext) -> list[Provider]:
    args = cmd_args([
            'qemu-system-' + ctx.attrs.system,
            '-nographic',
        ] + ctx.attrs.args + ([
            '-chardev', 'socket,id=swtpm,path="$SWTPM_SOCKET"',
            '-tpmdev emulator,id=tpm0,chardev=swtpm',
            '-device', 'tpm-tis-device,tpmdev=tpm0',
        ] if ctx.attrs.swtpm_broker else []),
        delimiter = " ",
    )
    cmd = cmd_args(['/usr/bin/env', 'bash', '-c', args])

    return [
        DefaultInfo(),
        RunInfo(args = cmd),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [ cmd ],
            local_resources = {
                'swtpm': ctx.attrs.swtpm_broker.label
            } if ctx.attrs.swtpm_broker else {},
            required_local_resources = [
                RequiredTestLocalResource("swtpm", listing = False, execution = True),
            ] if ctx.attrs.swtpm_broker else [],
        ),
    ]

_run_qemu = rule(impl = _run_qemu_impl, attrs = {
    "system": attrs.string(),
    "args": attrs.list(attrs.arg()),
    "swtpm_broker": attrs.option(attrs.exec_dep(
        providers = [LocalResourceInfo]),
        default = None,
    ),
})

qemu = struct(
    run_qemu = _run_qemu,
    run_swtpm = _swtpm_cmd,
)
