// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared native runner for linked console components. The application supplies
// its identity and optional assets; all guest code runs through wasm2c.
#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "console.h"
#include "hal-host.h"
#include "host.h"
#include "platform.h"
#include "terminal.h"
#include "wasm-rt-exceptions.h"
#include "wasm-rt-impl.h"

enum { MAX_HANDLES = 128, MAX_EVENTS = 256, MAX_RAM_FILE = 64 * 1024 * 1024, MAX_NAME = 256 };
// The audio queue holds a second of 44100 Hz stereo frames.
enum { AUDIO_RATE = 44100, AUDIO_CHANNELS = 2, AUDIO_CAPACITY = AUDIO_RATE };
// An entry of the virtual root: a file or a directory. Names are unique; a
// file removed while open keeps its slot, invisible, until its last handle
// closes, and a free slot has an empty name.
typedef struct {
  char name[MAX_NAME];
  uint8_t *data;
  size_t size;
  bool readonly, directory, removed, dirty;
  unsigned open_count;
} file;
typedef struct { size_t file; bool used, writable; } handle;
enum { SCRIPT_KEY, SCRIPT_MOUSE, SCRIPT_TEXT };
typedef struct {
  uint64_t frame;
  int kind;
  console_key_event key;
  int32_t x, y, wheel;
  uint32_t buttons;
  char *text;
} script_event;

// This scalar WIT record has the same layout on the host and wasm32. Native
// generated string/list structs contain host pointers and cannot be copied
// into guest memory; those descriptors still use explicit little-endian stores.
_Static_assert(sizeof(console_hal_raw_key_event_t) == 8 &&
               _Alignof(console_hal_raw_key_event_t) == 4 &&
               offsetof(console_hal_raw_key_event_t, key) == 0 &&
               offsetof(console_hal_raw_key_event_t, pressed) == 4 && sizeof(bool) == 1,
               "native HAL key-event layout must match the canonical WIT ABI");

struct console_hal_context {
  console_host *host;
};

struct console_host {
  struct console_hal_context hal;
  unsigned frames_per_second;
  w2c_linked *linked;
  terminal *terminal;
  bool headless, trace, exit_requested, present_every_frame;
  int exit_code, trap;
  uint64_t now_ms, frames, presentations;
  uint32_t width, height;
  uint8_t *pixels;
  size_t pixels_size;
  file *files;
  size_t file_count, file_capacity;
  handle handles[MAX_HANDLES];
  // Writable entries are mirrored below this host directory when it is set.
  char *save_dir;
  char save_error[512];
  // Queued frames play at the fixed rate, a frame period's worth per frame,
  // into the hash, the WAV dump, and the sink process when there is one.
  int16_t audio[AUDIO_CAPACITY * AUDIO_CHANNELS];
  size_t audio_start, audio_count;
  uint64_t audio_hash, audio_played, audio_head, audio_dropped;
  FILE *wav;
  uint64_t wav_frames;
  int sink;
  pid_t sink_pid;
  bool no_audio;
  // What a headless run reports for the wall clock and entropy.
  int64_t unix_time;
  uint64_t seed;
  console_key_event events[MAX_EVENTS];
  size_t event_count;
  // The pointer as the game reads it: motion and wheel notches accumulate
  // until read-mouse, and the recording sees what changed each frame.
  int32_t mouse_x, mouse_y, mouse_dx, mouse_dy, mouse_wheel, frame_wheel;
  uint32_t mouse_buttons;
  bool mouse_seen, mouse_changed;
  char text[4096];
  size_t text_length, frame_text;
  script_event *script;
  size_t script_count, script_next;
  FILE *record;
  int argc;
  char **argv;
  char log[65536];
  size_t log_size;
};
typedef console_host host_t;

static uint8_t *range(wasm_rt_memory_t *memory, u32 ptr, u32 len) {
  if ((uint64_t)ptr + len > memory->size) wasm_rt_trap(WASM_RT_TRAP_OOB);
  return memory->data + ptr;
}

static void store32(wasm_rt_memory_t *memory, u32 ptr, u32 value) {
  uint8_t *p = range(memory, ptr, 4);
  for (unsigned i = 0; i < 4; ++i) p[i] = (uint8_t)(value >> (8 * i));
}

static void store64(wasm_rt_memory_t *memory, u32 ptr, u64 value) {
  uint8_t *p = range(memory, ptr, 8);
  for (unsigned i = 0; i < 8; ++i) p[i] = (uint8_t)(value >> (8 * i));
}

static void *checked_realloc(void *old, size_t size) {
  void *p = realloc(old, size ? size : 1);
  if (!p) wasm_rt_trap(WASM_RT_TRAP_EXHAUSTION);
  return p;
}

static uint64_t monotonic_ns(void);

void console_hal_write_log(console_hal_t *instance, u32 level, u32 ptr, u32 len) {
  host_t *host = instance->host;
  const char *message = (const char *)range(console_hal_write_log_memory(host->linked), ptr, len);
  if (host->headless) {
    printf("log %u: %.*s\n", level, (int)len, message);
  } else {
    // Keep diagnostics out of the alternate screen; retain the most recent
    // messages to print after restoring the terminal if the guest fails.
    size_t n = len < sizeof(host->log) - 1 ? len : sizeof(host->log) - 1;
    if (host->log_size + n + 1 > sizeof(host->log)) {
      size_t drop = host->log_size + n + 1 - sizeof(host->log);
      memmove(host->log, host->log + drop, host->log_size - drop);
      host->log_size -= drop;
    }
    memcpy(host->log + host->log_size, message, n);
    host->log_size += n;
    host->log[host->log_size++] = '\n';
  }
}

void console_hal_present(console_hal_t *instance, u32 width, u32 height, u32 ptr, u32 len) {
  host_t *host = instance->host;
  if (!width || !height || (uint64_t)width * height * 4 != len)
    wasm_rt_trap(WASM_RT_TRAP_OOB);
  const uint8_t *pixels = range(console_hal_present_memory(host->linked), ptr, len);
  host->pixels = checked_realloc(host->pixels, len);
  memcpy(host->pixels, pixels, len);
  host->pixels_size = len;
  host->width = width;
  host->height = height;
  host->presentations++;
}

void console_hal_present_indexed(console_hal_t *instance, u32 width, u32 height, u32 ptr, u32 len,
                                 u32 palette_ptr, u32 palette_len) {
  host_t *host = instance->host;
  if (!width || !height || (uint64_t)width * height != len || palette_len != 256)
    wasm_rt_trap(WASM_RT_TRAP_OOB);
  wasm_rt_memory_t *memory = console_hal_present_indexed_memory(host->linked);
  const uint8_t *pixels = range(memory, ptr, len);
  const uint8_t *palette = range(memory, palette_ptr, palette_len * 4);
  host->pixels = checked_realloc(host->pixels, (size_t)len * 4);
  for (size_t i = 0; i < len; ++i) memcpy(host->pixels + 4 * i, palette + 4 * pixels[i], 4);
  host->pixels_size = (size_t)len * 4;
  host->width = width;
  host->height = height;
  host->presentations++;
}

u32 console_hal_frames_per_second(console_hal_t *instance) {
  return instance->host->frames_per_second;
}

