// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { Counter } from "@fixture/objects";

Deno.test("a Durable Object class runs over the fake runtime", () => {
  const counter = new Counter({} as DurableObjectState, {});
  if (counter.increment(0) !== 84) throw new Error("first");
  if (counter.increment(1) !== 170) throw new Error("second");
});
