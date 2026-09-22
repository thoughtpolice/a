// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-memory `SegmentAPI` driven by the real decision core, for testing
 * what is built on segments without celld.
 *
 * `FakeSegment` keeps the three tables the Durable Object keeps (the meta
 * row, the registers, and the capture rows) and implements each method
 * exactly as `src/segment.ts` does: it asks the same `core.*Scope` function
 * what to load, builds the same view from its tables, runs the same
 * transition, and applies the outcome in the Durable Object's order (prune,
 * insert the capture, insert the registers, delete through the mark). The
 * edges behave like celld's RPC: every request and every result is a
 * structured clone, so no caller shares bytes with the store, and every call
 * is asynchronous. `listen` parks on a real timer and is woken only after
 * the write that passes its counter has been applied.
 *
 * `FakeSegments` is a registry of named fakes that hands out the
 * `(name) => SegmentAPI` resolver `src/chain.ts` takes, logs every call, and
 * consults an optional `faults` hook before each one, which can answer in
 * the segment's place, throw the way celld does when an owner is
 * unreachable, or perform the call and then lose its reply.
 *
 * @module
 */

import * as core from "@wormspace/segment/core";
import {
  type CaptureRow,
  type Meta,
  type Outcome,
  type Range,
  type RegisterRow,
} from "@wormspace/segment/core";
import {
  type AllocRequest,
  type AllocResult,
  type AnyResult,
  type CaptureRequest,
  type CaptureResult,
  type ListenRequest,
  type ListenResult,
  NAME_PATTERN,
  type ReadRequest,
  type ReadResult,
  type SegmentAPI,
  type StatusResult,
  type TrimRequest,
  type TrimResult,
  type WriteRequest,
  type WriteResult,
} from "@wormspace/segment/types";

/** A segment method, as the fault hook and the call log name it. */
export type Method = keyof SegmentAPI;

/**
 * What a fault hook decides for one call:
 *
 *   - a result: answered in the segment's place, and nothing is performed;
 *   - `"throw"`: nothing is performed, and the call throws `unreachable()`;
 *   - `"lost"`: the call is performed, then throws `lostReply()`, the way a
 *     write whose durability celld could not prove does;
 *   - `undefined`: the call goes through.
 */
export type FaultAction = AnyResult | "throw" | "lost" | undefined;

/** Consulted before every call; `request` is `undefined` for `status`. */
export type Fault = (
  method: Method,
  request: unknown,
  name: string,
) => FaultAction;

/** One call as the registry saw it, before any fault was applied. */
export interface Call {
  name: string;
  method: Method;
  request: unknown;
}

/** What celld throws while a cell's owner cannot be reached. */
export function unreachable(): Error {
  return Object.assign(new Error("segment owner unreachable (fake)"), {
    code: "owner_unreachable",
    retryable: true,
  });
}

/** What celld throws when a write committed but could not be proven. */
export function lostReply(): Error {
  return new Error("route failed: DurabilityUnproven");
}

/** How the registry reaches into each fake it created. */
interface Hooks {
  now(): number;
  before(name: string, method: Method, request: unknown): FaultAction;
}

/** A parked `listen`, exactly as the Durable Object keeps one. */
interface Waiter {
  since: number;
  wake(writes: number | null): void;
}

const DIRECT: Hooks = {
  now: () => Date.now(),
  before: () => undefined,
};

/** One segment's tables in memory, behind the Durable Object's methods. */
export class FakeSegment implements SegmentAPI {
  meta: Meta = core.INITIAL_META;
  /** Written registers by offset, as the `registers` table holds them. */
  readonly registers = new Map<number, RegisterRow>();
  /** The `captures` table, in insertion order. */
  captures: CaptureRow[] = [];
  readonly #waiters = new Set<Waiter>();
  readonly #hooks: Hooks;

  constructor(readonly name = "fake", hooks: Hooks = DIRECT) {
    this.#hooks = hooks;
  }

