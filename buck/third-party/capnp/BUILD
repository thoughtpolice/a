# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot="shims")
load("@root//buck/shims/package.bzl", "pkg")

VERSION = pkg.version()

SOURCE_FILES = [
    # kj: sources
    "c++/src/kj/arena.c++",
    "c++/src/kj/array.c++",
    "c++/src/kj/cidr.c++",
    "c++/src/kj/common.c++",
    "c++/src/kj/debug.c++",
    "c++/src/kj/encoding.c++",
    "c++/src/kj/exception.c++",
    "c++/src/kj/filesystem.c++",
    "c++/src/kj/filesystem-disk-unix.c++",
    "c++/src/kj/filesystem-disk-win32.c++",
    "c++/src/kj/hash.c++",
    "c++/src/kj/io.c++",
    "c++/src/kj/list.c++",
    "c++/src/kj/main.c++",
    "c++/src/kj/memory.c++",
    "c++/src/kj/mutex.c++",
    "c++/src/kj/parse/char.c++",
    "c++/src/kj/refcount.c++",
    "c++/src/kj/source-location.c++",
    "c++/src/kj/string.c++",
    "c++/src/kj/string-tree.c++",
    "c++/src/kj/table.c++",
    "c++/src/kj/test-helpers.c++",
    "c++/src/kj/thread.c++",
    "c++/src/kj/time.c++",
    "c++/src/kj/units.c++",
    # kj: headers
    "c++/src/kj/arena.h",
    "c++/src/kj/array.h",
    "c++/src/kj/cidr.h",
    "c++/src/kj/common.h",
    "c++/src/kj/debug.h",
    "c++/src/kj/encoding.h",
    "c++/src/kj/exception.h",
    "c++/src/kj/filesystem.h",
    "c++/src/kj/function.h",
    "c++/src/kj/hash.h",
    "c++/src/kj/io.h",
    "c++/src/kj/list.h",
    "c++/src/kj/main.h",
    "c++/src/kj/map.h",
    "c++/src/kj/memory.h",
    "c++/src/kj/miniposix.h",
    "c++/src/kj/mutex.h",
    "c++/src/kj/one-of.h",
    "c++/src/kj/parse/char.h",
    "c++/src/kj/parse/common.h",
    "c++/src/kj/refcount.h",
    "c++/src/kj/source-location.h",
    "c++/src/kj/std/iostream.h",
    "c++/src/kj/string.h",
    "c++/src/kj/string-tree.h",
    "c++/src/kj/table.h",
    "c++/src/kj/test.h",
    "c++/src/kj/thread.h",
    "c++/src/kj/threadlocal.h",
    "c++/src/kj/time.h",
    "c++/src/kj/tuple.h",
    "c++/src/kj/units.h",
    "c++/src/kj/vector.h",
    "c++/src/kj/win32-api-version.h",
    "c++/src/kj/windows-sanity.h",
    # kj-async: sources
    "c++/src/kj/async.c++",
    "c++/src/kj/async-io.c++",
    "c++/src/kj/async-io-unix.c++",
    "c++/src/kj/async-io-win32.c++",
    "c++/src/kj/async-unix.c++",
    "c++/src/kj/async-win32.c++",
    "c++/src/kj/timer.c++",
    # kj-async: headers
    "c++/src/kj/async.h",
    "c++/src/kj/async-inl.h",
    "c++/src/kj/async-io.h",
    "c++/src/kj/async-io-internal.h",
    "c++/src/kj/async-prelude.h",
    "c++/src/kj/async-queue.h",
    "c++/src/kj/async-unix.h",
    "c++/src/kj/async-win32.h",
    "c++/src/kj/timer.h",
    # capnp: sources
    "c++/src/capnp/any.c++",
    "c++/src/capnp/arena.c++",
    "c++/src/capnp/blob.c++",
    "c++/src/capnp/c++.capnp.c++",
    "c++/src/capnp/dynamic.c++",
    "c++/src/capnp/layout.c++",
    "c++/src/capnp/list.c++",
    "c++/src/capnp/message.c++",
    "c++/src/capnp/schema.c++",
    "c++/src/capnp/schema.capnp.c++",
    "c++/src/capnp/schema-loader.c++",
    "c++/src/capnp/serialize.c++",
    "c++/src/capnp/serialize-packed.c++",
    "c++/src/capnp/stream.capnp.c++",
    "c++/src/capnp/stringify.c++",
    # capnp: headers
    "c++/src/capnp/any.h",
    "c++/src/capnp/arena.h",
    "c++/src/capnp/blob.h",
    "c++/src/capnp/c++.capnp.h",
    "c++/src/capnp/capability.h",
    "c++/src/capnp/common.h",
    "c++/src/capnp/dynamic.h",
    "c++/src/capnp/endian.h",
    "c++/src/capnp/generated-header-support.h",
    "c++/src/capnp/layout.h",
    "c++/src/capnp/list.h",
    "c++/src/capnp/membrane.h",
    "c++/src/capnp/message.h",
    "c++/src/capnp/orphan.h",
    "c++/src/capnp/pointer-helpers.h",
    "c++/src/capnp/pretty-print.h",
    "c++/src/capnp/raw-schema.h",
    "c++/src/capnp/schema.capnp.h",
    "c++/src/capnp/schema.h",
    "c++/src/capnp/schema-lite.h",
    "c++/src/capnp/schema-loader.h",
    "c++/src/capnp/schema-parser.h",
    "c++/src/capnp/serialize.h",
    "c++/src/capnp/serialize-async.h",
    "c++/src/capnp/serialize-packed.h",
    "c++/src/capnp/serialize-text.h",
    "c++/src/capnp/stream.capnp.h",
    # capnpc: sources
    "c++/src/capnp/compiler/compiler.c++",
    "c++/src/capnp/compiler/error-reporter.c++",
    "c++/src/capnp/compiler/generics.c++",
    "c++/src/capnp/compiler/grammar.capnp.c++",
    "c++/src/capnp/compiler/lexer.c++",
    "c++/src/capnp/compiler/lexer.capnp.c++",
    "c++/src/capnp/compiler/node-translator.c++",
    "c++/src/capnp/compiler/parser.c++",
    "c++/src/capnp/compiler/type-id.c++",
    "c++/src/capnp/schema-parser.c++",
    "c++/src/capnp/serialize-text.c++",
    # capnpc: headers
    "c++/src/capnp/compiler/compiler.h",
    "c++/src/capnp/compiler/error-reporter.h",
    "c++/src/capnp/compiler/generics.h",
    "c++/src/capnp/compiler/grammar.capnp.h",
    "c++/src/capnp/compiler/lexer.capnp.h",
    "c++/src/capnp/compiler/lexer.h",
    "c++/src/capnp/compiler/module-loader.h",
    "c++/src/capnp/compiler/node-translator.h",
    "c++/src/capnp/compiler/parser.h",
    "c++/src/capnp/compiler/resolver.h",
    "c++/src/capnp/compiler/type-id.h",
    # capnp_tool: sources
    "c++/src/capnp/compat/json.c++",
    "c++/src/capnp/compat/json.capnp.c++",
    "c++/src/capnp/compat/json.h",
    "c++/src/capnp/compat/json.capnp.h",
    "c++/src/capnp/compiler/capnp.c++",
    "c++/src/capnp/compiler/module-loader.c++",
]

