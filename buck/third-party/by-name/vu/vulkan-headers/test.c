// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The C headers are this package's version, and declare the Vulkan 1.4 API
// and the Wayland WSI (which, unlike X11's, needs no platform headers).

#define VK_USE_PLATFORM_WAYLAND_KHR
#include <stdio.h>
#include <vulkan/vulkan.h>

_Static_assert(VK_HEADER_VERSION == EXPECTED_HEADER_VERSION, "header version");
_Static_assert(VK_API_VERSION_MAJOR(VK_HEADER_VERSION_COMPLETE) == 1 &&
                   VK_API_VERSION_MINOR(VK_HEADER_VERSION_COMPLETE) == 4,
               "Vulkan 1.4 headers");

int main(void) {
    PFN_vkCreateWaylandSurfaceKHR create = 0;
    VkWaylandSurfaceCreateInfoKHR info = {.sType = VK_STRUCTURE_TYPE_WAYLAND_SURFACE_CREATE_INFO_KHR};
    (void)create;
    if (info.sType != 1000006000) return puts("unexpected VkStructureType"), 1;
    printf("%s %s\n", VK_KHR_WAYLAND_SURFACE_EXTENSION_NAME, VK_EXT_MESH_SHADER_EXTENSION_NAME);
    return 0;
}
