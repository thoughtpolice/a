// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Compile-time checks: `deno check` fails if inference regresses. Each
// `const _name: true = ...` only compiles when the two types are identical.

import { assertEquals } from "@celld/assert";
import {
  type AuthScheme,
  bearer,
  middleware,
  type ParamNames,
  type PathParams,
  type Principal,
  type RouteLimits,
  router,
} from "@celld/router";
import { v } from "@celld/sieve";
import type { Equal } from "./fixture.ts";

const _names: Equal<ParamNames<"/orgs/:org/files/*path">, "org" | "path"> =
  true;
const _params: Equal<PathParams<"/users/:id">, { readonly id: string }> = true;
const _none: Equal<keyof PathParams<"/users">, never> = true;

interface Env {
  readonly NOTES: KVNamespace;
}

const auth = bearer({ verify: () => ({ subject: "a" }) });
const user = middleware<{ user: { name: string } }>(async (c, next) => {
  c.state.user = { name: "ada" };
  return await next();
});
const trace = middleware<{ traceId: string }>(async (c, next) => {
  c.state.traceId = "t";
  return await next();
});

const app = router<Env>({ auth }).use(user);

app.get("/users/:id/files/*path", (c) => {
  const _p: Equal<
    typeof c.params,
    { readonly id: string; readonly path: string }
  > = true;
  const _principal: Equal<typeof c.principal, Principal> = true;
  const _env: Equal<typeof c.env, Env> = true;
  const _state: Equal<typeof c.state.user, { name: string }> = true;
  const _body: Equal<typeof c.body, undefined> = true;
  const _query: Equal<
    typeof c.query,
    Readonly<Record<string, string | readonly string[]>>
  > = true;
  return c.text("x");
});

app.get("/public", { public: true }, (c) => {
  const _principal: Equal<typeof c.principal, Principal | null> = true;
  return c.text("x");
});

app.post("/notes/:id", {
  body: v.object({ text: v.string(), tags: v.array(v.string()).default([]) }),
  query: v.object({ dry: v.coerce.boolean().optional() }),
  params: v.object({ id: v.coerce.number() }),
  response: v.object({ id: v.number() }),
  use: [trace],
}, (c) => {
  const _body: Equal<typeof c.body, { text: string; tags: string[] }> = true;
  const _query: Equal<typeof c.query, { dry?: boolean | undefined }> = true;
  const _params: Equal<typeof c.params, { id: number }> = true;
  const _trace: Equal<typeof c.state.traceId, string> = true;
  const _user: Equal<typeof c.state.user, { name: string }> = true;
  // @ts-expect-error: the response schema types what c.json takes.
  c.json({ id: "not a number" });
  return c.json({ id: c.params.id });
});

const open = router({ auth: "none" });
open.get("/", (c) => {
  const _principal: Equal<typeof c.principal, null> = true;
  return c.text("x");
});

const unset = router();
unset.get("/", { public: true }, (c) => {
  const _principal: Equal<typeof c.principal, Principal | null> = true;
  return c.text("x");
});

const _hook: Equal<
  NonNullable<AuthScheme["unauthenticated"]>,
  (c: Parameters<AuthScheme["authenticate"]>[0]) => Response | null | undefined
> = true;
const _timeout: Equal<
  RouteLimits["timeout"],
  number | string | false | undefined
> = true;

const login: AuthScheme = {
  name: "login",
  authenticate: () => null,
  unauthenticated: (c) => c.redirect("/login"),
};
router({ auth: login }).get(
  "/",
  { limits: { timeout: false } },
  (c) => c.text("x"),
);
// Never called: it only has to fail to compile.
const _badTimeout = () =>
  router({ auth: "none" }).get(
    "/",
    // @ts-expect-error: true is not a timeout.
    { limits: { timeout: true } },
    (c) => c.text("x"),
  );

Deno.test("the type assertions above compiled", () => {
  assertEquals(app.routes().length, 3);
});
