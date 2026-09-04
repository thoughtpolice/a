// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { add } from "@fixture/base";
import { ANSWER } from "@fixture/base/extra";
import { double } from "./internal.ts";

/** Uses both of the base library's entry points and a private module. */
export function score(value: number): number {
  return double(add(value, ANSWER));
}
