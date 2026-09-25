// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { v } from "@celld/sieve";
import { router } from "@celld/web/router";
import {
  createClient,
  defineRoute,
  type RouteRequest,
  type RouteSuccess,
} from "@celld/web/router/client";
import type { Equal } from "./fixture.ts";

const lookup = defineRoute("GET", "/users/:id", {
  query: v.object({ search: v.string(), tags: v.array(v.string()).optional() }),
  response: v.object({ name: v.string(), count: v.number() }),
});
const create = defineRoute("POST", "/users", {
  body: v.object({ name: v.string(), active: v.boolean().default(true) }),
  responses: {
    201: { description: "Created", schema: v.object({ id: v.number() }) },
    202: { description: "Queued", schema: v.object({ ticket: v.string() }) },
    204: { description: "No content" },
  },
});
const app = router({ auth: "none" })
  .register(
    lookup,
    (c) => c.json({ name: c.params.id, count: c.query.search.length }),
  )
  .register(create, (c) => c.json({ id: c.body.name.length }, { status: 201 }));
const client = createClient<typeof app>()({ lookup, create }, {
  baseUrl: "https://example.test",
});

const _query: Equal<
  RouteRequest<typeof lookup>["query"],
  { search: string; tags?: string[] | undefined }
> = true;
const _params: Equal<
  RouteRequest<typeof lookup>["params"],
  { readonly id: string }
> = true;
const _body: Equal<
  RouteRequest<typeof create>["body"],
  { name: string; active?: boolean | undefined }
> = true;
const _created: Equal<
  Extract<RouteSuccess<typeof create>, { status: 201 }>["data"],
  { id: number }
> = true;
const _queued: Equal<
  Extract<RouteSuccess<typeof create>, { status: 202 }>["data"],
  { ticket: string }
> = true;
const _empty: Equal<
  Extract<RouteSuccess<typeof create>, { status: 204 }>["data"],
  undefined
> = true;

// Not called: these consumer errors must fail checking, not send requests.
const _consumer = async () => {
  const found = await client.call("lookup", {
    params: { id: "a" },
    query: { search: "ada" },
  });
  if (found.ok) {
    const _name: string = found.data.name;
    // @ts-expect-error: output schema makes this a number.
    const _count: string = found.data.count;
  }
  // @ts-expect-error: the route requires its path parameter.
  client.call("lookup", { query: { search: "ada" } });
  // @ts-expect-error: the query schema requires search.
  client.call("lookup", { params: { id: "a" }, query: {} });
  // @ts-expect-error: unknown operation.
  client.call("missing", {});
  // @ts-expect-error: body schema requires a string name.
  client.call("create", { body: { name: 7 } });
  client.call("lookup", {
    params: { id: "a" },
    query: { search: "a" },
    // @ts-expect-error: GET cannot have this request body.
    body: {},
  });
  const unregistered = defineRoute("GET", "/not-registered", {
    response: v.string(),
  });
  // @ts-expect-error: a type-only router contract refuses routes not registered on it.
  createClient<typeof app>()({ unregistered }, {
    baseUrl: "https://example.test",
  });
  router({ auth: "none" }).register(
    lookup,
    // @ts-expect-error: server options cannot change the schema shared with the browser.
    { response: v.number() },
    (c) => c.text("x"),
  );
};
