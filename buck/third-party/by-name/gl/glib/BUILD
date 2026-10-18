# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

VERSION_PARTS = [int(n) for n in VERSION.split(".")]

# Only libglib-2.0: QEMU and libslirp need nothing from gobject, gio or
# gmodule. The lists follow glib/meson.build for a Linux host. <gmodule.h> is
# exported all the same, with no library behind it, because QEMU includes it
# even in a build that loads no modules.
#
# gregex.c is left out, and with it pcre2, which glib cannot build without:
# no other part of libglib calls GRegex, and neither do QEMU's emulators or
# libslirp, so its declarations stay in <glib.h> with nothing behind them.
SRCS = [
    "deprecated/gallocator.c",
    "deprecated/gcache.c",
    "deprecated/gcompletion.c",
    "deprecated/grel.c",
    "deprecated/gthread-deprecated.c",
    "garcbox.c",
    "garray.c",
    "gasyncqueue.c",
    "gatomic.c",
    "gbacktrace.c",
    "gbase64.c",
    "gbitlock.c",
    "gbookmarkfile.c",
    "gbytes.c",
    "gcharset.c",
    "gchecksum.c",
    "gconvert.c",
    "gdataset.c",
    "gdate.c",
    "gdatetime.c",
    "gdatetime-private.c",
    "gdir.c",
    "genviron.c",
    "gerror.c",
    "gfileutils.c",
    "ggettext.c",
    "ghash.c",
    "ghmac.c",
    "ghook.c",
    "ghostutils.c",
    "giochannel.c",
    "gkeyfile.c",
    "glib-init.c",
    "glib-private.c",
    "glist.c",
    "gmain.c",
    "gmappedfile.c",
    "gmarkup.c",
    "gmem.c",
    "gmessages.c",
    "gnode.c",
    "goption.c",
    "gpathbuf.c",
    "gpattern.c",
    "gpoll.c",
    "gprimes.c",
    "gqsort.c",
    "gquark.c",
    "gqueue.c",
    "grand.c",
    "grcbox.c",
    "grefcount.c",
    "grefstring.c",
    "gscanner.c",
    "gsequence.c",
    "gshell.c",
    "gslice.c",
    "gslist.c",
    "gspawn.c",
    "gstdio.c",
    "gstrfuncs.c",
    "gstring.c",
    "gstringchunk.c",
    "gstrvbuilder.c",
    "gtestutils.c",
    "gthread.c",
    "gthreadpool.c",
    "gtimer.c",
    "gtimezone.c",
    "gtrace.c",
    "gtranslit.c",
    "gtrashstack.c",
    "gtree.c",
    "guniprop.c",
    "gutf8.c",
    "gunibreak.c",
    "gunicollate.c",
    "gunidecomp.c",
    "guri.c",
    "gutils.c",
    "guuid.c",
    "gvariant.c",
    "gvariant-core.c",
    "gvariant-parser.c",
    "gvariant-serialiser.c",
    "gvarianttypeinfo.c",
    "gvarianttype.c",
    "gversion.c",
    "gwakeup.c",
    "gprint.c",
    "gprintf.c",
    # Unix, and Linux only for the journal.
    "glib-unix.c",
    "giounix.c",
    "gspawn-posix.c",
    "gjournal-private.c",
]

# glib_sub_headers, installed as <glib/*.h>.
PUBLIC_HEADERS = [
    "galloca.h",
    "garray.h",
    "gasyncqueue.h",
    "gatomic.h",
    "gbacktrace.h",
    "gbase64.h",
    "gbitlock.h",
    "gbookmarkfile.h",
    "gbytes.h",
    "gcharset.h",
    "gchecksum.h",
    "gconvert.h",
    "gdataset.h",
    "gdate.h",
    "gdatetime.h",
    "gdir.h",
    "genviron.h",
    "gerror.h",
    "gfileutils.h",
    "ggettext.h",
    "ghash.h",
    "ghmac.h",
    "ghook.h",
    "ghostutils.h",
    "gi18n.h",
    "gi18n-lib.h",
    "giochannel.h",
    "gkeyfile.h",
    "glib-autocleanups.h",
    "glib-typeof.h",
    "glist.h",
    "gmacros.h",
    "gmain.h",
    "gmappedfile.h",
    "gmarkup.h",
    "gmem.h",
    "gmessages.h",
    "gnode.h",
    "goption.h",
    "gpathbuf.h",
    "gpattern.h",
    "gpoll.h",
    "gprimes.h",
    "gprintf.h",
    "gqsort.h",
    "gquark.h",
    "gqueue.h",
    "grand.h",
    "grcbox.h",
    "grefcount.h",
    "grefstring.h",
    "gregex.h",
    "gscanner.h",
    "gsequence.h",
    "gshell.h",
    "gslice.h",
    "gslist.h",
    "gspawn.h",
    "gstdio.h",
    "gstrfuncs.h",
    "gstring.h",
    "gstringchunk.h",
    "gstrvbuilder.h",
    "gtestutils.h",
    "gthread.h",
    "gthreadpool.h",
    "gtimer.h",
    "gtimezone.h",
    "gtrashstack.h",
    "gtree.h",
    "gtypes.h",
    "gunicode.h",
    "guri.h",
    "gutils.h",
    "guuid.h",
    "gvariant.h",
    "gvarianttype.h",
    "gversion.h",
]

