// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A host for the linked game package: implements console:hal/raw over stdio
// and drives the game's frame loop. This is the whole native surface of the
// console; everything above it is portable wasm.

#include <stdio.h>
#include <stdlib.h>

#include "hal-host.h"
#include "hal-bindings.h"
#include "wasm-rt.h"

// The generated header names the HAL context; its state belongs to this host.
struct console_hal_context {
  w2c_linked* linked;
};

// The imports wasm2c's module calls, which lift and lower for the
// console_hal_raw_ functions below.
#define CONSOLE_HAL_RAW_GUEST(hal) ((hal)->linked)
#define CONSOLE_HAL_RAW_IMPLEMENTATION
#include "hal-bindings.h"

enum {
  KEY_ENTER = 1,
  KEY_RIGHT = 8,
};

static const console_hal_raw_bytes_t empty = {NULL, 0};

void console_hal_raw_write_log(console_hal_t* hal, uint32_t level, console_hal_raw_bytes_t message) {
  (void)hal;
  printf("[hal] log %u: %.*s\n", level, (int)message.len, (const char*)message.ptr);
}

// The rectangle demo has no assets or arguments. These services keep its
// original deterministic behavior as the shared SDK expands.
void console_hal_raw_present(console_hal_t* hal, uint32_t width, uint32_t height,
                             console_hal_raw_bytes_t rgba) {
  (void)hal;
  printf("[hal] present %u %u bytes=%zu\n", width, height, rgba.len);
}

void console_hal_raw_present_indexed(console_hal_t* hal, uint32_t width, uint32_t height,
                                     console_hal_raw_bytes_t pixels, console_hal_raw_u32_view_t palette) {
  (void)hal;
  (void)palette;
  printf("[hal] present-indexed %u %u bytes=%zu\n", width, height, pixels.len);
}

uint32_t console_hal_raw_frames_per_second(console_hal_t* hal) {
  (void)hal;
  return 60;
}

uint32_t console_hal_raw_set_frame_rate(console_hal_t* hal, uint32_t hz) {
  (void)hal;
  (void)hz;
  return 60;
}

int64_t console_hal_raw_unix_seconds(console_hal_t* hal) {
  (void)hal;
  return 0;
}

uint64_t console_hal_raw_random_seed(console_hal_t* hal) {
  (void)hal;
  return 0;
}

console_hal_raw_bytes_t console_hal_raw_host_name(console_hal_t* hal) {
  (void)hal;
  static const char name[] = "stdio";
  return (console_hal_raw_bytes_t){(const uint8_t*)name, sizeof(name) - 1};
}

uint32_t console_hal_raw_host_features(console_hal_t* hal) {
  (void)hal;
  return 0;
}

void console_hal_raw_set_title(console_hal_t* hal, console_hal_raw_bytes_t title) {
  (void)hal;
  printf("[hal] set-title \"%.*s\"\n", (int)title.len, (const char*)title.ptr);
}

// The demo's original input: the right arrow held through the first two
// frames, then start.
console_hal_raw_key_event_list_t console_hal_raw_read_events(console_hal_t* hal) {
  (void)hal;
  static unsigned reads = 0;
  static const console_hal_raw_key_event_t frame_one[] = {{KEY_RIGHT, true}};
  static const console_hal_raw_key_event_t frame_three[] = {{KEY_RIGHT, false}, {KEY_ENTER, true}};
  reads++;
  if (reads == 1) return (console_hal_raw_key_event_list_t){frame_one, 1};
  if (reads == 3) return (console_hal_raw_key_event_list_t){frame_three, 2};
  return (console_hal_raw_key_event_list_t){NULL, 0};
}

uint32_t console_hal_raw_input_capabilities(console_hal_t* hal) {
  (void)hal;
  return 0;
}

console_hal_raw_mouse_state_t console_hal_raw_read_mouse(console_hal_t* hal) {
  (void)hal;
  return (console_hal_raw_mouse_state_t){0};
}

uint32_t console_hal_raw_capture_pointer(console_hal_t* hal, uint32_t captured) {
  (void)hal;
  (void)captured;
  return 0;
}

console_hal_raw_bytes_t console_hal_raw_read_text(console_hal_t* hal) {
  (void)hal;
  return empty;
}

uint32_t console_hal_raw_audio_write(console_hal_t* hal, console_hal_raw_s16_view_t samples) {
  (void)hal;
  (void)samples;
  return 0;
}

uint32_t console_hal_raw_audio_queued(console_hal_t* hal) {
  (void)hal;
  return 0;
}

uint64_t console_hal_raw_now_ms(console_hal_t* hal) {
  (void)hal;
  return 0;
}

int32_t console_hal_raw_file_open(console_hal_t* hal, console_hal_raw_bytes_t path, bool write) {
  (void)hal;
  (void)path;
  (void)write;
  return -1;
}

int64_t console_hal_raw_file_size(console_hal_t* hal, uint32_t handle) {
  (void)hal;
  (void)handle;
  return -1;
}

console_hal_raw_read_result_t console_hal_raw_file_read_at(console_hal_t* hal, uint32_t handle,
                                                            uint64_t offset, uint32_t length) {
  (void)hal;
  (void)handle;
  (void)offset;
  (void)length;
  return (console_hal_raw_read_result_t){.status = -1, .data = empty};
}

int32_t console_hal_raw_file_write_at(console_hal_t* hal, uint32_t handle, uint64_t offset,
                                      console_hal_raw_bytes_t data) {
  (void)hal;
  (void)handle;
  (void)offset;
  (void)data;
  return -1;
}

void console_hal_raw_file_close(console_hal_t* hal, uint32_t handle) {
  (void)hal;
  (void)handle;
}

console_hal_raw_list_result_t console_hal_raw_file_list_directory(console_hal_t* hal,
                                                                  console_hal_raw_bytes_t path) {
  (void)hal;
  (void)path;
  return (console_hal_raw_list_result_t){.status = -1, .entries = {NULL, 0}};
}

int32_t console_hal_raw_file_remove(console_hal_t* hal, console_hal_raw_bytes_t path) {
  (void)hal;
  (void)path;
  return -1;
}

int32_t console_hal_raw_file_rename(console_hal_t* hal, console_hal_raw_bytes_t path,
                                    console_hal_raw_bytes_t to) {
  (void)hal;
  (void)path;
  (void)to;
  return -1;
}

int32_t console_hal_raw_file_create_directory(console_hal_t* hal, console_hal_raw_bytes_t path) {
  (void)hal;
  (void)path;
  return -1;
}

uint32_t console_hal_raw_arg_count(console_hal_t* hal) {
  (void)hal;
  return 0;
}

console_hal_raw_bytes_t console_hal_raw_arg(console_hal_t* hal, uint32_t index) {
  (void)hal;
  (void)index;
  return empty;
}

void console_hal_raw_exit(console_hal_t* hal, int32_t code) {
  (void)hal;
  exit(code);
}

int main(void) {
  wasm_rt_init();
  w2c_linked linked;
  console_hal_t hal = {&linked};
  wasm2c_linked_instantiate(&linked, &hal);

  w2c_linked_init(&linked);
  unsigned frames = 1;
  for (;;) {
    bool more = w2c_linked_frame(&linked, 16);
    console_end_frame(&linked);
    if (!more || frames >= 100) break;
    frames++;
  }
  printf("game over after %u frames\n", frames);

  wasm2c_linked_free(&linked);
  wasm_rt_free();
  return 0;
}
