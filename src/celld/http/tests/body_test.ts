// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/core/assert";
import { type JsonValue, MAX_ERROR_TEXT, truncatedBody } from "@celld/http";

Deno.test("an empty body is null and short JSON is parsed", () => {
  assertEquals(truncatedBody(""), null);
  assertEquals(truncatedBody('{"error":{"message":"no"}}'), {
    error: { message: "no" },
  });
});

// DB-SWP-F8-1: an error body is kept on errors that are logged and sent
// over RPC, so a JSON body is no exception to the cut. This test used to
// assert that a 10,000-character JSON body was kept whole, which was the
// defect: a server could attach megabytes to every error.
Deno.test("JSON longer than the limit is cut like any text", () => {
  const long = JSON.stringify({ detail: "x".repeat(10_000) });
  const kept = truncatedBody(long);
  assertEquals(typeof kept, "string");
  assertEquals((kept as string).length, MAX_ERROR_TEXT + 1);
  assertEquals(kept, `${long.slice(0, MAX_ERROR_TEXT)}…`);
  const deep = "[".repeat(100_000) + "]".repeat(100_000);
  assertEquals((truncatedBody(deep) as string).length, MAX_ERROR_TEXT + 1);
});

Deno.test("text is kept up to the limit, then cut with an ellipsis", () => {
  assertEquals(MAX_ERROR_TEXT, 4096);
  assertEquals(truncatedBody("Bad Gateway"), "Bad Gateway");
  const exact = "y".repeat(MAX_ERROR_TEXT);
  assertEquals(truncatedBody(exact), exact);
  assertEquals(
    truncatedBody("y".repeat(MAX_ERROR_TEXT + 1)),
    `${exact}…`,
  );
  assertEquals(truncatedBody("abcdef", 3), "abc…");
});

Deno.test("the cut never splits a surrogate pair", () => {
  assertEquals(truncatedBody("ab🌍cd", 3), "ab…");
  assertEquals(truncatedBody("ab🌍cd", 4), "ab🌍…");
});

Deno.test("the result is a JsonValue", () => {
  const body: JsonValue = truncatedBody('[1,"two",{"three":null}]');
  assertEquals(body, [1, "two", { three: null }]);
});
