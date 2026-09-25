// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The patterns must agree with the parsers on every input, valid or not.

import { assertEquals } from "@celld/assert";
import { isCidrV4, isCidrV6, isIpv4, isIpv6 } from "@celld/ip";
import {
  CIDR_V4_PATTERN,
  CIDR_V6_PATTERN,
  IPV4_PATTERN,
  IPV6_PATTERN,
} from "@celld/ip/patterns";

const V4 = [
  "0.0.0.0",
  "1.2.3.4",
  "255.255.255.255",
  "256.1.1.1",
  "01.2.3.4",
  "1.2.3",
  "1.2.3.4.5",
  "",
  "a.b.c.d",
];

const V6 = [
  "::",
  "::1",
  "1::",
  "1:2:3:4:5:6:7:8",
  "1:2:3:4:5:6:7::",
  "::2:3:4:5:6:7:8",
  "1::8",
  "1:2::7:8",
  "1:2:3::6:7:8",
  "1:2:3:4::5:6:7",
  "::ffff:1.2.3.4",
  "::1.2.3.4",
  "1::1.2.3.4",
  "1:2:3:4:5::1.2.3.4",
  "1:2:3:4:5:6:1.2.3.4",
  "1:2:3:4:5:6:7:1.2.3.4",
  "1:2:3:4:5:6::1.2.3.4",
  "1:2:3:4:5:6:7:8:9",
  "1:2:3:4:5:6:7",
  ":::",
  "1::2::3",
  ":1::",
  "1:",
  "12345::",
  "ABCD:ef01::",
  "::ffff:256.1.1.1",
  "::1.2.3",
];

function random(alphabet: string): string {
  const length = 1 + Math.floor(Math.random() * 20);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function agree(
  pattern: string,
  test: (text: string) => boolean,
  inputs: string[],
) {
  const regex = new RegExp(pattern);
  for (const input of inputs) {
    assertEquals(regex.test(input), test(input), JSON.stringify(input));
  }
}

Deno.test("addresses", () => {
  agree(IPV4_PATTERN, isIpv4, V4);
  agree(IPV6_PATTERN, isIpv6, [...V6, ...V4]);
});

Deno.test("blocks", () => {
  const prefixes = ["0", "8", "32", "33", "64", "128", "129", "08", ""];
  agree(
    CIDR_V4_PATTERN,
    isCidrV4,
    V4.flatMap((a) => prefixes.map((p) => `${a}/${p}`)),
  );
  agree(
    CIDR_V6_PATTERN,
    isCidrV6,
    V6.flatMap((a) => prefixes.map((p) => `${a}/${p}`)),
  );
});

Deno.test("random strings", () => {
  const inputs = Array.from(
    { length: 20000 },
    () => random("0123456789abcdef:.:"),
  );
  agree(IPV6_PATTERN, isIpv6, inputs);
  agree(
    IPV4_PATTERN,
    isIpv4,
    Array.from({ length: 5000 }, () => random("0123456789.")),
  );
});
