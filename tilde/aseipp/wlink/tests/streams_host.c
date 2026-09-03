// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A host for tests/host_streams.wat through wasm2c: it reads the streams
// and futures the component returns and writes those it makes and passes
// in, with its buffers in `wlink:host`; copies that cannot complete at once
// finish through `wlink:async/event`, which only arrives while it pumps or
// makes a call that blocks. Strings the component writes to it are
// allocated with its own `wlink:async/realloc`, a blocking copy in the
// component asks it to do its part through `wlink:async/wait`, streams of
// streams carry ends between the host's table and the component's, and a
// stream of owned handles carries representations the host owns.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "host_streams.h"
#include "wasm-rt-exceptions.h"
#include "wasm-rt-impl.h"

#define CHECK(condition) do { \
  if (!(condition)) { \
    fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
    abort(); \
  } \
} while (0)

#define BLOCKED 0xffffffffu
#define COMPLETED 0
#define DROPPED 1
#define CANCELLED 2
#define STREAM_READ 2
#define STREAM_WRITE 3
#define FUTURE_READ 4

// The host's buffers in `wlink:host`: one per purpose, then the strings it
// writes, then what its allocator hands out.
#define PRODUCE_BUF 0x100u
#define CONSUME_BUF 0x200u
#define INBOX_BUF 0x300u
#define OUTBOX_BUF 0x400u
#define BUF 0x1000u
#define STRINGS 0x4000u
#define HEAP 0x8000u

static w2c_host__streams linked;

static wasm_rt_memory_t* host_memory(void) {
  return w2c_host__streams_wlink0x3Ahost(&linked);
}

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

static u64 random_state = 0x2545f4914f6cdd1dull;

static u32 next_random(u32 bound) {
  random_state ^= random_state << 13;
  random_state ^= random_state >> 7;
  random_state ^= random_state << 17;
  return (u32)(random_state % bound);
}

static u32 min_u32(u32 a, u32 b) {
  return a < b ? a : b;
}

// The host's operations on its ends.
static u64 stream_new(void) {
  return w2c_host__streams_wlink0x3Aasync0x3Astream0x2Dnew(&linked);
}

static u64 future_new(void) {
  return w2c_host__streams_wlink0x3Aasync0x3Afuture0x2Dnew(&linked);
}

static u32 host_read(u32 end, u32 ptr, u32 len) {
  return w2c_host__streams_wlink0x3Aasync0x3Aread(&linked, end, ptr, len);
}

static u32 host_write(u32 end, u32 ptr, u32 len) {
  return w2c_host__streams_wlink0x3Aasync0x3Awrite(&linked, end, ptr, len);
}

static void host_drop(u32 end) {
  w2c_host__streams_wlink0x3Aasync0x3Adrop(&linked, end);
}

// Events arrive only where the host lets the runtime run: while it pumps,
// and during a call that blocks.
static int expecting_events;

typedef struct {
  int fired;
  u32 code;
  u32 payload;
} Event;

static Event events[64];

static u32 pump(void) {
  expecting_events += 1;
  u32 more = w2c_host__streams_wlink0x3Aasync0x3Apump(&linked);
  expecting_events -= 1;
  return more;
}

// Runs the scheduler until no task can run.
static void settle(void) {
  while (pump()) {
  }
}

// The event copy `end` waited for, after the scheduler has run.
static u32 await_event(u32 end, u32 code) {
  settle();
  CHECK(end < 64 && events[end].fired && events[end].code == code);
  events[end].fired = 0;
  return events[end].payload;
}

// The live entries of the handle table.
static u32 live_entries(void) {
  wasm_rt_memory_t* handles = w2c_host__streams_wlink0x3Ahandles(&linked);
  u32 length = load_u32(handles, 0);
  u32 live = 0;
  for (u32 index = 1; index <= length; index++) {
    if (load_u32(handles, 32 + 64 * index) != 0) {
      live += 1;
    }
  }
  return live;
}

// `relay`'s two streams: the one `produce` makes, which the host writes,
// and the one `consume` is handed, which it reads, a few bytes at a time
// whenever the component waits for it.
typedef struct {
  u32 end;
  u32 total;
  u32 done;
  u32 asked;
  int busy;
} Producer;

