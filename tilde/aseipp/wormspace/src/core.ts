// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Every decision a segment makes, as pure transitions.
 *
 * The write-once and round rules are the parts worth testing exhaustively, and
 * a Deno test cannot import `cloudflare:workers`, so the decisions live here
 * and the Durable Object only loads what they read and persists what they
 * emit. Unlike the journal, decisions here depend on register state, so each
 * transition that needs it takes an explicit view: the Durable Object asks the
 * matching `*Scope` function what to load, loads it inside the same
 * `transactionSync`, and hands it over. A test builds the same view from a
 * model.
 *
 * Register semantics are single-shot Paxos with the cell's single owner
 * standing in for the acceptor quorum:
 *
 *   - `capture` is phase 1: it takes the next round for a range. The effective
 *     round of an offset is the highest round whose range covers it, or 0.
 *   - `write` is phase 2: it lands only if, at every offset, the register is
 *     unwritten and its effective round is exactly the caller's `captureId`.
 *     `captureId` 0 (the unsafe write) therefore lands only on a register no
 *     one ever captured.
 *   - A written register is immutable and immune to later captures.
 *
 * Invariants maintained by every transition:
 *
 *   nextRound never decreases, and each round is handed to exactly one capture
 *   a written register's value and round never change
 *   writtenCount = number of written registers above trimmedThrough
 *   writes = number of registers ever written, and it never decreases
 *   -1 <= trimmedThrough <= size - 1, and trimmedThrough never decreases
 *   nothing at or below trimmedThrough is stored
 *   the unallocated segment has size 0 and nothing else is decided for it
 *
 * @module
 */

import {
  type AllocRequest,
  type AllocResult,
  type CaptureRequest,
  type CaptureResult,
  type Invalid,
  LIMITS,
  type ListenRequest,
  type ListenResult,
  type OutOfRange,
  type ReadRequest,
  type ReadResult,
  type Register,
  type StatusResult,
  type TooLarge,
  type Trimmed,
  type TrimRequest,
  type TrimResult,
  type Unallocated,
  type WriteRequest,
  type WriteResult,
} from "./types.ts";

/** The single durable row every decision reads and rewrites. */
export interface Meta {
  allocated: boolean;
  size: number;
  metadata: Uint8Array | null;
  allocator: string | null;
  allocatedMs: number;
  /** The round the next capture receives; rounds start at 1. */
  nextRound: number;
  /** Written registers above `trimmedThrough`. */
  writtenCount: number;
  /**
   * Registers ever written, trimmed or not. Monotone; `listen` waits for it to
   * pass the caller's last value.
   */
  writes: number;
  /** The highest trimmed offset, or -1 before the first trim. */
  trimmedThrough: number;
}

/** The state of a segment nobody has allocated. */
export const INITIAL_META: Meta = {
  allocated: false,
  size: 0,
  metadata: null,
  allocator: null,
  allocatedMs: 0,
  nextRound: 1,
  writtenCount: 0,
  writes: 0,
  trimmedThrough: -1,
};

/** A half-open range of offsets. */
export interface Range {
  start: number;
  end: number;
}

/** One stored capture: `round` holds `[start, end)` unless a higher round covers. */
export interface CaptureRow {
  round: number;
  start: number;
  end: number;
}

/** A capture a transition wants persisted. */
export interface NewCapture extends CaptureRow {
  owner: string | null;
  capturedMs: number;
}

/** A register a transition wants persisted; `round` is the writing round. */
export interface NewRegister {
  offset: number;
  round: number;
  value: Uint8Array;
  writtenMs: number;
}

/** A written register, as storage holds it. */
export interface RegisterRow {
  offset: number;
  round: number;
  value: Uint8Array;
}

/** What `capture` needs to know about storage, over its effective range. */
export interface CaptureView {
  /** Written registers inside the range. */
  writtenInRange: number;
  /** Capture rows in the whole segment. */
  liveCaptures: number;
  /** Capture rows lying entirely inside the range, which this capture prunes. */
  dominated: number;
}

