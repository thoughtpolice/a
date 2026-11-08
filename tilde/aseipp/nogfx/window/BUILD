# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("//aseipp/nogfx:defs.bzl", "NOGFX_COMPILER_FLAGS")

# depot: <nogfx/window.hpp>, a window to present to on Linux, which upstream
# does not have: winit's, through a C ABI (winit.rs), as a gpu::LinuxWindow
# (window.cpp). Wayland, or X11 where there is no Wayland compositor or
# NOGRAPHICSAPI_X11=1 asks for it; winit loads libwayland-client and libX11
# at run time.

shims.rust_library(
    name = "winit",
    srcs = ["winit.rs"],
    crate = "nogfx_winit",
    crate_root = "winit.rs",
    # Linked into C++ programs, which leave it nowhere to load a shared
    # library from.
    preferred_linkage = "static",
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:winit",
    ],
)

shims.cxx_library(
    name = "window",
    srcs = ["window.cpp"],
    compiler_flags = NOGFX_COMPILER_FLAGS,
    exported_deps = ["//aseipp/nogfx"],
    exported_headers = ["window.hpp"],
    header_namespace = "nogfx",
    preferred_linkage = "static",
    deps = [":winit"],
)