typedef struct {
  u32 end;
  u8 bytes[4096];
  u32 count;
  u32 asked;
  int busy;
} Consumer;

static Producer producer;
static Consumer consumer;

static u8 produced_byte(u32 index) {
  return (u8)(index * 7);
}

static void produced(u32 result) {
  CHECK((result & 15) == COMPLETED);
  CHECK((result >> 4) <= producer.asked);
  producer.done += result >> 4;
  if (producer.done == producer.total) {
    host_drop(producer.end);
    producer.end = 0;
  }
}

static void produce_step(void) {
  if (producer.done == producer.total) {
    host_drop(producer.end);
    producer.end = 0;
    return;
  }
  producer.asked = min_u32(1 + next_random(5), producer.total - producer.done);
  for (u32 i = 0; i < producer.asked; i++) {
    host_memory()->data[PRODUCE_BUF + i] = produced_byte(producer.done + i);
  }
  u32 result = host_write(producer.end, PRODUCE_BUF, producer.asked);
  if (result == BLOCKED) {
    producer.busy = 1;
    return;
  }
  produced(result);
}

static void consumed(u32 result) {
  u32 count = result >> 4;
  CHECK(count <= consumer.asked && consumer.count + count <= sizeof consumer.bytes);
  memcpy(consumer.bytes + consumer.count, host_memory()->data + CONSUME_BUF, count);
  consumer.count += count;
  if ((result & 15) == DROPPED) {
    host_drop(consumer.end);
    consumer.end = 0;
  } else {
    CHECK((result & 15) == COMPLETED);
  }
}

static void consume_step(void) {
  consumer.asked = 1 + next_random(7);
  u32 result = host_read(consumer.end, CONSUME_BUF, consumer.asked);
  if (result == BLOCKED) {
    consumer.busy = 1;
    return;
  }
  consumed(result);
}

// `nested`'s stream of streams, which the host reads: the outer end, the
// inner stream it is reading, and how many bytes each inner stream held.
typedef struct {
  u32 outer;
  u32 inner;
  u32 index;
  u32 asked;
  int busy;
  u32 sizes[64];
} Inbox;

// `gather`'s stream of streams, which the host makes and writes: the
// outer writable end, and the inner stream it is writing, the k-th of
// which holds k bytes of value k, once it has handed over its readable end.
typedef struct {
  u32 outer;
  u32 inner;
  u32 total;
  u32 made;
  u32 left;
  u32 asked;
  int handing;
  int busy;
} Outbox;

static Inbox inbox;
static Outbox outbox;

static void inbox_outer(u32 result) {
  CHECK((result >> 4) <= 1);
  if (result >> 4) {
    inbox.inner = load_u32(host_memory(), INBOX_BUF);
    CHECK(inbox.inner != 0 && inbox.inner != inbox.outer);
  }
  if ((result & 15) == DROPPED) {
    host_drop(inbox.outer);
    inbox.outer = 0;
  } else {
    CHECK((result & 15) == COMPLETED);
  }
}

static void inbox_inner(u32 result) {
  u32 count = result >> 4;
  CHECK(count <= inbox.asked && inbox.index < 64);
  for (u32 i = 0; i < count; i++) {
    CHECK(host_memory()->data[INBOX_BUF + i] == (u8)inbox.index);
  }
  inbox.sizes[inbox.index] += count;
  if ((result & 15) == DROPPED) {
    host_drop(inbox.inner);
    inbox.inner = 0;
    inbox.index += 1;
  } else {
    CHECK((result & 15) == COMPLETED);
  }
}

static void inbox_step(void) {
  u32 result;
  if (inbox.inner) {
    inbox.asked = 1 + next_random(6);
    result = host_read(inbox.inner, INBOX_BUF, inbox.asked);
  } else {
    inbox.asked = 1;
    result = host_read(inbox.outer, INBOX_BUF, 1);
  }
  if (result == BLOCKED) {
    inbox.busy = 1;
  } else if (inbox.inner) {
    inbox_inner(result);
  } else {
    inbox_outer(result);
  }
}

static void outbox_wrote(u32 result) {
  CHECK((result & 15) == COMPLETED && (result >> 4) <= outbox.asked);
  if (outbox.handing) {
    // The inner stream's readable end went into the component's table.
    CHECK(result >> 4 == 1);
    outbox.handing = 0;
  } else {
    outbox.left -= result >> 4;
  }
}

