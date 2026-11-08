/*
 * SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */

/* The XCB types vulkan_xcb.h names, as <xcb/xcb.h> and <xcb/xproto.h>
 * define them; see ../X11/Xlib.h. */

#ifndef DEPOT_VULKAN_LOADER_XCB_H
#define DEPOT_VULKAN_LOADER_XCB_H

#include <stdint.h>

typedef struct xcb_connection_t xcb_connection_t;
typedef uint32_t xcb_window_t;
typedef uint32_t xcb_visualid_t;

#endif