[
    http_archive(
        name = f'src.{typ}',
        type = typ,
        strip_prefix = f'capnproto-{VERSION}',
        sub_targets = SOURCE_FILES,
        urls = [
            f'https://github.com/capnproto/capnproto/archive/refs/tags/v{VERSION}.{typ}',
        ],
        sha256 = sha256,
    ) for typ, sha256 in ({
        'tar.gz': '3cfd0ed58080d78b3a3381305489f2175cdaf1ef1cb55425d8fc8246a76bdff3',
        'zip': '3c9afa5dffa4d81a3cbd0581a15a5b1633feaf43093a3b108aded0f636622752',
    }).items()
]

alias(
    name = 'src',
    actual = select({
        'config//os:windows': ':src.zip',
        'DEFAULT': ':src.tar.gz',
    })
)

MSVC_FLAGS = select({
    'config//os:windows': [ '/TP' ],
    'DEFAULT': [],
})

depot.copy_files(
    name = 'kj-srcs',
    srcs = {
        "kj/arena.c++": ":src[c++/src/kj/arena.c++]",
        "kj/array.c++": ":src[c++/src/kj/array.c++]",
        "kj/cidr.c++": ":src[c++/src/kj/cidr.c++]",
        "kj/common.c++": ":src[c++/src/kj/common.c++]",
        "kj/debug.c++": ":src[c++/src/kj/debug.c++]",
        "kj/encoding.c++": ":src[c++/src/kj/encoding.c++]",
        "kj/exception.c++": ":src[c++/src/kj/exception.c++]",
        "kj/filesystem.c++": ":src[c++/src/kj/filesystem.c++]",
        "kj/filesystem-disk-unix.c++": ":src[c++/src/kj/filesystem-disk-unix.c++]",
        "kj/filesystem-disk-win32.c++": ":src[c++/src/kj/filesystem-disk-win32.c++]",
        "kj/hash.c++": ":src[c++/src/kj/hash.c++]",
        "kj/io.c++": ":src[c++/src/kj/io.c++]",
        "kj/list.c++": ":src[c++/src/kj/list.c++]",
        "kj/main.c++": ":src[c++/src/kj/main.c++]",
        "kj/memory.c++": ":src[c++/src/kj/memory.c++]",
        "kj/mutex.c++": ":src[c++/src/kj/mutex.c++]",
        "kj/parse/char.c++": ":src[c++/src/kj/parse/char.c++]",
        "kj/refcount.c++": ":src[c++/src/kj/refcount.c++]",
        "kj/source-location.c++": ":src[c++/src/kj/source-location.c++]",
        "kj/string.c++": ":src[c++/src/kj/string.c++]",
        "kj/string-tree.c++": ":src[c++/src/kj/string-tree.c++]",
        "kj/table.c++": ":src[c++/src/kj/table.c++]",
        "kj/test-helpers.c++": ":src[c++/src/kj/test-helpers.c++]",
        "kj/thread.c++": ":src[c++/src/kj/thread.c++]",
        "kj/time.c++": ":src[c++/src/kj/time.c++]",
        "kj/units.c++": ":src[c++/src/kj/units.c++]",

        "kj/async.c++": ":src[c++/src/kj/async.c++]",
        "kj/async-io.c++": ":src[c++/src/kj/async-io.c++]",
        "kj/async-io-unix.c++": ":src[c++/src/kj/async-io-unix.c++]",
        "kj/async-io-win32.c++": ":src[c++/src/kj/async-io-win32.c++]",
        "kj/async-unix.c++": ":src[c++/src/kj/async-unix.c++]",
        "kj/async-win32.c++": ":src[c++/src/kj/async-win32.c++]",
        "kj/timer.c++": ":src[c++/src/kj/timer.c++]",

        "kj/arena.h":     ":src[c++/src/kj/arena.h]",
        "kj/array.h":     ":src[c++/src/kj/array.h]",
        "kj/common.h":    ":src[c++/src/kj/common.h]",
        "kj/cidr.h":      ":src[c++/src/kj/cidr.h]",
        "kj/debug.h":     ":src[c++/src/kj/debug.h]",
        "kj/encoding.h":  ":src[c++/src/kj/encoding.h]",
        "kj/list.h":      ":src[c++/src/kj/list.h]",
        "kj/hash.h":      ":src[c++/src/kj/hash.h]",
        "kj/io.h":        ":src[c++/src/kj/io.h]",
        "kj/exception.h": ":src[c++/src/kj/exception.h]",
        "kj/filesystem.h": ":src[c++/src/kj/filesystem.h]",
        "kj/function.h":   ":src[c++/src/kj/function.h]",
        "kj/main.h":      ":src[c++/src/kj/main.h]",
        "kj/map.h":       ":src[c++/src/kj/map.h]",
        "kj/memory.h":    ":src[c++/src/kj/memory.h]",
        "kj/mutex.h":     ":src[c++/src/kj/mutex.h]",
        "kj/miniposix.h": ":src[c++/src/kj/miniposix.h]",
        "kj/one-of.h":     ":src[c++/src/kj/one-of.h]",
        "kj/parse/char.h": ":src[c++/src/kj/parse/char.h]",
        "kj/parse/common.h": ":src[c++/src/kj/parse/common.h]",
        "kj/refcount.h":  ":src[c++/src/kj/refcount.h]",
        "kj/string.h":    ":src[c++/src/kj/string.h]",
        "kj/string-tree.h": ":src[c++/src/kj/string-tree.h]",
        "kj/source-location.h": ":src[c++/src/kj/source-location.h]",
        "kj/table.h":     ":src[c++/src/kj/table.h]",
        "kj/time.h":      ":src[c++/src/kj/time.h]",
        "kj/test.h":      ":src[c++/src/kj/test.h]",
        "kj/thread.h":    ":src[c++/src/kj/thread.h]",
        "kj/threadlocal.h": ":src[c++/src/kj/threadlocal.h]",
        "kj/tuple.h":     ":src[c++/src/kj/tuple.h]",
        "kj/units.h":      ":src[c++/src/kj/units.h]",
        "kj/windows-sanity.h": ":src[c++/src/kj/windows-sanity.h]",
        "kj/win32-api-version.h": ":src[c++/src/kj/win32-api-version.h]",
        "kj/vector.h":    ":src[c++/src/kj/vector.h]",

        "kj/async.h": ":src[c++/src/kj/async.h]",
        "kj/async-inl.h": ":src[c++/src/kj/async-inl.h]",
        "kj/async-io.h": ":src[c++/src/kj/async-io.h]",
        "kj/async-io-internal.h": ":src[c++/src/kj/async-io-internal.h]",
        "kj/async-prelude.h": ":src[c++/src/kj/async-prelude.h]",
        "kj/async-queue.h": ":src[c++/src/kj/async-queue.h]",
        "kj/async-unix.h": ":src[c++/src/kj/async-unix.h]",
        "kj/async-win32.h": ":src[c++/src/kj/async-win32.h]",
        "kj/timer.h": ":src[c++/src/kj/timer.h]",
    },
)