u32 console_hal_set_frame_rate(console_hal_t *instance, u32 hz) {
  host_t *host = instance->host;
  if (host->frames == 0 && hz >= 1 && hz <= 1000) host->frames_per_second = hz;
  return host->frames_per_second;
}

u64 console_hal_unix_seconds(console_hal_t *instance) {
  host_t *host = instance->host;
  return host->headless ? (u64)host->unix_time : (u64)time(NULL);
}

u64 console_hal_random_seed(console_hal_t *instance) {
  host_t *host = instance->host;
  if (host->headless) return host->seed;
  uint64_t seed;
  if (getentropy(&seed, sizeof(seed)) != 0) seed = (uint64_t)monotonic_ns();
  return seed;
}

void console_hal_host_name(console_hal_t *instance, u32 result) {
  host_t *host = instance->host;
  const char *name = host->headless ? "headless" : "terminal";
  u32 len = (u32)strlen(name);
  u32 ptr = console_hal_host_name_realloc(host->linked, 0, 0, 1, len);
  wasm_rt_memory_t *memory = console_hal_host_name_memory(host->linked);
  memcpy(range(memory, ptr, len), name, len);
  store32(memory, result, ptr);
  store32(memory, result + 4, len);
}

u32 console_hal_host_features(console_hal_t *instance) {
  return instance->host->save_dir ? CONSOLE_SDK_SYSTEM_FEATURES_PERSISTENT_STORAGE : 0;
}

void console_hal_set_title(console_hal_t *instance, u32 ptr, u32 len) {
  host_t *host = instance->host;
  const char *title = (const char *)range(console_hal_set_title_memory(host->linked), ptr, len);
  if (host->terminal) terminal_set_title(host->terminal, title, len);
}

void console_hal_read_events(console_hal_t *instance, u32 result) {
  host_t *host = instance->host;
  u32 count = (u32)host->event_count;
  const u32 stride = sizeof(console_hal_raw_key_event_t);
  // Empty returned lists still need an aligned dangling pointer for the
  // generated Rust binding's Vec::from_raw_parts ownership conversion.
  u32 ptr = count ? console_hal_read_events_realloc(
      host->linked, 0, 0, _Alignof(console_hal_raw_key_event_t), count * stride) :
      _Alignof(console_hal_raw_key_event_t);
  wasm_rt_memory_t *memory = console_hal_read_events_memory(host->linked);
  if (count) memset(range(memory, ptr, count * stride), 0, count * stride);
  for (u32 i = 0; i < count; ++i) {
    u32 event = ptr + stride * i;
    store32(memory, event + offsetof(console_hal_raw_key_event_t, key), host->events[i].key);
    *range(memory, event + offsetof(console_hal_raw_key_event_t, pressed), sizeof(bool)) =
        host->events[i].pressed ? 1 : 0;
  }
  store32(memory, result, ptr);
  store32(memory, result + 4, count);
  host->event_count = 0;
}

u32 console_hal_input_capabilities(console_hal_t *instance) {
  host_t *host = instance->host;
  bool releases = host->headless || terminal_key_releases(host->terminal);
  return (releases ? CONSOLE_SDK_INPUT_CAPABILITY_KEY_RELEASES : 0) |
         CONSOLE_SDK_INPUT_CAPABILITY_TEXT | CONSOLE_SDK_INPUT_CAPABILITY_MOUSE;
}

void console_hal_read_mouse(console_hal_t *instance, u32 result) {
  host_t *host = instance->host;
  wasm_rt_memory_t *memory = console_hal_read_mouse_memory(host->linked);
  const int32_t fields[] = {host->mouse_x, host->mouse_y, host->mouse_dx, host->mouse_dy,
                            (int32_t)host->mouse_buttons, host->mouse_wheel};
  for (unsigned i = 0; i < 6; ++i) store32(memory, result + 4 * i, (u32)fields[i]);
  host->mouse_dx = host->mouse_dy = host->mouse_wheel = 0;
}

u32 console_hal_capture_pointer(console_hal_t *instance, u32 captured) {
  (void)instance; (void)captured;
  return 0;
}

void console_hal_read_text(console_hal_t *instance, u32 result) {
  host_t *host = instance->host;
  u32 len = (u32)host->text_length;
  u32 ptr = len ? console_hal_read_text_realloc(host->linked, 0, 0, 1, len) : 1;
  wasm_rt_memory_t *memory = console_hal_read_text_memory(host->linked);
  if (len) memcpy(range(memory, ptr, len), host->text, len);
  store32(memory, result, ptr);
  store32(memory, result + 4, len);
  host->text_length = 0;
}

u64 console_hal_now_ms(console_hal_t *instance) {
  return instance->host->now_ms;
}

u32 console_hal_audio_write(console_hal_t *instance, u32 ptr, u32 len) {
  host_t *host = instance->host;
  const uint8_t *bytes = range(console_hal_audio_write_memory(host->linked), ptr, len * 2);
  size_t frames = len / AUDIO_CHANNELS, room = AUDIO_CAPACITY - host->audio_count;
  if (frames > room) frames = room;
  for (size_t i = 0; i < frames * AUDIO_CHANNELS; ++i) {
    size_t at = ((host->audio_start + host->audio_count) * AUDIO_CHANNELS + i) % (AUDIO_CAPACITY * AUDIO_CHANNELS);
    host->audio[at] = (int16_t)(bytes[2 * i] | bytes[2 * i + 1] << 8);
  }
  host->audio_count += frames;
  return (u32)frames;
}

u32 console_hal_audio_queued(console_hal_t *instance) {
  return (u32)instance->host->audio_count;
}

// Paths live in a virtual root: slash-separated names whose segments are
// never empty, ".", or "..". They never select arbitrary host files.
static bool file_name(const char *p, size_t len, char name[MAX_NAME]) {
  while (len >= 2 && p[0] == '.' && p[1] == '/') { p += 2; len -= 2; }
  if (!len || len >= MAX_NAME || memchr(p, 0, len) || memchr(p, '\\', len)) return false;
  size_t start = 0;
  for (size_t i = 0; i <= len; ++i) {
    if (i < len && p[i] != '/') continue;
    size_t segment = i - start;
    if (!segment || (segment == 1 && p[start] == '.') ||
        (segment == 2 && p[start] == '.' && p[start + 1] == '.')) return false;
    start = i + 1;
  }
  memcpy(name, p, len);
  name[len] = 0;
  return true;
}

// A directory is named like a file, except that the root is the empty path
// or ".", named by the empty string.
static bool directory_name(const char *p, size_t len, char name[MAX_NAME]) {
  while (len >= 2 && p[0] == '.' && p[1] == '/') { p += 2; len -= 2; }
  if (!len || (len == 1 && p[0] == '.')) { name[0] = 0; return true; }
  return file_name(p, len, name);
}

static bool is_root(const char *name) {
  return !name[0];
}

static file *find(host_t *host, const char *name) {
  for (size_t i = 0; i < host->file_count; ++i) {
    file *f = &host->files[i];
    if (f->name[0] && !f->removed && !strcmp(f->name, name)) return f;
  }
  return NULL;
}