static void outbox_step(void) {
  u32 result;
  if (outbox.inner && outbox.left == 0) {
    host_drop(outbox.inner);
    outbox.inner = 0;
    return;
  }
  if (outbox.inner) {
    outbox.asked = min_u32(1 + next_random(6), outbox.left);
    memset(host_memory()->data + OUTBOX_BUF, (int)(outbox.made - 1), outbox.asked);
    result = host_write(outbox.inner, OUTBOX_BUF, outbox.asked);
  } else if (outbox.made < outbox.total) {
    u64 ends = stream_new();
    outbox.inner = (u32)(ends >> 32);
    outbox.left = outbox.made;
    outbox.made += 1;
    outbox.asked = 1;
    outbox.handing = 1;
    // The element is the readable end's index in the host's table.
    store_u32(host_memory(), OUTBOX_BUF, (u32)ends);
    result = host_write(outbox.outer, OUTBOX_BUF, 1);
  } else {
    host_drop(outbox.outer);
    outbox.outer = 0;
    return;
  }
  if (result == BLOCKED) {
    outbox.busy = 1;
  } else {
    outbox_wrote(result);
  }
}

struct w2c_host0x3Astreams0x2Fio {
  u32 produces;
  u32 consumes;
  u32 inboxes;
};

// produce(n): a stream the host makes, its readable end handed over; the
// bytes follow as the component reads.
u32 w2c_host0x3Astreams0x2Fio_produce(struct w2c_host0x3Astreams0x2Fio* io, u32 n) {
  io->produces += 1;
  CHECK(producer.end == 0 && n == producer.total);
  u64 ends = stream_new();
  producer.end = (u32)(ends >> 32);
  producer.done = 0;
  producer.busy = 0;
  return (u32)ends;
}

// consume(s): the host takes the readable end, and reads it as it can.
void w2c_host0x3Astreams0x2Fio_consume(struct w2c_host0x3Astreams0x2Fio* io, u32 end) {
  io->consumes += 1;
  CHECK(consumer.end == 0 && end != 0);
  consumer.end = end;
  consumer.count = 0;
  consumer.busy = 0;
}

// inbox(s): the host takes a stream of streams, and reads each in turn.
void w2c_host0x3Astreams0x2Fio_inbox(struct w2c_host0x3Astreams0x2Fio* io, u32 end) {
  io->inboxes += 1;
  CHECK(inbox.outer == 0 && end != 0);
  inbox = (Inbox){0};
  inbox.outer = end;
}

struct w2c_wlink0x3Aasync {
  u32 waits;
  u32 events;
  u32 allocations;
  u32 heap;
};

// A blocking copy needs the host's part: the next write or read of the
// streams it serves.
u32 w2c_wlink0x3Aasync_wait(struct w2c_wlink0x3Aasync* async) {
  async->waits += 1;
  expecting_events += 1;
  u32 progress = 0;
  if (producer.end && !producer.busy) {
    produce_step();
    progress = 1;
  }
  if (consumer.end && !consumer.busy) {
    consume_step();
    progress = 1;
  }
  if (inbox.outer && !inbox.busy) {
    inbox_step();
    progress = 1;
  }
  if (outbox.outer && !outbox.busy) {
    outbox_step();
    progress = 1;
  }
  expecting_events -= 1;
  return progress;
}

void w2c_wlink0x3Aasync_event(struct w2c_wlink0x3Aasync* async, u32 end, u32 code,
                              u32 payload) {
  async->events += 1;
  CHECK(expecting_events > 0);
  if (producer.end && end == producer.end) {
    CHECK(code == STREAM_WRITE && producer.busy);
    producer.busy = 0;
    produced(payload);
    return;
  }
  if (consumer.end && end == consumer.end) {
    CHECK(code == STREAM_READ && consumer.busy);
    consumer.busy = 0;
    consumed(payload);
    return;
  }
  if (inbox.busy && (end == inbox.outer || end == inbox.inner)) {
    CHECK(code == STREAM_READ && end == (inbox.inner ? inbox.inner : inbox.outer));
    inbox.busy = 0;
    if (inbox.inner) {
      inbox_inner(payload);
    } else {
      inbox_outer(payload);
    }
    return;
  }
  if (outbox.busy && (end == outbox.outer || end == outbox.inner)) {
    CHECK(code == STREAM_WRITE);
    outbox.busy = 0;
    outbox_wrote(payload);
    return;
  }
  CHECK(end < 64 && !events[end].fired);
  events[end] = (Event){1, code, payload};
}

