// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Where `subscriptions/listen` streams get their changes.
 *
 * A server's `subscriptions/listen` handler turns {@link ChangeEvent}s from a
 * pluggable {@link ChangeSource} into the notifications each subscriber
 * opted in to. Two sources come with the library:
 *
 * - {@link MemoryChangeSource}: publish and listen in one isolate. Right for
 *   tests, a single process, or a Durable Object that owns both ends.
 * - {@link pollingChangeSource} over a {@link ChangeLog}: the log is the part
 *   a Durable Object keeps (see `@celld/mcp/durable`, `McpChangeHub`), and
 *   every Worker isolate serving a listen stream long-polls it. Workers do
 *   not share memory, so this is how a change published by one request
 *   reaches listen streams held open by others.
 *
 * @module
 */

import { ulid } from "@celld/ulid";

/** A change that listen streams may need to report. */
export type ChangeEvent =
  /** The tool list changed. */
  | { readonly type: "tools" }
  /** The prompt list changed. */
  | { readonly type: "prompts" }
  /** The resource list changed. */
  | { readonly type: "resources" }
  /** One resource's contents changed. */
  | { readonly type: "resource"; readonly uri: string }
  /** A task's status changed (the tasks extension). */
  | { readonly type: "task"; readonly taskId: string }
  /**
   * Changes may have been missed (the log restarted or was overrun), so a
   * subscriber should assume everything it watches changed.
   */
  | { readonly type: "reset" };

/** A feed of changes for listen streams. */
export interface ChangeSource {
  /**
   * Attaches a listener. Resolves once it is attached, so every event
   * published after that is delivered; the iterable yields them in order
   * until `signal` aborts, then returns.
   */
  listen(signal: AbortSignal): Promise<AsyncIterable<ChangeEvent>>;
}

/** Something changes can be published to. */
export interface ChangePublisher {
  publish(event: ChangeEvent): void | Promise<void>;
}

/** Whether `value` is a well-formed {@link ChangeEvent}. */
export function isChangeEvent(value: unknown): value is ChangeEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as { type?: unknown; uri?: unknown };
  switch (event.type) {
    case "tools":
    case "prompts":
    case "resources":
    case "reset":
      return true;
    case "resource":
      return typeof event.uri === "string";
    case "task":
      return typeof (event as { taskId?: unknown }).taskId === "string";
    default:
      return false;
  }
}

/**
 * An async iterator fed by `subscribe`'s pushes. It subscribes immediately,
 * so nothing published before the first `next()` is lost, queues values
 * until read, and ends (unsubscribing) when `signal` aborts or it is
 * returned early.
 */
