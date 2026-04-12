#!/bin/sh
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Unpack an OCI image with umoci and then cull the rootfs via cull.py,
# writing a tarball. Exists because Buck2's oci_unpack exposes the full
# tree as an artifact and fails to validate filenames containing escape
# sequences like systemd's `system-systemd\x2dcryptsetup.slice`.
#
# Usage: unpack_and_cull.sh UMOCI IMAGE_DIR CULL_PY KEEPFILE DENYFILE OUT_TAR

set -eu

UMOCI="$1"
IMAGE_DIR="$2"
CULL_PY="$3"
KEEPFILE="$4"
DENYFILE="$5"
OUT_TAR="$6"

BUNDLE=$(mktemp -d)
cleanup() { rm -rf "$BUNDLE"; }
trap cleanup EXIT INT TERM

"$UMOCI" unpack --rootless --image "$IMAGE_DIR:latest" "$BUNDLE"
python3 "$CULL_PY" \
    --rootfs "$BUNDLE/rootfs" \
    --keepfile "$KEEPFILE" \
    --denyfile "$DENYFILE" \
    --out "$OUT_TAR"
