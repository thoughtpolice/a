// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// chez_embed.h -- boot Chez Scheme from boot files appended to the program.
//
// chez.standalone (defs.bzl) appends boot files to a kernel executable; see
// embed.sls for the layout. A kernel boots with
//
//   Sscheme_init(NULL);
//   if (chez_embed_register(chez_embed_self_path(argv[0])) < 0) ... no boots
//   Sbuild_heap(argv[0], NULL);
#ifndef CHEZ_EMBED_H
#define CHEZ_EMBED_H

#ifdef __cplusplus
extern "C" {
#endif

// The path of the running executable (from /proc/self/exe on Linux,
// _NSGetExecutablePath on macOS, GetModuleFileNameW on Windows, else argv0
// resolved), or NULL. It is UTF-8 on Windows. The string is static.
const char* chez_embed_self_path(const char* argv0);

// Register, in order, the boot files appended to the executable at path
// (UTF-8 on Windows).
// Returns how many, or -1 if it has none (or they are unreadable).
int chez_embed_register(const char* path);

#ifdef __cplusplus
}
#endif

#endif
