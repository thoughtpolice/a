// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  canonicalUlid,
  decodeTime,
  encodeTime,
  isUlid,
  MAX_TIME,
  monotonicFactory,
  type RandomSource,
  ulid,
  ULID_PATTERN,
  UlidError,
  ulidFactory,
  ulidFromBytes,
  ulidFromUuid,
  ulidToBytes,
  ulidToUuid,
} from "@celld/ulid";

function fill(byte: number): RandomSource {
  return (bytes) => {
    bytes.fill(byte);
  };
}

Deno.test("the spec's time example", () => {
  assertEquals(encodeTime(1469918176385), "01ARYZ6S41");
  assertEquals(decodeTime("01ARYZ6S41TSV4RRFFQ69G5FAV"), 1469918176385);
  assertEquals(ulid(1469918176385).slice(0, 10), "01ARYZ6S41");
});

Deno.test("time bounds", () => {
  assertEquals(encodeTime(0), "0000000000");
  assertEquals(encodeTime(MAX_TIME), "7ZZZZZZZZZ");
  assertEquals(decodeTime("7ZZZZZZZZZZZZZZZZZZZZZZZZZ"), MAX_TIME);
  for (const bad of [-1, MAX_TIME + 1, 1.5, NaN, Infinity]) {
    assertThrows(() => encodeTime(bad), UlidError);
  }
});

Deno.test("isUlid", () => {
  for (
    const good of [
      "01ARYZ6S41TSV4RRFFQ69G5FAV",
      "01aryz6s41tsv4rrffq69g5fav",
      "00000000000000000000000000",
      "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
    ]
  ) {
    assert(isUlid(good), good);
  }
  for (
    const bad of [
      "",
      "01ARYZ6S41TSV4RRFFQ69G5FA",
      "01ARYZ6S41TSV4RRFFQ69G5FAVX",
      "81ARYZ6S41TSV4RRFFQ69G5FAV",
      "01ARYZ6S41TSV4RRFFQ69G5FAI",
      "01ARYZ6S41TSV4RRFFQ69G5FAL",
      "01ARYZ6S41TSV4RRFFQ69G5FAO",
      "01ARYZ6S41TSV4RRFFQ69G5FAU",
      "01ARYZ6S41TSV4RRFFQ69G5FA-",
    ]
  ) {
    assert(!isUlid(bad), bad);
  }
  assert(
    new RegExp(ULID_PATTERN).test("01ARYZ6S41TSV4RRFFQ69G5FAV"),
    "pattern",
  );
});

Deno.test("canonical spelling and errors", () => {
  assertEquals(
    canonicalUlid("01aryz6s41tsv4rrffq69g5fav"),
    "01ARYZ6S41TSV4RRFFQ69G5FAV",
  );
  assertThrows(() => decodeTime("nope"), UlidError);
  assertThrows(() => ulidToBytes("8" + "0".repeat(25)), UlidError);
});

Deno.test("bytes round trip", () => {
  const zero = new Uint8Array(16);
  assertEquals(ulidFromBytes(zero), "0".repeat(26));
  const max = new Uint8Array(16).fill(255);
  assertEquals(ulidFromBytes(max), "7" + "Z".repeat(25));
  assertEquals(ulidToBytes("7" + "Z".repeat(25)), max);
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => i * 17);
  const id = ulidFromBytes(bytes);
  assert(isUlid(id), id);
  assertEquals(ulidToBytes(id), bytes);
  assertEquals(ulidToBytes(id.toLowerCase()), bytes);
  for (let i = 0; i < 200; i++) {
    const random = crypto.getRandomValues(new Uint8Array(16));
    assertEquals(ulidToBytes(ulidFromBytes(random)), random);
  }
  assertThrows(() => ulidFromBytes(new Uint8Array(15)), UlidError);
});

Deno.test("the time is the first six bytes", () => {
  const bytes = ulidToBytes(ulid(0x0102_0304_0506));
  assertEquals(Array.from(bytes.subarray(0, 6)), [1, 2, 3, 4, 5, 6]);
});

Deno.test("UUID round trip", () => {
  const id = "01ARYZ6S41TSV4RRFFQ69G5FAV";
  const uuid = ulidToUuid(id);
  assertEquals(uuid, "01563df3-6481-d676-4c61-efb99302bd5b");
  assertEquals(ulidFromUuid(uuid), id);
  assertEquals(ulidFromUuid(uuid.toUpperCase()), id);
  assertEquals(
    ulidToUuid("0".repeat(26)),
    "00000000-0000-0000-0000-000000000000",
  );
  assertThrows(() => ulidFromUuid("01563df3-6481-d676-4c61"), UlidError);
});

Deno.test("injected clock and randomness", () => {
  const make = ulidFactory({ now: () => 1469918176385, random: fill(0) });
  assertEquals(make(), "01ARYZ6S41" + "0".repeat(16));
  assertEquals(make(0), "0".repeat(26));
  const ones = ulidFactory({ now: () => 0, random: fill(255) });
  assertEquals(ones(), "0".repeat(10) + "Z".repeat(16));
});

Deno.test("fresh ULIDs differ and sort by time", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
  assertEquals(ids.size, 1000);
  assert(ulid(1000) < ulid(1001), "time order");
});

Deno.test("monotonic within a millisecond", () => {
  const next = monotonicFactory({ now: () => 5, random: fill(0) });
  const first = next();
  const second = next();
  const third = next();
  assertEquals(first, "0000000005" + "0".repeat(16));
  assertEquals(second, "0000000005" + "0".repeat(15) + "1");
  assertEquals(third, "0000000005" + "0".repeat(15) + "2");
  let previous = third;
  for (let i = 0; i < 100; i++) {
    const id = next();
    assert(id > previous, `${id} > ${previous}`);
    previous = id;
  }
});

Deno.test("monotonic carries across bytes", () => {
  const next = monotonicFactory({
    now: () => 1,
    random: (bytes) => {
      bytes.fill(0);
      bytes[9] = 0xfe;
    },
  });
  const a = next();
  const b = next();
  const c = next();
  assertEquals(Array.from(ulidToBytes(a).subarray(14)), [0, 0xfe]);
  assertEquals(Array.from(ulidToBytes(b).subarray(14)), [0, 0xff]);
  assertEquals(Array.from(ulidToBytes(c).subarray(14)), [1, 0]);
});

Deno.test("monotonic takes fresh randomness when time moves on", () => {
  let time = 10;
  let calls = 0;
  const next = monotonicFactory({
    now: () => time,
    random: (bytes) => {
      calls++;
      bytes.fill(calls);
    },
  });
  next();
  next();
  assertEquals(calls, 1);
  time = 11;
  const later = next();
  assertEquals(calls, 2);
  assertEquals(decodeTime(later), 11);
});

Deno.test("monotonic keeps the last time when the clock goes back", () => {
  let time = 100;
  const next = monotonicFactory({ now: () => time, random: fill(7) });
  const first = next();
  time = 50;
  const second = next();
  assertEquals(decodeTime(second), 100);
  assert(second > first, "still increasing");
  assertEquals(decodeTime(next(20)), 100);
});

Deno.test("monotonic overflow throws", () => {
  const next = monotonicFactory({ now: () => 3, random: fill(255) });
  assertEquals(next(), "0000000003" + "Z".repeat(16));
  const error = assertThrows(() => next());
  assert(error instanceof UlidError, error.message);
  assert(error.message.includes("overflow"), error.message);
});