DEPRECATED_HEADERS = [
    "gallocator.h",
    "gcache.h",
    "gcompletion.h",
    "gmain.h",
    "grel.h",
    "gthread.h",
]

# Headers glib keeps to itself, and the sources other sources #include
# rather than compile.
PRIVATE_HEADERS = [
    "gasyncqueueprivate.h",
    "gbsearcharray.h",
    "gcharsetprivate.h",
    "gconstructor.h",
    "gconstructorprivate.h",
    "gconvertprivate.h",
    "gdatasetprivate.h",
    "gdatetime-private.h",
    "gjournal-private.h",
    "glib-init.h",
    "glib-private.h",
    "glib-unixprivate.h",
    "glib_trace.h",
    "glibintl.h",
    "gmain-internal.h",
    "gmirroringtable.h",
    "gprintfint.h",
    "gprintprivate.h",
    "grcboxprivate.h",
    "gscripttable.h",
    "gspawn-private.h",
    "gstdio-private.c",
    "gstdioprivate.h",
    "gthread-posix.c",
    "gthreadprivate.h",
    "gtrace-private.h",
    "gtranslit-data.h",
    "gunibreak.h",
    "gunichartables.h",
    "gunicodeprivate.h",
    "gunicomp.h",
    "gunidecomp.h",
    "guriprivate.h",
    "gutilsprivate.c",
    "gutilsprivate.h",
    "gvalgrind.h",
    "gvariant-core.h",
    "gvariant-internal.h",
    "gvariant-serialiser.h",
    "gvarianttype-private.h",
    "gvarianttypeinfo.h",
    "gwakeup.h",
    "valgrind.h",
]

CHARSET_HEADERS = [
    "libcharset.h",
    "localcharset.h",
]

shims.http_archive(
    name = "src",
    sha256 = "93c941aa17d5eb1d53fe838365f29a8b4e539c222a256d974ec8f30fc413e396",
    strip_prefix = "glib-{}".format(VERSION),
    sub_targets = [
        "gmodule/gmodule.h",
        "glib/glib.h",
        "glib/glib-unix.h",
        "glib/glibconfig.h.in",
        "glib/gversionmacros.h.in",
        "glib/libcharset/localcharset.c",
        "tools/gen-visibility-macros.py",
    ] + ["glib/" + f for f in SRCS + PUBLIC_HEADERS + PRIVATE_HEADERS] + [
        "glib/deprecated/" + h
        for h in DEPRECATED_HEADERS
    ] + [
        "glib/libcharset/" + h
        for h in CHARSET_HEADERS
    ],
    type = "tar.xz",
    urls = [
        "https://download.gnome.org/sources/glib/{}.{}/glib-{}.tar.xz".format(
            VERSION_PARTS[0],
            VERSION_PARTS[1],
            VERSION,
        ),
    ],
)

# gversionmacros.h and glib-visibility.h come from the script meson runs for
# them, so a new release brings its own GLIB_VERSION_2_* macros.
shims.python_binary(
    name = "gen-visibility-macros",
    main = ":src[tools/gen-visibility-macros.py]",
)

shims.genrule(
    name = "gversionmacros.h",
    srcs = [":src[glib/gversionmacros.h.in]"],
    out = "gversionmacros.h",
    cmd = "$(exe :gen-visibility-macros) {} versions-macros $SRCS $OUT".format(VERSION),
)

shims.genrule(
    name = "glib-visibility.h",
    out = "glib-visibility.h",
    cmd = "$(exe :gen-visibility-macros) {} visibility-macros GLIB $OUT".format(VERSION),
)

