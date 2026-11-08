// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Create and destroy an instance through the loader, and check the versions
// it reports. Physical devices are only listed: a machine without a GPU
// driver (such as CI) has none, which is not an error.

#include <stdio.h>
#include <vulkan/vulkan.h>

int main(void) {
    uint32_t version = 0;
    if (vkEnumerateInstanceVersion(&version) != VK_SUCCESS || version < VK_API_VERSION_1_4)
        return fprintf(stderr, "instance version %u.%u\n", VK_API_VERSION_MAJOR(version), VK_API_VERSION_MINOR(version)), 1;

    uint32_t count = 0;
    if (vkEnumerateInstanceExtensionProperties(NULL, &count, NULL) != VK_SUCCESS)
        return fputs("vkEnumerateInstanceExtensionProperties failed\n", stderr), 1;

    const VkApplicationInfo app = {
        .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName = "test-loader",
        .apiVersion = VK_API_VERSION_1_4,
    };
    const VkInstanceCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .pApplicationInfo = &app,
    };
    VkInstance instance;
    VkResult result = vkCreateInstance(&info, NULL, &instance);
    if (result == VK_ERROR_INCOMPATIBLE_DRIVER) {
        printf("no Vulkan driver found; loader %u.%u.%u\n", VK_API_VERSION_MAJOR(version),
               VK_API_VERSION_MINOR(version), VK_API_VERSION_PATCH(version));
        return 0;
    }
    if (result != VK_SUCCESS) return fprintf(stderr, "vkCreateInstance: %d\n", result), 1;

    uint32_t devices = 0;
    vkEnumeratePhysicalDevices(instance, &devices, NULL);
    printf("loader %u.%u.%u, %u instance extensions, %u physical devices\n", VK_API_VERSION_MAJOR(version),
           VK_API_VERSION_MINOR(version), VK_API_VERSION_PATCH(version), count, devices);
    vkDestroyInstance(instance, NULL);
    return 0;
}