depot.cxx_library(
    name = 'kj-headers',
    header_namespace = "kj",
    exported_headers = {
        "arena.h":     ":src[c++/src/kj/arena.h]",
        "array.h":     ":src[c++/src/kj/array.h]",
        "common.h":    ":src[c++/src/kj/common.h]",
        "debug.h":     ":src[c++/src/kj/debug.h]",
        "exception.h": ":src[c++/src/kj/exception.h]",
        "memory.h":    ":src[c++/src/kj/memory.h]",
        "refcount.h":  ":src[c++/src/kj/refcount.h]",
        "string.h":    ":src[c++/src/kj/string.h]",
        "time.h":      ":src[c++/src/kj/time.h]",
        "tuple.h":     ":src[c++/src/kj/tuple.h]",
        "source-location.h": ":src[c++/src/kj/source-location.h]",
        "win32-api-version.h": ":src[c++/src/kj/win32-api-version.h]",
        "windows-sanity.h": ":src[c++/src/kj/windows-sanity.h]",

        "async.h": ":src[c++/src/kj/async.h]",
        "async-inl.h": ":src[c++/src/kj/async-inl.h]",
        "async-io.h": ":src[c++/src/kj/async-io.h]",
        "async-io-internal.h": ":src[c++/src/kj/async-io-internal.h]",
        "async-prelude.h": ":src[c++/src/kj/async-prelude.h]",
        "async-queue.h": ":src[c++/src/kj/async-queue.h]",
        "async-unix.h": ":src[c++/src/kj/async-unix.h]",
        "async-win32.h": ":src[c++/src/kj/async-win32.h]",
        "timer.h": ":src[c++/src/kj/timer.h]",
    },
)

