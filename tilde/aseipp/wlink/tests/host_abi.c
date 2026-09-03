// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "host_abi.h"
#include "wasm-rt-exceptions.h"
#include "wasm-rt-impl.h"

#define CHECK(condition) do { \
  if (!(condition)) { \
    fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
    abort(); \
  } \
} while (0)

struct w2c_host {
  w2c_host__abi* linked;
};

// The host implements `stream`: it deals in representations, never in the
// component's handles. Every stream it opens is `id * 10`.
struct w2c_host0x3Ares0x2Fstreams {
  u32 opened;
  u32 dropped;
};

u32 w2c_host0x3Ares0x2Fstreams_open(struct w2c_host0x3Ares0x2Fstreams* streams, u32 id) {
  streams->opened += 1;
  return id * 10;
}

u32 w2c_host0x3Ares0x2Fstreams_read(struct w2c_host0x3Ares0x2Fstreams* streams, u32 rep) {
  (void)streams;
  return rep + 1;
}

void w2c_host0x3Ares0x2Fstreams_0x5Bresource0x2Ddrop0x5Dstream(
    struct w2c_host0x3Ares0x2Fstreams* streams, u32 rep) {
  streams->dropped += rep;
}

static u32 read_byte(wasm_rt_memory_t* memory, u32 ptr, u32 len) {
  CHECK(len == 1 && (u64)ptr + len <= memory->size);
  return memory->data[ptr];
}

u32 w2c_host_read0x24lower0(struct w2c_host* host, u32 ptr, u32 len) {
  return read_byte(
      w2c_host__abi_wlink0x3Aimport0x3Ahost0x23read0x24lower00x3Amemory(host->linked),
      ptr, len);
}

u32 w2c_host_read0x24lower1(struct w2c_host* host, u32 ptr, u32 len) {
  return read_byte(
      w2c_host__abi_wlink0x3Aimport0x3Ahost0x23read0x24lower10x3Amemory(host->linked),
      ptr, len);
}

static u32 load_u32(wasm_rt_memory_t* memory, u32 ptr) {
  CHECK((u64)ptr + 4 <= memory->size);
  return (u32)memory->data[ptr] | (u32)memory->data[ptr + 1] << 8 |
         (u32)memory->data[ptr + 2] << 16 | (u32)memory->data[ptr + 3] << 24;
}

// The host implements `item`, whose handles the component passes inside a
// list, inside a list of records, and in a parameter list that spills, so
// every one reaches the host as a word of the component's memory. An item's
// representation is `id * 1000 + 7`, which no handle index can be, so a
// word that was not rewritten is caught.
struct w2c_host0x3Ares0x2Fpool {
  w2c_host__abi* linked;
  u32 opened;
  u32 dropped;
  u32 taken;
  u32 reenter;
};

static u32 item_id(u32 rep) {
  CHECK(rep % 1000 == 7);
  return rep / 1000;
}

// The ids of the items whose representations sit `stride` bytes apart, each
// in the last word of its element.
static u32 sum_ids(wasm_rt_memory_t* memory, u32 ptr, u32 len, u32 stride) {
  u32 total = 0;
  for (u32 i = 0; i < len; i++) {
    total += item_id(load_u32(memory, ptr + i * stride + stride - 4));
  }
  return total;
}

u32 w2c_host0x3Ares0x2Fpool_open(struct w2c_host0x3Ares0x2Fpool* pool, u32 id) {
  pool->opened += 1;
  return id * 1000 + 7;
}

void w2c_host0x3Ares0x2Fpool_0x5Bresource0x2Ddrop0x5Ditem(
    struct w2c_host0x3Ares0x2Fpool* pool, u32 rep) {
  pool->dropped += item_id(rep);
}

u32 w2c_host0x3Ares0x2Fpool_sum0x2Dall(struct w2c_host0x3Ares0x2Fpool* pool, u32 ptr, u32 len) {
  u32 total = sum_ids(
      w2c_host__abi_wlink0x3Aimport0x3Ahost0x3Ares0x2Fpool0x23sum0x2Dall0x3Amemory(pool->linked),
      ptr, len, 4);
  if (pool->reenter) {
    // The first item is lent to this call, so dropping it traps and control
    // never comes back here.
    w2c_host__abi_pool0x2Ddrop(pool->linked, 0);
    CHECK(!"a lent handle was dropped");
  }
  return total;
}

u32 w2c_host0x3Ares0x2Fpool_take0x2Dall(struct w2c_host0x3Ares0x2Fpool* pool, u32 ptr, u32 len) {
  pool->taken += len;
  return sum_ids(
      w2c_host__abi_wlink0x3Aimport0x3Ahost0x3Ares0x2Fpool0x23take0x2Dall0x3Amemory(pool->linked),
      ptr, len, 4);
}

u32 w2c_host0x3Ares0x2Fpool_describe(struct w2c_host0x3Ares0x2Fpool* pool, u32 ptr, u32 len) {
  wasm_rt_memory_t* memory =
      w2c_host__abi_wlink0x3Aimport0x3Ahost0x3Ares0x2Fpool0x23describe0x3Amemory(pool->linked);
  u32 total = sum_ids(memory, ptr, len, 8);
  for (u32 i = 0; i < len; i++) {
    total += load_u32(memory, ptr + i * 8);
  }
  return total;
}

u32 w2c_host0x3Ares0x2Fpool_wide(struct w2c_host0x3Ares0x2Fpool* pool, u32 ptr) {
  wasm_rt_memory_t* memory =
      w2c_host__abi_wlink0x3Aimport0x3Ahost0x3Ares0x2Fpool0x23wide0x3Amemory(pool->linked);
  u32 total = 0;
  for (u32 i = 0; i < 16; i++) {
    total += load_u32(memory, ptr + i * 4);
  }
  return total + item_id(load_u32(memory, ptr + 64));
}

