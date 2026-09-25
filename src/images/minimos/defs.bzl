# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Composable minimos appliance images.

minimos is a base layer: culled Wolfi systemd + the first-party overlay
that makes it boot on exe.dev. Downstream packages compose on top of it
without knowing its internals — this load is the only one they need:

    load("@root//src/images/minimos:defs.bzl", "minimos")

    minimos.apk_culled_layer(name = "app-culled-layer", apks = ["app"])
    minimos.overlay(name = "app-overlay-layer", files = {...}, units = [...])
    minimos.image(
        name = "my-app",
        description = "minimos + my app",
        layers = [":app-culled-layer", ":app-overlay-layer"],
        ports = ["80/tcp"],
    )

Service binaries come from pinned Wolfi packages (hash-verified .apk
files, see third-party//by-name/wo/wolfi) so they share one glibc with
the base. A service with no Wolfi package needs one pinned or built
from source; there is no path for culling a foreign image.

The worked compositions live in examples/ — nginx is the fullest one.

`minimos.image` always stacks the two base layers first, bakes in the
exe.dev boot contract (systemd Cmd, login-user label, PATH/LANG), and
emits `<name>` (OCI layout dir), `<name>-docker` (docker-archive tar),
and `<name>-boot-smoke` (docker-based boot test).
"""

load("@root//buck/shims:shims.bzl", depot = "shims")

_TOOLS = "//src/images/minimos/tools"

_WOLFI = "third-party//by-name/wo/wolfi"

_BASE_CULLED_LAYER = "//src/images/minimos:culled-layer"

# Every image built with minimos.image() starts from these. Layer order
# matters: the culled systemd rootfs first, then the overlay that
# configures it.
_BASE_LAYERS = [
    _BASE_CULLED_LAYER,
    "//src/images/minimos:overlay-layer",
]

# What a composition layer may write. scratch_image enforces it while an
# image is built and the boot smoke re-checks the finished image; the
# file itself explains the model.
_POLICY = "//src/images/minimos:policy.txt"

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

def _tool(name):
    return "$(exe {}:{})".format(_TOOLS, name)

def _is_label(src):
    return src.startswith(":") or "//" in src

def _apk(pkg):
    """A bare Wolfi package name as its pinned .apk target; labels pass through."""
    return pkg if _is_label(pkg) else "{}:{}.apk".format(_WOLFI, pkg)

def _file_arg(arc, spec):
    """mkoverlay's SRC:ARC[:MODE[:UID:GID]] for one files= entry.

    A source is a package-relative path or a label (":target",
    "//pkg:target", "cell//pkg:target[sub]"); Buck locates a label, and
    it is not listed in srcs. The mode and owner are the trailing numeric
    fields, so a label's own colons are left alone.

    Returns the argument and the package-relative source to depend on
    (None for a label).
    """
    parts = spec.split(":")
    tail = []
    for part in reversed(parts):
        if len(tail) == 3 or not part.isdigit():
            break
        tail.insert(0, part)
    src = ":".join(parts[:len(parts) - len(tail)])
    if _is_label(src):
        return ":".join(["$(location {})".format(src), arc] + tail), None
    return ":".join([src, arc] + tail), src

def _apk_culled_layer(
        name,
        apks,
        keepfiles = "keepfiles.txt",
        denyfiles = None,
        provided_by = [_BASE_CULLED_LAYER],
        visibility = None):
    """A rootfs layer culled out of pinned Wolfi .apk packages.

    Extracts every package in `apks` into a scratch rootfs, in order,
    later packages winning. An entry is a Wolfi package name
    ("nginx-mainline" means third-party//by-name/wo/wolfi:nginx-mainline.apk)
    or an .apk label. The layer then keeps only the paths listed in
    `keepfiles` plus the resolved .so closure of every kept ELF binary,
    minus `denyfiles`. Both files are package-relative paths. A keep entry
    that matches nothing in the packages fails the build, the same way an
    unresolved soname does.

    The closure also resolves against `provided_by`, the layers already
    below this one in the image: a library one of them ships (glibc
    above all) is neither listed in `apks` nor copied, so a composition
    names only what it adds. The base's own culled layer passes an
    empty list. A soname neither side has fails the build.
    """
    cmd = [
        "sh",
        "$(location {}:assemble_and_cull.sh)".format(_TOOLS),
        _tool("mkapkroot"),
        _tool("cull"),
        _q(keepfiles),
        _q(denyfiles or ""),
        "$OUT",
    ]
    for layer in provided_by:
        cmd += ["--provided", _q("$(location {})".format(layer))]
    cmd += [_q("$(location {})".format(_apk(apk))) for apk in apks]
    depot.genrule(
        name = name,
        out = name + ".tar",
        srcs = [keepfiles] + ([denyfiles] if denyfiles else []),
        cmd = " ".join(cmd),
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
    files:       {"in/image/path": "src", "in/image/path": "src:mode",
                  "in/image/path": "src:mode:uid:gid"}; src is a file in
                 this package or a label for a build artifact
    symlinks:    {"in/image/path": "target"}
    units:       ["foo.service"] — installed to /etc/systemd/system and
                 enabled the way its own [Install] section says
                 (WantedBy=/RequiredBy=); a unit without one is
                 installed but not enabled
    masks:       ["bar.service"] — masked (symlink to /dev/null)
    empty_files: ["path", "path:mode"]

    Parent directories are not implied; list them in dirs or rely on a
    lower layer to provide them.
    """
    args = [
        _tool("mkoverlay"),
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
        arg, src = _file_arg(arc, spec)
        args += ["--file", _q(arg)]
        if src != None:
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
        boot_smoke_containers = False,
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

    boot_smoke_containers=True marks a container host: the smoke then
    asserts that gVisor is the only OCI runtime in the image (no runc,
    crun, or runc shim in any layer) and that containerd came up with
    runsc configured as its default runtime.

    `cmd` is a comma-separated argv. exe.dev only runs a Cmd as PID 1 when
    its program is named `init`, so a replacement has to keep that name.
    """
    program = cmd.split(",")[0]
    if program.rpartition("/")[2] != "init":
        fail(
            ("minimos.image {}: cmd must start with a program named `init`, got {}. " +
             "exe.dev runs any other Cmd as a child of its own init, not as PID 1.")
                .format(name, repr(program)),
        )

    policy_args = [
        "--base-layer-count",
        str(len(_BASE_LAYERS)),
        "--policy",
        "$(location {})".format(_POLICY),
    ]

    args = [
        _tool("scratch_image"),
        "build",
        "--output",
        "$OUT",
    ]
    for layer in _BASE_LAYERS + layers:
        args += ["--layer", "$(location {})".format(layer)]
    args += policy_args
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

    depot.oci.archive(
        name = name + "-docker",
        image = ":" + name,
        image_name = name,
        out = name + ".tar",
        visibility = visibility,
    )

    if boot_smoke:
        depot.command_test(
            name = name + "-boot-smoke",
            cmd = [
                      "bash",
                      "$(location {}:boot_smoke.sh)".format(_TOOLS),
                      "$(exe depot-toolchains//oci:skopeo)",
                      _tool("scratch_image"),
                      "$(location :{})".format(name),
                      "--image-cmd",
                      cmd,
                  ] + policy_args +
                  (["--userland"] if boot_smoke_userland else []) +
                  (["--dev"] if boot_smoke_dev else []) +
                  (["--containers"] if boot_smoke_containers else []) +
                  boot_smoke_units,
        )

minimos = struct(
    apk_culled_layer = _apk_culled_layer,
    overlay = _overlay,
    image = _image,
)
