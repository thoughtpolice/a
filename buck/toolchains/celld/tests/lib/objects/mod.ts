// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { score } from "@fixture/top";

/** A Durable Object whose state is a single counter row. */
export class Counter extends DurableObject<unknown> {
  #value = 0;

  /** Adds the score of `amount` and returns the new total. */
  increment(amount: number): number {
    this.#value += score(amount);
    return this.#value;
  }
}
