// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oauth/durable`: the authorization server's storage, and DPoP
 * replay prevention, in Durable Objects.
 *
 * ```ts
 * export { OAuthRecords } from "@celld/oauth/durable";
 *
 * const store = durableRecordStore(env.OAUTH_RECORDS);
 * const server = new AuthorizationServer({ store, ... });
 * const replay = durableReplayStore(env.OAUTH_RECORDS); // for a ResourceServer
 * ```
 *
 * ```python
 * celld.project(..., bindings = {"OAUTH_RECORDS": "OAuthRecords"})
 * ```
 *
 * {@link OAuthRecords} keeps records in its SQLite database. Each method
 * reads and writes with synchronous statements before its first `await`,
 * so it is atomic, then waits for `storage.sync()` before answering, so an
 * acknowledged write (a spent code, a rotated refresh token, a claimed
 * `jti`) is durable. An alarm deletes expired records.
 *
 * {@link durableRecordStore} spreads keys over `shards` objects by a hash
 * of the key. Every operation touches one key, so sharding keeps each
 * atomic. Changing `shards` or `name` later strands the records already
 * written, so choose them once.
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import type { ReplayStore } from "./dpop/verify.ts";
import {
  recordReplayStore,
  type RecordStore,
  type StoredRecord,
} from "./server/store.ts";

/**
 * The RPC surface of {@link OAuthRecords}: {@link RecordStore} with
 * `get`, `put` and `delete` named `read`, `write` and `remove`, since a
 * stub reserves the HTTP names.
 */
export interface RecordStoreApi {
  read(key: string): StoredRecord<unknown> | null;
  write(key: string, value: unknown, expiresAt: number | null): Promise<void>;
  create(
    key: string,
    value: unknown,
    expiresAt: number | null,
  ): Promise<boolean>;
  swap(
    key: string,
    version: number,
    value: unknown,
    expiresAt: number | null,
  ): Promise<boolean>;
  remove(key: string): Promise<void>;
}

/** The statements {@link OAuthRecords} runs, one per `sql.exec`. */
export const RECORD_SQL = {
  table:
    "CREATE TABLE IF NOT EXISTS oauth_record (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL, expires_at INTEGER)",
  index:
    "CREATE INDEX IF NOT EXISTS oauth_record_expiry ON oauth_record (expires_at)",
  select: "SELECT value, version, expires_at FROM oauth_record WHERE key = ?",
  upsert:
    "INSERT INTO oauth_record (key, value, version, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, version = excluded.version, expires_at = excluded.expires_at",
  remove: "DELETE FROM oauth_record WHERE key = ?",
  purge:
    "DELETE FROM oauth_record WHERE expires_at IS NOT NULL AND expires_at <= ?",
  next:
    "SELECT MIN(expires_at) AS next FROM oauth_record WHERE expires_at IS NOT NULL",
} as const;

interface Row {
  readonly value: string;
  readonly version: number;
  readonly expires_at: number | null;
  readonly [column: string]: SqlStorageValue;
}

const MIN_ALARM_GAP_MS = 60_000;

