#!/bin/sh
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Installed as /usr/local/bin/buck2 and /usr/local/bin/jj. Each runs the
# DotSlash launcher of its own name from the checkout around the working
# directory, so a fresh clone builds without putting buck/bin on PATH.

name=${0##*/}
dir=$PWD
while :; do
    if [ -f "$dir/.buckroot" ]; then
        for launcher in "$dir/buck/bin/$name" "$dir/buck/bin/extra/$name"; do
            if [ -f "$launcher" ]; then
                exec dotslash "$launcher" "$@"
            fi
        done
    fi
    [ "$dir" = / ] && break
    dir=$(dirname "$dir")
done
printf '%s: no checkout with buck/bin/%s around %s\n' "$name" "$name" "$PWD" >&2
exit 127
