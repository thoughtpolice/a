// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/core/assert";
import { nextEnabledIndex } from "@celld/web/interactions";

Deno.test("roving navigation wraps and skips disabled items in both directions", () => {
  const enabled = [true, false, true, false];
  assertEquals(nextEnabledIndex(enabled, 0, 1), 2);
  assertEquals(nextEnabledIndex(enabled, 2, 1), 0);
  assertEquals(nextEnabledIndex(enabled, 0, -1), 2);
  assertEquals(nextEnabledIndex(enabled, 2, -1), 0);
});

Deno.test("Home and End choose enabled boundaries, not disabled endpoints", () => {
  const enabled = [false, true, true, false];
  assertEquals(nextEnabledIndex(enabled, -1, 1), 1);
  assertEquals(nextEnabledIndex(enabled, -1, -1), 2);
});

Deno.test("empty and fully disabled menus have no focus destination", () => {
  assertEquals(nextEnabledIndex([], -1, 1), -1);
  assertEquals(nextEnabledIndex([false, false], 0, 1), -1);
  assertEquals(nextEnabledIndex([false, false], 1, -1), -1);
});

Deno.test("one enabled item retains its focus across wraparound", () => {
  assertEquals(nextEnabledIndex([false, true, false], 1, 1), 1);
  assertEquals(nextEnabledIndex([false, true, false], 1, -1), 1);
});
