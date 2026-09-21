// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The journal cell's store in memory, and a harness that builds the
 * coordinator over it and over wormspace's fake segments.
 *
 * `MemoryLogStore` is what the Durable Object keeps in SQLite, as a row and a
 * Map: every read hands out a copy and `commit` applies its whole change at
 * once. A test "restarts" the cell by building a new `LogCore` over the same
 * store and the same segments, which drops the cached head and the call
 * queue and keeps exactly what was committed.
 *
 * @module
 */

import { FakeSegments } from "@wormspace/testing/fake_segment";
import type { Link } from "@journal/links";
import {
  INITIAL_STATE,
  type LogChange,
  LogCore,
  type LogState,
  type LogStore,
} from "@journal/log";

export class MemoryLogStore implements LogStore {
  state: LogState = { ...INITIAL_STATE };
  readonly links = new Map<number, Link>();
  commits = 0;
  barriers = 0;
  #pending = false;

  load(): LogState {
    return { ...this.state };
  }

  #sorted(): Link[] {
    return [...this.links.values()].sort((left, right) =>
      left.link - right.link
    );
  }

  last(): Link | null {
    const links = this.#sorted();
    return links.length === 0 ? null : { ...links[links.length - 1] };
  }

  find(seq: number): Link | null {
    const found = this.#sorted().filter((link) => link.firstSeq <= seq).pop();
    return found === undefined ? null : { ...found };
  }

  after(link: number): Link | null {
    const found = this.#sorted().find((row) => row.link > link);
    return found === undefined ? null : { ...found };
  }

  all(): Link[] {
    return this.#sorted().map((link) => ({ ...link }));
  }

  commit(change: LogChange): void {
    if (change.state !== undefined) this.state = { ...change.state };
    for (const link of change.links ?? []) {
      this.links.set(link.link, { ...link });
    }
    for (const link of change.drop ?? []) this.links.delete(link);
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

  databaseSize(): number {
    return 4096 + 64 * this.links.size;
  }
}

/** The clock every harness starts at, so deadlines are reproducible. */
export const T0 = 1_700_000_000_000;

/** One journal cell over fakes: its store, its segments, and its instance. */
export class Harness {
  readonly store = new MemoryLogStore();
  readonly segments: FakeSegments;
  nowMs = T0;
  core: LogCore;

  constructor(readonly log = "orders") {
    this.segments = new FakeSegments({ now: () => this.nowMs });
    this.core = this.#build();
  }

  #build(): LogCore {
    return new LogCore(this.store, this.segments.resolve, this.log, {
      retry: { attempts: 5, pauseMs: 0 },
      now: () => this.nowMs,
    });
  }

  /** A new instance over the same store and segments, as after an eviction. */
  restart(): LogCore {
    this.core = this.#build();
    return this.core;
  }

  /** The fake behind link `index`. */
  link(index: number) {
    return this.segments.get(`${this.log}.${index}`);
  }
}
