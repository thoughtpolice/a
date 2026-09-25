// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * What the authorization server keeps: a {@link RecordStore}, a small
 * keyed store of plain-data records with versions and expiry. Every
 * operation touches one key, so an implementation can shard by key; the
 * server builds single use (codes, request URIs), rotation (refresh token
 * families) and replay prevention from {@link RecordStore.create} and
 * {@link RecordStore.swap}.
 *
 * Secrets are never keys or values: codes, refresh tokens, device codes
 * and client secrets are stored as SHA-256 hashes, so a leaked store does
 * not hand out working credentials.
 *
 * {@link memoryRecordStore} is for tests and single-isolate use;
 * `@celld/oauth/durable` has the Durable Object one.
 *
 * @module
 */

import type { ReplayStore } from "../dpop/verify.ts";
import { type Clock, defaultClock } from "../util.ts";

/** A record as stored. */
export interface StoredRecord<T> {
  readonly value: T;
  /** 1 when created, one more on every write. */
  readonly version: number;
  /** Epoch milliseconds, or null for never. */
  readonly expiresAt: number | null;
}

/**
 * A keyed store of JSON-compatible records. An expired record reads as
 * absent, and may be deleted at any time after it expires.
 */
export interface RecordStore {
  get<T>(key: string): Promise<StoredRecord<T> | null>;
  /** Writes a record whatever was there. */
  put<T>(key: string, value: T, expiresAt: number | null): Promise<void>;
  /** Writes a record only if the key is absent (or expired); true when it did. */
  create<T>(key: string, value: T, expiresAt: number | null): Promise<boolean>;
  /**
   * Replaces the record at `version` with `value` (or deletes it, for
   * null); false, changing nothing, when the record is at another version
   * or gone.
   */
  swap<T>(
    key: string,
    version: number,
    value: T | null,
    expiresAt: number | null,
  ): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** Options for {@link memoryRecordStore}. */
export interface MemoryRecordStoreOptions {
  readonly now?: Clock;
}

/** An in-memory {@link RecordStore}; values are copied in and out. */
export function memoryRecordStore(
  options: MemoryRecordStoreOptions = {},
): RecordStore & { readonly size: number } {
  const now = options.now ?? defaultClock;
  const records = new Map<string, StoredRecord<unknown>>();
  const live = (key: string) => {
    const record = records.get(key);
    if (record === undefined) return null;
    if (record.expiresAt !== null && record.expiresAt <= now()) {
      records.delete(key);
      return null;
    }
    return record;
  };
  const copy = <T>(value: T): T => structuredClone(value);
  return {
    get size() {
      for (const key of [...records.keys()]) live(key);
      return records.size;
    },
    get<T>(key: string) {
      const record = live(key);
      return Promise.resolve(
        record === null ? null : { ...record, value: copy(record.value as T) },
      );
    },
    put(key, value, expiresAt) {
      const version = (live(key)?.version ?? 0) + 1;
      records.set(key, { value: copy(value), version, expiresAt });
      return Promise.resolve();
    },
    create(key, value, expiresAt) {
      if (live(key) !== null) return Promise.resolve(false);
      records.set(key, { value: copy(value), version: 1, expiresAt });
      return Promise.resolve(true);
    },
    swap(key, version, value, expiresAt) {
      const record = live(key);
      if (record === null || record.version !== version) {
        return Promise.resolve(false);
      }
      if (value === null) records.delete(key);
      else {
        records.set(key, {
          value: copy(value),
          version: version + 1,
          expiresAt,
        });
      }
      return Promise.resolve(true);
    },
    delete(key) {
      records.delete(key);
      return Promise.resolve();
    },
  };
}

/** A {@link ReplayStore} over a {@link RecordStore}, under `prefix`. */
export function recordReplayStore(
  store: RecordStore,
  prefix = "replay:",
): ReplayStore {
  return {
    claim: (key, expiresAt) => store.create(`${prefix}${key}`, 1, expiresAt),
  };
}
