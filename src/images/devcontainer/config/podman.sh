#!/bin/sh
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Installed as /usr/local/bin/podman and /usr/local/bin/docker, ahead of
# /usr/bin on PATH. Both run Podman, so the tests that drive `docker`
# run their containers with it.
#
# Inside a container started with --privileged, Podman can only create
# containers once it may delegate cgroup controllers. cgroup v2 lets a
# cgroup enable controllers for its children only while no process sits
# in it directly, and every process of the outer container sits in the
# root of its cgroup namespace. So, the first time through, move them
# all into a child, init, and enable every controller below the root, as
# Docker-in-Docker does. The runtime that starts the outer container puts
# processes it later execs into init too. Anywhere else, such as a host
# or a container without --privileged, the root isn't writable and this
# changes nothing.

# cgroupfs files always have size 0, so `test -s` can't tell whether
# one is empty; read them instead.
root=/sys/fs/cgroup
if [ "$(cat /proc/self/cgroup 2>/dev/null)" = "0::/" ] &&
    [ -w "$root/cgroup.subtree_control" ] &&
    [ -n "$(cat "$root/cgroup.procs")" ]; then
    mkdir -p "$root/init"
    # Processes can start while this runs, so take a few passes.
    for _ in 1 2 3 4 5; do
        procs=$(cat "$root/cgroup.procs")
        [ -n "$procs" ] || break
        for pid in $procs; do
            echo "$pid" > "$root/init/cgroup.procs" 2>/dev/null || :
        done
    done
    sed -e 's/ / +/g' -e 's/^/+/' < "$root/cgroup.controllers" > "$root/cgroup.subtree_control"
fi

exec /usr/bin/podman "$@"
