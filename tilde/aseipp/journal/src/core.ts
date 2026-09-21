// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Every decision the journal makes, as pure transitions over one meta row.
 *
 * The fencing and trim rules are the parts worth testing exhaustively, and a
 * Deno test cannot import `cloudflare:workers`, so the decisions live here and
 * the Durable Object only persists what they emit. Records are never *read* by
 * a decision, only produced or deleted, so `Outcome` describes the whole write
 * set and a test can model storage with a fifteen-line reducer.
 *
 * Invariants maintained by every transition:
 *
 *   0 <= trimmedThrough <= snapshotThrough <= head - 1
 *   records exist exactly for seq in (trimmedThrough, head)
 *   leader === null  iff  leaseDeadlineMs === 0
 *   term never decreases, and at most one leader ever holds a given term
 *
 * @module
 */

import {
  type AcquireLeaseRequest,
  type AcquireLeaseResult,
  type AppendRequest,
  type AppendResult,
  type Invalid,
  type JournalRecord,
  LIMITS,
  type ReadRequest,
  type ReadResult,
  type RecordSnapshotRequest,
  type RecordSnapshotResult,
  type ReleaseLeaseRequest,
  type ReleaseLeaseResult,
  type RenewLeaseRequest,
  type RenewLeaseResult,
  type SnapshotMark,
  type StatusResult,
  type TooLarge,
  type TrimRequest,
  type TrimResult,
} from "./types.ts";

/** The single durable row every decision reads and rewrites. */
export interface Meta {
  /** The sequence the next append receives; sequences start at 1. */
  head: number;
  term: number;
  leader: string | null;
  leaseDeadlineMs: number;
  trimmedThrough: number;
  snapshotThrough: number;
  snapshotRef: string | null;
}

/** The state of a journal that has never been written. */
export const INITIAL_META: Meta = {
  head: 1,
  term: 0,
  leader: null,
  leaseDeadlineMs: 0,
  trimmedThrough: 0,
  snapshotThrough: 0,
  snapshotRef: null,
};

/** A record a transition wants persisted. */
export interface NewRecord {
  seq: number;
  term: number;
  payload: Uint8Array;
  appendedMs: number;
}

/**
 * A decision and the write set that realizes it. `meta === input` means the
 * decision changed nothing: the Durable Object uses that identity to skip both
 * the update and the durability barrier, so a rejected request never syncs.
 */
export interface Outcome<R> {
  meta: Meta;
  result: R;
  insert?: NewRecord[];
  deleteThrough?: number;
}

/** The scan a `read` needs, or the reply it already has. */
export type ReadPlan =
  | { kind: "reply"; result: ReadResult }
  | { kind: "scan"; from: number; limit: number; maxBytes: number };

/** Requests arrive over RPC from arbitrary JavaScript, so nothing is assumed. */
function fields(request: unknown): Record<string, unknown> {
  return (typeof request === "object" && request !== null
    ? request
    : {}) as Record<string, unknown>;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= LIMITS.tokenChars;
}

function isTtl(value: unknown): value is number {
  return isCount(value) && value >= LIMITS.minTtlMs && value <= LIMITS.maxTtlMs;
}

function invalid(message: string): Invalid {
  return { ok: false, code: "INVALID", message };
}

function tooLarge(message: string): TooLarge {
  return { ok: false, code: "TOO_LARGE", message };
}

/** Keeps `meta` identical so the caller can tell that nothing was decided. */
function reject<R>(meta: Meta, result: R): Outcome<R> {
  return { meta, result };
}

/** A journal with no snapshot reports `null` rather than a zero-valued mark. */
export function snapshotMark(meta: Meta): SnapshotMark | null {
  if (meta.snapshotThrough === 0 || meta.snapshotRef === null) return null;
  return { throughSeq: meta.snapshotThrough, ref: meta.snapshotRef };
}

/**
 * Grants the lease to a free journal, to its current holder (a renew, which
 * keeps the term), or to anyone once the holder's deadline has passed (a
 * takeover, which bumps the term).
 */
export function acquireLease(
  meta: Meta,
  request: AcquireLeaseRequest,
  nowMs: number,
): Outcome<AcquireLeaseResult> {
  const { candidate, ttlMs } = fields(request);
  if (!isToken(candidate)) {
    return reject(meta, invalid("candidate must be a 1..128 character string"));
  }
  if (!isTtl(ttlMs)) {
    return reject(
      meta,
      invalid(
        `ttlMs must be an integer in [${LIMITS.minTtlMs}, ${LIMITS.maxTtlMs}]`,
      ),
    );
  }
  const free = meta.leader === null || meta.leaseDeadlineMs <= nowMs;
  if (!free && meta.leader !== candidate) {
    return reject(meta, {
      ok: false,
      code: "LEASE_HELD",
      term: meta.term,
      deadlineMs: meta.leaseDeadlineMs,
      nowMs,
    });
  }
  const term = meta.leader === candidate ? meta.term : meta.term + 1;
  const deadlineMs = nowMs + ttlMs;
  return {
    meta: { ...meta, term, leader: candidate, leaseDeadlineMs: deadlineMs },
    result: { ok: true, term, deadlineMs, nowMs },
  };
}