// Adds an entry, reusing a free slot; NULL when memory runs out. Growing the
// array moves every entry, so callers keep indexes, not pointers, across it.
static file *add(host_t *host, const char *name, bool directory) {
  file *f = NULL;
  for (size_t i = 0; i < host->file_count && !f; ++i)
    if (!host->files[i].name[0]) f = &host->files[i];
  if (!f) {
    if (host->file_count == host->file_capacity) {
      size_t capacity = host->file_capacity ? 2 * host->file_capacity : 64;
      file *files = realloc(host->files, capacity * sizeof(*files));
      if (!files) return NULL;
      host->files = files;
      host->file_capacity = capacity;
    }
    f = &host->files[host->file_count++];
  }
  *f = (file){.directory = directory};
  strcpy(f->name, name);
  return f;
}

static void release(file *f) {
  free(f->data);
  *f = (file){0};
}

static char *disk_path(const host_t *host, const char *name) {
  size_t base = strlen(host->save_dir);
  char *path = malloc(base + strlen(name) + 2);
  if (!path) return NULL;
  strcpy(path, host->save_dir);
  if (name[0]) {
    path[base] = '/';
    strcpy(path + base + 1, name);
  }
  return path;
}

// The first failure to mirror a change on disk is reported after the run.
static void save_failed(host_t *host, const char *what, const char *path) {
  if (!host->save_error[0])
    snprintf(host->save_error, sizeof(host->save_error), "%s %s: %s", what, path, strerror(errno));
}

static bool make_directory(const char *path) {
  return !mkdir(path, 0777) || errno == EEXIST;
}

// Creates the directories of a disk path below the save directory.
static bool make_parents(host_t *host, char *path) {
  for (char *slash = path + strlen(host->save_dir) + 1; (slash = strchr(slash, '/')); ++slash) {
    *slash = 0;
    bool ok = make_directory(path);
    *slash = '/';
    if (!ok) return false;
  }
  return true;
}

static file *add_directory(host_t *host, const char *name) {
  file *f = add(host, name, true);
  if (f && host->save_dir) {
    char *path = disk_path(host, name);
    if (!path || !make_parents(host, path) || !make_directory(path)) save_failed(host, "creating", path ? path : name);
    free(path);
  }
  return f;
}

// Every directory on a name's path exists, created as needed; a file in the
// way fails.
static bool ensure_parents(host_t *host, const char *name) {
  char parent[MAX_NAME];
  for (const char *slash = strchr(name, '/'); slash; slash = strchr(slash + 1, '/')) {
    size_t len = (size_t)(slash - name);
    memcpy(parent, name, len);
    parent[len] = 0;
    file *f = find(host, parent);
    if (f ? !f->directory : !add_directory(host, parent)) return false;
  }
  return true;
}

static bool child_of(const file *f, const char *dir) {
  if (!f->name[0] || f->removed) return false;
  size_t len = strlen(dir);
  if (len) {
    if (strncmp(f->name, dir, len) || f->name[len] != '/') return false;
    len++;
  }
  return !strchr(f->name + len, '/');
}

static bool has_children(const host_t *host, const char *dir) {
  for (size_t i = 0; i < host->file_count; ++i)
    if (child_of(&host->files[i], dir)) return true;
  return false;
}

static int by_name(const void *a, const void *b) {
  return strcmp((*(file *const *)a)->name, (*(file *const *)b)->name);
}

static size_t children(host_t *host, const char *dir, file ***out) {
  size_t count = 0;
  for (size_t i = 0; i < host->file_count; ++i) count += child_of(&host->files[i], dir);
  file **list = count ? checked_realloc(NULL, count * sizeof(*list)) : NULL;
  count = 0;
  for (size_t i = 0; i < host->file_count; ++i)
    if (child_of(&host->files[i], dir)) list[count++] = &host->files[i];
  qsort(list, count, sizeof(*list), by_name);
  *out = list;
  return count;
}

// Writes a file's contents to its place in the save directory, through a
// temporary so a failure leaves the previous copy.
static void flush(host_t *host, file *f) {
  if (!host->save_dir || f->directory || f->removed || !f->dirty) return;
  f->dirty = false;
  char *path = disk_path(host, f->name), *temp = disk_path(host, ".flush.tmp");
  if (path && temp) {
    FILE *out = make_parents(host, path) ? fopen(temp, "wb") : NULL;
    bool ok = out && (!f->size || fwrite(f->data, 1, f->size, out) == f->size);
    if (out && fclose(out)) ok = false;
    if (ok && rename(temp, path)) ok = false;
    if (!ok) { save_failed(host, "writing", path); unlink(temp); }
  }
  free(path);
  free(temp);
}

static void flush_all(host_t *host) {
  for (size_t i = 0; i < host->file_count; ++i)
    if (host->files[i].name[0]) flush(host, &host->files[i]);
}

static void disk_remove(host_t *host, const file *f) {
  if (!host->save_dir) return;
  char *path = disk_path(host, f->name);
  if (path && (f->directory ? rmdir(path) : unlink(path)) && errno != ENOENT)
    save_failed(host, "removing", path);
  free(path);
}

static void disk_rename(host_t *host, const char *from, const char *to) {
  if (!host->save_dir) return;
  char *source = disk_path(host, from), *target = disk_path(host, to);
  if (source && target && (!make_parents(host, target) || rename(source, target)) && errno != ENOENT)
    save_failed(host, "renaming", source);
  free(source);
  free(target);
}

// POSIX arguments can contain arbitrary bytes, while WIT strings are UTF-8.
// Preserve the platform's original policy of replacing invalid strings with
// an empty string before generated Rust bindings take ownership of them.
static bool valid_utf8(const unsigned char *s, size_t len) {
  for (size_t i = 0; i < len;) {
    unsigned byte = s[i++], value, minimum, extra;
    if (byte < 0x80) continue;
    if (byte >= 0xc2 && byte <= 0xdf) {
      value = byte & 0x1f; minimum = 0x80; extra = 1;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      value = byte & 0x0f; minimum = 0x800; extra = 2;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      value = byte & 7; minimum = 0x10000; extra = 3;
    } else return false;
    if (extra > len - i) return false;
    while (extra--) {
      byte = s[i++];
      if ((byte & 0xc0) != 0x80) return false;
      value = (value << 6) | (byte & 0x3f);
    }
    if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff))
      return false;
  }
  return true;
}

static bool read_disk_file(const char *path, uint8_t **data, size_t *size) {
  FILE *in = fopen(path, "rb");
  if (!in) return false;
  bool ok = !fseek(in, 0, SEEK_END);
  long length = ok ? ftell(in) : -1;
  ok = ok && length >= 0 && length <= MAX_RAM_FILE && !fseek(in, 0, SEEK_SET);
  uint8_t *buffer = ok && length ? malloc((size_t)length) : NULL;
  ok = ok && (!length || (buffer && fread(buffer, 1, (size_t)length, in) == (size_t)length));
  fclose(in);
  if (!ok) { free(buffer); return false; }
  *data = buffer;
  *size = (size_t)length;
  return true;
}