depot.cxx_library(
    name = 'kj',
    srcs = [
        ":kj-srcs[kj/arena.c++]",
        ":kj-srcs[kj/array.c++]",
        ":kj-srcs[kj/cidr.c++]",
        ":kj-srcs[kj/common.c++]",
        ":kj-srcs[kj/debug.c++]",
        ":kj-srcs[kj/encoding.c++]",
        ":kj-srcs[kj/exception.c++]",
        ":kj-srcs[kj/filesystem.c++]",
        ":kj-srcs[kj/filesystem-disk-unix.c++]",
        ":kj-srcs[kj/filesystem-disk-win32.c++]",
        ":kj-srcs[kj/hash.c++]",
        ":kj-srcs[kj/io.c++]",
        ":kj-srcs[kj/list.c++]",
        ":kj-srcs[kj/main.c++]",
        ":kj-srcs[kj/memory.c++]",
        ":kj-srcs[kj/mutex.c++]",
        ":kj-srcs[kj/parse/char.c++]",
        ":kj-srcs[kj/refcount.c++]",
        ":kj-srcs[kj/source-location.c++]",
        ":kj-srcs[kj/string.c++]",
        ":kj-srcs[kj/string-tree.c++]",
        ":kj-srcs[kj/table.c++]",
        ":kj-srcs[kj/test-helpers.c++]",
        ":kj-srcs[kj/thread.c++]",
        ":kj-srcs[kj/time.c++]",
        ":kj-srcs[kj/units.c++]",
    ],

    compiler_flags = select({
        'config//os:windows': [ '/TP' ],
        'DEFAULT': [],
    }),

    preprocessor_flags = select({
        'config//os:windows': [
            '-D_WINDOWS',
            '-DWIN32',
            '-DWIN32_LEAN_AND_MEAN',
        ],
        'DEFAULT': [],
    }) + [
        "-I$(location :kj-srcs)",
    ],

    preferred_linkage = 'static',
)

