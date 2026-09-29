# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/images/minimos:defs.bzl", "minimos")

# minimos + k0s: a Kubernetes node whose cluster state lives in S3. Each
# node runs a k0s controller and a worker, and k0s's kine keeps the
# datastore with its T4 driver, which needs no quorum. See k0s.yaml.
#
#   ssh exe.dev new --image=<pushed image> --name=k0s-1 --tag=s3-testing
#   ssh k0s-1.exe.xyz kubectl get nodes

_K0S_VERSION = "1.36.4+k0s.1"

# k0s (Apache-2.0, © k0s authors) as upstream's static release binary. It
# carries every Kubernetes component, containerd, runc, kine and
# iptables inside it, and unpacks them under /var/lib/k0s/bin at start.
depot.http_file(
    name = "k0s",
    sha256 = "18c304d53cdd70095e99c6b859b269b4fef0bb84579d7e7185271a9135694a31",
    urls = [
        "https://github.com/k0sproject/k0s/releases/download/v{}/k0s-v{}-amd64".format(
            _K0S_VERSION.replace("+", "%2B"),
            _K0S_VERSION,
        ),
    ],
)

# The base has no /usr/local, so this layer declares the directories.
minimos.overlay(
    name = "k0s-overlay-layer",
    dirs = [
        "etc/k0s",
        "etc/k0s/containerd.d",
        "etc/systemd/system/k0scontroller.service.wants",
        "home/exedev/.kube:700:1000:1000",
        "usr/local",
        "usr/local/bin",
        "var/lib/k0s-kubeconfig:750:0:1000",
    ],
    files = {
        "etc/k0s/containerd.d/systemd-cgroup.toml": "systemd-cgroup.toml",
        "etc/k0s/k0s.yaml": "k0s.yaml",
        # Applied by k0s-kubeconfig.service, not the boot-time tmpfiles
        # pass. See the file.
        "etc/k0s/kubeconfig-access.conf": "kubeconfig-access.conf",
        "usr/local/bin/k0s": ":k0s:755",
        "usr/local/bin/kubectl": "kubectl:755",
    },
    symlinks = {
        "home/exedev/.kube/config": "/var/lib/k0s-kubeconfig/admin.conf",
    },
    units = [
        "k0s-kubeconfig.service",
        "k0scontroller.service",
        "kubernetes.slice",
    ],
)

minimos.image(
    name = "minimos-k0s",
    description = "minimos + a k0s controller and worker that keeps its state in S3",
    layers = [
        ":k0s-overlay-layer",
    ],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
