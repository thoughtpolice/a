// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import { parseIp } from "@celld/core/ip";
import {
  importKeySecret,
  ipKey,
  shardOf,
  storageKey,
} from "@celld/sec/ratelimit";

Deno.test("ip keys: one per IPv4 address and per IPv6 /64 by default", () => {
  assertEquals(ipKey("192.0.2.10"), "ip:192.0.2.10/32");
  assertEquals(ipKey("2001:db8:1:2::99"), "ip:2001:db8:1:2::/64");
  assertEquals(
    ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
    ipKey("2001:db8:1:2::1"),
  );
  assert(
    ipKey("2001:db8:1:3::1") !== ipKey("2001:db8:1:2::1"),
    "another /64 is another key",
  );
  assertEquals(ipKey(parseIp("198.51.100.7")), "ip:198.51.100.7/32");
});

Deno.test("ip keys: mapped IPv4 counts as IPv4, and prefixes are settings", () => {
  assertEquals(ipKey("::ffff:192.0.2.10"), "ip:192.0.2.10/32");
  assertEquals(ipKey("192.0.2.10", { ipv4Prefix: 24 }), "ip:192.0.2.0/24");
  assertEquals(
    ipKey("2001:db8:1:2::99", { ipv6Prefix: 48 }),
    "ip:2001:db8:1::/48",
  );
  assertThrows(() => ipKey("192.0.2.10", { ipv4Prefix: 33 }), RangeError);
  assertThrows(() => ipKey("::1", { ipv6Prefix: -1 }), RangeError);
  assertThrows(() => ipKey("::1", { ipv6Prefix: 1.5 }), RangeError);
});

Deno.test("ip keys: an unknown address shares one key; a bad one throws", () => {
  assertEquals(ipKey(null), "ip:unknown");
  assertThrows(() => ipKey("not-an-ip"), TypeError, "not an IP address");
  assertThrows(() => ipKey("192.0.2.10/24"), TypeError);
});

Deno.test("storage keys: 64 hex digits, separated by limiter name", async () => {
  const a = await storageKey("login", "ip:192.0.2.10/32");
  assert(/^[0-9a-f]{64}$/.test(a), a);
  assertEquals(await storageKey("login", "ip:192.0.2.10/32"), a);
  assert(a !== await storageKey("api", "ip:192.0.2.10/32"), "name separates");
  // A name cannot hold the NUL separator, so "a" + "b\0c" has no twin.
  await assertRejects(() => storageKey("a\u0000b", "c"), TypeError);
  await assertRejects(() => storageKey("", "c"), TypeError);
});

Deno.test("storage keys: a secret keys the hash and must be 32 bytes", async () => {
  const secret = await importKeySecret("s".repeat(32));
  const other = await importKeySecret(new Uint8Array(32).fill(7));
  const plain = await storageKey("login", "user:alice");
  const keyed = await storageKey("login", "user:alice", secret);
  assert(keyed !== plain, "keyed differs from plain");
  assert(
    keyed !== await storageKey("login", "user:alice", other),
    "the secret matters",
  );
  await assertRejects(() => importKeySecret("short"), RangeError, "32 bytes");
});

Deno.test("shards: the first 32 bits, modulo the count", () => {
  const key = "ffffffff" + "0".repeat(56);
  assertEquals(shardOf(key, 16), 0xffffffff % 16);
  assertEquals(shardOf("0".repeat(64), 7), 0);
  for (let i = 0; i < 100; i++) {
    const shard = shardOf(
      crypto.randomUUID().replaceAll("-", "") + "0".repeat(32),
      13,
    );
    assert(shard >= 0 && shard < 13, `shard ${shard}`);
  }
});
