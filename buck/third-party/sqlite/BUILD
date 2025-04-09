# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")
load("@root//buck/shims/package.bzl", "pkg")

VERSION = pkg.version().split(".")  # something like '3.46.1'
# quoting https://www.sqlite.org/download.html: "The version is encoded
# so that filenames sort in order of increasing version number when
# viewed using "ls". For version 3.X.Y the filename encoding is 3XXYY00.
# For branch version 3.X.Y.Z, the encoding is 3XXYYZZ."
URL_VERSION = "{major}{minor}{patch}00".format(
    major=VERSION[0],
    minor=shims.rjust(VERSION[1], "0", 2),
    patch=shims.rjust(VERSION[2], "0", 2),
)

http_archive(
    name="src",
    sha256="67d3fe6d268e6eaddcae3727fce58fcc8e9c53869bdd07a0c61e38ddf2965071",
    urls=[
        f"https://www.sqlite.org/2024/sqlite-autoconf-{URL_VERSION}.tar.gz",
    ],
    type="tar.gz",
    strip_prefix=f"sqlite-autoconf-{URL_VERSION}",
    sub_targets=[
        "sqlite3.c",
        "sqlite3.h",
        "sqlite3ext.h",
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
    name="sqlite",
    srcs=[":src[sqlite3.c]"],
    preferred_linkage="static",
    header_namespace="",
    exported_headers={
        "sqlite3.h": ":src[sqlite3.h]",
        "sqlite3ext.h": ":src[sqlite3ext.h]",
    },
    exported_preprocessor_flags=map(lambda x: f"-D{x}", BUILD_FLAGS),
)

# write out some wrapper.h files for the sqlite3.h and sqlite3ext.h
# that also contain pre-include #define directives as specified above; that way
# anyone who includes these headers will get the same build settings as the library

# FIXME (aseipp): re-enable this

HEADER_FILE_FLAGS = map(lambda x: "#define {}".format(x.replace("=", " ")), BUILD_FLAGS)
[
    genrule(
        name=f"wrapper_{f}.h",
        srcs=[f":src[{f}.h]"],
        out=f"wrapper_{f}.h",
        cmd="""
            echo -e "{headers}\n#include \\"{file}.h\\"" > $OUT
        """.format(headers="\n".join(HEADER_FILE_FLAGS), file=f),
    )
    for f in ["sqlite3", "sqlite3ext"]
]
