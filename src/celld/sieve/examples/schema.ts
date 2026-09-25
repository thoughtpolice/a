// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An API that publishes the JSON Schema of what it accepts.
 *
 * The schemas live in their own library, `@sieve-example/api` (`api.ts`).
 * The Worker parses requests with them, and the build writes their JSON
 * Schema with `sieve_json_schema` (from `//src/celld/sieve:defs.bzl`),
 * which the project ships as a static asset:
 *
 * - `GET /schema.json` is that build-time file, served from the assets
 *   before the Worker runs: every named schema under `$defs`.
 * - `GET /schemas/<Name>` builds one schema's document at request time with
 *   `toJSONSchema`; `?io=input` describes what parsing accepts (defaults
 *   optional) rather than what it returns.
 * - `GET /schema-check` fetches the asset through the `ASSETS` binding and
 *   compares it with `toJSONSchemaBundle` over the same module, so a build
 *   that shipped a stale file would say so.
 * - `POST /tickets` and `PATCH /tickets/<id>` parse bodies with `Ticket` and
 *   `TicketPatch`, answering with the parsed value or the issues.
 *
 * ```sh
 * buck2 run root//src/celld/sieve/examples:schema-dev
 * curl -sS localhost:9876/schema.json
 * curl -sS 'localhost:9876/schemas/Ticket?io=input'
 * ```
 *
 * @module
 */

import * as api from "@sieve-example/api";
import { type AnySchema } from "@celld/sieve";
import { toJSONSchema, toJSONSchemaBundle } from "@celld/sieve/json-schema";

interface Env {
  readonly ASSETS: Fetcher;
}

const NAMED: Record<string, AnySchema> = {
  Contact: api.Contact,
  Priority: api.Priority,
  Ticket: api.Ticket,
  TicketPatch: api.TicketPatch,
};

function parse(schema: AnySchema, body: unknown, status: number): Response {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? Response.json(parsed.data, { status })
    : Response.json(parsed.error.flatten(), { status: 400 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const named = /^\/schemas\/(\w+)$/.exec(url.pathname);
    if (request.method === "GET" && named !== null) {
      const schema = Object.hasOwn(NAMED, named[1]) ? NAMED[named[1]] : null;
      if (schema === null) {
        return Response.json({
          error: "no such schema",
          names: Object.keys(NAMED),
        }, {
          status: 404,
        });
      }
      const io = url.searchParams.get("io") === "input" ? "input" : "output";
      return Response.json(toJSONSchema(schema, { io }), {
        headers: { "content-type": "application/schema+json" },
      });
    }
    if (request.method === "GET" && url.pathname === "/schema-check") {
      const shipped = await (await env.ASSETS.fetch(
        new URL("/schema.json", url),
      )).json();
      const built = toJSONSchemaBundle(api);
      return Response.json({
        same: JSON.stringify(shipped) === JSON.stringify(built),
        defs: Object.keys(built.$defs ?? {}),
      });
    }
    if (request.method === "POST" && url.pathname === "/tickets") {
      return parse(
        api.Ticket,
        await request.json().catch(() => undefined),
        201,
      );
    }
    if (request.method === "PATCH" && /^\/tickets\/\d+$/.test(url.pathname)) {
      return parse(
        api.TicketPatch,
        await request.json().catch(() => undefined),
        200,
      );
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
