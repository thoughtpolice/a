#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# devices.sh QEMU ARGS...: start QEMU, paused, with a VNC server, user-mode
# networking and a writable vvfat drive of a scratch directory, all under the
# devices ARGS add, and check over QMP that each came up. @DIR@ in ARGS is
# the scratch directory.

set -uo pipefail

qemu=$1
shift
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
mkdir "$dir/fat"
echo hello > "$dir/fat/hello.txt"

qmp() {
    printf '{"execute":"human-monitor-command","arguments":{"command-line":"%s"}}\n' "$1"
}

out=$({
    echo '{"execute":"qmp_capabilities"}'
    echo '{"execute":"query-vnc"}'
    qmp "info network"
    qmp "info block"
    qmp "info qtree"
    echo '{"execute":"quit"}'
} | timeout 60 "$qemu" "${@//@DIR@/$dir}" \
    -S -nodefaults -display none -vnc "unix:$dir/vnc" \
    -netdev user,id=net0 \
    -drive "if=none,id=fat0,format=raw,file=fat:rw:$dir/fat" \
    -qmp stdio 2>&1)
status=$?
if [ "$status" != 0 ]; then
    printf '%s\n' "$out"
    echo "devices.sh: QEMU exited with status $status" >&2
    exit 1
fi

check() {
    if ! grep -q -- "$1" <<<"$out"; then
        printf '%s\n' "$out"
        echo "devices.sh: no $2 in QEMU's answers" >&2
        exit 1
    fi
}

check '"enabled": true' "VNC server"
check 'net0: index=0,type=user' "user-mode network"
check 'fat0 (#block[0-9]*): json:{.*vvfat' "vvfat drive"
check 'dev: virtio-net-pci' "virtio-net-pci"
check 'dev: virtio-blk-pci' "virtio-blk-pci"
check 'dev: virtio-gpu-pci' "virtio-gpu-pci"
