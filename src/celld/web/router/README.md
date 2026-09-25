<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/web/router

A router for celld Workers where the safe thing is the default: every route
needs a principal unless it says otherwise, and the headers, limits, error
bodies, cookies, CSRF checks and CORS are set up so that a handler written
without thinking about them is still safe. It depends only on other `@celld`
libraries.

## Hardening migration and startup

Configuration records reject unknown keys, getters, and wrong primitive types at
construction. Route options have the same exact-key checks in TypeScript,
including pre-bound objects and nested limits/responses. Omit `scopes`/`roles`
when there is no restriction; empty lists are errors. `scopes` means **all**,
`roles` means **any**, and `authorize` must return an actual boolean.
Non-boolean authorization, CORS, nonce, or replay results are opaque programmer
errors.

After registering routes, call `await app.ready()` from your application's
startup/readiness hook before admitting traffic. This probes every configured
JWT/DPoP algorithm and prepares keys; the JWT verifier reuses imported keys on
requests. Custom schemes can implement `ready(): Promise<void>` for their own
dependencies. A failed readiness check must keep the deployment out of service.
The dependency/runtime failure is an operator error, never evidence of a bad
user credential.

Authenticated and credential-refused responses always get
`Cache-Control: private, no-store`, including API keys/custom headers, 400s and
login redirects. Anonymous metadata keeps its explicit caching. Only
`security: { noStore: false }` opts out. Trusted-proxy headers that are missing
or malformed now return 400; untrusted peers' forwarding headers are ignored.

`AuthError` accepts integer 400–499 only; use `HttpError` for dependency/5xx
failures. Error headers are defensive snapshots, scopes are frozen, and JSON
details and principal claims are deeply copied/frozen under resource limits.
Sessions use the same principal validation, validate cookie attributes up front,
and cap the encoded browser cookie. Keyrings allow at most eight keys, each with
32–4096 secret bytes and a distinct case-sensitive ID. `TRACE` and `CONNECT` are
refused. `on(method, path, handler)` now matches the named-method overloads.

Nested CORS preflights select the route using the requested method and intersect
every directly registered `cors()` on its router/route chain. Origin, methods,
request headers, response exposure and credentials can only narrow; max-age is
the minimum. Preflight runs no ordinary middleware, authorization or handler.
Register CORS directly rather than invoking it inside an opaque wrapper:

```typescript
const api = router({ auth: "none" }).use(cors({
  origins: ["https://app.example.com"],
  methods: ["GET", "POST"],
  allowHeaders: ["content-type", "x-request-id"],
}));
const reports = router({ auth: "none" }).use(cors({
  origins: ["https://app.example.com"],
  methods: ["GET"],
  allowHeaders: ["x-request-id"],
  maxAge: 60,
}));
reports.get("/", (c) => c.json({ status: "ready" }));
api.mount("/reports", reports);
```

CORS controls browser access, so it does not replace server authorization.
Regressions for these contracts live in `tests/hardening_test.ts`,
`tests/types_test.ts`, and the existing auth/CORS/cookie/proxy suites.

```python
celld.worker(
    name = "worker",
    main = "src/index.ts",
    srcs = glob(["src/*.ts"]),
    deps = [
        "root//src/celld/web/router:router",
        "root//src/celld/sieve:sieve",
    ],
)
```

| Import                      | What it has                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@celld/web/router`         | `router`, `Context`, middleware, the auth schemes, `cors`, cookies, `HttpError`, `clientIp`, `clientIpForAuthorization`, `csrfToken`, `timingSafeEqual` |
| `@celld/web/router/openapi` | `openapi(app, options)`: an OpenAPI 3.1 document from the routes                                                                                        |
| `@celld/web/router/client` | `defineRoute`, `createClient`, browser-only contracts/error types, and the router's `parsePattern`, `splitPath`, `Trie` matcher |

The core never imports the OpenAPI subpath (and so never
`@celld/sieve/json-schema`).

## Typed browser client

Define each HTTP route once in a schema-only module. This module may import
Sieve and `@celld/web/router/client`, but not a Worker, handlers, credential
verifiers, or auth configuration:

```typescript
// shared/routes.ts
import { v } from "@celld/sieve";
import { defineRoute } from "@celld/web/router/client";

export const routes = {
  user: defineRoute("GET", "/api/users/:id", {
    query: v.object({ detail: v.string().optional() }),
    response: v.object({ id: v.string(), name: v.string() }),
  }),
  create: defineRoute("POST", "/api/users", {
    body: v.object({ name: v.string() }),
    response: v.object({ id: v.string(), name: v.string() }),
    responses: { 201: { description: "Created" } },
  }),
};
```

The server consumes the definitions rather than restating paths or schemas.
`register(definition, handler)` and `register(definition, serverOptions,
handler)` run the existing registration, authentication and validation
pipeline. Server options cannot override shared schemas or body encoding.
Keep the returned registration chain when exporting its type:

```typescript
// server.ts
import { router } from "@celld/web/router";
import { routes } from "./shared/routes.ts";

export const app = router({ auth: "none" })
  .register(routes.user, (c) => c.json({ id: c.params.id, name: "Ada" }))
  .register(routes.create, (c) =>
    c.json({ id: "new-user", name: c.body.name }, { status: 201 }));
export default { fetch: app.fetch };
```

Browser code imports the server **only as a type**. The curried constructor
checks that the shared definitions were registered on that router, and then
infers operation names and input/output types from those definitions:

```typescript
// browser.ts
import type { app } from "./server.ts";
import { routes } from "./shared/routes.ts";
import { createClient } from "@celld/web/router/client";

