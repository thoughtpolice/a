// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Idempotency keys for `tools/call`: how a client may safely send a
 * mutation again after the answer was lost.
 *
 * The client puts a key it chose in `_meta["celld/idempotency-key"]` and
 * sends the same key on every retry of that one logical call. A server
 * configured with an {@link IdempotencyStore} runs a `tools/call` carrying a
 * key at most once per caller, tool, key and multi round-trip round, and
 * answers later duplicates with the stored result (or error). Without a
 * store the server ignores the key.
 *
 * A server with a store advertises it in `server/discover`, as
 * `capabilities.experimental["celld/idempotency"] = { durable }`, where
 * `durable` is the store's own {@link IdempotencyStore.durable}. `McpClient`
 * sends a keyed call again only to a server advertising `durable: true`
 * (it asks `server/discover` when it does not know yet): against any other
 * server a retry could run the call twice.
 *
 * @module
 */

import { nonNegativeMs } from "@celld/core/bounds";

/** The `_meta` entry carrying a request's idempotency key. */
export const IDEMPOTENCY_KEY = "celld/idempotency-key";

/**
 * The `capabilities.experimental` entry a server with an
 * {@link IdempotencyStore} advertises: {@link IdempotencyCapability}.
 */
export const IDEMPOTENCY_CAPABILITY = "celld/idempotency";

/** What a server advertises under {@link IDEMPOTENCY_CAPABILITY}. */
export interface IdempotencyCapability {
  /**
   * Whether every instance of the server shares the store and it survives
   * restarts, so a retry landing anywhere finds the first attempt.
   */
  readonly durable: boolean;
}

/** The longest idempotency key accepted, in characters. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Whether `key` is a usable idempotency key: 1 to 255 printable ASCII
 * characters without spaces. Keys should be unguessable (a random UUID):
 * callers without credentials share one namespace.
 */
export function isIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 &&
    key.length <= MAX_IDEMPOTENCY_KEY_LENGTH && /^[\x21-\x7e]+$/.test(key);
}

/** What {@link IdempotencyStore.claim} found. */
export type IdempotencyClaim =
  /**
   * The key was free and is now held: run the request, then `complete`
   * with this claim's `token`.
   */
  | { readonly first: true; readonly token: string }
  /**
   * The key is held: `result` is what `complete` stored, or absent while
   * the first request still runs.
   */
  | { readonly first: false; readonly result?: unknown };

/**
 * Where a server remembers idempotency keys. `claim` must be atomic: of any
 * number of concurrent claims of one key, exactly one gets `first: true`.
 * Entries expire `ttlMs` after the claim, completed or not. Results are
 * plain JSON. A store shared by every instance of the server (a Durable
 * Object, a database with a unique key) is what makes retries safe across
 * instances; the store in memory only covers one isolate.
 *
 * Each winning claim gets a fresh `token`, and `complete` records a result
 * only while the key is still held by the claim with that token. A request
 * that outlives its claim can then finish after a retry claimed the key
 * again without writing its result into the retry's claim: the retry's own
 * answer is the one kept.
 */
export interface IdempotencyStore {
  /**
   * True only when every instance of the server shares this store and its
   * entries survive restarts (a Durable Object, a database). The server
   * advertises it, and clients retry keyed calls only when it is true.
   */
  readonly durable: boolean;
  claim(key: string, ttlMs: number): Promise<IdempotencyClaim>;
  /** Records `result` if the claim `token` still holds `key`; else nothing. */
  complete(key: string, token: string, result: unknown): Promise<void>;
}

/** The server's idempotency settings. */
export interface IdempotencyOptions {
  readonly store: IdempotencyStore;
  /**
   * How long a key is remembered after its first request; default 24 hours.
   * A retry after that runs again.
   */
  readonly ttlMs?: number;
}

/** Validates {@link IdempotencyOptions.ttlMs}, giving the default. */
export function idempotencyTtl(options: IdempotencyOptions): number {
  return nonNegativeMs(options.ttlMs ?? 86_400_000, {
    name: "idempotency.ttlMs",
    min: 1,
  });
}

/** Options for {@link unsafeMemoryIdempotencyStore}. */
export interface MemoryIdempotencyStoreOptions {
  /** Most keys held; the oldest is forgotten past it. Default 10 000. */
  readonly maxEntries?: number;
  /** Milliseconds since the epoch; for tests. */
  readonly now?: () => number;
}

/**
 * An {@link IdempotencyStore} in this isolate's memory, for tests and
 * single-isolate development. It is unsafe for a deployment: keys are lost
 * on restart, invisible to other isolates, and forgotten oldest-first past
 * `maxEntries`, and any of those lets a retry run twice.
 */
export function unsafeMemoryIdempotencyStore(
  options: MemoryIdempotencyStoreOptions = {},
): IdempotencyStore {
  const max = options.maxEntries ?? 10_000;
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new RangeError("maxEntries must be a positive integer");
  }
  const now = options.now ?? (() => Date.now());
  const entries = new Map<
    string,
    { token: string; expiresAt: number; done: boolean; result: unknown }
  >();
  return {
    // Per isolate and lost on restart: clients do not retry against it.
    durable: false,
    claim(key, ttlMs) {
      const at = now();
      const found = entries.get(key);
      if (found !== undefined && found.expiresAt > at) {
        return Promise.resolve(
          found.done
            ? { first: false, result: structuredClone(found.result) }
            : { first: false },
        );
      }
      entries.delete(key);
      for (const [held, entry] of entries) {
        if (entry.expiresAt <= at) entries.delete(held);
      }
      while (entries.size >= max) {
        entries.delete(entries.keys().next().value!);
      }
      const token = crypto.randomUUID();
      entries.set(key, {
        token,
        expiresAt: at + ttlMs,
        done: false,
        result: null,
      });
      return Promise.resolve({ first: true, token });
    },
    complete(key, token, result) {
      const found = entries.get(key);
      if (found !== undefined && found.token === token) {
        found.done = true;
        found.result = structuredClone(result);
      }
      return Promise.resolve();
    },
  };
}

/**
 * The RPC surface of `McpIdempotencyObject` (from `@celld/mcp/durable`):
 * one object per slot, named by the slot, so its single thread makes
 * `claim` atomic.
 */
export interface IdempotencyObjectApi {
  claim(ttlMs: number): Promise<IdempotencyClaim>;
  complete(token: string, result: unknown): Promise<void>;
}

/**
 * The durable {@link IdempotencyStore}: one `McpIdempotencyObject` Durable
 * Object per slot, keeping the claim and the answer in its SQLite storage
 * (flushed before `claim` answers `first: true` and before `complete`
 * returns), and deleting both at the TTL. Every instance of the server
 * sees the same slots, so the server advertises `durable: true` and
 * clients retry keyed calls against it.
 *
 * ```ts
 * export { McpIdempotencyObject } from "@celld/mcp/durable";
 * const server = new McpServer({
 *   info,
 *   idempotency: { store: durableIdempotencyStore(env.MCP_IDEMPOTENCY) },
 * });
 * ```
 */
export function durableIdempotencyStore(
  namespace: DurableObjectNamespace<IdempotencyObjectApi>,
): IdempotencyStore {
  const stub = (key: string) =>
    namespace.getByName(key) as unknown as IdempotencyObjectApi;
  return {
    durable: true,
    claim: (key, ttlMs) => stub(key).claim(ttlMs),
    complete: (key, token, result) => stub(key).complete(token, result),
  };
}