/** What `write` needs to know about storage, over the written range. */
export interface WriteView {
  /** The stored value of every already-written register in the range. */
  existing: ReadonlyMap<number, Uint8Array>;
  /** Every capture row overlapping the range. */
  captures: readonly CaptureRow[];
}

/** What `trim` needs to know about storage. */
export interface TrimView {
  /** Written registers at or below the requested mark. */
  writtenThrough: number;
}

/** The views a rejected request is decided with; nothing reads them. */
export const EMPTY_CAPTURE_VIEW: CaptureView = {
  writtenInRange: 0,
  liveCaptures: 0,
  dominated: 0,
};
export const EMPTY_WRITE_VIEW: WriteView = {
  existing: new Map(),
  captures: [],
};
export const EMPTY_TRIM_VIEW: TrimView = { writtenThrough: 0 };

/**
 * A decision and the write set that realizes it. `meta === input` means the
 * decision changed nothing: the Durable Object uses that identity to skip both
 * the update and the durability barrier, so a rejected request never syncs.
 *
 * Storage applies the fields in this order: `pruneCaptures` (delete capture
 * rows lying entirely inside the range), `insertCapture`, `insertRegisters`,
 * then `deleteThrough` (delete register rows at or below it, and capture rows
 * whose whole range is).
 */
export interface Outcome<R> {
  meta: Meta;
  result: R;
  insertRegisters?: NewRegister[];
  insertCapture?: NewCapture;
  pruneCaptures?: Range;
  deleteThrough?: number;
}

/**
 * What a `listen` does: answer now (a rejection, or a counter already past
 * `since`), or park until the counter passes `since` or `timeoutMs` elapses.
 */
export type ListenPlan =
  | { kind: "reply"; result: ListenResult }
  | { kind: "wait"; since: number; timeoutMs: number };

/** The scan a `read` needs, or the reply it already has. */
export type ReadPlan =
  | { kind: "reply"; result: ReadResult }
  | { kind: "scan"; start: number; end: number; maxBytes: number };

/** Requests arrive over RPC from arbitrary JavaScript, so nothing is assumed. */
function fields(request: unknown): Record<string, unknown> {
  return (typeof request === "object" && request !== null
    ? request
    : {}) as Record<string, unknown>;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= LIMITS.nameChars;
}

function invalid(message: string): Invalid {
  return { ok: false, code: "INVALID", message };
}

function tooLarge(message: string): TooLarge {
  return { ok: false, code: "TOO_LARGE", message };
}

function unallocated(): Unallocated {
  return {
    ok: false,
    code: "UNALLOCATED",
    message: "the segment has not been allocated",
  };
}

function outOfRange(meta: Meta, message: string): OutOfRange {
  return { ok: false, code: "OUT_OF_RANGE", size: meta.size, message };
}

function trimmed(meta: Meta, message: string): Trimmed {
  return {
    ok: false,
    code: "TRIMMED",
    message,
    trimmedThrough: meta.trimmedThrough,
  };
}

/** Keeps `meta` identical so the caller can tell that nothing was decided. */
function reject<R>(meta: Meta, result: R): Outcome<R> {
  return { meta, result };
}

/** Byte equality: the write-once replay proof. */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** The highest round covering `offset`, or 0 when no capture covers it. */
export function effectiveRound(
  captures: readonly CaptureRow[],
  offset: number,
): number {
  let round = 0;
  for (const row of captures) {
    if (row.start <= offset && offset < row.end && row.round > round) {
      round = row.round;
    }
  }
  return round;
}

/**
 * Allocates the segment for the first caller; every later caller, including
 * a replay of the winning one, learns the existing allocation instead. That
 * pair is the paper's `alloc`/`check`, and first-writer-wins is its leader
 * election idiom.
 */