const api = createClient<typeof app>()(routes, {
  baseUrl: "https://api.example.com",
  credentials: "include",
});
const result = await api.call("user", {
  params: { id: "a/b" },
  query: { detail: "full" },
  signal: new AbortController().signal,
});
if (result.ok) {
  console.log(result.status, result.data.name);
} else if (result.kind === "validation") {
  console.log(result.error.location, result.error.fieldErrors);
} else if (result.kind === "auth") {
  console.log(result.status, result.error.error, result.challenge);
}
```

`createClient(routes, options)` infers the same request/results without the
optional router registration check. Neither constructor imports server code.
The definition is a schema-only boundary, not JSON serialization of arbitrary
Sieve refinement/transform functions; those functions must also be browser-safe.
Inputs use Sieve `Input`, while successful results use `Output`. Response
schemas must validate the JSON wire representation (use idempotent validation
or coercions, not transformations that would change already-parsed server
output a second time).

Params are percent-encoded one segment at a time; wildcards preserve their
segment separators. Dot-only segments are refused because Fetch URL
normalization cannot preserve them. Queries and form bodies retain repeated
array fields; undefined query/form fields are omitted. JSON bodies retain JSON
encoding. The base URL's path is a deployment prefix. Call-specific headers
and credentials override client defaults; credentials default to `same-origin`.
The default `Accept: application/json` selects data on negotiated page routes;
an explicit client/call Accept header is retained.
Automatic redirects are disabled so authentication redirects do not masquerade
as a successful API response. Cookie auth still requires the router's normal
Origin/CSRF policy, and cross-origin calls require its CORS policy.

Successful statuses are checked against declared 2xx `responses` entries
(otherwise 200). Each declared status selects its own response schema, falling
back to `response`; 204, 205 and HEAD have no data. A route without a response
schema accepts Sieve-guarded JSON or text according to its response content type.
The client checks actual network data with Sieve, including router error
envelopes and the complete validation issue/field-error structure:

- `validation`: 400 `validation_failed`, with location, issues and field errors;
- `auth`: 401 or 403, with router error code and `WWW-Authenticate`;
- `http`: other router HTTP errors, including declared error-schema data;
- `response`: malformed or schema-invalid data, undeclared success status, or
  a non-router response (including an authentication redirect);
- `transport` / `cancelled`: fetch/body-read failure or caller cancellation;
- `request`: values that cannot be encoded on the wire.

Every HTTP result retains its status and original `Response` for headers and
request-id inspection (its body has been consumed). Request encoding,
response parsing, and transport failures are returned rather than thrown;
unknown operation names and invalid constructor configuration are programmer
errors. Regression coverage is in `client_test.ts` and `client_types_test.ts`.


## Why it exists

A Worker's `fetch` is a function from a `Request` to a `Response`, and
everything around the handler is left to each Worker: parsing the path, checking
the token, refusing a 10 MB body, remembering `nosniff`, not putting a stack
trace in a 500. Each of those is easy to forget once, and forgetting one is a
vulnerability. The usual routers make the happy path short and leave security to
middleware you have to know to add. This one turns that around: a route is
authenticated unless it is marked public, a router without auth refuses to
register a non-public route at all, and relaxing any default is an explicit,
greppable option.

It is also built for celld's constraints: the matcher walks a segment trie (no
`eval` or `new Function`, which isolates forbid), validation is
[`@celld/sieve`](../../sieve), tokens are [`@celld/sec/jwt`](../../sec/jwt), addresses are
[`@celld/core/ip`](../../core/README.md#celldcoreip), request ids are [`@celld/core/ulid`](../../core/README.md#celldcoreulid), and there are no
npm or JSR imports.

## A quick tour

```typescript
import { RemoteJwks } from "@celld/sec/jwt";
import { cors, jwtBearer, middleware, router } from "@celld/web/router";
import { opaqueIdentity } from "@celld/core/bounds";
import { openapi } from "@celld/web/router/openapi";
import { v } from "@celld/sieve";

interface Env {
  readonly NOTES: KVNamespace;
  // A prepared HMAC-SHA-256 signing key, kept confidential and stable.
  readonly IDENTITY_KEY: CryptoKey;
}

const Note = v.object({
  text: v.string().min(1).max(500),
  tags: v.array(v.string()).default([]),
});

const timing = middleware<{ started: number }>(async (c, next) => {
  c.state.started = Date.now();
  return await next();
});

const app = router<Env>({
  auth: jwtBearer({
    keys: new RemoteJwks("https://auth.example.com/.well-known/jwks.json"),
    issuer: "https://auth.example.com",
    audience: "https://notes.example.com",
    algorithms: ["ES256"],
    typ: "at+jwt",
  }),
})
  .use(cors({ origins: ["https://app.example.com"] }))
  .use(timing);

app.get("/health", { public: true }, (c) => c.json({ ok: true }));

app.get("/notes/:id", { scopes: ["notes:read"] }, async (c) => {
  // c.params: { id: string }; c.principal: Principal (never null here).
  // Own data by a keyed, domain-separated identity, never just `subject`.
  const owner = await opaqueIdentity(c.env.IDENTITY_KEY, "notes.owner", c.principal.key);
  const note = await c.env.NOTES.get(`${owner}:${c.params.id}`, "json");
  return note === null ? c.fail(404, "no such note") : c.json(note);
});

app.post("/notes", { scopes: ["notes:write"], body: Note }, async (c) => {
  // c.body: { text: string; tags: string[] }, already validated
  const owner = await opaqueIdentity(c.env.IDENTITY_KEY, "notes.owner", c.principal.key);
  await c.env.NOTES.put(`${owner}:${c.requestId}`, JSON.stringify(c.body));
  return c.json({ id: c.requestId }, 201);
});

app.get(
  "/openapi.json",
  { public: true },
  () =>
    new Response(DOCUMENT, { headers: { "content-type": "application/json" } }),
);

// Once, after the last route is added; every request serves the same text.
const DOCUMENT = JSON.stringify(
  openapi(app, { info: { title: "Notes", version: "1.0.0" } }),
);

