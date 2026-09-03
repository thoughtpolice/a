// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A host for the linked game package: implements console:hal/raw over stdio
// and drives the game's frame loop. This is the whole native surface of the
// console; everything above it is portable wasm.

#include <stdio.h>
#include <stdlib.h>

#include "hal-host.h"
#include "wasm-rt.h"

// The generated header names the HAL context; its state belongs to this host.
struct console_hal_context {
  w2c_linked* linked;
};

enum {
  KEY_ENTER = 1,
  KEY_RIGHT = 8,
};

// Each import identifies the canonical memory its pointers refer to.
static unsigned char* memory_range(wasm_rt_memory_t* memory, u32 ptr, u32 len) {
  if ((u64)ptr + (u64)len > memory->size) {
    fprintf(stderr, "HAL byte range %u+%u escapes its memory of %llu bytes\n",
            ptr, len, (unsigned long long)memory->size);
    abort();
  }
  return memory->data + ptr;
}

static void empty_list(wasm_rt_memory_t* memory, u32 result_ptr, unsigned align) {
  unsigned char* result = memory_range(memory, result_ptr, 8);
  for (unsigned i = 0; i < 8; i++) {
    result[i] = 0;
  }
  // Generated Rust bindings require a non-null aligned pointer even at len=0.
  result[0] = (unsigned char)align;
}

void console_hal_write_log(console_hal_t* hal, u32 level, u32 ptr, u32 len) {
  printf("[hal] log %u: %.*s\n", level, (int)len,
         (const char*)memory_range(console_hal_write_log_memory(hal->linked), ptr, len));
}

// The rectangle demo has no assets or arguments. These services keep its
// original deterministic behavior as the shared SDK expands.
void console_hal_present(console_hal_t* hal, u32 width, u32 height, u32 ptr, u32 len) {
  (void)memory_range(console_hal_present_memory(hal->linked), ptr, len);
  printf("[hal] present %u %u bytes=%u\n", width, height, len);
}

void console_hal_present_indexed(console_hal_t* hal, u32 width, u32 height, u32 ptr, u32 len,
                                 u32 palette_ptr, u32 palette_len) {
  wasm_rt_memory_t* memory = console_hal_present_indexed_memory(hal->linked);
  (void)memory_range(memory, ptr, len);
  (void)memory_range(memory, palette_ptr, palette_len * 4);
  printf("[hal] present-indexed %u %u bytes=%u\n", width, height, len);
}

u32 console_hal_frames_per_second(console_hal_t* hal) {
  (void)hal;
  return 60;
}

u32 console_hal_set_frame_rate(console_hal_t* hal, u32 hz) {
  (void)hal;
  (void)hz;
  return 60;
}

u64 console_hal_unix_seconds(console_hal_t* hal) {
  (void)hal;
  return 0;
}

u64 console_hal_random_seed(console_hal_t* hal) {
  (void)hal;
  return 0;
}

void console_hal_host_name(console_hal_t* hal, u32 result) {
  static const char name[] = "stdio";
  u32 ptr = console_hal_host_name_realloc(hal->linked, 0, 0, 1, sizeof(name) - 1);
  wasm_rt_memory_t* memory = console_hal_host_name_memory(hal->linked);
  unsigned char* text = memory_range(memory, ptr, sizeof(name) - 1);
  for (unsigned i = 0; i + 1 < sizeof(name); i++) {
    text[i] = (unsigned char)name[i];
  }
  unsigned char* out = memory_range(memory, result, 8);
  for (unsigned b = 0; b < 4; b++) {
    out[b] = (unsigned char)(ptr >> (8 * b));
    out[4 + b] = (unsigned char)((sizeof(name) - 1) >> (8 * b));
  }
}

u32 console_hal_host_features(console_hal_t* hal) {
  (void)hal;
  return 0;
}

void console_hal_set_title(console_hal_t* hal, u32 ptr, u32 len) {
  printf("[hal] set-title \"%.*s\"\n", (int)len,
         (const char*)memory_range(console_hal_set_title_memory(hal->linked), ptr, len));
}

// The demo's original input: the right arrow held through the first two
// frames, then start.
void console_hal_read_events(console_hal_t* hal, u32 result) {
  static unsigned reads = 0;
  reads++;
  const u32 frame_one[] = {KEY_RIGHT, 1};
  const u32 frame_three[] = {KEY_RIGHT, 0, KEY_ENTER, 1};
  const u32* events = reads == 1 ? frame_one : reads == 3 ? frame_three : NULL;
  u32 count = reads == 1 ? 1 : reads == 3 ? 2 : 0;
  if (!count) {
    empty_list(console_hal_read_events_memory(hal->linked), result, 4);
    return;
  }
  u32 ptr = console_hal_read_events_realloc(hal->linked, 0, 0, 4, count * 8);
  wasm_rt_memory_t* memory = console_hal_read_events_memory(hal->linked);
  unsigned char* list = memory_range(memory, ptr, count * 8);
  for (u32 i = 0; i < count; i++) {
    for (unsigned b = 0; b < 8; b++) {
      list[8 * i + b] = b < 4 ? (unsigned char)(events[2 * i] >> (8 * b)) : b == 4 ? (unsigned char)events[2 * i + 1] : 0;
    }
  }
  unsigned char* out = memory_range(memory, result, 8);
  for (unsigned b = 0; b < 4; b++) {
    out[b] = (unsigned char)(ptr >> (8 * b));
    out[4 + b] = (unsigned char)(count >> (8 * b));
  }
}

