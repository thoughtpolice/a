# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Composable minimos appliance images.

minimos is a base layer: culled Wolfi systemd + the first-party overlay
that makes it boot on exe.dev. Downstream packages compose on top of it
without knowing its internals — this load is the only one they need:

    load("@root//src/images/minimos:defs.bzl", "minimos")

    minimos.apk_culled_layer(
        name = "app-culled-layer",
        apks = ["third-party//by-name/wo/wolfi:app.apk", ...],
    )
    minimos.overlay(name = "app-overlay-layer", files = {...}, units = [...])
    minimos.image(
        name = "my-app",
        description = "minimos + my app",
        layers = [":app-culled-layer", ":app-overlay-layer"],
        ports = ["80/tcp"],
    )

Service binaries come from pinned Wolfi packages (hash-verified .apk
files, see third-party//by-name/wo/wolfi) so they share one glibc with
the base. minimos.pull + minimos.culled_layer remain for culling an
arbitrary OCI donor image instead; if you go that way, the donor's
binaries must target a glibc no newer than the base's (Wolfi tracks
current upstream), the layer must carry any libraries outside ld.so's
default /lib*:/usr/lib* search paths at resolvable locations, and the
donor's own glibc should be denylisted.

The worked compositions live in examples/ — nginx is the fullest one.