// Loads the save directory into the virtual root, below any mounted assets:
// files become writable entries, directories become directories, and what
// cannot be represented is reported and skipped.
static void load_directory(host_t *host, const char *prefix) {
  char *path = disk_path(host, prefix);
  DIR *dir = path ? opendir(path) : NULL;
  if (!dir) { if (path) perror(path); free(path); return; }
  free(path);
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    const char *base = entry->d_name;
    if (!strcmp(base, ".") || !strcmp(base, "..") || (!prefix[0] && !strcmp(base, ".flush.tmp"))) continue;
    char name[MAX_NAME], joined[2 * MAX_NAME];
    int len = snprintf(joined, sizeof(joined), prefix[0] ? "%s/%s" : "%s%s", prefix, base);
    if (len < 0 || (size_t)len >= sizeof(joined) || !file_name(joined, (size_t)len, name) ||
        !valid_utf8((const unsigned char *)name, strlen(name))) {
      fprintf(stderr, "%s/%s: not a usable name, skipped\n", host->save_dir, joined);
      continue;
    }
    char *full = disk_path(host, name);
    struct stat st;
    if (!full || stat(full, &st)) { free(full); continue; }
    file *existing = find(host, name);
    if (S_ISDIR(st.st_mode)) {
      if (existing ? existing->directory : add(host, name, true) != NULL) load_directory(host, name);
      else fprintf(stderr, "%s: a mounted asset is in the way, skipped\n", full);
    } else if (S_ISREG(st.st_mode)) {
      uint8_t *data = NULL;
      size_t size = 0;
      if (existing) fprintf(stderr, "%s: a mounted asset is in the way, skipped\n", full);
      else if (!read_disk_file(full, &data, &size)) fprintf(stderr, "%s: unreadable or too large, skipped\n", full);
      else {
        file *f = add(host, name, false);
        if (f) { f->data = data; f->size = size; }
        else free(data);
      }
    }
    free(full);
  }
  closedir(dir);
}

bool console_host_mount_readonly(console_host *host, const char *path,
                                 uint8_t *data, size_t size) {
  char name[MAX_NAME];
  if (!host || !path || (!data && size) || !file_name(path, strlen(path), name) ||
      find(host, name) || !ensure_parents(host, name)) return false;
  file *f = add(host, name, false);
  if (!f) return false;
  f->data = data;
  f->size = size;
  f->readonly = true;
  return true;
}

static file *handle_file(host_t *host, u32 fd) {
  return fd < MAX_HANDLES && host->handles[fd].used ? &host->files[host->handles[fd].file] : NULL;
}

u32 console_hal_file_open(console_hal_t *instance, u32 ptr, u32 len, u32 write) {
  host_t *host = instance->host;
  char name[MAX_NAME];
  if (!file_name((const char *)range(console_hal_file_open_memory(host->linked), ptr, len), len, name)) return (u32)-1;
  size_t fd;
  for (fd = 0; fd < MAX_HANDLES && host->handles[fd].used; ++fd) {}
  if (fd == MAX_HANDLES) return (u32)-1;
  file *f = find(host, name);
  if (!f && write && ensure_parents(host, name)) f = add(host, name, false);
  if (!f || f->directory || (write && f->readonly)) return (u32)-1;
  if (write) {
    free(f->data);
    f->data = NULL;
    f->size = 0;
    f->dirty = true;
  }
  f->open_count++;
  host->handles[fd] = (handle){(size_t)(f - host->files), true, write != 0};
  return (u32)fd;
}

u64 console_hal_file_size(console_hal_t *instance, u32 fd) {
  file *f = handle_file(instance->host, fd);
  return f ? f->size : (u64)-1;
}

void console_hal_file_read_at(console_hal_t *instance, u32 fd, u64 offset, u32 length, u32 result) {
  host_t *host = instance->host;
  file *f = handle_file(host, fd);
  u32 size = f && offset < f->size ? (u32)((f->size - offset < length) ? f->size - offset : length) : 0;
  u32 ptr = size ? console_hal_file_read_at_realloc(host->linked, 0, 0, 1, size) : 1;
  wasm_rt_memory_t *memory = console_hal_file_read_at_memory(host->linked);
  if (size) memcpy(range(memory, ptr, size), f->data + (size_t)offset, size);
  store32(memory, result, f ? 0 : (u32)-1);
  store32(memory, result + 4, ptr);
  store32(memory, result + 8, size);
}

u32 console_hal_file_write_at(console_hal_t *instance, u32 fd, u64 offset, u32 ptr, u32 len) {
  host_t *host = instance->host;
  file *f = handle_file(host, fd);
  if (!f || !host->handles[fd].writable || offset > MAX_RAM_FILE || len > MAX_RAM_FILE - offset)
    return (u32)-1;
  const uint8_t *data = range(console_hal_file_write_at_memory(host->linked), ptr, len);
  if (len && offset + len > f->size) {
    f->data = checked_realloc(f->data, (size_t)offset + len);
    memset(f->data + f->size, 0, (size_t)offset + len - f->size);
    f->size = (size_t)offset + len;
  }
  if (len) memcpy(f->data + (size_t)offset, data, len);
  f->dirty = true;
  return len;
}

void console_hal_file_close(console_hal_t *instance, u32 fd) {
  host_t *host = instance->host;
  file *f = handle_file(host, fd);
  if (!f) return;
  bool writable = host->handles[fd].writable;
  host->handles[fd] = (handle){0};
  f->open_count--;
  if (writable) flush(host, f);
  if (f->removed && !f->open_count) release(f);
}

void console_hal_file_list_directory(console_hal_t *instance, u32 ptr, u32 len, u32 result) {
  host_t *host = instance->host;
  wasm_rt_memory_t *memory = console_hal_file_list_directory_memory(host->linked);
  char name[MAX_NAME];
  file **entries = NULL;
  size_t count = 0;
  bool found = directory_name((const char *)range(memory, ptr, len), len, name);
  if (found && !is_root(name)) {
    file *f = find(host, name);
    found = f && f->directory;
  }
  if (found) count = children(host, name, &entries);
  // The entry record is a string, a u64, and a bool: 24 bytes, 8-aligned.
  const u32 stride = 24, align = 8;
  u32 list = count ? console_hal_file_list_directory_realloc(host->linked, 0, 0, align, (u32)(count * stride)) : align;
  if (count) memset(range(memory, list, (u32)(count * stride)), 0, count * stride);
  size_t skip = is_root(name) ? 0 : strlen(name) + 1;
  for (size_t i = 0; i < count; ++i) {
    const char *child = entries[i]->name + skip;
    u32 child_len = (u32)strlen(child);
    u32 text = child_len ? console_hal_file_list_directory_realloc(host->linked, 0, 0, 1, child_len) : 1;
    if (child_len) memcpy(range(memory, text, child_len), child, child_len);
    u32 entry = list + (u32)(i * stride);
    store32(memory, entry, text);
    store32(memory, entry + 4, child_len);
    store64(memory, entry + 8, entries[i]->directory ? 0 : entries[i]->size);
    *range(memory, entry + 16, 1) = entries[i]->directory;
  }
  free(entries);
  store32(memory, result, found ? 0 : (u32)-1);
  store32(memory, result + 4, list);
  store32(memory, result + 8, (u32)count);
}

u32 console_hal_file_remove(console_hal_t *instance, u32 ptr, u32 len) {
  host_t *host = instance->host;
  char name[MAX_NAME];
  if (!file_name((const char *)range(console_hal_file_remove_memory(host->linked), ptr, len), len, name)) return (u32)-1;
  file *f = find(host, name);
  if (!f || f->readonly || (f->directory && has_children(host, name))) return (u32)-1;
  disk_remove(host, f);
  if (f->open_count) f->removed = true;
  else release(f);
  return 0;
}