/**
 * Extends the lease of whoever still holds the token. An expired deadline is
 * not itself a rejection: only a takeover, which replaces the token, is.
 */
export function renewLease(
  meta: Meta,
  request: RenewLeaseRequest,
  nowMs: number,
): Outcome<RenewLeaseResult> {
  const { leader, ttlMs } = fields(request);
  if (!isToken(leader)) {
    return reject(meta, invalid("leader must be a 1..128 character string"));
  }
  if (!isTtl(ttlMs)) {
    return reject(
      meta,
      invalid(
        `ttlMs must be an integer in [${LIMITS.minTtlMs}, ${LIMITS.maxTtlMs}]`,
      ),
    );
  }
  if (meta.leader === null || meta.leader !== leader) {
    return reject(meta, { ok: false, code: "NOT_LEADER", term: meta.term });
  }
  const deadlineMs = nowMs + ttlMs;
  return {
    meta: { ...meta, leaseDeadlineMs: deadlineMs },
    result: { ok: true, term: meta.term, deadlineMs, nowMs },
  };
}

/** Hands the journal back, letting the next candidate take it immediately. */
export function releaseLease(
  meta: Meta,
  request: ReleaseLeaseRequest,
): Outcome<ReleaseLeaseResult> {
  const { leader } = fields(request);
  if (!isToken(leader)) {
    return reject(meta, invalid("leader must be a 1..128 character string"));
  }
  if (meta.leader === null || meta.leader !== leader) {
    return reject(meta, { ok: false, code: "NOT_LEADER", term: meta.term });
  }
  return {
    meta: { ...meta, leader: null, leaseDeadlineMs: 0 },
    result: { ok: true, term: meta.term },
  };
}

/**
 * Appends a batch under the caller's fencing token.
 *
 * The deadline is deliberately not consulted. A leader can be paused between
 * checking its own lease and reaching the journal, so a deadline test here
 * would make correctness depend on clock quality without buying any safety:
 * the token comparison, serialized inside the single-owner cell against every
 * `acquireLease`, is what makes two writers impossible. A sole leader whose
 * lease lapsed with no takeover may therefore keep appending, and is fenced
 * the instant someone else acquires.
 */
export function append(
  meta: Meta,
  request: AppendRequest,
  nowMs: number,
): Outcome<AppendResult> {
  const { leader, records, expectedNextSeq } = fields(request);
  if (!isToken(leader)) {
    return reject(meta, invalid("leader must be a 1..128 character string"));
  }
  if (!Array.isArray(records) || records.length === 0) {
    return reject(meta, invalid("records must be a non-empty array"));
  }
  if (records.length > LIMITS.batchRecords) {
    return reject(
      meta,
      tooLarge(
        `batch of ${records.length} exceeds ${LIMITS.batchRecords} records`,
      ),
    );
  }
  const payloads: Uint8Array[] = [];
  let batchBytes = 0;
  for (const payload of records) {
    if (!(payload instanceof Uint8Array)) {
      return reject(meta, invalid("every record must be a Uint8Array"));
    }
    if (payload.byteLength > LIMITS.recordBytes) {
      return reject(
        meta,
        tooLarge(
          `record of ${payload.byteLength} bytes exceeds ${LIMITS.recordBytes}`,
        ),
      );
    }
    batchBytes += payload.byteLength;
    payloads.push(payload);
  }
  if (batchBytes > LIMITS.batchBytes) {
    return reject(
      meta,
      tooLarge(`batch of ${batchBytes} bytes exceeds ${LIMITS.batchBytes}`),
    );
  }
  if (
    expectedNextSeq !== undefined &&
    (!isCount(expectedNextSeq) || expectedNextSeq < 1)
  ) {
    return reject(meta, invalid("expectedNextSeq must be an integer >= 1"));
  }
  if (meta.leader === null || meta.leader !== leader) {
    return reject(meta, { ok: false, code: "NOT_LEADER", term: meta.term });
  }
  if (expectedNextSeq !== undefined && expectedNextSeq !== meta.head) {
    return reject(meta, {
      ok: false,
      code: "SEQ_MISMATCH",
      head: meta.head,
      term: meta.term,
    });
  }
  const insert = payloads.map((payload, index) => ({
    seq: meta.head + index,
    term: meta.term,
    payload,
    appendedMs: nowMs,
  }));
  return {
    meta: { ...meta, head: meta.head + payloads.length },
    result: {
      ok: true,
      firstSeq: meta.head,
      lastSeq: meta.head + payloads.length - 1,
      term: meta.term,
    },
    insert,
  };
}

