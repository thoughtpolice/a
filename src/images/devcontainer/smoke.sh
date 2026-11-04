#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# The devcontainer's smoke test. It loads the image into docker and runs
# smoke-inside.sh in a container with no network, which checks that the
# tools the build expects are there and work. Without a docker it can
# use, the test reports SKIP under Buck2's test protocol and fails under
# a plain `buck2 run`.
#
# Usage: smoke.sh OCI LAYOUT INSIDE_SCRIPT

set -euo pipefail

PROTOCOL=0
case "${1:-}" in
    -list-tests)
        echo "test: smoke smoke"
        exit 0
        ;;
    -run-test)
        PROTOCOL=1
        shift
        if [[ $# -eq 0 || "${!#}" != smoke ]]; then
            echo "smoke: expected the filter \`smoke\` last" >&2
            exit 2
        fi
        set -- "${@:1:$#-1}"
        ;;
esac

OCI="${1:?oci tool binary}"
LAYOUT="${2:?oci image layout dir}"
INSIDE="${3:?script to run in the container}"

result() {
    [[ "$PROTOCOL" -eq 1 ]] && echo "result: $1 smoke - ${2:-}"
    return 0
}

problem=""
if ! command -v docker >/dev/null 2>&1; then
    problem="docker is not installed"
elif ! info=$(docker version --format '{{.Server.Version}}' 2>&1); then
    problem="docker can't reach its daemon: $info"
fi
if [[ -n "$problem" ]]; then
    if [[ "$PROTOCOL" -eq 0 ]]; then
        echo "smoke: $problem" >&2
        exit 1
    fi
    result SKIP "$problem"
    exit 0
fi

# Tag by the layout's own digest, so concurrent runs of different builds
# never share a tag.
digest=$(sha256sum "$LAYOUT/index.json" | cut -c1-16)
tag="devcontainer-smoke:$digest"
"$OCI" load --image "$LAYOUT" --tag "$tag" >&2
trap 'docker image rm "$tag" >/dev/null 2>&1 || true' EXIT

if docker run --rm --network none --interactive "$tag" bash -s < "$INSIDE"; then
    result PASS
else
    result FAIL "smoke-inside.sh failed; its output is above"
    exit 1
fi
