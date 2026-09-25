// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * ULIDs next to a system that stores UUIDs, and one spelling per resource.
 *
 * A ULID is 128 bits, like a UUID, so a table with a `uuid` column can hold
 * ULIDs without a migration: `ulidToUuid` and `ulidFromUuid` copy the bits
 * both ways. This Worker keeps its records in KV under the UUID spelling,
 * the way a legacy store would, and serves them under the ULID.
 *
 * - `PUT /items/<ulid>` with a JSON body stores it (keyed by UUID).
 * - `GET /items/<id>` answers for the canonical ULID. A lower-case ULID, or
 *   the UUID of one, redirects (301) to the canonical URL, so each record
 *   has one address for caches and links; a `PUT` there gets a 308.
 * - `GET /convert/<id>` takes either spelling and returns both, with the
 *   time the ULID carries.
 *
 * `ulidToUuid` copies bits only: the result is usually not a valid RFC 9562
 * UUID of any version, so do not hand it to code that checks versions.
 *
 * ```sh
 * buck2 run root//src/celld/ulid/examples:convert-dev
 * curl -sS localhost:9876/convert/01563e3a-b5d3-d676-4c61-efb99302bd5b
 * curl -sS -i localhost:9876/items/01arz3ndektsv4rrffq69g5fav
 * ```
 *
 * @module
 */

import {
  canonicalUlid,
  decodeTime,
  isUlid,
  ulidFromUuid,
  ulidToUuid,
} from "@celld/ulid";

interface Env {
  readonly ITEMS: KVNamespace;
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** The canonical ULID for either spelling, or null. */
function toUlid(text: string): string | null {
  if (isUlid(text)) return canonicalUlid(text);
  if (UUID.test(text)) return ulidFromUuid(text);
  return null;
}

function notAnId(text: string): Response {
  return Response.json(
    { error: `not a ULID or a UUID: ${JSON.stringify(text)}` },
    { status: 400 },
  );
}

async function item(
  request: Request,
  env: Env,
  url: URL,
  text: string,
): Promise<Response> {
  const id = toUlid(text);
  if (id === null) return notAnId(text);
  if (id !== text) {
    // 308, unlike 301, tells clients to repeat a PUT as a PUT.
    const status = request.method === "GET" ? 301 : 308;
    return Response.redirect(new URL(`/items/${id}`, url).href, status);
  }
  const key = ulidToUuid(id);
  if (request.method === "PUT") {
    const body = await request.text();
    try {
      JSON.parse(body);
    } catch {
      return Response.json({ error: "expected JSON" }, { status: 400 });
    }
    await env.ITEMS.put(key, body);
    return Response.json({ id, key }, { status: 201 });
  }
  const stored = await env.ITEMS.get(key);
  if (stored === null) {
    return Response.json({ error: "no such item" }, { status: 404 });
  }
  return Response.json({ id, key, item: JSON.parse(stored) });
}

function convert(text: string): Response {
  const id = toUlid(text);
  if (id === null) return notAnId(text);
  const time = decodeTime(id);
  return Response.json({
    ulid: id,
    uuid: ulidToUuid(id),
    time,
    date: new Date(time).toISOString(),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, route, text, ...rest] = url.pathname.split("/");
    if (text !== undefined && text !== "" && rest.length === 0) {
      const id = decodeURIComponent(text);
      if (route === "items" && ["GET", "PUT"].includes(request.method)) {
        return await item(request, env, url, id);
      }
      if (route === "convert" && request.method === "GET") return convert(id);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
