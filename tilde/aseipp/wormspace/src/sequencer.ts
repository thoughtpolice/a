// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * WormLog's sequencer, as one Durable Object per log: the SQLite store around
 * `sequencer_core.ts`.
 *
 * The storage rules are `segment.ts`'s: one statement per `sql.exec`, every
 * cursor drained, each commit one `transactionSync`, `sync()` awaited outside
 * it and only after something committed, never the asynchronous
 * `storage.transaction()`, and a constructor that never awaits. The one thing
 * held in memory is the core's call queue, which is not state.
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";

import {
  type FillRequest,
  type FillResult,
  type InitRequest,
  type InitResult,
  type LogRequest,
  type LogStateResult,
  type MarkRequest,
  type NextResult,
  type RecaptureRequest,
  type RecaptureResult,
  type SequencerAPI,
  type SequencerChange,
  SequencerCore,
  type SequencerState,
  type SequencerStore,
} from "@wormspace/layers/sequencer_core";
import type { SegmentAPI } from "@wormspace/segment/types";

export interface SequencerEnv {
  SEGMENTS: DurableObjectNamespace<SegmentAPI>;
}

const CREATE_META = `CREATE TABLE IF NOT EXISTS sequencer_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  log TEXT NOT NULL,
  size INTEGER NOT NULL,
  next INTEGER NOT NULL,
  trimmed_through INTEGER NOT NULL
)`;

const CREATE_CAPTURES = `CREATE TABLE IF NOT EXISTS sequencer_captures (
  link INTEGER PRIMARY KEY,
  capture_id INTEGER NOT NULL
)`;

const LOAD_META =
  "SELECT log, size, next, trimmed_through FROM sequencer_meta WHERE id = 1";

const SAVE_META = "INSERT OR REPLACE INTO sequencer_meta " +
  "(id, log, size, next, trimmed_through) VALUES (1, ?, ?, ?, ?)";

const LOAD_CAPTURE = "SELECT capture_id FROM sequencer_captures WHERE link = ?";

const SAVE_CAPTURE = "INSERT OR REPLACE INTO sequencer_captures " +
  "(link, capture_id) VALUES (?, ?)";

interface MetaRow extends SqlStorageRow {
  log: string;
  size: number;
  next: number;
  trimmed_through: number;
}

interface CaptureRow extends SqlStorageRow {
  capture_id: number;
}

/** The sequencer's tables behind the core's synchronous store interface. */
class SqlSequencerStore implements SequencerStore {
  readonly #storage: DurableObjectStorage;
  /** Whether a commit is still waiting for its barrier; not state. */
  #dirty = false;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    for (const statement of [CREATE_META, CREATE_CAPTURES]) {
      storage.sql.exec(statement).toArray();
    }
  }

  #run<Row extends SqlStorageRow>(
    query: string,
    ...bindings: SqlStorageBindable[]
  ): Row[] {
    return this.#storage.sql.exec<Row>(query, ...bindings).toArray();
  }

  load(): SequencerState | null {
    const row = this.#run<MetaRow>(LOAD_META)[0];
    if (row === undefined) return null;
    return {
      log: row.log,
      size: row.size,
      next: row.next,
      trimmedThrough: row.trimmed_through,
    };
  }

  captureOf(index: number): number | null {
    return this.#run<CaptureRow>(LOAD_CAPTURE, index)[0]?.capture_id ?? null;
  }

  commit(change: SequencerChange): void {
    this.#storage.transactionSync(() => {
      const state = change.state;
      if (state !== undefined) {
        this.#run(
          SAVE_META,
          state.log,
          state.size,
          state.next,
          state.trimmedThrough,
        );
      }
      const capture = change.capture;
      if (capture !== undefined) {
        this.#run(SAVE_CAPTURE, capture.index, capture.captureId);
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

export class Sequencer extends DurableObject<SequencerEnv>
  implements SequencerAPI {
  readonly #core: SequencerCore;

  constructor(ctx: DurableObjectState, env: SequencerEnv) {
    super(ctx, env);
    this.#core = new SequencerCore(
      new SqlSequencerStore(ctx.storage),
      (name) => env.SEGMENTS.getByName(name),
    );
  }

  init(request: InitRequest): Promise<InitResult> {
    return this.#core.init(request);
  }

  next(request: LogRequest): Promise<NextResult> {
    return this.#core.next(request);
  }

  recapture(request: RecaptureRequest): Promise<RecaptureResult> {
    return this.#core.recapture(request);
  }

  fill(request: FillRequest): Promise<FillResult> {
    return this.#core.fill(request);
  }

  tail(request: LogRequest): Promise<LogStateResult> {
    return this.#core.tail(request);
  }

  trimmed(request: MarkRequest): Promise<LogStateResult> {
    return this.#core.trimmed(request);
  }
}
