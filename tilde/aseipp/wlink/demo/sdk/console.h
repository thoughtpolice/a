// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_SDK_H
#define CONSOLE_SDK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "game.h"


#ifdef __cplusplus
extern "C" {
#endif

#define CONSOLE_KEY_COUNT (CONSOLE_SDK_INPUT_KEY_KP_DIVIDE + 1)

typedef struct {
  uint8_t* data;
  size_t len;
} console_bytes;

typedef struct {
  char* data;
  size_t len;
} console_string;

// This convenience shape is also used by native terminal input. The generated
// bindings handle the component representation independently.
typedef struct {
  uint32_t key;
  uint8_t pressed;
  uint8_t padding[3];
} console_key_event;

typedef struct {
  console_key_event* data;
  size_t len;
} console_key_events;

// An open file: a resource handle the caller owns until console_file_close
// releases it, which closes the file. Every method borrows it.
typedef console_sdk_files_own_file_t console_file;

typedef struct {
  int32_t status;
  console_bytes data;
} console_file_read_result;

void console_gfx_present(uint32_t width, uint32_t height,
                         const uint8_t* rgba, size_t len);
// Palette entries from `first`: four bytes each, red, green, blue, alpha.
void console_gfx_set_palette(uint8_t first, const uint8_t* rgba, size_t count);
void console_gfx_present_indexed(uint32_t width, uint32_t height,
                                 const uint8_t* pixels, size_t len);
console_sdk_gfx_display_info_t console_gfx_info(void);
void console_gfx_draw_text(int32_t x, int32_t y, const char* text, size_t len,
                           console_sdk_gfx_color_t color);
console_key_events console_input_read_events(void);
// The console_sdk_input_capability_* bits.
uint32_t console_input_capabilities(void);

typedef struct {
  int32_t x;
  int32_t y;
  int32_t dx;
  int32_t dy;
  uint32_t buttons;  // The console_sdk_input_mouse_buttons_* bits.
  int32_t wheel;
} console_mouse;

// Motion and wheel counts are since the previous call.
console_mouse console_input_mouse(void);
bool console_input_capture_pointer(bool captured);
// Text typed since the previous call, owned by the caller.
console_string console_input_read_text(void);
uint64_t console_clock_now_ms(void);
uint64_t console_clock_frame(void);
int64_t console_clock_unix_seconds(void);
uint32_t console_clock_set_frame_rate(uint32_t hz);
// The host's name, owned by the caller, and its console_sdk_system_features_*
// bits.
console_string console_system_host_name(void);
uint32_t console_system_features(void);
uint64_t console_system_random_seed(void);
void console_system_set_title(const char* title, size_t len);

typedef struct {
  uint32_t sample_rate;
  uint32_t channels;
} console_audio_format;

console_audio_format console_audio_get_format(void);
// Interleaved samples; returns the frames accepted.
uint32_t console_audio_write(const int16_t* samples, size_t count);
uint32_t console_audio_queued(void);

// Returns false when the file cannot be opened. Write opens create/truncate.
bool console_files_open(const char* path, size_t len, bool write,
                        console_file* file);
int64_t console_file_size(console_file file);
// status is 0 on success (including EOF), -1 on error. The returned bytes are
// owned by the caller and released with console_free_bytes(&result.data).
console_file_read_result console_file_read_at(console_file file,
                                              uint64_t offset,
                                              uint32_t length);
// Returns the byte count written, or -1 on failure.
int32_t console_file_write_at(console_file file, uint64_t offset,
                             const uint8_t* data, size_t len);
void console_file_close(console_file file);
// A directory entry: the generated record, whose name is a byte range.
typedef console_sdk_files_entry_t console_file_entry;
typedef console_sdk_files_list_entry_t console_file_entries;
// Returns false when there is no such directory. The entries are sorted by
// name and belong to the caller until console_files_free_entries.
bool console_files_list_directory(const char* path, size_t len,
                                  console_file_entries* entries);
bool console_files_remove(const char* path, size_t len);
bool console_files_rename(const char* path, size_t len, const char* to,
                          size_t to_len);
bool console_files_create_directory(const char* path, size_t len);
uint32_t console_process_arg_count(void);
// Returned strings are owned byte ranges, with no trailing NUL.
console_string console_process_arg(uint32_t index);
_Noreturn void console_process_exit(int32_t code);
void console_log(uint32_t level, const char* message, size_t len);

// All helpers accept an empty buffer and clear its descriptor after release.
void console_free_bytes(console_bytes* bytes);
void console_free_string(console_string* string);
void console_input_free_events(console_key_events* events);
void console_files_free_entries(console_file_entries* entries);

// The reactor supplies and exports this allocator. A zero new_size releases
// an existing allocation and returns NULL; other calls preserve old contents.
void* cabi_realloc(void* old, size_t old_size, size_t align, size_t new_size);


#ifdef __cplusplus
}
#endif

#endif
