// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The journal as a coordinator over write-once segments, independent of
 * celld: logic over a store interface and a segment resolver.
 *
 * `core.ts` still makes every decision. This module feeds it a `Meta` whose
 * `head` comes from memory, and realises what it decides on segments: an
 * `append`'s records become one segment write, a `trim`'s deletion becomes
 * segment trims, and everything else is the store's small state row. The
 * records themselves live only in the chain of links `links.ts` describes;
 * the store keeps the lease, the marks, the link size, and the link table.
 *
 * **Head is a cache.** Nothing on the append path writes the store, because a
 * store commit costs the journal cell a durability barrier and the append
 * must pay only for its segment write. So `head` lives in the instance and is
 * recovered on the first call after construction, and after any failure:
 * recapture the last link (which fences every write a previous owner of this
 * cell may still have in flight), then read the link's durable `writes`
 * counter with a zero-timeout `listen`. The journal writes each link
 * contiguously from offset 0, so `head = firstSeq + writes`.
 *
 * **Everything below head is durable.** Head moves only past a write the
 * segment acknowledged (acknowledged means durable), past registers a replay
 * found with `sameValue` (answered after a barrier), or to a counter a
 * `listen` answered (also after a barrier). A read never reaches past head,
 * so, unlike the wormspace layers, it needs no `listen` after a window.
 *
 * **Appends.** The core decides against the cached head; the batch is placed
 * (`links.place`), opening a link first when it does not fit or the term
 * changed; then one segment write lands it, all or nothing. A replay of that
 * write after a transient throw that finds its own bytes proves the write
 * landed. `ALREADY_WRITTEN` otherwise means the cache was stale: head is
 * recovered and the same request decided again from the top, so a client
 * replaying a lost append gets exactly the `SEQ_MISMATCH` the retry contract
 * promises. `CAPTURE_STALE` means somebody captured the link over the
 * journal: it recaptures once, persists the round, and writes again; a
 * second steal in the same call is thrown as unavailable.
 *
 * **Failures.** Segment calls celld says are safe to repeat are repeated a
 * bounded number of times (`retryTransient`). Past that, and for a second
 * steal, the call throws an error whose message starts with
 * `UNAVAILABLE_PREFIX`, which the HTTP edge answers with 503. Any throw drops
 * the cached head, so the next call recovers it. A segment answer that can
 * only mean a bug is thrown as a plain error.
 *
 * Every method runs on one promise chain per instance (`Serial`): an append
 * reads the store, calls segments, and writes the store back, and two calls
 * must never interleave at an `await`.
 *
 * @module
 */

import {
  DEFAULT_RETRY,
  type RetryPolicy,
  retryTransient,
  Serial,
} from "@wormspace/segment/serial";
import type {
  CaptureResult,
  SegmentAPI,
  WriteResult,
} from "@wormspace/segment/types";
import * as core from "./core.ts";
import { type Meta, type Outcome } from "./core.ts";
import { retryableCause, UNAVAILABLE_PREFIX } from "./http.ts";
import {
  capacity,
  checkLinkSize,
  decodeLinkMetadata,
  encodeLinkMetadata,
  type Link,
  LINK_LIMITS,
  linkName,
  place,
  sameLink,
  trimPlan,
} from "./links.ts";
import type {
  AcquireLeaseRequest,
  AcquireLeaseResult,
  AppendRequest,
  AppendResult,
  JournalAPI,
  JournalRecord,
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
} from "./types.ts";

/** A segment by name: `env.SEGMENTS.getByName` in the cell, fakes in tests. */
export type Segments = (name: string) => SegmentAPI;

/** Everything the journal keeps besides its records and its head. */
export interface LogState {
  term: number;
  leader: string | null;
  leaseDeadlineMs: number;
  trimmedThrough: number;
  snapshotThrough: number;
  snapshotRef: string | null;
  /** Registers per link; fixed once the first link exists. */
  linkSize: number;
}

