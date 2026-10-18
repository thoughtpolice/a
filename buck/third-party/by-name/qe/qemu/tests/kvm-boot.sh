#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# The x86_64 boot test under KVM, as a dynamic_test (see
# buck/shims/dynamic_test_internal.bzl), so that a machine without a usable
# /dev/kvm reports it as skipped rather than passed or failed.
#
# kvm-boot.sh [-list-tests | -run-test] BOOT QEMU ARGS... [FILTER]

set -uo pipefail

case "${1:-}" in
-list-tests)
    echo "test: kvm kvm"
    exit 0
    ;;
-run-test)
    shift
    set -- "${@:1:$#-1}"
    ;;
esac

if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    echo "result: SKIP kvm - /dev/kvm is not available"
    exit 0
fi

boot=$1
shift
if out=$("$boot" 1 "$@" 2>&1); then
    echo "result: PASS kvm -"
else
    echo "result: FAIL kvm -"
    while IFS= read -r line; do
        echo "result-details: $line"
    done <<<"$out"
    exit 1
fi
