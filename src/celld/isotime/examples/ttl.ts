// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A key-value store whose time-to-live is an ISO 8601 duration, held as a
 * `Temporal.Duration`.
 *
 * `PUT /entries/<key>?ttl=PT10M` stores the body until the TTL runs out;
 * without `ttl`, the `DEFAULT_TTL` variable applies (itself a duration, so
 * configuration reads `P1D` rather than `86400`). `@celld/isotime` checks
 * the text strictly; `Temporal` adds it to the moment of writing, in UTC,
 * so `P1M` written on January 31 expires on the last day of February. A
 * zero or unparseable TTL is refused, and so is a fractional month or
 * year, which has no length.
 *
 * `GET /entries/<key>` returns the value with `x-expires-at` (RFC 3339) and
 * `x-ttl-remaining` (a duration) headers, or 404 once it has expired. Entries
 * live in a `Store` Durable Object, which checks expiry on read and uses
 * its alarm to delete what has expired.
 *
 * ```sh
 * buck2 run root//src/celld/isotime/examples:ttl-dev
 * curl -sS -X PUT 'localhost:9876/entries/greeting?ttl=PT30S' -d 'hello'
 * curl -sS -i localhost:9876/entries/greeting
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { parseDuration } from "@celld/isotime";

interface Env {
  readonly STORE: DurableObjectNamespace<Store>;
  readonly DEFAULT_TTL: string;
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

  async write(key: string, value: string, expires: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO entries (key, value, expires) VALUES (?, ?, ?)",
      key,
      value,
      expires,
    );
    await this.#schedule();
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
    // Waking at least daily keeps the alarm near; celld 0.5.1 panics on one
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
  return Temporal.Instant.compare(expires, now) > 0
    ? expires
    : `a TTL must be longer than zero: ${text}`;
}

/** An instant to the second, as RFC 3339 in UTC. */
function seconds(at: Temporal.Instant): string {
  return at.toString({ smallestUnit: "second" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const store = env.STORE.getByName("default");
    if (url.pathname === "/stats") {
      return Response.json({ stored: await store.count() });
    }
    const match = /^\/entries\/([\w.-]{1,128})$/.exec(url.pathname);
    if (match === null) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const key = match[1];
    const now = Temporal.Now.instant();
    if (request.method === "PUT") {
      const text = url.searchParams.get("ttl") ?? env.DEFAULT_TTL;
      const expires = expiry(text, now);
      if (typeof expires === "string") {
        return Response.json({ error: expires }, { status: 400 });
      }
      await store.write(key, await request.text(), expires.epochMilliseconds);
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
  },
};
