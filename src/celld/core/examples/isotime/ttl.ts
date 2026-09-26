// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A key-value store whose time-to-live is an ISO 8601 duration, held as a
 * `Temporal.Duration`.
 *
 * `PUT /entries/<key>?ttl=PT10M` stores the body until the TTL runs out;
 * without `ttl`, the `DEFAULT_TTL` variable applies (itself a duration, so
 * configuration reads `P1D` rather than `86400`). `@celld/core/isotime` checks
 * the text strictly; `Temporal` adds it to the moment of writing, in UTC,
 * so `P1M` written on January 31 expires on the last day of February. A
 * zero or unparseable TTL is refused, and so is a fractional month or
 * year, which has no length, and one longer than `P31D` (so `P1M` always
 * fits), which would keep a value for good. A `DEFAULT_TTL` that is not
 * such a TTL fails every request with a 500 rather than blaming the caller.
 * Values are read under a 64 KiB cap (413 above it), and the store holds at
 * most `MAX_ENTRIES` live keys (default 10,000): a new key past that is a
 * 507 until entries expire, while a stored key can still be replaced. The
 * `Store` object checks and inserts in one synchronous step, so concurrent
 * writers cannot overshoot it. A `MAX_ENTRIES` that is not a whole number
 * from 1 to 1,000,000 fails every request with a 500, as `DEFAULT_TTL` does.
 *
 * `GET /entries/<key>` returns the value with `x-expires-at` (RFC 3339) and
 * `x-ttl-remaining` (a duration) headers, or 404 once it has expired. Entries
 * live in a `Store` Durable Object, which checks expiry on read and uses
 * its alarm to delete what has expired.
 *
 * This is a local demo with no authentication: anyone who can reach the
 * Worker reads and overwrites every entry, and fills the store up to what the
 * caps allow. A deployment puts it behind authentication (see the router
 * examples) and names keys per principal.
 *
 * ```sh
 * buck2 run root//src/celld/core/examples/isotime:ttl-dev
 * curl -sS -X PUT 'localhost:9876/entries/greeting?ttl=PT30S' -d 'hello'
 * curl -sS -i localhost:9876/entries/greeting
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import {
  BoundsError,
  bytes,
  readTextBounded,
  safeInt,
} from "@celld/core/bounds";
import { parseDuration } from "@celld/core/isotime";

const MAX_VALUE = bytes(64 * 1024);
const MAX_TTL = "P31D";
const DEFAULT_MAX_ENTRIES = 10_000;

interface Env {
  readonly STORE: DurableObjectNamespace<Store>;
  readonly DEFAULT_TTL: string;
  /** Live keys the store holds at most; default 10,000. */
  readonly MAX_ENTRIES?: string;
}

/** A value that has not expired, and when it will. */
export interface Entry {
  readonly value: string;
  readonly expires: number;
}

/** Every entry, with its expiry time. */
export class Store extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
  }

  /**
   * Stores `key` unless that would make more than `max` live keys; false
   * when the store is full. The count and the insert run with no await
   * between them, so no other write can come in between.
   */
  async write(
    key: string,
    value: string,
    expires: number,
    max: number,
  ): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM entries WHERE expires <= ?", Date.now());
    const others = sql.exec<{ n: number }>(
      "SELECT count(*) AS n FROM entries WHERE key != ?",
      key,
    ).one().n;
    if (others >= max) return false;
    sql.exec(
      "INSERT OR REPLACE INTO entries (key, value, expires) VALUES (?, ?, ?)",
      key,
      value,
      expires,
    );
    await this.#schedule();
    return true;
  }

  read(key: string): Entry | null {
    const row = this.ctx.storage.sql.exec<{ value: string; expires: number }>(
      "SELECT value, expires FROM entries WHERE key = ? AND expires > ?",
      key,
      Date.now(),
    ).toArray()[0];
    return row ?? null;
  }

  count(): number {
    return this.ctx.storage.sql.exec<{ n: number }>(
      "SELECT count(*) AS n FROM entries",
    ).one().n;
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM entries WHERE expires <= ?",
      Date.now(),
    );
    await this.#schedule();
  }

  async #schedule(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ at: number | null }>(
      "SELECT min(expires) AS at FROM entries",
    ).one().at;
    if (next === null) await this.ctx.storage.deleteAlarm();
    // Waking at least daily keeps the alarm near; celld panics on one
    // set years ahead.
    else {await this.ctx.storage.setAlarm(
        Math.min(next, Date.now() + 86_400_000),
      );}
  }
}

/** When a TTL written at `now` runs out, or why it is not a TTL. */
function expiry(
  text: string,
  now: Temporal.Instant,
): Temporal.Instant | string {
  const ttl = parseDuration(text);
  if (ttl === null) return `not an ISO 8601 duration: ${text}`;
  let expires: Temporal.Instant;
  try {
    expires = now.toZonedDateTimeISO("UTC").add(ttl).toInstant();
  } catch (error) {
    if (error instanceof RangeError) return `a TTL out of range: ${text}`;
    throw error;
  }
  if (Temporal.Instant.compare(expires, now) <= 0) {
    return `a TTL must be longer than zero: ${text}`;
  }
  const longest = now.toZonedDateTimeISO("UTC").add(MAX_TTL).toInstant();
  return Temporal.Instant.compare(expires, longest) > 0
    ? `a TTL may be at most ${MAX_TTL}: ${text}`
    : expires;
}

/** An instant to the second, as RFC 3339 in UTC. */
function seconds(at: Temporal.Instant): string {
  return at.toString({ smallestUnit: "second" });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const now = Temporal.Now.instant();
  // Checked on every request, so a bad setting fails loudly and at once.
  const fallback = expiry(env.DEFAULT_TTL ?? "", now);
  if (typeof fallback === "string") {
    return Response.json({
      error: `ttl misconfigured: DEFAULT_TTL: ${fallback}`,
    }, { status: 500 });
  }
  let maxEntries: number;
  try {
    maxEntries = env.MAX_ENTRIES === undefined
      ? DEFAULT_MAX_ENTRIES
      : safeInt(Number(env.MAX_ENTRIES), {
        name: "MAX_ENTRIES",
        min: 1,
        max: 1_000_000,
      });
  } catch {
    return Response.json({
      error:
        "ttl misconfigured: MAX_ENTRIES is a whole number from 1 to 1000000",
    }, { status: 500 });
  }
  const store = env.STORE.getByName("default");
  if (url.pathname === "/stats") {
    return Response.json({ stored: await store.count() });
  }
  const match = /^\/entries\/([\w.-]{1,128})$/.exec(url.pathname);
  if (match === null) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const key = match[1];
  if (request.method === "PUT") {
    const text = url.searchParams.get("ttl") ?? env.DEFAULT_TTL;
    const expires = expiry(text, now);
    if (typeof expires === "string") {
      return Response.json({ error: expires }, { status: 400 });
    }
    const value = await readTextBounded(request, { maxBytes: MAX_VALUE });
    if (
      !(await store.write(key, value, expires.epochMilliseconds, maxEntries))
    ) {
      return Response.json({
        error: `the store is full: at most ${maxEntries} entries`,
      }, { status: 507 });
    }
    return Response.json({
      key,
      ttl: text,
      expires: seconds(expires),
    }, { status: 201 });
  }
  if (request.method === "GET") {
    const entry = await store.read(key);
    if (entry === null) {
      return Response.json({ error: "no such entry" }, { status: 404 });
    }
    const expires = Temporal.Instant.fromEpochMilliseconds(entry.expires);
    // What is left, rounded up to a second and written in days at most.
    const remaining = now.until(expires).round({
      largestUnit: "days",
      smallestUnit: "seconds",
      roundingMode: "ceil",
    });
    return new Response(entry.value, {
      headers: {
        "x-expires-at": seconds(expires),
        "x-ttl-remaining": remaining.toString(),
      },
    });
  }
  return Response.json({ error: "method not allowed" }, { status: 405 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (cause) {
      if (cause instanceof BoundsError && cause.code === "too_large") {
        return Response.json({ error: "too_large" }, { status: 413 });
      }
      throw cause;
    }
  },
};
