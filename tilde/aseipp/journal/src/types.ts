// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The journal's wire contract: limits, requests, and result unions.
 *
 * Every operation answers with a discriminated union rather than throwing.
 * A thrown error loses its class identity and its own properties across
 * celld's RPC boundary (see the toolchain's `tests/rpc_runtime.js` error
 * scenarios), so domain outcomes that a caller must branch on are values.
 *
 * Conflict replies never echo the current leader token: holding that token is
 * the capability to write, and a loser of an election must not learn it.
 * Only `status()` reports it, for operators.
 *
 * @module
 */

/** Bounds checked on both edges; the HTTP layer adds only the body cap. */
export const LIMITS = {
  /** Largest single record payload. */
  recordBytes: 1024 * 1024,
  /** Largest total payload in one append. */
  batchBytes: 4 * 1024 * 1024,
  /** Most records in one append. */
  batchRecords: 1000,
  /** Largest accepted `read` limit, and the default when none is given. */
  readLimit: 1000,
  defaultReadLimit: 100,
  /** Largest accepted `read` byte budget, and the default when none is given. */
  readBytes: 4 * 1024 * 1024,
  defaultReadBytes: 1024 * 1024,
  /** Lease duration bounds. A lease is a liveness aid, never a safety one. */
  minTtlMs: 1_000,
  maxTtlMs: 300_000,
  /** Character bound on leader/candidate tokens and snapshot references. */
  tokenChars: 128,
  /** Largest accepted HTTP request body. */
  bodyBytes: 8 * 1024 * 1024,
} as const;

/** Log names become cell names and URL components, so they stay conservative. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** Machine-readable outcome of a rejected operation. */
export type ErrorCode =
  | "INVALID"
  | "TOO_LARGE"
  | "LEASE_HELD"
  | "NOT_LEADER"
  | "SEQ_MISMATCH"
  | "TRIMMED"
  | "SNAPSHOT_STALE";

/** A malformed request: shape, type, or a value outside its allowed range. */
export interface Invalid {
  ok: false;
  code: "INVALID";
  message: string;
}

/** A well-formed request whose payload exceeds a size or count bound. */
export interface TooLarge {
  ok: false;
  code: "TOO_LARGE";
  message: string;
}

/** Another candidate holds an unexpired lease. */
export interface LeaseHeld {
  ok: false;
  code: "LEASE_HELD";
  term: number;
  deadlineMs: number;
  nowMs: number;
}

/** The supplied token is not the journal's current leader. */
export interface NotLeader {
  ok: false;
  code: "NOT_LEADER";
  term: number;
}

/** `expectedNextSeq` did not match; `head` and `term` decide the retry. */
export interface SeqMismatch {
  ok: false;
  code: "SEQ_MISMATCH";
  head: number;
  term: number;
}

/** The requested position was deleted; resume from the snapshot instead. */
export interface Trimmed {
  ok: false;
  code: "TRIMMED";
  trimmedThrough: number;
  snapshot: SnapshotMark | null;
}

/** The snapshot mark already covers a later prefix than this request. */
export interface SnapshotStale {
  ok: false;
  code: "SNAPSHOT_STALE";
  snapshot: SnapshotMark | null;
}

/** An off-box snapshot covering the prefix through `throughSeq`. */
export interface SnapshotMark {
  throughSeq: number;
  ref: string;
}

/**
 * A granted or extended lease. `nowMs` is the journal's clock at decision
 * time: a client subtracts it from `deadlineMs` to get a relative remaining
 * duration and applies that to its own monotonic clock, so clock skew between
 * the client and the journal never affects the client's own liveness math.
 */
export interface LeaseOk {
  ok: true;
  term: number;
  deadlineMs: number;
  nowMs: number;
}

/** A released lease; the term is the one that just ended. */
export interface ReleaseOk {
  ok: true;
  term: number;
}

/** The inclusive sequence range the batch received, under `term`. */
export interface AppendOk {
  ok: true;
  firstSeq: number;
  lastSeq: number;
  term: number;
}

