---
name: using-exe-dev
description: Guides working with exe.dev VMs. Use when the user mentions exe.dev, exe VMs, *.exe.xyz, or tasks involving exe.dev infrastructure.
---

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Use exe.dev

Use exe.dev to manage Linux VMs with persistent disks, automatic HTTPS, and
built-in authentication. Each VM has `https://<vm>.exe.xyz/` with automatic TLS.

## Discover the supported commands

Start with the [documentation index](https://exe.dev/docs.md), then follow the
page for the task. Use [all documentation](https://exe.dev/docs/all.md) only when
a consolidated reference is needed.

```bash
ssh exe.dev help
ssh exe.dev help <command>
ssh exe.dev ls --json
ssh exe.dev new --json
ssh exe.dev vm-logs <vm>
ssh exe.dev rm <vm>
```

Inspect command-specific help for lifecycle, sharing, and configuration options.
Delete a VM only when deletion is part of the requested task.

If an exe.dev MCP `exec` tool is available, read its schema and use it for account
commands. Its command is the portion after `ssh exe.dev`: start with `help`, then
`help <command>`. Use `ssh <vm> <shell command>` through that API to run commands
inside a VM, following the tool's quoting rules.

## Choose the correct SSH destination

- `ssh exe.dev <command>` connects to the account lobby for VM management. It is
  not a shell and does not support scp, sftp, or arbitrary shell commands.
- `ssh <vm>.exe.xyz` connects directly to a VM. Use it for shell access, scp,
  sftp, and port forwarding.

```bash
ssh <vm>.exe.xyz
ssh <vm>.exe.xyz 'uname -a'
scp file.txt <vm>.exe.xyz:~/
```

Do not send a file transfer to `exe.dev`; target the VM hostname instead.

## Handle non-interactive connections

For a first connection to a new VM, permit a new host key without disabling
checks for changed keys:

```bash
ssh -o StrictHostKeyChecking=accept-new <vm>.exe.xyz 'uname -a'
```

Check host-key prompts when an unattended connection appears hung. Check that
both account and VM destinations select the intended identity; adapt this SSH
configuration to the actual key path:

```sshconfig
Host exe.dev *.exe.xyz
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_ed25519
```

For scp/sftp failures, confirm the VM destination and SSH authentication first.
If file-transfer tools are unavailable, transfer over the VM's SSH shell rather
than the lobby. Verify the result on the VM and exercise the actual service at
its `.exe.xyz` URL when the task changes a web-facing deployment.