export function alloc(
  meta: Meta,
  request: AllocRequest,
  nowMs: number,
): Outcome<AllocResult> {
  const { size, metadata, allocator } = fields(request);
  if (!isCount(size) || size < 1 || size > LIMITS.maxSize) {
    return reject(
      meta,
      invalid(`size must be an integer in [1, ${LIMITS.maxSize}]`),
    );
  }
  if (!(metadata instanceof Uint8Array)) {
    return reject(meta, invalid("metadata must be a Uint8Array"));
  }
  if (metadata.byteLength > LIMITS.metadataBytes) {
    return reject(
      meta,
      tooLarge(
        `metadata of ${metadata.byteLength} bytes exceeds ${LIMITS.metadataBytes}`,
      ),
    );
  }
  if (allocator !== undefined && !isName(allocator)) {
    return reject(
      meta,
      invalid("allocator must be a 1..128 character string"),
    );
  }
  if (meta.allocated) {
    return reject(meta, {
      ok: false,
      code: "ALREADY_ALLOCATED",
      message: "the segment is already allocated",
      size: meta.size,
      metadata: meta.metadata ?? new Uint8Array(0),
      allocator: meta.allocator,
      allocatedMs: meta.allocatedMs,
    });
  }
  return {
    meta: {
      ...meta,
      allocated: true,
      size,
      metadata,
      allocator: allocator ?? null,
      allocatedMs: nowMs,
    },
    result: { ok: true, size, allocatedMs: nowMs },
  };
}

/** Operator view of one segment. */
export function status(
  meta: Meta,
  captures: number,
  databaseSize: number,
): StatusResult {
  return {
    ok: true,
    allocated: meta.allocated,
    size: meta.size,
    metadata: meta.metadata,
    allocator: meta.allocator,
    allocatedMs: meta.allocatedMs,
    nextRound: meta.nextRound,
    writtenCount: meta.writtenCount,
    writes: meta.writes,
    captures,
    trimmedThrough: meta.trimmedThrough,
    databaseSize,
  };
}

type CaptureCheck =
  | { ok: false; result: CaptureResult }
  | { ok: true; start: number; end: number; owner: string | null };

function checkCapture(meta: Meta, request: CaptureRequest): CaptureCheck {
  const { start, end, owner } = fields(request);
  if (!isCount(start) || start < 0) {
    return { ok: false, result: invalid("start must be an integer >= 0") };
  }
  const last = end === undefined ? start + 1 : end;
  if (!isCount(last) || last <= start) {
    return { ok: false, result: invalid("end must be an integer > start") };
  }
  if (owner !== undefined && !isName(owner)) {
    return {
      ok: false,
      result: invalid("owner must be a 1..128 character string"),
    };
  }
  if (!meta.allocated) return { ok: false, result: unallocated() };
  if (last > meta.size) {
    return {
      ok: false,
      result: outOfRange(
        meta,
        `range [${start}, ${last}) exceeds ${meta.size}`,
      ),
    };
  }
  if (last - 1 <= meta.trimmedThrough) {
    return {
      ok: false,
      result: trimmed(meta, `range [${start}, ${last}) is entirely trimmed`),
    };
  }
  return {
    ok: true,
    start: Math.max(start, meta.trimmedThrough + 1),
    end: last,
    owner: owner ?? null,
  };
}

/** The effective range a capture will take, or `null` when it will be refused. */
export function captureScope(
  meta: Meta,
  request: CaptureRequest,
): Range | null {
  const check = checkCapture(meta, request);
  return check.ok ? { start: check.start, end: check.end } : null;
}

/**
 * Takes the next round for a range: phase 1. Always succeeds on a valid live
 * range, because stealing is the point; a range straddling the trim mark is
 * clipped to start just past it. Rows the new capture covers completely can
 * never be the effective round anywhere again, so they are pruned, which keeps
 * a sticky leader's repeated batch captures at one row.
 */