u32 console_hal_file_rename(console_hal_t *instance, u32 ptr, u32 len, u32 to_ptr, u32 to_len) {
  host_t *host = instance->host;
  wasm_rt_memory_t *memory = console_hal_file_rename_memory(host->linked);
  char from[MAX_NAME], to[MAX_NAME], prefix[MAX_NAME + 1];
  if (!file_name((const char *)range(memory, ptr, len), len, from) ||
      !file_name((const char *)range(memory, to_ptr, to_len), to_len, to)) return (u32)-1;
  file *f = find(host, from);
  if (!f || f->readonly) return (u32)-1;
  if (!strcmp(from, to)) return 0;
  bool directory = f->directory;
  size_t from_len = strlen(from);
  sprintf(prefix, "%s/", from);
  if (directory) {
    // The new name may not lie inside the old one, and every entry below
    // must still fit.
    if (!strncmp(to, prefix, from_len + 1)) return (u32)-1;
    for (size_t i = 0; i < host->file_count; ++i) {
      const file *below = &host->files[i];
      if (below->name[0] && !strncmp(below->name, prefix, from_len + 1) &&
          strlen(below->name) - from_len + strlen(to) >= MAX_NAME) return (u32)-1;
    }
  }
  file *target = find(host, to);
  if (target && (target->directory || target->readonly || directory)) return (u32)-1;
  if (!ensure_parents(host, to)) return (u32)-1;
  // Adding parents may have moved the entries.
  f = find(host, from);
  target = find(host, to);
  if (target) {
    disk_remove(host, target);
    if (target->open_count) target->removed = true;
    else release(target);
  }
  disk_rename(host, from, to);
  if (directory) {
    for (size_t i = 0; i < host->file_count; ++i) {
      file *below = &host->files[i];
      if (below->name[0] && !below->removed && !strncmp(below->name, prefix, from_len + 1)) {
        char moved[MAX_NAME];
        sprintf(moved, "%s%s", to, below->name + from_len);
        strcpy(below->name, moved);
      }
    }
  }
  strcpy(f->name, to);
  return 0;
}

u32 console_hal_file_create_directory(console_hal_t *instance, u32 ptr, u32 len) {
  host_t *host = instance->host;
  char name[MAX_NAME];
  if (!directory_name((const char *)range(console_hal_file_create_directory_memory(host->linked), ptr, len), len, name)) return (u32)-1;
  if (is_root(name)) return 0;
  file *f = find(host, name);
  if (f) return f->directory ? 0 : (u32)-1;
  return ensure_parents(host, name) && add_directory(host, name) ? 0 : (u32)-1;
}

u32 console_hal_arg_count(console_hal_t *instance) {
  return (u32)instance->host->argc;
}

void console_hal_arg(console_hal_t *instance, u32 index, u32 result) {
  host_t *host = instance->host;
  const char *s = index < (u32)host->argc ? host->argv[index] : "";
  u32 len = (u32)strlen(s);
  if (!valid_utf8((const unsigned char *)s, len)) len = 0;
  u32 ptr = len ? console_hal_arg_realloc(host->linked, 0, 0, 1, len) : 1;
  wasm_rt_memory_t *memory = console_hal_arg_memory(host->linked);
  if (len) memcpy(range(memory, ptr, len), s, len);
  store32(memory, result, ptr);
  store32(memory, result + 4, len);
}

void console_hal_exit(console_hal_t *instance, u32 code) {
  host_t *host = instance->host;
  host->exit_requested = true;
  host->exit_code = (s32)code;
  wasm_rt_trap(WASM_RT_TRAP_UNREACHABLE);
}

static void sink_write(host_t *host, const uint8_t *bytes, size_t len) {
  while (host->sink >= 0 && len) {
    ssize_t n = write(host->sink, bytes, len);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && errno == EAGAIN) { host->audio_dropped += len / 4; return; }
    if (n < 0) { close(host->sink); host->sink = -1; return; }
    bytes += n;
    len -= (size_t)n;
  }
}

// Plays what the frame period since the last call covers: queued frames go
// to the hash, the dump, and the sink; the rest of the period is silence.
static void play_audio(host_t *host) {
  uint64_t target = host->frames * AUDIO_RATE / host->frames_per_second;
  uint64_t due = target - host->audio_head;
  host->audio_head = target;
  size_t frames = due < host->audio_count ? (size_t)due : host->audio_count;
  uint8_t bytes[4096];
  size_t pending = 0;
  for (size_t i = 0; i < frames * AUDIO_CHANNELS; ++i) {
    int16_t sample = host->audio[(host->audio_start * AUDIO_CHANNELS + i) % (AUDIO_CAPACITY * AUDIO_CHANNELS)];
    bytes[pending++] = (uint8_t)sample;
    bytes[pending++] = (uint8_t)((uint16_t)sample >> 8);
    if (pending == sizeof(bytes) || i + 1 == frames * AUDIO_CHANNELS) {
      for (size_t j = 0; j < pending; ++j) {
        host->audio_hash ^= bytes[j];
        host->audio_hash *= UINT64_C(1099511628211);
      }
      if (host->wav) fwrite(bytes, 1, pending, host->wav);
      sink_write(host, bytes, pending);
      pending = 0;
    }
  }
  host->audio_start = (host->audio_start + frames) % AUDIO_CAPACITY;
  host->audio_count -= frames;
  host->audio_played += frames;
  memset(bytes, 0, sizeof(bytes));
  for (uint64_t silent = due - frames; silent; ) {
    size_t chunk = silent * 4 < sizeof(bytes) ? (size_t)silent * 4 : sizeof(bytes);
    if (host->wav) fwrite(bytes, 1, chunk, host->wav);
    sink_write(host, bytes, chunk);
    silent -= chunk / 4;
  }
  host->wav_frames += due;
}

static void store_le(FILE *out, uint32_t value, unsigned bytes) {
  for (unsigned i = 0; i < bytes; ++i) fputc((int)(value >> (8 * i)) & 0xff, out);
}

// A 44100 Hz stereo 16-bit RIFF/WAVE header; the sizes are filled in at the
// end of the run.
static bool open_wav(host_t *host, const char *path) {
  if (!(host->wav = fopen(path, "wb"))) { perror(path); return false; }
  fputs("RIFF", host->wav);
  store_le(host->wav, 0, 4);
  fputs("WAVEfmt ", host->wav);
  store_le(host->wav, 16, 4);
  store_le(host->wav, 1, 2);
  store_le(host->wav, AUDIO_CHANNELS, 2);
  store_le(host->wav, AUDIO_RATE, 4);
  store_le(host->wav, AUDIO_RATE * AUDIO_CHANNELS * 2, 4);
  store_le(host->wav, AUDIO_CHANNELS * 2, 2);
  store_le(host->wav, 16, 2);
  fputs("data", host->wav);
  store_le(host->wav, 0, 4);
  return true;
}

