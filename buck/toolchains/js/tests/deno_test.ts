// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { count, greet, later } from "@fixture/plain";
import { count as sharedCount } from "@fixture/plain/state";
import { configValue } from "@fixture/config";

Deno.test("library closure, live exports, dynamic imports and config aliases", async () => {
  const actual = {
    greetings: [greet("Ada"), greet("Grace")],
    count,
    live: sharedCount,
    dynamic: await later(),
    config: configValue,
  };
  const expected = {
    greetings: ["hello, Ada #1", "hello, Grace #2"],
    count: 2,
    live: 2,
    dynamic: "café:ready",
    config: "merged",
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(JSON.stringify(actual));
  }
});
