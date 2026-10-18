# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

VERSION_PARTS = VERSION.split(".")

SRCS = [
    "arp_table.c",
    "bootp.c",
    "cksum.c",
    "dhcpv6.c",
    "dnssearch.c",
    "if.c",
    "ip6_icmp.c",
    "ip6_input.c",
    "ip6_output.c",
    "ip_icmp.c",
    "ip_input.c",
    "ip_output.c",
    "mbuf.c",
    "misc.c",
    "ncsi.c",
    "ndp_table.c",
    "sbuf.c",
    "slirp.c",
    "socket.c",
    "state.c",
    "stream.c",
    "tcp_input.c",
    "tcp_output.c",
    "tcp_subr.c",
    "tcp_timer.c",
    "tftp.c",
    "udp.c",
    "udp6.c",
    "util.c",
    "version.c",
    "vmstate.c",
]

PRIVATE_HEADERS = [
    "bootp.h",
    "debug.h",
    "dhcpv6.h",
    "if.h",
    "ip.h",
    "ip6.h",
    "ip6_icmp.h",
    "ip_icmp.h",
    "main.h",
    "mbuf.h",
    "misc.h",
    "ncsi-pkt.h",
    "sbuf.h",
    "slirp.h",
    "socket.h",
    "stream.h",
    "tcp.h",
    "tcp_timer.h",
    "tcp_var.h",
    "tcpip.h",
    "tftp.h",
    "udp.h",
    "util.h",
    "vmstate.h",
    "winver.h",
]

# Upstream's own meson tests: ping the virtual host, check NC-SI replies,
# and validate guest forwarding rules. None reaches outside the emulated
# network.
TESTS = [
    "guestfwdtest",
    "ncsitest",
    "pingtest",
]

shims.http_archive(
    name = "src",
    sha256 = "f43e68b60b580647574ec4a0e2b6c600a56281e6c39f79426510832dc810f483",
    strip_prefix = "libslirp-v{}".format(VERSION),
    sub_targets = [
        "src/libslirp.h",
        "src/libslirp-version.h.in",
    ] + ["src/" + f for f in SRCS + PRIVATE_HEADERS] + [
        "test/{}.c".format(t)
        for t in TESTS
    ],
    type = "tar.gz",
    urls = [
        "https://gitlab.freedesktop.org/slirp/libslirp/-/archive/v{0}/libslirp-v{0}.tar.gz".format(VERSION),
    ],
)

# meson's configure_file() of the version numbers. The archive has no
# .tarball-version for build-aux/git-version-gen to read, so meson falls back
# to the project version for the string too.
shims.genrule(
    name = "libslirp-version.h",
    srcs = [":src[src/libslirp-version.h.in]"],
    out = "libslirp-version.h",
    cmd = " ".join(["sed"] + [
        "-e 's/@{}@/{}/g'".format(k, v)
        for k, v in {
            "SLIRP_MAJOR_VERSION": VERSION_PARTS[0],
            "SLIRP_MICRO_VERSION": VERSION_PARTS[2],
            "SLIRP_MINOR_VERSION": VERSION_PARTS[1],
            "SLIRP_VERSION_STRING": "\"{}\"".format(VERSION),
        }.items()
    ] + ["$SRCS > $OUT && ! grep '@[A-Z_]*@' $OUT"]),
)

PRIVATE_HEADER_MAP = {
    h: ":src[src/{}]".format(h)
    for h in PRIVATE_HEADERS
}

# Upstream installs the headers in include/slirp, and its pkg-config file
# puts that directory on the include path, so consumers write <libslirp.h>.
shims.cxx_library(
    name = "libslirp",
    srcs = [":src[src/{}]".format(f) for f in SRCS],
    compiler_flags = ["-std=gnu99"],
    exported_headers = {
        "libslirp-version.h": ":libslirp-version.h",
        "libslirp.h": ":src[src/libslirp.h]",
    },
    header_namespace = "",
    headers = PRIVATE_HEADER_MAP,
    preferred_linkage = "static",
    preprocessor_flags = [
        "-DG_LOG_DOMAIN=\"Slirp\"",
        "-DBUILDING_LIBSLIRP",
    ],
    visibility = ["PUBLIC"],
    deps = ["third-party//by-name/gl/glib:glib"],
)

# ncsitest reaches into slirp.h, and with it <glib.h>, so the tests see the
# private headers, as meson's include_directories('src') gives them.
[
    shims.cxx_binary(
        name = "{}-bin".format(t),
        srcs = [":src[test/{}.c]".format(t)],
        compiler_flags = ["-std=gnu99"],
        header_namespace = "",
        headers = PRIVATE_HEADER_MAP,
        deps = [
            "third-party//by-name/gl/glib:glib",
            ":libslirp",
        ],
    )
    for t in TESTS
]

[
    shims.command_test(
        name = "test-{}".format(t),
        cmd = ["$(exe :{}-bin)".format(t)],
    )
    for t in TESTS
]

shims.cxx_binary(
    name = "test-smoke-bin",
    srcs = ["test.c"],
    deps = [
        "third-party//by-name/gl/glib:glib",
        ":libslirp",
    ],
)

shims.command_test(
    name = "test-smoke",
    cmd = ["$(exe :test-smoke-bin)"],
)
