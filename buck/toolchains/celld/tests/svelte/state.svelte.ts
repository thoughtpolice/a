// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import type { FixtureProps } from "./types.ts";

export const state = $state<FixtureProps>({ message: "native", count: 0 });
export function increment(): number {
  state.count += 1;
  return state.count;
}
