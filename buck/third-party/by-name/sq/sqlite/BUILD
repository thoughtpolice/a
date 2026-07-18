# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version().split(".")  # something like '3.46.1'

# quoting https://www.sqlite.org/download.html: "The version is encoded
# so that filenames sort in order of increasing version number when
# viewed using "ls". For version 3.X.Y the filename encoding is 3XXYY00.
# For branch version 3.X.Y.Z, the encoding is 3XXYYZZ."
URL_VERSION = "{major}{minor}{patch}00".format(
    major = VERSION[0],
    minor = shims.rjust(
        VERSION[1],
        "0",
        2,
    ),
    patch = shims.rjust(
        VERSION[2],
        "0",
        2,
    ),
)

shims.http_archive(
    name = "src",
    sha256 = "c917d7db16648ec95f714974ace5e5dcf46b7dc70e26600a0a102a3141125db0",
    strip_prefix = "sqlite-autoconf-{URL_VERSION}".format(URL_VERSION = URL_VERSION),
    sub_targets = [
        "sqlite3.c",
        "sqlite3.h",
        "sqlite3ext.h",
    ],
    type = "tar.gz",
    urls = [
        "https://www.sqlite.org/2026/sqlite-autoconf-{URL_VERSION}.tar.gz".format(URL_VERSION = URL_VERSION),
    ],
)

BUILD_FLAGS = [
    "SQLITE_CORE",
    "SQLITE_DEFAULT_FOREIGN_KEYS=1",
    "SQLITE_ENABLE_API_ARMOR",
    "SQLITE_ENABLE_COLUMN_METADATA",
    "SQLITE_ENABLE_DBSTAT_VTAB",
    "SQLITE_ENABLE_FTS3",
    "SQLITE_ENABLE_FTS3_PARENTHESIS",
    "SQLITE_ENABLE_FTS5",
    "SQLITE_ENABLE_JSON1",
    "SQLITE_ENABLE_MEMORY_MANAGEMENT",
    "SQLITE_ENABLE_RTREE",
    "SQLITE_ENABLE_STAT4",
    "SQLITE_ENABLE_SESSION",
    "SQLITE_SOUNDEX",
    "SQLITE_THREADSAFE=1",
    "SQLITE_USE_URI",
    "HAVE_USLEEP=1",
    "HAVE_ISNAN",
]

shims.cxx_library(
    name = "sqlite",
    srcs = [":src[sqlite3.c]"],
    exported_headers = {
        "sqlite3.h": ":src[sqlite3.h]",
        "sqlite3ext.h": ":src[sqlite3ext.h]",
    },
    exported_preprocessor_flags = map(
        lambda x: "-D{x}".format(x = x),
        BUILD_FLAGS,
    ),
    header_namespace = "",
    preferred_linkage = "static",
)

# write out some wrapper.h files for the sqlite3.h and sqlite3ext.h
# that also contain pre-include #define directives as specified above; that way
# anyone who includes these headers will get the same build settings as the library

# FIXME (aseipp): re-enable this

HEADER_FILE_FLAGS = map(
    lambda x: "#define {}".format(x.replace("=", " ")),
    BUILD_FLAGS,
)

[
    shims.genrule(
        name = "wrapper_{f}.h".format(f = f),
        srcs = [":src[{f}.h]".format(f = f)],
        out = "wrapper_{f}.h".format(f = f),
        cmd = """
            echo -e "{headers}\n#include \\"{file}.h\\"" > $OUT
        """.format(
            file = f,
            headers = "\n".join(HEADER_FILE_FLAGS),
        ),
    )
    for f in [
        "sqlite3",
        "sqlite3ext",
    ]
]