  /** Parked `listen` calls, for tests that check nothing leaks. */
  get waiting(): number {
    return this.#waiters.size;
  }

  /**
   * The RPC edge: consult the fault hook, clone the request in, yield once
   * as a real call would, run the method, and clone the result out.
   */
  async #call<R extends AnyResult>(
    method: Method,
    request: unknown,
    body: (request: never) => R | Promise<R>,
  ): Promise<R> {
    const action = this.#hooks.before(this.name, method, request);
    if (action === "throw") throw unreachable();
    if (action !== undefined && action !== "lost") {
      return structuredClone(action) as R;
    }
    const cloned = structuredClone(request) as never;
    await Promise.resolve();
    const result = await body(cloned);
    if (action === "lost") throw lostReply();
    return structuredClone(result);
  }

  #written(range: Range): RegisterRow[] {
    return [...this.registers.values()]
      .filter((row) => row.offset >= range.start && row.offset < range.end)
      .sort((left, right) => left.offset - right.offset);
  }

  #overlapping(range: Range): CaptureRow[] {
    return this.captures.filter((row) =>
      row.start < range.end && row.end > range.start
    );
  }

  /**
   * The Durable Object's `#mutate`: apply the write set in its order, or
   * nothing when the transition kept `meta`; then, as after its `sync()`,
   * hand the new meta to `durable`.
   */
  #mutate<R>(
    step: (meta: Meta) => Outcome<R>,
    durable?: (meta: Meta) => void,
  ): R {
    const before = this.meta;
    const outcome = step(before);
    if (outcome.meta === before) return outcome.result;
    // A reused primary key makes SQLite roll the whole transaction back, so
    // it is refused before anything changes.
    const captured = outcome.insertCapture;
    if (
      captured !== undefined &&
      this.captures.some((row) => row.round === captured.round)
    ) {
      throw new Error(`capture round ${captured.round} inserted twice`);
    }
    const rows = outcome.insertRegisters ?? [];
    for (const row of rows) {
      if (this.registers.has(row.offset)) {
        throw new Error(`register ${row.offset} inserted twice`);
      }
    }
    const prune = outcome.pruneCaptures;
    if (prune !== undefined) {
      this.captures = this.captures.filter((row) =>
        !(row.start >= prune.start && row.end <= prune.end)
      );
    }
    if (captured !== undefined) this.captures.push({ ...captured });
    for (const row of rows) this.registers.set(row.offset, { ...row });
    const through = outcome.deleteThrough;
    if (through !== undefined) {
      for (const offset of [...this.registers.keys()]) {
        if (offset <= through) this.registers.delete(offset);
      }
      this.captures = this.captures.filter((row) => row.end > through + 1);
    }
    this.meta = outcome.meta;
    durable?.(outcome.meta);
    return outcome.result;
  }

  #wake(writes: number): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.since < writes) waiter.wake(writes);
    }
  }

  alloc(request: AllocRequest): Promise<AllocResult> {
    return this.#call("alloc", request, (request: AllocRequest) => {
      const nowMs = this.#hooks.now();
      return this.#mutate((meta) => core.alloc(meta, request, nowMs));
    });
  }

  capture(request: CaptureRequest): Promise<CaptureResult> {
    return this.#call("capture", request, (request: CaptureRequest) => {
      const nowMs = this.#hooks.now();
      return this.#mutate((meta) => {
        const range = core.captureScope(meta, request);
        const view = range === null ? core.EMPTY_CAPTURE_VIEW : {
          writtenInRange: this.#written(range).length,
          liveCaptures: this.captures.length,
          dominated: this.captures.filter((row) =>
            row.start >= range.start && row.end <= range.end
          ).length,
        };
        return core.capture(meta, request, view, nowMs);
      });
    });
  }

  write(request: WriteRequest): Promise<WriteResult> {
    return this.#call("write", request, (request: WriteRequest) => {
      const nowMs = this.#hooks.now();
      return this.#mutate((meta) => {
        const range = core.writeScope(meta, request);
        const view = range === null ? core.EMPTY_WRITE_VIEW : {
          existing: new Map(
            this.#written(range).map((row) => [row.offset, row.value]),
          ),
          captures: this.#overlapping(range),
        };
        return core.write(meta, request, view, nowMs);
      }, (meta) => this.#wake(meta.writes));
    });
  }

  trim(request: TrimRequest): Promise<TrimResult> {
    return this.#call(
      "trim",
      request,
      (request: TrimRequest) =>
        this.#mutate((meta) => {
          const through = core.trimScope(meta, request);
          const view = through === null ? core.EMPTY_TRIM_VIEW : {
            writtenThrough: [...this.registers.keys()]
              .filter((offset) => offset <= through).length,
          };
          return core.trim(meta, request, view);
        }),
    );
  }

  read(request: ReadRequest): Promise<ReadResult> {
    return this.#call("read", request, (request: ReadRequest) => {
      const meta = this.meta;
      const plan = core.planRead(meta, request);
      if (plan.kind === "reply") return plan.result;
      const sizes = this.#written(plan).map((row) => ({
        offset: row.offset,
        bytes: row.value.byteLength,
      }));
      const window = { start: plan.start, end: core.readWindow(plan, sizes) };
      return core.finishRead(
        meta,
        window,
        this.#written(window),
        this.#overlapping(window),
      );
    });
  }

  /**
   * A stand-in for SQLite's page count: a page for the schema plus the bytes
   * stored. Only the Durable Object's number means anything.
   */
  #databaseSize(): number {
    let bytes = 4096;
    for (const row of this.registers.values()) bytes += row.value.byteLength;
    return bytes;
  }

  status(): Promise<StatusResult> {
    return this.#call(
      "status",
      undefined,
      () => core.status(this.meta, this.captures.length, this.#databaseSize()),
    );
  }

  listen(request: ListenRequest): Promise<ListenResult> {
    return this.#call("listen", request, async (request: ListenRequest) => {
      const plan = core.planListen(this.meta, request);
      if (plan.kind === "reply") return plan.result;
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
      return core.listenReply(this.meta, plan.since);
    });
  }
}