int main(void) {
  wasm_rt_init();
  w2c_host__abi linked;
  struct w2c_host host = {&linked};
  struct w2c_host0x3Ares0x2Fpool pool = {&linked, 0, 0, 0, 0};
  struct w2c_host0x3Ares0x2Fstreams streams = {0, 0};
  wasm2c_host__abi_instantiate(&linked, &host, &pool, &streams);

  // Both callers pass (0, 1); the import identifies which memory to read.
  CHECK(w2c_host__abi_run0x2Da(&linked) == 2 * 'a');
  CHECK(w2c_host__abi_run0x2Db(&linked) == 2 * 'b');
  CHECK(w2c_host__abi_run0x2Da(&linked) == 2 * 'a');

  wasm_rt_memory_t* memory =
      w2c_host__abi_wlink0x3Aexport0x3Aname0x3Amemory(&linked);
  u32 result = w2c_host__abi_name(&linked);
  u32 ptr = load_u32(memory, result);
  u32 len = load_u32(memory, result + 4);
  CHECK(len == 3 && (u64)ptr + len <= memory->size);
  CHECK(memcmp(memory->data + ptr, "abc", len) == 0);
  CHECK(w2c_host__abi_count(&linked) == 0);

  // Cleanup is explicit: the returned string remains readable until this call.
  w2c_host__abi_cabi_post_name(&linked, result);
  CHECK(w2c_host__abi_count(&linked) == 1);
  CHECK(memory->data[ptr] == 0);

  // Allocate an incoming argument using this export's canonical allocator.
  memory = w2c_host__abi_wlink0x3Aexport0x3Agreet0x3Amemory(&linked);
  ptr = w2c_host__abi_wlink0x3Aexport0x3Agreet0x3Arealloc(&linked, 0, 0, 1, 1);
  CHECK(ptr < memory->size);
  memory->data[ptr] = 'z';
  CHECK(w2c_host__abi_greet(&linked, ptr, 1) == 'z');

  // A counter the component implements reaches the host as its
  // representation: make lifts the owned handle out of the table, value
  // takes a borrow straight to the implementor, and consume gives ownership
  // back so the component's destructor runs.
  CHECK(w2c_host__abi_host0x3Ares0x2Fcounters0x23make(&linked, 5) == 5);
  CHECK(w2c_host__abi_host0x3Ares0x2Fcounters0x23value(&linked, 5) == 5);
  CHECK(w2c_host__abi_host0x3Ares0x2Fcounters0x23consume(&linked, 7) == 7);
  CHECK(w2c_host__abi_host0x3Ares0x2Fcounters0x23destroyed(&linked) == 7);
  // The host destroys the counter it still holds through the exported drop.
  w2c_host__abi_host0x3Ares0x2Fcounters0x230x5Bresource0x2Ddrop0x5Dcounter(&linked, 5);
  CHECK(w2c_host__abi_host0x3Ares0x2Fcounters0x23destroyed(&linked) == 12);

  // A stream the host implements: the component opens one, reads it through
  // a borrow, and drops it, which asks the host to destroy representation 30.
  CHECK(w2c_host__abi_probe(&linked, 3) == 31);
  CHECK(streams.opened == 1 && streams.dropped == 30);
  CHECK(w2c_host__abi_probe(&linked, 4) == 41);
  CHECK(streams.opened == 2 && streams.dropped == 70);

  // Handles reach the host through memory: an array of three items passed as
  // a list of borrows, as rows pairing them with numbers, and inside a
  // parameter list wide enough to spill. The host reads representations.
  wasm_rt_memory_t* array =
      w2c_host__abi_wlink0x3Aimport0x3Ahost0x3Ares0x2Fpool0x23sum0x2Dall0x3Amemory(&linked);
  w2c_host__abi_pool0x2Dfill(&linked, 3);
  CHECK(pool.opened == 3);
  u32 handles[3];
  for (u32 i = 0; i < 3; i++) {
    handles[i] = load_u32(array, 1024 + 4 * i);
  }
  CHECK(w2c_host__abi_pool0x2Dsum(&linked, 3) == 6);
  // Once the call returned the words hold the handles again, so the same
  // array serves another call.
  for (u32 i = 0; i < 3; i++) {
    CHECK(load_u32(array, 1024 + 4 * i) == handles[i]);
  }
  CHECK(w2c_host__abi_pool0x2Dsum(&linked, 3) == 6);
  CHECK(w2c_host__abi_pool0x2Ddescribe(&linked, 3) == 606);
  CHECK(w2c_host__abi_pool0x2Dwide(&linked) == 138);
  // Every lend was returned: the handles can be dropped and given away.
  w2c_host__abi_pool0x2Ddrop(&linked, 0);
  CHECK(pool.dropped == 1);
  CHECK(w2c_host__abi_pool0x2Dtake0x2Dfrom(&linked, 1, 2) == 5);
  CHECK(pool.taken == 2 && pool.opened == 3);

  // While the host holds a borrow the handle stays lent: dropping it from a
  // call back into the component traps. A trap ends the instance, so this
  // comes last.
  w2c_host__abi_pool0x2Dfill(&linked, 2);
  pool.reenter = 1;
  wasm_rt_trap_t trap = wasm_rt_impl_try();
  if (trap == 0) {
    w2c_host__abi_pool0x2Dsum(&linked, 2);
    CHECK(!"dropping a lent handle did not trap");
  }
  CHECK(trap == WASM_RT_TRAP_UNREACHABLE);

  wasm2c_host__abi_free(&linked);
  wasm_rt_free();
  return 0;
}
