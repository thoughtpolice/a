// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "console.h"
#include "runtime.h"

void console_gfx_present(uint32_t width, uint32_t height,
                         const uint8_t* rgba, size_t len) {
  game_list_u8_t pixels = {(uint8_t*)rgba, len};
  console_sdk_gfx_present(width, height, &pixels);
}

void console_gfx_set_palette(uint8_t first, const uint8_t* rgba, size_t count) {
  console_sdk_gfx_list_color_t colors = {(console_sdk_gfx_color_t*)rgba, count};
  console_sdk_gfx_set_palette(first, &colors);
}

void console_gfx_present_indexed(uint32_t width, uint32_t height,
                                 const uint8_t* pixels, size_t len) {
  game_list_u8_t list = {(uint8_t*)pixels, len};
  console_sdk_gfx_present_indexed(width, height, &list);
}

console_sdk_gfx_display_info_t console_gfx_info(void) {
  console_sdk_gfx_display_info_t info;
  console_sdk_gfx_info(&info);
  return info;
}

void console_gfx_draw_text(int32_t x, int32_t y, const char* text, size_t len,
                           console_sdk_gfx_color_t color) {
  game_string_t string = {(uint8_t*)text, len};
  console_sdk_gfx_draw_text(x, y, &string, &color);
}

console_key_events console_input_read_events(void) {
  console_sdk_input_list_key_event_t raw = {0};
  console_sdk_input_read_events(&raw);
  console_key_events result = {0};
  if (raw.len > SIZE_MAX / sizeof(console_key_event)) {
    __builtin_trap();
  }
  if (raw.len != 0) {
    result.data = console_malloc(raw.len * sizeof(console_key_event));
    result.len = raw.len;
    for (size_t i = 0; i < raw.len; i++) {
      result.data[i] = (console_key_event){
        .key = raw.ptr[i].key,
        .pressed = raw.ptr[i].pressed,
      };
    }
  }
  console_sdk_input_list_key_event_free(&raw);
  return result;
}

uint32_t console_input_capabilities(void) {
  return console_sdk_input_capabilities();
}

console_mouse console_input_mouse(void) {
  console_sdk_input_mouse_state_t state;
  console_sdk_input_mouse(&state);
  return (console_mouse){state.x, state.y, state.dx, state.dy, state.buttons, state.wheel};
}

bool console_input_capture_pointer(bool captured) {
  return console_sdk_input_capture_pointer(captured);
}

console_string console_input_read_text(void) {
  game_string_t text = {0};
  console_sdk_input_read_text(&text);
  return (console_string){(char*)text.ptr, text.len};
}

uint64_t console_clock_now_ms(void) {
  return console_sdk_clock_now_ms();
}

uint64_t console_clock_frame(void) {
  return console_sdk_clock_frame();
}

int64_t console_clock_unix_seconds(void) {
  return console_sdk_clock_unix_seconds();
}

uint32_t console_clock_set_frame_rate(uint32_t hz) {
  return console_sdk_clock_set_frame_rate(hz);
}

console_string console_system_host_name(void) {
  console_sdk_system_host_info_t info;
  console_sdk_system_info(&info);
  return (console_string){(char*)info.name.ptr, info.name.len};
}

uint32_t console_system_features(void) {
  console_sdk_system_host_info_t info;
  console_sdk_system_info(&info);
  game_string_free(&info.name);
  return info.features;
}

uint64_t console_system_random_seed(void) {
  return console_sdk_system_random_seed();
}

void console_system_set_title(const char* title, size_t len) {
  game_string_t string = {(uint8_t*)title, len};
  console_sdk_system_set_title(&string);
}

console_audio_format console_audio_get_format(void) {
  console_sdk_audio_sample_format_t format;
  console_sdk_audio_format(&format);
  return (console_audio_format){format.sample_rate, format.channels};
}

uint32_t console_audio_write(const int16_t* samples, size_t count) {
  game_list_s16_t list = {(int16_t*)samples, count};
  return console_sdk_audio_write(&list);
}

uint32_t console_audio_queued(void) {
  return console_sdk_audio_queued();
}

bool console_files_open(const char* path, size_t len, bool write,
                        console_file* file) {
  game_string_t string = {(uint8_t*)path, len};
  return console_sdk_files_open(&string, write, file);
}

int64_t console_file_size(console_file file) {
  return console_sdk_files_method_file_size(console_sdk_files_borrow_file(file));
}

console_file_read_result console_file_read_at(console_file file,
                                              uint64_t offset,
                                              uint32_t length) {
  game_list_u8_t data = {0};
  if (!console_sdk_files_method_file_read_at(console_sdk_files_borrow_file(file),
                                             offset, length, &data)) {
    return (console_file_read_result){-1, {0}};
  }
  return (console_file_read_result){0, {data.ptr, data.len}};
}

int32_t console_file_write_at(console_file file, uint64_t offset,
                             const uint8_t* data, size_t len) {
  game_list_u8_t bytes = {(uint8_t*)data, len};
  return console_sdk_files_method_file_write_at(console_sdk_files_borrow_file(file),
                                                offset, &bytes);
}

void console_file_close(console_file file) {
  console_sdk_files_file_drop_own(file);
}

bool console_files_list_directory(const char* path, size_t len,
                                  console_file_entries* entries) {
  game_string_t string = {(uint8_t*)path, len};
  // The generated binding leaves the list unset when there is no such
  // directory; an empty one is safe to free.
  if (console_sdk_files_list_directory(&string, entries)) return true;
  *entries = (console_file_entries){0};
  return false;
}

bool console_files_remove(const char* path, size_t len) {
  game_string_t string = {(uint8_t*)path, len};
  return console_sdk_files_remove(&string);
}

bool console_files_rename(const char* path, size_t len, const char* to,
                          size_t to_len) {
  game_string_t from = {(uint8_t*)path, len};
  game_string_t target = {(uint8_t*)to, to_len};
  return console_sdk_files_rename(&from, &target);
}

bool console_files_create_directory(const char* path, size_t len) {
  game_string_t string = {(uint8_t*)path, len};
  return console_sdk_files_create_directory(&string);
}

uint32_t console_process_arg_count(void) {
  return console_sdk_process_arg_count();
}

console_string console_process_arg(uint32_t index) {
  game_string_t result = {0};
  console_sdk_process_arg(index, &result);
  return (console_string){(char*)result.ptr, result.len};
}

_Noreturn void console_process_exit(int32_t code) {
  console_sdk_process_exit(code);
  __builtin_trap();
}

void console_log(uint32_t level, const char* message, size_t len) {
  game_string_t string = {(uint8_t*)message, len};
  console_sdk_log_log((console_sdk_log_level_t)level, &string);
}

void console_free_bytes(console_bytes* bytes) {
  game_list_u8_t value = {bytes->data, bytes->len};
  game_list_u8_free(&value);
  *bytes = (console_bytes){0};
}

void console_free_string(console_string* string) {
  game_string_t value = {(uint8_t*)string->data, string->len};
  game_string_free(&value);
  *string = (console_string){0};
}

void console_input_free_events(console_key_events* events) {
  console_free(events->data);
  *events = (console_key_events){0};
}

void console_files_free_entries(console_file_entries* entries) {
  console_sdk_files_list_entry_free(entries);
  *entries = (console_file_entries){0};
}