/** The Durable Object behind {@link durableRecordStore}; see the module documentation. */
export class OAuthRecords extends DurableObject implements RecordStoreApi {
  #alarmAt: number | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(RECORD_SQL.table).toArray();
    sql.exec(RECORD_SQL.index).toArray();
  }

  #read(key: string, now: number): Row | null {
    const rows = this.ctx.storage.sql.exec<Row>(RECORD_SQL.select, key)
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    if (row.expires_at !== null && row.expires_at <= now) {
      this.ctx.storage.sql.exec(RECORD_SQL.remove, key).toArray();
      return null;
    }
    return row;
  }

  #write(
    key: string,
    value: unknown,
    version: number,
    expiresAt: number | null,
  ) {
    this.ctx.storage.sql.exec(
      RECORD_SQL.upsert,
      key,
      JSON.stringify(value),
      version,
      expiresAt,
    ).toArray();
  }

  async #commit(expiresAt: number | null): Promise<void> {
    await this.ctx.storage.sync();
    if (expiresAt === null) return;
    const at = Math.max(expiresAt, Date.now() + MIN_ALARM_GAP_MS);
    if (this.#alarmAt === null) {
      this.#alarmAt = await this.ctx.storage.getAlarm();
    }
    if (this.#alarmAt === null || this.#alarmAt > at + MIN_ALARM_GAP_MS) {
      this.#alarmAt = at;
      await this.ctx.storage.setAlarm(at);
    }
  }

  read(key: string): StoredRecord<unknown> | null {
    const row = this.#read(String(key), Date.now());
    if (row === null) return null;
    return {
      value: JSON.parse(row.value),
      version: row.version,
      expiresAt: row.expires_at,
    };
  }

  async write(
    key: string,
    value: unknown,
    expiresAt: number | null,
  ): Promise<void> {
    const version = (this.#read(String(key), Date.now())?.version ?? 0) + 1;
    this.#write(String(key), value, version, expiresAt);
    await this.#commit(expiresAt);
  }

  async create(
    key: string,
    value: unknown,
    expiresAt: number | null,
  ): Promise<boolean> {
    if (this.#read(String(key), Date.now()) !== null) return false;
    this.#write(String(key), value, 1, expiresAt);
    await this.#commit(expiresAt);
    return true;
  }

  async swap(
    key: string,
    version: number,
    value: unknown,
    expiresAt: number | null,
  ): Promise<boolean> {
    const row = this.#read(String(key), Date.now());
    if (row === null || row.version !== version) return false;
    if (value === null) {
      this.ctx.storage.sql.exec(RECORD_SQL.remove, String(key)).toArray();
      await this.#commit(null);
    } else {
      this.#write(String(key), value, version + 1, expiresAt);
      await this.#commit(expiresAt);
    }
    return true;
  }

  async remove(key: string): Promise<void> {
    this.ctx.storage.sql.exec(RECORD_SQL.remove, String(key)).toArray();
    await this.#commit(null);
  }

  /** Deletes expired records and schedules the next sweep. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    sql.exec(RECORD_SQL.purge, now).toArray();
    const next = sql.exec<{ next: number | null }>(RECORD_SQL.next).toArray()[0]
      ?.next ?? null;
    await this.ctx.storage.sync();
    this.#alarmAt = null;
    if (next !== null) {
      this.#alarmAt = Math.max(next, now + MIN_ALARM_GAP_MS);
      await this.ctx.storage.setAlarm(this.#alarmAt);
    }
  }
}

/** Options for {@link durableRecordStore}. */
export interface DurableRecordStoreOptions {
  /** Objects to spread keys over; default 16. Fixed once records exist. */
  readonly shards?: number;
  /** The prefix of the objects' names; default `oauth`. Fixed once records exist. */
  readonly name?: string;
}

/** FNV-1a over the key's UTF-16 code units: a stable, cheap shard choice. */
function shardOf(key: string, shards: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % shards;
}

/** A {@link RecordStore} over {@link OAuthRecords} objects; see the module documentation. */
export function durableRecordStore(
  namespace: DurableObjectNamespace<RecordStoreApi>,
  options: DurableRecordStoreOptions = {},
): RecordStore {
  const shards = options.shards ?? 16;
  if (!Number.isInteger(shards) || shards < 1) {
    throw new TypeError("shards must be a positive integer");
  }
  const name = options.name ?? "oauth";
  const stub = (key: string) =>
    namespace.getByName(`${name}:${shardOf(key, shards)}`);
  return {
    async get<T>(key: string) {
      return await stub(key).read(key) as StoredRecord<T> | null;
    },
    put: (key, value, expiresAt) => stub(key).write(key, value, expiresAt),
    create: (key, value, expiresAt) => stub(key).create(key, value, expiresAt),
    swap: (key, version, value, expiresAt) =>
      stub(key).swap(key, version, value, expiresAt),
    delete: (key) => stub(key).remove(key),
  };
}

/** A DPoP (or client assertion) {@link ReplayStore} over {@link OAuthRecords} objects. */
export function durableReplayStore(
  namespace: DurableObjectNamespace<RecordStoreApi>,
  options: DurableRecordStoreOptions = {},
): ReplayStore {
  return recordReplayStore(durableRecordStore(namespace, options));
}
