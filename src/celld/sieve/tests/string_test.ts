// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { type AnySchema, v } from "@celld/sieve";
import { issues } from "./fixture.ts";

function accepts(schema: AnySchema, values: unknown[]) {
  for (const value of values) {
    assert(
      schema.safeParse(value).success,
      `should accept ${JSON.stringify(value)}`,
    );
  }
}

function rejects(schema: AnySchema, values: unknown[], format: string) {
  for (const value of values) {
    const found = issues(schema, value);
    assertEquals(
      found.map((issue) => [issue.code, (issue as { format?: string }).format]),
      [["invalid_format", format]],
      JSON.stringify(value),
    );
  }
}

Deno.test("lengths", () => {
  assertEquals(v.string().min(2).parse("ab"), "ab");
  assertEquals(issues(v.string().min(2), "a"), [{
    code: "too_small",
    origin: "string",
    minimum: 2,
    inclusive: true,
    path: [],
    message: "must have at least 2 characters",
  }]);
  assertEquals(issues(v.string().max(1), "ab"), [{
    code: "too_big",
    origin: "string",
    maximum: 1,
    inclusive: true,
    path: [],
    message: "must have at most 1 character",
  }]);
  assertEquals(issues(v.string().length(2), "a"), [{
    code: "too_small",
    origin: "string",
    minimum: 2,
    inclusive: true,
    exact: true,
    path: [],
    message: "must have exactly 2 characters",
  }]);
  assertEquals(issues(v.string().nonempty(), "")[0].code, "too_small");
  assertEquals(
    issues(v.string().nonempty("required"), "")[0].message,
    "required",
  );
});

Deno.test("patterns and affixes", () => {
  assertEquals(v.string().regex(/^a+$/).parse("aa"), "aa");
  assertEquals(issues(v.string().regex(/^a+$/i), "b"), [{
    code: "invalid_format",
    format: "regex",
    pattern: "/^a+$/i",
    path: [],
    message: "must match /^a+$/i",
  }]);
  const sticky = v.string().regex(/a/g);
  assertEquals([sticky.is("a"), sticky.is("a"), sticky.is("a")], [
    true,
    true,
    true,
  ]);
  assertEquals(issues(v.string().startsWith("sk-"), "pk-1"), [{
    code: "invalid_format",
    format: "starts_with",
    prefix: "sk-",
    path: [],
    message: 'must start with "sk-"',
  }]);
  assertEquals(issues(v.string().endsWith(".ts"), "a.js"), [{
    code: "invalid_format",
    format: "ends_with",
    suffix: ".ts",
    path: [],
    message: 'must end with ".ts"',
  }]);
  assertEquals(issues(v.string().includes("@"), "a"), [{
    code: "invalid_format",
    format: "includes",
    includes: "@",
    path: [],
    message: 'must include "@"',
  }]);
});

Deno.test("email", () => {
  accepts(v.email(), [
    "a@b.co",
    "first.last+tag@sub.example.org",
    "x_y@a-b.io",
  ]);
  rejects(
    v.email(),
    [
      "a",
      "a@b",
      "@b.co",
      "a@@b.co",
      ".a@b.co",
      "a.@b.co",
      "a..b@c.co",
      "a@-b.co",
      "a b@c.co",
    ],
    "email",
  );
  assertEquals(issues(v.email(), "x")[0].message, "invalid email address");
  assertEquals(
    issues(v.string().email("bad email"), "x")[0].message,
    "bad email",
  );
});

Deno.test("url and uuid", () => {
  accepts(v.url(), [
    "https://example.com/a?b#c",
    "mailto:a@b.co",
    "http://[::1]:80",
  ]);
  rejects(v.url(), ["example.com", "http//x", ""], "url");
  accepts(v.uuid(), [
    "123e4567-e89b-12d3-a456-426614174000",
    "0190C0DE-7A1B-7CDE-8F00-000000000001",
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
  ]);
  rejects(
    v.uuid(),
    [
      "123e4567-e89b-02d3-a456-426614174000",
      "123e4567-e89b-12d3-c456-426614174000",
      "123e4567e89b12d3a456426614174000",
    ],
    "uuid",
  );
});

