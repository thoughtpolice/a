// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The segment's wire contract: limits, requests, and result unions.
 *
 * A segment is WormSpace's write-once segment (WOS): `size` write-once
 * registers at offsets `0..size-1`, each forever unwritten, captured by a
 * round, or written. Every operation answers with a discriminated union rather
 * than throwing. A thrown error loses its class identity and its own
 * properties across celld's RPC boundary (see the toolchain's
 * `tests/rpc_runtime.js` error scenarios), so domain outcomes that a caller
 * must branch on are values.
 *
 * @module
 */

/** Bounds checked on both edges; the HTTP layer adds only the body cap. */
export const LIMITS = {
  /** Largest segment, in registers. */
  maxSize: 65_536,
  /** Largest `alloc` metadata payload. */
  metadataBytes: 64 * 1024,
  /** Character bound on allocator and capture owner names. */
  nameChars: 128,
  /** Largest single register value. */
  valueBytes: 1024 * 1024,
  /** Largest total payload in one write. */
  batchBytes: 4 * 1024 * 1024,
  /** Most registers in one write. */
  batchValues: 1000,
  /** Largest accepted `read` count, and the default when none is given. */
  readCount: 1000,
  defaultReadCount: 100,
  /** Largest accepted `read` byte budget, and the default when none is given. */
  readBytes: 4 * 1024 * 1024,
  defaultReadBytes: 1024 * 1024,
  /**
   * Most capture rows a segment keeps. Every effective-round lookup scans the
   * rows overlapping its range, so this bounds that scan; a capture prunes the
   * rows it dominates and a trim the rows below its mark.
   */
  liveCaptures: 4096,
  /** Largest accepted HTTP request body. */
  bodyBytes: 8 * 1024 * 1024,
  /**
   * Longest a `listen` may park, and how long it parks when the caller does
   * not say. Bounded so a parked request never outlives celld's operation
   * deadlines.
   */
  listenTimeoutMs: 25_000,
  defaultListenTimeoutMs: 10_000,
} as const;

/** Segment names become cell names and URL components, so they stay conservative. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** Machine-readable outcome of a rejected operation. */
export type ErrorCode =
  | "INVALID"
  | "TOO_LARGE"
  | "UNALLOCATED"
  | "ALREADY_ALLOCATED"
  | "OUT_OF_RANGE"
  | "ALREADY_WRITTEN"
  | "CAPTURE_STALE"
  | "TRIMMED";

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

/** The segment has not been allocated, so it has no registers yet. */
export interface Unallocated {
  ok: false;
  code: "UNALLOCATED";
  message: string;
}

/**
 * Someone already allocated the segment: the paper's `check`. The reply is the
 * winning allocation, so a losing candidate learns who won and what they said.
 */
export interface AlreadyAllocated {
  ok: false;
  code: "ALREADY_ALLOCATED";
  message: string;
  size: number;
  metadata: Uint8Array;
  allocator: string | null;
  allocatedMs: number;
}

/** An offset or range outside `0..size-1`. */
export interface OutOfRange {
  ok: false;
  code: "OUT_OF_RANGE";
  size: number;
  message: string;
}

/**
 * The register at `offset` is already written. `sameValue` compares the stored
 * bytes with the ones this write carried: `true` after a replay means the
 * original write landed.
 */
export interface AlreadyWritten {
  ok: false;
  code: "ALREADY_WRITTEN";
  message: string;
  offset: number;
  sameValue: boolean;
}

/**
 * The register at `offset` is not held by `captureId`: its effective round is
 * `round`, which a later capture took (or, for `captureId` 0, any capture).
 */
export interface CaptureStale {
  ok: false;
  code: "CAPTURE_STALE";
  message: string;
  offset: number;
  round: number;
  captureId: number;
}

/** The position is at or below the trim mark and no longer exists. */
export interface Trimmed {
  ok: false;
  code: "TRIMMED";
  message: string;
  trimmedThrough: number;
}

/** A granted allocation. */
export interface AllocOk {
  ok: true;
  size: number;
  allocatedMs: number;
}

/**
 * A capture: `captureId` is the round, the range is the effective one (clipped
 * past the trim mark), and `alreadyWritten` counts registers in it that are
 * already immutable, which the capture cannot affect.
 */
