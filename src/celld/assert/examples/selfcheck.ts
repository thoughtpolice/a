// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A health endpoint that runs the Worker's own checks with `@celld/assert`.
 *
 * `@celld/assert` is for tests, but its assertions are plain functions with
 * no test runner behind them, so a deployed Worker can run the same kind of
 * checks against itself. This one prices orders: `POST /quote` with
 * `{"items": [{"cents", "quantity"}]}` returns the subtotal, tax and total.
 * `GET /healthz` checks, in the running isolate, that:
 *
 * - the deployed `TAX_RATE` is a rate from 0 to 1 (`assert`), not a
 *   percentage;
 * - a known order succeeds (`assertOk`, which narrows the result to its
 *   quote) and prices to known amounts (`assertEquals`, which compares
 *   structurally, so the whole quote is checked at once);
 * - an empty order is refused with the right code (`assertCode`), and a
 *   bad item with its index.
 *
 * It answers 200 with the number of checks, or 503 with the first failure
 * and its message, which `assertEquals` spells out with both values. A
 * load balancer then stops routing to a misconfigured deployment.
 *
 * ```sh
 * buck2 run root//src/celld/assert/examples:selfcheck-dev
 * curl -sS localhost:9876/healthz
 * curl -sS -X POST localhost:9876/quote -d '{"items": [{"cents": 250, "quantity": 4}]}'
 * ```
 *
 * @module
 */

import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";

interface Env {
  readonly TAX_RATE: string;
}

interface Quote {
  readonly subtotal: number;
  readonly tax: number;
  readonly total: number;
}

type Priced =
  | { readonly ok: true; readonly quote: Quote }
  | {
    readonly ok: false;
    readonly code: "empty" | "bad_item";
    readonly item?: number;
  };

function price(items: unknown, rate: number): Priced {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, code: "empty" };
  }
  let subtotal = 0;
  for (const [index, item] of items.entries()) {
    const { cents, quantity } = (item ?? {}) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(cents) || (cents as number) < 0 ||
      !Number.isSafeInteger(quantity) || (quantity as number) < 1
    ) {
      return { ok: false, code: "bad_item", item: index };
    }
    subtotal += (cents as number) * (quantity as number);
  }
  // Round half away from zero, once, on the total tax.
  const tax = Math.round(subtotal * rate);
  return { ok: true, quote: { subtotal, tax, total: subtotal + tax } };
}

const CHECKS: [string, (rate: number) => void][] = [
  ["tax rate", (rate) => {
    assert(
      Number.isFinite(rate) && rate >= 0 && rate < 1,
      "TAX_RATE is a rate from 0 to 1",
    );
  }],
  ["known order", () => {
    const priced = assertOk(
      price([{ cents: 1000, quantity: 3 }, { cents: 199, quantity: 1 }], 0.25),
    );
    assertEquals(
      priced.quote,
      { subtotal: 3199, tax: 800, total: 3999 },
      "known order",
    );
  }],
  ["empty order", () => assertCode(price([], 0.25), "empty")],
  ["bad item", () => {
    const refused = price([{ cents: 1, quantity: 1 }, {
      cents: -5,
      quantity: 1,
    }], 0.25);
    assertEquals(refused, { ok: false, code: "bad_item", item: 1 });
  }],
];

function healthz(env: Env): Response {
  const rate = Number(env.TAX_RATE);
  for (const [name, check] of CHECKS) {
    try {
      check(rate);
    } catch (error) {
      return Response.json({
        ok: false,
        failed: name,
        error: (error as Error).message,
      }, {
        status: 503,
      });
    }
  }
  return Response.json({ ok: true, checks: CHECKS.length });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === "GET /healthz") return healthz(env);
    if (route === "POST /quote") {
      const { items } = await request.json().catch(() => ({})) as {
        items?: unknown;
      };
      const priced = price(items, Number(env.TAX_RATE));
      return priced.ok
        ? Response.json(priced.quote)
        : Response.json(priced, { status: 400 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
