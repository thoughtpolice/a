# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/images/minimos:defs.bzl", "minimos")

# --------------------------------------------------------------------------
# minimos + containerd, with gVisor as the only OCI runtime on the
# system. This is the Bottlerocket-shaped composition: an appliance whose
# job is to run other people's containers, so it ships no userland of its
# own — the userland arrives inside the sandboxes.
#
# "Only runtime" is an image-content property, not a setting: there is no
# runc, no crun, and no containerd-shim-runc-v2 in any layer, so the
# conventional default runtime cannot start a container here at all. The
# boot smoke re-derives that from the built layers rather than trusting
# this comment.
#
# Workloads are part of the image. A layer stacked on this one ships
# /etc/minimos/containers/<name>.env and enables container@<name>.service
# (see container@.service). The SSH owner can pull and inspect with ctr,
# but can't start a container, as the example README explains.
# --------------------------------------------------------------------------

_WOLFI = "third-party//by-name/wo/wolfi"

# gVisor point releases are immutable; the undotted `release/<date>` path
# moves when a follow-up release ships that day. Pin the dotted one, so a
# new release is a deliberate version bump instead of a hash mismatch.
_GVISOR_RELEASE = "20260914.0"

_GVISOR_URL = "https://storage.googleapis.com/gvisor/releases/release/{}/x86_64".format(
    _GVISOR_RELEASE,
)

# runsc, its containerd shim, and the sidecars runsc execs from
# gvisor-bin/ beside itself. Ship those too: the alternative is runsc's
# embedded fallback, which upstream stops supporting after 2026-10, or a
# download at sandbox start.
_GVISOR_BINARIES = [
    "runsc",
    "containerd-shim-runsc-v1",
    "gvisor-bin/checkpointgofer",
    "gvisor-bin/gvisor-sentry-prewarmer",
    "gvisor-bin/gvisor_sentry",
    "gvisor-bin/runsc-fd-parking",
    "gvisor-bin/runsc-metric-server",
]

# runsc (Apache-2.0, © The gVisor Authors), its containerd shim and the
# sidecar binaries runsc execs: static, no libc of their own, and Wolfi
# has no gvisor package. Releases after 20260817.0 publish this archive
# only, so the loose per-binary URLs are gone. The sha256 pin was
# cross-checked against upstream's published .sha512 file at the same URL.
depot.http_archive(
    name = "gvisor",
    sha256 = "94a1b9716797efcb0b348fc3283ddaa1ee5c7898b61eeccb08ee9ac7dc903c15",
    sub_targets = _GVISOR_BINARIES,
    type = "tar.bz2",
    urls = ["{}/gvisor.tar.bz2".format(_GVISOR_URL)],
)

# The runtime layer. /usr/local/bin is where gVisor's own documentation
# installs runsc; the base has no /usr/local at all, so the layer
# carries the directory chain.
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

# containerd, its two clients, the CNI plugins container networking
# shells out to, and iptables' nft multi binary. Everything here is a
# static Go binary except iptables and containerd itself, which need
# nothing the base doesn't already ship (libc) or the closure doesn't
# resolve (libxtables, libmnl, libnftnl).
minimos.apk_culled_layer(
    name = "containerd-culled-layer",
    apks = [
        "{}:containerd-2.apk".format(_WOLFI),
        "{}:ctr-2.apk".format(_WOLFI),
        "{}:nerdctl.apk".format(_WOLFI),
        "{}:cni-plugins.apk".format(_WOLFI),
        "{}:iptables.apk".format(_WOLFI),
        "{}:libmnl.apk".format(_WOLFI),
        "{}:libnftnl.apk".format(_WOLFI),
    ],
)

# The host's configuration: what containerd is, how a sandbox is built,
# and where the CLI looks for its pieces.
minimos.overlay(
    name = "container-host-overlay-layer",
    dirs = [
        "etc",
        "etc/systemd",
        "etc/systemd/system",
        "etc/systemd/system/multi-user.target.wants",
        "etc/containerd",
        # The shim's fallback config location — see runsc-config.toml.
        "etc/containerd/runsc",
        # Where a composition stacked on this image declares its
        # workloads: one <name>.env per container@<name>.service.
        "etc/minimos",
        "etc/minimos/containers",
        "etc/nerdctl",
        # Written by nerdctl the first time a container needs the bridge
        # network; the image ships the directory, not the config, so the
        # CLI stays the owner of its own network definitions.
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
        # Not under /etc/tmpfiles.d: this one is applied by the unit, not
        # by the boot-time pass. See the file itself.
        "etc/containerd/socket-access.conf": "socket-access.conf",
        "etc/nerdctl/nerdctl.toml": "nerdctl.toml",
    },
    symlinks = {
        # CNI's conventional plugin directory. Wolfi installs the
        # plugins into /usr/bin, and pointing cni_path there would hand
        # the network setup path a directory full of unrelated binaries.
        "opt/cni/bin/bridge": "/usr/bin/bridge",
        "opt/cni/bin/firewall": "/usr/bin/firewall",
        "opt/cni/bin/host-local": "/usr/bin/host-local",
        "opt/cni/bin/loopback": "/usr/bin/loopback",
        "opt/cni/bin/portmap": "/usr/bin/portmap",
        "opt/cni/bin/tuning": "/usr/bin/tuning",
        # The applet names the CNI plugins exec. Wolfi's own iptables
        # symlink points at the legacy backend, which this image does
        # not carry (see keepfiles.txt).
        "usr/bin/ip6tables": "xtables-nft-multi",
        "usr/bin/ip6tables-restore": "xtables-nft-multi",
        "usr/bin/ip6tables-save": "xtables-nft-multi",
        "usr/bin/iptables": "xtables-nft-multi",
        "usr/bin/iptables-restore": "xtables-nft-multi",
        "usr/bin/iptables-save": "xtables-nft-multi",
    },
    # The daemon is enabled by its [Install] section. The workload
    # template has none, so it is installed and left alone: instances are
    # what get enabled, and a composition layer does that by shipping its
    # own .env plus a multi-user.target.wants symlink.
    units = [
        "containerd.service",
        "container@.service",
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
    # exe.dev's proxy auto-picks 80; publish a container onto one of
    # these with `nerdctl run -p 80:<port>`.
    ports = [
        "80/tcp",
        "8080/tcp",
    ],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
