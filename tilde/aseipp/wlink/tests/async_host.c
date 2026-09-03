// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A host for tests/host_async.wat through wasm2c: it implements the async
// imports, resolving them later through `wlink:async:resolve`, calls the
// async exports and takes their results from `wlink:task-return`, runs
// the scheduler with `wlink:async:pump`, finishes its work when a
// synchronous wait asks, and cancels in both directions.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "host_async.h"
#include "wasm-rt-exceptions.h"
#include "wasm-rt-impl.h"

#define CHECK(condition) do { \
  if (!(condition)) { \
    fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
    abort(); \
  } \
} while (0)

static w2c_host__async linked;

static u32 load_u32(wasm_rt_memory_t* memory, u32 ptr) {
  CHECK((u64)ptr + 4 <= memory->size);
  u32 value;
  memcpy(&value, memory->data + ptr, 4);
  return value;
}

static void store_u32(wasm_rt_memory_t* memory, u32 ptr, u32 value) {
  CHECK((u64)ptr + 4 <= memory->size);
  memcpy(memory->data + ptr, &value, 4);
}

// An async import the host has started and not resolved: the subtask it
// runs as, where its result goes, and what it computes it from.
typedef struct {
  u32 subtask;
  u32 out;
  int echo;
  u32 n;
  char text[64];
  u32 length;
} Pending;

static Pending pending[64];
static int pending_count;

struct w2c_host0x3Aasync0x2Fio {
  u32 fetches;
};

// fetch(n) is n * 10, at once for 0 and later for anything else.
u32 w2c_host0x3Aasync0x2Fio_fetch(struct w2c_host0x3Aasync0x2Fio* io, u32 subtask, u32 n,
                                  u32 out) {
  io->fetches += 1;
  if (n == 0) {
    store_u32(w2c_host__async_wlink0x3Aimport0x3Ahost0x3Aasync0x2Fio0x23fetch0x3Amemory(&linked),
              out, 0);
    return 2;  // RETURNED
  }
  CHECK(pending_count < 64);
  pending[pending_count++] = (Pending){subtask, out, 0, n, {0}, 0};
  return 1;  // STARTED
}

// echo(s) is s, later. The argument is read now: the caller's memory for it
// is its own again once the call has started.
u32 w2c_host0x3Aasync0x2Fio_echo(struct w2c_host0x3Aasync0x2Fio* io, u32 subtask, u32 ptr,
                                 u32 len, u32 out) {
  (void)io;
  wasm_rt_memory_t* memory =
      w2c_host__async_wlink0x3Aimport0x3Ahost0x3Aasync0x2Fio0x23echo0x3Amemory(&linked);
  CHECK(len < 64 && (u64)ptr + len <= memory->size);
  Pending call = {subtask, out, 1, 0, {0}, len};
  memcpy(call.text, memory->data + ptr, len);
  CHECK(pending_count < 64);
  pending[pending_count++] = call;
  return 1;  // STARTED
}

// delay is lowered synchronously, so the host implements it synchronously.
u32 w2c_host0x3Aasync0x2Fio_delay(struct w2c_host0x3Aasync0x2Fio* io, u32 n) {
  (void)io;
  return n + 1;
}

// Writes the result of pending call `index` and resolves its subtask.
static void resolve(int index) {
  Pending call = pending[index];
  pending[index] = pending[--pending_count];
  if (call.echo) {
    wasm_rt_memory_t* memory =
        w2c_host__async_wlink0x3Aimport0x3Ahost0x3Aasync0x2Fio0x23echo0x3Amemory(&linked);
    u32 ptr = w2c_host__async_wlink0x3Aimport0x3Ahost0x3Aasync0x2Fio0x23echo0x3Arealloc(
        &linked, 0, 0, 1, call.length);
    CHECK((u64)ptr + call.length <= memory->size);
    memcpy(memory->data + ptr, call.text, call.length);
    store_u32(memory, call.out, ptr);
    store_u32(memory, call.out + 4, call.length);
  } else {
    store_u32(w2c_host__async_wlink0x3Aimport0x3Ahost0x3Aasync0x2Fio0x23fetch0x3Amemory(&linked),
              call.out, call.n * 10);
  }
  w2c_host__async_wlink0x3Aasync0x3Aresolve(&linked, call.subtask, 2);
}

struct w2c_wlink0x3Aasync {
  u32 waits;
  u32 cancels;
  u32 cancelled_task;
  u32 cancelled_state;
};

