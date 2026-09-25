// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An append-only event log per stream, keyed by ULIDs, in a Durable Object.
 *
 * Each stream is one `EventLog` object holding a SQLite table whose primary
 * key is the event's ULID. Because ULIDs sort by time, the key is also the
 * time index: listing in key order is listing in time order, a time filter
 * is a key range (`encodeTime(since)` padded with the smallest random
 * part), and the last ID seen is a cursor. The object mints IDs with a
 * `monotonicFactory`, so events appended within one millisecond keep the
 * order they arrived in.
 *
 * The log only moves forward: an event may carry its own `at` (epoch
 * milliseconds, for imports), but not one earlier than the newest event,
 * which is refused with a 409.
 *
 * - `POST /streams/<name>/events` with `{"type", "data"?, "at"?}` appends
 *   and returns `{id, at}`.
 * - `GET /streams/<name>/events?since=<ms>&after=<id>&limit=<n>` lists
 *   events oldest first; `next` is the cursor for the next page, or null.
 *
 * ```sh
 * buck2 run root//src/celld/ulid/examples:events-dev
 * curl -sS -X POST localhost:9876/streams/orders/events -d '{"type": "created"}'
 * curl -sS 'localhost:9876/streams/orders/events?limit=10'
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import {
  decodeTime,
  encodeTime,
  isUlid,
  monotonicFactory,
  ulidFromBytes,
  ulidToBytes,
} from "@celld/ulid";

/** One stored event. */
export interface LoggedEvent {
  readonly id: string;
  readonly at: number;
  readonly type: string;
  readonly data: unknown;
}

/** What `append` answers: the new event's key, or why there is none. */
export type Appended =
  | { readonly ok: true; readonly id: string; readonly at: number }
  | { readonly ok: false; readonly error: string };

interface Env {
  readonly EVENTS: DurableObjectNamespace<EventLog>;
}

/** The ULID right after `id`: the same time, the random part plus one. */
function successor(id: string): string {
  const bytes = ulidToBytes(id);
  let i = 15;
  while (i >= 6 && bytes[i] === 255) bytes[i--] = 0;
  if (i < 6) throw new Error(`no ULID follows ${id} within its millisecond`);
  bytes[i]++;
  return ulidFromBytes(bytes);
}

/** The log of one stream. */
export class EventLog extends DurableObject<Env> {
  readonly #next = monotonicFactory();
  #last: string | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL)",
    );
    const rows = sql.exec<{ id: string }>(
      "SELECT id FROM events ORDER BY id DESC LIMIT 1",
    ).toArray();
    this.#last = rows[0]?.id ?? null;
  }

  append(event: { type: string; data?: unknown; at?: number }): Appended {
    const at = event.at ?? Date.now();
    if (this.#last !== null && at < decodeTime(this.#last)) {
      return {
        ok: false,
        error: `the log only moves forward; its newest event is at ${
          decodeTime(this.#last)
        }`,
      };
    }
    let id = this.#next(at);
    // A new object (after a restart, say) has a new factory, which knows
    // nothing of the stored IDs; within the newest event's millisecond it
    // could mint a smaller one.
    if (this.#last !== null && id <= this.#last) id = successor(this.#last);
    this.ctx.storage.sql.exec(
      "INSERT INTO events (id, type, data) VALUES (?, ?, ?)",
      id,
      event.type,
      JSON.stringify(event.data ?? null),
    );
    this.#last = id;
    return { ok: true, id, at: decodeTime(id) };
  }

  list(query: { from: string; after: string; limit: number }): LoggedEvent[] {
    return this.ctx.storage.sql.exec<
      { id: string; type: string; data: string }
    >(
      "SELECT id, type, data FROM events WHERE id >= ? AND id > ? ORDER BY id LIMIT ?",
      query.from,
      query.after,
      query.limit,
    ).toArray().map(({ id, type, data }) => ({
      id,
      at: decodeTime(id),
      type,
      data: JSON.parse(data),
    }));
  }
}

function error(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

async function append(log: DurableObjectStub<EventLog>, request: Request) {
  const body = await request.json().catch(() => null) as
    | { type?: unknown; data?: unknown; at?: unknown }
    | null;
  if (typeof body?.type !== "string" || body.type === "") {
    return error("expected {type, data?, at?}");
  }
  if (body.at !== undefined) {
    try {
      encodeTime(body.at as number);
    } catch (cause) {
      return error((cause as Error).message);
    }
  }
  const appended = await log.append({
    type: body.type,
    data: body.data,
    at: body.at as number | undefined,
  });
  return appended.ok
    ? Response.json({ id: appended.id, at: appended.at }, { status: 201 })
    : error(appended.error, 409);
}

async function list(log: DurableObjectStub<EventLog>, url: URL) {
  const params = url.searchParams;
  const limit = Number(params.get("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return error("limit is an integer from 1 to 1000");
  }
  let after = "";
  const cursor = params.get("after");
  if (cursor !== null) {
    if (!isUlid(cursor)) return error("after is a ULID");
    after = cursor.toUpperCase();
  }
  // Every ID at `since` or later sorts at or after its time part followed
  // by the smallest random part, so a time filter is a key range.
  let from = "";
  const since = params.get("since");
  if (since !== null) {
    try {
      from = encodeTime(Number(since)) + "0".repeat(16);
    } catch (cause) {
      return error((cause as Error).message);
    }
  }
  const events = await log.list({ from, after, limit });
  return Response.json({
    events,
    next: events.length === limit ? events.at(-1)!.id : null,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/streams\/([a-z0-9-]{1,64})\/events$/.exec(url.pathname);
    if (match === null) return error("not found", 404);
    const log = env.EVENTS.getByName(match[1]);
    if (request.method === "POST") return await append(log, request);
    if (request.method === "GET") return await list(log, url);
    return error("method not allowed", 405);
  },
};
