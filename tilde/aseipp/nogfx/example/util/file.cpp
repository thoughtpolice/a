#include <util/file.hpp>

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

using namespace gpu;

Span<byte> read_shader(const char* path) noexcept
{
    FILE* file = fopen(path, "rb");
    assert(file);
    fseek(file, 0, SEEK_END);
    const size_t byte_count = size_t(ftell(file));
    rewind(file);
    Span<byte> code(static_cast<byte*>(malloc(byte_count)), byte_count);
    fread(code.data, 1, code.size, file);
    fclose(file);
    return code;
}

void read_binary_file(const char* path, Span<byte> data) noexcept
{
    FILE* file = fopen(path, "rb");
    assert(file);
    fread(data.data, 1, data.size, file);
    fclose(file);
}
