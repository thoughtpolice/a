// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The scheduler: `console:sdk/tasks` over the platform's clock and files.
//
// Its exports are lifted with callbacks, so a waiting task costs a record
// and returns to the runtime's scheduler rather than holding a stack. A task
// in `frames` or `sleep` waits for one byte on a stream of its own, which
// `begin` writes when the wait is over: the stream is only a way to be woken,
// since a component has no other waitable it can complete for itself. A load
// moves a budget of the file's bytes into its stream at the start of every
// frame, as far as the game has read.

#include <stdlib.h>

#include "scheduler.h"

typedef exports_console_sdk_tasks_stream_u8_t reader_t;
typedef exports_console_sdk_tasks_stream_u8_writer_t writer_t;

// A task in `frames` or `sleep`, until `begin` has woken it.
typedef struct waiter {
  struct waiter* next;
  // The frame, or the clock's millisecond, it waits for.
  uint64_t due;
  bool by_clock;
  reader_t reader;
  writer_t writer;
  scheduler_waitable_set_t set;
  // Where the byte that wakes it lands.
  uint8_t byte;
  void (*done)(void);
} waiter_t;

// The bytes a load moves into its stream each frame.
#define LOAD_BUDGET 65536

typedef struct load {
  struct load* next;
  console_sdk_files_own_file_t file;
  uint64_t size;
  uint64_t offset;
  writer_t writer;
  // The bytes read from the file and not yet taken by the game.
  scheduler_list_u8_t chunk;
  size_t sent;
  // A write of `chunk` from `sent` is pending.
  bool writing;
  bool over;
} load_t;

static waiter_t* waiters;
static load_t* loads;
// The frames begun so far.
static uint64_t frame;
// The set a pending write of a load waits in, for `begin` to poll.
static scheduler_waitable_set_t load_writes;

static scheduler_callback_code_t wait_until(uint64_t due, bool by_clock, void (*done)(void)) {
  waiter_t* waiter = calloc(1, sizeof *waiter);
  if (!waiter) abort();
  waiter->due = due;
  waiter->by_clock = by_clock;
  waiter->done = done;
  waiter->reader = exports_console_sdk_tasks_stream_u8_new(&waiter->writer);
  if (exports_console_sdk_tasks_stream_u8_read(waiter->reader, &waiter->byte, 1) !=
      SCHEDULER_WAITABLE_STATUS_BLOCKED) {
    abort();
  }
  waiter->set = scheduler_waitable_set_new();
  scheduler_waitable_join(waiter->reader, waiter->set);
  waiter->next = waiters;
  waiters = waiter;
  scheduler_context_set_0(waiter);
  return SCHEDULER_CALLBACK_CODE_WAIT(waiter->set);
}

static void unlink_waiter(waiter_t* waiter) {
  for (waiter_t** at = &waiters; *at; at = &(*at)->next) {
    if (*at == waiter) {
      *at = waiter->next;
      return;
    }
  }
}

// The wait is over, or the caller cancelled it.
static scheduler_callback_code_t woken(scheduler_event_t* event) {
  waiter_t* waiter = scheduler_context_get_0();
  bool cancelled = event->event == SCHEDULER_EVENT_CANCEL;
  if (!cancelled && event->event != SCHEDULER_EVENT_STREAM_READ) abort();
  scheduler_waitable_join(waiter->reader, 0);
  if (cancelled) {
    // The read is pending, or complete with its event not yet taken.
    exports_console_sdk_tasks_stream_u8_cancel_read(waiter->reader);
    if (waiter->writer) {
      unlink_waiter(waiter);
      exports_console_sdk_tasks_stream_u8_drop_writable(waiter->writer);
    }
  }
  exports_console_sdk_tasks_stream_u8_drop_readable(waiter->reader);
  scheduler_waitable_set_drop(waiter->set);
  void (*done)(void) = waiter->done;
  free(waiter);
  scheduler_context_set_0(NULL);
  if (cancelled) {
    scheduler_task_cancel();
  } else {
    done();
  }
  return SCHEDULER_CALLBACK_CODE_EXIT;
}

scheduler_callback_code_t exports_console_sdk_tasks_frames(uint32_t count) {
  if (count == 0) {
    exports_console_sdk_tasks_frames_return();
    return SCHEDULER_CALLBACK_CODE_EXIT;
  }
  return wait_until(frame + count, false, exports_console_sdk_tasks_frames_return);
}

scheduler_callback_code_t exports_console_sdk_tasks_frames_callback(scheduler_event_t* event) {
  return woken(event);
}

scheduler_callback_code_t exports_console_sdk_tasks_sleep(uint32_t ms) {
  if (ms == 0) {
    exports_console_sdk_tasks_sleep_return();
    return SCHEDULER_CALLBACK_CODE_EXIT;
  }
  return wait_until(console_sdk_clock_now_ms() + ms, true, exports_console_sdk_tasks_sleep_return);
}

