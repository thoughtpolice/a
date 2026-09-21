// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * One journal, as one Durable Object: the SQLite store around `log.ts`.
 *
 * The cell keeps only the lease, the marks, the link size, and the link
 * table; its records live in its segment links, which are `Segment` cells of
 * this same script (the `SEGMENTS` binding). Every decision is `core.ts`'s,
 * and every segment call is `log.ts`'s.
 *
 * The rules this file obeys, all of them celld 0.5.1 contracts:
 *
 *   - `sql.exec` is synchronous and runs one statement, so the schema is three
 *     calls and every cursor is drained with `toArray()`. An open write cursor
 *     makes `sync()` reject.
 *   - Each commit is one `transactionSync`, and `sync()` is awaited outside it
 *     and only when something committed: a rejected request, a read, and an
 *     append that stays inside its link never pay for this cell's barrier.
 *   - The asynchronous `storage.transaction()` is never used: it resets the
 *     object after 30 seconds, and 0.5.1 can still report `database is locked`.
 *   - The constructor never awaits. A cell is created on demand, on the path
 *     of the first request to reach it, and recovers its head inside that
 *     request instead.
 *   - The one thing held in memory is the core's cached head and call queue;
 *     both are rebuilt from SQLite and the last link after an eviction.
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";

import type { SegmentAPI } from "@wormspace/segment/types";
import type { Link } from "@journal/links";
import {
  INITIAL_STATE,
  type LogChange,
  LogCore,
  type LogState,
  type LogStore,
} from "@journal/log";
import type {
  AcquireLeaseRequest,
  AcquireLeaseResult,
  AppendRequest,
  AppendResult,
  JournalAPI,
  ReadRequest,
  ReadResult,
  RecordSnapshotRequest,
  RecordSnapshotResult,
  ReleaseLeaseRequest,
  ReleaseLeaseResult,
  RenewLeaseRequest,
  RenewLeaseResult,
  StatusResult,
  TrimRequest,
  TrimResult,
} from "@journal/types";

export interface JournalEnv {
  SEGMENTS: DurableObjectNamespace<SegmentAPI>;
}

const CREATE_STATE = `CREATE TABLE IF NOT EXISTS journal_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  term INTEGER NOT NULL,
  leader TEXT,
  lease_deadline_ms INTEGER NOT NULL,
  trimmed_through INTEGER NOT NULL,
  snapshot_through INTEGER NOT NULL,
  snapshot_ref TEXT,
  link_size INTEGER NOT NULL
)`;

const SEED_STATE = "INSERT OR IGNORE INTO journal_state " +
  `VALUES (1, 0, NULL, 0, 0, 0, NULL, ${INITIAL_STATE.linkSize})`;

const CREATE_LINKS = `CREATE TABLE IF NOT EXISTS journal_links (
  link INTEGER PRIMARY KEY,
  first_seq INTEGER NOT NULL,
  capture_id INTEGER NOT NULL,
  sealed_at INTEGER,
  term INTEGER NOT NULL
)`;

const LOAD_STATE = `SELECT term, leader, lease_deadline_ms, trimmed_through,
  snapshot_through, snapshot_ref, link_size FROM journal_state WHERE id = 1`;

const SAVE_STATE = `UPDATE journal_state SET term = ?, leader = ?,
  lease_deadline_ms = ?, trimmed_through = ?, snapshot_through = ?,
  snapshot_ref = ?, link_size = ? WHERE id = 1`;

const LINK_COLUMNS = "link, first_seq, capture_id, sealed_at, term";

const LAST_LINK =
  `SELECT ${LINK_COLUMNS} FROM journal_links ORDER BY link DESC LIMIT 1`;

const FIND_LINK = `SELECT ${LINK_COLUMNS} FROM journal_links
  WHERE first_seq <= ? ORDER BY link DESC LIMIT 1`;

const NEXT_LINK = `SELECT ${LINK_COLUMNS} FROM journal_links
  WHERE link > ? ORDER BY link LIMIT 1`;

const ALL_LINKS = `SELECT ${LINK_COLUMNS} FROM journal_links ORDER BY link`;

const SAVE_LINK = "INSERT OR REPLACE INTO journal_links " +
  `(${LINK_COLUMNS}) VALUES (?, ?, ?, ?, ?)`;

const DROP_LINK = "DELETE FROM journal_links WHERE link = ?";

interface StateRow extends SqlStorageRow {
  term: number;
  leader: string | null;
  lease_deadline_ms: number;
  trimmed_through: number;
  snapshot_through: number;
  snapshot_ref: string | null;
  link_size: number;
}

