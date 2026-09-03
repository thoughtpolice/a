// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "../assert.ts";
import { fit } from "../render.ts";

Deno.test("a 4:3 frame fills the canvas and is centred in what is left", () => {
  const frame = { width: 320, height: 200 };
  assertEquals(fit(frame, { width: 800, height: 600 }, "4:3"), {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  });
  assertEquals(fit(frame, { width: 1000, height: 600 }, "4:3"), {
    x: 100,
    y: 0,
    width: 800,
    height: 600,
  });
  assertEquals(fit(frame, { width: 800, height: 900 }, "4:3"), {
    x: 0,
    y: 150,
    width: 800,
    height: 600,
  });
});

Deno.test("square pixels scale by whole numbers while a whole number fits", () => {
  const frame = { width: 320, height: 200 };
  assertEquals(fit(frame, { width: 1000, height: 800 }, "frame"), {
    x: 20,
    y: 100,
    width: 960,
    height: 600,
  });
  // Below one whole multiple there is nothing to snap to.
  const large = fit({ width: 320, height: 200 }, { width: 300, height: 300 }, "frame");
  assertEquals([large.width, large.height], [300, 188]);
});

Deno.test("a run that has presented nothing occupies nothing", () => {
  assertEquals(fit({ width: 0, height: 0 }, { width: 800, height: 600 }, "4:3"), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
});
