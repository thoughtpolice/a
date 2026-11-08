// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// depot: <nogfx/window.hpp> on Linux, which upstream does not have. The window
// is winit's (winit.rs), and the void* passed to create_device as
// DeviceDesc::window is the gpu::LinuxWindow below, which pump_window keeps
// the window's size current in.

#include <nogfx/window.hpp>

#include <assert.h>
#include <stdio.h>
#include <time.h>

namespace
{

// winit.rs's window, and the handles it hands out for a Vulkan surface.
struct WinitWindow;

struct NativeWindow
{
    uint32 platform;
    void* display;
    void* wayland_surface;
    uint64 xlib_window;
};

extern "C" WinitWindow* nogfx_window_open(const char* title, uint32 width, uint32 height) noexcept;
extern "C" bool nogfx_window_native(const WinitWindow* window, NativeWindow* out) noexcept;
extern "C" bool nogfx_window_pump(WinitWindow* window, uint32* width, uint32* height) noexcept;
extern "C" void nogfx_window_close(WinitWindow* window) noexcept;

// The gpu::LinuxWindow comes first, so that the window's void* points to it.
struct Window
{
    gpu::LinuxWindow linux_window;
    WinitWindow* winit;
};

} // namespace

double time_seconds() noexcept
{
    timespec now{};
    clock_gettime(CLOCK_MONOTONIC, &now);
    return double(now.tv_sec) + double(now.tv_nsec) * 1e-9;
}

void* open_window(const char* title, uint32 width, uint32 height) noexcept
{
    assert(title && width && height);
    WinitWindow* winit = nogfx_window_open(title, width, height);
    if (!winit)
        return nullptr;
    NativeWindow native{};
    if (!nogfx_window_native(winit, &native))
    {
        fprintf(stderr, "nogfx: the window is neither a Wayland nor an Xlib one\n");
        nogfx_window_close(winit);
        return nullptr;
    }
    Window* window = new Window{
        .linux_window = {
            .platform = native.platform == 0 ? gpu::LinuxWindow::Platform::wayland : gpu::LinuxWindow::Platform::xlib,
            .display = native.display,
            .wayland_surface = native.wayland_surface,
            .xlib_window = native.xlib_window,
        },
        .winit = winit,
    };
    nogfx_window_pump(winit, &window->linux_window.width, &window->linux_window.height);
    return &window->linux_window;
}

bool pump_window(void* handle) noexcept
{
    Window* window = reinterpret_cast<Window*>(handle);
    return nogfx_window_pump(window->winit, &window->linux_window.width, &window->linux_window.height);
}

void close_window(void*& handle) noexcept
{
    if (handle)
    {
        Window* window = reinterpret_cast<Window*>(handle);
        nogfx_window_close(window->winit);
        delete window;
    }
    handle = nullptr;
}
