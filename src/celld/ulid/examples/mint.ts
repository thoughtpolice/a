// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An ID-minting endpoint, and one that reads an ID back.
 *
 * `POST /ids` with `{"count"?, "at"?}` mints `count` ULIDs (default 1, at
 * most 1000) from one `monotonicFactory` per isolate, so every ID this
 * isolate hands out sorts after the one before, even within one
 * millisecond: the factory adds one to the random part instead of drawing
 * a new one. `at` (epoch milliseconds, default now) is the time to mint at,
 * for callers backfilling records. A time earlier than the factory's last
 * one keeps the last time, which is what keeps the IDs increasing, so the
 * response's `time` is the time the IDs actually carry.
 *
 * `GET /ids/<id>` checks an ID in either case and returns its canonical
 * spelling, its time, and its 128 bits as hex and as a UUID.
 *
 * ```sh
 * buck2 run root//src/celld/ulid/examples:mint-dev
 * curl -sS -X POST localhost:9876/ids -d '{"count": 3}'
 * curl -sS localhost:9876/ids/01arz3ndektsv4rrffq69g5fav
 * ```
 *
 * @module
 */

import {
  canonicalUlid,
  decodeTime,
  MAX_TIME,
  monotonicFactory,
  UlidError,
  ulidToBytes,
  ulidToUuid,
} from "@celld/ulid";

const next = monotonicFactory();

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

async function mint(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as
    | { count?: unknown; at?: unknown }
    | null;
  if (body === null || typeof body !== "object") {
    return badRequest("expected a JSON object");
  }
  const count = body.count ?? 1;
  if (
    !Number.isInteger(count) || (count as number) < 1 ||
    (count as number) > 1000
  ) {
    return badRequest("count is an integer from 1 to 1000");
  }
  if (body.at !== undefined && typeof body.at !== "number") {
    return badRequest(`at is epoch milliseconds from 0 to ${MAX_TIME}`);
  }
  const ids: string[] = [];
  try {
    for (let i = 0; i < (count as number); i++) {
      ids.push(next(body.at as number | undefined));
    }
  } catch (error) {
    if (error instanceof UlidError) return badRequest(error.message);
    throw error;
  }
  const time = decodeTime(ids[0]);
  return Response.json({ ids, time, date: new Date(time).toISOString() });
}

function inspect(text: string): Response {
  let id: string;
  try {
    id = canonicalUlid(text);
  } catch (error) {
    if (error instanceof UlidError) return badRequest(error.message);
    throw error;
  }
  const time = decodeTime(id);
  return Response.json({
    id,
    time,
    date: new Date(time).toISOString(),
    hex: Array.from(ulidToBytes(id), (b) => b.toString(16).padStart(2, "0"))
      .join(""),
    uuid: ulidToUuid(id),
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/ids") {
      return await mint(request);
    }
    const match = /^\/ids\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && match !== null) {
      return inspect(decodeURIComponent(match[1]));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
