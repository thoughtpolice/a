// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { label } from "@fixture/tokens";
import { bump } from "./state.js";
export { count } from "./state.js";

/** @param {string} name */
export function greet(name) {
  return `${label(name)} #${bump()}`;
}
export async function later() {
  const prefix = "café";
  return `${prefix}:${(await import("./lazy.js")).suffix}`;
}
