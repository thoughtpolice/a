// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A randomized model check of the decision core against its invariants.
 *
 * The generator and the checks live in `model.ts`, so the fake segment's
 * differential test can replay the same sequences; see that module for what
 * is kept side by side and what is asserted after every step.
 *
 * @module
 */

import { run, SEEDS, STEPS } from "./model.ts";
import { assert } from "@celld/assert";

Deno.test("randomized operation sequences preserve every segment invariant", () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    run(seed, STEPS, seen);
  }
});

Deno.test("the generator actually reaches the interesting states", () => {
  // A model test that never steals, never replays, or never trims would pass
  // vacuously, so the outcomes of a few seeds are counted.
  const seen = new Set<string>();
  for (let seed = 1; seed <= 10; seed += 1) run(seed, STEPS, seen);
  for (
    const state of [
      "alloc-lost",
      "steal",
      "write",
      "batch-write",
      "unsafe-write",
      "unsafe-refused",
      "stale-write",
      "replay-same",
      "replay-different",
      "capture-pruned",
      "capture-clipped",
      "capture-trimmed",
      "read-budget",
      "trim",
      "trim-idempotent",
    ]
  ) {
    assert(seen.has(state), `the generator never produced ${state}`);
  }
});
