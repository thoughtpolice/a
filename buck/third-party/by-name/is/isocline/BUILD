# SPDX-FileCopyrightText: © 2017-2023 Meta Platforms, Inc. and affiliates.
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//:paths.bzl", "paths")
load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

shims.http_archive(
    name = "src",
    sha256 = "0a2149aa99bdffc0c430aa4ecfcdc378bd5f98565eef10991475db52b33f607b",
    strip_prefix = "isocline-8d6dc1ef95b1b46711e66eb23d39d4467a0fcdac",
    sub_targets = [
        "include/isocline.h",
        "src/attr.h",
        "src/bbcode.h",
        "src/common.h",
        "src/completions.h",
        "src/env.h",
        "src/highlight.h",
        "src/history.h",
        "src/stringbuf.h",
        "src/term.h",
        "src/tty.h",
        "src/undo.h",
        # the following .c files are used in include directives
        # so they're treated like header files
        "src/wcwidth.c",
        "src/term_color.c",
        "src/editline_help.c",
        "src/editline_history.c",
        "src/editline_completion.c",
        "src/bbcode_colors.c",
        "src/attr.c",
        "src/bbcode.c",
        "src/common.c",
        "src/completers.c",
        "src/completions.c",
        "src/editline.c",
        "src/editline_completion.c",
        "src/editline_help.c",
        "src/editline_history.c",
        "src/highlight.c",
        "src/history.c",
        "src/isocline.c",
        "src/stringbuf.c",
        "src/term.c",
        "src/term_color.c",
        "src/tty.c",
        "src/tty_esc.c",
        "src/undo.c",
        "src/wcwidth.c",
    ],
    type = "tar.gz",
    urls = [
        "https://github.com/daanx/isocline/archive/{}.tar.gz".format(VERSION.split("g", 1)[1]),
    ],
)

# these files all do a relative '../' include which will break
# inside the sandbox. fix them using bbsed.
FIX_INCLUDE_FILES = [
    "src/common.h",
    "src/env.h",
    "src/isocline.c",
    "src/history.c",
    "src/undo.c",
    "src/completers.c",
    "src/completions.c",
]

[
    shims.genrule(
        name = "fixed-{}".format(paths.basename(f).replace(".", "-")),
        srcs = [":src[{}]".format(f)],
        out = paths.basename(f),
        bash = "sed 's|../include/isocline.h|isocline/isocline.h|g' $SRCS > $OUT",
    )
    for f in FIX_INCLUDE_FILES
]

shims.cxx_library(
    name = "isocline",
    srcs = [
        ":fixed-completers-c",
        ":fixed-completions-c",
        ":fixed-history-c",
        ":fixed-isocline-c",
        ":fixed-undo-c",
        ":src[src/attr.c]",
        ":src[src/bbcode.c]",
        ":src[src/common.c]",
        ":src[src/editline.c]",
        ":src[src/highlight.c]",
        ":src[src/stringbuf.c]",
        ":src[src/term.c]",
        ":src[src/tty.c]",
        ":src[src/tty_esc.c]",
    ],
    exported_headers = {
        "isocline/isocline.h": ":src[include/isocline.h]",
    },
    header_namespace = "",
    headers = {
        "attr.h": ":src[src/attr.h]",
        "bbcode.h": ":src[src/bbcode.h]",
        "completions.h": ":src[src/completions.h]",
        "highlight.h": ":src[src/highlight.h]",
        "history.h": ":src[src/history.h]",
        "stringbuf.h": ":src[src/stringbuf.h]",
        "term.h": ":src[src/term.h]",
        "tty.h": ":src[src/tty.h]",
        "undo.h": ":src[src/undo.h]",
        "wcwidth.c": ":src[src/wcwidth.c]",
        "term_color.c": ":src[src/term_color.c]",
        "editline_help.c": ":src[src/editline_help.c]",
        "editline_history.c": ":src[src/editline_history.c]",
        "editline_completion.c": ":src[src/editline_completion.c]",
        "bbcode_colors.c": ":src[src/bbcode_colors.c]",
        "env.h": ":fixed-env-h",
        "common.h": ":fixed-common-h",
    },
    preprocessor_flags = [
        "-DIC_SEPARATE_OBJS=1",
    ],
    visibility = ["PUBLIC"],
)