export function capture(
  meta: Meta,
  request: CaptureRequest,
  view: CaptureView,
  nowMs: number,
): Outcome<CaptureResult> {
  const check = checkCapture(meta, request);
  if (!check.ok) return reject(meta, check.result);
  if (view.liveCaptures - view.dominated + 1 > LIMITS.liveCaptures) {
    return reject(
      meta,
      tooLarge(
        `the segment already holds ${view.liveCaptures} capture ranges ` +
          `(limit ${LIMITS.liveCaptures}); capture a wider range or trim`,
      ),
    );
  }
  const round = meta.nextRound;
  const range = { start: check.start, end: check.end };
  return {
    meta: { ...meta, nextRound: round + 1 },
    result: {
      ok: true,
      captureId: round,
      start: range.start,
      end: range.end,
      alreadyWritten: view.writtenInRange,
    },
    insertCapture: { round, ...range, owner: check.owner, capturedMs: nowMs },
    ...(view.dominated > 0 ? { pruneCaptures: range } : {}),
  };
}

type WriteCheck =
  | { ok: false; result: WriteResult }
  | { ok: true; start: number; values: Uint8Array[]; captureId: number };

function checkWrite(meta: Meta, request: WriteRequest): WriteCheck {
  const { start, values, captureId } = fields(request);
  if (!isCount(start) || start < 0) {
    return { ok: false, result: invalid("start must be an integer >= 0") };
  }
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, result: invalid("values must be a non-empty array") };
  }
  if (values.length > LIMITS.batchValues) {
    return {
      ok: false,
      result: tooLarge(
        `batch of ${values.length} exceeds ${LIMITS.batchValues} values`,
      ),
    };
  }
  const checked: Uint8Array[] = [];
  let batchBytes = 0;
  for (const value of values) {
    if (!(value instanceof Uint8Array)) {
      return { ok: false, result: invalid("every value must be a Uint8Array") };
    }
    if (value.byteLength > LIMITS.valueBytes) {
      return {
        ok: false,
        result: tooLarge(
          `value of ${value.byteLength} bytes exceeds ${LIMITS.valueBytes}`,
        ),
      };
    }
    batchBytes += value.byteLength;
    checked.push(value);
  }
  if (batchBytes > LIMITS.batchBytes) {
    return {
      ok: false,
      result: tooLarge(
        `batch of ${batchBytes} bytes exceeds ${LIMITS.batchBytes}`,
      ),
    };
  }
  if (!isCount(captureId) || captureId < 0) {
    return { ok: false, result: invalid("captureId must be an integer >= 0") };
  }
  if (!meta.allocated) return { ok: false, result: unallocated() };
  const end = start + checked.length;
  if (end > meta.size) {
    return {
      ok: false,
      result: outOfRange(meta, `range [${start}, ${end}) exceeds ${meta.size}`),
    };
  }
  if (start <= meta.trimmedThrough) {
    return {
      ok: false,
      result: trimmed(meta, `offset ${start} is trimmed`),
    };
  }
  if (captureId >= meta.nextRound) {
    return {
      ok: false,
      result: invalid(`captureId ${captureId} was never issued`),
    };
  }
  return { ok: true, start, values: checked, captureId };
}

/** The range a write will examine, or `null` when it will be refused unseen. */
export function writeScope(meta: Meta, request: WriteRequest): Range | null {
  const check = checkWrite(meta, request);
  return check.ok
    ? { start: check.start, end: check.start + check.values.length }
    : null;
}

/**
 * Writes a batch of registers, all or none: phase 2. Offsets are examined in
 * order and the first one that refuses decides the reply.
 *
 * A written register refuses with `ALREADY_WRITTEN`, and says whether it holds
 * exactly these bytes: that is how a writer whose reply was lost learns its
 * write landed, with no operation table. Otherwise the offset's effective
 * round must equal `captureId`; any other value means a later capture took it
 * (or, for `captureId` 0, that anybody captured it at all).
 */
