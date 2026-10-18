# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

# pixman_files in pixman/meson.build. The per-cpu files among them compile to
# nothing but a detection stub on other cpus.
PIXMAN_SRCS = [
    "pixman.c",
    "pixman-access.c",
    "pixman-access-accessors.c",
    "pixman-arm.c",
    "pixman-bits-image.c",
    "pixman-combine32.c",
    "pixman-combine-float.c",
    "pixman-conical-gradient.c",
    "pixman-edge.c",
    "pixman-edge-accessors.c",
    "pixman-fast-path.c",
    "pixman-filter.c",
    "pixman-glyph.c",
    "pixman-general.c",
    "pixman-gradient-walker.c",
    "pixman-image.c",
    "pixman-implementation.c",
    "pixman-linear-gradient.c",
    "pixman-matrix.c",
    "pixman-mips.c",
    "pixman-noop.c",
    "pixman-ppc.c",
    "pixman-radial-gradient.c",
    "pixman-region16.c",
    "pixman-region32.c",
    "pixman-region64f.c",
    "pixman-riscv.c",
    "pixman-solid-fill.c",
    "pixman-timer.c",
    "pixman-trap.c",
    "pixman-utils.c",
    "pixman-x86.c",
]

# The headers the sources include, and the .c files some of them include
# textually to instantiate a second copy with accessors on.
PRIVATE_HEADERS = [
    "dither/blue-noise-64x64.h",
    "pixman-access.c",
    "pixman-accessor.h",
    "pixman-arm-asm.h",
    "pixman-arm-common.h",
    "pixman-arma64-neon-asm.h",
    "pixman-combine-float.h",
    "pixman-combine32.h",
    "pixman-compiler.h",
    "pixman-edge.c",
    "pixman-edge-imp.h",
    "pixman-inlines.h",
    "pixman-private.h",
    "pixman-region.c",
]

# The `simds` table of pixman/meson.build, for the cpus pixman-config.h
# describes: a library of each, built with the flags that let its intrinsics
# compile. meson adds -Winline as well, which only warns.
SIMDS = {
    "mmx": struct(
        asm = [],
        cpu = "x86_64",
        flags = ["-mmmx"],
    ),
    "sse2": struct(
        asm = [],
        cpu = "x86_64",
        flags = ["-msse2"],
    ),
    "ssse3": struct(
        asm = [],
        cpu = "x86_64",
        flags = ["-mssse3"],
    ),
    "arm-neon": struct(
        asm = [
            "pixman-arma64-neon-asm.S",
            "pixman-arma64-neon-asm-bilinear.S",
        ],
        cpu = "arm64",
        flags = [],
    ),
}

# test/meson.build's tests. They check their output against CRCs recorded from
# the C implementations, so they cover the SIMD paths of the host they run on.
TESTS = [
    "oob-test",
    "infinite-loop",
    "trap-crasher",
    "fence-image-self-test",
    "region-translate-test",
    "fetch-test",
    "a1-trap-test",
    "prng-test",
    "radial-invalid",
    "pdf-op-test",
    "region-test",
    "region-fractional-test",
    "combiner-test",
    "scaling-crash-test",
    "alpha-loop",
    "scaling-helpers-test",
    "rotate-test",
    "alphamap",
    "gradient-crash-test",
    "pixel-test",
    "matrix-test",
    "filter-reduction-test",
    "composite-traps-test",
    "region-contains-test",
    "glyph-test",
    "solid-test",
    "stress-test",
    "cover-test",
    "blitters-test",
    "affine-test",
    "scaling-test",
    "composite",
    "tolerance-test",
    "neg-stride-test",
    "thread-test",
]

shims.http_archive(
    name = "src",
    sha256 = "d09c44ebc3bd5bee7021c79f922fe8fb2fb57f7320f55e97ff9914d2346a591c",
    strip_prefix = "pixman-{}".format(VERSION),
    sub_targets = [
        "pixman/" + f
        for f in PIXMAN_SRCS + PRIVATE_HEADERS + [
            "pixman.h",
            "pixman-version.h.in",
        ] + ["pixman-{}.c".format(simd) for simd in SIMDS] + [
            asm
            for simd in SIMDS.values()
            for asm in simd.asm
        ]
    ] + [
        "test/utils/utils.c",
        "test/utils/utils.h",
        "test/utils/utils-prng.c",
        "test/utils/utils-prng.h",
    ] + ["test/{}.c".format(t) for t in TESTS],
    type = "tar.gz",
    urls = [
        "https://www.cairographics.org/releases/pixman-{}.tar.gz".format(VERSION),
    ],
)