scheduler_callback_code_t exports_console_sdk_tasks_sleep_callback(scheduler_event_t* event) {
  return woken(event);
}

bool exports_console_sdk_tasks_load(scheduler_string_t* path, reader_t* ret) {
  console_sdk_files_own_file_t file;
  bool opened = console_sdk_files_open(path, false, &file);
  scheduler_string_free(path);
  if (!opened) return false;
  int64_t size = console_sdk_files_method_file_size(console_sdk_files_borrow_file(file));
  if (size < 0) {
    console_sdk_files_file_drop_own(file);
    return false;
  }
  load_t* load = calloc(1, sizeof *load);
  if (!load) abort();
  load->file = file;
  load->size = (uint64_t)size;
  *ret = exports_console_sdk_tasks_stream_u8_new(&load->writer);
  load->next = loads;
  loads = load;
  return true;
}

// Takes the result of a write of `load`'s chunk.
static void wrote(load_t* load, scheduler_waitable_status_t status) {
  load->sent += SCHEDULER_WAITABLE_COUNT(status);
  if (load->sent == load->chunk.len) {
    scheduler_list_u8_free(&load->chunk);
    load->chunk.len = 0;
    load->sent = 0;
  }
  // The game dropped its end: nobody will read the rest.
  if (SCHEDULER_WAITABLE_STATE(status) == SCHEDULER_WAITABLE_DROPPED) load->over = true;
}

// Moves up to a budget of `load`'s bytes into its stream, as far as the game
// takes them; a write the game has not taken yet stays pending.
static void advance(load_t* load) {
  size_t budget = LOAD_BUDGET;
  while (!load->writing && !load->over && budget) {
    if (load->sent == load->chunk.len) {
      if (load->offset == load->size) {
        load->over = true;
        break;
      }
      uint64_t left = load->size - load->offset;
      uint32_t want = left < budget ? (uint32_t)left : (uint32_t)budget;
      if (!console_sdk_files_method_file_read_at(console_sdk_files_borrow_file(load->file),
                                                 load->offset, want, &load->chunk) ||
          load->chunk.len == 0) {
        // The file failed or shrank: the stream ends where it got to.
        scheduler_list_u8_free(&load->chunk);
        load->chunk.len = 0;
        load->over = true;
        break;
      }
      load->offset += load->chunk.len;
      load->sent = 0;
    }
    size_t left = load->chunk.len - load->sent;
    size_t amount = left < budget ? left : budget;
    budget -= amount;
    scheduler_waitable_status_t status =
        exports_console_sdk_tasks_stream_u8_write(load->writer, load->chunk.ptr + load->sent, amount);
    if (status == SCHEDULER_WAITABLE_STATUS_BLOCKED) {
      load->writing = true;
      if (!load_writes) load_writes = scheduler_waitable_set_new();
      scheduler_waitable_join(load->writer, load_writes);
    } else {
      wrote(load, status);
    }
  }
}

static load_t* load_writing(uint32_t writer) {
  for (load_t* load = loads; load; load = load->next) {
    if (load->writing && load->writer == writer) return load;
  }
  abort();
}

void exports_console_scheduler_frames_begin(void) {
  frame++;
  uint64_t now = console_sdk_clock_now_ms();
  for (waiter_t** at = &waiters; *at;) {
    waiter_t* waiter = *at;
    if (waiter->by_clock ? now < waiter->due : frame < waiter->due) {
      at = &waiter->next;
      continue;
    }
    static const uint8_t one = 1;
    exports_console_sdk_tasks_stream_u8_write(waiter->writer, &one, 1);
    exports_console_sdk_tasks_stream_u8_drop_writable(waiter->writer);
    waiter->writer = 0;
    *at = waiter->next;
  }

  // The writes the game has taken since the last frame.
  if (load_writes) {
    for (;;) {
      scheduler_event_t event;
      scheduler_waitable_set_poll(load_writes, &event);
      if (event.event == SCHEDULER_EVENT_NONE) break;
      if (event.event != SCHEDULER_EVENT_STREAM_WRITE) abort();
      load_t* load = load_writing(event.waitable);
      scheduler_waitable_join(load->writer, 0);
      load->writing = false;
      wrote(load, event.code);
    }
  }
  for (load_t** at = &loads; *at;) {
    load_t* load = *at;
    advance(load);
    if (!load->over || load->writing) {
      at = &load->next;
      continue;
    }
    scheduler_list_u8_free(&load->chunk);
    exports_console_sdk_tasks_stream_u8_drop_writable(load->writer);
    console_sdk_files_file_drop_own(load->file);
    *at = load->next;
    free(load);
  }
}