shims.genrule(
    name = "gmodule-visibility.h",
    out = "gmodule-visibility.h",
    cmd = "$(exe :gen-visibility-macros) {} visibility-macros GMODULE $OUT".format(VERSION),
)

# glibconfig.h is meson's substitution of glibconfig_conf into its template,
# as meson.build answers it for LP64 Linux, where x86_64 and arm64 agree:
# int64_t is long, size_t and pointers are long, the stack grows down, and
# the poll, socket and message constants are Linux's. GLIB_STATIC_COMPILATION
# is what a static-only meson build sets; it only changes Windows linkage.
# A release that adds a substitution fails the grep here rather than a
# compile.
GLIBCONFIG = {
    "GLIB_MAJOR_VERSION": str(VERSION_PARTS[0]),
    "GLIB_MICRO_VERSION": str(VERSION_PARTS[2]),
    "GLIB_MINOR_VERSION": str(VERSION_PARTS[1]),
    "g_af_inet": "2",
    "g_af_inet6": "10",
    "g_af_unix": "1",
    "g_bs_alien": "BE",
    "g_bs_native": "LE",
    "g_byte_order": "G_LITTLE_ENDIAN",
    "g_dir_separator": "/",
    "g_module_suffix": "so",
    "g_msg_dontroute": "4",
    "g_msg_oob": "1",
    "g_msg_peek": "2",
    "g_pid_format": "\"i\"",
    "g_pid_type": "int",
    "g_pollerr": "8",
    "g_pollfd_format": "\"%d\"",
    "g_pollhup": "16",
    "g_pollin": "1",
    "g_pollnval": "32",
    "g_pollout": "4",
    "g_pollpri": "2",
    "g_searchpath_separator": ":",
    "g_threads_impl_def": "POSIX",
    "gint16": "short",
    "gint16_format": "\"hi\"",
    "gint16_modifier": "\"h\"",
    "gint32": "int",
    "gint32_format": "\"i\"",
    "gint32_modifier": "\"\"",
    "gint64": "long",
    "gint64_constant": "(val##L)",
    "gint64_format": "\"li\"",
    "gint64_modifier": "\"l\"",
    "gintbits": "32",
    "gintptr_format": "\"li\"",
    "gintptr_modifier": "\"l\"",
    "glib_extension": "",
    "glib_gpi_cast": "(glong)",
    "glib_gpui_cast": "(gulong)",
    "glib_intptr_type_define": "long",
    "glib_long": "8",
    "glib_msize_type": "LONG",
    "glib_os": "#define G_OS_UNIX",
    "glib_size_t": "8",
    "glib_size_type_define": "long",
    "glib_ssize_t": "8",
    "glib_vacopy": "",
    "glib_void_p": "8",
    "glongbits": "64",
    "gsize_format": "\"lu\"",
    "gsize_modifier": "\"l\"",
    "gsizebits": "64",
    "gssize_format": "\"li\"",
    "gssize_modifier": "\"l\"",
    "guint16_format": "\"hu\"",
    "guint32_format": "\"u\"",
    "guint64_constant": "(val##UL)",
    "guint64_format": "\"lu\"",
    "guintptr_format": "\"lu\"",
}

# What each #mesondefine becomes: a value, a bare #define for a true
# boolean, or None for #undef.
GLIBCONFIG_DEFINES = {
    "GIO_STATIC_COMPILATION": "1",
    "GI_STATIC_COMPILATION": "1",
    "GLIB_HAVE_ALLOCA_H": "",
    "GLIB_STATIC_COMPILATION": "1",
    "GLIB_USING_SYSTEM_PRINTF": "",
    "GMODULE_STATIC_COMPILATION": "1",
    "GOBJECT_STATIC_COMPILATION": "1",
    "G_ATOMIC_LOCK_FREE": "",
    "G_HAVE_FREE_SIZED": None,
    "G_HAVE_GROWING_STACK": "0",
}

_sed_escape = lambda s: s.replace("\\", "\\\\").replace("|", "\\|").replace("&", "\\&").replace("'", "'\\''")

_mesondefine = lambda k, v: "/* #undef {} */".format(k) if v == None else "#define {} {}".format(k, v).rstrip()

GLIBCONFIG_SED = [
    "-e 's|@{}@|{}|g'".format(
        k,
        _sed_escape(v),
    )
    for k, v in GLIBCONFIG.items()
] + [
    "-e 's|^#mesondefine {}$|{}|'".format(
        k,
        _sed_escape(_mesondefine(k, v)),
    )
    for k, v in GLIBCONFIG_DEFINES.items()
]