/** Validates a read and resolves it against the trimmed prefix. */
export function planRead(meta: Meta, request: ReadRequest): ReadPlan {
  const { from, limit, maxBytes } = fields(request);
  if (!isCount(from) || from < 1) {
    return { kind: "reply", result: invalid("from must be an integer >= 1") };
  }
  if (
    limit !== undefined &&
    (!isCount(limit) || limit < 1 || limit > LIMITS.readLimit)
  ) {
    return {
      kind: "reply",
      result: invalid(`limit must be an integer in [1, ${LIMITS.readLimit}]`),
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
  if (from > meta.head) {
    return {
      kind: "reply",
      result: invalid(`from ${from} is past head ${meta.head}`),
    };
  }
  if (from <= meta.trimmedThrough) {
    return {
      kind: "reply",
      result: {
        ok: false,
        code: "TRIMMED",
        trimmedThrough: meta.trimmedThrough,
        snapshot: snapshotMark(meta),
      },
    };
  }
  return {
    kind: "scan",
    from,
    limit: limit ?? LIMITS.defaultReadLimit,
    maxBytes: maxBytes ?? LIMITS.defaultReadBytes,
  };
}

/**
 * Applies the byte budget to a scan's rows. The budget is advisory in one
 * direction only: a single record larger than it is still returned, so a
 * reader with a small budget can never stall on an oversized record.
 */
export function finishRead(
  meta: Meta,
  rows: JournalRecord[],
  maxBytes: number,
): ReadResult {
  const records: JournalRecord[] = [];
  let total = 0;
  for (const row of rows) {
    total += row.payload.byteLength;
    if (records.length > 0 && total > maxBytes) break;
    records.push(row);
  }
  return {
    ok: true,
    records,
    head: meta.head,
    trimmedThrough: meta.trimmedThrough,
    snapshot: snapshotMark(meta),
  };
}

/** Operator view; the only reply that discloses the live leader token. */
export function status(
  meta: Meta,
  nowMs: number,
  databaseSize: number,
): StatusResult {
  return {
    ok: true,
    head: meta.head,
    term: meta.term,
    leader: meta.leader,
    deadlineMs: meta.leaseDeadlineMs,
    nowMs,
    trimmedThrough: meta.trimmedThrough,
    snapshot: snapshotMark(meta),
    databaseSize,
  };
}

/**
 * Marks a durable off-box copy of the prefix through `throughSeq`.
 *
 * Unfenced by design: the prefix is immutable, so any snapshot of it is valid
 * no matter who took it, and a snapshotter should not need the write lease.
 */
export function recordSnapshot(
  meta: Meta,
  request: RecordSnapshotRequest,
): Outcome<RecordSnapshotResult> {
  const { throughSeq, ref } = fields(request);
  if (!isCount(throughSeq) || throughSeq < 1 || throughSeq > meta.head - 1) {
    return reject(
      meta,
      invalid(`throughSeq must be an integer in [1, ${meta.head - 1}]`),
    );
  }
  if (!isToken(ref)) {
    return reject(meta, invalid("ref must be a 1..128 character string"));
  }
  if (throughSeq < meta.snapshotThrough) {
    return reject(meta, {
      ok: false,
      code: "SNAPSHOT_STALE",
      snapshot: snapshotMark(meta),
    });
  }
  const result = { ok: true, snapshot: { throughSeq, ref } } as const;
  if (throughSeq === meta.snapshotThrough && ref === meta.snapshotRef) {
    return reject(meta, result);
  }
  return {
    meta: { ...meta, snapshotThrough: throughSeq, snapshotRef: ref },
    result,
  };
}

/**
 * Deletes the prefix through `throughSeq`, never past the snapshot mark: the
 * mark is the proof that the bytes still exist somewhere a reader can get them.
 */
export function trim(meta: Meta, request: TrimRequest): Outcome<TrimResult> {
  const { throughSeq } = fields(request);
  if (!isCount(throughSeq) || throughSeq < 1) {
    return reject(meta, invalid("throughSeq must be an integer >= 1"));
  }
  if (throughSeq > meta.snapshotThrough) {
    return reject(meta, {
      ok: false,
      code: "SNAPSHOT_STALE",
      snapshot: snapshotMark(meta),
    });
  }
  if (throughSeq <= meta.trimmedThrough) {
    return reject(meta, { ok: true, trimmedThrough: meta.trimmedThrough });
  }
  return {
    meta: { ...meta, trimmedThrough: throughSeq },
    result: { ok: true, trimmedThrough: throughSeq },
    deleteThrough: throughSeq,
  };
}