depot.cxx_library(
    name = 'kj-async',
    srcs = [
        ":kj-srcs[kj/async.c++]",
        ":kj-srcs[kj/async-io.c++]",
        ":kj-srcs[kj/async-io-unix.c++]",
        ":kj-srcs[kj/async-io-win32.c++]",
        ":kj-srcs[kj/async-unix.c++]",
        ":kj-srcs[kj/async-win32.c++]",
        ":kj-srcs[kj/timer.c++]",
    ],

    compiler_flags = select({
        'config//os:windows': [ '/TP' ],
        'DEFAULT': [],
    }),

    preprocessor_flags = select({
        'config//os:windows': [
            '-D_WINDOWS',
            '-DWIN32',
            '-DWIN32_LEAN_AND_MEAN',
        ],
        'DEFAULT': [],
    }) + [
        "-I$(location :kj-srcs)",
    ],

    preferred_linkage = 'static',
    exported_deps = [ ":kj" ],
)

depot.copy_files(
    name = 'capnp-srcs',
    srcs = {
        "capnp/any.c++": ":src[c++/src/capnp/any.c++]",
        "capnp/arena.c++": ":src[c++/src/capnp/arena.c++]",
        "capnp/blob.c++": ":src[c++/src/capnp/blob.c++]",
        "capnp/c++.capnp.c++": ":src[c++/src/capnp/c++.capnp.c++]",
        "capnp/dynamic.c++": ":src[c++/src/capnp/dynamic.c++]",
        "capnp/layout.c++": ":src[c++/src/capnp/layout.c++]",
        "capnp/list.c++": ":src[c++/src/capnp/list.c++]",
        "capnp/message.c++": ":src[c++/src/capnp/message.c++]",
        "capnp/schema.c++": ":src[c++/src/capnp/schema.c++]",
        "capnp/schema.capnp.c++": ":src[c++/src/capnp/schema.capnp.c++]",
        "capnp/schema-loader.c++": ":src[c++/src/capnp/schema-loader.c++]",
        "capnp/schema-parser.c++": ":src[c++/src/capnp/schema-parser.c++]",
        "capnp/serialize.c++": ":src[c++/src/capnp/serialize.c++]",
        "capnp/serialize-text.c++": ":src[c++/src/capnp/serialize-text.c++]",
        "capnp/serialize-packed.c++": ":src[c++/src/capnp/serialize-packed.c++]",
        "capnp/stream.capnp.c++": ":src[c++/src/capnp/stream.capnp.c++]",
        "capnp/stringify.c++": ":src[c++/src/capnp/stringify.c++]",

        "capnp/compiler/compiler.c++": ":src[c++/src/capnp/compiler/compiler.c++]",
        "capnp/compiler/error-reporter.c++": ":src[c++/src/capnp/compiler/error-reporter.c++]",
        "capnp/compiler/generics.c++": ":src[c++/src/capnp/compiler/generics.c++]",
        "capnp/compiler/grammar.capnp.c++": ":src[c++/src/capnp/compiler/grammar.capnp.c++]",
        "capnp/compiler/lexer.c++": ":src[c++/src/capnp/compiler/lexer.c++]",
        "capnp/compiler/lexer.capnp.c++": ":src[c++/src/capnp/compiler/lexer.capnp.c++]",
        "capnp/compiler/node-translator.c++": ":src[c++/src/capnp/compiler/node-translator.c++]",
        "capnp/compiler/parser.c++": ":src[c++/src/capnp/compiler/parser.c++]",
        "capnp/compiler/type-id.c++": ":src[c++/src/capnp/compiler/type-id.c++]",

        "capnp/compiler/capnp.c++": ":src[c++/src/capnp/compiler/capnp.c++]",
        "capnp/compiler/module-loader.c++": ":src[c++/src/capnp/compiler/module-loader.c++]",

        "capnp/any.h": ":src[c++/src/capnp/any.h]",
        "capnp/arena.h": ":src[c++/src/capnp/arena.h]",
        "capnp/blob.h": ":src[c++/src/capnp/blob.h]",
        "capnp/c++.capnp.h": ":src[c++/src/capnp/c++.capnp.h]",
        "capnp/capability.h": ":src[c++/src/capnp/capability.h]",
        "capnp/common.h": ":src[c++/src/capnp/common.h]",
        "capnp/dynamic.h": ":src[c++/src/capnp/dynamic.h]",
        "capnp/endian.h": ":src[c++/src/capnp/endian.h]",
        "capnp/layout.h": ":src[c++/src/capnp/layout.h]",
        "capnp/list.h": ":src[c++/src/capnp/list.h]",
        "capnp/generated-header-support.h": ":src[c++/src/capnp/generated-header-support.h]",
        "capnp/message.h": ":src[c++/src/capnp/message.h]",
        "capnp/orphan.h": ":src[c++/src/capnp/orphan.h]",
        "capnp/pointer-helpers.h": ":src[c++/src/capnp/pointer-helpers.h]",
        "capnp/pretty-print.h": ":src[c++/src/capnp/pretty-print.h]",
        "capnp/raw-schema.h": ":src[c++/src/capnp/raw-schema.h]",
        "capnp/schema.h": ":src[c++/src/capnp/schema.h]",
        "capnp/schema.capnp.h": ":src[c++/src/capnp/schema.capnp.h]",
        "capnp/schema-loader.h": ":src[c++/src/capnp/schema-loader.h]",
        "capnp/schema-parser.h": ":src[c++/src/capnp/schema-parser.h]",
        "capnp/serialize.h": ":src[c++/src/capnp/serialize.h]",
        "capnp/serialize-text.h": ":src[c++/src/capnp/serialize-text.h]",
        "capnp/serialize-packed.h": ":src[c++/src/capnp/serialize-packed.h]",
        "capnp/stream.capnp.h": ":src[c++/src/capnp/stream.capnp.h]",

        "capnp/compiler/compiler.h": ":src[c++/src/capnp/compiler/compiler.h]",
        "capnp/compiler/error-reporter.h": ":src[c++/src/capnp/compiler/error-reporter.h]",
        "capnp/compiler/generics.h": ":src[c++/src/capnp/compiler/generics.h]",
        "capnp/compiler/grammar.capnp.h": ":src[c++/src/capnp/compiler/grammar.capnp.h]",
        "capnp/compiler/lexer.capnp.h": ":src[c++/src/capnp/compiler/lexer.capnp.h]",
        "capnp/compiler/lexer.h": ":src[c++/src/capnp/compiler/lexer.h]",
        "capnp/compiler/module-loader.h": ":src[c++/src/capnp/compiler/module-loader.h]",
        "capnp/compiler/node-translator.h": ":src[c++/src/capnp/compiler/node-translator.h]",
        "capnp/compiler/parser.h": ":src[c++/src/capnp/compiler/parser.h]",
        "capnp/compiler/resolver.h": ":src[c++/src/capnp/compiler/resolver.h]",
        "capnp/compiler/type-id.h": ":src[c++/src/capnp/compiler/type-id.h]",
    },
)