shims.genrule(
    name = "glibconfig.h",
    srcs = [":src[glib/glibconfig.h.in]"],
    out = "glibconfig.h",
    cmd = " ".join(["sed"] + GLIBCONFIG_SED + [
        "$SRCS > $OUT && ! grep -e '@[A-Za-z0-9_]*@' -e '#mesondefine' $OUT",
    ]),
)

# The project arguments meson gives every glib compile: _GNU_SOURCE, no strict
# aliasing, and G_DISABLE_CAST_CHECKS, which glib_debug=auto picks for the
# default debugoptimized build. Assertions and checks stay on, as upstream
# ships them.
COMPILER_FLAGS = [
    "-std=gnu11",
    "-fno-strict-aliasing",
    "-fvisibility=hidden",
    "-Wno-unused-parameter",
    "-Wno-cast-function-type",
    "-Wno-format-zero-length",
    "-Wno-string-plus-int",
]

PREPROCESSOR_FLAGS = [
    "-D_GNU_SOURCE",
    "-DG_DISABLE_CAST_CHECKS",
    "-DGLIB_COMPILATION",
    "-DG_LOG_DOMAIN=\"GLib\"",
]

# libcharset is its own static library in meson, so it gets neither
# GLIB_COMPILATION nor the GLib log domain. GLIB_CHARSETALIAS_DIR is where it
# reads charset.alias, which glibc never needs; it is the default libdir.
shims.cxx_library(
    name = "charset",
    srcs = [":src[glib/libcharset/localcharset.c]"],
    compiler_flags = [
        "-std=gnu11",
        "-fno-strict-aliasing",
        "-fvisibility=hidden",
    ],
    header_namespace = "",
    headers = {
        "config.h": "config.h",
    } | {
        h: ":src[glib/libcharset/{}]".format(h)
        for h in CHARSET_HEADERS
    },
    preferred_linkage = "static",
    preprocessor_flags = [
        "-D_GNU_SOURCE",
        "-DGLIB_CHARSETALIAS_DIR=\"/usr/local/lib\"",
    ],
)

# Upstream installs <glib.h> and <glib-unix.h> in include/glib-2.0, the rest
# under its glib/ directory, and glibconfig.h in lib/glib-2.0/include; one
# root here resolves all of them. The sources also #include their siblings
# by bare name, and a few private headers as glib/..., so those resolve too.
shims.cxx_library(
    name = "glib",
    srcs = [":src[glib/{}]".format(f) for f in SRCS],
    compiler_flags = COMPILER_FLAGS,
    exported_headers = {
        "glib-unix.h": ":src[glib/glib-unix.h]",
        "glib.h": ":src[glib/glib.h]",
        "glib/glib-visibility.h": ":glib-visibility.h",
        "glib/gversionmacros.h": ":gversionmacros.h",
        "glibconfig.h": ":glibconfig.h",
        "gmodule.h": ":src[gmodule/gmodule.h]",
        "gmodule/gmodule-visibility.h": ":gmodule-visibility.h",
    } | {
        "glib/" + h: ":src[glib/{}]".format(h)
        for h in PUBLIC_HEADERS
    } | {
        "glib/deprecated/" + h: ":src[glib/deprecated/{}]".format(h)
        for h in DEPRECATED_HEADERS
    },
    header_namespace = "",
    headers = {
        "config.h": "config.h",
    } | {
        h: ":src[glib/{}]".format(h)
        for h in PUBLIC_HEADERS + PRIVATE_HEADERS
    } | {
        "glib/" + h: ":src[glib/{}]".format(h)
        for h in PRIVATE_HEADERS
    } | {
        "deprecated/" + h: ":src[glib/deprecated/{}]".format(h)
        for h in DEPRECATED_HEADERS
    } | {
        "libcharset/" + h: ":src[glib/libcharset/{}]".format(h)
        for h in CHARSET_HEADERS
    },
    preferred_linkage = "static",
    preprocessor_flags = PREPROCESSOR_FLAGS,
    visibility = ["PUBLIC"],
    deps = [":charset"],
)

shims.cxx_binary(
    name = "test-smoke-bin",
    srcs = ["test.c"],
    deps = [":glib"],
)

shims.command_test(
    name = "test-smoke",
    cmd = ["$(exe :test-smoke-bin)"],
)
