// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The opt-in answer cache: a KV namespace or an in-isolate map, keyed by a
 * SHA-256 of the request.
 *
 * Only requests pinned to a versioned model (`jev-1.13.0`) are cached. An
 * alias such as `jev-latest` moves to a new model when TypeSafe ships one, so
 * an answer cached under it could be served after the model behind it
 * changed; the client bypasses the cache for aliases and reports
 * `meta.cache: "bypass"`. A response whose `model` is not the pinned one is
 * not stored either.
 *
 * Entries are validated response bodies. The client decodes each hit against
 * the questions again, so a corrupt or foreign entry is a miss, not a wrong
 * answer. Cache failures never fail a request: a read error is a miss and a
 * write error is ignored.
 *
 * @module
 */

import { canonicalJson } from "./json.ts";
import type { AnswerCache, Entry, Questions } from "./types.ts";

/** Bump when the stored format changes, so old entries stop matching. */
const VERSION = "jev/v1/";

function hex(bytes: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The cache key for a request: `jev/v1/` and the hex SHA-256 of the canonical
 * JSON of `{model, state, questions}`. The request must already be valid.
 */
export async function cacheKey(
  request: {
    readonly model: string;
    readonly state: Entry;
    readonly questions: Questions;
  },
): Promise<string> {
  const text = canonicalJson({
    model: request.model,
    state: request.state,
    questions: request.questions,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return VERSION + hex(digest);
}

/** Options for {@link kvCache}. */
export interface KvCacheOptions {
  /** How long an entry lives, in seconds; KV's minimum is 60. */
  readonly ttlSeconds: number;
  /** Prepended to every key, to share a namespace with other data. */
  readonly prefix?: string;
}

/**
 * A cache in a KV namespace, with entries expiring after `ttlSeconds`.
 *
 * ```ts
 * const client = JevClient.fromEnv(env, {
 *   cache: kvCache(env.JEV_CACHE, { ttlSeconds: 86_400 }),
 * });
 * ```
 */
export function kvCache(kv: KVNamespace, options: KvCacheOptions): AnswerCache {
  const ttl = options.ttlSeconds;
  if (!Number.isInteger(ttl) || ttl < 60) {
    throw new RangeError(
      `ttlSeconds must be an integer of at least 60, got ${ttl}`,
    );
  }
  const prefix = options.prefix ?? "";
  return {
    get: (key) => kv.get(prefix + key),
    put: (key, value) => kv.put(prefix + key, value, { expirationTtl: ttl }),
  };
}

/** Options for {@link memoryCache}. */
export interface MemoryCacheOptions {
  /** How long an entry lives, in milliseconds. */
  readonly ttlMs: number;
  /** The most entries kept; the oldest go first. Default 1000. */
  readonly maxEntries?: number;
  /** The clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A cache in this isolate's memory: for tests, and for hot, repeated
 * requests within one Worker instance. Nothing is shared between isolates.
 */
export function memoryCache(options: MemoryCacheOptions): AnswerCache {
  const { ttlMs } = options;
  const maxEntries = options.maxEntries ?? 1000;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`ttlMs must be positive, got ${ttlMs}`);
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(
      `maxEntries must be a positive integer, got ${maxEntries}`,
    );
  }
  const entries = new Map<string, { value: string; expires: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return Promise.resolve(null);
      if (entry.expires <= now()) {
        entries.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(entry.value);
    },
    put(key, value) {
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttlMs });
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value!);
      }
      return Promise.resolve();
    },
  };
}
