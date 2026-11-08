/*
 * SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */

/* The Xlib types vulkan_xlib.h names, as <X11/Xlib.h> defines them. The
 * loader only passes these handles from an application to a driver, so it
 * needs neither the rest of Xlib's headers nor libX11. */

#ifndef DEPOT_VULKAN_LOADER_XLIB_H
#define DEPOT_VULKAN_LOADER_XLIB_H

typedef unsigned long XID;
typedef unsigned long VisualID;
typedef XID Window;
typedef struct _XDisplay Display;

#endif
