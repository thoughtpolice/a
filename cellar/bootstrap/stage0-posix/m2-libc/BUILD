
load("@cellar//bootstrap/stage0-posix:defs.bzl", "export_file", "filegroup")

EXTS = [
    "**/*.c",
    "**/*.h",
    "**/*.M1",
    "**/*.hex2",
]

[
    export_file(name = name) for name in glob(EXTS)
]

filegroup(
    name = "m2-libc",
    srcs = glob(EXTS),
)
