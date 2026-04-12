#!/bin/sh
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Assemble a rootfs from pinned .apk files with mkapkroot.py, then cull
# it down via cull.py, writing a tarball. The apk-flavoured sibling of
# unpack_and_cull.sh: same shape, but the input is a package list from
# third-party//by-name/wo/wolfi instead of an OCI donor image.
#
# Usage: assemble_and_cull.sh MKAPKROOT_PY CULL_PY KEEPFILE DENYFILE OUT_TAR APK...

set -eu

MKAPKROOT="$1"
CULL_PY="$2"
KEEPFILE="$3"
DENYFILE="$4"
OUT_TAR="$5"
shift 5

ROOT=$(mktemp -d)
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT INT TERM

python3 "$MKAPKROOT" --dest "$ROOT/rootfs" "$@"
python3 "$CULL_PY" \
    --rootfs "$ROOT/rootfs" \
    --keepfile "$KEEPFILE" \
    --denyfile "$DENYFILE" \
    --out "$OUT_TAR"
