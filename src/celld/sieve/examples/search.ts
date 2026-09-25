// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Query strings parsed into typed filters.
 *
 * A query string is all text, and a key can repeat. `GET /search` turns
 * `URLSearchParams` into an object (a repeated key becomes a list) and
 * parses it with `Query`:
 *
 * - `v.coerce.number()` reads `limit` and `page` from text, with bounds
 *   and defaults;
 * - `archived` is `true` or `false`. `v.coerce.boolean()` would read the
 *   text `"false"` as true (it is `Boolean(text)`), so this uses an enum
 *   and a transform;
 * - `tag` may repeat, so a lone value is wrapped into a list first with
 *   `v.preprocess`;
 * - `from` and `to` are ISO dates, and a `.check` on the whole object
 *   blames `to` when the range runs backwards;
 * - `network` is an IPv4 CIDR block, checked by `@celld/ip`.
 *
 * The answer echoes the parsed filters (a real handler would query with
 * them). Unknown keys are refused, so a misspelled filter is a 400 rather
 * than silently ignored.
 *
 * ```sh
 * buck2 run root//src/celld/sieve/examples:search-dev
 * curl -sS 'localhost:9876/search?q=disk&tag=ops&tag=prod&limit=50'
 * curl -sS 'localhost:9876/search?limit=500&archived=maybe'
 * ```
 *
 * @module
 */

import { v } from "@celld/sieve";

const list = (value: unknown) =>
  value === undefined || Array.isArray(value) ? value : [value];

const Query = v.strictObject({
  q: v.string().trim().min(1).max(100).optional(),
  tag: v.preprocess(list, v.array(v.string().toLowerCase().min(1)).max(10))
    .default([]),
  archived: v.enum(["true", "false"]).transform((text) => text === "true")
    .default(false),
  limit: v.coerce.number().int().min(1).max(100).default(20),
  page: v.coerce.number().int().positive().default(1),
  from: v.iso.date().optional(),
  to: v.iso.date().optional(),
  network: v.cidrv4().optional(),
  sort: v.enum(["newest", "oldest", "relevance"]).default("relevance"),
}).check(({ value, addIssue }) => {
  if (
    value.from !== undefined && value.to !== undefined && value.to < value.from
  ) {
    addIssue({ message: "must not be before from", path: ["to"] });
  }
});

/** The query as an object; a key given more than once is a list. */
function entries(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/search") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const parsed = Query.safeParse(entries(url.searchParams));
    if (!parsed.success) {
      return Response.json(parsed.error.flatten(), { status: 400 });
    }
    return Response.json({ filters: parsed.data });
  },
};
