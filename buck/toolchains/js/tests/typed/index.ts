// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { multiply } from "./math.ts";
import { Token } from "./registration.ts";
export { events } from "./events.ts";
export enum Label {
  One = "one",
  Alias = One,
}
export { multiply } from "./math.ts";

export function doubled(value: number): number {
  return multiply(value, 2);
}
export function identity(value: Token): Token {
  return value;
}
export async function lazy(): Promise<string> {
  const prefix = "naïve";
  return `${prefix}:${(await import("./lazy.ts")).suffix}`;
}

export function fail(): never {
  throw new Error("mapped");
}

import "./augment.ts";
