// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// An async game that checks `console:sdk/tasks` from the inside: one `run`
// task with a ticker waiting a frame at a time and drawing each frame, a
// three-frame wait, a 100 ms sleep, waits of zero, a wait it cancels, a
// streamed load it checks byte for byte, a load it abandons, and a file that
// is not there, all in flight at once. Every step is logged with the frame
// and the clock, and `test-contract` runs the game under the native runner
// and the web core and compares the two. `--quick` returns from `run` at
// once, and `--misuse` breaks the canonical ABI, which traps.

#include <stdlib.h>
#include <string.h>

#include "async_game.h"

typedef async_game_subtask_t subtask_t;
typedef console_sdk_tasks_stream_u8_t reader_t;

// The frames the ticker draws before the game returns.
#define TURNS 12
#define ASSET "tasks/asset.bin"
#define ASSET_SIZE 150000
#define READ_SIZE 40000

static async_game_waitable_set_t set;
static subtask_t ticker, countdown, nap;
static reader_t asset, abandoned;
static uint8_t* buffer;
static uint32_t turns, loaded, sum, expected_sum;
static int pending;

static uint8_t asset_byte(uint32_t index) {
  return (uint8_t)(index * 31 + 7);
}

static void say(const char* text) {
  async_game_string_t message;
  async_game_string_set(&message, text);
  console_sdk_log_log(CONSOLE_SDK_LOG_LEVEL_INFO, &message);
}

// Appends the decimal digits of `value` at `at`: the new end.
static char* digits(char* at, uint64_t value) {
  char reversed[20];
  int count = 0;
  do {
    reversed[count++] = (char)('0' + value % 10);
    value /= 10;
  } while (value);
  while (count) *at++ = reversed[--count];
  return at;
}

static char* append(char* at, const char* text) {
  size_t length = strlen(text);
  memcpy(at, text, length);
  return at + length;
}

// Logs `what` with the frames ended so far and the clock.
static void event(const char* what, uint64_t value) {
  char line[128];
  char* at = append(line, "tasks: ");
  at = append(at, what);
  at = append(at, " ");
  at = digits(at, value);
  at = append(at, " frame=");
  at = digits(at, console_sdk_clock_frame());
  at = append(at, " now=");
  at = digits(at, console_sdk_clock_now_ms());
  *at = 0;
  say(line);
}

static void fail(const char* what) {
  event(what, 0);
  console_sdk_process_exit(3);
}

// Starts an async call: its subtask, joined to the set, or 0 when it
// returned at once.
static subtask_t started(async_game_subtask_status_t status) {
  if (ASYNC_GAME_SUBTASK_STATE(status) == ASYNC_GAME_SUBTASK_RETURNED) return 0;
  subtask_t subtask = ASYNC_GAME_SUBTASK_HANDLE(status);
  async_game_waitable_join(subtask, set);
  pending++;
  return subtask;
}

static void finished(subtask_t subtask) {
  async_game_waitable_join(subtask, 0);
  async_game_subtask_drop(subtask);
  pending--;
}

// Reads `reader` into the buffer until a read has to wait: whether the
// stream is still open.
static bool read_asset(void) {
  for (;;) {
    async_game_waitable_status_t status = console_sdk_tasks_stream_u8_read(asset, buffer, READ_SIZE);
    if (status == ASYNC_GAME_WAITABLE_STATUS_BLOCKED) return true;
    uint32_t count = ASYNC_GAME_WAITABLE_COUNT(status);
    for (uint32_t i = 0; i < count; i++) sum += buffer[i];
    loaded += count;
    if (ASYNC_GAME_WAITABLE_STATE(status) == ASYNC_GAME_WAITABLE_DROPPED) return false;
  }
}

static void asset_done(void) {
  if (loaded != ASSET_SIZE || sum != expected_sum) fail("load mismatch");
  event("load complete", loaded);
  async_game_waitable_join(asset, 0);
  console_sdk_tasks_stream_u8_drop_readable(asset);
  asset = 0;
  pending--;
}

static void draw(void) {
  console_sdk_gfx_color_t background = {(uint8_t)(turns * 20), 40, (uint8_t)(loaded >> 10), 255};
  console_sdk_gfx_clear(&background);
  console_sdk_gfx_color_t ink = {255, 255, 255, 255};
  char text[32];
  char* at = append(text, "TURN ");
  at = digits(at, turns);
  *at = 0;
  async_game_string_t line;
  async_game_string_set(&line, text);
  console_sdk_gfx_draw_text(4, 4, &line, &ink);
}

// The end of the game: every wait is over.
static async_game_callback_code_t finish(void) {
  async_game_waitable_set_drop(set);
  free(buffer);
  say("tasks: run returns");
  exports_console_sdk_main_run_return();
  return ASYNC_GAME_CALLBACK_CODE_EXIT;
}

static async_game_callback_code_t next(void) {
  if (turns >= TURNS && pending == 0) return finish();
  return ASYNC_GAME_CALLBACK_CODE_WAIT(set);
}

// Whether the guest argument after the program name is `flag`.
static bool argument(const char* flag) {
  if (console_sdk_process_arg_count() < 2) return false;
  async_game_string_t value;
  console_sdk_process_arg(1, &value);
  size_t length = strlen(flag);
  bool same = value.len == length && memcmp(value.ptr, flag, length) == 0;
  async_game_string_free(&value);
  return same;
}

