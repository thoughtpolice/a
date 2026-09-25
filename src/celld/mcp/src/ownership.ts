// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Who owns what a server keeps between requests: tasks, sealed multi
 * round-trip state and idempotency slots.
 *
 * An authenticated caller is its principal's `key` (`@celld/web/router`: the
 * scheme, issuer, tenant, client id and subject), never its `subject`
 * alone, so equal subjects from two issuers, schemes, tenants or clients
 * are different owners.
 *
 * An anonymous caller (an endpoint with `{ public: true }`, or a public
 * route with no credential sent) owns nothing. A task it starts is owned by
 * a bearer capability instead: the `CreateTaskResult` carries a random
 * 256-bit token in `_meta["celld/task-token"]` ({@link TASK_TOKEN}), the
 * store keeps only its digest, and `tasks/get`, `tasks/update` and
 * `tasks/cancel` must send the token back in the same `_meta` key. It is
 * not single use: whoever holds it can follow, answer and cancel the task
 * for as long as the task lives, so keep it as secret as a password. A listen stream sends
 * one token per task id in `_meta["celld/task-tokens"]` ({@link TASK_TOKENS}).
 * Knowing a task id alone is not enough.
 *
 * @module
 */

import { toBase64Url } from "./json.ts";
import type { Principal } from "./server.ts";

/**
 * The `_meta` entry carrying an anonymous task's token: on the
 * `CreateTaskResult`, and on every `tasks/get`, `tasks/update` and
 * `tasks/cancel` for it.
 */
export const TASK_TOKEN = "celld/task-token";

/**
 * The `_meta` entry of a `subscriptions/listen` request carrying the tokens
 * of the anonymous tasks it names: an object from task id to token.
 */
export const TASK_TOKENS = "celld/task-tokens";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh task token: 256 random bits, base64url (43 characters). */
export function newTaskToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Whether `value` has the shape of a task token. */
export function isTaskToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/**
 * The owner recorded for an anonymous task: a digest of its token. It never
 * equals a principal's key, which always contains NUL separators.
 */
export async function capabilityOwner(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`celld-mcp task token\n${token}`),
  );
  return `capability:${toBase64Url(new Uint8Array(digest))}`;
}

/**
 * The owner a principal stands for: its `key`. Throws when the principal
 * has none (built by hand rather than by `toPrincipal`), so nothing is ever
 * recorded under a partial identity.
 */
export function principalOwner(principal: Principal): string {
  const key = (principal as { key?: unknown }).key;
  if (typeof key !== "string" || !key.includes("\u0000")) {
    throw new TypeError(
      "the principal has no ownership key; build principals with @celld/web/router's toPrincipal",
    );
  }
  return key;
}
