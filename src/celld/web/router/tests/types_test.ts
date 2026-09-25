// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Compile-time checks: `deno check` fails if inference regresses. Each
// `const _name: true = ...` only compiles when the two types are identical.

import { assertEquals } from "@celld/core/assert";
import {
  type AuthConfig,
  type AuthScheme,
  bearer,
  middleware,
  type ParamNames,
  type PathParams,
  type Principal,
  type RouteLimits,
  router,
} from "@celld/web/router";
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

// DB-RTR-003: an inheriting router does not know its auth until it is
// mounted, so its principal is nullable unless the route demands scopes,
// roles or authorize (which no anonymous mount can satisfy).
const inherits = router({ auth: "inherit" });
inherits.get("/", (c) => {
  const _principal: Equal<typeof c.principal, Principal | null> = true;
  return c.text("x");
});
inherits.get("/scoped", { scopes: ["a"] }, (c) => {
  const _principal: Equal<typeof c.principal, Principal> = true;
  return c.text("x");
});
inherits.get("/roles", { roles: ["a"] }, (c) => {
  const _principal: Equal<typeof c.principal, Principal> = true;
  return c.text("x");
});
inherits.get("/checked", { authorize: () => true }, (c) => {
  const _principal: Equal<typeof c.principal, Principal> = true;
  return c.text("x");
});
inherits.get("/unrestricted", {}, (c) => {
  const _principal: Equal<typeof c.principal, Principal | null> = true;
  return c.text("x");
});
inherits.get("/public", { public: true }, (c) => {
  const _principal: Equal<typeof c.principal, Principal | null> = true;
  return c.text("x");
});
// Never called: the non-null promise is not made for inheriting routers.
const _exactOptions = () => {
  const app = router({ auth: "none" });
  // @ts-expect-error: unknown security option must never be inferred away.
  app.get("/typo", { scope: ["admin"] }, (c) => c.text("x"));
  const typo = { public: true, scope: ["admin"] };
  // @ts-expect-error: a pre-bound object obeys the same exact option contract.
  app.get("/bound", typo, (c) => c.text("x"));
  // @ts-expect-error: nested unknown timeout option.
  app.on("POST", "/nested", { limits: { timeot: 1 } }, (c) => c.text("x"));
  app.get(
    "/response",
    // @ts-expect-error: unknown response metadata.
    { responses: { 200: { description: "ok", schem: {} } } },
    (c) => c.text("x"),
  );
  app.on("PURGE", "/:id", (c) => {
    const _id: string = c.params.id;
    return c.text(_id);
  });
};
const _inheritNonNull = () =>
  router({ auth: "inherit" }).get("/", (c) => {
    // @ts-expect-error: the principal may be null here.
    return c.text(c.principal.subject);
  });

// An `auth` only known as an `AuthConfig` could be "none" or "inherit".
const configured = (): AuthConfig => auth;
const general = router({ auth: configured() });
general.get("/", (c) => {
  const _principal: Equal<typeof c.principal, Principal | null> = true;
  return c.text("x");
});

// WP-07 (DB-RTR-004 carry-over): a router declares the parameter names
// its mount prefixes supply, and its handlers see them typed; `mount`
// refuses a prefix (with its parent's own) that does not supply them.
const members = router<Env, "org">({ auth: "inherit" });
members.get("/users/:user", (c) => {
  const _p: Equal<
    typeof c.params,
    { readonly org: string; readonly user: string }
  > = true;
  return c.text(c.params.org);
});
members.get("/schema/:id", { params: v.object({ id: v.string() }) }, (c) => {
  const _p: Equal<typeof c.params, { id: string }> = true;
  return c.text("x");
});
const tenants = router<Env>({ auth });
tenants.mount("/orgs/:org", members);
// Nested: the outer prefix supplies `org`, the inner one `team`.
const teams = router<Env, "org" | "team">({ auth: "inherit" });
teams.get("/", (c) => c.text(`${c.params.org}/${c.params.team}`));
const orgScoped = router<Env, "org">({ auth: "inherit" });
orgScoped.mount("/teams/:team", teams);
router<Env>({ auth }).mount("/orgs/:org", orgScoped);
// Never called: they only have to fail to compile.
const _wrongPrefix = () =>
  // @ts-expect-error: "/teams/:team" does not supply org.
  router<Env>({ auth }).mount("/teams/:team", members);
const _missingOuter = () =>
  // @ts-expect-error: without an outer "org", "/teams/:team" is not enough.
  router<Env>({ auth: "inherit" }).mount("/teams/:team", teams);

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
  ambient: false,
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
