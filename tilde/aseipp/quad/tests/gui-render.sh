#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# A test that draws frames with no window (tests/SCRIPT.ss: gui-render, by
# default, or golden) as a dynamic_test (buck/shims/dynamic_test_internal.bzl),
# so that a machine that cannot draw reports it as skipped, rather than
# passed or failed: one whose C library is older than the toolchain's (the
# host-linked quad does not start), or with no Vulkan device or fonts.
# Frames are drawn with Mesa's lavapipe, a software renderer, where it is
# installed, so that they do not depend on the GPU; else on any device the
# script takes (golden.ss takes none other).
#
# gui-render.sh [-list-tests | -run-test] QUAD TESTS-DIR [SCRIPT] [FILTER]

set -uo pipefail

case "${1:-}" in
-list-tests)
    script=${4:-gui-render}
    name=${script#gui-}
    echo "test: $name $name"
    exit 0
    ;;
-run-test)
    shift
    set -- "${@:1:$#-1}"
    ;;
esac

quad=$1
tests=$2
script=${3:-gui-render}
name=${script#gui-}

if ! "$quad" --version >/dev/null 2>&1; then
    echo "result: SKIP $name - the host-linked quad does not run here"
    exit 0
fi

run() {
    QUAD_GUI_DEVICE=$1 QUAD_GOLDEN="$tests/golden" "$quad" -q --batch "$tests/$script.ss" 2>&1
}
out=$(run llvmpipe)
status=$?
if grep -q '^SKIP: ' <<<"$out"; then
    out=$(run "")
    status=$?
fi

if skip=$(grep -m1 '^SKIP: ' <<<"$out"); then
    echo "result: SKIP $name - ${skip#SKIP: }"
elif [ $status -eq 0 ] && ! grep -q '^FAIL' <<<"$out"; then
    echo "result: PASS $name -"
else
    echo "result: FAIL $name -"
    while IFS= read -r line; do
        echo "result-details: $line"
    done <<<"$out"
    exit 1
fi
