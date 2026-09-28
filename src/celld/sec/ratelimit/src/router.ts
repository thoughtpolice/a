// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link rateLimit}: `@celld/web/router` middleware that charges each request
 * to a key and answers 429 when a policy refuses it.
 *
 * Where it goes decides what it can key on and what it protects:
 *
 * - `app.use(rateLimit(...))` runs before authentication, for every route
 *   and for 404s: a per-address limit on everything ({@link byIp}).
 * - A route's `before: [rateLimit(...)]` runs once the route matched,
 *   before the body is read and before authentication: a login route's
 *   per-address limit, so a flood never reaches the password check.
 * - A route's `use: [rateLimit(...)]` runs after authentication, with
 *   `c.principal` set: a per-caller quota ({@link byPrincipal}).
 *
 * An admitted request gets `RateLimit-Policy` and `RateLimit` on its
 * response (each limit on the route adds its policies to the same
 * fields); a refused one is a 429 with `Retry-After` and code
 * `rate_limited`. When the limiter cannot answer, the request is refused
 * with a 503 unless `unavailable: "allow"` lets it through.
 *
 * @module
 */

import { type Context, HttpError, type Middleware } from "@celld/web/router";
import type { PolicyStatus } from "./gcra.ts";
import { limitField, policyField, retryAfterField } from "./headers.ts";
import { ipKey, type IpKeyOptions, ipKeyOptions } from "./keys.ts";
import type { RateLimiter } from "./limiter.ts";

/** Options for {@link rateLimit}. */
export interface RateLimitOptions {
  /**
   * The limiter, or a function returning it for the request (for one built
   * from `c.env`, such as a `durableLimiter` over a binding).
   */
  readonly limiter: RateLimiter | ((c: Context) => RateLimiter);
  /**
   * The key the request is charged to, such as {@link byIp} or
   * {@link byPrincipal}; null lets the request through uncharged.
   */
  readonly key: (c: Context) => string | null | Promise<string | null>;
  /** Units the request spends: a number, or a function of the request. Default 1. */
  readonly cost?: number | ((c: Context) => number);
  /** Send `RateLimit-Policy` and `RateLimit`; default true. */
  readonly headers?: boolean;
  /**
   * When the limiter cannot answer (a `RateLimitUnavailable`, or any error
   * but a `TypeError` or `RangeError`, which are mistakes in the key or
   * cost and answer 500): `"refuse"` (default) answers 503 with
   * `Retry-After: 1`, `"allow"` lets the request through unlimited.
   * Refusing keeps a limit that guards credentials from failing open.
   */
  readonly unavailable?: "refuse" | "allow";
  /** Called with the error when the limiter cannot answer, to log it. */
  readonly onUnavailable?: (error: unknown, c: Context) => void;
}

/** The policies charged so far on each request, by name, for the fields. */
const charged = new WeakMap<Context, Map<string, PolicyStatus>>();

function record(c: Context, statuses: readonly PolicyStatus[]): Headers {
  let map = charged.get(c);
  if (map === undefined) {
    map = new Map();
    charged.set(c, map);
  }
  for (const status of statuses) map.set(status.name, status);
  const all = [...map.values()];
  const headers = new Headers({
    "ratelimit-policy": policyField(all),
    "ratelimit": limitField(all),
  });
  // Pending headers reach every answer, errors included; the last set wins,
  // so each limit writes the fields with every policy charged so far.
  headers.forEach((value, name) => c.header(name, value));
  return headers;
}

/**
 * Middleware charging each request to `key(c)` in `limiter`. See the
 * module documentation for where to put it.
 *
 * ```ts
 * const perAddress = memoryLimiter({
 *   policies: [{ name: "address", limit: 60, window: "PT1M" }],
 * });
 * app.use(rateLimit({ limiter: perAddress, key: byIp() }));
 * ```
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("rateLimit takes an options object");
  }
  for (const key of Object.keys(options)) {
    if (
      !["limiter", "key", "cost", "headers", "unavailable", "onUnavailable"]
        .includes(key)
    ) {
      throw new TypeError(`rateLimit has no option ${JSON.stringify(key)}`);
    }
  }
  const { limiter, key, cost = 1 } = options;
  if (
    typeof limiter !== "function" &&
    (typeof limiter !== "object" || limiter === null ||
      typeof limiter.limit !== "function")
  ) {
    throw new TypeError("rateLimit needs a limiter");
  }
  if (typeof key !== "function") {
    throw new TypeError("rateLimit needs a key function");
  }
  if (typeof cost !== "number" && typeof cost !== "function") {
    throw new TypeError("rateLimit's cost is a number or a function");
  }
  const unavailable = options.unavailable ?? "refuse";
  if (unavailable !== "refuse" && unavailable !== "allow") {
    throw new TypeError('rateLimit\'s unavailable is "refuse" or "allow"');
  }
  const headers = options.headers ?? true;
  const onUnavailable = options.onUnavailable;

  return async (c, next) => {
    const charge = await key(c);
    if (charge === null) return await next();
    const units = typeof cost === "function" ? cost(c) : cost;
    const chosen = typeof limiter === "function" ? limiter(c) : limiter;
    let decision;
    try {
      decision = await chosen.limit(charge, { cost: units });
    } catch (error) {
      // A bad cost or key is the application's mistake, not an outage.
      if (error instanceof TypeError || error instanceof RangeError) {
        throw error;
      }
      try {
        onUnavailable?.(error, c);
      } catch {
        // A failing reporter must not change the answer.
      }
      if (unavailable === "allow") return await next();
      throw new HttpError(503, "rate limiter unavailable", {
        code: "rate_limit_unavailable",
        headers: { "retry-after": "1" },
        cause: error,
      });
    }
    const fields = headers ? record(c, decision.policies) : new Headers();
    if (!decision.allowed) {
      fields.set("retry-after", retryAfterField(decision.retryAfterMs));
      throw new HttpError(429, "too many requests", {
        code: "rate_limited",
        headers: fields,
      });
    }
    return await next();
  };
}

/**
 * Keys requests by the client's address (`c.ip()`, per the router's
 * `clientIp` settings) with {@link ipKey}: one key per IPv4 address and per
 * IPv6 /64 by default, and one shared `ip:unknown` key for requests whose
 * address the router cannot tell. The address is only as good as the
 * router's peer source; see the router's README.
 */
export function byIp(options: IpKeyOptions = {}): (c: Context) => string {
  const checked = ipKeyOptions(options);
  return (c) => ipKey(c.ip(), checked);
}

/**
 * Keys requests by the authenticated principal's `key` (never its
 * `subject`, which two issuers can share); null for an anonymous request,
 * which is let through uncharged, so pair it with {@link byIp} where
 * anonymous requests reach it.
 */
export function byPrincipal(): (c: Context) => string | null {
  return (c) => c.principal === null ? null : `principal:${c.principal.key}`;
}