u32 console_hal_input_capabilities(console_hal_t* hal) {
  (void)hal;
  return 0;
}

void console_hal_read_mouse(console_hal_t* hal, u32 result) {
  unsigned char* state = memory_range(console_hal_read_mouse_memory(hal->linked), result, 24);
  for (unsigned i = 0; i < 24; i++) {
    state[i] = 0;
  }
}

u32 console_hal_capture_pointer(console_hal_t* hal, u32 captured) {
  (void)hal;
  (void)captured;
  return 0;
}

void console_hal_read_text(console_hal_t* hal, u32 result) {
  empty_list(console_hal_read_text_memory(hal->linked), result, 1);
}

u32 console_hal_audio_write(console_hal_t* hal, u32 ptr, u32 len) {
  (void)memory_range(console_hal_audio_write_memory(hal->linked), ptr, len * 2);
  return 0;
}

u32 console_hal_audio_queued(console_hal_t* hal) {
  (void)hal;
  return 0;
}

u64 console_hal_now_ms(console_hal_t* hal) {
  (void)hal;
  return 0;
}

u32 console_hal_file_open(console_hal_t* hal, u32 ptr, u32 len, u32 write) {
  (void)memory_range(console_hal_file_open_memory(hal->linked), ptr, len);
  (void)write;
  return (u32)-1;
}

u64 console_hal_file_size(console_hal_t* hal, u32 handle) {
  (void)hal;
  (void)handle;
  return (u64)-1;
}

void console_hal_file_read_at(console_hal_t* hal, u32 handle, u64 offset, u32 length, u32 result_ptr) {
  (void)handle;
  (void)offset;
  (void)length;
  unsigned char* result = memory_range(console_hal_file_read_at_memory(hal->linked), result_ptr, 12);
  for (unsigned i = 0; i < 12; i++) {
    result[i] = i < 4 ? 0xff : 0;
  }
  result[4] = 1; // Empty byte buffer uses an aligned dangling pointer.
}

u32 console_hal_file_write_at(console_hal_t* hal, u32 handle, u64 offset, u32 ptr, u32 len) {
  (void)handle;
  (void)offset;
  (void)memory_range(console_hal_file_write_at_memory(hal->linked), ptr, len);
  return (u32)-1;
}

void console_hal_file_close(console_hal_t* hal, u32 handle) {
  (void)hal;
  (void)handle;
}

void console_hal_file_list_directory(console_hal_t* hal, u32 ptr, u32 len, u32 result_ptr) {
  wasm_rt_memory_t* memory = console_hal_file_list_directory_memory(hal->linked);
  (void)memory_range(memory, ptr, len);
  unsigned char* result = memory_range(memory, result_ptr, 12);
  for (unsigned i = 0; i < 12; i++) {
    result[i] = i < 4 ? 0xff : 0;
  }
  result[4] = 8; // Empty entry list uses an aligned dangling pointer.
}

u32 console_hal_file_remove(console_hal_t* hal, u32 ptr, u32 len) {
  (void)memory_range(console_hal_file_remove_memory(hal->linked), ptr, len);
  return (u32)-1;
}

u32 console_hal_file_rename(console_hal_t* hal, u32 ptr, u32 len, u32 to_ptr, u32 to_len) {
  wasm_rt_memory_t* memory = console_hal_file_rename_memory(hal->linked);
  (void)memory_range(memory, ptr, len);
  (void)memory_range(memory, to_ptr, to_len);
  return (u32)-1;
}

u32 console_hal_file_create_directory(console_hal_t* hal, u32 ptr, u32 len) {
  (void)memory_range(console_hal_file_create_directory_memory(hal->linked), ptr, len);
  return (u32)-1;
}

u32 console_hal_arg_count(console_hal_t* hal) {
  (void)hal;
  return 0;
}

void console_hal_arg(console_hal_t* hal, u32 index, u32 result) {
  (void)index;
  empty_list(console_hal_arg_memory(hal->linked), result, 1);
}

void console_hal_exit(console_hal_t* hal, u32 code) {
  (void)hal;
  exit((int)(s32)code);
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
