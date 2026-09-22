// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * One write-once segment, as one Durable Object: the storage shell around
 * `core.ts`.
 *
 * celld gives a cell exactly one active owner with epoch fencing and an
 * acknowledgement that means the write is durable, so the single owner plays
 * the part of the acceptor quorum in each register's single-shot Paxos.
 * Nothing here decides anything: it loads the meta row and the view a
 * transition asks for, runs the transition, persists the write set it
 * describes, and waits for durability before answering.
 *
 * The rules this file obeys, all of them celld 0.5.1 contracts:
 *
 *   - `sql.exec` is synchronous and runs one statement, so the schema is four
 *     calls and every cursor is drained with `toArray()`. An open write cursor
 *     makes `sync()` reject.
 *   - `sync()` is awaited outside `transactionSync`, and only when something
 *     actually committed: a rejected request must not pay for a barrier.
 *   - The asynchronous `storage.transaction()` is never used: it resets the
 *     object after 30 seconds, and 0.5.1 can still report `database is locked`.
 *   - The constructor never awaits. A cell is created on demand, on the path
 *     of the first request to reach it.
 *   - Nothing is cached in a field. The owner can move or be evicted between
 *     any two calls, so SQLite is the only state. The one exception is the
 *     set of parked `listen` requests, which is not state but a list of open
 *     calls: losing it loses only those calls, which their callers see as a
 *     transport error and repeat.
 *   - `Date.now()` is read once per call and handed to the transition, which
 *     keeps every decision a function of its inputs.
 *   - A view is loaded inside the same `transactionSync` as the decision that
 *     reads it and the writes that follow, in a bounded number of statements
 *     (never one per register).
 *   - No caller learns of a write before it is durable: a parked `listen` is
 *     woken only after the write's `sync()` returns, a `listen` that answers
 *     from the counter awaits `sync()` first, because the counter it read may
 *     include a write still waiting for its barrier, and so does a `write`
 *     refused with `ALREADY_WRITTEN` and `sameValue: true`, which a replay
 *     takes as proof that its write landed. `read` and `status` are the
 *     exceptions: they report what is committed, and a caller that must not
 *     act on an undurable register follows the read with a zero-timeout
 *     `listen` on the same segment.
 *
 * `offset` and `end` are SQL keywords that SQLite accepts as column names;
 * they are quoted anyway so no parser context can mistake them.
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";

import * as core from "./core.ts";
import {
  type CaptureRow,
  type CaptureView,
  type Meta,
  type Outcome,
  type Range,
  type RegisterRow,
  type WriteView,
} from "./core.ts";
import type {
  AllocRequest,
  AllocResult,
  CaptureRequest,
  CaptureResult,
  ListenRequest,
  ListenResult,
  ReadRequest,
  ReadResult,
  SegmentAPI,
  StatusResult,
  TrimRequest,
  TrimResult,
  WriteRequest,
  WriteResult,
} from "./types.ts";

const CREATE_META = `CREATE TABLE IF NOT EXISTS segment_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allocated INTEGER NOT NULL,
  size INTEGER NOT NULL,
  metadata BLOB,
  allocator TEXT,
  allocated_ms INTEGER NOT NULL,
  next_round INTEGER NOT NULL,
  written_count INTEGER NOT NULL,
  writes INTEGER NOT NULL,
  trimmed_through INTEGER NOT NULL
)`;

const SEED_META = "INSERT OR IGNORE INTO segment_meta " +
  "VALUES (1, 0, 0, NULL, NULL, 0, 1, 0, 0, -1)";

const CREATE_CAPTURES = `CREATE TABLE IF NOT EXISTS captures (
  round INTEGER PRIMARY KEY,
  start INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  owner TEXT,
  captured_ms INTEGER NOT NULL
)`;

