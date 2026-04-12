#!/bin/sh
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Assemble a rootfs from pinned .apk files (third-party//by-name/wo/wolfi)
# with mkapkroot, then cull it down via cull, writing a tarball.
#
# Each --provided layer tar is unpacked beside the rootfs so cull can
# resolve the .so closure against what the image already ships below
# this layer, without copying any of it.
#
# Usage: assemble_and_cull.sh MKAPKROOT CULL KEEPFILE DENYFILE OUT_TAR
#        [--provided LAYER_TAR]... APK...
#
# DENYFILE may be empty.

set -eu

MKAPKROOT="$1"
CULL="$2"
KEEPFILE="$3"
DENYFILE="$4"
OUT_TAR="$5"
shift 5

ROOT=$(mktemp -d)
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT INT TERM

PROVIDED=""
while [ "${1:-}" = "--provided" ]; do
    PROVIDED="$ROOT/provided"
    mkdir -p "$PROVIDED"
    tar -xf "$2" -C "$PROVIDED"
    shift 2
done

"$MKAPKROOT" --dest "$ROOT/rootfs" "$@"
"$CULL" \
    --rootfs "$ROOT/rootfs" \
    --keepfile "$KEEPFILE" \
    ${DENYFILE:+--denyfile "$DENYFILE"} \
    ${PROVIDED:+--provided-rootfs "$PROVIDED"} \
    --out "$OUT_TAR"