// The host's allocator in its memory, for strings the component writes.
u32 w2c_wlink0x3Aasync_realloc(struct w2c_wlink0x3Aasync* async, u32 old, u32 old_size,
                               u32 align, u32 size) {
  CHECK(old == 0 && old_size == 0 && align != 0 && (align & (align - 1)) == 0);
  async->allocations += 1;
  u32 at = (async->heap + align - 1) & ~(align - 1);
  async->heap = at + size;
  CHECK((u64)async->heap <= host_memory()->size);
  return at;
}

void w2c_wlink0x3Aasync_task0x2Dcancelled(struct w2c_wlink0x3Aasync* async, u32 task,
                                          u32 state) {
  (void)async;
  (void)task;
  (void)state;
  CHECK(!"no task is cancelled");
}

struct w2c_wlink0x3Atask0x2Dreturn {
  u32 count_to;
  u32 names;
  u32 later;
  u32 tokens;
  u32 redeemed;
  u32 redeems;
  u32 sum;
  u32 sums;
  u32 wait_for;
  u32 waits_for;
  char joined[1024];
  u32 joined_length;
  u32 joins;
};

void w2c_wlink0x3Atask0x2Dreturn_count0x2Dto(struct w2c_wlink0x3Atask0x2Dreturn* results,
                                             u32 task, u32 end) {
  (void)task;
  results->count_to = end;
}

void w2c_wlink0x3Atask0x2Dreturn_names(struct w2c_wlink0x3Atask0x2Dreturn* results, u32 task,
                                       u32 end) {
  (void)task;
  results->names = end;
}

void w2c_wlink0x3Atask0x2Dreturn_later(struct w2c_wlink0x3Atask0x2Dreturn* results, u32 task,
                                       u32 end) {
  (void)task;
  results->later = end;
}

void w2c_wlink0x3Atask0x2Dreturn_tokens(struct w2c_wlink0x3Atask0x2Dreturn* results, u32 task,
                                        u32 end) {
  (void)task;
  results->tokens = end;
}

void w2c_wlink0x3Atask0x2Dreturn_redeem(struct w2c_wlink0x3Atask0x2Dreturn* results, u32 task,
                                        u32 total) {
  (void)task;
  results->redeemed = total;
  results->redeems += 1;
}

void w2c_wlink0x3Atask0x2Dreturn_sum(struct w2c_wlink0x3Atask0x2Dreturn* results, u32 task,
                                     u32 value) {
  (void)task;
  results->sum = value;
  results->sums += 1;
}

void w2c_wlink0x3Atask0x2Dreturn_wait0x2Dfor(struct w2c_wlink0x3Atask0x2Dreturn* results,
                                             u32 task, u32 value) {
  (void)task;
  results->wait_for = value;
  results->waits_for += 1;
}

void w2c_wlink0x3Atask0x2Dreturn_join(struct w2c_wlink0x3Atask0x2Dreturn* results, u32 task,
                                      u32 ptr, u32 len) {
  (void)task;
  wasm_rt_memory_t* memory = w2c_host__streams_wlink0x3Aexport0x3Ajoin0x3Amemory(&linked);
  CHECK(len < sizeof results->joined && (u64)ptr + len <= memory->size);
  memcpy(results->joined, memory->data + ptr, len);
  results->joined_length = len;
  results->joins += 1;
}

static struct w2c_host0x3Astreams0x2Fio io;
static struct w2c_wlink0x3Aasync async;
static struct w2c_wlink0x3Atask0x2Dreturn results;

// Reads `end` to its end a few elements of `size` bytes at a time into
// `out`, waiting for the writer whenever it must, and drops it: how many
// elements there were.
static u32 read_all(u32 end, u32 size, u8* out, u32 capacity) {
  u32 count = 0;
  for (;;) {
    u32 asked = 1 + next_random(6);
    u32 result = host_read(end, BUF, asked);
    if (result == BLOCKED) {
      result = await_event(end, STREAM_READ);
    }
    u32 got = result >> 4;
    CHECK(got <= asked && count + got <= capacity);
    memcpy(out + count * size, host_memory()->data + BUF, got * size);
    count += got;
    if ((result & 15) == DROPPED) {
      break;
    }
    CHECK((result & 15) == COMPLETED);
  }
  host_drop(end);
  return count;
}

