// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * One WormPaxos replica, as one Durable Object named `<group>.<replica>`: the
 * SQLite store around `replica_core.ts`.
 *
 * The state machine is the `kv` table; the meta row holds the group and
 * replica names, the chain's size, the next address to apply, and the
 * leadership. The storage rules are `segment.ts`'s: one statement per
 * `sql.exec`, every cursor drained, each commit (the meta row and the table
 * changes of one learned window, or of one proposal) a single
 * `transactionSync`, `sync()` awaited outside it and only after something
 * committed, never the asynchronous `storage.transaction()`, and a constructor
 * that never awaits. The one thing held in memory is the core's call queue,
 * which is not state.
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";

import {
  type GetRequest,
  type GetResult,
  type KvChange,
  type LearnRequest,
  type LearnResult,
  type ProposeRequest,
  type ProposeResult,
  type ReplicaAPI,
  ReplicaCore,
  type ReplicaInitRequest,
  type ReplicaInitResult,
  type ReplicaRequest,
  type ReplicaState,
  type ReplicaStateResult,
  type ReplicaStore,
} from "@wormspace/layers/replica_core";
import type { SegmentAPI } from "@wormspace/segment/types";

export interface ReplicaEnv {
  SEGMENTS: DurableObjectNamespace<SegmentAPI>;
}

const CREATE_META = `CREATE TABLE IF NOT EXISTS replica_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  smr TEXT NOT NULL,
  replica TEXT NOT NULL,
  size INTEGER,
  preferred_size INTEGER NOT NULL,
  applied INTEGER NOT NULL,
  leader_link INTEGER,
  leader_capture INTEGER,
  leader_tail INTEGER
)`;

const CREATE_KV = `CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
)`;

const LOAD_META = `SELECT smr, replica, size, preferred_size, applied,
  leader_link, leader_capture, leader_tail FROM replica_meta WHERE id = 1`;

const SAVE_META = `INSERT OR REPLACE INTO replica_meta (id, smr, replica,
  size, preferred_size, applied, leader_link, leader_capture, leader_tail)
  VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`;

const GET = "SELECT value FROM kv WHERE key = ?";
const PUT = "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)";
const DELETE = "DELETE FROM kv WHERE key = ?";

interface MetaRow extends SqlStorageRow {
  smr: string;
  replica: string;
  size: number | null;
  preferred_size: number;
  applied: number;
  leader_link: number | null;
  leader_capture: number | null;
  leader_tail: number | null;
}

interface ValueRow extends SqlStorageRow {
  value: ArrayBuffer;
}

/** The replica's tables behind the core's synchronous store interface. */
class SqlReplicaStore implements ReplicaStore {
  readonly #storage: DurableObjectStorage;
  /** Whether a commit is still waiting for its barrier; not state. */
  #dirty = false;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    for (const statement of [CREATE_META, CREATE_KV]) {
      storage.sql.exec(statement).toArray();
    }
  }

  #run<Row extends SqlStorageRow>(
    query: string,
    ...bindings: SqlStorageBindable[]
  ): Row[] {
    return this.#storage.sql.exec<Row>(query, ...bindings).toArray();
  }

  load(): ReplicaState | null {
    const row = this.#run<MetaRow>(LOAD_META)[0];
    if (row === undefined) return null;
    const leader = row.leader_link === null || row.leader_capture === null ||
        row.leader_tail === null
      ? null
      : {
        index: row.leader_link,
        captureId: row.leader_capture,
        tail: row.leader_tail,
      };
    return {
      smr: row.smr,
      replica: row.replica,
      size: row.size,
      preferredSize: row.preferred_size,
      applied: row.applied,
      leader,
    };
  }

  get(key: string): string | null {
    const row = this.#run<ValueRow>(GET, key)[0];
    return row === undefined
      ? null
      : new TextDecoder().decode(new Uint8Array(row.value));
  }

  commit(state: ReplicaState, changes: readonly KvChange[]): void {
    const encoder = new TextEncoder();
    this.#storage.transactionSync(() => {
      this.#run(
        SAVE_META,
        state.smr,
        state.replica,
        state.size,
        state.preferredSize,
        state.applied,
        state.leader?.index ?? null,
        state.leader?.captureId ?? null,
        state.leader?.tail ?? null,
      );
      for (const change of changes) {
        if (change.value === null) {
          this.#run(DELETE, change.key);
        } else {
          this.#run(PUT, change.key, encoder.encode(change.value));
        }
      }
    });
    this.#dirty = true;
  }

  async barrier(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    await this.#storage.sync();
  }
}

export class Replica extends DurableObject<ReplicaEnv> implements ReplicaAPI {
  readonly #core: ReplicaCore;

  constructor(ctx: DurableObjectState, env: ReplicaEnv) {
    super(ctx, env);
    this.#core = new ReplicaCore(
      new SqlReplicaStore(ctx.storage),
      (name) => env.SEGMENTS.getByName(name),
    );
  }

  init(request: ReplicaInitRequest): Promise<ReplicaInitResult> {
    return this.#core.init(request);
  }

  propose(request: ProposeRequest): Promise<ProposeResult> {
    return this.#core.propose(request);
  }

  learn(request: LearnRequest): Promise<LearnResult> {
    return this.#core.learn(request);
  }

  lookup(request: GetRequest): Promise<GetResult> {
    return this.#core.lookup(request);
  }

  state(request: ReplicaRequest): Promise<ReplicaStateResult> {
    return this.#core.state(request);
  }
}
