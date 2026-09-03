// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The assertions the unit tests use. They live here rather than in a registry
 * package because nothing in this package may reach the network at build time.
 */

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function show(value: unknown): string {
  if (value instanceof Uint8Array || value instanceof Int16Array) {
    return `${value.constructor.name}(${[...value].join(",")})`;
  }
  // JSON.stringify refuses bigints, which the 64-bit halves of the ABI are
  // full of.
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? `${item}n` : item) ??
    String(value);
}

export function assertEquals(actual: unknown, expected: unknown, message = "not equal"): void {
  const a = show(actual);
  const b = show(expected);
  if (a !== b) throw new Error(`${message}: ${a} !== ${b}`);
}

export function assertThrows(body: () => unknown, match?: string | RegExp): Error {
  let error: Error | null = null;
  try {
    body();
  } catch (thrown) {
    error = thrown instanceof Error ? thrown : new Error(String(thrown));
  }
  if (!error) throw new Error("expected a throw");
  if (typeof match === "string" && !error.message.includes(match)) {
    throw new Error(`expected ${JSON.stringify(match)}, got ${JSON.stringify(error.message)}`);
  }
  if (match instanceof RegExp && !match.test(error.message)) {
    throw new Error(`expected ${match}, got ${JSON.stringify(error.message)}`);
  }
  return error;
}
