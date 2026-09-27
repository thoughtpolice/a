// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  arrayLiteral,
  encodeParam,
  ident,
  join,
  json,
  OID,
  ParamError,
  parseArray,
  parseBytea,
  parsers,
  parseTimestamptz,
  raw,
  sql,
  ValueParseError,
} from "@celld/api/neon";

Deno.test("parameters encode to the text Postgres reads", () => {
  assertEquals(encodeParam(null), null);
  assertEquals(encodeParam(undefined), null);
  assertEquals(encodeParam(9223372036854775807n), "9223372036854775807");
  assertEquals(encodeParam(-0), "0");
  assertEquals(encodeParam(true), "true");
  assertEquals(encodeParam(new Uint8Array([0, 15, 255])), "\\x000fff");
  assertEquals(
    encodeParam(Temporal.Instant.from("2026-01-01T00:00:00Z")),
    "2026-01-01T00:00:00Z",
  );
  assertEquals(encodeParam({ a: [1] }), '{"a":[1]}');
  assertEquals(encodeParam(json([1, 2])), "[1,2]");
  assertThrows(() => encodeParam("a\0b"), ParamError, "NUL");
  assertThrows(() => encodeParam(new Map() as never), ParamError, "json()");
  assertThrows(() => encodeParam(Symbol() as never), ParamError);
});

Deno.test("arrays become escaped literals (Neon's own conversion mangles escapes)", () => {
  assertEquals(
    arrayLiteral(["a\nb", 'c"d', "e\\f", "g,h", null, "NULL", ""]),
    '{"a\nb","c\\"d","e\\\\f","g,h",NULL,"NULL",""}',
  );
  assertEquals(arrayLiteral([[1, 2], [3, null]]), '{{"1","2"},{"3",NULL}}');
  assertEquals(encodeParam([]), "{}");
});

Deno.test("array literals parse back, quoted and nested", () => {
  const text = (s: string) => s;
  assertEquals(parseArray('{"a\\"b","c,d",NULL,"NULL",x}', text), [
    'a"b',
    "c,d",
    null,
    "NULL",
    "x",
  ]);
  assertEquals(parseArray("{{1,2},{3,NULL}}", Number), [[1, 2], [3, null]]);
  assertEquals(parseArray("[0:1]={7,8}", Number), [7, 8]);
  assertEquals(parseArray("{}", text), []);
  assertThrows(() => parseArray("{1,2", Number), ValueParseError);
  assertThrows(() => parseArray('{"a}', text), ValueParseError);
});

Deno.test("values parse by type OID", () => {
  const p = parsers();
  const parse = (oid: number, text: string) => p.get(oid)!(text);
  assertEquals(parse(OID.int8, "9223372036854775807"), 9223372036854775807n);
  assertEquals(parse(OID.numeric, "1.10"), "1.10");
  assertEquals(parse(OID.bool, "t"), true);
  assert(Number.isNaN(parse(OID.float8, "NaN") as number), "NaN");
  assertEquals(parse(OID.float8, "-Infinity"), -Infinity);
  assertEquals(parse(OID.jsonb, '{"a":1}'), { a: 1 });
  assertEquals(parse(OID._int4, "{1,NULL}"), [1, null]);
  assertEquals(String(parse(OID.date, "2026-01-02")), "2026-01-02");
  assertEquals(parse(OID.date, "infinity"), "infinity");
  assertEquals(
    parse(OID.timestamp, "0044-03-15 12:00:00 BC"),
    "0044-03-15 12:00:00 BC",
  );
  assertEquals([...parseBytea("\\xdead")], [0xde, 0xad]);
  assertThrows(() => parse(OID.int4, "1.5"), ValueParseError);
  assertEquals(parsers({ int8: "string" }).get(OID.int8)!("1"), "1");
  assertThrows(
    () => parsers({ int8: "number" }).get(OID.int8)!("9223372036854775807"),
    ValueParseError,
    "bigint",
  );
  assertEquals(parsers({ temporal: false }).get(OID.date), undefined);
  assertEquals(
    parsers({ parsers: { 12345: (s) => s.length } }).get(12345)!("abc"),
    3,
  );
});

Deno.test("timestamptz offsets in every form Postgres prints", () => {
  const at = (s: string) =>
    (parseTimestamptz(s) as Temporal.Instant).toString();
  assertEquals(
    at("2026-09-27 02:03:06.032994+00"),
    "2026-09-27T02:03:06.032994Z",
  );
  assertEquals(at("2026-09-27 07:33:06+05:30"), "2026-09-27T02:03:06Z");
  assertEquals(at("1900-01-01 00:00:00-00:01:15"), "1900-01-01T00:01:15Z");
  assertEquals(parseTimestamptz("-infinity"), "-infinity");
});

Deno.test("sql keeps values out of the text and renumbers spliced queries", () => {
  const inner = sql`owner = ${"alice"}`;
  const q = sql`SELECT * FROM ${
    ident(["app", 'we"ird'])
  } WHERE ${inner} AND id = ANY(${[1, 2]}) ${raw("ORDER BY id")}`;
  assertEquals(
    q.text,
    'SELECT * FROM "app"."we""ird" WHERE owner = $1 AND id = ANY($2) ORDER BY id',
  );
  assertEquals(q.params, ["alice", [1, 2]]);
  assertEquals(
    join([sql`a = ${1}`, sql`b = ${2}`], " AND ").text,
    "a = $1 AND b = $2",
  );
  assertThrows(() => ident(""), TypeError);
});