export function write(
  meta: Meta,
  request: WriteRequest,
  view: WriteView,
  nowMs: number,
): Outcome<WriteResult> {
  const check = checkWrite(meta, request);
  if (!check.ok) return reject(meta, check.result);
  const { start, values, captureId } = check;
  for (const [index, value] of values.entries()) {
    const offset = start + index;
    const stored = view.existing.get(offset);
    if (stored !== undefined) {
      return reject(meta, {
        ok: false,
        code: "ALREADY_WRITTEN",
        message: `register ${offset} is already written`,
        offset,
        sameValue: sameBytes(stored, value),
      });
    }
    const round = effectiveRound(view.captures, offset);
    if (round !== captureId) {
      return reject(meta, {
        ok: false,
        code: "CAPTURE_STALE",
        message:
          `register ${offset} is held by round ${round}, not ${captureId}`,
        offset,
        round,
        captureId,
      });
    }
  }
  return {
    meta: {
      ...meta,
      writtenCount: meta.writtenCount + values.length,
      writes: meta.writes + values.length,
    },
    result: { ok: true, start, end: start + values.length },
    insertRegisters: values.map((value, index) => ({
      offset: start + index,
      round: captureId,
      value,
      writtenMs: nowMs,
    })),
  };
}

/** Validates a read and resolves it against the segment and its trim mark. */
export function planRead(meta: Meta, request: ReadRequest): ReadPlan {
  const { start, count, maxBytes } = fields(request);
  if (!isCount(start) || start < 0) {
    return { kind: "reply", result: invalid("start must be an integer >= 0") };
  }
  if (
    count !== undefined &&
    (!isCount(count) || count < 1 || count > LIMITS.readCount)
  ) {
    return {
      kind: "reply",
      result: invalid(`count must be an integer in [1, ${LIMITS.readCount}]`),
    };
  }
  if (
    maxBytes !== undefined &&
    (!isCount(maxBytes) || maxBytes < 1 || maxBytes > LIMITS.readBytes)
  ) {
    return {
      kind: "reply",
      result: invalid(
        `maxBytes must be an integer in [1, ${LIMITS.readBytes}]`,
      ),
    };
  }
  if (!meta.allocated) return { kind: "reply", result: unallocated() };
  if (start >= meta.size) {
    return {
      kind: "reply",
      result: outOfRange(meta, `offset ${start} is past size ${meta.size}`),
    };
  }
  if (start <= meta.trimmedThrough) {
    return {
      kind: "reply",
      result: trimmed(meta, `offset ${start} is trimmed`),
    };
  }
  return {
    kind: "scan",
    start,
    end: Math.min(start + (count ?? LIMITS.defaultReadCount), meta.size),
    maxBytes: maxBytes ?? LIMITS.defaultReadBytes,
  };
}

/**
 * Applies the byte budget to the sizes of the written registers in a scan and
 * returns where the window ends, so only those values are ever loaded. Holes
 * cost nothing. The budget is advisory in one direction only: the first
 * register is always included, so a reader can never stall on a large value.
 */
export function readWindow(
  plan: { start: number; end: number; maxBytes: number },
  sizes: readonly { offset: number; bytes: number }[],
): number {
  let total = 0;
  for (const { offset, bytes } of sizes) {
    total += bytes;
    if (total > plan.maxBytes && offset > plan.start) return offset;
  }
  return plan.end;
}

/**
 * Reports every register in `[start, end)`: written ones with their value and
 * writing round, the rest with their effective round. Holes are never skipped.
 */