const CREATE_REGISTERS = `CREATE TABLE IF NOT EXISTS registers (
  "offset" INTEGER PRIMARY KEY,
  round INTEGER NOT NULL,
  value BLOB NOT NULL,
  written_ms INTEGER NOT NULL
)`;

const LOAD_META = `SELECT allocated, size, metadata, allocator, allocated_ms,
  next_round, written_count, writes, trimmed_through
  FROM segment_meta WHERE id = 1`;

const SAVE_META = `UPDATE segment_meta SET allocated = ?, size = ?,
  metadata = ?, allocator = ?, allocated_ms = ?, next_round = ?,
  written_count = ?, writes = ?, trimmed_through = ? WHERE id = 1`;

const COUNT_CAPTURES = "SELECT COUNT(*) AS n FROM captures";

const COUNT_DOMINATED =
  'SELECT COUNT(*) AS n FROM captures WHERE start >= ? AND "end" <= ?';

const COUNT_WRITTEN_IN =
  'SELECT COUNT(*) AS n FROM registers WHERE "offset" >= ? AND "offset" < ?';

const COUNT_WRITTEN_THROUGH =
  'SELECT COUNT(*) AS n FROM registers WHERE "offset" <= ?';

const OVERLAPPING_CAPTURES =
  'SELECT round, start, "end" FROM captures WHERE start < ? AND "end" > ?';

const SCAN_REGISTERS = `SELECT "offset", round, value FROM registers
  WHERE "offset" >= ? AND "offset" < ? ORDER BY "offset"`;

const SCAN_SIZES = `SELECT "offset", length(value) AS bytes FROM registers
  WHERE "offset" >= ? AND "offset" < ? ORDER BY "offset"`;

const INSERT_CAPTURE =
  'INSERT INTO captures (round, start, "end", owner, captured_ms) ' +
  "VALUES (?, ?, ?, ?, ?)";

const PRUNE_CAPTURES = 'DELETE FROM captures WHERE start >= ? AND "end" <= ?';

const INSERT_REGISTER =
  'INSERT INTO registers ("offset", round, value, written_ms) ' +
  "VALUES (?, ?, ?, ?)";

const DELETE_REGISTERS_THROUGH = 'DELETE FROM registers WHERE "offset" <= ?';

const DELETE_CAPTURES_THROUGH = 'DELETE FROM captures WHERE "end" <= ?';

interface MetaRow extends SqlStorageRow {
  allocated: number;
  size: number;
  metadata: ArrayBuffer | null;
  allocator: string | null;
  allocated_ms: number;
  next_round: number;
  written_count: number;
  writes: number;
  trimmed_through: number;
}

interface CountRow extends SqlStorageRow {
  n: number;
}

interface CaptureSqlRow extends SqlStorageRow {
  round: number;
  start: number;
  end: number;
}

interface RegisterSqlRow extends SqlStorageRow {
  offset: number;
  round: number;
  value: ArrayBuffer;
}

interface SizeRow extends SqlStorageRow {
  offset: number;
  bytes: number;
}

/** A parked `listen`: woken with the durable counter, or `null` on timeout. */
interface Waiter {
  since: number;
  wake(writes: number | null): void;
}

