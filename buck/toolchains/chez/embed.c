// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// embed.c -- register boot files appended to an executable; see
// chez_embed.h, and embed.sls for the layout.
#define _GNU_SOURCE
#include "scheme.h"

#include "chez_embed.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

#define TRAILER_MAGIC "CHEZBOOT"
#define NAME_LEN 16
#define ENTRY_LEN (8 + 8 + NAME_LEN)
#define MAX_BOOTS 32

static uint64_t
get_u64(const unsigned char* p)
{
  uint64_t v = 0;
  for (int i = 7; i >= 0; i--) v = (v << 8) | p[i];
  return v;
}

static int
pread_full(int fd, void* buf, size_t len, off_t off)
{
  size_t done = 0;
  while (done < len) {
    ssize_t r = pread(fd, (char*)buf + done, len - done, off + done);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    done += r;
  }
  return 0;
}

const char*
chez_embed_self_path(const char* argv0)
{
  static char path[PATH_MAX];
#if defined(__linux__)
  ssize_t len = readlink("/proc/self/exe", path, sizeof(path) - 1);
  if (len > 0) {
    path[len] = '\0';
    return path;
  }
#elif defined(__APPLE__)
  // The path the executable was started by, which may be relative, or a
  // symlink's: resolved, as /proc/self/exe is.
  char started[PATH_MAX];
  uint32_t size = sizeof(started);
  if (_NSGetExecutablePath(started, &size) == 0 && realpath(started, path)) return path;
#endif
  if (argv0 && realpath(argv0, path)) return path;
  return NULL;
}

int
chez_embed_register(const char* path)
{
  if (!path) return -1;
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;

  off_t size = lseek(fd, 0, SEEK_END);
  unsigned char tail[16];
  if (size < 16 || pread_full(fd, tail, 16, size - 16) != 0
      || memcmp(tail + 8, TRAILER_MAGIC, 8) != 0) {
    close(fd);
    return -1;
  }

  uint64_t count = get_u64(tail);
  unsigned char index[MAX_BOOTS * ENTRY_LEN];
  off_t index_off = size - 16 - (off_t)(count * ENTRY_LEN);
  if (count == 0 || count > MAX_BOOTS || index_off < 0
      || pread_full(fd, index, count * ENTRY_LEN, index_off) != 0) {
    close(fd);
    return -1;
  }

  for (uint64_t i = 0; i < count; i++) {
    const unsigned char* e = index + i * ENTRY_LEN;
    char name[NAME_LEN + 1] = {0};
    memcpy(name, e + 16, NAME_LEN);
    // Each registration takes its own descriptor, with its own file offset,
    // which Chez closes after reading; Sbuild_heap reads the regions later.
    int bfd = (i == 0) ? fd : open(path, O_RDONLY | O_CLOEXEC);
    if (bfd < 0) return -1;
    Sregister_boot_file_fd_region(name, bfd, (iptr)get_u64(e), (iptr)get_u64(e + 8), 1);
  }
  return (int)count;
}
