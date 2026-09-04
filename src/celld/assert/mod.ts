// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Assertions for celld Deno tests, imported as "@celld/assert".
 *
 * celld code has no module registry dependencies (a JSR assertion library
 * would need a lockfile and a network fetch), so tests share these instead.
 * The comparison understands `Uint8Array`, which is the one value shape these
 * tests care about that structural JSON equality gets wrong.
 * `assertThrows(fn, Class?, includes?)` and `assertRejects(work, Class?,
 * includes?)` return the error for further checks; use them rather than a
 * local try/catch helper.
 *
 * @module
 */

/** Structural equality over plain data: objects, arrays and byte arrays. */
export function equals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.length === right.length &&
      left.every((byte, index) => byte === right[index]);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((item, index) => equals(item, right[index]));
  }
  if (
    typeof left === "object" && typeof right === "object" &&
    left !== null && right !== null
  ) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && equals(a[key], b[key]));
  }
  return false;
}

/** Renders a value with byte arrays spelled out rather than as `{}`. */
export function show(value: unknown): string {
  const text = JSON.stringify(
    value,
    (_key, item) => item instanceof Uint8Array ? Array.from(item) : item,
  );
  return text ?? String(value);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

/** Fails with the whole result, so an unexpected success is readable. */
export function assertCode(result: unknown, code: string): void {
  const actual = (result as { code?: unknown }).code;
  if (actual !== code) {
    throw new Error(`expected code ${code}, got ${show(result)}`);
  }
}

/** Asserts a successful result and narrows it for the caller's field checks. */
export function assertOk<T extends { ok: boolean }>(
  result: T,
): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${show(result)}`);
  return result as Extract<T, { ok: true }>;
}

/** A class of errors, abstract or not, for {@link assertThrows}. */
// deno-lint-ignore no-explicit-any
export type ErrorClass<E extends Error> = abstract new (...args: any[]) => E;

/**
 * Checks what a call threw: it must be an `Error`, an instance of `type` when
 * one is given, and its message must contain `includes`.
 */
function thrown<E extends Error>(
  error: unknown,
  type: ErrorClass<E> | undefined,
  includes: string | undefined,
): E {
  if (!(error instanceof (type ?? Error))) {
    const want = type?.name ?? "an Error";
    throw new Error(`expected ${want} to be thrown, got ${String(error)}`);
  }
  const found = error as E;
  if (includes !== undefined && !found.message.includes(includes)) {
    throw new Error(
      `expected a message containing ${show(includes)}, got ${
        show(found.message)
      }`,
    );
  }
  return found;
}

/**
 * Asserts that `fn` throws synchronously and returns the error, so the caller
 * can check its fields. With `type` the error must be an instance of it; with
 * `includes` its message must contain that text.
 */
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
    // A rejected promise would otherwise surface as an unhandled rejection.
    result.catch(() => {});
    throw new Error("expected a throw, got a promise (use assertRejects)");
  }
  throw new Error("expected a throw");
}

/**
 * The asynchronous {@link assertThrows}: awaits `work` (a promise, or a
 * function returning one, which may also throw synchronously) and returns
 * the rejection.
 */
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