/** Named fakes behind one resolver, with a call log and a fault hook. */
export class FakeSegments {
  readonly #segments = new Map<string, FakeSegment>();
  /** Every call made through the registry, in order. */
  readonly calls: Call[] = [];
  /** Consulted before every call; replace it at any time. */
  faults: Fault | undefined;
  /** The clock handed to every transition. */
  now: () => number;

  constructor(options: { faults?: Fault; now?: () => number } = {}) {
    this.faults = options.faults;
    this.now = options.now ?? (() => Date.now());
  }

  /** The fake behind `name`, created unallocated on first use like a cell. */
  get(name: string): FakeSegment {
    if (!NAME_PATTERN.test(name)) {
      throw new TypeError(`${JSON.stringify(name)} is not a segment name`);
    }
    let segment = this.#segments.get(name);
    if (segment === undefined) {
      segment = new FakeSegment(name, {
        now: () => this.now(),
        before: (name, method, request) => {
          this.calls.push({ name, method, request });
          return this.faults?.(method, request, name);
        },
      });
      this.#segments.set(name, segment);
    }
    return segment;
  }

  /** The resolver `src/chain.ts` and anything else built on segments takes. */
  readonly resolve = (name: string): SegmentAPI => this.get(name);

  /** Names of every segment touched so far, allocated or not. */
  names(): string[] {
    return [...this.#segments.keys()].sort();
  }

  /** How many calls of `method` (on `name`, if given) the log holds. */
  count(method: Method, name?: string): number {
    return this.calls.filter((call) =>
      call.method === method && (name === undefined || call.name === name)
    ).length;
  }
}
