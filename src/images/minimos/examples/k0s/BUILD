# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/images/minimos:defs.bzl", "minimos")

# minimos + k0s: a Kubernetes node whose cluster state lives in S3. Each
# node runs a k0s controller and a worker, and T4, a datastore that keeps
# its WAL in S3 and needs no quorum. The nodes reach each other over
# Tailscale. See k0s.yaml.in and the example README.
#
#   ssh exe.dev new --image=<pushed image> --name=k0s-1 --tag=s3-testing,mos-k0s
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

# Tailscale, and curl for the API calls the start scripts make through
# exe.dev's integrations. Both tailscale binaries are static, and cull.py
# adds the libraries curl links.
minimos.apk_culled_layer(
    name = "k0s-tools-culled-layer",
    apks = [
        "tailscale",
        "curl",
        # Libraries curl links that the base doesn't ship.
        "cyrus-sasl-mit-libs",
        "keyutils-libs",
        "krb5-libs",
        "libbrotlicommon1",
        "libbrotlidec1",
        "libbrotlienc1",
        "libcom_err",
        "libcurl-openssl4",
        "libidn2",
        "libldap-2.7",
        "libnghttp2-14",
        "libpsl",
        "libunistring",
        "libverto",
        "nghttp3",
        "openssl-4.0-libcrypto",
        "openssl-4.0-libssl",
        "ngtcp2",
        "zlib",
        # krb5's libresolv, which the base culls.
        "glibc-2.44",
    ],
    denyfiles = "k0s-tools-denyfiles.txt",
    keepfiles = "k0s-tools-keepfiles.txt",
)

_T4_VERSION = "1.1.15"

# T4 (Apache-2.0, © the T4 authors) as upstream's static release binary,
# whose hash matches the release's checksums.txt. It speaks the etcd v3
# API, and k0s uses it as an external etcd.
depot.http_file(
    name = "t4",
    sha256 = "99f47fad187bf25541109d0febc7fc356fce3a0d39b494170210f35b43313c52",
    urls = [
        "https://github.com/t4db/t4/releases/download/v{}/t4-linux-amd64".format(_T4_VERSION),
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
        "usr/libexec",
        "usr/libexec/minimos-k0s",
        "usr/local",
        "usr/local/bin",
        "var/lib/k0s-kubeconfig:750:0:1000",
    ],
    files = {
        "etc/k0s/cluster.env": "cluster.env",
        "etc/k0s/containerd.d/systemd-cgroup.toml": "systemd-cgroup.toml",
        "etc/k0s/k0s.yaml.in": "k0s.yaml.in",
        # Applied by k0s-kubeconfig.service, not the boot-time tmpfiles
        # pass. See the file.
        "etc/k0s/kubeconfig-access.conf": "kubeconfig-access.conf",
        "usr/libexec/minimos-k0s/check-bootstrap": "check-bootstrap:755",
        "usr/libexec/minimos-k0s/start": "start:755",
        "usr/libexec/minimos-k0s/t4-start": "t4-start:755",
        "usr/libexec/minimos-k0s/t4-watchdog": "t4-watchdog:755",
        "usr/libexec/minimos-k0s/tailscale-login": "tailscale-login:755",
        "usr/local/bin/k0s": ":k0s:755",
        "usr/local/bin/k0s-join-token": "k0s-join-token:755",
        "usr/local/bin/kubectl": "kubectl:755",
        "usr/local/bin/t4": ":t4:755",
    },
    symlinks = {
        "home/exedev/.kube/config": "/var/lib/k0s-kubeconfig/admin.conf",
    },
    units = [
        "k0s-kubeconfig.service",
        "k0scontroller.service",
        "kubernetes.slice",
        "t4-watchdog.service",
        "t4.service",
        "tailscale-login.service",
        "tailscaled.service",
    ],
)

minimos.image(
    name = "minimos-k0s",
    description = "minimos + a k0s controller and worker that keeps its state in S3",
    layers = [
        ":k0s-tools-culled-layer",
        ":k0s-overlay-layer",
    ],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
