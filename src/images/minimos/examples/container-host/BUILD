# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/images/minimos:defs.bzl", "minimos")

# minimos + containerd, with gVisor as the only OCI runtime. The image is
# an appliance for running containers, in the shape of Bottlerocket, and
# ships no userland of its own. The userland comes inside the containers.
#
# No layer has runc, crun or containerd-shim-runc-v2, so nothing but
# gVisor can start a container here. The boot smoke checks that against
# the built layers.
#
# Workloads are part of the image. A layer stacked on this one ships
# /etc/minimos/containers/<name>.env and enables container@<name>.service
# (see container@.service). The SSH owner can pull and inspect with ctr,
# but can't start a container, as the example README explains.

# gVisor's dotted release paths never change, while `release/<date>`
# moves if a second release ships that day. Pinning the dotted one makes
# an update a deliberate bump rather than a hash mismatch.
_GVISOR_RELEASE = "20260914.0"

_GVISOR_URL = "https://storage.googleapis.com/gvisor/releases/release/{}/x86_64".format(
    _GVISOR_RELEASE,
)

# runsc, its containerd shim, and the helpers runsc runs from gvisor-bin/
# next to itself. Without the helpers runsc falls back to embedded copies,
# which upstream stops supporting after 2026-10, or downloads them when a
# sandbox starts.
_GVISOR_BINARIES = [
    "runsc",
    "containerd-shim-runsc-v1",
    "gvisor-bin/checkpointgofer",
    "gvisor-bin/gvisor-sentry-prewarmer",
    "gvisor-bin/gvisor_sentry",
    "gvisor-bin/runsc-fd-parking",
    "gvisor-bin/runsc-metric-server",
]

# gVisor (Apache-2.0, © The gVisor Authors) as upstream's static release
# binaries, since Wolfi has no gvisor package. Releases after 20260817.0
# publish only this archive. The sha256 was checked against upstream's
# .sha512 file at the same URL.
depot.http_archive(
    name = "gvisor",
    sha256 = "94a1b9716797efcb0b348fc3283ddaa1ee5c7898b61eeccb08ee9ac7dc903c15",
    sub_targets = _GVISOR_BINARIES,
    type = "tar.bz2",
    urls = ["{}/gvisor.tar.bz2".format(_GVISOR_URL)],
)

# gVisor's own docs install runsc in /usr/local/bin. The base has no
# /usr/local, so this layer declares the directories.
minimos.overlay(
    name = "gvisor-overlay-layer",
    dirs = [
        "usr/local",
        "usr/local/bin",
        "usr/local/bin/gvisor-bin",
    ],
    files = {
        "usr/local/bin/" + binary: ":gvisor[{}]:755".format(binary)
        for binary in _GVISOR_BINARIES
    },
)

# containerd, ctr and nerdctl, the CNI plugins container networking runs,
# and iptables' nft binary. iptables links libxtables, libmnl and
# libnftnl, and the rest need at most the base's glibc.
minimos.apk_culled_layer(
    name = "containerd-culled-layer",
    apks = [
        "containerd-2",
        "ctr-2",
        "nerdctl",
        "cni-plugins",
        "iptables",
        "libmnl",
        "libnftnl",
    ],
)

# Configuration for containerd, the gVisor shim and nerdctl, and the
# units that run them.
minimos.overlay(
    name = "container-host-overlay-layer",
    dirs = [
        "etc",
        "etc/systemd",
        "etc/systemd/system",
        "etc/systemd/system/multi-user.target.wants",
        "etc/containerd",
        # Where the gVisor shim looks for its config. See runsc-config.toml.
        "etc/containerd/runsc",
        # One <name>.env per container@<name>.service, shipped by a layer
        # stacked on this image.
        "etc/minimos",
        "etc/minimos/containers",
        "etc/nerdctl",
        # nerdctl writes its bridge network here the first time a
        # container needs it. The image ships only the directory.
        "etc/cni",
        "etc/cni/net.d",
        "opt",
        "opt/cni",
        "opt/cni/bin",
        "var",
        "var/lib",
        "var/lib/containerd",
        "var/lib/nerdctl",
    ],
    files = {
        "etc/containerd/config.toml": "containerd-config.toml",
        "etc/containerd/runsc/config.toml": "runsc-config.toml",
        # Applied by containerd.service, not the boot-time tmpfiles pass.
        # See the file.
        "etc/containerd/socket-access.conf": "socket-access.conf",
        "etc/nerdctl/nerdctl.toml": "nerdctl.toml",
    },
    symlinks = {
        # CNI's usual plugin directory. Wolfi installs the plugins in
        # /usr/bin, and cni_path shouldn't point at every other program
        # there too.
        "opt/cni/bin/bridge": "/usr/bin/bridge",
        "opt/cni/bin/firewall": "/usr/bin/firewall",
        "opt/cni/bin/host-local": "/usr/bin/host-local",
        "opt/cni/bin/loopback": "/usr/bin/loopback",
        "opt/cni/bin/portmap": "/usr/bin/portmap",
        "opt/cni/bin/tuning": "/usr/bin/tuning",
        # The names the CNI plugins run. Wolfi's own iptables link points
        # at the legacy backend, which this image doesn't ship.
        "usr/bin/ip6tables": "xtables-nft-multi",
        "usr/bin/ip6tables-restore": "xtables-nft-multi",
        "usr/bin/ip6tables-save": "xtables-nft-multi",
        "usr/bin/iptables": "xtables-nft-multi",
        "usr/bin/iptables-restore": "xtables-nft-multi",
        "usr/bin/iptables-save": "xtables-nft-multi",
    },
    # containerd is enabled by its [Install] section. The template has
    # none. A layer above enables each instance with a
    # multi-user.target.wants link next to its .env file. The slice needs
    # no enabling, since the units that name it pull it in.
    units = [
        "containerd.service",
        "container@.service",
        "containers.slice",
    ],
)

minimos.image(
    name = "minimos-container-host",
    boot_smoke_containers = True,
    boot_smoke_units = ["containerd.service"],
    description = "minimos + containerd with gVisor as the only OCI runtime",
    layers = [
        ":containerd-culled-layer",
        ":gvisor-overlay-layer",
        ":container-host-overlay-layer",
    ],
    # exe.dev's proxy picks 80. A workload publishes onto it with
    # `--publish 80:<port>` in its RUN_ARGS.
    ports = [
        "80/tcp",
        "8080/tcp",
    ],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
