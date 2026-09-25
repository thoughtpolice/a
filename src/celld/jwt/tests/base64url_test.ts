// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { fromBase64Url, isBase64Url, toBase64Url } from "@celld/jwt";

Deno.test("RFC 4648 vectors, unpadded and URL-safe", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["f", "Zg"],
    ["fo", "Zm8"],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg"],
    ["fooba", "Zm9vYmE"],
    ["foobar", "Zm9vYmFy"],
  ];
  for (const [plain, encoded] of cases) {
    assertEquals(toBase64Url(plain), encoded);
    assertEquals(new TextDecoder().decode(fromBase64Url(encoded)!), plain);
  }
  assertEquals(toBase64Url(Uint8Array.of(0xfb, 0xff, 0xbf)), "-_-_");
  assertEquals(fromBase64Url("-_-_"), Uint8Array.of(0xfb, 0xff, 0xbf));
});

Deno.test("round trips every length", () => {
  for (let length = 0; length < 70; length++) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    const text = toBase64Url(bytes);
    assertEquals(fromBase64Url(text), bytes);
    assertEquals(
      btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replaceAll(
        "+",
        "-",
      ).replaceAll("/", "_"),
      text,
    );
  }
});

Deno.test("rejects anything else", () => {
  for (
    const text of ["Zg==", "Zm9v+", "Zm9v/", "Z", "Zm9vY", "Zm 9v", "Zh", "Zm9"]
  ) {
    assert(!isBase64Url(text), text);
  }
  assert(isBase64Url("Zm8"), "canonical");
  assertEquals(fromBase64Url("Zm9"), null);
});