// Writes `count` elements of `size` bytes from `in` to `end` a few at a
// time, waiting for the reader whenever it must, and drops it.
static void write_all(u32 end, u32 size, const u8* in, u32 count) {
  u32 sent = 0;
  while (sent < count) {
    u32 asked = min_u32(1 + next_random(6), count - sent);
    memcpy(host_memory()->data + BUF, in + sent * size, asked * size);
    u32 result = host_write(end, BUF, asked);
    if (result == BLOCKED) {
      result = await_event(end, STREAM_WRITE);
    }
    CHECK((result & 15) == COMPLETED && (result >> 4) <= asked);
    sent += result >> 4;
  }
  host_drop(end);
}

// count-to(n): 1, 4, 7, ... read by the host.
static void count_to(u32 n) {
  results.count_to = 0;
  CHECK(w2c_host__streams_count0x2Dto(&linked, n) == 2);  // returned the stream
  CHECK(results.count_to != 0);
  u32 values[64];
  CHECK(read_all(results.count_to, 4, (u8*)values, 64) == n);
  for (u32 i = 0; i < n; i++) {
    CHECK(values[i] == 3 * i + 1);
  }
  settle();
}

// sum(values) over a stream the host makes and writes.
static void sum(u32 n) {
  u32 values[64];
  u32 expected = 0;
  for (u32 i = 0; i < n; i++) {
    values[i] = next_random(1000);
    expected += values[i];
  }
  u64 ends = stream_new();
  u32 sums = results.sums;
  u32 status = w2c_host__streams_sum(&linked, (u32)ends);
  CHECK((status & 15) == 1);  // started, reading
  write_all((u32)(ends >> 32), 4, (const u8*)values, n);
  settle();
  CHECK(results.sums == sums + 1 && results.sum == expected);
}

// names(n): strings the component writes into the host's memory, through
// its allocator.
static void names(u32 n) {
  results.names = 0;
  async.heap = HEAP;
  u32 allocations = async.allocations;
  CHECK(w2c_host__streams_names(&linked, n) == 2);
  CHECK(results.names != 0);
  u32 records[2 * 64];
  CHECK(read_all(results.names, 8, (u8*)records, 64) == n);
  CHECK(async.allocations == allocations + n);
  for (u32 i = 0; i < n; i++) {
    u32 ptr = records[2 * i];
    u32 len = records[2 * i + 1];
    CHECK(len == i % 10 + 1);
    CHECK(ptr >= HEAP && (u64)ptr + len <= async.heap);
    CHECK(memcmp(host_memory()->data + ptr, "abcdefghij", len) == 0);
  }
  settle();
}

// join(parts) over strings in the host's memory.
static void join(u32 n) {
  static const char* words[] = {"wasm", "", "component", "-", "model", "host", "edge"};
  u32 records[2 * 64];
  char expected[1024];
  u32 length = 0;
  u32 at = STRINGS;
  for (u32 i = 0; i < n; i++) {
    const char* word = words[next_random(7)];
    u32 len = (u32)strlen(word);
    memcpy(host_memory()->data + at, word, len);
    records[2 * i] = at;
    records[2 * i + 1] = len;
    memcpy(expected + length, word, len);
    at += len;
    length += len;
  }
  u64 ends = stream_new();
  u32 joins = results.joins;
  u32 status = w2c_host__streams_join(&linked, (u32)ends);
  CHECK((status & 15) == 1);
  write_all((u32)(ends >> 32), 8, (const u8*)records, n);
  settle();
  CHECK(results.joins == joins + 1 && results.joined_length == length);
  CHECK(memcmp(results.joined, expected, length) == 0);
}