// A synchronous wait needs the host's work done: all of it, most recent
// first.
u32 w2c_wlink0x3Aasync_wait(struct w2c_wlink0x3Aasync* async) {
  async->waits += 1;
  if (pending_count == 0) {
    return 0;
  }
  while (pending_count > 0) {
    resolve(pending_count - 1);
  }
  return 1;
}

// A component cancels a call the host is running: it stops at once.
void w2c_wlink0x3Aasync_cancel(struct w2c_wlink0x3Aasync* async, u32 subtask) {
  async->cancels += 1;
  for (int index = 0; index < pending_count; index++) {
    if (pending[index].subtask == subtask) {
      pending[index] = pending[--pending_count];
      w2c_host__async_wlink0x3Aasync0x3Aresolve(&linked, subtask, 4);
      return;
    }
  }
  CHECK(!"cancelled a call the host is not running");
}

void w2c_wlink0x3Aasync_task0x2Dcancelled(struct w2c_wlink0x3Aasync* async, u32 task,
                                          u32 state) {
  async->cancelled_task = task;
  async->cancelled_state = state;
}

struct w2c_wlink0x3Atask0x2Dreturn {
  u32 total_task;
  u32 total_value;
  u32 totals;
  u32 shout_task;
  char shout[64];
  u32 shouts;
  u32 spinner_task;
  u32 spinner_value;
  u32 spins;
};

void w2c_wlink0x3Atask0x2Dreturn_total(struct w2c_wlink0x3Atask0x2Dreturn* results, u32 task,
                                       u32 value) {
  results->total_task = task;
  results->total_value = value;
  results->totals += 1;
}

// The string is in the component's memory for the duration of this call.
void w2c_wlink0x3Atask0x2Dreturn_shout(struct w2c_wlink0x3Atask0x2Dreturn* results, u32 task,
                                       u32 ptr, u32 len) {
  wasm_rt_memory_t* memory = w2c_host__async_wlink0x3Aexport0x3Ashout0x3Amemory(&linked);
  CHECK(len < 64 && (u64)ptr + len <= memory->size);
  memcpy(results->shout, memory->data + ptr, len);
  results->shout[len] = 0;
  results->shout_task = task;
  results->shouts += 1;
}

void w2c_wlink0x3Atask0x2Dreturn_spinner(struct w2c_wlink0x3Atask0x2Dreturn* results, u32 task,
                                         u32 value) {
  results->spinner_task = task;
  results->spinner_value = value;
  results->spins += 1;
}

void w2c_wlink0x3Atask0x2Dreturn_sleepy(struct w2c_wlink0x3Atask0x2Dreturn* results, u32 task,
                                        u32 value) {
  (void)results;
  (void)task;
  (void)value;
  CHECK(!"sleepy returned instead of being cancelled");
}

// The live entries of the handle table: tasks, subtasks, waitable sets and
// the rest that have not been freed.
static u32 live_entries(void) {
  wasm_rt_memory_t* handles = w2c_host__async_wlink0x3Ahandles(&linked);
  u32 length = load_u32(handles, 0);
  u32 live = 0;
  for (u32 index = 1; index <= length; index++) {
    if (load_u32(handles, 32 + 64 * index) != 0) {
      live += 1;
    }
  }
  return live;
}

// Runs the scheduler until no task can run: each pump gives every ready
// task one turn.
static void settle(void) {
  while (w2c_host__async_wlink0x3Aasync0x3Apump(&linked)) {
  }
}

static u64 random_state = 0x9e3779b97f4a7c15ull;

static u32 next_random(u32 bound) {
  random_state ^= random_state << 13;
  random_state ^= random_state >> 7;
  random_state ^= random_state << 17;
  return (u32)(random_state % bound);
}

