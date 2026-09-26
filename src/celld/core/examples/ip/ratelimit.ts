// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A rate limiter per network rather than per address.
 *
 * Limiting single addresses does little against IPv6, where one customer
 * gets a /64 (or more) and can use a fresh address for every request, and
 * little against a crowd behind one IPv4 NAT that should share a budget. So
 * this Worker puts each client in a bucket named by its block: the /24 for
 * IPv4 and the /64 for IPv6 (both Worker variables). An IPv4-mapped IPv6
 * address counts as its IPv4 address, or it would get a bucket of its own.
 *
 * Each bucket is a `Bucket` Durable Object named by the block's text, a
 * token bucket holding `BURST` requests and refilling `PER_MINUTE` a
 * minute. The level is kept in memory: it is soft state, and an evicted
 * object starts full, which admits at most one burst early.
 *
 * - Any request spends a token; with none left it gets a 429 with
 *   `retry-after`. The response headers say which bucket was charged.
 * - `GET /buckets/<address>` names the address's bucket and its level,
 *   without spending anything.
 *
 * The client address is `CF-Connecting-IP`, which is trustworthy only on
 * Cloudflare's edge: the edge overwrites whatever the client sent.
 * Anywhere a client can reach the Worker directly (and under `celld dev`,
 * which passes it through as sent) a client picks the header, so it can
 * rotate it for fresh buckets or spend a victim's /24. Deployed elsewhere,
 * take the peer from the platform (router's `clientIp.peer`), and read
 * `X-Forwarded-For` only from a trusted proxy, as the `firewall` example
 * does.
 *
 * The numbers are checked once with `@celld/core/bounds` (`BURST` a whole
 * number from 1, `PER_MINUTE` above 0, prefixes within 0-32 and 0-128), so
 * a bad value answers 500 instead of refusing everyone or promising
 * `retry-after: Infinity`.
 *
 * ```sh
 * buck2 run root//src/celld/core/examples/ip:ratelimit-dev
 * curl -sS -i localhost:9876/ -H 'cf-connecting-ip: 192.0.2.10'
 * curl -sS localhost:9876/buckets/2001:db8:1:2::99
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { BoundsError, finite, safeInt } from "@celld/core/bounds";
import { Cidr, type IpAddress, parseIp } from "@celld/core/ip";

interface Env {
  readonly BUCKETS: DurableObjectNamespace<Bucket>;
  readonly BURST: string;
  readonly PER_MINUTE: string;
  readonly IPV4_PREFIX: string;
  readonly IPV6_PREFIX: string;
}

/** A bucket's answer to one request. */
export interface Decision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the next token, when refused. */
  readonly retryAfter: number;
}

/** The Worker variables, checked. */
interface Settings {
  readonly burst: number;
  readonly perMs: number;
  readonly ipv4Prefix: number;
  readonly ipv6Prefix: number;
}

function number(
  env: Env,
  name: "BURST" | "PER_MINUTE" | "IPV4_PREFIX" | "IPV6_PREFIX",
): number {
  const text = (env[name] ?? "").trim();
  return text === "" ? NaN : Number(text);
}

/** @throws {BoundsError} for a missing or out-of-range variable. */
function settings(env: Env): Settings {
  const perMinute = finite(number(env, "PER_MINUTE"), {
    name: "PER_MINUTE",
    min: 0,
    max: 1_000_000,
  });
  if (perMinute === 0) {
    throw new BoundsError("range", "PER_MINUTE must be greater than 0, got 0");
  }
  return {
    burst: safeInt(number(env, "BURST"), {
      name: "BURST",
      min: 1,
      max: 1_000_000,
    }),
    perMs: perMinute / 60_000,
    ipv4Prefix: safeInt(number(env, "IPV4_PREFIX"), {
      name: "IPV4_PREFIX",
      min: 0,
      max: 32,
    }),
    ipv6Prefix: safeInt(number(env, "IPV6_PREFIX"), {
      name: "IPV6_PREFIX",
      min: 0,
      max: 128,
    }),
  };
}

/** One network's token bucket. */
export class Bucket extends DurableObject<Env> {
  readonly #settings: Settings;
  #tokens: number;
  #at = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#settings = settings(env);
    this.#tokens = this.#settings.burst;
  }

  #refill(): void {
    const now = Date.now();
    this.#tokens = Math.min(
      this.#settings.burst,
      this.#tokens + (now - this.#at) * this.#settings.perMs,
    );
    this.#at = now;
  }

  take(): Decision {
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(this.#tokens),
        retryAfter: 0,
      };
    }
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((1 - this.#tokens) / this.#settings.perMs / 1000),
    };
  }

  peek(): number {
    this.#refill();
    return Math.floor(this.#tokens);
  }
}

/** The block `address` is charged to. */
function bucketOf(address: IpAddress, settings: Settings): Cidr {
  const ip = address.toIpv4() ?? address;
  return new Cidr(
    ip,
    ip.version === 4 ? settings.ipv4Prefix : settings.ipv6Prefix,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let current: Settings;
    try {
      current = settings(env);
    } catch (error) {
      if (error instanceof BoundsError) {
        return Response.json(
          { error: `ratelimit misconfigured: ${error.message}` },
          { status: 500 },
        );
      }
      throw error;
    }
    const { pathname } = new URL(request.url);
    const peek = /^\/buckets\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && peek !== null) {
      let text: string;
      try {
        text = decodeURIComponent(peek[1]);
      } catch {
        return Response.json(
          { error: "the path is not valid percent-encoding" },
          { status: 400 },
        );
      }
      const address = parseIp(text);
      if (address === null) {
        return Response.json({ error: "not an IP address" }, { status: 400 });
      }
      const bucket = bucketOf(address, current).toString();
      const remaining = await env.BUCKETS.getByName(bucket).peek();
      return Response.json({ bucket, remaining });
    }
    const address = parseIp(request.headers.get("cf-connecting-ip") ?? "");
    if (address === null) {
      return Response.json({ error: "no client address" }, { status: 400 });
    }
    const bucket = bucketOf(address, current).toString();
    const decision = await env.BUCKETS.getByName(bucket).take();
    const headers = {
      "x-ratelimit-bucket": bucket,
      "x-ratelimit-remaining": String(decision.remaining),
    };
    if (!decision.allowed) {
      return Response.json({ error: "slow down", bucket }, {
        status: 429,
        headers: { ...headers, "retry-after": String(decision.retryAfter) },
      });
    }
    return Response.json({ hello: address.toString() }, { headers });
  },
};