// later(v) and wait-for(f): a future each way.
static void futures(u32 value) {
  results.later = 0;
  CHECK(w2c_host__streams_later(&linked, value) == 2);
  CHECK(results.later != 0);
  // The component's write waits for the host's read, which completes it.
  CHECK(host_read(results.later, BUF, 1) == COMPLETED);
  CHECK(load_u32(host_memory(), BUF) == value + 1);
  host_drop(results.later);
  settle();

  u64 ends = future_new();
  u32 waits_for = results.waits_for;
  u32 status = w2c_host__streams_wait0x2Dfor(&linked, (u32)ends);
  CHECK((status & 15) == 1);
  store_u32(host_memory(), BUF, value);
  CHECK(host_write((u32)(ends >> 32), BUF, 1) == COMPLETED);
  host_drop((u32)(ends >> 32));
  CHECK(results.waits_for == waits_for);
  settle();
  CHECK(results.waits_for == waits_for + 1 && results.wait_for == 2 * value);
}

// relay(n): the component copies a stream the host writes into one it
// reads, blocking on every copy, so the runtime asks the host to wait.
static void relay(u32 n) {
  producer = (Producer){0};
  producer.total = n;
  consumer.end = 0;
  consumer.busy = 0;
  u32 waits = async.waits;
  expecting_events += 1;
  CHECK(w2c_host__streams_relay(&linked, n) == n);
  expecting_events -= 1;
  CHECK(async.waits > waits && producer.end == 0);
  // The component dropped its end: the host hears so on its next read.
  while (consumer.end) {
    if (consumer.busy) {
      settle();
      CHECK(!consumer.busy);
    } else {
      consume_step();
    }
  }
  CHECK(consumer.count == n);
  for (u32 i = 0; i < n; i++) {
    CHECK(consumer.bytes[i] == (u8)(produced_byte(i) + 1));
  }
  settle();
}

// nested(n): a stream of n streams the host reads, the i-th holding i
// bytes.
static void nested(u32 n) {
  CHECK(inbox.outer == 0);
  expecting_events += 1;
  CHECK(w2c_host__streams_nested(&linked, n) == n);
  expecting_events -= 1;
  while (inbox.outer || inbox.inner) {
    if (inbox.busy) {
      settle();
      CHECK(!inbox.busy);
    } else {
      inbox_step();
    }
  }
  CHECK(inbox.index == n);
  for (u32 i = 0; i < n; i++) {
    CHECK(inbox.sizes[i] == i);
  }
  settle();
}

// gather(s): the component reads a stream of streams the host makes, the
// k-th holding k bytes of value k.
static void gather(u32 n) {
  u64 ends = stream_new();
  outbox = (Outbox){0};
  outbox.outer = (u32)(ends >> 32);
  outbox.total = n;
  u32 expected = 0;
  for (u32 k = 0; k < n; k++) {
    expected += k * k;
  }
  expecting_events += 1;
  CHECK(w2c_host__streams_gather(&linked, (u32)ends) == expected);
  expecting_events -= 1;
  CHECK(outbox.outer == 0 && outbox.inner == 0 && outbox.made == n);
  settle();
}

// tokens(n): the host reads n owned tokens as their representations,
// hands the first `back` to redeem, which drops them, and destroys the rest
// itself.
static void tokens(u32 n, u32 back) {
  u32 destroyed = w2c_host__streams_destroyed(&linked);
  results.tokens = 0;
  CHECK(w2c_host__streams_tokens(&linked, n) == 2);
  CHECK(results.tokens != 0);
  u32 reps[64];
  CHECK(read_all(results.tokens, 4, (u8*)reps, 64) == n);
  settle();
  u32 all = 0;
  u32 redeemed = 0;
  for (u32 i = 0; i < n; i++) {
    CHECK(reps[i] == 100 + i);
    all += reps[i];
    if (i < back) {
      redeemed += reps[i];
    }
  }
  // The host owns them now: nothing is destroyed until it says so.
  CHECK(w2c_host__streams_destroyed(&linked) == destroyed);
  u64 ends = stream_new();
  u32 redeems = results.redeems;
  CHECK((w2c_host__streams_redeem(&linked, (u32)ends) & 15) == 1);
  write_all((u32)(ends >> 32), 4, (const u8*)reps, back);
  settle();
  CHECK(results.redeems == redeems + 1 && results.redeemed == redeemed);
  CHECK(w2c_host__streams_destroyed(&linked) == destroyed + redeemed);
  for (u32 i = back; i < n; i++) {
    w2c_host__streams_0x5Bresource0x2Ddrop0x5Dtoken(&linked, reps[i]);
  }
  CHECK(w2c_host__streams_destroyed(&linked) == destroyed + all);
}