export class Segment extends DurableObject implements SegmentAPI {
  /** Parked `listen` calls on this instance; never state, see the header. */
  readonly #waiters = new Set<Waiter>();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    for (
      const statement of [
        CREATE_META,
        SEED_META,
        CREATE_CAPTURES,
        CREATE_REGISTERS,
      ]
    ) {
      ctx.storage.sql.exec(statement).toArray();
    }
  }

  #run<Row extends SqlStorageRow>(
    query: string,
    ...bindings: SqlStorageBindable[]
  ): Row[] {
    return this.ctx.storage.sql.exec<Row>(query, ...bindings).toArray();
  }

  #count(query: string, ...bindings: SqlStorageBindable[]): number {
    return this.#run<CountRow>(query, ...bindings)[0].n;
  }

  #loadMeta(): Meta {
    const row = this.#run<MetaRow>(LOAD_META)[0];
    return {
      allocated: row.allocated !== 0,
      size: row.size,
      // SQLite hands back BLOBs as ArrayBuffers.
      metadata: row.metadata === null ? null : new Uint8Array(row.metadata),
      allocator: row.allocator,
      allocatedMs: row.allocated_ms,
      nextRound: row.next_round,
      writtenCount: row.written_count,
      writes: row.writes,
      trimmedThrough: row.trimmed_through,
    };
  }

  #saveMeta(meta: Meta): void {
    this.#run(
      SAVE_META,
      meta.allocated ? 1 : 0,
      meta.size,
      meta.metadata,
      meta.allocator,
      meta.allocatedMs,
      meta.nextRound,
      meta.writtenCount,
      meta.writes,
      meta.trimmedThrough,
    );
  }

  #overlapping(range: Range): CaptureRow[] {
    return this.#run<CaptureSqlRow>(
      OVERLAPPING_CAPTURES,
      range.end,
      range.start,
    ).map((row) => ({ round: row.round, start: row.start, end: row.end }));
  }

  #registers(range: Range): RegisterRow[] {
    return this.#run<RegisterSqlRow>(SCAN_REGISTERS, range.start, range.end)
      .map((row) => ({
        offset: row.offset,
        round: row.round,
        value: new Uint8Array(row.value),
      }));
  }

  #captureView(range: Range): CaptureView {
    return {
      writtenInRange: this.#count(COUNT_WRITTEN_IN, range.start, range.end),
      liveCaptures: this.#count(COUNT_CAPTURES),
      dominated: this.#count(COUNT_DOMINATED, range.start, range.end),
    };
  }

  #writeView(range: Range): WriteView {
    const existing = new Map<number, Uint8Array>();
    for (const row of this.#registers(range)) {
      existing.set(row.offset, row.value);
    }
    return { existing, captures: this.#overlapping(range) };
  }

  /**
   * Runs one transition atomically and acknowledges only durable writes.
   * `durable` sees the new meta once its barrier has returned, and only when
   * the transition changed something.
   */
  async #mutate<R>(
    step: (meta: Meta) => Outcome<R>,
    durable?: (meta: Meta) => void,
  ): Promise<R> {
    const storage = this.ctx.storage;
    const applied = storage.transactionSync(() => {
      const before = this.#loadMeta();
      const outcome = step(before);
      if (outcome.meta === before) {
        return { result: outcome.result, meta: null };
      }
      const prune = outcome.pruneCaptures;
      if (prune !== undefined) {
        this.#run(PRUNE_CAPTURES, prune.start, prune.end);
      }
      const captured = outcome.insertCapture;
      if (captured !== undefined) {
        this.#run(
          INSERT_CAPTURE,
          captured.round,
          captured.start,
          captured.end,
          captured.owner,
          captured.capturedMs,
        );
      }
      for (const row of outcome.insertRegisters ?? []) {
        this.#run(
          INSERT_REGISTER,
          row.offset,
          row.round,
          row.value,
          row.writtenMs,
        );
      }
      const through = outcome.deleteThrough;
      if (through !== undefined) {
        this.#run(DELETE_REGISTERS_THROUGH, through);
        this.#run(DELETE_CAPTURES_THROUGH, through + 1);
      }
      this.#saveMeta(outcome.meta);
      return { result: outcome.result, meta: outcome.meta };
    });
    if (applied.meta !== null) {
      await storage.sync();
      durable?.(applied.meta);
    }
    return applied.result;
  }

  /** Wakes every parked `listen` the durable counter `writes` has passed. */
  #wake(writes: number): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.since < writes) waiter.wake(writes);
    }
  }

  alloc(request: AllocRequest): Promise<AllocResult> {
    const nowMs = Date.now();
    return this.#mutate((meta) => core.alloc(meta, request, nowMs));
  }

  capture(request: CaptureRequest): Promise<CaptureResult> {
    const nowMs = Date.now();
    return this.#mutate((meta) => {
      const range = core.captureScope(meta, request);
      const view = range === null
        ? core.EMPTY_CAPTURE_VIEW
        : this.#captureView(range);
      return core.capture(meta, request, view, nowMs);
    });
  }

  /**
   * `ALREADY_WRITTEN` with `sameValue: true` is a replay's proof that its
   * write landed, and the register it found may still be at its barrier
   * (committed by a call whose reply was lost, or which is still waiting),
   * so that one refusal waits for a barrier before answering. Every other
   * refusal tells the writer only that its own write did not land.
   */
  async write(request: WriteRequest): Promise<WriteResult> {
    const nowMs = Date.now();
    const result = await this.#mutate((meta) => {
      const range = core.writeScope(meta, request);
      const view = range === null
        ? core.EMPTY_WRITE_VIEW
        : this.#writeView(range);
      return core.write(meta, request, view, nowMs);
    }, (meta) => this.#wake(meta.writes));
    if (!result.ok && result.code === "ALREADY_WRITTEN" && result.sameValue) {
      await this.ctx.storage.sync();
    }
    return result;
  }

  trim(request: TrimRequest): Promise<TrimResult> {
    return this.#mutate((meta) => {
      const through = core.trimScope(meta, request);
      const view = through === null
        ? core.EMPTY_TRIM_VIEW
        : { writtenThrough: this.#count(COUNT_WRITTEN_THROUGH, through) };
      return core.trim(meta, request, view);
    });
  }

  /**
   * Reads are consistent without a transaction: nothing awaits mid-scan. The
   * sizes are scanned first so only the values the byte budget admits are
   * ever loaded.
   */
  read(request: ReadRequest): Promise<ReadResult> {
    const meta = this.#loadMeta();
    const plan = core.planRead(meta, request);
    if (plan.kind === "reply") return Promise.resolve(plan.result);
    const sizes = this.#run<SizeRow>(SCAN_SIZES, plan.start, plan.end);
    const window = { start: plan.start, end: core.readWindow(plan, sizes) };
    return Promise.resolve(
      core.finishRead(
        meta,
        window,
        this.#registers(window),
        this.#overlapping(window),
      ),
    );
  }

  /**
   * The paper's `WOS_listen`, as a bounded long poll: answers once `writes`
   * passes `since`, or with `changed: false` after `timeoutMs`. The waiter
   * lives only in this instance, so an eviction or a move drops it and the
   * caller sees a transport error; `listen` is a hint, never a delivery
   * guarantee, and the answer to any failure is to ask again from the same
   * `since`.
   */
  async listen(request: ListenRequest): Promise<ListenResult> {
    const plan = core.planListen(this.#loadMeta(), request);
    if (plan.kind === "reply") {
      if (plan.result.ok) await this.ctx.storage.sync();
      return plan.result;
    }
    const writes = await new Promise<number | null>((resolve) => {
      const waiter: Waiter = {
        since: plan.since,
        wake: (value) => {
          clearTimeout(timer);
          this.#waiters.delete(waiter);
          resolve(value);
        },
      };
      const timer = setTimeout(() => waiter.wake(null), plan.timeoutMs);
      this.#waiters.add(waiter);
    });
    if (writes !== null) return { ok: true, writes, changed: true };
    // Timed out: a write may have committed and still be at its barrier, in
    // which case the counter is past `since` and must be durable first.
    const result = core.listenReply(this.#loadMeta(), plan.since);
    if (result.ok && result.changed) await this.ctx.storage.sync();
    return result;
  }

  status(): Promise<StatusResult> {
    const meta = this.#loadMeta();
    const captures = this.#count(COUNT_CAPTURES);
    const size = this.ctx.storage.sql.databaseSize;
    return Promise.resolve(core.status(meta, captures, size));
  }
}
