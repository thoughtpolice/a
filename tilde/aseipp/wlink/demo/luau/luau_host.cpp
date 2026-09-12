// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The console pointed at a cart on disk. The runner is native, so it carries
// the Luau compiler itself: a source file is compiled here and the bytecode is
// mounted for the guest, which never needs a compiler of its own.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "host.h"
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

bool ends_with(const char* text, const char* suffix) {
    size_t length = strlen(text);
    size_t wanted = strlen(suffix);
    return length >= wanted && strcmp(text + length - wanted, suffix) == 0;
}

// Compiled bytecode is mounted as it is; anything else is taken for source
// and compiled first, so an edit is one run away from being played.
bool mount_cart(console_host* host, const char* path) {
    size_t length = 0;
    char* contents = read_file(path, &length);
    if (!contents) {
        fprintf(stderr, "luau: cannot read %s\n", path);
        return false;
    }

    uint8_t* cart = nullptr;
    size_t size = 0;
    if (ends_with(path, ".luauc")) {
        cart = reinterpret_cast<uint8_t*>(contents);
        size = length;
    } else {
        lua_CompileOptions options = {};
        options.optimizationLevel = 2;
        options.debugLevel = 1;
        char* bytecode = luau_compile(contents, length, &options, &size);
        free(contents);
        if (!bytecode || size == 0) {
            fprintf(stderr, "luau: %s produced no bytecode\n", path);
            free(bytecode);
            return false;
        }
        // A leading zero byte means the rest is the message it failed with.
        if (bytecode[0] == 0) {
            fprintf(stderr, "%s:%.*s\n", path, static_cast<int>(size - 1), bytecode + 1);
            free(bytecode);
            return false;
        }
        cart = reinterpret_cast<uint8_t*>(bytecode);
    }

    if (!console_host_mount_readonly(host, "cart.luauc", cart, size)) {
        free(cart);
        return false;
    }
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    // The cart is given as a plain path, so the console reads the way an
    // interpreter does. Everything else stays the runner's own options.
    char** forwarded = argv;
    int count = argc;
    if (argc > 1 && argv[1][0] != '-') {
        forwarded = static_cast<char**>(malloc(sizeof(char*) * static_cast<size_t>(argc + 2)));
        if (!forwarded) return 1;
        forwarded[0] = argv[0];
        forwarded[1] = const_cast<char*>("--cart");
        for (int at = 1; at < argc; ++at) forwarded[at + 1] = argv[at];
        count = argc + 1;
    }

    const console_host_config config = {
        .name = "luau",
        .help = "Plays a Luau cart: luau CART.luau [runner options]",
        .asset_option = "--cart",
        .asset_required = false,
        .mount_asset = mount_cart,
        .frames_per_second = 60,
    };
    return console_host_run(&config, count, forwarded);
}
