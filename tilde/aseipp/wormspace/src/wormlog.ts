// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * WormLog: a CORFU-style shared log over a segment chain and a sequencer.
 *
 * The log named `l` is the segment chain `l` (`chain.ts`) plus the `Sequencer`
 * cell named `l`. Slot `s` is global address `s` of the chain, and each
 * register holds an entry (`entry.ts`): a record, or a filled hole. This
 * module is the client: it runs wherever a `SequencerAPI` and a segment
 * resolver are at hand, which is the Worker in production and a Deno test
 * over the fakes.
 *
 *   - `append(value)` takes a token from the sequencer (a slot and the round
 *     the sequencer holds on its segment) and writes the entry there under
 *     that round: two round trips, and the second is one write. A write whose
 *     reply is lost is replayed with the same bytes, which settles it. A slot
 *     somebody filled first costs a new token; a stale round costs a
 *     `recapture` and a new token. A slot is never reused for a different
 *     value.
 *   - `read(from, count)` reports every issued slot in the window as `value`,
 *     `hole`, `pending` (issued, not yet written), or `corrupt` (written, but
 *     not an entry). Slots at or past the sequencer's `next` are not reported.
 *   - `fill(slot)` asks the sequencer to close a slot with the hole entry.
 *   - `trim(through)` trims every segment up to the slot, then records the
 *     mark on the sequencer, so a retry after a crash redoes the segments.
 *   - `listen(from, ...)` is the segment `listen` on the segment holding
 *     `from`.
 *
 * A register a `read` returns may have committed on its segment and not yet
 * passed that segment's durability barrier, so after every segment window
 * that returned a written register this module asks the same segment for a
 * zero-timeout `listen`, which answers only after a barrier. That closes the
 * window in which a reader could report a record the owner then lost, as
 * long as the same owner answered both calls; see the README's limits.
 *
 * @module
 */

import { chainPosition, type Segments } from "./chain.ts";
import { decodeEntry, encodeValue } from "./entry.ts";
import {
  type Contended,
  type FillResult,
  type InitResult,
  liftTrimmed,
  type LogStateResult,
  type SegmentFailure,
  type SequencerAPI,
} from "./sequencer_core.ts";
import {
  DEFAULT_RETRY,
  type RetryPolicy,
  retryTransient,
} from "@wormspace/segment/serial";
import {
  type Invalid,
  LIMITS,
  type ListenResult,
  type Trimmed,
} from "@wormspace/segment/types";

/** How many tokens one `append` may take before it reports `CONTENDED`. */
export const APPEND_ATTEMPTS = 8;

export type LogEntryState = "value" | "hole" | "pending" | "corrupt";

/** One slot as a reader sees it; `value` only for `value`. */
export interface LogEntry {
  slot: number;
  state: LogEntryState;
  value?: Uint8Array;
}

export interface AppendOk {
  ok: true;
  slot: number;
  /** Tokens this append took; more than one means it lost slots. */
  attempts: number;
}

export interface ReadLogOk {
  ok: true;
  entries: LogEntry[];
  /** The sequencer's next slot when the read started. */
  next: number;
  trimmedThrough: number;
  size: number;
}

export interface ListenLogOk {
  ok: true;
  /** The chain index of the segment that answered. */
  index: number;
  writes: number;
  changed: boolean;
}

export interface ReadLogRequest {
  from: number;
  count?: number;
}

export interface ListenLogRequest {
  from: number;
  since: number;
  timeoutMs?: number;
}

export type AppendResult = AppendOk | SegmentFailure | Contended;
export type ReadLogResult = ReadLogOk | SegmentFailure;
export type TrimLogResult = LogStateResult | SegmentFailure;
export type ListenLogResult =
  | ListenLogOk
  | Exclude<ListenResult, { ok: true }>
  | Invalid;

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

function trimmedLog(slot: number, trimmedThrough: number): Trimmed {
  return {
    ok: false,
    code: "TRIMMED",
    message: `slot ${slot} is trimmed`,
    trimmedThrough,
  };
}

/** One log: its name, its sequencer, and the resolver for its segments. */
export class WormLog {
  readonly log: string;
  readonly #sequencer: SequencerAPI;
  readonly #segments: Segments;
  readonly #retry: RetryPolicy;

  constructor(
    sequencer: SequencerAPI,
    segments: Segments,
    log: string,
    retry: RetryPolicy = DEFAULT_RETRY,
  ) {
    this.#sequencer = sequencer;
    this.#segments = segments;
    this.log = log;
    this.#retry = retry;
  }

  #again<T>(call: () => Promise<T>): Promise<T> {
    return retryTransient(call, this.#retry);
  }

  /** Fixes the segment size before the first slot; see `Sequencer.init`. */
  init(size: number): Promise<InitResult> {
    return this.#again(() => this.#sequencer.init({ log: this.log, size }));
  }

  tail(): Promise<LogStateResult> {
    return this.#again(() => this.#sequencer.tail({ log: this.log }));
  }

  /** Closes `slot` with the hole entry, unless it already holds a value. */
  fill(slot: number): Promise<FillResult> {
    return this.#again(() => this.#sequencer.fill({ log: this.log, slot }));
  }

