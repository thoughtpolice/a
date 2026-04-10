load(":defs.bzl", "cc")

# mescc-tools-extra is compiled with M2-Mesoplanet, producing native binaries
# for the host architecture. Pick the right seed tools and target triple for
# whichever arch buck2 is running on; amd64 and aarch64 are the two currently
# supported hosts.
_ARCH = "aarch64" if host_info().arch.is_aarch64 else "amd64"
_SEED_BINS = (
    "cellar//bootstrap/stage0-posix/seeds/linux-arm64:bins" if host_info().arch.is_aarch64
    else "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins"
)

[
    cc(
        name = name,
        src = src,
        os = "Linux",
        arch = _ARCH,
        tools = _SEED_BINS,
    )
    for (src, name) in map(
        lambda x: (x, x.split(".")[0] if "." in x else x),
        glob(["*.c"]),
    )
]