int main(void) {
  wasm_rt_init();
  struct w2c_host0x3Aasync0x2Fio io = {0};
  struct w2c_wlink0x3Aasync async = {0};
  struct w2c_wlink0x3Atask0x2Dreturn results = {0};
  wasm2c_host__async_instantiate(&linked, &io, &async, &results);

  // total(4): fetch(0) returns at once and the others wait for the host,
  // which resolves them out of order, running the scheduler after each.
  u32 status = w2c_host__async_total(&linked, 4);
  CHECK((status & 15) == 1);  // STARTED
  u32 task = status >> 4;
  CHECK(pending_count == 3 && io.fetches == 4 && results.totals == 0);
  resolve(1);
  CHECK(w2c_host__async_wlink0x3Aasync0x3Apump(&linked) == 0);
  CHECK(results.totals == 0);
  // Two events for one task: a pump gives it one turn, and says so.
  resolve(0);
  resolve(0);
  CHECK(w2c_host__async_wlink0x3Aasync0x3Apump(&linked) == 1);
  CHECK(results.totals == 0);
  CHECK(w2c_host__async_wlink0x3Aasync0x3Apump(&linked) == 0);
  CHECK(results.totals == 1 && results.total_task == task && results.total_value == 60);
  CHECK(live_entries() == 0);

  // shout("hey"): the argument goes through the export's allocator, the
  // result comes back through `task-return` while it is in the
  // component's memory.
  wasm_rt_memory_t* memory = w2c_host__async_wlink0x3Aexport0x3Ashout0x3Amemory(&linked);
  u32 ptr = w2c_host__async_wlink0x3Aexport0x3Ashout0x3Arealloc(&linked, 0, 0, 1, 3);
  memcpy(memory->data + ptr, "hey", 3);
  status = w2c_host__async_shout(&linked, ptr, 3);
  CHECK((status & 15) == 1);
  CHECK(pending_count == 1 && pending[0].echo && pending[0].length == 3);
  resolve(0);
  settle();
  CHECK(results.shouts == 1 && results.shout_task == status >> 4);
  CHECK(strcmp(results.shout, "HEY") == 0);
  CHECK(live_entries() == 0);

  // blocking(7) waits synchronously for its fetch: the runtime asks the
  // host to finish its work.
  CHECK(w2c_host__async_blocking(&linked, 7) == 140);
  CHECK(async.waits == 1 && pending_count == 0);
  CHECK(live_entries() == 0);

  // spinner(3) only yields: each pump gives it a turn, and none says it
  // has more to do, so a host pumping until 0 stops after every one.
  status = w2c_host__async_spinner(&linked, 3);
  CHECK((status & 15) == 1);
  CHECK(w2c_host__async_wlink0x3Aasync0x3Apump(&linked) == 0);
  CHECK(results.spins == 0);
  CHECK(w2c_host__async_wlink0x3Aasync0x3Apump(&linked) == 0);
  CHECK(results.spins == 1 && results.spinner_value == 3 && results.spinner_task == status >> 4);
  CHECK(live_entries() == 0);

  // delayed(5) calls an import lowered synchronously.
  CHECK(w2c_host__async_delayed(&linked, 5) == 6);

  // sleepy() waits for a fetch that never comes; the host cancels it, and
  // it cancels its fetch, which the host stops at once, before confirming.
  status = w2c_host__async_sleepy(&linked);
  CHECK((status & 15) == 1 && pending_count == 1);
  w2c_host__async_wlink0x3Aasync0x3Acancel(&linked, status >> 4);
  CHECK(async.cancels == 1 && pending_count == 0);
  CHECK(async.cancelled_task == status >> 4 && async.cancelled_state == 4);
  CHECK(live_entries() == 0);

  // Rounds of total(n), resolved in random orders with the scheduler run
  // at random points, leave nothing behind.
  for (int round = 0; round < 200; round++) {
    u32 n = 1 + next_random(8);
    u32 before = results.totals;
    status = w2c_host__async_total(&linked, n);
    if (n == 1) {
      CHECK(status == 2);  // fetch(0) alone returns at once
    } else {
      CHECK((status & 15) == 1);
    }
    while (pending_count > 0) {
      resolve((int)next_random((u32)pending_count));
      if (next_random(2)) {
        w2c_host__async_wlink0x3Aasync0x3Apump(&linked);
      }
    }
    settle();
    CHECK(results.totals == before + 1);
    CHECK(results.total_value == 10 * n * (n - 1) / 2);
    CHECK(live_entries() == 0);
  }

  // Resolving a subtask the host is not running is a host error: a trap,
  // with its reason in `wlink:async:trap`.
  wasm_rt_trap_t trap = wasm_rt_impl_try();
  if (trap == 0) {
    w2c_host__async_wlink0x3Aasync0x3Aresolve(&linked, 12345, 2);
    CHECK(!"resolving an unknown subtask did not trap");
  }
  CHECK(trap == WASM_RT_TRAP_UNREACHABLE);
  CHECK(*w2c_host__async_wlink0x3Aasync0x3Atrap(&linked) == 16);

  wasm2c_host__async_free(&linked);
  wasm_rt_free();
  printf("async host ok\n");
  return 0;
}
