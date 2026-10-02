// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The C host bindings of tests/host.wit, run over wasm2c's runtime against a
// guest memory of the test's own: the imports the bindings define are called
// the way wasm2c's module would call them.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "wasm-rt.h"
#include "wasm-rt-exceptions.h"
#include "wasm-rt-impl.h"

typedef struct test_host_context test_host_t;

/* What wasm2c's instance would be: the memory every import names, and an
 * allocator that records what it was asked for. */
typedef struct {
  wasm_rt_memory_t memory;
  uint32_t next;
  uint32_t allocations[8][3];
  unsigned allocation_count;
} guest_t;

struct test_host_context {
  guest_t *guest;
  char calls[256];
};

#define TEST_HOST_HOST_TEST_HOST_GUEST(instance) ((instance)->guest)

static uint32_t guest_alloc(guest_t *guest, uint32_t old, uint32_t old_len, uint32_t align,
                            uint32_t len) {
  (void)old;
  (void)old_len;
  uint32_t ptr = (guest->next + align - 1) / align * align;
  guest->next = ptr + len;
  uint32_t *record = guest->allocations[guest->allocation_count++];
  record[0] = ptr;
  record[1] = align;
  record[2] = len;
  return ptr;
}

/* The aliases a host gives wasm2c's names for the imports' memories and
 * allocators: here every import shares the one memory. */
#define MEMORY(name) \
  static wasm_rt_memory_t *test_host_##name##_memory(guest_t *guest) { return &guest->memory; }
#define REALLOC(name)                                                                 \
  static uint32_t test_host_##name##_realloc(guest_t *guest, uint32_t old, uint32_t old_len, \
                                             uint32_t align, uint32_t len) {          \
    return guest_alloc(guest, old, old_len, align, len);                              \
  }
MEMORY(text)
MEMORY(bytes)
MEMORY(numbers)
MEMORY(points)
MEMORY(record_param)
MEMORY(tuples)
MEMORY(list_items)
MEMORY(spilled)
MEMORY(shout)
REALLOC(text)
REALLOC(bytes)
REALLOC(numbers)
REALLOC(points)
REALLOC(tuples)
REALLOC(list_items)

#define TEST_HOST_HOST_TEST_HOST_IMPLEMENTATION
#include "host.h"

static int failures;

#define CHECK(condition)                                               \
  do {                                                                 \
    if (!(condition)) {                                                \
      fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
      failures++;                                                      \
    }                                                                  \
  } while (0)

/* The host: what the test's guest calls end up in. */

uint64_t test_host_things_scalars(test_host_t *instance, bool a, uint8_t b, int8_t c, uint16_t d,
                                  int16_t e, uint32_t f, int32_t g, uint64_t h, int64_t i, float j,
                                  double k, uint32_t l) {
  snprintf(instance->calls, sizeof instance->calls,
           "%d %u %d %u %d %u %d %llu %lld %g %g %u", a, b, c, d, e, f, g,
           (unsigned long long)h, (long long)i, j, k, l);
  return UINT64_MAX - 1;
}

int16_t test_host_things_negate(test_host_t *instance, int16_t value) {
  (void)instance;
  return (int16_t)-value;
}

double test_host_things_halve(test_host_t *instance, double value) {
  (void)instance;
  return value / 2;
}

test_host_things_color_t test_host_things_enums(test_host_t *instance, test_host_things_color_t c,
                                              test_host_things_perms_t p) {
  (void)instance;
  CHECK(p == (TEST_HOST_THINGS_PERMS_READ | TEST_HOST_THINGS_PERMS_EXEC));
  return (test_host_things_color_t)((c + 1) % 3);
}

uint32_t test_host_things_letter(test_host_t *instance, uint32_t c) {
  (void)instance;
  return c >= 'a' && c <= 'z' ? c - 32 : c;
}

static uint8_t text_result[64];