static bool close_wav(host_t *host) {
  FILE *wav = host->wav;
  host->wav = NULL;
  uint32_t data = (uint32_t)(host->wav_frames * AUDIO_CHANNELS * 2);
  bool ok = !fseek(wav, 4, SEEK_SET);
  if (ok) store_le(wav, 36 + data, 4);
  ok = ok && !fseek(wav, 40, SEEK_SET);
  if (ok) store_le(wav, data, 4);
  ok = ok && !ferror(wav);
  return !fclose(wav) && ok;
}

// The terminal plays through the first available command-line player:
// PipeWire's and ALSA's on Linux, then SoX's and FFmpeg's, which Homebrew
// provides on macOS. Raw frames go over a pipe that never blocks the frame
// loop: what the player cannot take in time is dropped.
static void open_sink(host_t *host) {
  static char *const players[][14] = {
    {"pw-cat", "--playback", "--rate", "44100", "--channels", "2", "--format", "s16", "-", NULL},
    {"aplay", "-q", "-t", "raw", "-f", "S16_LE", "-r", "44100", "-c", "2", NULL},
    {"play", "-q", "-t", "raw", "-r", "44100", "-e", "signed", "-b", "16", "-c", "2", "-", NULL},
    {"ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "-", NULL},
  };
  int fds[2];
  if (pipe(fds)) return;
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, fds[0], 0);
  posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0);
  posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0);
  posix_spawn_file_actions_addclose(&actions, fds[1]);
  extern char **environ;
  for (size_t i = 0; i < sizeof(players) / sizeof(*players); ++i) {
    if (!posix_spawnp(&host->sink_pid, players[i][0], &actions, NULL, players[i], environ)) {
      host->sink = fds[1];
      break;
    }
  }
  posix_spawn_file_actions_destroy(&actions);
  close(fds[0]);
  if (host->sink < 0) { close(fds[1]); return; }
  signal(SIGPIPE, SIG_IGN);
  fcntl(host->sink, F_SETFL, fcntl(host->sink, F_GETFL) | O_NONBLOCK);
}

static void close_sink(host_t *host) {
  if (host->sink >= 0) close(host->sink);
  host->sink = -1;
  if (host->sink_pid > 0) waitpid(host->sink_pid, NULL, 0);
  host->sink_pid = 0;
}

static uint64_t checksum(const host_t *host) {
  uint64_t value = UINT64_C(14695981039346656037);
  for (size_t i = 0; i < host->pixels_size; ++i) {
    value ^= host->pixels[i];
    value *= UINT64_C(1099511628211);
  }
  return value;
}

static uint64_t monotonic_ns(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) { perror("clock_gettime"); exit(1); }
  return (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
}


// The script and recording name of every key, by its ordinal in
// console:sdk/input.key.
static const char *const KEY_NAMES[] = {
  "tab", "enter", "escape", "space", "backspace", "up", "down", "left", "right", "shift", "control", "alt",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "minus", "equals", "comma", "period", "slash", "semicolon", "apostrophe",
  "left-bracket", "right-bracket", "backslash", "grave", "pause",
  "insert", "delete", "home", "end", "page-up", "page-down", "caps-lock",
  "kp0", "kp1", "kp2", "kp3", "kp4", "kp5", "kp6", "kp7", "kp8", "kp9",
  "kp-enter", "kp-period", "kp-plus", "kp-minus", "kp-multiply", "kp-divide",
};
_Static_assert(sizeof(KEY_NAMES) / sizeof(*KEY_NAMES) == CONSOLE_KEY_COUNT, "every key has a name");

static int key_code(const char *name) {
  for (size_t i = 0; i < CONSOLE_KEY_COUNT; ++i)
    if (!strcmp(name, KEY_NAMES[i])) return (int)i;
  return -1;
}

// A script line is 'frame key down|up', 'frame mouse x y buttons wheel' for
// the pointer's position in frame pixels, its held buttons, and the notches
// turned that frame, or 'frame text ...' for typed text.
static bool load_script(host_t *host, const char *path) {
  FILE *input = fopen(path, "r");
  if (!input) { perror(path); return false; }
  char line[1024], key[64], action[64], trailing;
  bool ok = true;
  while (fgets(line, sizeof(line), input)) {
    if (line[0] == '#' || line[0] == '\n') continue;
    uint64_t frame;
    script_event event = {0};
    int fields = sscanf(line, "%" SCNu64 " %63s", &frame, key);
    if (fields != 2 || (host->script_count && frame < host->script[host->script_count - 1].frame)) { ok = false; break; }
    event.frame = frame;
    if (!strcmp(key, "mouse")) {
      event.kind = SCRIPT_MOUSE;
      if (sscanf(line, "%" SCNu64 " mouse %" SCNd32 " %" SCNd32 " %" SCNu32 " %" SCNd32 " %c",
                 &frame, &event.x, &event.y, &event.buttons, &event.wheel, &trailing) != 5 ||
          event.buttons > 7) { ok = false; break; }
    } else if (!strcmp(key, "text")) {
      event.kind = SCRIPT_TEXT;
      char *start = strstr(line, "text ");
      start = start ? start + 5 : NULL;
      size_t len = start ? strcspn(start, "\r\n") : 0;
      if (!len || !valid_utf8((const unsigned char *)start, len)) { ok = false; break; }
      event.text = strndup(start, len);
      if (!event.text) { ok = false; break; }
    } else {
      if (sscanf(line, "%" SCNu64 " %63s %63s %c", &frame, key, action, &trailing) != 3 ||
          key_code(key) < 0 || (strcmp(action, "down") && strcmp(action, "up"))) { ok = false; break; }
      event.key = (console_key_event){.key = (u32)key_code(key), .pressed = !strcmp(action, "down")};
    }
    script_event *events = realloc(host->script, (host->script_count + 1) * sizeof(*events));
    if (!events) { free(event.text); ok = false; break; }
    host->script = events;
    host->script[host->script_count++] = event;
  }
  if (ferror(input)) ok = false;
  fclose(input);
  if (!ok) fprintf(stderr, "%s: expected sorted 'frame key down|up', 'frame mouse x y buttons wheel', or 'frame text ...' lines\n", path);
  return ok;
}

static void move_mouse(host_t *host, int32_t x, int32_t y, uint32_t buttons, int32_t wheel) {
  if (host->mouse_seen) {
    host->mouse_dx += x - host->mouse_x;
    host->mouse_dy += y - host->mouse_y;
  }
  host->mouse_changed |= !host->mouse_seen || x != host->mouse_x || y != host->mouse_y ||
                         buttons != host->mouse_buttons || wheel != 0;
  host->mouse_seen = true;
  host->mouse_x = x;
  host->mouse_y = y;
  host->mouse_buttons = buttons;
  host->mouse_wheel += wheel;
  host->frame_wheel += wheel;
}

static void type_text(host_t *host, const char *text, size_t len) {
  if (host->text_length + len > sizeof(host->text)) return;
  memcpy(host->text + host->text_length, text, len);
  host->text_length += len;
  host->frame_text += len;
}

