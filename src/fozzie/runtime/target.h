// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef FOZZIE_RUNTIME_TARGET_H
#define FOZZIE_RUNTIME_TARGET_H

#include <stddef.h>
#include <stdint.h>

#if defined(__cplusplus)
extern "C" {
#endif

#if defined(__GNUC__) || defined(__clang__)
#define FOZZIE_OPTIONAL __attribute__((weak))
#define FOZZIE_EXPORT __attribute__((visibility("default")))
#else
#define FOZZIE_OPTIONAL
#define FOZZIE_EXPORT
#endif

enum fozzie_target_exit {
    FOZZIE_TARGET_EXIT_OK = 0,
    FOZZIE_TARGET_EXIT_CONFIGURATION = 70,
    FOZZIE_TARGET_EXIT_SHARED_MEMORY = 71,
    FOZZIE_TARGET_EXIT_SOCKET = 72,
    FOZZIE_TARGET_EXIT_PROTOCOL = 73,
    FOZZIE_TARGET_EXIT_INSTRUMENTATION = 74,
};

/* The standard libFuzzer-compatible target ABI. */
int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size);

/* Optional; its return value is deliberately ignored, as with libFuzzer. */
FOZZIE_OPTIONAL int LLVMFuzzerInitialize(int* argc, char*** argv);

/* Rust targets can export LLVMFuzzerTestOneInput and call this entry point. */
FOZZIE_EXPORT int fozzie_target_main(int argc, char** argv);

#if defined(__cplusplus)
} /* extern "C" */
#endif

#endif /* FOZZIE_RUNTIME_TARGET_H */
