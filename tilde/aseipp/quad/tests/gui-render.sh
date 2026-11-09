#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# tests/gui-render.ss as a dynamic_test (buck/shims/dynamic_test_internal.bzl),
# so that a machine that cannot draw reports it as skipped, rather than
# passed or failed: one whose C library is older than the toolchain's (the
# host-linked quad does not start), or with no Vulkan device or fonts.
# Frames are drawn with Mesa's lavapipe, a software renderer, where it is
# installed, so that they do not depend on the GPU; else on any device.
#
# gui-render.sh [-list-tests | -run-test] QUAD TESTS-DIR [FILTER]

set -uo pipefail

case "${1:-}" in
-list-tests)
    echo "test: render render"
    exit 0
    ;;
-run-test)
    shift
    set -- "${@:1:$#-1}"
    ;;
esac

quad=$1
tests=$2

if ! "$quad" --version >/dev/null 2>&1; then
    echo "result: SKIP render - the host-linked quad does not run here"
    exit 0
fi

run() {
    QUAD_GUI_DEVICE=$1 "$quad" -q --batch "$tests/gui-render.ss" 2>&1
}
out=$(run llvmpipe)
status=$?
if grep -q '^SKIP: ' <<<"$out"; then
    out=$(run "")
    status=$?
fi

if skip=$(grep -m1 '^SKIP: ' <<<"$out"); then
    echo "result: SKIP render - ${skip#SKIP: }"
elif [ $status -eq 0 ] && ! grep -q '^FAIL' <<<"$out"; then
    echo "result: PASS render -"
else
    echo "result: FAIL render -"
    while IFS= read -r line; do
        echo "result-details: $line"
    done <<<"$out"
    exit 1
fi