test_host_things_bytes_t test_host_things_text(test_host_t *instance, test_host_things_bytes_t message) {
  (void)instance;
  for (size_t i = 0; i < message.len; ++i)
    text_result[i] = message.ptr[i] >= 'a' && message.ptr[i] <= 'z' ? message.ptr[i] - 32 : message.ptr[i];
  return (test_host_things_bytes_t){text_result, message.len};
}

test_host_things_bytes_t test_host_things_bytes(test_host_t *instance, test_host_things_bytes_t data) {
  (void)instance;
  for (size_t i = 0; i < data.len; ++i) text_result[i] = data.ptr[data.len - 1 - i];
  return (test_host_things_bytes_t){text_result, data.len};
}

static uint32_t numbers_result[3];

test_host_things_u32_list_t test_host_things_numbers(test_host_t *instance, test_host_things_s16_view_t values,
                                                   test_host_things_u64_view_t wide,
                                                   test_host_things_f32_view_t floats) {
  snprintf(instance->calls, sizeof instance->calls, "%d,%d %llu %g",
           test_host_things_s16_view_get(values, 0), test_host_things_s16_view_get(values, 1),
           (unsigned long long)test_host_things_u64_view_get(wide, 0),
           test_host_things_f32_view_get(floats, 0));
  numbers_result[0] = (uint32_t)values.len;
  numbers_result[1] = (uint32_t)wide.len;
  numbers_result[2] = 0xdeadbeef;
  return (test_host_things_u32_list_t){numbers_result, 3};
}

static test_host_things_point_t points_result[4];

test_host_things_point_list_t test_host_things_points(test_host_t *instance, test_host_things_point_view_t points) {
  (void)instance;
  for (size_t i = 0; i < points.len; ++i) {
    test_host_things_point_t p = test_host_things_point_view_get(points, i);
    points_result[i] = (test_host_things_point_t){.x = p.y, .y = p.x};
  }
  return (test_host_things_point_list_t){points_result, points.len};
}

test_host_things_point_t test_host_things_record_param(test_host_t *instance, test_host_things_point_t p,
                                                     test_host_things_bytes_t name) {
  (void)instance;
  return (test_host_things_point_t){.x = p.x + (int32_t)name.len, .y = p.y};
}

test_host_things_tuple_u32_string_t test_host_things_tuples(test_host_t *instance,
                                                          test_host_things_tuple_u8_string_f32_t t) {
  (void)instance;
  return (test_host_things_tuple_u32_string_t){.f0 = t.f0 + (uint32_t)t.f2, .f1 = t.f1};
}

static const uint8_t one[] = "one";
static const uint8_t tag1[] = {1};
static const uint8_t tag2[] = {2, 3};
static test_host_things_item_t items[2];
static const uint16_t codes[] = {7, 65535};

test_host_things_listing_t test_host_things_list_items(test_host_t *instance, test_host_things_bytes_t path) {
  (void)instance;
  CHECK(path.len == 1 && path.ptr[0] == '/');
  items[0] = (test_host_things_item_t){
      .name = {one, 3}, .tag = {tag1, 1}, .color = TEST_HOST_THINGS_COLOR_BLUE, .weight = 1.5,
      .at = {.x = 1, .y = -1}};
  items[1] = (test_host_things_item_t){
      .name = {NULL, 0}, .tag = {tag2, 2}, .color = TEST_HOST_THINGS_COLOR_RED, .weight = -0.25,
      .at = {.x = 2, .y = -2}};
  return (test_host_things_listing_t){
      .status = -2, .items = {items, 2}, .codes = {codes, 2}};
}