depot.cxx_library(
    name = 'capnp',
    srcs = [
        ":capnp-srcs[capnp/any.c++]",
        ":capnp-srcs[capnp/arena.c++]",
        ":capnp-srcs[capnp/blob.c++]",
        ":capnp-srcs[capnp/c++.capnp.c++]",
        ":capnp-srcs[capnp/dynamic.c++]",
        ":capnp-srcs[capnp/layout.c++]",
        ":capnp-srcs[capnp/list.c++]",
        ":capnp-srcs[capnp/message.c++]",
        ":capnp-srcs[capnp/schema.c++]",
        ":capnp-srcs[capnp/schema.capnp.c++]",
        ":capnp-srcs[capnp/schema-loader.c++]",
        ":capnp-srcs[capnp/serialize.c++]",
        ":capnp-srcs[capnp/serialize-packed.c++]",
        ":capnp-srcs[capnp/stream.capnp.c++]",
        ":capnp-srcs[capnp/stringify.c++]",
    ],

    compiler_flags = select({
        'config//os:windows': [ '/TP' ],
        'DEFAULT': [],
    }),

    preprocessor_flags = select({
        'config//os:windows': [
            '-D_WINDOWS',
            '-DWIN32',
            '-DWIN32_LEAN_AND_MEAN',
        ],
        'DEFAULT': [],
    }) + [
        "-I$(location :kj-srcs)",
        "-I$(location :capnp-srcs)",
    ],

    preferred_linkage = 'static',
    exported_deps = [ ":kj" ],
)