export default { fetch: app.fetch };
```

### Routes

- **Patterns**: literals, `:param` (one non-empty segment) and a final `*rest`
  (the remaining segments, possibly none). `c.params` is typed from the pattern
  (`PathParams<"/a/:x/*y">` is `{ x: string; y: string }`), or from a `params`
  schema. Segments are percent-decoded one at a time, so `%2F` stays inside its
  parameter; bad encoding is a 400.
- **Precedence** is fixed, not registration order: at each segment a literal
  beats a parameter, which beats a wildcard, and matching backtracks when a
  literal branch dead-ends. Two routes with the same method and shape (`/u/:id`
  and `/u/:other`) are a registration error, checked against every route the
  router serves (mounted ones included) each time one is added, which leaves the
  router unchanged when it throws; so `fetch` and `routes()` never meet a
  conflict later. Trailing slashes are not ignored: `/users/` does not match
  `/users`.
- **Methods**: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, and
  `on(method, ...)` for others. A path that matches with the wrong method is a
  405 whose `Allow` lists every method of every route matching the path. `HEAD`
  falls back to `GET` without the body; `OPTIONS` answers 204 with `Allow`
  unless a route handles it.
- **Mounting**: `app.mount("/orgs/:org", orgs)` serves a sub-router's routes
  under a prefix. The child keeps its middleware, its `mapError` and its auth,
  or takes the parent's with `router({ auth: "inherit" })`; it is frozen once
  mounted. `app.routes()` lists everything.
- **Mount rules**, checked on every `mount` (which changes nothing when it
  throws):
  - A parameter name may appear once in the whole flattened route: `/orgs/:id`
    with a child's `/users/:id` is a `RouterError`, since one `c.params.id`
    would silently be the other. A child declares the parameters its prefix will
    supply as its second type argument,
    `router<Env, "org">({ auth: "inherit" })`, and its handlers then see
    `c.params.org` typed; `mount` is a type error when the prefix (with the
    parent's own declared ones) does not supply them. Undeclared, prefix
    parameters still reach `c.params` at runtime, untyped.
  - An `auth: "inherit"` router mounted (at any depth) under a router with
    `auth: "none"` is a `RouterError` unless every one of its routes is
    `public: true`: its private routes would otherwise run anonymously. Its
    handlers see `c.principal` as `Principal | null` unless the route demands
    `scopes`, `roles` or `authorize`, which no anonymous mount can satisfy;
    `router()` only promises a non-null principal when its `auth` is statically
    a scheme or a list of schemes.
  - A mounted router keeps only its `auth` and `mapError`; everything else
    (`limits`, `csrf`, `security`, `cookies`, `clientIp`, `publicUrl`,
    `onError`, `requestId`, `requestIdHeader`, `cors`,
    `allowCleartextCredentialsForDevelopment`) is the serving router's. A router
    made with any of those is a `RouterError` at `mount`, rather than being
    served with its own settings silently dropped (a child's smaller body limit
    or CSRF tokens, say). Put them on the serving router; a route's own `limits`
    travel with the route.
  - Two different scheme objects with one `name` anywhere in the served tree are
    a `RouterError` (two `apiKey()`s with the default name, say): the name is
    the first part of `Principal.key`, so their principals could share keys.
    Give one another `name`; the same scheme object used by several routers is
    fine.
- **Configuration is copied when it is given.** `router(options)`, every route's
  options, scheme lists, the schemes themselves (their `name`, `ambient` flag,
  methods and `openapi`), the scheme factories' options, `cors(...)`, cookies,
  `clientIp` (whose proxies are parsed then, so a bad block throws at once),
  CSRF and security settings are validated, copied and frozen at construction or
  registration; requests only read the copies. Changing the objects you passed
  afterwards changes nothing, and those objects are never frozen in place.
  `app.routes()` returns fresh frozen copies. Schemas and functions are kept by
  reference.

### The context

`c.req` (the request, whose body methods and stream go through the body limit
and `c.signal`; see below), `c.unsafeRequest` (the request exactly as it
arrived, whose body bypasses every limit), `c.url`, `c.publicUrl` (the URL the
client used; see [The public URL](#the-public-url-and-cleartext-credentials)),
`c.env`, `c.ctx` (the `ExecutionContext`), `c.params`, `c.query`, `c.body`,
`c.principal`, `c.state` (typed by middleware), `c.requestId` (a ULID, also sent
as `X-Request-Id`), `c.signal` (aborted with a `TimeoutError` when the time
budget runs out, and with the request's own reason when `c.req.signal` aborts,
as a runtime does when the client disconnects) and `c.route`. Responses:
`c.json`, `c.text`, `c.html`, `c.empty`, `c.redirect` (same origin only unless
`{ external: true }`), plus `c.header` (which throws a `TypeError` at the call,
an opaque 500, for a name or a value with CR, LF or NUL, such as echoed input,
so `fetch` never fails over a header), `c.cookie`, `c.setCookie`,
`c.deleteCookie`, `c.ip()`, `c.readJson()`/`readText()`/`readForm()`/
`readBytes()` (with the limits; `readBytes` takes any `Content-Type`),
`c.accepts(...types)` and `c.fail(status, message)`.

`c.params` has no prototype, so a parameter named `__proto__`, `constructor` or
`prototype` is an ordinary own string. `c.query` is parsed (in one pass) only
when a handler reads it or the route has a `query` schema.

**Bodies and cancellation.** `c.readJson()`, `readText()`, `readForm()` and
`readBytes()`, the route's `body` schema, and `c.req`'s `text()`, `json()`,
`arrayBuffer()`, `bytes()`, `formData()` and `body` stream all read under the
body limit in force (the route's, once one has matched): a declared
`Content-Length` over it is a 413 before reading, and a chunked body is cut off
with a 413 the moment it passes it. All of them stop when `c.signal` aborts,
cancel the request body, and reject with its reason. `c.req` does not apply the
JSON depth and key limits; `readJson` does. `c.unsafeRequest` is the platform's
request, unlimited, for platform properties (`cf`) or a body that must be
streamed on purpose.

**The time budget is cooperative.** When it runs out the router answers 504
`timeout` at once (no `Retry-After`) and aborts `c.signal`; the router's own
body reads and every reader above stop then. JavaScript cannot be interrupted,
though: a handler that ignores `c.signal` (a `fetch` without `signal: c.signal`,
a loop, a Durable Object call) keeps running after the 504, and every side
effect it has issued or still issues happens; only its response is thrown away.
The router itself stops at its next stage boundary: once the budget is spent it
does not start authentication, `authorize`, validation, a route's `use`
middleware or the handler, so a slow credential check (a JWKS fetch, a lookup)
does not go on to run the handler for a client that already has its 504. So a
504 means the outcome is unknown, not that nothing happened: a client must not
simply resend a write after one (make writes idempotent, with a key it repeats).
The router holds the abandoned handler with `c.ctx.waitUntil`, so the runtime
does not cut it off half-way through. Pass `c.signal` to everything that takes
one.

`c.accepts("application/json", "text/html")` is proactive negotiation on
`Accept` (RFC 9110 section 12.5.1): the offered type the header takes with the
highest `q`, each type getting the `q` of its most specific matching range, ties
going to the earlier type, and null when it takes none. With no `Accept` header
the first type wins, so offer the safe default first; a browser
(`text/html,...,*/*;q=0.8`) gets `text/html`, `curl` (`*/*`) the first.

### Middleware

`(c, next) => Response`, onion style. `app.use(mw)` wraps every route of that
router and, on the router serving the request, 404s, 405s and automatic
`OPTIONS` too; it runs **before** authentication, which is where CORS belongs. A
route's `use: [...]` runs **after** authentication and validation, around the
handler, and sees `c.principal` and `c.body`. A route's `before: [...]` runs
once it has matched, **before** the body limit and authentication, for checks
that must answer first (a foreign `Origin` gets its 403 rather than a 401),
without making them router-wide. `middleware<{ user: User }>(fn)` declares what
a middleware adds to `c.state`, and the handlers it wraps see those fields
typed.

### Validation

```typescript
app.post("/items/:id", {
  params: v.object({ id: v.coerce.number().int() }),
  query: v.object({ dry: v.coerce.boolean().optional() }),
  body: v.object({ name: v.string() }),
  bodyType: "json", // or "form" (urlencoded)
  response: v.object({ id: v.number(), name: v.string() }),
}, (c) => c.json({ id: c.params.id, name: c.body.name }));
```

- A failure is a 400 with `location` (`path`, `query` or `body`), sieve's
  flattened `formErrors`/`fieldErrors`, and the `issues` with their full paths.
- The query is given to the schema as an object whose values are strings; a name
  sent twice is a list (so `v.string()` refuses `?q=a&q=b` instead of picking
  one), and a name the schema types as an array is always a list.
- A 2xx `c.json` on a route with a `response` schema is parsed by it: unknown
  keys are stripped, so a stored `passwordHash` cannot leak by accident, and a
  mismatch is a 500. `c.json` is typed with the schema's input.

### Errors

`throw new HttpError(404, "no such note")` answers
`{ "error": "not_found", "message": "no such note", "requestId": "..." }`.
Options add a `code`, headers (`Retry-After`) and extra body fields. 5xx
messages are hidden unless `expose: true`. Anything else thrown is an opaque 500
(`internal error` and the request id, nothing about the error) and goes to
`onError(error, c)`; a Promise it returns is kept alive with `waitUntil`, and a
reporter that throws does not change the answer.

`mapError(error, c)` turns errors into answers before that: set it on a route,
on a router (for its routes, mounted ones included) or both. The route's runs
first, then those of the routers it is mounted in, innermost first, then the
serving router's. The first `Response` answers (with the security headers and
request id like any other); `null` passes the error on; throwing replaces it, so
a hook can rethrow an `HttpError`. A mapped error is not reported to `onError`.

```typescript
const app = router({
  auth: bearer({ verify }),
  // A fixed answer: the upstream's `error.message` can carry its internals,
  // so it stays on the server. A mapped error skips `onError`; log it here
  // if it should be kept.
  mapError: (error, c) =>
    error instanceof GptError
      ? c.json({ error: "upstream_error", kind: error.kind }, 502)
      : null,
});
```

## Secure by default

Every default below, and how to relax it. Relaxing is always an explicit option
at the router or the route.

| Default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | How to relax it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Deny by default.** With auth configured, every route needs a principal (401 with every scheme's challenge, or a scheme's `unauthenticated` answer such as a login redirect).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `public: true` on the route. A public route still checks a credential that is sent: a bad one is refused, never treated as anonymous.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **No auth, no private routes.** `router()` without `auth` throws a `RouterError` when a route that is not `public` is added (at registration, not at request time).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `router({ auth: "none" })`, which also forbids `scopes`/`roles`/`authorize`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Authorization is declarative.** `scopes` (all needed; 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`), `roles` (any one), `authorize(principal, c)`. Contradictions (`public` with `scopes`) are registration errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Leave them out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Credentials never fall through.** A malformed credential is 400 (`invalid_request`), a refused one 401 (`invalid_token`/`invalid_credentials`), with that scheme's challenge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Bearer tokens in the query string are refused** (400), as are two tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `bearer({ allowQuery: true })`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **DPoP-bound tokens need their proof.** A bearer token whose principal has `cnf.jkt` is `invalid_token`. `dpop()` verifies every proof itself (signature by the header key, `htm`, `htu`, `iat`, `ath`, the `cnf.jkt` binding) and requires a replay store; a nonce is an optional additional defense, not a substitute.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `bearer({ allowBound: true })`, or the explicitly replayable `dpop({ unsafeNoReplay: true, ... })` only when single use is enforced elsewhere.                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Credentials never cross plain http.** Every built-in scheme (Basic, bearer, DPoP, API keys, session cookies) refuses a credential sent over http unless the public URL's host is a loopback IP literal: 403 `insecure_transport`, with no challenge, so browsers do not prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `router({ allowCleartextCredentialsForDevelopment: true })`, for development only; behind a TLS proxy, set `publicUrl` instead.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **JWTs need explicit `algorithms`**, `issuer` and `audience`; `sub` and `exp` are required, `none` never works.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `requiredClaims`, `clockTolerance`, `principal` mapping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Security headers on every response**, 404s and errors included: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (and `HTML_CSP` for `text/html`: same-origin scripts, styles, images, fonts and fetches, `form-action 'self'`, `base-uri 'none'`), `Strict-Transport-Security: max-age=63072000; includeSubDomains` when the public URL is https.                                                                                                                                                                                                                                                                                                             | Set the header in the response (the handler's value wins), or `router({ security: { csp: "...", htmlCsp: false, hsts: false, frameOptions: "SAMEORIGIN", ... } })`.                                                                                                                                                                                                                                                                                                                                                                                    |
| **`Cache-Control: private, no-store`** overrides response caching after authentication or credential refusal, including custom headers, malformed credentials and login redirects. Anonymous metadata retains its caching. | `security: { noStore: false }` is the explicit opt-out. |
| **CORS is off.** Directly registered CORS policies are authoritative. Preflight selects the requested method's route and intersects every applicable origin, method, header, credentials and max-age policy before ordinary middleware or authentication. Actual response exposure is also intersected. | `cors({ origins, methods, allowHeaders, exposeHeaders, credentials, maxAge })`; `cors: "passthrough"` permits downstream CORS only when no policy ran. |
| **CSRF checks** apply to state-changing ambient-credential requests; GET/HEAD/OPTIONS are safe, TRACE/CONNECT are refused. Origin/fetch-metadata and optional double-submit tokens are checked. | Explicit `csrf` settings; malformed settings are registration errors. |
| **Double-submit tokens** when asked: the `__Host-csrf` cookie must equal `X-CSRF-Token` or the `_csrf` field of an urlencoded form (compared in constant time). The form is read for the token before the handler whether or not the route has a body schema (once, under the body limit, and kept for the handler's `c.readForm()` or `c.req`; the field is removed before schema validation).                                                                                                                                                                                                                                                                                                                                                                                   | Off unless `csrf: { token: true }` or `{ token: { cookie, header, field } }`; `csrfToken(c)` mints under those names (and throws where tokens are off). `csrf: { source: "header" }` on a route takes the token from the header only and never reads the body for it (JSON, multipart or streamed routes).                                                                                                                                                                                                                                             |
| **Cookies** default to `HttpOnly; Secure; SameSite=Lax; Path=/`; `__Host-`/`__Secure-` prefixes and `SameSite=None` are enforced; values that could inject attributes are refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `c.setCookie(name, value, { ... })`, or `router({ cookies: {...} })`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Sessions are encrypted** (AES-GCM, `__Host-session`, 8 hours); a bad or expired one is a 401 that also clears the cookie.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `session({ encrypt: false })` signs instead; `maxAge`, `cookie`, `cookieOptions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Request limits**: 1 MiB bodies (413 on `Content-Length` before reading, and while streaming, for every reader including `c.req`'s), 32 KiB of headers (431), 16 KiB URLs and 8 KiB queries (414) with at most 256 query fields (400), all checked before routing, JSON nested at most 32 deep with at most 1000 keys (400, checked before `JSON.parse`), 30 s per request, at most `maxTimeout` (5 minutes) for any route (504, outcome unknown, `c.signal` aborted and the handler held with `waitUntil`; the budget ends when the handler returns its response, so a streamed body is not cut off).                                                                                                                                                                           | `router({ limits: {...} })` (`body`, `headers`, `jsonDepth`, `jsonKeys`, `timeout`, `maxTimeout`, `maxUrlBytes`, `maxQueryBytes`, `maxQueryFields`); a route's `limits` for `body`, `jsonDepth`, `jsonKeys` and `timeout`. A route's `timeout` replaces the router's, counted from the start of the request, and is at most the serving router's `maxTimeout` (checked when it is added or mounted); `timeout: false` means none of its own, which still ends at `maxTimeout`. A streamed response needs neither: the budget ends when it is returned. |
| **`Content-Type` is enforced** for body schemas (415 with `Accept-Post`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `bodyType: "form"` for urlencoded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Opaque 500s** with the request id; messages, stacks and types never reach the client.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `new HttpError(5xx, msg, { expose: true })`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Client IP ignores `X-Forwarded-For`** unless the peer is in `trustedProxies`; then it is read from the right. `c.ip()`/`clientIp(c)` is informational; `clientIpForAuthorization(c)` is null unless the chain names a client (the peer is untrusted, or a trusted proxy named an untrusted hop), and is what an allow list should use. The peer is `CF-Connecting-IP` by default, which only Cloudflare's edge makes trustworthy, so the default serves `clientIp` alone: `clientIpForAuthorization` is always null, and `publicUrl: { mode: "trusted-proxy" }` is a RouterError, until the source is named (`clientIp.peer` from the platform, or `peerHeader: "cf-connecting-ip"` on Cloudflare's edge). A bad proxy CIDR throws when the router is made.                     | `router({ clientIp: { trustedProxies, peer, peerHeader, forwardedHeader, strict } })`; `strict: true` makes `clientIp` null for an incomplete chain too.                                                                                                                                                                                                                                                                                                                                                                                               |
| **Redirects stay on this origin.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `c.redirect(url, 302, { external: true })`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Responses match their schema** (unknown keys stripped).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Leave out `response`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## The public URL and cleartext credentials

Behind a TLS-terminating proxy the Worker sees an internal URL
(`http://10.0.0.7:8080/notes`), not the one the client used
(`https://api.example.com/notes`). Every decision that depends on the transport
or the origin is made on one URL, `c.publicUrl`, which the router resolves once
per request from `router({ publicUrl })`:

| `publicUrl`                                                                | `c.publicUrl`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ mode: "request" }` (default)                                            | the request URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `{ mode: "fixed", origin: "https://api.example.com" }`                     | that origin with the request's path and query                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `{ mode: "trusted-proxy", trustedProxies: ["10.0.0.0/8"], proto?, host? }` | Only configured trusted peers may supply forwarding metadata. Missing or malformed configured headers return 400. From other peers they are ignored. A component explicitly set to false uses the request URL's corresponding component. Configure the peer source from a platform-controlled value; client-provided headers cannot identify a trusted proxy. |
| `(c) => URL`                                                               | what the function returns, once, before middleware (anything but a `URL` is a 500)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Nothing is read from `X-Forwarded-*` unless a trusted proxy sent it: a client
that can reach the Worker directly can write those headers. The settings are
validated when the router is made (a `fixed` origin with a path, a bad CIDR, or
an unknown mode throws).

`c.publicUrl` decides:

- **the cleartext rule.** `basic`, `bearer`, `dpop`, `apiKey` and `session`
  refuse a credential they found when `c.publicUrl` is plain http, unless its
  host is a loopback IP literal (`127.0.0.0/8`, `[::1]`; not the name
  `localhost`): 403 `insecure_transport`, with no challenge. A request without a
  credential is the usual 401.
  `router({ allowCleartextCredentialsForDevelopment: true })` lifts the rule for
  every scheme, and is for development only. `dpop`'s own `publicUrl` option,
  when given, replaces the router's for that scheme (its `htu` and its transport
  check). A custom scheme applies the same rule with the exported
  `cleartextRefusal(c, "what")` once it has found its credential
  (`isLoopbackLiteral(host)` is the loopback test);
- **CSRF**: the `Origin` a same-origin request must carry;
- **HSTS**: sent when `c.publicUrl` is https;
- **DPoP `htu`**, and **`c.redirect`**'s same-origin check.

## Authentication

An `AuthScheme` has a `name`, `authenticate(c)` returning a principal, null ("no
credential of mine") or an `AuthError` (a `Challenge`), an optional
`challenge(error, c)` for `WWW-Authenticate`, a required `ambient` flag for CSRF
(`true` for cookies and Basic, `false` for a header the client sets itself;
leaving it out is a `RouterError`, since a guess of "not ambient" would turn
CSRF off for a cookie scheme), and an OpenAPI security scheme.
`router({ auth: [a, b] })` tries them in order: the first principal wins, the
first error ends the request, and when all return null a non-public route gets a
401 with every challenge.

**Unauthenticated answers.** A scheme may have `unauthenticated(c)`, returning a
`Response`, null or undefined. When no scheme found a credential on a route that
needs one, the route's schemes are asked in order and the first `Response` is
the answer instead of the 401 (a 302 to a login page for a browser `GET` that
accepts `text/html`, say); if none returns one, it is the 401. It is never asked
about a malformed or refused credential, which stays that scheme's 400 or 401,
nor on a public route. The answer still gets the security headers,
`Cache-Control:
no-store` and the headers set with `c.header`.

**AuthErrors after authentication.** A handler, a route's `use` middleware or
`authorize` may throw an `AuthError`, such as an `insufficient_scope` that only
the body reveals:
`throw new AuthError("insufficient_scope", "this tool needs notes:write", { scope: ["notes:write"] })`.
Once a route has matched, the answer is built as the router's own 401s and 403s
are: the error's status, JSON body and `headers`, and the challenge that the
scheme that authenticated the request writes for it (`realm`,
`resource_metadata` and `scope` included, in the usual order). When the request
is anonymous (a public route), every route scheme's challenge is sent without
the error's `error`, `error_description` or `scope`, since RFC 6750 section 3.1
says a request that carried no credentials gets no error information; the status
and JSON body are still the error's. Headers the scheme returned with the
principal (a `DPoP-Nonce`) stay on the answer. With `auth: "none"`, or from
router middleware before a route matches, there is no challenge.

A route cannot ask whether auth applies to it: under `auth: "none"`
`c.principal` is always null, the same as an anonymous caller on a public route.
Code that grants access by principal (per-tool scopes, say) should fail closed
on a null principal, as `@celld/mcp` does, rather than treat "no auth
configured" as "everything allowed".

A `Principal` has `subject`, `scopes`, `roles`, `claims`, `scheme`, and
optionally `clientId`, `tenant`, `issuer`, `tokenType`, `expiresAt` (epoch
milliseconds) and `cnf.jkt`. It is frozen. Its `key` is the ownership
fingerprint: `scheme`, `issuer`, `tenant`, `clientId` and `subject` (absent ones
empty) joined with NUL, which no part may contain. **Anything that records who
owns something (a task, sealed state, a session) must store and compare `key`,
never `subject`**: the same `sub` from two issuers, schemes, tenants or clients
is two different callers. `jwtVerifier` fills `issuer` from `iss` and
`expiresAt` from `exp`; `bearer` and `dpop` set `tokenType` when the verifier
does not. `scheme` is always the name of the scheme that authenticated the
request: a scheme or verifier that returns another `scheme` is a 500 (it would
pick another key's first part). Only `session()` carries the scheme its
principal logged in with, which it sealed in the cookie.
`toPrincipal(input, scheme)` builds one from what a scheme returns, as the
router does (for tests, or for calling code on a principal's behalf). What a
scheme returns may also carry `headers`, which go on whatever response the
request gets, the handler's or a later error (a 403 for a scope, a 400 from
validation), as `c.header` sets them; they are not part of the principal. A
resource server's fresh `DPoP-Nonce` travels this way.

| Scheme                                                                                       | Credential                                                                                                                                                                                                                                                                                                                          | Challenges                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bearer({ verify })`                                                                         | `Authorization: Bearer <token>` (RFC 6750)                                                                                                                                                                                                                                                                                          | `Bearer`, `Bearer error="invalid_token"`, `error="invalid_request"` (400), `error="insufficient_scope", scope="..."` (403); `realm` and `resource_metadata` when set |
| `jwtBearer({ keys, issuer, audience, algorithms, typ? })`                                    | a JWT access token, verified with `@celld/sec/jwt`; `typ` defaults to `at+jwt`, preventing another JWT kind from becoming an API credential (`unsafeAllowAnyTokenType: true` is the legacy opt-out); `keys` may be a `RemoteJwks`, while plain JWK/JWKS data is copied when the scheme is made; a missing or empty `issuer`, `audience` or `algorithms` is a `RouterError`, never "any"; an unreachable key set or unsupported runtime algorithm is a 503 for `onError`; await `app.ready()` before serving | as `bearer`, with short reasons (`the access token expired`, `... is for another audience`)                                                                          |
| `dpop({ verify, replay, nonce?, algs?, publicUrl?, maxAgeSec?, clockToleranceSec?, now? })` | `Authorization: DPoP <token>` + one `DPoP` proof (RFC 9449), verified by the scheme; `unsafeNoReplay: true` is the explicit replayable mode                                                                                                                                                                                           | `DPoP algs="ES256 RS256 PS256"`, `error="invalid_dpop_proof"`, `use_dpop_nonce` with `DPoP-Nonce`; `realm` and `resource_metadata` when set                          |
| `apiKey({ header \| query, lookup })`                                                        | a key in `x-api-key` (or the header/parameter given)                                                                                                                                                                                                                                                                                | `ApiKey realm="api", header="x-api-key"`                                                                                                                             |
| `basic({ verify })`                                                                          | `Authorization: Basic` (RFC 7617, UTF-8)                                                                                                                                                                                                                                                                                            | `Basic realm="api", charset="UTF-8"` (never over plain http)                                                                                                         |
| `session({ keys })`                                                                          | the `__Host-session` cookie; `issue(c, principal)` keeps the principal's `scheme` and `issuer`, so its `key` survives login; the principal's `expiresAt` is the session's expiry                                                                                                                                                    | none (a 401 clears the cookie)                                                                                                                                       |

**Challenge parameters.** `bearer`, `dpop` and `jwtBearer` take `realm` and
`resourceMetadata`; the second is RFC 9728's `resource_metadata`, the URL of the
Protected Resource Metadata a client discovers its authorization servers from.
Both go on every challenge those schemes send, the 403 `insufficient_scope` one
included, in the order `realm`, the scheme's own (`algs`), `error`,
`error_description`, `scope`, `resource_metadata`.
`challengeParams(options, error, leading)` builds that list for a custom
scheme's `challenge`. `formatChallenge` writes every value as a quoted string,
escaping `"` and `\` and replacing characters a header cannot carry with `?`.

**API keys** should be stored hashed: `hashApiKey(key)` is the hex SHA-256, and
`hashedKeys({ "<hash>": principal })` is a ready `lookup`. Keys should be long
and random, which is what makes a fast hash enough.

**Token verifiers and `@celld/sec/oauth`.** `bearer` and `dpop` do the HTTP parsing
and challenges and hand the access token to a `TokenVerifier`, which gets
`{ token, scheme, method, url, request, context }` and returns a principal (with
`cnf.jkt` for a bound token, and any response `headers`), null, or an
`AuthError` (whose `headers` go on the error). `jwtVerifier(options)` is the JWT
one and requires `typ: "at+jwt"` by default; legacy untyped issuers require the
explicit `unsafeAllowAnyTokenType: true` opt-out. A verifier never sees a DPoP
proof; token introspection belongs to
`@celld/sec/oauth`, whose `@celld/sec/oauth/router` subpath plugs its `ResourceServer`
into these hooks; the router does not depend on it.

**DPoP.** `dpop()` verifies the proof itself, so
`dpop({ verify: jwtVerifier({...}), replay })` is a complete RFC 9449 resource
server. In order: one proof of at most 8 KiB; `typ` `dpop+jwt`; an `alg` from
`algs` (asymmetric only: ES, PS, RS and EdDSA; default ES256, RS256, PS256); a
header `jwk` that is a public key (no private members, never `oct`) and whose
signature verifies; `jti` (at most 256 characters), `htm` equal to the method,
`htu` equal to the request's public URL (`c.publicUrl`, or the scheme's own
`publicUrl(c)` override; scheme, host and path compared after normalization,
query and fragment ignored), `iat` at most `maxAgeSec` (default 60) old and not
in the future, both within `clockToleranceSec` (default 5); `ath` equal to
base64url(SHA-256(token)); the nonce, when a `nonce` strategy is set; then
`verify` checks the token, which must be bound (`cnf.jkt`) to the proof key's
RFC 7638 thumbprint; last, with `replay`, the `jti` is claimed once, so a proof
refused for another reason does not use it up. Every proof failure is 401
`invalid_dpop_proof`.

A safe `dpop` scheme needs `replay`, a `ReplayStore` (`claim(key, expiresAt)`,
the shape of `@celld/sec/oauth/dpop`'s stores, so a Durable Object store fits;
an entry is live while `now <= expiresAt`, the last millisecond included, which
is the last millisecond the scheme accepts the proof, so a store that forgets
it at `expiresAt` itself lets the proof be replayed once). `nonce`, a
`DpopNonceStrategy` (`{ issue(), check(nonce) }`), may be used alongside the
store: a proof without a nonce `check` accepts is `use_dpop_nonce` with a fresh
`DPoP-Nonce`, and every answer to a DPoP request carries the next one. A server
nonce limits pre-generation but is reusable and does not make a captured proof
single-use. Omitting the store therefore requires `unsafeNoReplay: true`, which
explicitly accepts an exact proof again throughout its `iat`/nonce window and
is appropriate only when another layer atomically enforces single use.
`unsafeMemoryReplayStore()` is for tests and development only: it lives in one
isolate, so another isolate accepts the same proof; it is bounded and refuses
new claims when full.

```ts
const app = router({
  auth: dpop({
    verify: jwtVerifier({ keys, issuer, audience, algorithms: ["ES256"] }),
    replay: durableReplayStore, // shared by every isolate
  }),
  // Behind a proxy: htu, the cleartext rule, CSRF and HSTS all use it.
  publicUrl: { mode: "fixed", origin: "https://api.example.com" },
});
```

**Cookies.** `cookieKeys([{ id, secret }, ...])` is a keyring, newest first:
`sign`/`verify` (HMAC-SHA256, `s1.<kid>.<value>.<mac>`) and `seal`/`unseal`
(AES-256-GCM, `e1.<kid>.<iv>.<data>`). The cookie's name is bound into the MAC
and the associated data. Older keys still open values (`stale: true`), and
`session` re-seals those with the current key, so a secret rotates without
logging anyone out. Secrets need 32 bytes.

**Timing-safe comparisons.** `timingSafeEqual(a, b)` compares every byte
(lengths may differ observably); `secretEquals(a, b)` compares HMACs under a
random key and leaks neither position nor length.

Durations (`maxAge`, `timeout`) are checked after conversion to milliseconds:
finite and not negative, a request `timeout` at most the router's
`limits.maxTimeout` (default 5 minutes, itself at most 2^31 - 1 ms, the longest
timer), and a cookie's `maxAge` (sessions' included) at most 400 days, the most
a browser keeps one (RFC 6265bis); an `expires` further away is written as 400
days from now. They are seconds or ISO 8601 strings without years or months
(`"PT8H"`, `"P30D"`), read with `Temporal.Duration`.

## OpenAPI

`openapi(app, { info, servers?, exclude? })` writes an OpenAPI 3.1 document:
paths (`:id` as `{id}`), path and query parameters (named `params` and `query`
schemas are expanded into their properties) and request bodies from the schemas
as `parse` accepts them, responses, the schemes as `components.securitySchemes`,
and per-operation security (`[{}, ...]` for public routes that accept a
credential). Named sieve schemas (`.meta({ id })`) become `components.schemas`.
Generate it once, after the last route is added, and serve that text: nothing
about it changes per request.

It is meant to say exactly what the router does, and throws a `RouterError`
rather than write something else:

- **Security requirements.** A requirement lists the route's scopes only for
  `oauth2` and `openIdConnect` schemes, as OpenAPI defines; for `http` (bearer,
  Basic, DPoP) and `apiKey` schemes it is empty, and the route's scopes are its
  `x-required-scopes`. Two different security schemes under one name (a mounted
  router's `bearer` against the parent's, say) are an error.
- **Paths.** Routes whose paths differ only in parameter names (`/users/:id` and
  `/users/:uid`), or a parameter against a wildcard of the same name, are one
  OpenAPI path; they are an error instead of two keys that clients would read as
  different.
- **Responses.** A route's `responses: { 201: { description, schema? } }` lists
  its answers (a 2xx entry without a `schema` takes the route's `response`
  schema, except 204, 205 and 304); without a 2xx entry the document says `200`.
  The errors the router itself answers are added where they can happen, unless
  listed: 400 (schemas), 401 (any auth scheme), 403 (`scopes`, `roles` or
  `authorize`), 413 and 415 (a body).
- **Components.** Names must match `^[A-Za-z0-9._-]+$` (else an error),
  references are JSON Pointers with `~` and `/` escaped, and the component maps
  have no prototype, so a schema named `__proto__` is an ordinary key. Two
  different schemas under one name are an error. That includes one named sieve
  schema (`.meta({ id })`) used both as input (a `body`, `query` or `params`)
  and as a `response` when its input and output JSON Schemas differ (a default,
  a coercion or a transform): name the two forms differently, or use it on one
  side only.

## What it does not protect against

- **Guessing.** Nothing limits attempts: `basic`, `apiKey` and a login route
  answer every guess. Long random API keys (32 bytes) make guessing hopeless;
  passwords are not, so rate-limit login and Basic routes yourself (a Durable
  Object counter per account and per address, or the platform's rate limiting).
- **Stolen bearer tokens.** A `bearer` or `jwtBearer` token works for whoever
  holds it until it expires. Only a DPoP-bound token (`dpop()`, with `cnf.jkt`)
  needs the client's private key as well.
- **Revoking a session.** A `session` cookie is the whole session, sealed; the
  server keeps nothing. `clear(c)` (logout) deletes the browser's copy only, and
  a copy taken earlier stays valid until its `maxAge` (8 hours by default) runs
  out. Revoking one session needs server-side state (a session id in the claims,
  checked in `authorize` against a store); dropping a key from `keys` ends every
  session sealed with it.
- **A spoofed peer.** The default peer, `CF-Connecting-IP`, is set by
  Cloudflare's edge; anywhere else a client can send it, and with it choose its
  own `clientIp` and, under `trusted-proxy`, its public URL. Give
  `clientIp.peer` from the platform there.

## Examples

[`examples/`](examples) has tested Workers: a CRUD API with OpenAPI, JWT access
tokens against a JWKS, a cookie-session app with CSRF, CORS for a SPA, and an
API-key webhook receiver.

## Tests

```sh
buck2 test root//src/celld/web/router/...
```

One suite per concern under `tests/`: routing and precedence, auth and
deny-by-default, each scheme's success and failure paths with exact
`WWW-Authenticate` values, validation and limits, security headers and errors,
CORS, CSRF, cookies and key rotation, client IPs and timing-safe comparison,
OpenAPI, and `types_test.ts`, whose assertions are types
(`const _: Equal<A, B> = true`), so `deno check` fails when inference regresses.
