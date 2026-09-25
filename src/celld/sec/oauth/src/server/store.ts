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
 * The authorization server never stores its secrets as keys or values:
 * codes, refresh tokens, device codes and client secrets are stored as
 * SHA-256 hashes, so a leaked store does not hand out working
 * credentials. (Device user codes are the exception: they are short-lived
 * keys the user types, stored as typed, and redeem nothing by themselves.)
 * That is a property of this server's records, not of the store: any
 * other user of a `RecordStore` must hash or encrypt what it keeps.
 * `@celld/sec/oidc/broker`'s `encryptedSecretStore` is one that encrypts, for
 * upstream tokens that must be read back.
 *
 * {@link unsafeMemoryRecordStore} is for tests and single-isolate demos
 * (bounded by `maxEntries`); `@celld/sec/oauth/durable` has the Durable
 * Object one.
 *
 * @module
 */

import { safeInt, strictRecord } from "@celld/core/bounds";
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

/** Options for {@link unsafeMemoryRecordStore}. */
export interface MemoryRecordStoreOptions {
  readonly now?: Clock;
  /**
   * The most records held, 1 to 10 000 000; default 100 000. When a write
   * would pass it, expired records are purged first; if the store is
   * still full, the write throws a `RangeError` (the endpoint answers 500)
   * rather than growing.
   */
  readonly maxEntries?: number;
}

/**
 * An in-memory {@link RecordStore}; values are copied in and out. Unsafe
 * outside tests and single-isolate demos: every isolate has its own, so
 * single use (codes, request URIs, DPoP and assertion `jti`s) and refresh
 * rotation hold only within one isolate, and everything is lost when it
 * goes. It holds at most `maxEntries` records; expired ones are deleted
 * when read, or all at once when the store is full.
 */
export function unsafeMemoryRecordStore(
  options: MemoryRecordStoreOptions = {},
): RecordStore & { readonly size: number } {
  strictRecord(
    options as unknown,
    ["now", "maxEntries"],
    "memory record store options",
  );
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("memory record store now must be a function");
  }
  const now = options.now ?? defaultClock;
  const maxEntries = safeInt(options.maxEntries ?? 100_000, {
    name: "maxEntries",
    min: 1,
    max: 10_000_000,
  });
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
  /** Makes room for a new key: purges expired records, then refuses. */
  const room = (key: string) => {
    if (records.has(key) || records.size < maxEntries) return;
    for (const name of [...records.keys()]) live(name);
    if (records.size >= maxEntries) {
      throw new RangeError(
        `the memory record store is full (${maxEntries} records)`,
      );
    }
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
      room(key);
      records.set(key, { value: copy(value), version, expiresAt });
      return Promise.resolve();
    },
    create(key, value, expiresAt) {
      if (live(key) !== null) return Promise.resolve(false);
      room(key);
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

/**
 * A {@link ReplayStore} over a {@link RecordStore}, under `prefix`. A
 * record is gone at its `expiresAt`, while a replay entry is live through
 * it, so the record expires one millisecond later.
 */
export function recordReplayStore(
  store: RecordStore,
  prefix = "replay:",
): ReplayStore {
  if (
    typeof store?.create !== "function" || typeof prefix !== "string" ||
    prefix.length > 256
  ) {
    throw new TypeError(
      "record replay store requires an atomic create and bounded prefix",
    );
  }
  return {
    claim: (key, expiresAt) =>
      store.create(`${prefix}${key}`, 1, expiresAt + 1),
  };
}
