// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { message } from "@fixture/portable";

export const effects: string[] = [];
export let count = 0;
export function advance(): string {
  count++;
  effects.push(message(String(count)));
  return effects[count - 1];
}
export function response(): Response {
  return new Response(JSON.stringify({ count, effects }));
}