// Every event the application receives goes to the recording, so replaying
// it as a script reproduces the run.
static void queue_input(host_t *host, uint64_t dt) {
  size_t first = host->event_count;
  host->mouse_changed = false;
  host->frame_wheel = 0;
  host->frame_text = 0;
  if (host->terminal) {
    host->event_count += terminal_poll(host->terminal, dt, host->events + host->event_count, MAX_EVENTS - host->event_count);
    terminal_mouse mouse = terminal_read_mouse(host->terminal);
    if (mouse.seen) move_mouse(host, mouse.x, mouse.y, mouse.buttons, mouse.wheel);
    char text[TERMINAL_TEXT_CAPACITY];
    size_t len = terminal_read_text(host->terminal, text, sizeof(text));
    if (len) type_text(host, text, len);
  }
  while (host->script_next < host->script_count && host->script[host->script_next].frame <= host->frames && host->event_count < MAX_EVENTS) {
    const script_event *event = &host->script[host->script_next++];
    if (event->kind == SCRIPT_KEY) host->events[host->event_count++] = event->key;
    else if (event->kind == SCRIPT_MOUSE) move_mouse(host, event->x, event->y, event->buttons, event->wheel);
    else type_text(host, event->text, strlen(event->text));
  }
  if (!host->record) return;
  for (size_t i = first; i < host->event_count; ++i) {
    if (host->events[i].key < CONSOLE_KEY_COUNT)
      fprintf(host->record, "%" PRIu64 " %s %s\n", host->frames, KEY_NAMES[host->events[i].key],
              host->events[i].pressed ? "down" : "up");
  }
  if (host->mouse_changed)
    fprintf(host->record, "%" PRIu64 " mouse %" PRId32 " %" PRId32 " %" PRIu32 " %" PRId32 "\n", host->frames,
            host->mouse_x, host->mouse_y, host->mouse_buttons, host->frame_wheel);
  if (host->frame_text)
    fprintf(host->record, "%" PRIu64 " text %.*s\n", host->frames, (int)host->frame_text,
            host->text + host->text_length - host->frame_text);
}

static void frame_trace(host_t *host) {
  printf("frame=%" PRIu64 " hash=%016" PRIx64 " game-memory=%" PRIu64 " platform-memory=%" PRIu64
         " audio=%016" PRIx64 " played=%" PRIu64 "\n",
         host->frames, checksum(host), (uint64_t)console_game_memory(host->linked)->size,
         (uint64_t)console_platform_memory(host->linked)->size, host->audio_hash, host->audio_played);
}

// A backlog longer than this is dropped rather than caught up: the pacing
// clock resyncs, and the application loses that time instead of running
// frames back to back until it is made up.
#define MAX_LAG_NS UINT64_C(250000000)

// All state modified after setjmp lives in the caller-owned context. A trapped
// instance is destroyed, never resumed with a partially unwound guest stack.
static void run_guest(host_t *host, uint64_t limit) {
  int trap = wasm_rt_impl_try();
  if (trap) { host->trap = trap; return; }
  host->hal.host = host;
  wasm2c_linked_instantiate(host->linked, &host->hal);
  queue_input(host, 0);
  w2c_linked_init(host->linked);
  uint64_t start = monotonic_ns();
  while (!limit || host->frames < limit) {
    // The application's clock advances a frame per frame in every mode, so a
    // run is a function of its inputs; in the terminal the frames are paced
    // against the wall clock, and a slow frame is followed by catch-up ones.
    if (!host->headless) {
      uint64_t frame_ns = UINT64_C(1000000000) / host->frames_per_second;
      uint64_t deadline = start + (host->frames + 1) * frame_ns;
      uint64_t now = monotonic_ns();
      while (now < deadline) {
        uint64_t wait = deadline - now;
        struct timespec delay = {(time_t)(wait / 1000000000), (long)(wait % 1000000000)};
        if (nanosleep(&delay, NULL) && errno != EINTR) break;
        if (terminal_should_quit(host->terminal)) break;
        now = monotonic_ns();
      }
      if (now > deadline + MAX_LAG_NS) start = now - (host->frames + 1) * frame_ns;
    }
    uint64_t next_ms = ((host->frames + 1) * 1000 + host->frames_per_second - 1) / host->frames_per_second;
    uint64_t dt = next_ms - host->now_ms;
    host->now_ms = next_ms;
    host->frames++;
    queue_input(host, dt);
    if (host->terminal && terminal_should_quit(host->terminal)) break;
    bool more = w2c_linked_frame(host->linked, (u32)dt);
    console_end_frame(host->linked);
    play_audio(host);
    if (!more) break;
    // A budget of zero keeps every frame: the terminal never falls behind, so
    // it never drops one to catch up. A test that counts the frames it was
    // sent needs that; a person watching would rather the game kept its pace.
    unsigned budget_ms = host->present_every_frame ? 0 : 1000 / host->frames_per_second;
    if (host->terminal && host->pixels &&
        terminal_present(host->terminal, host->width, host->height, host->pixels, budget_ms)) {
      host->exit_code = 1; break;
    }
    if (host->trace) frame_trace(host);
  }
}

static bool dump_frame(const host_t *host, const char *path) {
  if (!host->pixels) { fprintf(stderr, "no frame to capture\n"); return false; }
  FILE *out = fopen(path, "wb");
  if (!out) { perror(path); return false; }
  fprintf(out, "P6\n%u %u\n255\n", host->width, host->height);
  for (size_t i = 0; i < host->pixels_size; i += 4) fwrite(host->pixels + i, 1, 3, out);
  bool ok = !ferror(out);
  if (fclose(out)) ok = false;
  return ok;
}

// The terminal's default save directory: the application's own directory
// under the XDG data home, or NULL when the environment names none.
static char *default_save_dir(const char *name) {
  const char *data = getenv("XDG_DATA_HOME"), *home = getenv("HOME");
  const char *base = data && data[0] == '/' ? data : home && home[0] == '/' ? home : NULL;
  const char *middle = base == data ? "/console/" : "/.local/share/console/";
  if (!base) return NULL;
  char *path = malloc(strlen(base) + strlen(middle) + strlen(name) + 1);
  if (path) sprintf(path, "%s%s%s", base, middle, name);
  return path;
}

static bool create_save_dir(const char *path) {
  char *copy = strdup(path);
  if (!copy) return false;
  bool ok = true;
  for (char *slash = strchr(copy + 1, '/'); ok && slash; slash = strchr(slash + 1, '/')) {
    *slash = 0;
    ok = make_directory(copy);
    *slash = '/';
  }
  ok = ok && make_directory(copy);
  if (!ok) perror(path);
  free(copy);
  return ok;
}

static void usage(FILE *out, const console_host_config *config) {
  fprintf(out, "usage: %s", config->name);
  if (config->asset_option)
    fprintf(out, config->asset_required ? " %s PATH" : " [%s PATH]", config->asset_option);
  fputs(" [--renderer auto|kitty|ansi] [--headless --frames N]\n"
        "       [--script PATH] [--record PATH] [--trace] [--dump-frame PATH]\n"
        "       [--dump-audio PATH] [--no-audio] [--save-dir PATH | --no-save]\n"
        "       [--seed N] [--unix-time N] [--present-every-frame]\n"
        "       [-- GUEST_ARGS...]\n", out);
  if (config->help) fputs(config->help, out);
  fputs("Scripts contain sorted 'frame key down|up', 'frame mouse x y buttons wheel',\n"
        "and 'frame text ...' lines; --record writes one from the input the application\n"
        "receives, and replaying it repeats the run. In the\n"
        "terminal, files the application writes persist under\n"
        "$XDG_DATA_HOME/console/<name> (default ~/.local/share); a headless run keeps\n"
        "them for the session unless --save-dir names a directory. Sound plays through\n"
        "pw-cat, aplay, play, or ffplay when one is installed; --dump-audio writes it\n"
        "as a WAV file.\n"
        "A headless run reports --seed as its entropy and --unix-time as the wall\n"
        "clock, both zero unless given. A terminal that cannot keep up is sent\n"
        "fewer frames than the application draws; --present-every-frame sends it\n"
        "all of them however long that takes.\n", out);
}

