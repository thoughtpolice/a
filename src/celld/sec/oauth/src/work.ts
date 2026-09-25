// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { ProtocolError } from "./errors.ts";

/** Isolate-local outbound admission. Keys must be nonsecret hashes/URLs. */
export class OutboundWork {
  readonly #pending = new Map<string, Promise<unknown>>();
  readonly #origins = new Map<string, number>();
  #window = 0;
  #calls = 0;
  #failed = 0;
  #openUntil = 0;
  constructor(readonly now: () => number) {}
  async run<T>(
    key: string,
    origin: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const existing = this.#pending.get(key);
    if (existing !== undefined) return await existing as T;
    const now = this.now();
    if (now - this.#window >= 60_000) {
      this.#window = now;
      this.#calls = 0;
    }
    if (
      this.#pending.size >= 32 || (this.#origins.get(origin) ?? 0) >= 8 ||
      this.#calls >= 120 || this.#openUntil > now
    ) {
      throw new ProtocolError("temporarily_unavailable", {
        status: 503,
        description: "outbound authentication budget exhausted",
        headers: { "retry-after": "1" },
      });
    }
    this.#calls++;
    this.#origins.set(origin, (this.#origins.get(origin) ?? 0) + 1);
    const pending = Promise.resolve().then(work);
    this.#pending.set(key, pending);
    try {
      const result = await pending;
      this.#failed = 0;
      return result;
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.status >= 500) {
        if (++this.#failed >= 5) {
          this.#openUntil = this.now() + 1000;
          this.#failed = 0;
        }
      }
      throw error;
    } finally {
      this.#pending.delete(key);
      const count = this.#origins.get(origin)! - 1;
      if (count === 0) this.#origins.delete(origin);
      else this.#origins.set(origin, count);
    }
  }
}
