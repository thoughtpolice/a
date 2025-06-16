# SPDX-FileCopyrightText: © 2017-2023 Meta Platforms, Inc. and affiliates.
# SPDX-FileCopyrightText: © 2023 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//paths.bzl", "paths")
load("@root//buck/shims/shims.bzl", "shims")
load("@root//buck/shims/package.bzl", "pkg")

VERSION = pkg.version()

shims.http_archive(
    name = 'src',
    sha256 = '7d678dd32233bf1c4a576fe3cd788b059c921650650e182441c9465d80d22b11',
    urls = [
        'https://github.com/daanx/isocline/archive/{}.tar.gz'.format(VERSION.split('g', 1)[1]),
    ],
    type = 'tar.gz',
    strip_prefix = 'isocline-c9310ae58941559d761fe5d2dd2713d245f18da6',
    sub_targets = [
        'include/isocline.h',

        'src/attr.h',
        'src/bbcode.h',
        'src/common.h',
        'src/completions.h',
        'src/env.h',
        'src/highlight.h',
        'src/history.h',
        'src/stringbuf.h',
        'src/term.h',
        'src/tty.h',
        'src/undo.h',
        # the following .c files are used in include directives
        # so they're treated like header files
        'src/wcwidth.c',
        'src/term_color.c',
        'src/editline_help.c',
        'src/editline_history.c',
        'src/editline_completion.c',
        'src/bbcode_colors.c',

        'src/attr.c',
        'src/bbcode.c',
        'src/common.c',
        'src/completers.c',
        'src/completions.c',
        'src/editline.c',
        'src/editline_completion.c',
        'src/editline_help.c',
        'src/editline_history.c',
        'src/highlight.c',
        'src/history.c',
        'src/isocline.c',
        'src/stringbuf.c',
        'src/term.c',
        'src/term_color.c',
        'src/tty.c',
        'src/tty_esc.c',
        'src/undo.c',
        'src/wcwidth.c',
    ]
)

# these files all do a relative '../' include which will break
# inside the sandbox. fix them using bbsed.
FIX_INCLUDE_FILES = [
    'src/common.h',
    'src/env.h',
    'src/isocline.c',
    'src/history.c',
    'src/undo.c',
    'src/completers.c',
    'src/completions.c',
]

[
    genrule(
        name = 'fixed-{}'.format(paths.basename(f).replace('.', '-')),
        srcs = [':src[{}]'.format(f)],
        out = paths.basename(f),
        bash = "sed 's|../include/isocline.h|isocline/isocline.h|g' $SRCS > $OUT",
    )
    for f in FIX_INCLUDE_FILES
]

shims.cxx_library(
    name = "isocline",
    visibility = ['PUBLIC'],
    header_namespace = '',
    exported_headers = {
        'isocline/isocline.h': ':src[include/isocline.h]',
    },

    preprocessor_flags = [
        '-DIC_SEPARATE_OBJS=1',
    ],

    headers = {
        'attr.h': ':src[src/attr.h]',
        'bbcode.h': ':src[src/bbcode.h]',
        'completions.h': ':src[src/completions.h]',
        'highlight.h': ':src[src/highlight.h]',
        'history.h': ':src[src/history.h]',
        'stringbuf.h': ':src[src/stringbuf.h]',
        'term.h': ':src[src/term.h]',
        'tty.h': ':src[src/tty.h]',
        'undo.h': ':src[src/undo.h]',

        'wcwidth.c': ':src[src/wcwidth.c]',
        'term_color.c': ':src[src/term_color.c]',
        'editline_help.c': ':src[src/editline_help.c]',
        'editline_history.c': ':src[src/editline_history.c]',
        'editline_completion.c': ':src[src/editline_completion.c]',
        'bbcode_colors.c': ':src[src/bbcode_colors.c]',

        'env.h': ':fixed-env-h',
        'common.h': ':fixed-common-h',
    },

    srcs = [
        ':src[src/attr.c]',
        ':src[src/bbcode.c]',
        ':src[src/common.c]',
        ':src[src/editline.c]',
        ':src[src/highlight.c]',
        ':src[src/stringbuf.c]',
        ':src[src/term.c]',
        ':src[src/tty.c]',
        ':src[src/tty_esc.c]',

        ':fixed-isocline-c',
        ':fixed-history-c',
        ':fixed-undo-c',
        ':fixed-completers-c',
        ':fixed-completions-c',
    ],
)
