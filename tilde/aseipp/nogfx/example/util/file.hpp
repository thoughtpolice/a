#pragma once

#include <nogfx/nogfx.hpp>

// Free the returned buffer after creating the PSO that uses it.
gpu::Span<byte> read_shader(const char* path) noexcept;
void read_binary_file(const char* path, gpu::Span<byte> data) noexcept;
