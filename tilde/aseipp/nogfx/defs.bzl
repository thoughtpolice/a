# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Flags and rules for nogfx programs: their C++ flags, Slang shaders, and
install trees that run on the host's GPU driver."""

load("@root//buck/shims:shims.bzl", "shims")

# Upstream's CMakeLists.txt: C++20 without exceptions or RTTI, and its
# warnings.
NOGFX_COMPILER_FLAGS = [
    "-std=c++20",
    "-fno-exceptions",
    "-fno-rtti",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-Wconversion",
    "-Wshadow",
    "-Wno-missing-field-initializers",
]

_SHADER_INCLUDE = "tilde//aseipp/nogfx:shader-include"

def nogfx_shader(name, src, entry, stage, srcs = []):
    """SPIR-V for one entry point of a Slang shader, checked by spirv-val.

    Upstream's NoGraphicsAPI_compile_slang() for Vulkan: SPIR-V 1.5 through
    descriptor heaps (and mesh shading, for mesh and amplification stages).
    `srcs` are the other files of the package `src` includes, which it finds
    from the top of the package; <nogfx/shader.slang> is always on the
    include path.
    """
    capabilities = ["spvDescriptorHeapEXT"]
    if stage in ["mesh", "amplification"]:
        capabilities.append("spvMeshShadingEXT")
    shims.genrule(
        name = name,
        srcs = [src] + srcs,
        out = name,
        cmd = " && ".join([
            " ".join([
                "$(exe third-party//by-name/sl/slang:slangc)",
                "$SRCDIR/" + src,
                "-target spirv -profile spirv_1_5 -emit-spirv-directly -fvk-use-entrypoint-name",
                "-entry {} -stage {}".format(entry, stage),
                "-fvk-use-c-layout -matrix-layout-row-major",
                "-I $SRCDIR -I $(location {})".format(_SHADER_INCLUDE),
            ] + ["-capability " + c for c in capabilities] + [
                "-o $OUT",
            ]),
            "$(exe third-party//by-name/sp/spirv-tools:spirv-val) --target-env vulkan1.4 --scalar-block-layout $OUT",
        ]),
    )

# The host's dynamic linker, for each CPU.
_HOST_INTERPRETER = {
    "config//cpu:arm64": "/lib/ld-linux-aarch64.so.1",
    "config//cpu:x86_64": "/lib64/ld-linux-x86-64.so.2",
}

_PATCHELF = "$(exe third-party//by-name/pa/patchelf:patchelf)"

def host_vulkan_program(name, binary, data = {}):
    """A Vulkan program, runnable as `name`, from an install tree that loads
    the host's GPU driver.

    The toolchain's programs run on its own dynamic linker, which cannot load
    the host's GPU driver (the driver needs the host's libc and libstdc++,
    and finds its own libraries in the host's directories). The install tree
    `name`-dist gives the program the host's dynamic linker in its place,
    and libvulkan.so.1 beside it in ../lib, so that everything else comes
    from the host, whose libraries must be at least as new as the
    toolchain's. `data` maps paths in the tree to the files to install
    there; `name` runs the program from the top of the tree, so it finds
    them at those (relative) paths. `name`-test checks the tree.
    """
    dist = name + "-dist"
    program = "$OUT/bin/" + name
    copies = []
    for path, label in data.items():
        directory = path.rpartition("/")[0]
        if directory:
            copies.append("mkdir -p $OUT/" + directory)
        copies.append("cp $(location {}) $OUT/{}".format(label, path))

    shims.genrule(
        name = dist,
        out = name,
        cmd = " && ".join([
            "mkdir -p $OUT/bin $OUT/lib",
            "cp $(location {}) {}".format(binary, program),
            "cp $(location third-party//by-name/vu/vulkan-loader:vulkan[shared]) $OUT/lib/libvulkan.so.1",
            "chmod u+w {} $OUT/lib/libvulkan.so.1".format(program),
            _PATCHELF + " --remove-rpath $OUT/lib/libvulkan.so.1",
            _PATCHELF + " --set-rpath '$ORIGIN/../lib' " + program,
        ] + copies + [
            _PATCHELF + " --set-interpreter ",
        ]) + shims.select(_HOST_INTERPRETER) + " " + program,
    )

    shims.command(
        name = name,
        cmd = [
            "sh",
            "-c",
            "cd \"$0\" && exec ./bin/{} \"$@\"".format(name),
            "$(location :{})".format(dist),
        ],
    )

    # The program needs a GPU to run, which CI lacks; this checks what makes
    # it runnable on the host instead.
    shims.command_test(
        name = name + "-test",
        script = """
            dist=$(location :{dist})
            readelf -l $dist/bin/{name} | grep -q 'interpreter: /lib'
            readelf -d $dist/bin/{name} | grep -q 'RUNPATH.*\\[\\$ORIGIN/../lib\\]'
            if readelf -d $dist/lib/libvulkan.so.1 | grep -q 'RUNPATH\\|RPATH'; then
                echo "libvulkan.so.1 still has a search path" >&2
                exit 1
            fi
            for path in {data}; do
                test -s $dist/$path
            done
        """.format(
            data = " ".join(data.keys()),
            dist = dist,
            name = name,
        ),
    )