async_game_callback_code_t exports_console_sdk_main_run(void) {
  if (argument("--quick")) {
    say("tasks: run returns at once");
    exports_console_sdk_main_run_return();
    return ASYNC_GAME_CALLBACK_CODE_EXIT;
  }
  set = async_game_waitable_set_new();
  if (argument("--misuse")) {
    // A set with a member cannot be dropped: the runtime traps, code 8.
    subtask_t member = started(console_sdk_tasks_frames(1));
    say("tasks: dropping a set in use");
    async_game_waitable_set_drop(set);
    (void)member;
  }
  buffer = malloc(READ_SIZE);
  if (!buffer) abort();
  event("run starts", 0);

  // The asset the load streams back.
  for (uint32_t i = 0; i < READ_SIZE; i++) buffer[i] = asset_byte(i);
  async_game_string_t path;
  async_game_string_set(&path, ASSET);
  console_sdk_files_own_file_t file;
  if (!console_sdk_files_open(&path, true, &file)) fail("cannot write the asset");
  for (uint32_t offset = 0; offset < ASSET_SIZE; offset += READ_SIZE) {
    uint32_t length = ASSET_SIZE - offset < READ_SIZE ? ASSET_SIZE - offset : READ_SIZE;
    for (uint32_t i = 0; i < length; i++) {
      buffer[i] = asset_byte(offset + i);
      expected_sum += buffer[i];
    }
    async_game_list_u8_t data = {buffer, length};
    if (console_sdk_files_method_file_write_at(console_sdk_files_borrow_file(file), offset, &data) !=
        (int32_t)length) {
      fail("cannot write the asset");
    }
  }
  console_sdk_files_file_drop_own(file);

  // Waits of zero return at once.
  if (started(console_sdk_tasks_frames(0)) || started(console_sdk_tasks_sleep(0))) {
    fail("a wait of zero waited");
  }
  event("zero waits return", 0);

  // A wait cancelled before it is over, synchronously, so outside the set.
  async_game_subtask_status_t status = console_sdk_tasks_frames(1000);
  if (ASYNC_GAME_SUBTASK_STATE(status) != ASYNC_GAME_SUBTASK_STARTED) fail("frames(1000) did not wait");
  subtask_t doomed = ASYNC_GAME_SUBTASK_HANDLE(status);
  async_game_subtask_status_t cancelled = async_game_subtask_cancel(doomed);
  if (ASYNC_GAME_SUBTASK_STATE(cancelled) != ASYNC_GAME_SUBTASK_RETURNED_CANCELLED) {
    fail("the cancelled wait did not end cancelled");
  }
  async_game_subtask_drop(doomed);
  event("cancelled wait", ASYNC_GAME_SUBTASK_STATE(cancelled));

  async_game_string_set(&path, "tasks/missing.bin");
  reader_t missing;
  if (console_sdk_tasks_load(&path, &missing)) fail("a missing file loaded");
  event("missing load refused", 0);

  countdown = started(console_sdk_tasks_frames(3));
  nap = started(console_sdk_tasks_sleep(100));
  ticker = started(console_sdk_tasks_frames(1));
  if (!countdown || !nap || !ticker) fail("a wait returned at once");

  async_game_string_set(&path, ASSET);
  if (!console_sdk_tasks_load(&path, &asset)) fail("the asset did not load");
  if (!read_asset()) fail("the asset ended at once");
  async_game_waitable_join(asset, set);
  pending++;

  // A load abandoned before it is read: the scheduler hears of the drop.
  if (!console_sdk_tasks_load(&path, &abandoned)) fail("the second load did not open");
  console_sdk_tasks_stream_u8_drop_readable(abandoned);
  return next();
}

async_game_callback_code_t exports_console_sdk_main_run_callback(async_game_event_t* event_) {
  if (event_->event == ASYNC_GAME_EVENT_SUBTASK) {
    if (event_->code != ASYNC_GAME_SUBTASK_RETURNED) fail("a wait did not return");
    subtask_t subtask = event_->waitable;
    finished(subtask);
    if (subtask == ticker) {
      turns++;
      draw();
      event("turn", turns);
      ticker = turns < TURNS ? started(console_sdk_tasks_frames(1)) : 0;
    } else if (subtask == countdown) {
      event("frames(3) woke", 3);
      countdown = 0;
    } else if (subtask == nap) {
      event("sleep(100) woke", 100);
      nap = 0;
    } else {
      fail("an unknown subtask returned");
    }
    return next();
  }
  if (event_->event == ASYNC_GAME_EVENT_STREAM_READ && event_->waitable == asset) {
    uint32_t count = ASYNC_GAME_WAITABLE_COUNT(event_->code);
    for (uint32_t i = 0; i < count; i++) sum += buffer[i];
    loaded += count;
    event("loaded", loaded);
    if (ASYNC_GAME_WAITABLE_STATE(event_->code) == ASYNC_GAME_WAITABLE_DROPPED || !read_asset()) {
      asset_done();
    }
    return next();
  }
  fail("an unexpected event");
  return ASYNC_GAME_CALLBACK_CODE_EXIT;
}
