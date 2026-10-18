#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# boot.sh STATUS QEMU ARGS...: run QEMU on one of the tests/ programs and
# check that it printed "ok" and exited with STATUS.

set -uo pipefail

status=$1
shift

out=$(timeout 60 "$@" 2>&1 </dev/null)
got=$?
printf '%s\n' "$out"
if [ "$got" != "$status" ]; then
    echo "boot.sh: QEMU exited with status $got, not $status" >&2
    exit 1
fi
if ! grep -qx ok <<<"$out"; then
    echo "boot.sh: the guest did not print ok" >&2
    exit 1
fi
