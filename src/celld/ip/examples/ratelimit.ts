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
 * The client address is `CF-Connecting-IP`; see the `firewall` example for
 * `X-Forwarded-For`.
 *
 * ```sh
 * buck2 run root//src/celld/ip/examples:ratelimit-dev
 * curl -sS -i localhost:9876/ -H 'cf-connecting-ip: 192.0.2.10'
 * curl -sS localhost:9876/buckets/2001:db8:1:2::99
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { Cidr, type IpAddress, parseIp } from "@celld/ip";

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

/** One network's token bucket. */
export class Bucket extends DurableObject<Env> {
  #tokens: number;
  #at = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#tokens = this.#burst;
  }

  get #burst(): number {
    return Number(this.env.BURST);
  }

  #refill(): void {
    const now = Date.now();
    const perMs = Number(this.env.PER_MINUTE) / 60_000;
    this.#tokens = Math.min(
      this.#burst,
      this.#tokens + (now - this.#at) * perMs,
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
    const perMs = Number(this.env.PER_MINUTE) / 60_000;
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((1 - this.#tokens) / perMs / 1000),
    };
  }

  peek(): number {
    this.#refill();
    return Math.floor(this.#tokens);
  }
}

/** The block `address` is charged to. */
function bucketOf(address: IpAddress, env: Env): Cidr {
  const ip = address.toIpv4() ?? address;
  const prefix = Number(ip.version === 4 ? env.IPV4_PREFIX : env.IPV6_PREFIX);
  return new Cidr(ip, prefix);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const peek = /^\/buckets\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && peek !== null) {
      const address = parseIp(decodeURIComponent(peek[1]));
      if (address === null) {
        return Response.json({ error: "not an IP address" }, { status: 400 });
      }
      const bucket = bucketOf(address, env).toString();
      const remaining = await env.BUCKETS.getByName(bucket).peek();
      return Response.json({ bucket, remaining });
    }
    const address = parseIp(request.headers.get("cf-connecting-ip") ?? "");
    if (address === null) {
      return Response.json({ error: "no client address" }, { status: 400 });
    }
    const bucket = bucketOf(address, env).toString();
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
