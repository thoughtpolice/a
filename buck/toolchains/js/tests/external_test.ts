// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { styles } from "@fixture/external";

Deno.test("portable bare imports resolve declared archive-backed dependencies", () => {
  if (styles() !== "hello active") {
    throw new Error("incorrect conditional classes");
  }
});
