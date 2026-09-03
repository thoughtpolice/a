// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "../assert.ts";
import { CODE_TO_KEY, KEY_COUNT, KEY_NAMES, keyCode } from "../keys.ts";

/**
 * The key names come from the WIT enum, so the source of truth is the WIT: a
 * key added there without a name here would silently shift every later ordinal.
 */
function keysFromWit(): string[] {
  const wit = Deno.readTextFileSync(
    new URL("../../wit/sdk.wit", import.meta.url),
  );
  const block = wit.match(/enum key \{([^}]*)\}/);
  assert(block !== null, "sdk.wit has no key enum");
  return block[1]
    .split(",")
    .map((name) => name.replace(/\/\/.*$/gm, "").trim())
    .filter((name) => name.length > 0)
    .map((name) => (/^num[0-9]$/.test(name) ? name.slice(3) : name));
}

Deno.test("every key of the WIT enum has the host's name, in order", () => {
  assertEquals(KEY_NAMES, keysFromWit());
  assertEquals(KEY_COUNT, 95);
});

Deno.test("names round trip through their ordinals", () => {
  for (let ordinal = 0; ordinal < KEY_COUNT; ordinal++) {
    assertEquals(keyCode(KEY_NAMES[ordinal]), ordinal, KEY_NAMES[ordinal]);
  }
  assertEquals(keyCode("meta"), -1);
  assertEquals(keyCode(""), -1);
  assertEquals(keyCode("F1"), -1);
});

Deno.test("every key is reachable from a KeyboardEvent.code", () => {
  const reached = new Set(Object.values(CODE_TO_KEY));
  const missing = KEY_NAMES.map((_, ordinal) => ordinal).filter((o) =>
    !reached.has(o)
  );
  assertEquals(missing.map((o) => KEY_NAMES[o]), []);
  for (const [code, ordinal] of Object.entries(CODE_TO_KEY)) {
    assert(
      ordinal >= 0 && ordinal < KEY_COUNT,
      `${code} maps outside the enum`,
    );
  }
});

Deno.test("the codes whose names do not look like their keys", () => {
  assertEquals(CODE_TO_KEY["Quote"], 66);
  assertEquals(CODE_TO_KEY["Backquote"], 70);
  assertEquals(CODE_TO_KEY["Equal"], 61);
  assertEquals(CODE_TO_KEY["Digit0"], 50);
  assertEquals(CODE_TO_KEY["Numpad0"], 79);
  assertEquals(CODE_TO_KEY["NumpadDecimal"], 90);
  assertEquals(CODE_TO_KEY["ShiftRight"], 9);
  assertEquals(CODE_TO_KEY["ShiftLeft"], CODE_TO_KEY["ShiftRight"]);
  assertEquals(CODE_TO_KEY["BracketLeft"], 67);
  assertEquals(CODE_TO_KEY["MetaLeft"], undefined);
});