export interface CaptureOk {
  ok: true;
  captureId: number;
  start: number;
  end: number;
  alreadyWritten: number;
}

/** The half-open range of registers the write filled. */
export interface WriteOk {
  ok: true;
  start: number;
  end: number;
}

/** What one register is now. `round` is 0 for a register nobody captured. */
export type RegisterState = "unwritten" | "captured" | "written";

/**
 * One register as a reader sees it. A written register's `round` is the round
 * that wrote it (0 for an unsafe write); otherwise it is the effective round.
 */
export interface Register {
  offset: number;
  state: RegisterState;
  round: number;
  value?: Uint8Array;
}

/** A contiguous window of registers, holes included. */
export interface ReadOk {
  ok: true;
  registers: Register[];
  size: number;
  trimmedThrough: number;
}

/** The trim mark now in force and how many written registers this call removed. */
export interface TrimOk {
  ok: true;
  trimmedThrough: number;
  deleted: number;
}

/**
 * Operator view of one segment. `trimmedThrough` is -1 until the first trim.
 * `writes` counts every register ever written, trimmed or not: it only grows,
 * which is what `listen` waits on.
 */
export interface StatusOk {
  ok: true;
  allocated: boolean;
  size: number;
  metadata: Uint8Array | null;
  allocator: string | null;
  allocatedMs: number;
  nextRound: number;
  writtenCount: number;
  writes: number;
  captures: number;
  trimmedThrough: number;
  databaseSize: number;
}

/**
 * A `listen` answer: the segment's `writes` counter, and whether it is past
 * the caller's `since`. `changed: false` means the wait timed out.
 */
export interface ListenOk {
  ok: true;
  writes: number;
  changed: boolean;
}

export interface AllocRequest {
  size: number;
  metadata: Uint8Array;
  allocator?: string;
}

export interface CaptureRequest {
  start: number;
  /** Exclusive; defaults to `start + 1`. */
  end?: number;
  owner?: string;
}

export interface WriteRequest {
  start: number;
  values: Uint8Array[];
  /** The round from `capture`, or 0 for the paper's unsafe write. */
  captureId: number;
}

export interface ReadRequest {
  start: number;
  count?: number;
  maxBytes?: number;
}

export interface TrimRequest {
  through: number;
}

export interface ListenRequest {
  /** The `writes` value the caller last saw; 0 before it has seen any. */
  since: number;
  /** How long to park, in `[0, LIMITS.listenTimeoutMs]`. */
  timeoutMs?: number;
}

export type AllocResult = AllocOk | AlreadyAllocated | Invalid | TooLarge;
export type StatusResult = StatusOk;
export type CaptureResult =
  | CaptureOk
  | Unallocated
  | OutOfRange
  | Trimmed
  | Invalid
  | TooLarge;
export type WriteResult =
  | WriteOk
  | AlreadyWritten
  | CaptureStale
  | Unallocated
  | OutOfRange
  | Trimmed
  | Invalid
  | TooLarge;
export type ReadResult = ReadOk | Unallocated | OutOfRange | Trimmed | Invalid;
export type TrimResult = TrimOk | Unallocated | OutOfRange | Invalid;
export type ListenResult = ListenOk | Unallocated | Invalid;

/** Every result the HTTP edge may have to encode and map to a status. */
export type AnyResult =
  | AllocResult
  | StatusResult
  | CaptureResult
  | WriteResult
  | ReadResult
  | TrimResult
  | ListenResult;

/**
 * The Durable Object's remote surface. Declaring it separately from the class
 * keeps the typed stub (`DurableObjectNamespace<SegmentAPI>`) to the intended
 * methods; it is documentation and type checking, not access control.
 */
export interface SegmentAPI {
  alloc(request: AllocRequest): Promise<AllocResult>;
  status(): Promise<StatusResult>;
  capture(request: CaptureRequest): Promise<CaptureResult>;
  write(request: WriteRequest): Promise<WriteResult>;
  read(request: ReadRequest): Promise<ReadResult>;
  trim(request: TrimRequest): Promise<TrimResult>;
  listen(request: ListenRequest): Promise<ListenResult>;
}
