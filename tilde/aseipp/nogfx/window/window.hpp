// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// depot: a window to present to, which upstream's examples open themselves
// (example_support.hpp, Win32 and macOS only); here it is winit's, on Linux.

#pragma once

#include <nogfx/nogfx.hpp>

// Opens a window of width by height logical pixels: Wayland's, or X11's
// where there is no Wayland compositor or NOGRAPHICSAPI_X11=1 asks for it.
// Returns what DeviceDesc::window takes (a gpu::LinuxWindow*), or null.
void* open_window(const char* title, uint32 width, uint32 height) noexcept;

// Handles the window's pending events, keeping its LinuxWindow's size
// current. Returns false once it is closed, or Escape is pressed.
bool pump_window(void* window) noexcept;

// Closes the window, after the device presenting to it is destroyed.
void close_window(void*& window) noexcept;

// Seconds on a monotonic clock, for animation.
double time_seconds() noexcept;
