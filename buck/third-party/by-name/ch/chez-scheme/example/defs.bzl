# SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
# SPDX-License-Identifier: BSD-3-Clause

"""One build of the example application, as its Makefile's knobs chose.

The application is a C kernel (src/c/_entry.c) that embeds Chez Scheme and
boots a boot file compiled from the Scheme sources, plus a companion shared
library the Scheme code loads at startup. A build is laid out as the
Makefile's `bindist` laid it out:

    bin/<app>                        launcher; sets the paths below
    lib/<app>/<version>/<app>.exe    the C kernel
    lib/<app>/<version>/<app>.boot   the application
    lib/<app>/<version>/petite.boot  (and scheme.boot) from Chez Scheme
    lib/<app>/<version>/<app>-clib-v<version>.so
"""

load("@root//buck/shims:shims.bzl", "shims")

CHEZ = "third-party//by-name/ch/chez-scheme"

def _yes(b):
    return "yes" if b else "no"

def _scheme_bool(b):
    return "#t" if b else "#f"

def chez_app(
        name: str,
        app: str,
        version: str,
        scheme_srcs: list[str],
        clib: str,
        opt: int = 1,
        debug: bool = False,
        profile: bool = False,
        runtime: str = "petite",
        strip: bool = False,
        visible_libs: bool = True,
        test_build: bool = False,
        profile_data: [str, None] = None):
    """Build `app` from `scheme_srcs` and the C kernel as `:<name>`.

    Args:
        name: the runnable launcher; the build's other targets share its
            prefix, and `:<name>-tree` is the source tree it was compiled in.
        app: the application name, which names its files.
        version: the application version.
        scheme_srcs: the Scheme sources, paths relative to the package.
        clib: the companion shared library.
        opt: Chez Scheme's optimize-level, 1 to 3.
        debug: keep inspector information, and build the kernel with
            debugging output and symbols.
        profile: instrument for source profiling; the build then writes
            reports when run with PROFILE_DATA, PROFILE_HTML, PROFILE_LIST
            or PROFILE_COVERAGE set.
        runtime: "petite" (interpreter only) or "chez" (with the compiler).
        strip: strip the inspector, source and profile information from the
            boot file.
        visible_libs: keep the program's libraries visible to `eval`.
        test_build: build the test driver (src/t/main.ss) as the program.
        profile_data: a .pd file from a profiled run, to optimize with.
    """
    if runtime not in ["petite", "chez"]:
        fail("chez_app: runtime must be petite or chez, not {}".format(runtime))
    rts_boot = "petite.boot" if runtime == "petite" else "scheme.boot"

    # The build's settings, as the program sees them.
    shims.write_file(
        name = name + "-version.ss",
        contents = [
            '(define build-time-appname "{}")'.format(app),
            '(define build-time-version "{}")'.format(version),
            "(define is-debug-build?    {})".format(_scheme_bool(debug)),
            "(define is-profile-build?  {})".format(_scheme_bool(profile)),
            "",
        ],
    )

    shims.filegroup(
        name = name + "-tree",
        srcs = {src: src for src in scheme_srcs} | {
            "build/gen/version.ss": ":{}-version.ss".format(name),
        },
    )

    build_args = [
        "app=" + app,
        "out=$root/$OUT",
        "opt={}".format(opt),
        "debug=" + _yes(debug),
        "profile=" + _yes(profile),
        "runtime=" + runtime,
        "strip=" + _yes(strip),
        "visible-libs=" + _yes(visible_libs),
    ]
    if profile_data:
        build_args.append("profile-data=$root/$(location {})".format(profile_data))

    # The test driver is chosen when _entry.ss is expanded, from TEST_BUILD.
    shims.genrule(
        name = name + "-boot",
        outs = {
            "boot": [app + ".boot"],
            "so": [app + ".so"],
            "wpo": [app + ".wpo"],
        },
        cmd = " && ".join([
            "root=$PWD",
            "cd $(location :{}-tree)".format(name),
            " ".join([
                "TEST_BUILD={}".format(1 if test_build else 0),
                "$root/$(exe {}:scheme)".format(CHEZ),
                "-q --script $root/$(location :build.ss)",
            ] + build_args),
        ]),
    )

    shims.cxx_binary(
        name = name + "-exe",
        srcs = ["src/c/_entry.c"],
        headers = {
            "prelude.h": "src/c/prelude.h",
        },
        header_namespace = "",
        compiler_flags = [
            "-std=gnu99",
            "-Wall",
            "-Wno-missing-braces",
            "-O{}".format(opt),
        ] + (["-g"] if debug else []),
        preprocessor_flags = [
            '-DAPP_VERSION_STRING="{}"'.format(version),
            '-DAPP_NAME_STRING="{}"'.format(app),
            '-DRTS_BOOT_FILE="{}"'.format(rts_boot),
            "-DPROFILE" if profile else "-DNPROFILE",
            "-DDEBUG" if debug else "-DNDEBUG",
        ],
        deps = [CHEZ + ":kernel"],
    )

    lib = "lib/{}/{}".format(app, version)
    boots = [":install[petite.boot]"] + ([":install[scheme.boot]"] if runtime == "chez" else [])
    shims.genrule(
        name = name + "-dist",
        srcs = {
            "launcher.sh.in": "launcher.sh.in",
        },
        outs = {
            "bin": ["bin"],
            "launcher": ["bin/" + app],
            "lib": [lib],
        },
        cmd = " && ".join([
            "mkdir -p $OUT/bin $OUT/{}".format(lib),
            "install -m 0755 $(location :{}-exe) $OUT/{}/{}.exe".format(name, lib, app),
            "install -m 0755 $(location {}) $OUT/{}/{}-clib-v{}.so".format(clib, lib, app, version),
            "install -m 0444 $(location :{}-boot[boot]) $OUT/{}/{}.boot".format(name, lib, app),
        ] + [
            "install -m 0444 $(location {}{}) $OUT/{}".format(CHEZ, boot, lib)
            for boot in boots
        ] + [
            "sed -e 's/@APPNAME@/{}/g' -e 's/@VERSION@/{}/g' launcher.sh.in > $OUT/bin/{}".format(app, version, app),
            "chmod 0755 $OUT/bin/" + app,
        ]),
    )

    shims.command(
        name = name,
        cmd = ["$(location :{}-dist[launcher])".format(name)],
    )
