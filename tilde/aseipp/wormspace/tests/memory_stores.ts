// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory stores for the sequencer and replica cores, and a fault wrapper
 * for the sequencer's remote surface.
 *
 * The stores are what the Durable Objects keep in SQLite, as Maps: every
 * `load` hands out a copy, and `commit` applies its whole change at once. A
 * test "restarts" a cell by building a new core over the same store, which
 * drops the call queue and keeps exactly what was committed.
 *
 * `FaultySequencer` stands between a `WormLog` and a `SequencerCore` the way
 * celld's RPC does, consulting a hook before each call that can make it throw
 * without performing it, or perform it and then lose the reply.
 *
 * @module
 */

import type {
  KvChange,
  ReplicaState,
  ReplicaStore,
} from "@wormspace/layers/replica_core";
import type {
  FillRequest,
  InitRequest,
  LogRequest,
  MarkRequest,
  RecaptureRequest,
  SequencerAPI,
  SequencerChange,
  SequencerState,
  SequencerStore,
} from "@wormspace/layers/sequencer_core";
import { lostReply, unreachable } from "@wormspace/testing/fake_segment";

export class MemorySequencerStore implements SequencerStore {
  state: SequencerState | null = null;
  readonly captures = new Map<number, number>();
  commits = 0;
  barriers = 0;
  #pending = false;

  load(): SequencerState | null {
    return this.state === null ? null : { ...this.state };
  }

  captureOf(index: number): number | null {
    return this.captures.get(index) ?? null;
  }

  commit(change: SequencerChange): void {
    if (change.state !== undefined) this.state = { ...change.state };
    if (change.capture !== undefined) {
      this.captures.set(change.capture.index, change.capture.captureId);
    }
    this.commits += 1;
    this.#pending = true;
  }

  async barrier(): Promise<void> {
    if (this.#pending) {
      this.#pending = false;
      this.barriers += 1;
    }
    await Promise.resolve();
  }
}

export class MemoryReplicaStore implements ReplicaStore {
  state: ReplicaState | null = null;
  readonly kv = new Map<string, string>();
  commits = 0;
  #pending = false;

  load(): ReplicaState | null {
    return this.state === null ? null : structuredClone(this.state);
  }

  get(key: string): string | null {
    return this.kv.get(key) ?? null;
  }

  commit(state: ReplicaState, changes: readonly KvChange[]): void {
    this.state = structuredClone(state);
    for (const change of changes) {
      if (change.value === null) this.kv.delete(change.key);
      else this.kv.set(change.key, change.value);
    }
    this.commits += 1;
    this.#pending = true;
  }

  async barrier(): Promise<void> {
    this.#pending = false;
    await Promise.resolve();
  }

  /** The table, sorted, for comparing two replicas. */
  entries(): [string, string][] {
    return [...this.kv.entries()].sort(([a], [b]) => a < b ? -1 : 1);
  }
}

export type SequencerMethod = keyof SequencerAPI;

/** `"throw"`: not performed; `"lost"`: performed, then the reply is lost. */
export type SequencerFault = (
  method: SequencerMethod,
  request: unknown,
) => "throw" | "lost" | undefined;

/** A sequencer behind an RPC-like edge with a fault hook and a call log. */
export class FaultySequencer implements SequencerAPI {
  readonly calls: SequencerMethod[] = [];
  faults: SequencerFault | undefined;
  target: SequencerAPI;

  constructor(target: SequencerAPI, faults?: SequencerFault) {
    this.target = target;
    this.faults = faults;
  }

  async #call<R>(
    method: SequencerMethod,
    request: unknown,
    body: () => Promise<R>,
  ): Promise<R> {
    this.calls.push(method);
    const action = this.faults?.(method, request);
    if (action === "throw") throw unreachable();
    await Promise.resolve();
    const result = structuredClone(await body());
    if (action === "lost") throw lostReply();
    return result;
  }

  init(request: InitRequest) {
    return this.#call("init", request, () => this.target.init(request));
  }

  next(request: LogRequest) {
    return this.#call("next", request, () => this.target.next(request));
  }

  recapture(request: RecaptureRequest) {
    return this.#call(
      "recapture",
      request,
      () => this.target.recapture(request),
    );
  }

  fill(request: FillRequest) {
    return this.#call("fill", request, () => this.target.fill(request));
  }

  tail(request: LogRequest) {
    return this.#call("tail", request, () => this.target.tail(request));
  }

  trimmed(request: MarkRequest) {
    return this.#call("trimmed", request, () => this.target.trimmed(request));
  }
}