/** The state of a journal that has never been written. */
export const INITIAL_STATE: LogState = {
  term: 0,
  leader: null,
  leaseDeadlineMs: 0,
  trimmedThrough: 0,
  snapshotThrough: 0,
  snapshotRef: null,
  linkSize: LINK_LIMITS.defaultSize,
};

/** One atomic change to the store. */
export interface LogChange {
  state?: LogState;
  /** Link rows to insert or replace. */
  links?: Link[];
  /** Link rows to delete, by index. */
  drop?: number[];
}

/** What the journal keeps: SQLite in the Durable Object, Maps in tests. */
export interface LogStore {
  /** The state row, `INITIAL_STATE` before anything was committed. */
  load(): LogState;
  /** The link with the highest index, or `null` before the first. */
  last(): Link | null;
  /** The highest-indexed link whose `firstSeq` is at or below `seq`. */
  find(seq: number): Link | null;
  /** The first link after index `link`. */
  after(link: number): Link | null;
  /** Every link, in index order. */
  all(): Link[];
  /** Applies one change atomically. */
  commit(change: LogChange): void;
  /** Waits until every commit so far is durable; free when there was none. */
  barrier(): Promise<void>;
  /** The store's size in bytes, for `status`. */
  databaseSize(): number;
}

export interface LogOptions {
  retry?: RetryPolicy;
  now?: () => number;
}

/** How many times one append decides again after finding a stale head. */
const DECIDE_ATTEMPTS = 3;

/** How many allocated-but-foreign link indexes an open skips past. */
const OPEN_ATTEMPTS = 8;

/** A segment's largest `read` count and byte budget. */
const READ_COUNT = 1000;
const READ_BYTES = 4 * 1024 * 1024;

/** An error the edge answers with 503: the caller should simply repeat. */
function unavailableError(cause: string): Error {
  return new Error(`${UNAVAILABLE_PREFIX}${cause}`);
}

/** Turns a transient throw into the journal's own retryable error. */
function classify(error: unknown): unknown {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.startsWith(UNAVAILABLE_PREFIX)) {
    return error;
  }
  const cause = retryableCause(error);
  return cause === null ? error : unavailableError(cause);
}

/** A segment answer the journal's own bookkeeping rules out. */
function bug(what: string, result: unknown): Error {
  return new Error(`journal: ${what}: ${JSON.stringify(result)}`);
}

function toMeta(state: LogState, head: number): Meta {
  return {
    head,
    term: state.term,
    leader: state.leader,
    leaseDeadlineMs: state.leaseDeadlineMs,
    trimmedThrough: state.trimmedThrough,
    snapshotThrough: state.snapshotThrough,
    snapshotRef: state.snapshotRef,
  };
}

function toState(meta: Meta, linkSize: number): LogState {
  return {
    term: meta.term,
    leader: meta.leader,
    leaseDeadlineMs: meta.leaseDeadlineMs,
    trimmedThrough: meta.trimmedThrough,
    snapshotThrough: meta.snapshotThrough,
    snapshotRef: meta.snapshotRef,
    linkSize,
  };
}

export class LogCore implements JournalAPI {
  readonly #store: LogStore;
  readonly #segments: Segments;
  readonly #log: string;
  readonly #owner: string;
  readonly #retry: RetryPolicy;
  readonly #now: () => number;
  readonly #serial = new Serial();
  /** The next sequence, while known; `null` means recover it first. */
  #head: number | null = null;

  /**
   * `log` names the journal's links (`<log>.<index>`) and goes into their
   * allocation metadata. Constructing a core does no I/O; the first call
   * recovers the head.
   */
  constructor(
    store: LogStore,
    segments: Segments,
    log: string,
    options: LogOptions = {},
  ) {
    this.#store = store;
    this.#segments = segments;
    this.#log = log;
    this.#owner = `journal:${log}`.slice(0, 128);
    this.#retry = options.retry ?? DEFAULT_RETRY;
    this.#now = options.now ?? (() => Date.now());
  }

