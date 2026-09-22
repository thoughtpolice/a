// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * WormLog's sequencer, as logic over a store and a segment resolver.
 *
 * The paper's WormLog (TR1544 §4.2) appends in two round trips: a token from
 * a sequencer, then one write. The sequencer makes that possible by
 * allocating each segment and capturing all of it before handing out any
 * slot in it, and by handing the capture's round to every appender with its
 * slot, so an append is a write predicated on a capture it never had to make.
 *
 * Here the sequencer is a cell, so unlike the paper's soft-state hint it is
 * durable and there is exactly one of it: the next slot, the segment size, the
 * trim mark, and the round held on each segment are its store, and a slot is
 * handed out only after the counter that issued it is durable. A slot is
 * therefore never issued twice, and an appender that loses its token simply
 * leaves a pending register for `fill` to close.
 *
 * Every method is serialised on the instance (`Serial`): each reads the store,
 * may call segments, and writes the store back, and two of them must never
 * interleave at an `await`. Segment calls that celld says are safe to repeat
 * are repeated a bounded number of times; everything else a segment throws is
 * thrown to the caller, who may repeat the whole method (each is idempotent,
 * except that a repeated `next` issues another slot).
 *
 * The store interface is synchronous, as SQLite is inside a Durable Object:
 * `commit` applies one change atomically and `barrier` waits until everything
 * committed so far is durable (and does nothing when nothing was).
 *
 * @module
 */

import {
  Chain,
  CHAIN_NAME_PATTERN,
  type ChainMismatch,
  chainPosition,
  type Segments,
} from "./chain.ts";
import { holeBytes } from "./entry.ts";
import {
  DEFAULT_RETRY,
  type RetryPolicy,
  retryTransient,
  Serial,
} from "@wormspace/segment/serial";
import {
  type CaptureResult,
  type Invalid,
  LIMITS,
  type OutOfRange,
  type TooLarge,
  type Trimmed,
  type Unallocated,
} from "@wormspace/segment/types";

/** The segment size a log gets when nobody chose one before its first slot. */
export const DEFAULT_SEGMENT_SIZE = 4096;

/** How many times `fill` recaptures before it gives up. */
const FILL_ATTEMPTS = 3;

/** The sequencer's durable state, apart from the round it holds per segment. */
export interface SequencerState {
  log: string;
  size: number;
  /** The next slot to issue; every slot below it has been issued. */
  next: number;
  /** The global trim mark, or -1 before the first trim. */
  trimmedThrough: number;
}

/** One atomic change: the state row, a segment's round, or both. */
export interface SequencerChange {
  state?: SequencerState;
  capture?: { index: number; captureId: number };
}

/** What the sequencer keeps; SQLite in the Durable Object, a Map in tests. */
export interface SequencerStore {
  /** The state row, or `null` before anything was committed. */
  load(): SequencerState | null;
  /** The round this sequencer holds on segment `index`, if it captured it. */
  captureOf(index: number): number | null;
  commit(change: SequencerChange): void;
  /** Waits until every commit so far is durable; free when there was none. */
  barrier(): Promise<void>;
}

/** The log's size is already fixed, by its first slot or by link 0. */
export interface Conflict {
  ok: false;
  code: "CONFLICT";
  message: string;
  size: number;
}

/** A bounded retry loop ran out; nothing it tried took effect. */
export interface Contended {
  ok: false;
  code: "CONTENDED";
  message: string;
}

export interface LogRequest {
  log: string;
}

export interface InitRequest extends LogRequest {
  size: number;
}

export interface RecaptureRequest extends LogRequest {
  index: number;
  /** The round the caller was refused with. */
  captureId: number;
}

export interface FillRequest extends LogRequest {
  slot: number;
}

export interface MarkRequest extends LogRequest {
  through: number;
}

/** The log as the sequencer sees it. */
export interface LogStateOk {
  ok: true;
  log: string;
  size: number;
  next: number;
  trimmedThrough: number;
}

/** One issued slot: where it lives, and the round to write it under. */
export interface TokenOk {
  ok: true;
  slot: number;
  index: number;
  offset: number;
  segment: string;
  captureId: number;
  size: number;
}

export interface RecaptureOk {
  ok: true;
  index: number;
  captureId: number;
}

/** `hole` says whether the slot now holds the hole entry (else a value). */
export interface FillOk {
  ok: true;
  slot: number;
  hole: boolean;
}

/** What a segment call made on the log's behalf can fail with. */
export type SegmentFailure =
  | Invalid
  | TooLarge
  | Unallocated
  | OutOfRange
  | Trimmed
  | ChainMismatch;

export type InitResult = LogStateOk | Invalid | Conflict;
export type NextResult = TokenOk | SegmentFailure;
export type RecaptureResult = RecaptureOk | SegmentFailure;
export type FillResult = FillOk | SegmentFailure | Contended;
export type LogStateResult = LogStateOk | Invalid;

