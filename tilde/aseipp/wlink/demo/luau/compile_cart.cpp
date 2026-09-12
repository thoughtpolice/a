// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Compiles a Luau source file to the bytecode a cart ships. The console's
// guest carries the interpreter alone, so this runs at build time, where the
// compiler can use the exceptions it reports errors with.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "luacode.h"

namespace {

char* read_file(const char* path, size_t* length) {
    FILE* file = fopen(path, "rb");
    if (!file) return nullptr;
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    fseek(file, 0, SEEK_SET);
    if (size < 0) {
        fclose(file);
        return nullptr;
    }
    char* text = static_cast<char*>(malloc(static_cast<size_t>(size) + 1));
    if (!text) {
        fclose(file);
        return nullptr;
    }
    size_t read = fread(text, 1, static_cast<size_t>(size), file);
    fclose(file);
    text[read] = '\0';
    *length = read;
    return text;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: compile-cart SOURCE OUTPUT\n");
        return 2;
    }

    size_t length = 0;
    char* source = read_file(argv[1], &length);
    if (!source) {
        fprintf(stderr, "compile-cart: cannot read %s\n", argv[1]);
        return 1;
    }

    lua_CompileOptions options = {};
    // Inlining and the rest: a cart is compiled once, by the build, and the
    // console has no debugger to confuse. Line numbers stay, so a runtime
    // error still names the line it came from.
    options.optimizationLevel = 2;
    options.debugLevel = 1;

    size_t size = 0;
    char* bytecode = luau_compile(source, length, &options, &size);
    free(source);
    if (!bytecode || size == 0) {
        fprintf(stderr, "compile-cart: %s produced no bytecode\n", argv[1]);
        return 1;
    }

    // A leading zero byte means the rest is the message the compiler failed
    // with, which belongs on the build's error output rather than in a cart.
    if (bytecode[0] == 0) {
        fprintf(stderr, "%s:%.*s\n", argv[1], static_cast<int>(size - 1), bytecode + 1);
        free(bytecode);
        return 1;
    }

    FILE* out = fopen(argv[2], "wb");
    if (!out) {
        fprintf(stderr, "compile-cart: cannot write %s\n", argv[2]);
        free(bytecode);
        return 1;
    }
    size_t written = fwrite(bytecode, 1, size, out);
    int closed = fclose(out);
    free(bytecode);
    if (written != size || closed != 0) {
        fprintf(stderr, "compile-cart: short write to %s\n", argv[2]);
        return 1;
    }
    return 0;
}