/** One durable record. `term` is the leadership term that appended it. */
export interface JournalRecord {
  seq: number;
  term: number;
  payload: Uint8Array;
}

/** A window of the stream plus the cursor context a reader needs. */
export interface ReadOk {
  ok: true;
  records: JournalRecord[];
  head: number;
  trimmedThrough: number;
  snapshot: SnapshotMark | null;
}

/** Operator view of one journal, including the live leader token. */
export interface StatusOk {
  ok: true;
  head: number;
  term: number;
  leader: string | null;
  deadlineMs: number;
  nowMs: number;
  trimmedThrough: number;
  snapshot: SnapshotMark | null;
  databaseSize: number;
}

/** The snapshot mark now recorded. */
export interface SnapshotOk {
  ok: true;
  snapshot: SnapshotMark;
}

/** The highest sequence now deleted from the journal. */
export interface TrimOk {
  ok: true;
  trimmedThrough: number;
}

export interface AcquireLeaseRequest {
  candidate: string;
  ttlMs: number;
  /**
   * The registers per segment link, a tuning knob fixed at first use: it is
   * honoured only while the journal has no links yet, and ignored after. An
   * integer in [8, 65536]; the default is 4096, and anything below 1000 (the
   * largest batch) makes a batch larger than a link `TOO_LARGE`, so sizes
   * that small are for tests that want to cross links cheaply.
   */
  linkSize?: number;
}

export interface RenewLeaseRequest {
  leader: string;
  ttlMs: number;
}

export interface ReleaseLeaseRequest {
  leader: string;
}

export interface AppendRequest {
  leader: string;
  records: Uint8Array[];
  /**
   * The post's `last_seq` conditional, and the retry contract: replay an
   * ambiguous append with the same value. `SEQ_MISMATCH` with an unchanged
   * `term` and `head === expectedNextSeq + records.length` means the original
   * attempt landed, because no one else can write under that term.
   */
  expectedNextSeq?: number;
}

export interface ReadRequest {
  from: number;
  limit?: number;
  maxBytes?: number;
}

export interface RecordSnapshotRequest {
  throughSeq: number;
  ref: string;
}

export interface TrimRequest {
  throughSeq: number;
}

export type AcquireLeaseResult = LeaseOk | LeaseHeld | Invalid;
export type RenewLeaseResult = LeaseOk | NotLeader | Invalid;
export type ReleaseLeaseResult = ReleaseOk | NotLeader | Invalid;
export type AppendResult =
  | AppendOk
  | NotLeader
  | SeqMismatch
  | Invalid
  | TooLarge;
export type ReadResult = ReadOk | Trimmed | Invalid;
export type StatusResult = StatusOk;
export type RecordSnapshotResult = SnapshotOk | SnapshotStale | Invalid;
export type TrimResult = TrimOk | SnapshotStale | Invalid;

/** Every result the HTTP edge may have to encode and map to a status. */
export type AnyResult =
  | AcquireLeaseResult
  | RenewLeaseResult
  | ReleaseLeaseResult
  | AppendResult
  | ReadResult
  | StatusResult
  | RecordSnapshotResult
  | TrimResult;

/**
 * The Durable Object's remote surface. Declaring it separately from the class
 * keeps the typed stub (`DurableObjectNamespace<JournalAPI>`) to the intended
 * methods; it is documentation and type checking, not access control.
 */
export interface JournalAPI {
  acquireLease(request: AcquireLeaseRequest): Promise<AcquireLeaseResult>;
  renewLease(request: RenewLeaseRequest): Promise<RenewLeaseResult>;
  releaseLease(request: ReleaseLeaseRequest): Promise<ReleaseLeaseResult>;
  append(request: AppendRequest): Promise<AppendResult>;
  read(request: ReadRequest): Promise<ReadResult>;
  status(): Promise<StatusResult>;
  recordSnapshot(request: RecordSnapshotRequest): Promise<RecordSnapshotResult>;
  trim(request: TrimRequest): Promise<TrimResult>;
}
