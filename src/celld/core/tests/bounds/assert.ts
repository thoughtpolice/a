// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The few assertions the bounds tests need, stricter than
 * `@celld/core/assert`: values compare with `Object.is`, so a parse that
 * turns `-0` into `0` fails its agreement with `JSON.parse`, and `Map`,
 * `Set` and `Date` compare by content.
 *
 * @module
 */

type ErrorClass<E extends Error> = new (...args: never[]) => E;

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof Map && b instanceof Map) {
    return a.size === b.size &&
      [...a].every(([k, v]) => b.has(k) && equals(v, b.get(k)));
  }
  if (a instanceof Set && b instanceof Set) {
    return a.size === b.size && [...a].every((v) => b.has(v));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equals(v, b[i]));
  }
  if (
    typeof a === "object" && a !== null && typeof b === "object" &&
    b !== null &&
    !Array.isArray(a) && !Array.isArray(b)
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length &&
      ka.every((k) =>
        Object.hasOwn(b, k) &&
        equals(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        )
      );
  }
  return false;
}

function show(value: unknown): string {
  try {
    return typeof value === "string" ? JSON.stringify(value) : String(
      value instanceof Uint8Array
        ? `Uint8Array(${value.length})`
        : JSON.stringify(value) ?? value,
    );
  } catch {
    return String(value);
  }
}

export function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (!equals(actual, expected)) {
    const prefix = message === undefined ? "" : `${message}: `;
    throw new Error(`${prefix}expected ${show(expected)}, got ${show(actual)}`);
  }
}

function thrown<E extends Error>(
  error: unknown,
  type?: ErrorClass<E>,
  includes?: string,
): E {
  if (type !== undefined && !(error instanceof type)) {
    throw new Error(`expected a ${type.name}, got ${String(error)}`);
  }
  if (!(error instanceof Error)) {
    throw new Error(`expected an Error, got ${String(error)}`);
  }
  if (includes !== undefined && !error.message.includes(includes)) {
    throw new Error(
      `expected the message to include ${JSON.stringify(includes)}, got ${
        JSON.stringify(error.message)
      }`,
    );
  }
  return error as E;
}

export function assertThrows(fn: () => unknown): Error;
export function assertThrows<E extends Error>(
  fn: () => unknown,
  type: ErrorClass<E>,
  includes?: string,
): E;
export function assertThrows<E extends Error>(
  fn: () => unknown,
  type?: ErrorClass<E>,
  includes?: string,
): E {
  let result: unknown;
  try {
    result = fn();
  } catch (error) {
    return thrown(error, type, includes);
  }
  if (result instanceof Promise) {
    result.catch(() => {});
    throw new Error("expected a throw, got a promise (use assertRejects)");
  }
  throw new Error("expected a throw");
}

export function assertRejects(
  work: PromiseLike<unknown> | (() => unknown),
): Promise<Error>;
export function assertRejects<E extends Error>(
  work: PromiseLike<unknown> | (() => unknown),
  type: ErrorClass<E>,
  includes?: string,
): Promise<E>;
export async function assertRejects<E extends Error>(
  work: PromiseLike<unknown> | (() => unknown),
  type?: ErrorClass<E>,
  includes?: string,
): Promise<E> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    return thrown(error, type, includes);
  }
  throw new Error("expected a rejection");
}