export function finishRead(
  meta: Meta,
  window: Range,
  rows: readonly RegisterRow[],
  captures: readonly CaptureRow[],
): ReadResult {
  const written = new Map(rows.map((row) => [row.offset, row]));
  const registers: Register[] = [];
  for (let offset = window.start; offset < window.end; offset += 1) {
    const row = written.get(offset);
    if (row !== undefined) {
      registers.push({
        offset,
        state: "written",
        round: row.round,
        value: row.value,
      });
      continue;
    }
    const round = effectiveRound(captures, offset);
    registers.push({
      offset,
      state: round === 0 ? "unwritten" : "captured",
      round,
    });
  }
  return {
    ok: true,
    registers,
    size: meta.size,
    trimmedThrough: meta.trimmedThrough,
  };
}

type TrimCheck =
  | { ok: false; result: TrimResult }
  | { ok: true; through: number; moves: boolean };

function checkTrim(meta: Meta, request: TrimRequest): TrimCheck {
  const { through } = fields(request);
  if (!isCount(through) || through < 0) {
    return { ok: false, result: invalid("through must be an integer >= 0") };
  }
  if (!meta.allocated) return { ok: false, result: unallocated() };
  if (through > meta.size - 1) {
    return {
      ok: false,
      result: outOfRange(meta, `through ${through} is past ${meta.size - 1}`),
    };
  }
  return { ok: true, through, moves: through > meta.trimmedThrough };
}

/** The mark a trim will delete through, or `null` when it will delete nothing. */
export function trimScope(meta: Meta, request: TrimRequest): number | null {
  const check = checkTrim(meta, request);
  return check.ok && check.moves ? check.through : null;
}

/**
 * Deletes every register and capture at or below `through`. Monotone and
 * idempotent: a mark at or below the current one changes nothing and reports
 * the current mark.
 */
export function trim(
  meta: Meta,
  request: TrimRequest,
  view: TrimView,
): Outcome<TrimResult> {
  const check = checkTrim(meta, request);
  if (!check.ok) return reject(meta, check.result);
  if (!check.moves) {
    return reject(meta, {
      ok: true,
      trimmedThrough: meta.trimmedThrough,
      deleted: 0,
    });
  }
  return {
    meta: {
      ...meta,
      trimmedThrough: check.through,
      writtenCount: meta.writtenCount - view.writtenThrough,
    },
    result: {
      ok: true,
      trimmedThrough: check.through,
      deleted: view.writtenThrough,
    },
    deleteThrough: check.through,
  };
}

/**
 * Validates a `listen` and decides whether it can answer at once. Waiting is
 * the caller's business: this only says for how long, and on what.
 *
 * A `since` above the counter is not an error. A client can have seen a
 * value from a write that committed on an owner which then failed to prove
 * it durable, so the counter it returns to is lower; that caller simply
 * waits for the next write, and a timeout hands it the current value.
 */
export function planListen(meta: Meta, request: ListenRequest): ListenPlan {
  const { since, timeoutMs } = fields(request);
  if (!isCount(since) || since < 0) {
    return { kind: "reply", result: invalid("since must be an integer >= 0") };
  }
  if (
    timeoutMs !== undefined &&
    (!isCount(timeoutMs) || timeoutMs < 0 ||
      timeoutMs > LIMITS.listenTimeoutMs)
  ) {
    return {
      kind: "reply",
      result: invalid(
        `timeoutMs must be an integer in [0, ${LIMITS.listenTimeoutMs}]`,
      ),
    };
  }
  if (!meta.allocated) return { kind: "reply", result: unallocated() };
  if (meta.writes > since) {
    return {
      kind: "reply",
      result: { ok: true, writes: meta.writes, changed: true },
    };
  }
  return {
    kind: "wait",
    since,
    timeoutMs: timeoutMs ?? LIMITS.defaultListenTimeoutMs,
  };
}

/** The answer a parked `listen` gets, from the counter it wakes up to. */
export function listenReply(meta: Meta, since: number): ListenResult {
  return { ok: true, writes: meta.writes, changed: meta.writes > since };
}
