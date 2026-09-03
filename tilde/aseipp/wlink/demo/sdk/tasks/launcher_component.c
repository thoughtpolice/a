// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The launcher: an async game's `run`, behind the `init` and `frame` every
// console package exports. `init` starts `run`, which goes on as a subtask
// once `init` has returned; each `frame` begins a frame in the scheduler,
// and the game takes its turn when the host next pumps.

#include <stdlib.h>

#include "launcher.h"

static launcher_subtask_t run;
static launcher_waitable_set_t set;
static bool over;

void exports_launcher_init(void) {
  launcher_subtask_status_t status = console_sdk_main_run();
  if (LAUNCHER_SUBTASK_STATE(status) == LAUNCHER_SUBTASK_RETURNED) {
    over = true;
    return;
  }
  run = LAUNCHER_SUBTASK_HANDLE(status);
  set = launcher_waitable_set_new();
  launcher_waitable_join(run, set);
}

bool exports_launcher_frame(uint32_t dt_ms) {
  (void)dt_ms;
  while (!over) {
    launcher_event_t event;
    launcher_waitable_set_poll(set, &event);
    if (event.event == LAUNCHER_EVENT_NONE) break;
    if (event.event != LAUNCHER_EVENT_SUBTASK) abort();
    if (event.code == LAUNCHER_SUBTASK_RETURNED) {
      over = true;
      launcher_waitable_join(run, 0);
      launcher_subtask_drop(run);
      launcher_waitable_set_drop(set);
    }
  }
  if (over) return false;
  console_scheduler_frames_begin();
  return true;
}
