# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

# include/vulkan: the C headers, one per platform's WSI, and Vulkan-Hpp.
VULKAN_HEADERS = [
    "vk_icd.h",
    "vk_layer.h",
    "vk_platform.h",
    "vulkan.h",
    "vulkan.hpp",
    "vulkan_android.h",
    "vulkan_beta.h",
    "vulkan_core.h",
    "vulkan_directfb.h",
    "vulkan_enums.hpp",
    "vulkan_extension_inspection.hpp",
    "vulkan_format_traits.hpp",
    "vulkan_fuchsia.h",
    "vulkan_funcs.hpp",
    "vulkan_ggp.h",
    "vulkan_handles.hpp",
    "vulkan_hash.hpp",
    "vulkan_hpp_macros.hpp",
    "vulkan_ios.h",
    "vulkan_macos.h",
    "vulkan_metal.h",
    "vulkan_ohos.h",
    "vulkan_raii.hpp",
    "vulkan_screen.h",
    "vulkan_shared.hpp",
    "vulkan_static_assertions.hpp",
    "vulkan_structs.hpp",
    "vulkan_to_string.hpp",
    "vulkan_ubm.h",
    "vulkan_vi.h",
    "vulkan_video.hpp",
    "vulkan_wayland.h",
    "vulkan_win32.h",
    "vulkan_xcb.h",
    "vulkan_xlib.h",
    "vulkan_xlib_xrandr.h",
]

# include/vk_video: the video codec headers vulkan_core.h includes.
VIDEO_HEADERS = [
    "vulkan_video_codec_av1std.h",
    "vulkan_video_codec_av1std_decode.h",
    "vulkan_video_codec_av1std_encode.h",
    "vulkan_video_codec_h264std.h",
    "vulkan_video_codec_h264std_decode.h",
    "vulkan_video_codec_h264std_encode.h",
    "vulkan_video_codec_h265std.h",
    "vulkan_video_codec_h265std_decode.h",
    "vulkan_video_codec_h265std_encode.h",
    "vulkan_video_codec_vp9std.h",
    "vulkan_video_codec_vp9std_decode.h",
    "vulkan_video_codecs_common.h",
]

shims.http_archive(
    name = "src",
    sha256 = "e87dce08116151f6b6d7de6b6faf41498e87e6cf848ff16fa3bd5402190ad4a3",
    strip_prefix = "Vulkan-Headers-vulkan-sdk-{}.0".format(VERSION),
    sub_targets = ["include/vulkan/" + h for h in VULKAN_HEADERS] +
                  ["include/vk_video/" + h for h in VIDEO_HEADERS],
    type = "tar.gz",
    urls = [
        "https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/vulkan-sdk-{}.0.tar.gz".format(VERSION),
    ],
)

# A platform's WSI types come from its own headers (vulkan.h includes
# <X11/Xlib.h> for VK_USE_PLATFORM_XLIB_KHR, for example), which a user
# provides with the VK_USE_PLATFORM_* macro it defines.
shims.cxx_library(
    name = "vulkan-headers",
    exported_headers = {
        "vulkan/" + h: ":src[include/vulkan/{}]".format(h)
        for h in VULKAN_HEADERS
    } | {
        "vk_video/" + h: ":src[include/vk_video/{}]".format(h)
        for h in VIDEO_HEADERS
    },
    header_namespace = "",
)

shims.cxx_binary(
    name = "test-headers-bin",
    srcs = ["test.c"],
    preprocessor_flags = ["-DEXPECTED_HEADER_VERSION={}".format(VERSION.split(".")[2])],
    deps = [":vulkan-headers"],
)

shims.command_test(
    name = "test-headers",
    cmd = ["$(exe :test-headers-bin)"],
)

shims.cxx_binary(
    name = "test-hpp-bin",
    srcs = ["test.cpp"],
    deps = [":vulkan-headers"],
)

shims.command_test(
    name = "test-hpp",
    cmd = ["$(exe :test-hpp-bin)"],
)