int console_host_run(const console_host_config *config, int argc, char **argv) {
  if (!config || !config->name || !*config->name ||
      (config->asset_required && !config->asset_option) ||
      (config->asset_option && !config->mount_asset) || config->frames_per_second > 1000)
    return 1;
  host_t *host = calloc(1, sizeof(*host));
  if (!host) return 1;
  host->frames_per_second = config->frames_per_second ? config->frames_per_second : 60;
  host->audio_hash = UINT64_C(14695981039346656037);
  host->sink = -1;
  const char *asset = NULL, *renderer = "auto", *script = NULL, *capture = NULL, *save_dir = NULL;
  const char *record = NULL, *wav = NULL;
  bool no_save = false;
  uint64_t limit = 0;
  int first_arg = argc, result = 1;
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--")) { first_arg = i + 1; break; }
    if (!strcmp(argv[i], "--help")) { usage(stdout, config); result = 0; goto cleanup; }
    if (!strcmp(argv[i], "--headless")) { host->headless = true; continue; }
    if (!strcmp(argv[i], "--trace")) { host->trace = true; continue; }
    if (!strcmp(argv[i], "--no-save")) { no_save = true; continue; }
    if (!strcmp(argv[i], "--no-audio")) { host->no_audio = true; continue; }
    if (!strcmp(argv[i], "--present-every-frame")) { host->present_every_frame = true; continue; }
    if (i + 1 == argc) { usage(stderr, config); goto cleanup; }
    if (config->asset_option && !strcmp(argv[i], config->asset_option)) asset = argv[++i];
    else if (!strcmp(argv[i], "--renderer")) renderer = argv[++i];
    else if (!strcmp(argv[i], "--script")) script = argv[++i];
    else if (!strcmp(argv[i], "--record")) record = argv[++i];
    else if (!strcmp(argv[i], "--dump-frame")) capture = argv[++i];
    else if (!strcmp(argv[i], "--dump-audio")) wav = argv[++i];
    else if (!strcmp(argv[i], "--save-dir")) save_dir = argv[++i];
    else if (!strcmp(argv[i], "--seed") || !strcmp(argv[i], "--unix-time")) {
      char *end;
      errno = 0;
      unsigned long long value = strtoull(argv[i + 1], &end, 10);
      if (errno || *end || !*argv[i + 1]) { fprintf(stderr, "invalid %s\n", argv[i]); goto cleanup; }
      if (!strcmp(argv[i], "--seed")) host->seed = value;
      else host->unix_time = (int64_t)value;
      ++i;
    }
    else if (!strcmp(argv[i], "--frames")) {
      char *end;
      errno = 0;
      limit = strtoull(argv[++i], &end, 10);
      if (errno || *end || !limit || limit > 100000000) { fprintf(stderr, "invalid frame limit\n"); goto cleanup; }
    } else { usage(stderr, config); goto cleanup; }
  }
  if ((config->asset_required && !asset) || (host->headless && !limit) || (save_dir && no_save)) { usage(stderr, config); goto cleanup; }
  if (host->trace && !host->headless) {
    fprintf(stderr, "--trace requires --headless\n");
    goto cleanup;
  }
  if ((asset && !config->mount_asset(host, asset)) || (script && !load_script(host, script))) goto cleanup;
  if (record) {
    if (!(host->record = fopen(record, "w"))) { perror(record); goto cleanup; }
    fprintf(host->record, "# %s input recording\n", config->name);
  }
  if (wav && !open_wav(host, wav)) goto cleanup;
  if (save_dir) host->save_dir = strdup(save_dir);
  else if (!host->headless && !no_save && !(host->save_dir = default_save_dir(config->name)))
    fprintf(stderr, "neither XDG_DATA_HOME nor HOME is set; saves last for this session\n");
  if (host->save_dir) {
    if (!create_save_dir(host->save_dir)) goto cleanup;
    load_directory(host, "");
  }
  host->argc = 1 + argc - first_arg;
  host->argv = calloc((size_t)host->argc + 1, sizeof(char *));
  host->linked = calloc(1, sizeof(*host->linked));
  if (!host->argv || !host->linked) goto cleanup;
  host->argv[0] = (char *)config->name;
  for (int i = 1; i < host->argc; ++i) host->argv[i] = argv[first_arg + i - 1];
  if (!host->headless && !(host->terminal = terminal_open(renderer))) goto cleanup;
  if (!host->headless && !host->no_audio) open_sink(host);
  wasm_rt_init();
  run_guest(host, limit);
  flush_all(host);
  close_sink(host);
  if (host->record && fclose(host->record)) { perror(record); host->exit_code = 1; }
  host->record = NULL;
  if (host->wav && !close_wav(host)) { perror(wav); host->exit_code = 1; }
  terminal_close(host->terminal);
  host->terminal = NULL;
  result = host->exit_code;
  if (host->trap && !host->exit_requested) {
    fprintf(stderr, "guest trapped: %s\n", wasm_rt_strerror((wasm_rt_trap_t)host->trap));
    result = 1;
  }
  if (result && host->log_size) fwrite(host->log, 1, host->log_size, stderr);
  if (host->save_error[0]) fprintf(stderr, "saves not written: %s\n", host->save_error);
  if (host->audio_dropped) fprintf(stderr, "audio: the player fell behind by %" PRIu64 " frames\n", host->audio_dropped);
  if (capture && !dump_frame(host, capture)) result = 1;
  if (host->headless) {
    printf("summary frames=%" PRIu64 " presents=%" PRIu64 " width=%u height=%u hash=%016" PRIx64
           " game-memory=%" PRIu64 " platform-memory=%" PRIu64 " audio=%016" PRIx64 " played=%" PRIu64 " exit=%d\n",
           host->frames, host->presentations, host->width, host->height, checksum(host),
           (uint64_t)console_game_memory(host->linked)->size,
           (uint64_t)console_platform_memory(host->linked)->size, host->audio_hash, host->audio_played, result);
  }
  // The generated free function also accepts zero-initialized memories/tables
  // belonging to a component whose instantiation was interrupted.
  wasm2c_linked_free(host->linked);
  wasm_rt_free();
cleanup:
  close_sink(host);
  if (host->record) fclose(host->record);
  for (size_t i = 0; i < host->script_count; ++i) free(host->script[i].text);
  if (host->wav) fclose(host->wav);
  for (size_t i = 0; i < host->file_count; ++i) free(host->files[i].data);
  free(host->files);
  free(host->save_dir);
  free(host->pixels);
  free(host->script);
  free(host->argv);
  free(host->linked);
  free(host);
  return result;
}
