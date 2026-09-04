// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { add } from "@fixture/base";
import { score } from "@fixture/top";

Deno.test("libraries resolve through their exported specifiers", () => {
  if (add(1, 2) !== 3) throw new Error("add");
  if (score(0) !== 84) throw new Error("score");
});
