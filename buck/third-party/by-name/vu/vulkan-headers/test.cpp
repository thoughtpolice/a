// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Vulkan-Hpp compiles against the C headers it ships with; vulkan.hpp itself
// static_asserts that their VK_HEADER_VERSION is its own.

#define VULKAN_HPP_NO_EXCEPTIONS
#define VULKAN_HPP_DISPATCH_LOADER_DYNAMIC 1
#include <vulkan/vulkan.hpp>

#include <cstdio>

int main() {
    vk::ApplicationInfo app{"test", 1, "test", 1, vk::ApiVersion14};
    if (app.apiVersion != VK_API_VERSION_1_4) return std::puts("wrong API version"), 1;
    std::printf("%s\n", vk::to_string(vk::Format::eB8G8R8A8Srgb).c_str());
    return 0;
}
