# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "ungz", "untar")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")
load(":sources.bzl", "FILES")

VERSION = "44d780e03e78efcb3168ceab068170206dc92e85"

download_file(
    name = "musl-chartable-tools.tar.gz",
    hash = "952eae3ee6da3cbc5c29faa2ac728b882d5d43e744bca31daae98c66739ea121",
    size_bytes = 7048550,
    urls = ["https://codeload.github.com/richfelker/musl-chartable-tools/tar.gz/" + VERSION],
)

ungz(
    name = "tables.tar",
    input = ":musl-chartable-tools.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "musl-chartable-tools-" + VERSION,
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    input = ":tables.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

# TCC 0.9.27 does not implement C99's implicit return from main.
PATCHED_GENERATORS = {
    "ctype/gen_ctype.c": "ctype",
    "ctype/gen_wide.c": "wide",
    "ctype/gen_nonspacing.c": "nonspacing",
    "iconv/jis.c": "jis",
    "iconv/gb.c": "gb",
    "iconv/big5.c": "big5",
    "iconv/hkscs.c": "hkscs",
    "iconv/ks.c": "ks",
    "iconv/mkcodepage.c": "mkcodepage",
}

[
    exact_patch(
        name = name + "-source",
        src = ":musl-chartable-tools-" + VERSION + "[" + path + "]",
        after = "\n\treturn 0;\n}\n",
        before = "\n}\n",
    )
    for path, name in PATCHED_GENERATORS.items()
]

filegroup(
    name = "source",
    srcs = {path: ":musl-chartable-tools-" + VERSION + "[" + path + "]" for path in FILES} | {path: ":" + name + "-source" for path, name in PATCHED_GENERATORS.items()},
)

MUSL = "cellar//bootstrap/stage1/musl"

TCC = "cellar//bootstrap/stage1/tcc-musl"

[
    [
        c_object(
            name = name + ".o",
            src = src,
            headers = [MUSL + ":headers"] + ([":codepage-source"] if name == "mkcodepage" else []),
            object_name = name + ".o",
            toolchain = TCC + ":musl2",
        ),
        c_binary(
            name = name,
            end_objects = [
                MUSL + ":rebuilt-crtn.o",
            ],
            libraries = [
                MUSL + ":rebuilt-libc.a",
                TCC + ":musl2-libtcc1.a",
                MUSL + ":rebuilt-libc.a",
            ],
            objects = [
                MUSL + ":rebuilt-crt1.o",
                MUSL + ":rebuilt-crti.o",
                ":" + name + ".o",
            ],
            output = name,
            toolchain = TCC + ":musl2",
        ),
    ]
    for name, src in [
        ("ctype", ":source[ctype/gen_ctype.c]"),
        ("wide", ":source[ctype/gen_wide.c]"),
        ("nonspacing", ":source[ctype/gen_nonspacing.c]"),
        ("arrayify", ":source[ctype/arrayify.c]"),
        ("jis", ":source[iconv/jis.c]"),
        ("gb", ":source[iconv/gb.c]"),
        ("big5", ":source[iconv/big5.c]"),
        ("hkscs", ":source[iconv/hkscs.c]"),
        ("ks", ":source[iconv/ks.c]"),
        ("table-order", "table-order.c"),
        ("compare-tables", "compare-tables.c"),
        ("mkcodepage", ":codepage-source[mkcodepage.c]"),
    ]
]

[
    [
        generate(
            name = name + "-values",
            args = args,
            capture = "cellar//bootstrap/stage1/tools:capture",
            tool = ":" + tool,
            working_directory = ":source[ctype]",
        ),
        generate(
            name = name + ".h",
            capture = "cellar//bootstrap/stage1/tools:capture",
            stdin = ":" + name + "-values",
            tool = ":arrayify",
        ),
    ]
    for name, tool, args in [
        (
            "alpha",
            "ctype",
            ["a"],
        ),
        (
            "punct",
            "ctype",
            ["p"],
        ),
        ("wide", "wide", []),
        ("nonspacing", "nonspacing", []),
    ]
]

[
    [
        generate(
            name = name + "-values",
            capture = "cellar//bootstrap/stage1/tools:capture",
            stdin = ":source[iconv/cjk/" + data + "]",
            tool = ":" + tool,
        ),
        generate(
            name = name + ".h",
            capture = "cellar//bootstrap/stage1/tools:capture",
            stdin = ":" + name + "-values",
            tool = ":arrayify",
        ),
    ]
    for name, tool, data in [
        ("jis0208", "jis", "jis0208.txt"),
        ("gb18030", "gb", "gb18030.txt"),
        ("big5", "big5", "big5-musl.txt"),
        ("hkscs", "hkscs", "hkscs-2008-sect3-musl.txt"),
        ("ksc", "ks", "CP949.TXT"),
    ]
]

# The original Makefile uses filter/sort pipelines for these two tables.
# The native C transformer performs only those text operations.
[
    [
        generate(
            name = name + "-values",
            args = [mode] + ["$(location :source[" + path + "])" for path in paths],
            capture = "cellar//bootstrap/stage1/tools:capture",
            tool = ":table-order",
        ),
        generate(
            name = name + ".h",
            capture = "cellar//bootstrap/stage1/tools:capture",
            stdin = ":" + name + "-values",
            tool = ":arrayify",
        ),
    ]
    for name, mode, paths in [
        (
            "legacychars",
            "legacy",
            [path for path in FILES if path.startswith("iconv/charmaps/")],
        ),
        (
            "revjis",
            "revjis",
            ["iconv/cjk/jis0208.txt"],
        ),
    ]
]

filegroup(
    name = "codepage-source",
    srcs = {
        "mkcodepage.c": ":source[iconv/mkcodepage.c]",
        "legacychars.h": ":legacychars.h",
    },
)

# Preserve aliases.txt order: iconv's packed string table uses these offsets.
CODEPAGES = [
    (
        "iso-8859-1.txt",
        [
            "iso88591",
            "latin1",
        ],
    ),
    (
        "iso-8859-2.txt",
        ["iso88592"],
    ),
    (
        "iso-8859-3.txt",
        ["iso88593"],
    ),
    (
        "iso-8859-4.txt",
        ["iso88594"],
    ),
    (
        "iso-8859-5.txt",
        ["iso88595"],
    ),
    (
        "iso-8859-6.txt",
        ["iso88596"],
    ),
    (
        "iso-8859-7.txt",
        ["iso88597"],
    ),
    (
        "iso-8859-8.txt",
        ["iso88598"],
    ),
    (
        "iso-8859-9.txt",
        ["iso88599"],
    ),
    (
        "iso-8859-10.txt",
        ["iso885910"],
    ),
    (
        "iso-8859-11.txt",
        [
            "iso885911",
            "tis620",
        ],
    ),
    (
        "iso-8859-13.txt",
        ["iso885913"],
    ),
    (
        "iso-8859-14.txt",
        ["iso885914"],
    ),
    (
        "iso-8859-15.txt",
        [
            "iso885915",
            "latin9",
        ],
    ),
    (
        "iso-8859-16.txt",
        ["iso885916"],
    ),
    (
        "cp1250.txt",
        [
            "cp1250",
            "windows1250",
        ],
    ),
    (
        "cp1251.txt",
        [
            "cp1251",
            "windows1251",
        ],
    ),
    (
        "cp1252.txt",
        [
            "cp1252",
            "windows1252",
        ],
    ),
    (
        "cp1253.txt",
        [
            "cp1253",
            "windows1253",
        ],
    ),
    (
        "cp1254.txt",
        [
            "cp1254",
            "windows1254",
        ],
    ),
    (
        "cp1255.txt",
        [
            "cp1255",
            "windows1255",
        ],
    ),
    (
        "cp1256.txt",
        [
            "cp1256",
            "windows1256",
        ],
    ),
    (
        "cp1257.txt",
        [
            "cp1257",
            "windows1257",
        ],
    ),
    (
        "cp1258.txt",
        [
            "cp1258",
            "windows1258",
        ],
    ),
    (
        "koi8-r.txt",
        ["koi8r"],
    ),
    (
        "koi8-u.txt",
        ["koi8u"],
    ),
    (
        "cp437.txt",
        ["cp437"],
    ),
    (
        "cp850.txt",
        ["cp850"],
    ),
    (
        "cp866.txt",
        ["cp866"],
    ),
    (
        "ibm1047.txt",
        [
            "ibm1047",
            "cp1047",
        ],
    ),
]

[
    generate(
        name = "codepage-" + path,
        args = aliases,
        capture = "cellar//bootstrap/stage1/tools:capture",
        stdin = ":source[iconv/charmaps/" + path + "]",
        tool = ":mkcodepage",
    )
    for path, aliases in CODEPAGES
]

concatenate(
    name = "codepages.h",
    inputs = [":codepage-" + path for path, _aliases in CODEPAGES],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
)

filegroup(
    name = "generated",
    srcs = {"ctype/" + name + ".h": ":" + name + ".h" for name in [
        "alpha",
        "punct",
        "wide",
        "nonspacing",
    ]} | {"locale/" + name + ".h": ":" + name + ".h" for name in [
        "jis0208",
        "gb18030",
        "big5",
        "hkscs",
        "ksc",
        "legacychars",
        "codepages",
        "revjis",
    ]},
)

# Published tables are test oracles only, never generator inputs.
[
    command_test(
        name = "compare-" + path.replace("/", "-"),
        args = [
            "strings" if path == "locale/codepages.h" else "numbers",
            "$(location :generated[" + path + "])",
            "$(location " + MUSL + ":musl-1.1.24[src/" + path + "])",
        ],
        tool = ":compare-tables",
    )
    for path in [
        "ctype/alpha.h",
        "ctype/punct.h",
        "ctype/wide.h",
        "ctype/nonspacing.h",
        "locale/big5.h",
        "locale/codepages.h",
        "locale/gb18030.h",
        "locale/hkscs.h",
        "locale/jis0208.h",
        "locale/ksc.h",
        "locale/legacychars.h",
        "locale/revjis.h",
    ]
]