  async append(value: Uint8Array): Promise<AppendResult> {
    const encoded = encodeValue(value);
    if (!encoded.ok) return encoded;
    const bytes = encoded.bytes;
    for (let attempt = 1; attempt <= APPEND_ATTEMPTS; attempt += 1) {
      const token = await this.#again(() =>
        this.#sequencer.next({ log: this.log })
      );
      if (!token.ok) return token;
      const segment = this.#segments(token.segment);
      // A replay carries the same bytes, so it either lands or proves the
      // first attempt did (`sameValue`).
      const result = await this.#again(() =>
        segment.write({
          start: token.offset,
          values: [bytes],
          captureId: token.captureId,
        })
      );
      if (result.ok) return { ok: true, slot: token.slot, attempts: attempt };
      switch (result.code) {
        case "ALREADY_WRITTEN":
          if (result.sameValue) {
            return { ok: true, slot: token.slot, attempts: attempt };
          }
          // Filled under us: the slot is closed, take another.
          continue;
        case "CAPTURE_STALE": {
          const again = await this.#again(() =>
            this.#sequencer.recapture({
              log: this.log,
              index: token.index,
              captureId: token.captureId,
            })
          );
          if (!again.ok) return again;
          continue;
        }
        case "TRIMMED":
          // Trimmed ahead of its writer; the slot is gone.
          continue;
        default:
          return liftTrimmed(result, token.index, token.size);
      }
    }
    return {
      ok: false,
      code: "CONTENDED",
      message: `no slot held after ${APPEND_ATTEMPTS} tokens`,
    };
  }

  async read(request: ReadLogRequest): Promise<ReadLogResult> {
    const { from, count } = fields(request);
    if (!isCount(from)) return invalid("from must be an integer >= 0");
    if (
      count !== undefined &&
      (!isCount(count) || count < 1 || count > LIMITS.readCount)
    ) {
      return invalid(`count must be an integer in [1, ${LIMITS.readCount}]`);
    }
    const tail = await this.tail();
    if (!tail.ok) return tail;
    const { size, next, trimmedThrough } = tail;
    if (from <= trimmedThrough) return trimmedLog(from, trimmedThrough);
    const end = Math.min(from + (count ?? LIMITS.defaultReadCount), next);
    const entries: LogEntry[] = [];
    let slot = from;
    while (slot < end) {
      const position = chainPosition(slot, size);
      if (!position.ok) return position;
      const { index, offset } = position;
      const want = Math.min(end - slot, size - offset);
      const segment = this.#segments(`${this.log}.${index}`);
      const window = await this.#again(() =>
        segment.read({ start: offset, count: want })
      );
      if (!window.ok) return liftTrimmed(window, index, size);
      let written = false;
      for (const register of window.registers) {
        const at = index * size + register.offset;
        if (register.state !== "written" || register.value === undefined) {
          entries.push({ slot: at, state: "pending" });
          continue;
        }
        written = true;
        const decoded = decodeEntry(register.value);
        if (!decoded.ok) {
          entries.push({ slot: at, state: "corrupt" });
        } else if (decoded.entry.kind === "hole") {
          entries.push({ slot: at, state: "hole" });
        } else {
          entries.push({
            slot: at,
            state: "value",
            value: decoded.entry.value,
          });
        }
      }
      if (written) {
        // Answers only once the segment's owner has passed a barrier.
        await this.#again(() => segment.listen({ since: 0, timeoutMs: 0 }));
      }
      slot += window.registers.length;
      // The segment's byte budget cut the window: the caller reads on from
      // the last slot returned.
      if (window.registers.length < want) break;
    }
    return { ok: true, entries, next, trimmedThrough, size };
  }

  async trim(through: number): Promise<TrimLogResult> {
    if (!isCount(through)) return invalid("through must be an integer >= 0");
    const tail = await this.tail();
    if (!tail.ok) return tail;
    const { size, next, trimmedThrough } = tail;
    if (through >= next) {
      return invalid(`through ${through} has not been issued; next is ${next}`);
    }
    if (through <= trimmedThrough) return tail;
    const first = chainPosition(trimmedThrough + 1, size);
    const last = chainPosition(through, size);
    if (!first.ok) return first;
    if (!last.ok) return last;
    for (let index = first.index; index <= last.index; index += 1) {
      const mark = index < last.index ? size - 1 : last.offset;
      const segment = this.#segments(`${this.log}.${index}`);
      const result = await this.#again(() => segment.trim({ through: mark }));
      if (!result.ok) return result;
    }
    return this.#again(() =>
      this.#sequencer.trimmed({ log: this.log, through })
    );
  }

  /**
   * Parks on the segment holding `from` until its `writes` counter passes
   * `since`. `UNALLOCATED` means the log has not reached that segment yet.
   * Not repeated here: a dropped park is the caller's to repeat.
   */
  async listen(request: ListenLogRequest): Promise<ListenLogResult> {
    const { from, since, timeoutMs } = fields(request);
    if (!isCount(from)) return invalid("from must be an integer >= 0");
    const tail = await this.tail();
    if (!tail.ok) return tail;
    const position = chainPosition(from, tail.size);
    if (!position.ok) return position;
    const segment = this.#segments(`${this.log}.${position.index}`);
    const result = await segment.listen({
      since: since as number,
      ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
    });
    if (!result.ok) return result;
    return {
      ok: true,
      index: position.index,
      writes: result.writes,
      changed: result.changed,
    };
  }
}