depot.cxx_library(
    name = 'capnpc',
    srcs = [
        ":capnp-srcs[capnp/compiler/compiler.c++]",
        ":capnp-srcs[capnp/compiler/error-reporter.c++]",
        ":capnp-srcs[capnp/compiler/generics.c++]",
        ":capnp-srcs[capnp/compiler/grammar.capnp.c++]",
        ":capnp-srcs[capnp/compiler/lexer.c++]",
        ":capnp-srcs[capnp/compiler/lexer.capnp.c++]",
        ":capnp-srcs[capnp/compiler/node-translator.c++]",
        ":capnp-srcs[capnp/compiler/parser.c++]",
        ":capnp-srcs[capnp/compiler/type-id.c++]",
        ":capnp-srcs[capnp/schema-parser.c++]",
        ":capnp-srcs[capnp/serialize-text.c++]",
    ],

    compiler_flags = select({
        'config//os:windows': [ '/TP' ],
        'DEFAULT': [],
    }),

    preprocessor_flags = select({
        'config//os:windows': [
            '-D_WINDOWS',
            '-DWIN32',
            '-DWIN32_LEAN_AND_MEAN',
        ],
        'DEFAULT': [],
    }) + [
        "-I$(location :kj-srcs)",
        "-I$(location :capnp-srcs)",
    ],

    preferred_linkage = 'static',
    exported_deps = [ ":capnp" ],
)

