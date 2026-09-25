// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/core/assert";
import { router } from "@celld/web/router";

// Repeatable warmed scaling sample. No wall-clock assertion: CI hosts vary.
// The 2,000-route request/collision checks are also a functional regression.
Deno.test("Daybreak incremental registration scaling and atomic collisions", async () => {
  const samples: Record<number, number[]> = {};
  for (let round = 0; round < 8; round++) {
    for (const size of [250, 500, 1000, 2000]) {
      const app = router({ auth: "none" });
      const start = performance.now();
      for (let i = 0; i < size; i++) {
        app.get(`/r${i}/:id`, (c) => c.text(c.params.id));
      }
      const elapsed = performance.now() - start;
      if (round > 1) (samples[size] ??= []).push(elapsed);
      let rejected = false;
      try {
        app.get("/r0/:other", (c) => c.text("bad"));
      } catch {
        rejected = true;
      }
      assertEquals(rejected, true);
      const response = await app.fetch(
        new Request(`https://example.test/r${size - 1}/value`),
      );
      assertEquals(response.status, 200);
      assertEquals(await response.text(), "value");
      assertEquals(app.routes().length, size);
    }
  }
  console.info(
    "registration median ms",
    Object.fromEntries(
      Object.entries(samples).map(([size, runs]) => [
        size,
        runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)],
      ]),
    ),
  );
});
