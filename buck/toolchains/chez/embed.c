// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// embed.c -- register boot files appended to an executable; see
// chez_embed.h, and embed.sls for the layout.
#if defined(_WIN32)
// _wopen and friends are what the C runtime's descriptors, which Chez
// Scheme reads boot files through, are made with; not deprecated here.
#define _CRT_SECURE_NO_WARNINGS
#else
#define _GNU_SOURCE
#endif
#include "scheme.h"

#include "chez_embed.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <io.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

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

// MARK: Files

// What the rest needs of the system: open the executable read-only (as a
// C runtime descriptor, which is what Sregister_boot_file_fd_region takes
// and later closes), its size, and reads at an offset. Offsets are 64-bit
// everywhere.
#if defined(_WIN32)

static wchar_t*
utf8_to_wide(const char* s)
{
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
  if (n <= 0) return NULL;
  wchar_t* w = malloc(n * sizeof(wchar_t));
  if (w && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n) != n) {
    free(w);
    return NULL;
  }
  return w;
}

static int
open_self(const char* path)
{
  wchar_t* wpath = utf8_to_wide(path);
  if (!wpath) return -1;
  // Binary, or the C runtime would translate line endings; not inherited by
  // child processes, as O_CLOEXEC does elsewhere.
  int fd = _wopen(wpath, _O_RDONLY | _O_BINARY | _O_NOINHERIT);
  free(wpath);
  return fd;
}

static int64_t
file_size(int fd)
{
  return _lseeki64(fd, 0, SEEK_END);
}

// The C runtime has no pread: seek, then read. Each descriptor here is this
// file's own until it is registered, so moving its offset is harmless (Chez
// seeks to each region itself before reading it).
static int
pread_full(int fd, void* buf, size_t len, int64_t off)
{
  if (_lseeki64(fd, off, SEEK_SET) != off) return -1;
  size_t done = 0;
  while (done < len) {
    size_t chunk = len - done;
    if (chunk > INT_MAX) chunk = INT_MAX;
    int r = _read(fd, (char*)buf + done, (unsigned int)chunk);
    if (r <= 0) return -1;
    done += (size_t)r;
  }
  return 0;
}

static void
close_self(int fd)
{
  _close(fd);
}

#else

static int
open_self(const char* path)
{
  return open(path, O_RDONLY | O_CLOEXEC);
}

static int64_t
file_size(int fd)
{
  return (int64_t)lseek(fd, 0, SEEK_END);
}

static int
pread_full(int fd, void* buf, size_t len, int64_t off)
{
  size_t done = 0;
  while (done < len) {
    ssize_t r = pread(fd, (char*)buf + done, len - done, (off_t)(off + done));
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    done += r;
  }
  return 0;
}

static void
close_self(int fd)
{
  close(fd);
}

#endif

// MARK: The executable's path

#if defined(_WIN32)

const char*
chez_embed_self_path(const char* argv0)
{
  static char* path;
  (void)argv0;
  if (path) return path;
  // GetModuleFileNameW truncates a path longer than its buffer (and says
  // so), so grow the buffer until it fits: long paths can exceed MAX_PATH.
  DWORD cap = MAX_PATH;
  wchar_t* wpath = NULL;
  for (;;) {
    wchar_t* grown = realloc(wpath, cap * sizeof(wchar_t));
    if (!grown) {
      free(wpath);
      return NULL;
    }
    wpath = grown;
    DWORD len = GetModuleFileNameW(NULL, wpath, cap);
    if (len == 0) {
      free(wpath);
      return NULL;
    }
    if (len < cap) break;
    if (cap >= 32768) {
      free(wpath);
      return NULL;
    }
    cap *= 2;
  }
  int n = WideCharToMultiByte(CP_UTF8, 0, wpath, -1, NULL, 0, NULL, NULL);
  if (n > 0 && (path = malloc(n))) {
    if (WideCharToMultiByte(CP_UTF8, 0, wpath, -1, path, n, NULL, NULL) != n) {
      free(path);
      path = NULL;
    }
  }
  free(wpath);
  return path;
}

#else

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

#endif

// MARK: Registration

int
chez_embed_register(const char* path)
{
  if (!path) return -1;
  int fd = open_self(path);
  if (fd < 0) return -1;

  int64_t size = file_size(fd);
  unsigned char tail[16];
  if (size < 16 || pread_full(fd, tail, 16, size - 16) != 0
      || memcmp(tail + 8, TRAILER_MAGIC, 8) != 0) {
    close_self(fd);
    return -1;
  }

  uint64_t count = get_u64(tail);
  unsigned char index[MAX_BOOTS * ENTRY_LEN];
  if (count == 0 || count > MAX_BOOTS) {
    close_self(fd);
    return -1;
  }
  int64_t index_off = size - 16 - (int64_t)(count * ENTRY_LEN);
  if (index_off < 0 || pread_full(fd, index, count * ENTRY_LEN, index_off) != 0) {
    close_self(fd);
    return -1;
  }

  for (uint64_t i = 0; i < count; i++) {
    const unsigned char* e = index + i * ENTRY_LEN;
    char name[NAME_LEN + 1] = {0};
    memcpy(name, e + 16, NAME_LEN);
    // Each registration takes its own descriptor, with its own file offset,
    // which Chez closes after reading; Sbuild_heap reads the regions later.
    int bfd = (i == 0) ? fd : open_self(path);
    if (bfd < 0) return -1;
    Sregister_boot_file_fd_region(name, bfd, (iptr)get_u64(e), (iptr)get_u64(e + 8), 1);
  }
  return (int)count;
}
