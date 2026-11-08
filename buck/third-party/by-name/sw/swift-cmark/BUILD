# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

GIT_COMMIT = "924936d0427cb25a61169739a7660230bffa6ea6"

# src/CMakeLists.txt's libcmark-gfm.
SOURCES = [
    "arena.c",
    "blocks.c",
    "buffer.c",
    "cmark.c",
    "cmark_ctype.c",
    "commonmark.c",
    "footnotes.c",
    "houdini_href_e.c",
    "houdini_html_e.c",
    "houdini_html_u.c",
    "html.c",
    "inlines.c",
    "iterator.c",
    "latex.c",
    "linked_list.c",
    "man.c",
    "map.c",
    "node.c",
    "plaintext.c",
    "plugin.c",
    "references.c",
    "registry.c",
    "render.c",
    "scanners.c",
    "syntax_extension.c",
    "utf8.c",
    "xml.c",
]

PRIVATE_SOURCES = [
    "case_fold_switch.inc",
    "entities.inc",
]

# src/include, which CMake installs whole.
HEADERS = [
    "buffer.h",
    "chunk.h",
    "cmark-gfm-extension_api.h",
    "cmark-gfm.h",
    "cmark-gfm_config.h",
    "cmark-gfm_version.h",
    "cmark_ctype.h",
    "export.h",
    "footnotes.h",
    "houdini.h",
    "html.h",
    "inlines.h",
    "iterator.h",
    "map.h",
    "mutex.h",
    "node.h",
    "parser.h",
    "plugin.h",
    "references.h",
    "registry.h",
    "render.h",
    "scanners.h",
    "syntax_extension.h",
    "utf8.h",
]

shims.http_archive(
    name = "src",
    sha256 = "1c51659bd47c34df1c8976f893adc43ba039a98f6eac4fa95d53d1e08ba6072a",
    strip_prefix = "swift-cmark-{}".format(GIT_COMMIT),
    sub_targets = ["src/{}".format(f) for f in SOURCES + PRIVATE_SOURCES] +
                  ["src/include/{}".format(h) for h in HEADERS],
    type = "tar.gz",
    urls = [
        "https://github.com/swiftlang/swift-cmark/archive/{}.tar.gz".format(GIT_COMMIT),
    ],
)

# Without CMARK_USE_CMAKE_HEADERS, cmark-gfm_config.h is the configuration
# the Swift package ships in place of CMake's config.h: thread-safe, with
# pthread locks around cmark's static state.
shims.cxx_library(
    name = "swift-cmark",
    srcs = [":src[src/{}]".format(f) for f in SOURCES],
    exported_headers = {
        h: ":src[src/include/{}]".format(h)
        for h in HEADERS
    },
    exported_linker_flags = ["-pthread"],
    exported_preprocessor_flags = ["-DCMARK_GFM_STATIC_DEFINE"],
    header_namespace = "",
    headers = {
        f: ":src[src/{}]".format(f)
        for f in PRIVATE_SOURCES
    },
    preferred_linkage = "static",
)

shims.cxx_binary(
    name = "test-render-bin",
    srcs = ["test.c"],
    deps = [":swift-cmark"],
)

shims.command_test(
    name = "test-render",
    cmd = ["$(exe :test-render-bin)"],
)
