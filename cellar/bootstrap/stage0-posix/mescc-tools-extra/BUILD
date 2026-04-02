load(":defs.bzl", "cc")

[
    cc(
        name=name,
        src=src,
        os="Linux",
        arch="amd64",
        tools="cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
    )
    for (src, name) in map(
        lambda x: (x, x.split(".")[0] if "." in x else x),
        glob(["*.c"]),
    )
]