Deno.test("datetime and isoDate", () => {
  accepts(v.datetime(), [
    "2026-09-25T12:34Z",
    "2026-09-25T12:34:56Z",
    "2026-09-25T12:34:56.789Z",
    "2024-02-29T00:00:00Z",
  ]);
  rejects(
    v.datetime(),
    [
      "2026-09-25",
      "2026-09-25T12:34:56",
      "2026-09-25T12:34:56+02:00",
      "2026-13-01T00:00Z",
      "2025-02-29T00:00Z",
      "2026-09-25T24:00Z",
      "2026-09-25 12:34Z",
    ],
    "datetime",
  );
  accepts(v.datetime({ offset: true }), [
    "2026-09-25T12:34:56+05:30",
    "2026-09-25T12:34:56-08:00",
    "2026-09-25T12:34:56Z",
  ]);
  rejects(
    v.datetime({ offset: true }),
    ["2026-09-25T12:34:56+0530"],
    "datetime",
  );
  accepts(v.datetime({ local: true }), [
    "2026-09-25T12:34:56",
    "2026-09-25T12:34:56Z",
  ]);
  accepts(v.datetime({ precision: 3 }), ["2026-09-25T12:34:56.123Z"]);
  rejects(v.datetime({ precision: 3 }), [
    "2026-09-25T12:34:56Z",
    "2026-09-25T12:34Z",
    "2026-09-25T12:34:56.1Z",
  ], "datetime");
  accepts(v.datetime({ precision: 0 }), ["2026-09-25T12:34:56Z"]);
  rejects(v.datetime({ precision: 0 }), ["2026-09-25T12:34:56.1Z"], "datetime");
  assertEquals(issues(v.datetime("when?"), "x")[0].message, "when?");

  accepts(v.isoDate(), ["2026-09-25", "2000-02-29"]);
  rejects(v.isoDate(), [
    "2026-9-25",
    "1900-02-29",
    "2026-04-31",
    "2026-09-25T00:00Z",
  ], "date");
});

Deno.test("encodings", () => {
  accepts(v.base64(), ["", "YQ==", "YWI=", "YWJj", "+/+/"]);
  rejects(v.base64(), ["YQ", "Y===", "YW=j", "-_-_"], "base64");
  accepts(v.base64url(), ["", "YQ", "YWI", "YWJj", "-_-_"]);
  rejects(v.base64url(), ["YQ==", "Y", "YWJjZ", "+/+/"], "base64url");
  accepts(v.hex(), ["", "00ff", "ABCdef", "abc"]);
  rejects(v.hex(), ["0x00", "g0"], "hex");
});

Deno.test("ip addresses", () => {
  accepts(v.ipv4(), ["0.0.0.0", "192.168.1.1", "255.255.255.255"]);
  rejects(
    v.ipv4(),
    ["256.0.0.1", "1.2.3", "01.2.3.4", "1.2.3.4.5", "::1"],
    "ipv4",
  );
  accepts(v.ipv6(), [
    "::",
    "::1",
    "1::",
    "2001:db8::8a2e:370:7334",
    "2001:0db8:0000:0000:0000:ff00:0042:8329",
    "::ffff:192.0.2.128",
    "64:ff9b::1.2.3.4",
  ]);
  rejects(v.ipv6(), [
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    ":1",
    "1:",
    "12345::",
    "1.2.3.4",
    "1.2.3.4::",
    "::1.2.3",
    "1:2:3:4:5:6:7::8",
  ], "ipv6");
});

Deno.test("rewrites run in order with the checks", () => {
  assertEquals(v.string().trim().parse("  a  "), "a");
  assertEquals(v.string().toLowerCase().parse("AbC"), "abc");
  assertEquals(v.string().toUpperCase().parse("AbC"), "ABC");
  const slug = v.string().trim().toLowerCase().regex(/^[a-z]+$/);
  assertEquals(slug.parse("  Hello "), "hello");
  assertEquals(issues(v.string().trim().min(1), "   ")[0].code, "too_small");
  assertEquals(v.string().min(3).trim().parse("  a  "), "a");
});

Deno.test("top-level formats are string schemas", () => {
  assertEquals(v.email().max(6).safeParse("a@b.co").success, true);
  assertEquals(
    issues(v.uuid().startsWith("0"), "123e4567-e89b-12d3-a456-426614174000")[0]
      .code,
    "invalid_format",
  );
});