  /** The cached head, for tests; `null` until the first call recovers it. */
  get cachedHead(): number | null {
    return this.#head;
  }

  #segment(link: number): SegmentAPI {
    return this.#segments(linkName(this.#log, link));
  }

  #again<T>(call: () => Promise<T>): Promise<T> {
    return retryTransient(call, this.#retry);
  }

  /** Serialises a call; any throw drops the cached head. */
  #run<T>(task: () => Promise<T>): Promise<T> {
    return this.#serial.run(async () => {
      try {
        return await task();
      } catch (error) {
        this.#head = null;
        throw classify(error);
      }
    });
  }

  /** The decision core's view: the stored row and the cached head. */
  async #meta(): Promise<Meta> {
    if (this.#head === null) this.#head = await this.#recover();
    return toMeta(this.#store.load(), this.#head);
  }

  /**
   * Recovers head from the last link: capture it again first, so a write a
   * previous owner of this cell still has in flight can no longer land, then
   * read how many registers it holds from its durable `writes` counter.
   */
  async #recover(): Promise<number> {
    const last = this.#store.last();
    if (last === null) return 1;
    const linkSize = this.#store.load().linkSize;
    if (last.sealedAt !== null) return last.firstSeq + last.sealedAt;
    const segment = this.#segment(last.link);
    const captured: CaptureResult = await this.#again(() =>
      segment.capture({ start: 0, end: linkSize, owner: this.#owner })
    );
    if (captured.ok) {
      this.#store.commit({
        links: [{ ...last, captureId: captured.captureId }],
      });
      await this.#store.barrier();
    } else if (captured.code !== "TRIMMED") {
      // A wholly trimmed link takes no writes at all, so it needs no fence.
      throw bug(`recapturing link ${last.link}`, captured);
    }
    const heard = await this.#again(() =>
      segment.listen({ since: 0, timeoutMs: 0 })
    );
    if (!heard.ok || heard.writes > linkSize) {
      throw bug(`counting link ${last.link}`, heard);
    }
    return last.firstSeq + heard.writes;
  }

  /** Persists a new link row (and the seal of the previous one) durably. */
  async #open(
    index: number,
    firstSeq: number,
    term: number,
    seal: { link: Link; sealedAt: number } | null,
    linkSize: number,
  ): Promise<Link> {
    for (let skipped = 0; skipped < OPEN_ATTEMPTS; skipped += 1) {
      const at = index + skipped;
      const metadata = { log: this.#log, index: at, firstSeq, term };
      const segment = this.#segment(at);
      const allocated = await this.#again(() =>
        segment.alloc({
          size: linkSize,
          metadata: encodeLinkMetadata(metadata),
          allocator: this.#owner,
        })
      );
      if (!allocated.ok) {
        if (allocated.code !== "ALREADY_ALLOCATED") {
          throw bug(`allocating link ${at}`, allocated);
        }
        // An earlier open of this very link, whose row never became durable,
        // is ours to continue. Anything else at this index (an open for a
        // head or term that no longer applies) is skipped: it was never
        // written, and nothing refers to it.
        const found = decodeLinkMetadata(allocated.metadata);
        if (
          found === null || !sameLink(found, metadata) ||
          allocated.size !== linkSize
        ) {
          continue;
        }
      }
      const captured = await this.#again(() =>
        segment.capture({ start: 0, end: linkSize, owner: this.#owner })
      );
      if (!captured.ok) throw bug(`capturing link ${at}`, captured);
      if (captured.alreadyWritten > 0) continue;
      const link: Link = {
        link: at,
        firstSeq,
        captureId: captured.captureId,
        sealedAt: null,
        term,
      };
      const links = seal === null
        ? [link]
        : [{ ...seal.link, sealedAt: seal.sealedAt }, link];
      this.#store.commit({ links });
      await this.#store.barrier();
      return link;
    }
    throw bug(`opening a link from ${index}`, { skipped: OPEN_ATTEMPTS });
  }

  /** Takes the whole link back after a steal and persists the new round. */
  async #recapture(link: Link, linkSize: number): Promise<Link> {
    const captured = await this.#again(() =>
      this.#segment(link.link).capture({
        start: 0,
        end: linkSize,
        owner: this.#owner,
      })
    );
    if (!captured.ok) throw bug(`recapturing link ${link.link}`, captured);
    const next = { ...link, captureId: captured.captureId };
    this.#store.commit({ links: [next] });
    await this.#store.barrier();
    return next;
  }

  /**
   * Writes a batch at `offset` of `link`, all or none. `true` once it has
   * landed; `false` when the registers were already somebody else's, which
   * means the cached head was stale.
   */
  async #write(
    link: Link,
    offset: number,
    values: Uint8Array[],
    linkSize: number,
  ): Promise<boolean> {
    let current = link;
    for (let steals = 0;; steals += 1) {
      const segment = this.#segment(current.link);
      const captureId = current.captureId;
      let calls = 0;
      const result: WriteResult = await this.#again(() => {
        calls += 1;
        return segment.write({ start: offset, values, captureId });
      });
      if (result.ok) return true;
      if (result.code === "ALREADY_WRITTEN") {
        // After a transient throw, finding our own first value where the
        // batch starts means the thrown attempt landed, all of it.
        return calls > 1 && result.offset === offset && result.sameValue;
      }
      if (result.code !== "CAPTURE_STALE") {
        throw bug(`writing link ${current.link} at ${offset}`, result);
      }
      if (steals > 0) {
        throw unavailableError(
          `link ${current.link} was captured over the journal twice`,
        );
      }
      current = await this.#recapture(current, linkSize);
    }
  }

  /** Runs a decision that changes only the state row, and persists it. */
  async #decide<R>(
    step: (meta: Meta) => Outcome<R>,
    linkSize?: number,
  ): Promise<R> {
    const meta = await this.#meta();
    const outcome = step(meta);
    if (outcome.meta === meta) return outcome.result;
    const state = this.#store.load();
    const size = linkSize !== undefined && this.#store.last() === null
      ? linkSize
      : state.linkSize;
    this.#store.commit({ state: toState(outcome.meta, size) });
    await this.#store.barrier();
    return outcome.result;
  }

  acquireLease(request: AcquireLeaseRequest): Promise<AcquireLeaseResult> {
    return this.#run(() => {
      const linkSize = checkLinkSize(
        (request as { linkSize?: unknown } | null)?.linkSize,
      );
      if (typeof linkSize === "object") return Promise.resolve(linkSize);
      const nowMs = this.#now();
      return this.#decide(
        (meta) => core.acquireLease(meta, request, nowMs),
        linkSize,
      );
    });
  }

  renewLease(request: RenewLeaseRequest): Promise<RenewLeaseResult> {
    return this.#run(() => {
      const nowMs = this.#now();
      return this.#decide((meta) => core.renewLease(meta, request, nowMs));
    });
  }

  releaseLease(request: ReleaseLeaseRequest): Promise<ReleaseLeaseResult> {
    return this.#run(() =>
      this.#decide((meta) => core.releaseLease(meta, request))
    );
  }

  recordSnapshot(
    request: RecordSnapshotRequest,
  ): Promise<RecordSnapshotResult> {
    return this.#run(() =>
      this.#decide((meta) => core.recordSnapshot(meta, request))
    );
  }

  append(request: AppendRequest): Promise<AppendResult> {
    return this.#run(async () => {
      const nowMs = this.#now();
      for (let attempt = 0; attempt < DECIDE_ATTEMPTS; attempt += 1) {
        const meta = await this.#meta();
        const outcome = core.append(meta, request, nowMs);
        if (outcome.meta === meta) return outcome.result;
        const values = (outcome.insert ?? []).map((row) => row.payload);
        const { linkSize } = this.#store.load();
        const placed = place(
          this.#store.last(),
          meta.head,
          values.length,
          meta.term,
          linkSize,
        );
        if (placed.kind === "reply") return placed.result;
        const [link, offset] = placed.kind === "append"
          ? [placed.link, placed.offset]
          : [
            await this.#open(
              placed.index,
              placed.firstSeq,
              meta.term,
              placed.seal,
              linkSize,
            ),
            0,
          ];
        if (await this.#write(link, offset, values, linkSize)) {
          this.#head = outcome.meta.head;
          return outcome.result;
        }
        this.#head = null;
      }
      throw unavailableError(
        `head moved under the journal ${DECIDE_ATTEMPTS} times`,
      );
    });
  }

  /** Reads `want` records from `from`, link by link, under the byte budget. */
  async #scan(
    from: number,
    want: number,
    maxBytes: number,
    linkSize: number,
  ): Promise<JournalRecord[]> {
    const records: JournalRecord[] = [];
    if (want === 0) return records;
    let bytes = 0;
    let seq = from;
    let link = this.#store.find(from);
    while (
      records.length < want && (records.length === 0 || bytes <= maxBytes)
    ) {
      if (link === null) throw bug(`no link holds ${seq}`, { from, want });
      const offset = seq - link.firstSeq;
      const room = capacity(link, linkSize);
      if (offset >= room) {
        link = this.#store.after(link.link);
        continue;
      }
      const current = link;
      const window = await this.#again(() =>
        this.#segment(current.link).read({
          start: offset,
          count: Math.min(room - offset, want - records.length, READ_COUNT),
          maxBytes: Math.min(Math.max(1, maxBytes - bytes), READ_BYTES),
        })
      );
      if (!window.ok || window.registers.length === 0) {
        throw bug(`reading link ${current.link} at ${offset}`, window);
      }
      for (const register of window.registers) {
        if (register.state !== "written" || register.value === undefined) {
          throw bug(`sequence ${seq} is below head but unwritten`, register);
        }
        records.push({ seq, term: current.term, payload: register.value });
        bytes += register.value.byteLength;
        seq += 1;
      }
    }
    return records;
  }

  read(request: ReadRequest): Promise<ReadResult> {
    return this.#run(async () => {
      const meta = await this.#meta();
      const plan = core.planRead(meta, request);
      if (plan.kind === "reply") return plan.result;
      const want = Math.min(plan.limit, meta.head - plan.from);
      const rows = await this.#scan(
        plan.from,
        want,
        plan.maxBytes,
        this.#store.load().linkSize,
      );
      return core.finishRead(meta, rows, plan.maxBytes);
    });
  }

  status(): Promise<StatusResult> {
    return this.#run(async () => {
      const meta = await this.#meta();
      return core.status(meta, this.#now(), this.#store.databaseSize());
    });
  }

  /**
   * Trims the segments below the mark, and drops the rows of links wholly
   * below it. Runs after the mark is durable, and again on every successful
   * trim, so segments a crash left untrimmed are trimmed by the next one;
   * segment trims are idempotent.
   */
  async #sweep(through: number, linkSize: number): Promise<void> {
    const plan = trimPlan(this.#store.all(), through, linkSize);
    for (const step of plan) {
      const trimmed = await this.#again(() =>
        this.#segment(step.link.link).trim({ through: step.through })
      );
      if (!trimmed.ok) throw bug(`trimming link ${step.link.link}`, trimmed);
    }
    const drop = plan.filter((step) => step.drop).map((step) => step.link.link);
    if (drop.length > 0) {
      this.#store.commit({ drop });
      await this.#store.barrier();
    }
  }

  trim(request: TrimRequest): Promise<TrimResult> {
    return this.#run(async () => {
      const meta = await this.#meta();
      const outcome = core.trim(meta, request);
      const { linkSize } = this.#store.load();
      if (outcome.meta !== meta) {
        this.#store.commit({ state: toState(outcome.meta, linkSize) });
        await this.#store.barrier();
      }
      if (outcome.result.ok) {
        await this.#sweep(outcome.result.trimmedThrough, linkSize);
      }
      return outcome.result;
    });
  }
}
