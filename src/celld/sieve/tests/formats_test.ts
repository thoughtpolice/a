// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The formats built on @celld/ip, @celld/isotime, @celld/ulid and
// @celld/jwt: CIDR blocks, ULIDs, JWTs and the `v.iso` family.

import { assert, assertEquals } from "@celld/assert";
import { type AnySchema, v } from "@celld/sieve";
import { defOf } from "@celld/sieve/introspect";
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

function part(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

Deno.test("cidrv4 and cidrv6", () => {
  accepts(v.cidrv4(), [
    "10.0.0.0/8",
    "0.0.0.0/0",
    "192.0.2.7/24",
    "1.2.3.4/32",
  ]);
  rejects(
    v.cidrv4(),
    ["10.0.0.0", "10.0.0.0/33", "10.0.0.0/08", "::/0", "300.0.0.0/8"],
    "cidrv4",
  );
  accepts(v.cidrv6(), [
    "::/0",
    "2001:db8::/32",
    "::ffff:10.0.0.0/104",
    "::1/128",
  ]);
  rejects(
    v.cidrv6(),
    ["2001:db8::", "::/129", "10.0.0.0/8", "1::2::3/64"],
    "cidrv6",
  );
  assertEquals(issues(v.cidrv4(), "x")[0].message, "invalid IPv4 CIDR block");
  assertEquals(
    issues(v.string().cidrv6("need a block"), "x")[0].message,
    "need a block",
  );
});

Deno.test("ulid", () => {
  accepts(v.ulid(), [
    "01ARYZ6S41TSV4RRFFQ69G5FAV",
    "01aryz6s41tsv4rrffq69g5fav",
  ]);
  rejects(
    v.ulid(),
    [
      "",
      "81ARYZ6S41TSV4RRFFQ69G5FAV",
      "01ARYZ6S41TSV4RRFFQ69G5FAI",
      "01ARYZ6S41",
    ],
    "ulid",
  );
  assertEquals(issues(v.ulid(), "x")[0].message, "invalid ULID");
});

Deno.test("jwt: shape only", () => {
  const token = `${part({ alg: "HS256", typ: "JWT" })}.${
    part({ sub: "a" })
  }.c2ln`;
  accepts(v.jwt(), [token]);
  accepts(v.jwt({ alg: "HS256" }), [token]);
  rejects(v.jwt({ alg: "RS256" }), [token], "jwt");
  rejects(
    v.jwt(),
    [
      "a.b.c",
      `${part({ alg: "HS256" })}.${part({ sub: "a" })}`,
      `${part({ typ: "JWT" })}.${part({})}.c2ln`,
      `${part({ alg: "HS256" })}.${part("claims")}.c2ln`,
      `${part({ alg: "HS256", typ: "JWE" })}.${part({})}.c2ln`,
      `${part({ alg: "HS256" })}.${part({})}.`,
    ],
    "jwt",
  );
  assertEquals(issues(v.jwt("bad token"), "x")[0].message, "bad token");
  assertEquals(issues(v.string().jwt({ message: "m" }), "x")[0].message, "m");
  assertEquals(issues(v.jwt(), "x")[0].message, "invalid JWT");
});

Deno.test("iso.time", () => {
  accepts(v.iso.time(), ["00:00", "23:59:59", "12:30:45.123456"]);
  rejects(
    v.iso.time(),
    ["24:00", "12:60", "12:30Z", "12:30:45+01:00", "1:30"],
    "time",
  );
  accepts(v.iso.time({ precision: -1 }), ["12:30"]);
  rejects(v.iso.time({ precision: -1 }), ["12:30:00"], "time");
  accepts(v.iso.time({ precision: 0 }), ["12:30:00"]);
  rejects(v.iso.time({ precision: 0 }), ["12:30", "12:30:00.1"], "time");
  accepts(v.iso.time({ precision: 3 }), ["12:30:00.123"]);
  rejects(v.iso.time({ precision: 3 }), ["12:30:00.12"], "time");
  assertEquals(issues(v.iso.time("when?"), "x")[0].message, "when?");
  assertEquals(
    issues(v.string().isoTime(), "x")[0].message,
    "invalid ISO 8601 time",
  );
});

Deno.test("iso.duration", () => {
  accepts(v.iso.duration(), [
    "P1Y2M3DT4H5M6S",
    "P2W",
    "PT0S",
    "PT1.5H",
    "P1DT0,5S",
  ]);
  rejects(
    v.iso.duration(),
    ["P", "PT", "P1DT", "P1W1D", "-P1D", "P1.5DT1H"],
    "duration",
  );
  assertEquals(
    issues(v.string().isoDuration(), "x")[0].message,
    "invalid ISO 8601 duration",
  );
});

Deno.test("iso.date and iso.datetime are isoDate and datetime", () => {
  assertEquals(defOf(v.iso.date()), defOf(v.isoDate()));
  assertEquals(
    defOf(v.iso.datetime({ offset: true, precision: 3 })),
    defOf(v.datetime({ offset: true, precision: 3 })),
  );
  accepts(v.iso.datetime({ offset: true }), ["2026-09-25T12:34:56+05:30"]);
  rejects(v.iso.date(), ["2023-02-29"], "date");
  accepts(v.iso.datetime({ precision: -1 }), ["2026-09-25T12:34Z"]);
  rejects(
    v.iso.datetime({ precision: -1 }),
    ["2026-09-25T12:34:56Z"],
    "datetime",
  );
});

Deno.test("defs record the new formats", () => {
  assertEquals(defOf(v.jwt({ alg: "ES256" })).checks, [
    { check: "format", format: "jwt", alg: "ES256" },
  ]);
  assertEquals(defOf(v.iso.time({ precision: 0 })).checks, [
    { check: "format", format: "time", precision: 0 },
  ]);
  for (
    const [schema, format] of [
      [v.cidrv4(), "cidrv4"],
      [v.cidrv6(), "cidrv6"],
      [v.ulid(), "ulid"],
      [v.iso.duration(), "duration"],
    ] as const
  ) {
    assertEquals(defOf(schema).checks, [{ check: "format", format }]);
  }
});

Deno.test("formats chain with other checks", () => {
  const schema = v.string().trim().toUpperCase().ulid();
  assertEquals(
    schema.parse(" 01aryz6s41tsv4rrffq69g5fav "),
    "01ARYZ6S41TSV4RRFFQ69G5FAV",
  );
  assertEquals(v.cidrv4().optional().parse(undefined), undefined);
});