uint32_t test_host_things_spilled(test_host_t *instance, uint32_t a, uint32_t b, uint32_t c,
                                  uint32_t d, uint32_t e, uint32_t f, uint32_t g, uint32_t h,
                                  test_host_things_bytes_t i, test_host_things_bytes_t j,
                                  test_host_things_bytes_t k, test_host_things_bytes_t l, uint64_t m,
                                  test_host_things_point_t n) {
  (void)instance;
  CHECK(i.len == 1 && j.len == 1 && k.len == 1 && l.len == 1);
  CHECK(i.ptr[0] == 'w' && j.ptr[0] == 'x' && k.ptr[0] == 'y' && l.ptr[0] == 'z');
  CHECK(m == (uint64_t)1 << 40);
  return (uint32_t)((int32_t)(a + b + c + d + e + f + g + h) + n.x + n.y);
}

void test_host_things_nothing(test_host_t *instance) {
  snprintf(instance->calls, sizeof instance->calls, "nothing");
}

bool test_host_host_test_shout(test_host_t *instance, test_host_host_test_bytes_t word) {
  (void)instance;
  return word.len && word.ptr[word.len - 1] == '!';
}

/* The guest's side. */

static guest_t guest;
static test_host_t context;

static void reset(void) {
  memset(guest.memory.data, 0xaa, guest.memory.size);
  guest.next = 1024;
  guest.allocation_count = 0;
  context.calls[0] = 0;
}