/** The sequencer's remote surface: the Durable Object's, and the core's. */
export interface SequencerAPI {
  init(request: InitRequest): Promise<InitResult>;
  next(request: LogRequest): Promise<NextResult>;
  recapture(request: RecaptureRequest): Promise<RecaptureResult>;
  fill(request: FillRequest): Promise<FillResult>;
  tail(request: LogRequest): Promise<LogStateResult>;
  trimmed(request: MarkRequest): Promise<LogStateResult>;
}

function invalid(message: string): Invalid {
  return { ok: false, code: "INVALID", message };
}

function fields(request: unknown): Record<string, unknown> {
  return (typeof request === "object" && request !== null
    ? request
    : {}) as Record<string, unknown>;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}

/**
 * A segment's `TRIMMED` names its own offset; the log's names a slot. Every
 * other failure passes through as it is.
 */
export function liftTrimmed<R extends { ok: boolean; code?: string }>(
  result: R,
  index: number,
  size: number,
): R {
  const trimmed = result as unknown as Trimmed;
  if (!result.ok && trimmed.code === "TRIMMED") {
    return {
      ...result,
      trimmedThrough: index * size + trimmed.trimmedThrough,
    };
  }
  return result;
}

export class SequencerCore implements SequencerAPI {
  readonly #store: SequencerStore;
  readonly #segments: Segments;
  readonly #retry: RetryPolicy;
  readonly #serial = new Serial();

  constructor(
    store: SequencerStore,
    segments: Segments,
    retry: RetryPolicy = DEFAULT_RETRY,
  ) {
    this.#store = store;
    this.#segments = segments;
    this.#retry = retry;
  }