depot.copy_files(
    name = 'compat_json-srcs',
    srcs = {
        "capnp/compat/json.c++": ":src[c++/src/capnp/compat/json.c++]",
        "capnp/compat/json.capnp.c++": ":src[c++/src/capnp/compat/json.capnp.c++]",
        "capnp/compat/json.h": ":src[c++/src/capnp/compat/json.h]",
        "capnp/compat/json.capnp.h": ":src[c++/src/capnp/compat/json.capnp.h]",
    },
)

depot.cxx_library(
    name = 'compat_json',
    srcs = [
        ":compat_json-srcs[capnp/compat/json.c++]",
        ":compat_json-srcs[capnp/compat/json.capnp.c++]",
    ],
    compiler_flags = select({
        'config//os:windows': [ '/TP' ],
        'DEFAULT': [],
    }),

    preprocessor_flags = select({
        'config//os:windows': [
            '-D_WINDOWS',
            '-DWIN32',
            '-DWIN32_LEAN_AND_MEAN',
        ],
        'DEFAULT': [],
    }) + [
        "-I$(location :kj-srcs)",
        "-I$(location :capnp-srcs)",
        "-I$(location :compat_json-srcs)",
    ],

    preferred_linkage = 'static',
    deps = [ ":capnp" ],
)

depot.cxx_binary(
    name = 'capnp_tool',
    srcs = [
        ":capnp-srcs[capnp/compiler/capnp.c++]",
        ":capnp-srcs[capnp/compiler/module-loader.c++]",
    ],
    compiler_flags = select({
        'config//os:windows': [ '/TP' ],
        'DEFAULT': [],
    }),

    preprocessor_flags = select({
        'config//os:windows': [
            '-D_WINDOWS',
            '-DWIN32',
            '-DWIN32_LEAN_AND_MEAN',
        ],
        'DEFAULT': [],
    }) + [
        "-I$(location :kj-srcs)",
        "-I$(location :capnp-srcs)",
        "-I$(location :compat_json-srcs)",
    ],

    link_style = 'static',
    deps = [ ":capnpc", ":compat_json" ],
    visibility = [ 'PUBLIC' ],
)

depot.write_file(
    name = 'capnp-rust.rs',
    # XXX: this program is © 2013-2024 Sandstorm Development Group, Inc. and
    # contributors but is probably so simple it barely qualifies for the
    # "threshold of originality"; there's no real other way to write this
    # program.
    contents = [
        "pub fn main() {",
        "    ::capnpc::codegen::CodeGenerationCommand::new()",
        "        .output_directory(::std::path::Path::new(\".\"))",
        "        .run(::std::io::stdin())",
        "        .expect(\"failed to generate code\");",
        "}",
    ],
)

depot.rust_binary(
    name = 'capnpc-rust',
    mapped_srcs = { ':capnp-rust.rs': 'main.rs' },
    deps = [
        'third-party//rust:capnpc',
    ],
    visibility = [ 'PUBLIC' ],
)