static uint32_t word(uint32_t at) {
  const uint8_t *p = guest.memory.data + at;
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static void put(uint32_t at, const void *bytes, size_t len) {
  memcpy(guest.memory.data + at, bytes, len);
}

static void put32(uint32_t at, uint32_t value) {
  for (int i = 0; i < 4; ++i) guest.memory.data[at + i] = (uint8_t)(value >> (8 * i));
}

/* The trap a call raises, or WASM_RT_TRAP_NONE. */
#define TRAP_OF(call)                                 \
  ({                                                  \
    wasm_rt_trap_t trap_ = (wasm_rt_trap_t)wasm_rt_impl_try(); \
    if (!trap_) {                                     \
      call;                                           \
    }                                                 \
    trap_;                                            \
  })

int main(void) {
  wasm_rt_init();
  static uint8_t data[4096];
  guest.memory.data = data;
  guest.memory.size = sizeof data;
  context.guest = &guest;

  reset();
  uint64_t scalars = test_host_scalars(&context, 7, 0x1ff, 0xfffffff0u, 0x10002, 0x8000, UINT32_MAX,
                                       UINT32_MAX, UINT64_MAX, UINT64_MAX, 0.5f, -2.0, 0xe9);
  CHECK(scalars == UINT64_MAX - 1);
  CHECK(strcmp(context.calls, "1 255 -16 2 -32768 4294967295 -1 18446744073709551615 -1 0.5 -2 233") == 0);
  CHECK(test_host_negate(&context, 5) == (uint32_t)-5);
  CHECK(test_host_halve(&context, 3.0) == 1.5);
  CHECK(test_host_letter(&context, 'q') == 'Q');
  CHECK(test_host_enums(&context, 2, TEST_HOST_THINGS_PERMS_READ | TEST_HOST_THINGS_PERMS_EXEC) == 0);
  CHECK(TRAP_OF(test_host_enums(&context, 3, 0)) == WASM_RT_TRAP_UNREACHABLE);
  CHECK(TRAP_OF(test_host_letter(&context, 0xd800)) == WASM_RT_TRAP_UNREACHABLE);

  reset();
  put(16, "hello", 5);
  test_host_text(&context, 16, 5, 64);
  CHECK(guest.allocation_count == 1 && guest.allocations[0][0] == 1024 && guest.allocations[0][2] == 5);
  CHECK(word(64) == 1024 && word(68) == 5);
  CHECK(memcmp(data + 1024, "HELLO", 5) == 0);
  test_host_bytes(&context, 16, 0, 64);
  CHECK(guest.allocation_count == 1);
  CHECK(word(64) == 1 && word(68) == 0);
  CHECK(TRAP_OF(test_host_text(&context, 4090, 16, 64)) == WASM_RT_TRAP_OOB);

  reset();
  put(16, "\xff\xff\x02\x00", 4);
  uint64_t wide = (uint64_t)1 << 33;
  put(32, &wide, 8);
  float half = 1.5f;
  put(48, &half, 4);
  test_host_numbers(&context, 16, 2, 32, 1, 48, 1, 128);
  CHECK(strcmp(context.calls, "-1,2 8589934592 1.5") == 0);
  CHECK(guest.allocation_count == 1 && guest.allocations[0][1] == 4 && guest.allocations[0][2] == 12);
  CHECK(word(128) == 1024 && word(132) == 3 && word(1032) == 0xdeadbeef);
  CHECK(TRAP_OF(test_host_numbers(&context, 16, 2, 33, 1, 48, 1, 128)) == WASM_RT_TRAP_UNALIGNED);

  reset();
  const uint8_t points[] = {1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0xfc, 0xff, 0xff, 0xff};
  put(16, points, sizeof points);
  test_host_points(&context, 16, 2, 64);
  const uint8_t swapped[] = {2, 0, 0, 0, 1, 0, 0, 0, 0xfc, 0xff, 0xff, 0xff, 3, 0, 0, 0};
  CHECK(memcmp(data + 1024, swapped, sizeof swapped) == 0);
  put(200, "abc", 3);
  test_host_record_param(&context, 10, 20, 200, 3, 96);
  CHECK(word(96) == 13 && word(100) == 20);
  CHECK(TRAP_OF(test_host_record_param(&context, 10, 20, 200, 3, 98)) == WASM_RT_TRAP_UNALIGNED);

  reset();
  put(16, "tuple", 5);
  test_host_tuples(&context, 3, 16, 5, 4.0f, 64);
  CHECK(word(64) == 7 && word(72) == 5 && memcmp(data + word(68), "tuple", 5) == 0);

  reset();
  put(16, "/", 1);
  test_host_list_items(&context, 16, 1, 64);
  const uint32_t expected[][3] = {{1024, 8, 80}, {1104, 1, 3}, {1107, 1, 1}, {1108, 1, 2}, {1110, 2, 4}};
  CHECK(guest.allocation_count == 5 && memcmp(guest.allocations, expected, sizeof expected) == 0);
  CHECK(word(64) == (uint32_t)-2 && word(68) == 1024 && word(72) == 2 && word(76) == 1110 && word(80) == 2);
  const uint8_t first[] = {80, 4, 0, 0, 3, 0, 0, 0, 83, 4, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0};
  CHECK(memcmp(data + 1024, first, sizeof first) == 0);
  double weight;
  memcpy(&weight, data + 1048, 8);
  CHECK(weight == 1.5 && word(1056) == 1 && word(1060) == (uint32_t)-1);
  CHECK(word(1064) == 1 && word(1068) == 0);
  CHECK(memcmp(data + 1104, "one\x01\x02\x03\x07\x00\xff\xff", 10) == 0);

  reset();
  for (uint32_t index = 0; index < 8; ++index) put32(512 + index * 4, index + 1);
  put(400, "wxyz", 4);
  for (uint32_t index = 0; index < 4; ++index) {
    put32(512 + 32 + index * 8, 400 + index);
    put32(512 + 32 + index * 8 + 4, 1);
  }
  uint64_t m = (uint64_t)1 << 40;
  put(512 + 64, &m, 8);
  put32(512 + 72, 100);
  put32(512 + 76, (uint32_t)-10);
  CHECK(test_host_spilled(&context, 512) == 126);
  CHECK(TRAP_OF(test_host_spilled(&context, 516)) == WASM_RT_TRAP_UNALIGNED);

  reset();
  test_host_nothing(&context);
  CHECK(strcmp(context.calls, "nothing") == 0);
  put(16, "hey!", 4);
  CHECK(test_host_shout(&context, 16, 4) == 1);

  wasm_rt_free();
  if (failures) {
    fprintf(stderr, "%d checks failed\n", failures);
    return 1;
  }
  printf("ok\n");
  return 0;
}
