// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/assert";
import { type JsonValue, MAX_ERROR_TEXT, truncatedBody } from "@celld/http";

Deno.test("an empty body is null and JSON is parsed whole", () => {
  assertEquals(truncatedBody(""), null);
  assertEquals(truncatedBody('{"error":{"message":"no"}}'), {
    error: { message: "no" },
  });
  const long = JSON.stringify({ detail: "x".repeat(10_000) });
  assertEquals(truncatedBody(long), JSON.parse(long));
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
