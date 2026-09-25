// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  compareIp,
  formatIp,
  IpAddress,
  IpError,
  isIp,
  isIpv4,
  isIpv6,
  parseIp,
  parseIpv4,
  parseIpv6,
  toIp,
} from "@celld/ip";

Deno.test("IPv4", () => {
  for (
    const text of ["0.0.0.0", "127.0.0.1", "255.255.255.255", "192.0.2.10"]
  ) {
    assert(isIpv4(text), text);
    assertEquals(parseIpv4(text)?.toString(), text);
  }
  for (
    const text of [
      "",
      "1.2.3",
      "1.2.3.4.5",
      "256.0.0.1",
      "01.2.3.4",
      "1.2.3.04",
      "1.2.3.-4",
      "1.2.3.4 ",
      " 1.2.3.4",
      "1..3.4",
      "0x7f.0.0.1",
      "1.2.3.4/8",
    ]
  ) {
    assert(!isIpv4(text), text);
    assertEquals(parseIpv4(text), null, text);
  }
  assertEquals(Array.from(parseIpv4("10.20.30.40")!.bytes), [10, 20, 30, 40]);
  assertEquals(parseIpv4("10.20.30.40")!.version, 4);
});

Deno.test("IPv6 parsing", () => {
  const cases: [string, string][] = [
    ["::", "0:0:0:0:0:0:0:0"],
    ["::1", "0:0:0:0:0:0:0:1"],
    ["1::", "1:0:0:0:0:0:0:0"],
    ["2001:db8::1", "2001:db8:0:0:0:0:0:1"],
    ["2001:DB8:0:0:8:800:200C:417A", "2001:db8:0:0:8:800:200c:417a"],
    ["1:2:3:4:5:6:7::", "1:2:3:4:5:6:7:0"],
    ["::2:3:4:5:6:7:8", "0:2:3:4:5:6:7:8"],
    ["::ffff:192.0.2.1", "0:0:0:0:0:ffff:c000:201"],
    ["::192.0.2.1", "0:0:0:0:0:0:c000:201"],
    ["64:ff9b::192.0.2.33", "64:ff9b:0:0:0:0:c000:221"],
    ["1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:102:304"],
    ["0001:0002::", "1:2:0:0:0:0:0:0"],
  ];
  for (const [text, expanded] of cases) {
    assert(isIpv6(text), text);
    const address = parseIpv6(text)!;
    const groups = [];
    const bytes = address.bytes;
    for (let i = 0; i < 16; i += 2) {
      groups.push((bytes[i] << 8 | bytes[i + 1]).toString(16));
    }
    assertEquals(groups.join(":"), expanded, text);
  }
  for (
    const text of [
      "",
      ":",
      ":::",
      "1:::2",
      "1::2::3",
      ":1::",
      "::1:",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7::8",
      "::1:2:3:4:5:6:7:8",
      "12345::",
      "g::",
      "::ffff:256.0.0.1",
      "::ffff:1.2.3",
      "1.2.3.4::",
      "::1.2.3.4:5",
      "1:2:3:4:5:6:7:1.2.3.4",
      "fe80::1%eth0",
      "[::1]",
    ]
  ) {
    assert(!isIpv6(text), text);
  }
});

Deno.test("RFC 5952 formatting", () => {
  const cases: [string, string][] = [
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["2001:DB8::1", "2001:db8::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    ["2001:db8::1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    ["2001:0:0:1:0:0:0:1", "2001:0:0:1::1"],
    ["0:0:0:0:0:0:0:0", "::"],
    ["0:0:0:0:0:0:0:1", "::1"],
    ["1:0:0:0:0:0:0:0", "1::"],
    ["::ffff:c000:0201", "::ffff:192.0.2.1"],
    ["::ffff:192.0.2.1", "::ffff:192.0.2.1"],
    ["::192.0.2.1", "::c000:201"],
    ["::ffff:0:0", "::ffff:0.0.0.0"],
    ["1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8"],
  ];
  for (const [text, canonical] of cases) {
    assertEquals(formatIp(text), canonical, text);
    assertEquals(parseIp(canonical)!.toString(), canonical, canonical);
  }
});

Deno.test("mapped addresses", () => {
  const mapped = parseIp("::ffff:10.1.2.3")!;
  assert(mapped.isIpv4Mapped(), "mapped");
  assertEquals(mapped.toIpv4()?.toString(), "10.1.2.3");
  assertEquals(parseIp("::10.1.2.3")!.toIpv4(), null);
  assertEquals(parseIp("2001:db8::1")!.isIpv4Mapped(), false);
  const v4 = parseIp("10.1.2.3")!;
  assertEquals(v4.toIpv6().toString(), "::ffff:10.1.2.3");
  assert(v4.toIpv6().equals(mapped), "round trip");
  assert(v4.toIpv4() === v4, "identity");
  assertEquals(v4.isIpv4Mapped(), false);
});

Deno.test("parseIp picks the version", () => {
  assertEquals(parseIp("1.2.3.4")?.version, 4);
  assertEquals(parseIp("::1")?.version, 6);
  assertEquals(parseIp("nope"), null);
  assert(isIp("1.2.3.4") && isIp("::") && !isIp("1.2.3.4.5"), "isIp");
});

Deno.test("bytes, comparison and JSON", () => {
  const a = new IpAddress(Uint8Array.of(10, 0, 0, 1));
  const input = Uint8Array.of(10, 0, 0, 2);
  const b = new IpAddress(input);
  input[3] = 99;
  assertEquals(b.toString(), "10.0.0.2");
  b.bytes[0] = 99;
  assertEquals(b.toString(), "10.0.0.2");
  assert(compareIp(a, b) < 0 && compareIp(b, a) > 0, "order");
  assertEquals(compareIp(a, parseIp("10.0.0.1")!), 0);
  assert(compareIp(a, parseIp("::")!) < 0, "IPv4 first");
  assertEquals(
    [parseIp("::2")!, parseIp("10.0.0.1")!, parseIp("::1")!]
      .sort(compareIp)
      .map(String),
    ["10.0.0.1", "::1", "::2"],
  );
  assertEquals(
    JSON.stringify({ at: parseIp("2001:DB8::1") }),
    '{"at":"2001:db8::1"}',
  );
  assertEquals(a.bits, 32);
  assertEquals(parseIp("::")!.bits, 128);
  assertThrows(() => new IpAddress(new Uint8Array(5)), IpError);
});

Deno.test("toIp throws on bad text", () => {
  assertEquals(toIp("1.2.3.4").toString(), "1.2.3.4");
  const address = parseIp("::1")!;
  assert(toIp(address) === address, "passes addresses through");
  assertThrows(() => toIp("1.2.3"), IpError);
  assertThrows(() => formatIp("x"), IpError);
});