  /** The state for `log`, the defaults before its first commit. */
  #state(request: unknown): SequencerState | Invalid {
    const { log } = fields(request);
    if (typeof log !== "string" || !CHAIN_NAME_PATTERN.test(log)) {
      return invalid(`log names must match ${CHAIN_NAME_PATTERN}`);
    }
    const state = this.#store.load();
    if (state === null) {
      return { log, size: DEFAULT_SEGMENT_SIZE, next: 0, trimmedThrough: -1 };
    }
    if (state.log !== log) {
      return invalid(`this sequencer serves log ${state.log}, not ${log}`);
    }
    return state;
  }

  #owner(state: SequencerState): string {
    return `sequencer:${state.log}`;
  }

  #report(state: SequencerState): LogStateOk {
    return {
      ok: true,
      log: state.log,
      size: state.size,
      next: state.next,
      trimmedThrough: state.trimmedThrough,
    };
  }

  /** Captures all of segment `index` and records the round. */
  async #capture(
    state: SequencerState,
    index: number,
  ): Promise<RecaptureOk | SegmentFailure> {
    const name = `${state.log}.${index}`;
    const result: CaptureResult = await retryTransient(
      () =>
        this.#segments(name).capture({
          start: 0,
          end: state.size,
          owner: this.#owner(state),
        }),
      this.#retry,
    );
    if (!result.ok) return liftTrimmed(result, index, state.size);
    this.#store.commit({ capture: { index, captureId: result.captureId } });
    return { ok: true, index, captureId: result.captureId };
  }

  /** Allocates link `index` (in order, idempotently), then captures it. */
  async #open(
    state: SequencerState,
    index: number,
  ): Promise<RecaptureOk | SegmentFailure> {
    const chain = Chain.create(this.#segments, state.log, state.size);
    if (!chain.ok) return chain;
    const allocated = await retryTransient(
      () => chain.chain.allocate(index, this.#owner(state)),
      this.#retry,
    );
    if (!allocated.ok) return allocated;
    return this.#capture(state, index);
  }

  /** Recaptures `index` unless the caller's round is already superseded. */
  #recapture(
    state: SequencerState,
    index: number,
    stale: number,
  ): Promise<RecaptureResult> {
    const current = this.#store.captureOf(index);
    if (current === null) {
      return Promise.resolve(
        invalid(`segment ${index} was never captured by this sequencer`),
      );
    }
    if (current !== stale) {
      return Promise.resolve({ ok: true, index, captureId: current });
    }
    return this.#capture(state, index);
  }

  init(request: InitRequest): Promise<InitResult> {
    return this.#serial.run(async () => {
      const state = this.#state(request);
      if ("code" in state) return state;
      const { size } = fields(request);
      if (!isCount(size) || size < 1 || size > LIMITS.maxSize) {
        return invalid(`size must be an integer in [1, ${LIMITS.maxSize}]`);
      }
      const committed = this.#store.load() !== null;
      if (size === state.size && committed) return this.#report(state);
      if (
        size !== state.size &&
        (state.next > 0 || this.#store.captureOf(0) !== null)
      ) {
        return {
          ok: false,
          code: "CONFLICT",
          message: `log ${state.log} already has segments of ${state.size}`,
          size: state.size,
        };
      }
      // Link 0 is the chain's word on the size, even if this sequencer has
      // never seen it.
      const first = await retryTransient(
        () => this.#segments(`${state.log}.0`).status(),
        this.#retry,
      );
      if (first.allocated && first.size !== size) {
        return {
          ok: false,
          code: "CONFLICT",
          message: `link 0 of ${state.log} has ${first.size} registers`,
          size: first.size,
        };
      }
      const next = { ...state, size };
      this.#store.commit({ state: next });
      await this.#store.barrier();
      return this.#report(next);
    });
  }

  next(request: LogRequest): Promise<NextResult> {
    return this.#serial.run(async () => {
      const state = this.#state(request);
      if ("code" in state) return state;
      const position = chainPosition(state.next, state.size);
      if (!position.ok) return invalid(`log ${state.log} is full`);
      const { index, offset } = position;
      let captureId = this.#store.captureOf(index);
      if (captureId === null) {
        const opened = await this.#open(state, index);
        if (!opened.ok) {
          // The round, if any, is committed; make it durable anyway.
          await this.#store.barrier();
          return opened;
        }
        captureId = opened.captureId;
      }
      this.#store.commit({ state: { ...state, next: state.next + 1 } });
      await this.#store.barrier();
      return {
        ok: true,
        slot: state.next,
        index,
        offset,
        segment: `${state.log}.${index}`,
        captureId,
        size: state.size,
      };
    });
  }

  recapture(request: RecaptureRequest): Promise<RecaptureResult> {
    return this.#serial.run(async () => {
      const state = this.#state(request);
      if ("code" in state) return state;
      const { index, captureId } = fields(request);
      if (!isCount(index) || !isCount(captureId)) {
        return invalid("index and captureId must be integers >= 0");
      }
      const result = await this.#recapture(state, index, captureId);
      await this.#store.barrier();
      return result;
    });
  }

  /**
   * Closes an issued slot with the hole entry, under the sequencer's own
   * round: the paper's hole filling, done by the one holder of the capture.
   * A slot that already holds a value keeps it (`hole: false`), and a slot
   * this call or an earlier one already filled reports `hole: true`.
   */
  fill(request: FillRequest): Promise<FillResult> {
    return this.#serial.run(async () => {
      const state = this.#state(request);
      if ("code" in state) return state;
      const { slot } = fields(request);
      if (!isCount(slot)) return invalid("slot must be an integer >= 0");
      if (slot >= state.next) {
        return invalid(
          `slot ${slot} has not been issued; next is ${state.next}`,
        );
      }
      if (slot <= state.trimmedThrough) {
        return {
          ok: false,
          code: "TRIMMED",
          message: `slot ${slot} is trimmed`,
          trimmedThrough: state.trimmedThrough,
        };
      }
      const position = chainPosition(slot, state.size);
      if (!position.ok) return position;
      const { index, offset } = position;
      let captureId = this.#store.captureOf(index);
      if (captureId === null) {
        return invalid(`segment ${index} was never captured by this sequencer`);
      }
      const segment = this.#segments(`${state.log}.${index}`);
      for (let attempt = 0; attempt < FILL_ATTEMPTS; attempt += 1) {
        const round = captureId;
        const result = await retryTransient(
          () =>
            segment.write({
              start: offset,
              values: [holeBytes()],
              captureId: round,
            }),
          this.#retry,
        );
        if (result.ok) {
          await this.#store.barrier();
          return { ok: true, slot, hole: true };
        }
        if (result.code === "ALREADY_WRITTEN") {
          await this.#store.barrier();
          return { ok: true, slot, hole: result.sameValue };
        }
        if (result.code !== "CAPTURE_STALE") {
          return liftTrimmed(result, index, state.size);
        }
        const again = await this.#recapture(state, index, round);
        if (!again.ok) return again;
        captureId = again.captureId;
      }
      await this.#store.barrier();
      return {
        ok: false,
        code: "CONTENDED",
        message: `slot ${slot}: the capture was stolen ${FILL_ATTEMPTS} times`,
      };
    });
  }

  tail(request: LogRequest): Promise<LogStateResult> {
    return this.#serial.run(() => {
      const state = this.#state(request);
      return Promise.resolve("code" in state ? state : this.#report(state));
    });
  }

  /** Records a trim mark, which only moves forward and never past `next`. */
  trimmed(request: MarkRequest): Promise<LogStateResult> {
    return this.#serial.run(async () => {
      const state = this.#state(request);
      if ("code" in state) return state;
      const { through } = fields(request);
      if (!isCount(through)) return invalid("through must be an integer >= 0");
      if (through >= state.next) {
        return invalid(
          `through ${through} has not been issued; next is ${state.next}`,
        );
      }
      if (through <= state.trimmedThrough) return this.#report(state);
      const next = { ...state, trimmedThrough: through };
      this.#store.commit({ state: next });
      await this.#store.barrier();
      return this.#report(next);
    });
  }
}
