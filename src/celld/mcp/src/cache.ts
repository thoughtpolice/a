// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The client's result cache, driven by the `ttlMs` and `cacheScope` hints
 * the spec puts on `server/discover`, the list methods and `resources/read`.
 *
 * A key is the method plus the params that affect the result (everything
 * but `_meta`), so a cached answer is never served for a different request.
 * `private` results are also keyed by the client's authorization context and
 * are never shared across contexts; `public` ones are. Results of MRTR
 * retries are never cached, and a `ttlMs` of 0 (or absent, from an older
 * server) is not stored at all.
 *
 * @module
 */

import { canonicalJson } from "./json.ts";
import type { Result } from "./types.ts";

/** A cached result and when it goes stale. */
export interface CacheEntry {
  readonly result: Result;
  /** Epoch milliseconds: fresh while `now < expiresAt`. */
  readonly expiresAt: number;
  /** The method, for invalidation. */
  readonly method: string;
  /** The resource URI, for `resources/read` entries. */
  readonly uri?: string;
}

/** Storage for cached results. */
export interface ResultCache {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  /**
   * Drops entries for `method` (and, when given, only those for `uri`), as a
   * change notification requires.
   */
  invalidate(method: string, uri?: string): void | Promise<void>;
}

/** The methods whose complete results carry caching hints. */
export const CACHEABLE_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);

/** The cache key for a request under a scope (`public`, or the private context). */
export function cacheKey(
  method: string,
  params: Record<string, unknown>,
  scope: string,
): string {
  const salient: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== "_meta") salient[key] = value;
  }
  return `${method}\n${scope}\n${canonicalJson(salient)}`;
}

/** A synchronous, in-memory {@link ResultCache}. */
export interface MemoryCache extends ResultCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  invalidate(method: string, uri?: string): void;
  /** Entries held. */
  readonly size: number;
}

/** An in-memory cache, evicting the oldest entry past `maxEntries` (default 500). */
export function memoryCache(maxEntries = 500): MemoryCache {
  const entries = new Map<string, CacheEntry>();
  return {
    get(key) {
      return entries.get(key);
    },
    set(key, entry) {
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value!);
      }
    },
    invalidate(method, uri) {
      for (const [key, entry] of entries) {
        if (
          entry.method === method && (uri === undefined || entry.uri === uri)
        ) {
          entries.delete(key);
        }
      }
    },
    get size() {
      return entries.size;
    },
  };
}