int main(void) {
  wasm_rt_init();
  async.heap = HEAP;
  wasm2c_host__streams_instantiate(&linked, &io, &async, &results);

  count_to(0);
  CHECK(live_entries() == 0);
  count_to(10);
  CHECK(live_entries() == 0);
  sum(0);
  sum(9);
  CHECK(live_entries() == 0);
  names(12);
  CHECK(live_entries() == 0);
  join(5);
  CHECK(live_entries() == 0);
  futures(41);
  CHECK(live_entries() == 0);
  relay(0);
  relay(100);
  CHECK(io.produces == 2 && io.consumes == 2);
  CHECK(live_entries() == 0);
  nested(0);
  nested(6);
  CHECK(io.inboxes == 2);
  CHECK(live_entries() == 0);
  gather(0);
  gather(6);
  CHECK(live_entries() == 0);
  tokens(0, 0);
  tokens(7, 3);
  CHECK(live_entries() == 0);

  // A copy the component never answers: the host cancels it, copies again,
  // and hears when the component drops its end, but only once it pumps.
  u64 ends = stream_new();
  u32 readable = (u32)ends;
  u32 writable = (u32)(ends >> 32);
  w2c_host__streams_hold(&linked, readable);
  CHECK(host_write(writable, BUF, 2) == BLOCKED);
  CHECK(w2c_host__streams_wlink0x3Aasync0x3Acancel0x2Dwrite(&linked, writable) == CANCELLED);
  CHECK(host_write(writable, BUF, 2) == BLOCKED);
  w2c_host__streams_release(&linked);
  CHECK(!events[writable].fired);
  CHECK(await_event(writable, STREAM_WRITE) == DROPPED);
  host_drop(writable);
  u32 given = w2c_host__streams_give(&linked);
  CHECK(host_read(given, BUF, 3) == BLOCKED);
  CHECK(w2c_host__streams_wlink0x3Aasync0x3Acancel0x2Dread(&linked, given) == CANCELLED);
  CHECK(host_read(given, BUF, 3) == BLOCKED);
  w2c_host__streams_release(&linked);
  CHECK(!events[given].fired);
  CHECK(await_event(given, STREAM_READ) == DROPPED);
  host_drop(given);
  CHECK(live_entries() == 0);

  // Rounds of everything, with random sizes and chunks, leave nothing
  // behind.
  for (int round = 0; round < 200; round++) {
    switch (next_random(9)) {
      case 0:
        count_to(next_random(40));
        break;
      case 1:
        sum(next_random(40));
        break;
      case 2:
        names(next_random(40));
        break;
      case 3:
        join(next_random(20));
        break;
      case 4:
        futures(next_random(1000));
        break;
      case 5:
        nested(next_random(20));
        break;
      case 6:
        gather(next_random(20));
        break;
      case 7: {
        u32 n = next_random(40);
        tokens(n, next_random(n + 1));
        break;
      }
      default:
        relay(next_random(300));
        break;
    }
    CHECK(live_entries() == 0);
    for (u32 end = 0; end < 64; end++) {
      CHECK(!events[end].fired);
    }
  }

  // A writable end cannot be read, and an end that never crossed into a
  // component has no type to copy by: traps, with their reasons.
  ends = stream_new();
  wasm_rt_trap_t trap = wasm_rt_impl_try();
  if (trap == 0) {
    host_read((u32)(ends >> 32), BUF, 1);
    CHECK(!"reading a writable end did not trap");
  }
  CHECK(trap == WASM_RT_TRAP_UNREACHABLE);
  CHECK(*w2c_host__streams_wlink0x3Aasync0x3Atrap(&linked) == 3);
  trap = wasm_rt_impl_try();
  if (trap == 0) {
    host_read((u32)ends, BUF, 1);
    CHECK(!"reading an untyped end did not trap");
  }
  CHECK(trap == WASM_RT_TRAP_UNREACHABLE);
  CHECK(*w2c_host__streams_wlink0x3Aasync0x3Atrap(&linked) == 11);

  wasm2c_host__streams_free(&linked);
  wasm_rt_free();
  printf("streams host ok (%u waits, %u events)\n", async.waits, async.events);
  return 0;
}