`minimos.image` always stacks the two base layers first, bakes in the
exe.dev boot contract (systemd Cmd, login-user label, PATH/LANG), and
emits `<name>` (OCI layout dir), `<name>-docker` (docker-archive tar),
and `<name>-boot-smoke` (docker-based boot test).
"""

load("@root//buck/shims:shims.bzl", depot = "shims")

_TOOLS = "//src/images/minimos/tools"

# Every image built with minimos.image() starts from these. Layer order
# matters: the culled systemd rootfs first, then the overlay that
# configures it.
_BASE_LAYERS = [
    "//src/images/minimos:culled-layer",
    "//src/images/minimos:overlay-layer",
]

# What a composition layer may write, as a default-deny policy enforced by
# scratch_image.py independently of the runtime boot smoke.
#
# Two unconditional rules come first and need no list: a composition layer can
# never replace a path a lower layer established (so every one of the base's
# ~670 paths — PID 1, the shells, the account files, every vendor unit — is
# covered without being named), and it can never write a type-wide systemd
# drop-in directory (`service.d`, `user-.slice.d`, …) that would reconfigure
# units it does not own.
#
# On top of that, a *new* path must fall under one of these prefixes. This is
# the inverse of naming the dangerous paths: a search directory nobody
# anticipated is refused because it was never opened, rather than allowed
# because it was never denied. Longest match wins and ties are sealed.
_COMPOSABLE_PATHS = [
    "etc",
    "home",
    "opt",
    "srv",
    "usr/bin",
    "usr/lib",
    "usr/libexec",
    "usr/local",
    "usr/share",
    "var",
    # A per-user manager needs the helper user@.service BindsTo=; the base
    # denylist drops it, so examples/dev culls it back in. One file, reopened
    # by name inside the otherwise sealed systemd private directory.
    "usr/lib/systemd/systemd-user-runtime-dir",
]

# Carved back out of the composable prefixes above: directories where merely
# *adding* a file changes identity, privilege, or boot policy for the whole
# image. Everything outside _COMPOSABLE_PATHS (/run, /root, /boot, /dev, the
# merged-usr links, …) is already denied and needs no entry here.
_SEALED_PATHS = [
    # Identity and authentication.
    "etc/passwd",
    "etc/group",
    "etc/shadow",
    "etc/gshadow",
    "etc/subuid",
    "etc/subgid",
    "etc/nsswitch.conf",
    "etc/login.defs",
    "etc/pam.d",
    "etc/security",
    "etc/sudoers",
    "etc/sudoers.d",
    "etc/doas.conf",
    # Accounts created at boot: the base bakes /etc and masks systemd-sysusers.
    "etc/sysusers.d",
    "usr/lib/sysusers.d",
    "usr/local/lib/sysusers.d",
    # The dynamic loader reads these before any program's first instruction.
    "etc/ld.so.preload",
    "etc/ld.so.conf",
    "etc/ld.so.conf.d",
    "etc/ld.so.cache",
    # Kernel-facing configuration applied by early boot services.
    "etc/sysctl.conf",
    "etc/sysctl.d",
    "usr/lib/sysctl.d",
    "usr/local/lib/sysctl.d",
    "etc/tmpfiles.d",
    "usr/lib/tmpfiles.d",
    "usr/local/lib/tmpfiles.d",
    "etc/modules-load.d",
    "usr/lib/modules-load.d",
    "etc/modprobe.d",
    "usr/lib/modprobe.d",
    "etc/binfmt.d",
    "usr/lib/binfmt.d",
    "etc/udev",
    "usr/lib/udev",
    "etc/environment",
    "etc/environment.d",
    "usr/lib/environment.d",
    # Manager configuration, and every unit search path that outranks
    # /etc/systemd/system or runs code before units do (generators).
    "etc/systemd/system.conf",
    "etc/systemd/system.conf.d",
    "etc/systemd/user.conf",
    "etc/systemd/user.conf.d",
    "etc/systemd/journald.conf",
    "etc/systemd/journald.conf.d",
    "etc/systemd/logind.conf",
    "etc/systemd/logind.conf.d",
    "etc/systemd/system.control",
    "etc/systemd/system.attached",
    "etc/systemd/system-generators",
    "etc/systemd/user-generators",
    "etc/systemd/system-environment-generators",
    "etc/systemd/user-environment-generators",
    "etc/systemd/system-preset",
    "etc/systemd/user-preset",
    "etc/systemd/system-sleep",
    "etc/systemd/system-shutdown",
    # systemd's private directory: PID 1 itself, its helpers, the vendor unit
    # tree, and its generator directories. Sealed wholesale — a new search
    # path added by a future systemd lands inside it.
    "usr/lib/systemd",
    "usr/local/lib/systemd",
    # minimos's own boot and login chain lives here.
    "usr/lib/minimos",
    # Bus policy: the vendor files grant every uid the right to *send* to PID 1
    # and rely on systemd's authorization for the deny.
    "etc/dbus-1",
    "usr/share/dbus-1",
    # Trust roots and the factory tree systemd-tmpfiles copies from.
    "etc/ssl",
    "etc/pki",
    "etc/ca-certificates",
    "usr/share/ca-certificates",
    "usr/share/factory",
    "usr/share/polkit-1",
]

# The exe.dev boot contract: --log-target=syslog keeps the kernel
# console clean for the platform, --show-status prints unit startup
# progress there, which `ssh exe.dev vm-logs` captures. vm-logs is a log
# dump, not a terminal, so --log-color=false keeps ANSI escapes out of
# that stream; it only affects PID 1's console output — systemctl et al
# in SSH sessions still colorize.
_DEFAULT_CMD = "/sbin/init,--log-target=syslog,--show-status=true,--log-color=false"

def _q(s):
    """Single-quote a literal argument for the genrule shell command."""
    if "'" in s:
        fail("minimos defs: can't shell-quote {}".format(repr(s)))
    return "'" + s + "'"

def _pull(**kwargs):
    """An OCI donor image to cull binaries out of (depot.oci.pull).

    See the module docstring for the ABI rules donor binaries must
    follow now that the base glibc comes from Wolfi; prefer
    apk_culled_layer when the service exists as a Wolfi package.
    """
    digest = kwargs.get("digest")
    if digest == None or not digest.startswith("sha256:") or len(digest) != 71:
        fail("minimos.pull requires an immutable sha256 digest")
    depot.oci.pull(**kwargs)

def _culled_layer(
        name,
        source,
        keepfiles = "keepfiles.txt",
        denyfiles = "denyfiles.txt",
        visibility = None):
    """A rootfs layer culled out of a pulled OCI image.

    Unpacks `source` (an oci.pull target) and keeps only the paths listed
    in `keepfiles` plus the resolved .so closure of every kept ELF binary,
    minus `denyfiles`. Both files are package-relative paths.
    """
    depot.genrule(
        name = name,
        out = name + ".tar",
        srcs = [keepfiles, denyfiles],
        cmd = " ".join([
            "sh",
            "$(location {}:unpack_and_cull.sh)".format(_TOOLS),
            "$(exe depot-toolchains//oci:umoci)",
            "$(location {})".format(source),
            "$(location {}:cull.py)".format(_TOOLS),
            _q(keepfiles),
            _q(denyfiles),
            "$OUT",
        ]),
        visibility = visibility,
    )

def _apk_culled_layer(
        name,
        apks,
        keepfiles = "keepfiles.txt",
        denyfiles = "denyfiles.txt",
        visibility = None):
    """A rootfs layer culled out of pinned Wolfi .apk packages.

    Extracts every package in `apks` (targets from
    third-party//by-name/wo/wolfi, in order, later packages winning)
    into a scratch rootfs, then keeps only the paths listed in
    `keepfiles` plus the resolved .so closure of every kept ELF binary,
    minus `denyfiles`. Both files are package-relative paths.

    List enough packages that the .so closure resolves — cull.py warns
    about sonames it cannot find in the assembled rootfs. Libraries the
    minimos base layer already ships (glibc above all) belong in the
    package list for that resolution, and in `denyfiles` so the layer
    doesn't duplicate them.
    """
    depot.genrule(
        name = name,
        out = name + ".tar",
        srcs = [keepfiles, denyfiles],
        cmd = " ".join([
            "sh",
            "$(location {}:assemble_and_cull.sh)".format(_TOOLS),
            "$(location {}:mkapkroot.py)".format(_TOOLS),
            "$(location {}:cull.py)".format(_TOOLS),
            _q(keepfiles),
            _q(denyfiles),
            "$OUT",
        ] + [_q("$(location {})".format(apk)) for apk in apks]),
        visibility = visibility,
    )

def _overlay(
        name,
        dirs = [],
        files = {},
        symlinks = {},
        units = [],
        masks = [],
        empty_files = [],
        visibility = None):
    """A first-party overlay layer, declared instead of scripted.

    dirs:        ["path", "path:mode", "path:mode:uid:gid"] (octal mode)
    files:       {"in/image/path": "src", "in/image/path": "src:mode"}
    symlinks:    {"in/image/path": "target"}
    units:       ["foo.service"] — installed to /etc/systemd/system and
                 enabled via multi-user.target.wants
    masks:       ["bar.service"] — masked (symlink to /dev/null)
    empty_files: ["path", "path:mode"]

    Parent directories are not implied; list them in dirs or rely on a
    lower layer to provide them.
    """
    args = [
        "python3",
        "$(location {}:mkoverlay.py)".format(_TOOLS),
        "--out",
        "$OUT",
    ]
    for d in dirs:
        args += ["--dir", _q(d)]
    for arc, target in symlinks.items():
        args += ["--symlink", _q(arc + ":" + target)]
    for u in units:
        args += ["--unit", _q(u)]

    srcs = {u: None for u in units}
    for arc, spec in files.items():
        if ":" in spec:
            src, mode = spec.split(":")
            args += ["--file", _q(src + ":" + arc + ":" + mode)]
        else:
            src = spec
            args += ["--file", _q(src + ":" + arc)]
        srcs[src] = None
    for e in empty_files:
        args += ["--empty", _q(e)]
    for m in masks:
        args += ["--mask", _q(m)]

    depot.genrule(
        name = name,
        out = name + ".tar",
        srcs = srcs.keys(),
        cmd = " ".join(args),
        visibility = visibility,
    )

def _image(
        name,
        description,
        version = "0.1.0",
        layers = [],
        ports = [],
        labels = {},
        env = {},
        cmd = _DEFAULT_CMD,
        user = "root",
        boot_smoke = True,
        boot_smoke_units = [],
        boot_smoke_userland = False,
        boot_smoke_dev = False,
        visibility = None):
    """A bootable minimos-based OCI image: base layers + `layers` on top.

    Emits three targets:
      <name>            — OCI image layout directory
      <name>-docker     — docker-archive tarball for `docker load`
      <name>-boot-smoke — docker-based boot test (unless boot_smoke=False);
                          asserts systemd reaches `running` with no failed
                          units, plus any units in boot_smoke_units.

    boot_smoke_userland=True marks an image that deliberately ships an
    interactive userland (coreutils and friends): the smoke's
    no-distro-userspace layer check is skipped for it, while the
    package-manager ban and the suid/world-writable/account invariants
    still apply.
    """
    args = [
        "python3",
        "$(location {}:scratch_image.py)".format(_TOOLS),
        "--output",
        "$OUT",
    ]
    for layer in _BASE_LAYERS + layers:
        args += ["--layer", "$(location {})".format(layer)]
    args += ["--base-layer-count", str(len(_BASE_LAYERS))]
    for path in _COMPOSABLE_PATHS:
        args += ["--composable-path", _q(path)]
    for path in _SEALED_PATHS:
        args += ["--sealed-path", _q(path)]
    args += ["--cmd", _q(cmd)]

    image_env = {
        "PATH": "/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin",
        "LANG": "C.UTF-8",
        # The console this Cmd runs on is a log dump (`ssh exe.dev
        # vm-logs`), not a terminal. --log-color=false alone no longer
        # keeps it clean: systemd 256+ also probes the terminal size and
        # emits OSC context sequences unless the terminal is dumb. SSH
        # sessions are unaffected — the platform sshd sets its own TERM.
        "TERM": "dumb",
        "SYSTEMD_COLORS": "0",
    }
    image_env.update(env)
    for key, value in image_env.items():
        args += ["--env", _q(key + "=" + value)]

    args += ["--user", _q(user)]
    for port in ports:
        args += ["--port", _q(port)]

    image_labels = {
        # exe.dev maps external SSH names (including root) to this account.
        # The local uid-0 account is locked and has nologin.
        "exe.dev/login-user": "exedev",
        "org.opencontainers.image.title": name,
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.description": description,
        "org.opencontainers.image.licenses": "Apache-2.0",
    }
    image_labels.update(labels)
    for key, value in image_labels.items():
        args += ["--label", _q(key + "=" + value)]

    args += ["--arch", "amd64", "--os", "linux"]

    depot.genrule(
        name = name,
        out = ".",
        cmd = " ".join(args),
        visibility = visibility,
    )

    depot.genrule(
        name = name + "-docker",
        out = name + ".tar",
        cmd = " ".join([
            "$(exe depot-toolchains//oci:skopeo)",
            "copy",
            "--insecure-policy",
            "oci:$(location :{}):latest".format(name),
            "docker-archive:$OUT:{}:latest".format(name),
        ]),
        visibility = visibility,
    )

    if boot_smoke:
        boot_smoke_args = [
            "bash",
            "$(location {}:boot_smoke.sh)".format(_TOOLS),
            "$(exe depot-toolchains//oci:skopeo)",
            "$(location {}:scratch_image.py)".format(_TOOLS),
            "$(location :{})".format(name),
            "--image-cmd",
            cmd,
            "--base-layer-count",
            str(len(_BASE_LAYERS)),
        ]
        for path in _COMPOSABLE_PATHS:
            boot_smoke_args += ["--composable-path", path]
        for path in _SEALED_PATHS:
            boot_smoke_args += ["--sealed-path", path]
        depot.command_test(
            name = name + "-boot-smoke",
            cmd = boot_smoke_args + (["--userland"] if boot_smoke_userland else []) + (["--dev"] if boot_smoke_dev else []) + boot_smoke_units,
        )

minimos = struct(
    pull = _pull,
    culled_layer = _culled_layer,
    apk_culled_layer = _apk_culled_layer,
    overlay = _overlay,
    image = _image,
)
