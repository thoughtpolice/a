# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# The engine shim and the native host are sources of the application the
# demo package assembles. They keep a `doom/` path so their objects stay
# apart from the SDK's own host.c in the binaries that compile both.
[
    depot.export_file(
        name = source,
        src = source,
        out = "doom/" + source,
        visibility = ["PUBLIC"],
    )
    for source in [
        "host.c",
        "shim.c",
    ]
]

# The engine, one header at a pinned upstream commit. Its license and
# copyright notices are inside the file.
depot.http_file(
    name = "PureDOOM.h",
    sha256 = "ec16ce721436bf3fa4c338320afedd56a93c0b563a94ebf283718503c71ca780",
    urls = [
        "https://raw.githubusercontent.com/Daivuk/PureDOOM/355cfbd16fac119718879239336ee2ea408886bd/PureDOOM.h",
    ],
    visibility = ["PUBLIC"],
)

# Free game data for the engine. The checksum is the one published with the
# signed v0.13.0 release; the notices travel with the archive.
depot.http_archive(
    name = "freedoom",
    sha256 = "3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59",
    strip_prefix = "freedoom-0.13.0",
    sub_targets = [
        "freedoom1.wad",
        "freedoom2.wad",
        "COPYING.txt",
        "CREDITS.txt",
        "CREDITS-MUSIC.txt",
    ],
    type = "zip",
    urls = ["https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip"],
    visibility = ["PUBLIC"],
)
