
load("@cellar//bootstrap:defs.bzl", "export_file")

EXTS = [
    "**/*.c",
    "**/*.h",
    "**/*.M1",
    "**/*.hex2",
]

[
    export_file(name = name) for name in glob(EXTS)
]
