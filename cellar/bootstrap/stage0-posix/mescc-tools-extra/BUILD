load("@cellar//bootstrap:defs.bzl", "export_file")
load(":defs.bzl", "cc")

[
    cc(
        name=name,
        src=src,
        os="Linux",
        arch="amd64",
        tools="cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
        m2_mesoplanet_script=":M2-Mesoplanet.sh",
    )
    for (src, name) in map(
        lambda x: (x, x.split(".")[0] if "." in x else x),
        glob(["*.c"]),
    )
]

export_file(name="M2-Mesoplanet.sh")