interface LinkRow extends SqlStorageRow {
  link: number;
  first_seq: number;
  capture_id: number;
  sealed_at: number | null;
  term: number;
}

function toLink(row: LinkRow): Link {
  return {
    link: row.link,
    firstSeq: row.first_seq,
    captureId: row.capture_id,
    sealedAt: row.sealed_at,
    term: row.term,
  };
}

/** The journal's two tables behind the core's synchronous store interface. */
class SqlLogStore implements LogStore {
  readonly #storage: DurableObjectStorage;
  /** Whether a commit is still waiting for its barrier; not state. */
  #dirty = false;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    for (const statement of [CREATE_STATE, SEED_STATE, CREATE_LINKS]) {
      storage.sql.exec(statement).toArray();
    }
  }

  #run<Row extends SqlStorageRow>(
    query: string,
    ...bindings: SqlStorageBindable[]
  ): Row[] {
    return this.#storage.sql.exec<Row>(query, ...bindings).toArray();
  }

  #link(query: string, ...bindings: SqlStorageBindable[]): Link | null {
    const row = this.#run<LinkRow>(query, ...bindings)[0];
    return row === undefined ? null : toLink(row);
  }

  load(): LogState {
    const row = this.#run<StateRow>(LOAD_STATE)[0];
    return {
      term: row.term,
      leader: row.leader,
      leaseDeadlineMs: row.lease_deadline_ms,
      trimmedThrough: row.trimmed_through,
      snapshotThrough: row.snapshot_through,
      snapshotRef: row.snapshot_ref,
      linkSize: row.link_size,
    };
  }

  last(): Link | null {
    return this.#link(LAST_LINK);
  }

  find(seq: number): Link | null {
    return this.#link(FIND_LINK, seq);
  }

  after(link: number): Link | null {
    return this.#link(NEXT_LINK, link);
  }

  all(): Link[] {
    return this.#run<LinkRow>(ALL_LINKS).map(toLink);
  }

  commit(change: LogChange): void {
    this.#storage.transactionSync(() => {
      const state = change.state;
      if (state !== undefined) {
        this.#run(
          SAVE_STATE,
          state.term,
          state.leader,
          state.leaseDeadlineMs,
          state.trimmedThrough,
          state.snapshotThrough,
          state.snapshotRef,
          state.linkSize,
        );
      }
      for (const link of change.links ?? []) {
        this.#run(
          SAVE_LINK,
          link.link,
          link.firstSeq,
          link.captureId,
          link.sealedAt,
          link.term,
        );
      }
      for (const link of change.drop ?? []) this.#run(DROP_LINK, link);
    });
    this.#dirty = true;
  }

  async barrier(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    await this.#storage.sync();
  }

  databaseSize(): number {
    return this.#storage.sql.databaseSize;
  }
}

export class Journal extends DurableObject<JournalEnv> implements JournalAPI {
  readonly #core: LogCore;

  constructor(ctx: DurableObjectState, env: JournalEnv) {
    super(ctx, env);
    // Cells are addressed by log name, which celld recovers from the ID
    // itself (checked for a 128-character name, the longest a route
    // accepts), so it is the same on every activation. The encoded ID would
    // be as stable for an RPC caller's name too long to recover.
    this.#core = new LogCore(
      new SqlLogStore(ctx.storage),
      (name) => env.SEGMENTS.getByName(name),
      ctx.id.name ?? ctx.id.toString(),
    );
  }

  acquireLease(request: AcquireLeaseRequest): Promise<AcquireLeaseResult> {
    return this.#core.acquireLease(request);
  }

  renewLease(request: RenewLeaseRequest): Promise<RenewLeaseResult> {
    return this.#core.renewLease(request);
  }

  releaseLease(request: ReleaseLeaseRequest): Promise<ReleaseLeaseResult> {
    return this.#core.releaseLease(request);
  }

  append(request: AppendRequest): Promise<AppendResult> {
    return this.#core.append(request);
  }

  read(request: ReadRequest): Promise<ReadResult> {
    return this.#core.read(request);
  }

  status(): Promise<StatusResult> {
    return this.#core.status();
  }

  recordSnapshot(
    request: RecordSnapshotRequest,
  ): Promise<RecordSnapshotResult> {
    return this.#core.recordSnapshot(request);
  }

  trim(request: TrimRequest): Promise<TrimResult> {
    return this.#core.trim(request);
  }
}
