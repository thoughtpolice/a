// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  Cidr,
  contains,
  IpError,
  isCidr,
  isCidrV4,
  isCidrV6,
  parseCidr,
  parseCidrV4,
  parseCidrV6,
  parseIp,
  toCidr,
} from "@celld/ip";

Deno.test("parsing", () => {
  for (
    const text of ["0.0.0.0/0", "10.0.0.0/8", "192.0.2.7/24", "1.2.3.4/32"]
  ) {
    assert(isCidrV4(text), text);
    assert(!isCidrV6(text), text);
    assert(isCidr(text), text);
  }
  for (
    const text of ["::/0", "2001:db8::/32", "::1/128", "::ffff:10.0.0.0/104"]
  ) {
    assert(isCidrV6(text), text);
    assert(!isCidrV4(text), text);
  }
  for (
    const text of [
      "10.0.0.0",
      "10.0.0.0/",
      "10.0.0.0/33",
      "10.0.0.0/08",
      "10.0.0.0/-1",
      "10.0.0.0/8/8",
      "10.0.0.0/ 8",
      "10.0.0/8",
      "::/129",
      "::/1000",
      "2001:db8::/032",
      "/8",
    ]
  ) {
    assert(!isCidr(text), text);
    assertEquals(parseCidr(text), null, text);
  }
  assertEquals(parseCidrV4("::/0"), null);
  assertEquals(parseCidrV6("0.0.0.0/0"), null);
});

Deno.test("network, broadcast and masks", () => {
  const block = parseCidr("192.0.2.77/26")!;
  assertEquals(block.version, 4);
  assertEquals(block.prefix, 26);
  assertEquals(block.address.toString(), "192.0.2.77");
  assertEquals(block.network.toString(), "192.0.2.64");
  assertEquals(block.broadcast.toString(), "192.0.2.127");
  assertEquals(block.netmask.toString(), "255.255.255.192");
  assertEquals(block.hostmask.toString(), "0.0.0.63");
  assertEquals(block.size, 64n);
  assertEquals(block.isNetwork, false);
  assertEquals(block.toString(), "192.0.2.64/26");
  assertEquals(JSON.stringify(block), '"192.0.2.64/26"');

  const all = parseCidr("0.0.0.0/0")!;
  assertEquals(all.broadcast.toString(), "255.255.255.255");
  assertEquals(all.netmask.toString(), "0.0.0.0");
  assertEquals(all.size, 2n ** 32n);
  const host = parseCidr("10.1.2.3/32")!;
  assertEquals(host.network.toString(), "10.1.2.3");
  assertEquals(host.broadcast.toString(), "10.1.2.3");
  assertEquals(host.size, 1n);

  const v6 = parseCidr("2001:DB8:1:2::abcd/48")!;
  assertEquals(v6.network.toString(), "2001:db8:1::");
  assertEquals(v6.broadcast.toString(), "2001:db8:1:ffff:ffff:ffff:ffff:ffff");
  assertEquals(v6.netmask.toString(), "ffff:ffff:ffff::");
  assertEquals(v6.hostmask.toString(), "::ffff:ffff:ffff:ffff:ffff");
  assertEquals(v6.size, 2n ** 80n);
  assertEquals(v6.toString(), "2001:db8:1::/48");
  assertEquals(
    parseCidr("2001:db8::/33")!.broadcast.toString(),
    "2001:db8:7fff:ffff:ffff:ffff:ffff:ffff",
  );
});

Deno.test("strict mode rejects host bits", () => {
  assertEquals(parseCidr("10.0.0.1/8", { strict: true }), null);
  assert(!isCidrV4("10.0.0.1/8", { strict: true }), "v4");
  assert(isCidrV4("10.0.0.0/8", { strict: true }), "v4 network");
  assert(isCidrV4("10.0.0.1/32", { strict: true }), "host route");
  assert(!isCidrV6("2001:db8::1/64", { strict: true }), "v6");
  assert(isCidrV6("2001:db8::/64", { strict: true }), "v6 network");
  assert(isCidrV4("10.0.0.1/8"), "lenient by default");
});

Deno.test("contains", () => {
  assert(contains("10.0.0.0/8", "10.255.1.2"), "in");
  assert(!contains("10.0.0.0/8", "11.0.0.0"), "out");
  assert(contains("0.0.0.0/0", "255.255.255.255"), "everything");
  assert(contains("192.0.2.77/26", "192.0.2.64"), "written with host bits");
  assert(!contains("192.0.2.77/26", "192.0.2.128"), "past the end");
  assert(contains("2001:db8::/32", "2001:db8:ffff::1"), "v6");
  assert(!contains("2001:db8::/32", "2001:db9::"), "v6 out");
  assert(!contains("10.0.0.0/8", "::ffff:10.0.0.1"), "mapped is not unmapped");
  assert(
    contains("10.0.0.0/8", parseIp("::ffff:10.0.0.1")!.toIpv4()!),
    "unmapped",
  );
  assert(!contains("::/0", "1.2.3.4"), "versions differ");
  assert(contains(parseCidr("::1/128")!, parseIp("::1")!), "objects");
  assertThrows(() => contains("10.0.0.0/33", "10.0.0.1"), IpError);
  assertThrows(() => contains("10.0.0.0/8", "10.0.0"), IpError);
});

Deno.test("covers and overlaps", () => {
  const ten = toCidr("10.0.0.0/8");
  assert(ten.covers("10.1.0.0/16"), "covers");
  assert(ten.covers("10.0.0.0/8"), "itself");
  assert(!ten.covers("0.0.0.0/0"), "wider");
  assert(ten.overlaps("0.0.0.0/0"), "overlaps wider");
  assert(ten.overlaps("10.200.0.0/16"), "overlaps narrower");
  assert(!ten.overlaps("11.0.0.0/8"), "disjoint");
  assert(!ten.overlaps("::/0"), "versions");
});

Deno.test("constructor checks the prefix", () => {
  const address = parseIp("10.0.0.1")!;
  assertEquals(new Cidr(address, 24).toString(), "10.0.0.0/24");
  assertThrows(() => new Cidr(address, 33), IpError);
  assertThrows(() => new Cidr(address, 1.5), IpError);
  assertThrows(() => toCidr("nope"), IpError);
});
