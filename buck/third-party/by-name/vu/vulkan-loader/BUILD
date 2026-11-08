# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

# libvulkan.so.1, as loader/CMakeLists.txt builds it on Linux: every WSI
# platform (X11 through Xlib and XCB, Xlib with XRandR, and Wayland), and
# the assembly trampolines that let applications call device functions the
# loader does not know about. It looks for drivers and layers where a
# distribution's loader does (/etc, /usr/local/share, /usr/share and the
# XDG directories), so the system's GPU drivers are found at run time.

VERSION = pkg.version()

# NORMAL_LOADER_SRCS and the Linux and "unknown function" (OPT_LOADER_SRCS)
# additions. loader.c includes generated/vk_loader_extensions.c itself.
SOURCES = [
    "loader/allocation.c",
    "loader/cJSON.c",
    "loader/debug_utils.c",
    "loader/dev_ext_trampoline.c",
    "loader/extension_manual.c",
    "loader/gpa_helper.c",
    "loader/loader.c",
    "loader/loader_environment.c",
    "loader/loader_json.c",
    "loader/loader_linux.c",
    "loader/log.c",
    "loader/phys_dev_ext.c",
    "loader/settings.c",
    "loader/terminator.c",
    "loader/trampoline.c",
    "loader/unknown_function_handling.c",
    "loader/wsi.c",
]

ASSEMBLY = {
    "aarch64": "loader/unknown_ext_chain_gas_aarch.S",
    "x86_64": "loader/unknown_ext_chain_gas_x86.S",
}

shims.http_archive(
    name = "src",
    excludes = ["^tests/"],
    sha256 = "54f2537df22313768da0317dda2abdaaab7711b4081c48c869a79db343d0ae70",
    strip_prefix = "Vulkan-Loader-vulkan-sdk-{}.0".format(VERSION),
    sub_targets = SOURCES + ASSEMBLY.values() + ["loader/asm_offset.c"],
    type = "tar.gz",
    urls = [
        "https://github.com/KhronosGroup/Vulkan-Loader/archive/refs/tags/vulkan-sdk-{}.0.tar.gz".format(VERSION),
    ],
)

# Stand-ins for the X11 and XCB headers vulkan.h includes for those
# platforms' WSI, declaring only the handle types the WSI structs carry.
# Code that only passes such handles through (this loader, or a renderer
# given them by a windowing library) can use them in place of the real
# headers, which no -devel package provides here.
shims.cxx_library(
    name = "wsi-types",
    exported_headers = {
        "X11/Xlib.h": "wsi-types/X11/Xlib.h",
        "X11/extensions/Xrandr.h": "wsi-types/X11/extensions/Xrandr.h",
        "xcb/xcb.h": "wsi-types/xcb/xcb.h",
    },
    header_namespace = "",
    visibility = ["PUBLIC"],
)

# The top-level CMakeLists.txt's options for a Linux build with glibc, which
# has secure_getenv() (and no longer __secure_getenv()) and realpath().
PREPROCESSOR_FLAGS = [
    "-I$(location :src)/loader",
    "-I$(location :src)/loader/generated",
    "-D_GNU_SOURCE",
    "-D_FILE_OFFSET_BITS=64",
    "-DHAVE_REALPATH",
    "-DHAVE_SECURE_GETENV",
    "-DLOADER_ENABLE_LINUX_SORT",
    "-DVK_ENABLE_BETA_EXTENSIONS",
    "-DVK_USE_PLATFORM_WAYLAND_KHR",
    "-DVK_USE_PLATFORM_XCB_KHR",
    "-DVK_USE_PLATFORM_XLIB_KHR",
    "-DVK_USE_PLATFORM_XLIB_XRANDR_EXT",
    "-DFALLBACK_CONFIG_DIRS=\"/etc/xdg\"",
    "-DFALLBACK_DATA_DIRS=\"/usr/local/share:/usr/share\"",
    "-DSYSCONFDIR=\"/etc\"",
]

COMPILER_FLAGS = [
    "-std=c99",
    "-fvisibility=hidden",
    "-fno-strict-aliasing",
]

DEPS = [
    ":wsi-types",
    "third-party//by-name/vu/vulkan-headers:vulkan-headers",
]

# asm_offset prints the struct offsets and sizes the trampolines need, as
# gen_defines.asm.
shims.cxx_binary(
    name = "asm-offset",
    srcs = [":src[loader/asm_offset.c]"],
    compiler_flags = COMPILER_FLAGS,
    preprocessor_flags = PREPROCESSOR_FLAGS,
    deps = DEPS,
)

shims.genrule(
    name = "gen_defines.asm",
    out = "gen_defines.asm",
    cmd = " && ".join([
        "asm_offset=`realpath $(exe :asm-offset)`",
        "out=`realpath -m $OUT`",
        "cd `dirname $out`",
        "$asm_offset GAS",
        "test `basename $out` = gen_defines.asm",
    ]),
)

shims.cxx_library(
    name = "vulkan",
    srcs = [":src[{}]".format(f) for f in SOURCES] + shims.select({
        "config//cpu:arm64": [":src[{}]".format(ASSEMBLY["aarch64"])],
        "config//cpu:x86_64": [":src[{}]".format(ASSEMBLY["x86_64"])],
    }),
    compiler_flags = COMPILER_FLAGS,
    exported_deps = ["third-party//by-name/vu/vulkan-headers:vulkan-headers"],
    header_namespace = "",
    headers = {
        "gen_defines.asm": ":gen_defines.asm",
    },
    linker_flags = [
        "-Wl,--no-undefined",
        "-ldl",
        "-lm",
        "-pthread",
    ],
    preferred_linkage = "shared",
    preprocessor_flags = PREPROCESSOR_FLAGS,
    soname = "libvulkan.so.1",
    visibility = ["PUBLIC"],
    deps = [":wsi-types"],
)

# MARK: Tests

shims.cxx_binary(
    name = "test-loader-bin",
    srcs = ["test.c"],
    link_style = "shared",
    deps = [":vulkan"],
)

# Creating an instance needs no driver: the loader enumerates what it finds
# (possibly nothing, as on CI) and reports its own version, the API's.
shims.command_test(
    name = "test-loader",
    cmd = ["$(exe :test-loader-bin)"],
)

# The loader exports the Vulkan API and nothing of its own.
shims.command_test(
    name = "test-exports",
    script = """
        lib=$(location :vulkan[shared])
        exports=`nm -D --defined-only $lib | awk '{print $3}'`
        echo "$exports" | grep -qx vkCreateInstance
        echo "$exports" | grep -qx vkCreateWaylandSurfaceKHR
        echo "$exports" | grep -qx vkCreateXlibSurfaceKHR
        if echo "$exports" | grep -v '^vk' | grep -v '^_' | grep .; then
            echo "libvulkan exports names beyond the Vulkan API" >&2
            exit 1
        fi
        readelf -d $lib | grep -q 'SONAME.*libvulkan.so.1'
    """,
)