VERSION_PARTS = VERSION.split(".")

shims.genrule(
    name = "pixman-version.h",
    srcs = [":src[pixman/pixman-version.h.in]"],
    out = "pixman-version.h",
    cmd = " ".join(["sed"] + [
        "-e 's/@{}@/{}/g'".format(k, v)
        for k, v in {
            "PIXMAN_VERSION_MAJOR": VERSION_PARTS[0],
            "PIXMAN_VERSION_MICRO": VERSION_PARTS[2],
            "PIXMAN_VERSION_MINOR": VERSION_PARTS[1],
        }.items()
    ] + ["$SRCS > $OUT && ! grep '@[A-Z_]*@' $OUT"]),
)

shims.cxx_library(
    name = "headers",
    exported_headers = {
        "pixman.h": ":src[pixman/pixman.h]",
        "pixman-version.h": ":pixman-version.h",
    },
    header_namespace = "",
)

# The project arguments of meson.build. -ftrapping-math keeps clang from
# hoisting a division above the FLOAT_IS_ZERO check that guards it.
PIXMAN_FLAGS = [
    "-std=gnu99",
    "-fno-strict-aliasing",
    "-fvisibility=hidden",
    "-ftrapping-math",
    "-Wno-unused-local-typedefs",
]

shims.cxx_library(
    name = "internal",
    exported_deps = [":headers"],
    exported_headers = {
        "pixman-config.h": "pixman-config.h",
    } | {
        h: ":src[pixman/{}]".format(h)
        for h in PRIVATE_HEADERS
    },
    exported_preprocessor_flags = ["-DHAVE_CONFIG_H"],
    header_namespace = "",
)

# Each is empty on the other cpus, rather than incompatible with them, so that
# naming one explicitly (as a target determinator's list does) is never an
# error on a host it doesn't apply to.
[
    shims.cxx_library(
        name = "pixman-" + name,
        srcs = shims.select({
            "config//cpu:" + simd.cpu: [":src[pixman/pixman-{}.c]".format(name)] + [
                ":src[pixman/{}]".format(asm)
                for asm in simd.asm
            ],
            "DEFAULT": [],
        }),
        compiler_flags = PIXMAN_FLAGS + simd.flags,
        preferred_linkage = "static",
        deps = [":internal"],
    )
    for name, simd in SIMDS.items()
]

shims.cxx_library(
    name = "pixman",
    srcs = [":src[pixman/{}]".format(f) for f in PIXMAN_SRCS],
    compiler_flags = PIXMAN_FLAGS,
    exported_deps = [":headers"],
    preferred_linkage = "static",
    visibility = ["PUBLIC"],
    deps = [":internal"] + [":pixman-" + name for name in SIMDS],
)

# Static, as meson builds it: -fvisibility=hidden leaves a shared copy with no
# symbols to export.
shims.cxx_library(
    name = "testutils",
    srcs = [
        ":src[test/utils/utils.c]",
        ":src[test/utils/utils-prng.c]",
    ],
    compiler_flags = PIXMAN_FLAGS,
    exported_deps = [
        ":internal",
        ":pixman",
    ],
    exported_headers = {
        "utils.h": ":src[test/utils/utils.h]",
        "utils-prng.h": ":src[test/utils/utils-prng.h]",
    },
    header_namespace = "",
    preferred_linkage = "static",
)

[
    shims.cxx_binary(
        name = "{}-bin".format(t),
        srcs = [":src[test/{}.c]".format(t)],
        compiler_flags = PIXMAN_FLAGS,
        linker_flags = ["-pthread"],
        deps = [":testutils"],
    )
    for t in TESTS
]

[
    shims.command_test(
        name = "test-" + t,
        cmd = ["$(exe :{}-bin)".format(t)],
    )
    for t in TESTS
]
