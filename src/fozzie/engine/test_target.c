// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "fozzie/runtime/target.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

static const char* oracle_path = NULL;

int LLVMFuzzerInitialize(int* argc, char*** argv) {
    static const char prefix[] = "--fozzie-resource=oracle=";
    for (int index = 1; index < *argc; ++index) {
        if (strncmp((*argv)[index], prefix, sizeof(prefix) - 1) == 0) {
            oracle_path = (*argv)[index] + sizeof(prefix) - 1;
        }
    }
    return 0;
}

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size == 8 && memcmp(data, "RESOURCE", 8) == 0) {
        if (oracle_path == NULL || oracle_path[0] != '/') {
            return 22;
        }
        FILE* oracle = fopen(oracle_path, "rb");
        if (oracle == NULL) {
            return 23;
        }
        char contents[8] = {0};
        size_t read = fread(contents, 1, sizeof(contents) - 1, oracle);
        fclose(oracle);
        return read == 3 && memcmp(contents, "ok\n", 3) == 0 ? 0 : 21;
    }
    if (size == 7 && memcmp(data, "NONZERO", 7) == 0) {
        static const char diagnostic[] = "fozzie test oracle returned 17\n";
        if (write(STDERR_FILENO, diagnostic, sizeof(diagnostic) - 1) != (ssize_t)(sizeof(diagnostic) - 1)) {
            return 18;
        }
        return 17;
    }
    if (size == 1 && data[0] == 'B') {
        abort();
    }
    if (size == 4 && memcmp(data, "HANG", 4) == 0) {
        for (;;) {
        }
    }
    if (size == 5 && memcmp(data, "EXIT0", 5) == 0) {
        _exit(0);
    }
    if (size == 6 && memcmp(data, "EXIT70", 6) == 0) {
        _exit(70);
    }
    if (size == 9 && memcmp(data, "FORKCRASH", 9) == 0) {
        pid_t child = fork();
        if (child == 0) {
            for (;;) {
                pause();
            }
        }
        if (child < 0) {
            return 2;
        }
        abort();
    }

    volatile uint8_t observation = 0;
    if (size > 3 && data[0] == 'f') {
        observation ^= data[1];
    }
    if (size > 7 && data[2] == data[7]) {
        observation ^= data[2];
    }
    (void)observation;
    return 0;
}
