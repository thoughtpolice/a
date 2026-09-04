// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#define _POSIX_C_SOURCE 200809L

#include "fozzie/runtime/target.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int argument_count;
static char** arguments;

int LLVMFuzzerInitialize(int* argc, char*** argv) {
    argument_count = *argc;
    arguments = *argv;
    if (argument_count < 2) {
        _exit(71);
    }
    return 0;
}

static void write_bytes(int fd, const char* bytes, size_t size) {
    while (size != 0) {
        ssize_t amount = write(fd, bytes, size);
        if (amount < 0 && errno == EINTR) {
            continue;
        }
        if (amount <= 0) {
            _exit(71);
        }
        bytes += amount;
        size -= (size_t)amount;
    }
}

static void fixture_path(char* output, size_t size, const char* name) {
    if (argument_count < 3 || snprintf(output, size, "%s/%s", arguments[2], name) >= (int)size) {
        _exit(71);
    }
}

static void log_call(int worker) {
    char path[4096];
    fixture_path(path, sizeof(path), "calls");
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd < 0) {
        _exit(71);
    }
    char line[80];
    int size = snprintf(line, sizeof(line), "%d %ld\n", worker, (long)getpid());
    write_bytes(fd, line, (size_t)size);
    close(fd);
}

static void rendezvous(int worker) {
    char name[80];
    snprintf(name, sizeof(name), "worker-%d.pid", worker);
    char path[4096];
    fixture_path(path, sizeof(path), name);
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        _exit(71);
    }
    int size = snprintf(name, sizeof(name), "%ld\n", (long)getpid());
    write_bytes(fd, name, (size_t)size);
    close(fd);

    // Both callbacks must be active before either can return. Calibration
    // bypasses this barrier, and a fresh verifier sees the existing markers.
    snprintf(name, sizeof(name), "worker-%d.pid", 1 - worker);
    fixture_path(path, sizeof(path), name);
    struct timespec started;
    clock_gettime(CLOCK_MONOTONIC, &started);
    while (access(path, F_OK) != 0) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec - started.tv_sec >= 5) {
            _exit(71);
        }
        struct timespec delay = {.tv_sec = 0, .tv_nsec = 1000000};
        nanosleep(&delay, NULL);
    }
}

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    (void)data;
    (void)size;
    if (strcmp(arguments[1], "stderr") == 0) {
        static unsigned int calls;
        const char* diagnostic = ++calls == 1 ? "prior successful run\n" : "current failed run\n";
        write_bytes(STDERR_FILENO, diagnostic, strlen(diagnostic));
        return calls == 1 ? 0 : 17;
    }
    if (strcmp(arguments[1], "arguments") == 0) {
        const char expected[] = {'-', '\xff', '\'', '\n', '\0'};
        if (argument_count != 4 || strcmp(arguments[2], expected) != 0 || arguments[3][0] != '\0') {
            return 0;
        }
        const char diagnostic[] = "lossless arguments\n";
        write_bytes(STDERR_FILENO, diagnostic, sizeof(diagnostic) - 1);
        return 17;
    }
    if (strcmp(arguments[1], "large-input") == 0) {
        return size == 200000 && data[0] == 'x' && data[size - 1] == 'x' ? 17 : 0;
    }

    const char* mapping = getenv("FOZZIE_SHM_PATH");
    const char* component = mapping == NULL ? NULL : strstr(mapping, "/workers/");
    if (component == NULL) {
        log_call(-1);
        return 0;
    }
    int worker = atoi(component + strlen("/workers/"));
    if (worker < 0 || worker > 1) {
        _exit(71);
    }
    log_call(worker);
    static int first = 1;
    if (first) {
        first = 0;
        rendezvous(worker);
    }
    if (strcmp(arguments[1], "interrupt") == 0) {
        for (;;) {
            pause();
        }
    }
    if (strcmp(arguments[1], "findings") == 0) {
        return 17 + worker;
    }
    if (strcmp(arguments[1], "parallel") != 0) {
        _exit(71);
    }
    return 0;
}