function pushed<T>(
  signal: AbortSignal,
  subscribe: (push: (value: T) => void) => () => void,
): AsyncIterableIterator<T> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let unsubscribe = () => {};
  const finish = () => {
    if (done) return;
    done = true;
    unsubscribe();
    signal.removeEventListener("abort", finish);
    wake?.();
  };
  unsubscribe = subscribe((value) => {
    if (done) return;
    queue.push(value);
    wake?.();
  });
  signal.addEventListener("abort", finish);
  if (signal.aborted) finish();
  const iterator: AsyncIterableIterator<T> = {
    async next(): Promise<IteratorResult<T>> {
      for (;;) {
        if (done) return { done: true, value: undefined };
        if (queue.length > 0) return { done: false, value: queue.shift()! };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    },
    return(): Promise<IteratorResult<T>> {
      finish();
      return Promise.resolve({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

/** Publish and listen within one isolate. */
export class MemoryChangeSource implements ChangeSource, ChangePublisher {
  readonly #listeners = new Set<(event: ChangeEvent) => void>();

  /** Delivers `event` to every current listener. */
  publish(event: ChangeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  listen(signal: AbortSignal): Promise<AsyncIterable<ChangeEvent>> {
    return Promise.resolve(pushed<ChangeEvent>(signal, (push) => {
      this.#listeners.add(push);
      return () => this.#listeners.delete(push);
    }));
  }

  /** How many listen streams are attached, for tests and metrics. */
  get listeners(): number {
    return this.#listeners.size;
  }
}

/** A position in a {@link ChangeLog}. */
export interface ChangeCursor {
  /** Identifies one lifetime of the log; a new one means a restart. */
  readonly epoch: string;
  /** The sequence number of the last event seen. */
  readonly seq: number;
}

/** The answer to a poll. */
export interface ChangeBatch extends ChangeCursor {
  /** Events after the poll's cursor, oldest first. */
  readonly events: ChangeEvent[];
  /** True when events between the cursor and now were lost. */
  readonly reset: boolean;
}

/** Options for a {@link ChangeLog}. */
export interface ChangeLogOptions {
  /** Events kept for slow pollers; default 1000. */
  readonly capacity?: number;
  /** The epoch; default a fresh ULID. */
  readonly epoch?: string;
}

/**
 * A bounded, sequence-numbered log of changes with long polling: the state a
 * Durable Object keeps for {@link pollingChangeSource}. In memory by design:
 * listeners are live connections, so a restart only needs to tell them to
 * resynchronise, which the new epoch does.
 */
export class ChangeLog {
  readonly epoch: string;
  readonly #capacity: number;
  #events: { seq: number; event: ChangeEvent }[] = [];
  #seq = 0;
  #waiters = new Set<() => void>();

  constructor(options: ChangeLogOptions = {}) {
    this.#capacity = options.capacity ?? 1000;
    this.epoch = options.epoch ?? ulid();
  }

  /** The sequence number of the newest event. */
  get head(): number {
    return this.#seq;
  }

  /** Appends an event and wakes waiting pollers; returns its sequence number. */
  append(event: ChangeEvent): number {
    this.#seq++;
    this.#events.push({ seq: this.#seq, event });
    if (this.#events.length > this.#capacity) this.#events.shift();
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
    return this.#seq;
  }

  /**
   * The events after `cursor`, now. A null cursor starts at the head with no
   * events; a cursor from another epoch, from the future, or older than the
   * retained window is a reset.
   */
  since(cursor: ChangeCursor | null): ChangeBatch {
    const head = { epoch: this.epoch, seq: this.#seq };
    if (cursor === null) return { ...head, events: [], reset: false };
    const oldest = this.#events.length > 0
      ? this.#events[0].seq
      : this.#seq + 1;
    if (
      cursor.epoch !== this.epoch || cursor.seq > this.#seq ||
      cursor.seq < oldest - 1
    ) {
      return { ...head, events: [], reset: true };
    }
    return {
      ...head,
      events: this.#events.filter((entry) => entry.seq > cursor.seq).map((
        entry,
      ) => entry.event),
      reset: false,
    };
  }

  /**
   * Like {@link since}, but when there is nothing new, waits up to `waitMs`
   * for an append first.
   */
  async wait(
    cursor: ChangeCursor | null,
    waitMs: number,
  ): Promise<ChangeBatch> {
    const now = this.since(cursor);
    if (cursor === null || now.reset || now.events.length > 0 || waitMs <= 0) {
      return now;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(done);
        resolve();
      }, waitMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#waiters.add(done);
    });
    return this.since(cursor);
  }

  /** Pollers currently waiting, for tests. */
  get waiting(): number {
    return this.#waiters.size;
  }
}

/** Options for {@link pollingChangeSource}. */
export interface PollingOptions {
  /**
   * Long-poll window per call; default 10 s, below celld's default 15 s
   * operation deadline for Durable Object calls.
   */
  readonly waitMs?: number;
  /** Pause after a failed poll; default 1 s. */
  readonly errorDelayMs?: number;
  /** Told about failed polls; default: ignored. */
  readonly onError?: (error: unknown) => void;
}

/**
 * A {@link ChangeSource} that long-polls a {@link ChangeLog} somewhere else,
 * typically a Durable Object reached over RPC. `listen` resolves after the
 * first poll has fixed the starting position (and rejects if that poll
 * fails). A reset batch becomes a `reset` event. A later failed poll is
 * retried from the same cursor, so nothing is skipped unless the log itself
 * overran.
 */
export function pollingChangeSource(
  poll: (cursor: ChangeCursor | null, waitMs: number) => Promise<ChangeBatch>,
  options: PollingOptions = {},
): ChangeSource {
  const waitMs = options.waitMs ?? 10_000;
  const errorDelayMs = options.errorDelayMs ?? 1000;
  async function* follow(
    signal: AbortSignal,
    start: ChangeCursor,
  ): AsyncGenerator<ChangeEvent> {
    let cursor = start;
    while (!signal.aborted) {
      let batch: ChangeBatch;
      try {
        batch = await poll(cursor, waitMs);
      } catch (error) {
        options.onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, errorDelayMs));
        continue;
      }
      if (signal.aborted) return;
      if (batch.reset) yield { type: "reset" };
      for (const event of batch.events) yield event;
      cursor = { epoch: batch.epoch, seq: batch.seq };
    }
  }
  return {
    async listen(signal) {
      const head = await poll(null, 0);
      return follow(signal, { epoch: head.epoch, seq: head.seq });
    },
  };
}
