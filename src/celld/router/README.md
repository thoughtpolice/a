<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/router

A router for celld Workers where the safe thing is the default: every
route needs a principal unless it says otherwise, and the headers, limits,
error bodies, cookies, CSRF checks and CORS are set up so that a handler
written without thinking about them is still safe. It depends only on
other `@celld` libraries.

```python
celld.worker(
    name = "worker",
    main = "src/index.ts",
    srcs = glob(["src/*.ts"]),
    deps = [
        "root//src/celld/router:router",
        "root//src/celld/sieve:sieve",
    ],
)
```

| Import                  | What it has                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `@celld/router`         | `router`, `Context`, middleware, the auth schemes, `cors`, cookies, `HttpError`, `clientIp`, `timingSafeEqual` |
| `@celld/router/openapi` | `openapi(app, options)`: an OpenAPI 3.1 document from the routes   |

The core never imports the OpenAPI subpath (and so never
`@celld/sieve/json-schema`).

## Why it exists

A Worker's `fetch` is a function from a `Request` to a `Response`, and
everything around the handler is left to each Worker: parsing the path,
checking the token, refusing a 10 MB body, remembering `nosniff`, not
putting a stack trace in a 500. Each of those is easy to forget once, and
forgetting one is a vulnerability. The usual routers make the happy path
short and leave security to middleware you have to know to add. This one
turns that around: a route is authenticated unless it is marked public, a
router without auth refuses to register a non-public route at all, and
relaxing any default is an explicit, greppable option.

It is also built for celld's constraints: the matcher walks a segment
trie (no `eval` or `new Function`, which isolates forbid), validation is
[`@celld/sieve`](../sieve), tokens are [`@celld/jwt`](../jwt), addresses
are [`@celld/ip`](../ip), request ids are [`@celld/ulid`](../ulid), and
there are no npm or JSR imports.

## A quick tour

```typescript
import { RemoteJwks } from "@celld/jwt";
import { cors, jwtBearer, middleware, router } from "@celld/router";
import { openapi } from "@celld/router/openapi";
import { v } from "@celld/sieve";

interface Env {
  readonly NOTES: KVNamespace;
}

const Note = v.object({ text: v.string().min(1).max(500), tags: v.array(v.string()).default([]) });

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
  // c.params: { id: string }; c.principal: Principal (never null here)
  const note = await c.env.NOTES.get(`${c.principal.subject}:${c.params.id}`, "json");
  return note === null ? c.fail(404, "no such note") : c.json(note);
});

app.post("/notes", { scopes: ["notes:write"], body: Note }, async (c) => {
  // c.body: { text: string; tags: string[] }, already validated
  await c.env.NOTES.put(`${c.principal.subject}:${c.requestId}`, JSON.stringify(c.body));
  return c.json({ id: c.requestId }, 201);
});

app.get("/openapi.json", { public: true }, (c) =>
  c.json(openapi(app, { info: { title: "Notes", version: "1.0.0" } })));

export default { fetch: app.fetch };
```

### Routes

- **Patterns**: literals, `:param` (one non-empty segment) and a final
  `*rest` (the remaining segments, possibly none). `c.params` is typed from
  the pattern (`PathParams<"/a/:x/*y">` is `{ x: string; y: string }`), or
  from a `params` schema. Segments are percent-decoded one at a time, so
  `%2F` stays inside its parameter; bad encoding is a 400.
- **Precedence** is fixed, not registration order: at each segment a
  literal beats a parameter, which beats a wildcard, and matching
  backtracks when a literal branch dead-ends. Two routes with the same
  method and shape (`/u/:id` and `/u/:other`) are a registration error.
  Trailing slashes are not ignored: `/users/` does not match `/users`.
- **Methods**: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`,
  and `on(method, ...)` for others. A path that matches with the wrong
  method is a 405 whose `Allow` lists every method of every route matching
  the path. `HEAD` falls back to `GET` without the body; `OPTIONS` answers
  204 with `Allow` unless a route handles it.
- **Mounting**: `app.mount("/orgs/:org", orgs)` serves a sub-router's
  routes under a prefix. The child keeps its middleware and its auth, or
  takes the parent's with `router({ auth: "inherit" })`; it is frozen once
  mounted. `app.routes()` lists everything.

### The context

`c.req`, `c.url`, `c.env`, `c.ctx` (the `ExecutionContext`), `c.params`,
`c.query`, `c.body`, `c.principal`, `c.state` (typed by middleware),
`c.requestId` (a ULID, also sent as `X-Request-Id`), `c.signal` (aborted
with a `TimeoutError` when the time budget runs out, and with the
request's own reason when `c.req.signal` aborts, as a runtime does when
the client disconnects) and `c.route`. Responses: `c.json`,
`c.text`, `c.html`, `c.empty`, `c.redirect` (same origin only unless
`{ external: true }`), plus `c.header`, `c.cookie`, `c.setCookie`,
`c.deleteCookie`, `c.ip()`, `c.readJson()`/`readText()`/`readForm()`/
`readBytes()` (with the limits; `readBytes` takes any `Content-Type`),
`c.accepts(...types)` and `c.fail(status, message)`.

`c.accepts("application/json", "text/html")` is proactive negotiation on
`Accept` (RFC 9110 section 12.5.1): the offered type the header takes with
the highest `q`, each type getting the `q` of its most specific matching
range, ties going to the earlier type, and null when it takes none. With
no `Accept` header the first type wins, so offer the safe default first;
a browser (`text/html,...,*/*;q=0.8`) gets `text/html`, `curl` (`*/*`) the
first.

### Middleware

`(c, next) => Response`, onion style. `app.use(mw)` wraps every route of
that router and, on the router serving the request, 404s, 405s and
automatic `OPTIONS` too; it runs **before** authentication, which is where
CORS belongs. A route's `use: [...]` runs **after** authentication and
validation, around the handler, and sees `c.principal` and `c.body`. A
route's `before: [...]` runs once it has matched, **before** the body
limit and authentication, for checks that must answer first (a foreign
`Origin` gets its 403 rather than a 401), without making them router-wide.
`middleware<{ user: User }>(fn)` declares what a middleware adds to
`c.state`, and the handlers it wraps see those fields typed.

### Validation

```typescript
app.post("/items/:id", {
  params: v.object({ id: v.coerce.number().int() }),
  query: v.object({ dry: v.coerce.boolean().optional() }),
  body: v.object({ name: v.string() }),
  bodyType: "json",                    // or "form" (urlencoded)
  response: v.object({ id: v.number(), name: v.string() }),
}, (c) => c.json({ id: c.params.id, name: c.body.name }));
```

- A failure is a 400 with `location` (`path`, `query` or `body`),
  sieve's flattened `formErrors`/`fieldErrors`, and the `issues` with
  their full paths.
- The query is given to the schema as an object whose values are strings;
  a name sent twice is a list (so `v.string()` refuses `?q=a&q=b` instead
  of picking one), and a name the schema types as an array is always a
  list.
- A 2xx `c.json` on a route with a `response` schema is parsed by it:
  unknown keys are stripped, so a stored `passwordHash` cannot leak by
  accident, and a mismatch is a 500. `c.json` is typed with the schema's
  input.

### Errors

`throw new HttpError(404, "no such note")` answers
`{ "error": "not_found", "message": "no such note", "requestId": "..." }`.
Options add a `code`, headers (`Retry-After`) and extra body fields. 5xx
messages are hidden unless `expose: true`. Anything else thrown is an
opaque 500 (`internal error` and the request id, nothing about the error)
and goes to `onError(error, c)`; a Promise it returns is kept alive with
`waitUntil`, and a reporter that throws does not change the answer.

`mapError(error, c)` turns errors into answers before that: set it on a
route, on a router (for its routes, mounted ones included) or both. The
route's runs first, then those of the routers it is mounted in, innermost
first, then the serving router's. The first `Response` answers (with the
security headers and request id like any other); `null` passes the error
on; throwing replaces it, so a hook can rethrow an `HttpError`. A mapped
error is not reported to `onError`.

```typescript
const app = router({
  auth: "none",
  mapError: (error, c) =>
    error instanceof GptError
      ? c.json({ kind: error.kind, error: error.message }, 502)
      : null,
});
```

## Secure by default

Every default below, and how to relax it. Relaxing is always an explicit
option at the router or the route.

| Default | How to relax it |
| --- | --- |
| **Deny by default.** With auth configured, every route needs a principal (401 with every scheme's challenge, or a scheme's `unauthenticated` answer such as a login redirect). | `public: true` on the route. A public route still checks a credential that is sent: a bad one is refused, never treated as anonymous. |
| **No auth, no private routes.** `router()` without `auth` throws a `RouterError` when a route that is not `public` is added (at registration, not at request time). | `router({ auth: "none" })`, which also forbids `scopes`/`roles`/`authorize`. |
| **Authorization is declarative.** `scopes` (all needed; 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`), `roles` (any one), `authorize(principal, c)`. Contradictions (`public` with `scopes`) are registration errors. | Leave them out. |
| **Credentials never fall through.** A malformed credential is 400 (`invalid_request`), a refused one 401 (`invalid_token`/`invalid_credentials`), with that scheme's challenge. | none |
| **Bearer tokens in the query string are refused** (400), as are two tokens. | `bearer({ allowQuery: true })`. |
| **DPoP-bound tokens need their proof.** A bearer token whose principal has `cnf.jkt` is `invalid_token`. | `bearer({ allowBound: true })`. |
| **Basic refuses plain http** (403 `insecure_transport`, and no challenge, so browsers do not prompt). | `basic({ allowInsecure: true })`. |
| **JWTs need explicit `algorithms`**, `issuer` and `audience`; `sub` and `exp` are required, `none` never works. | `requiredClaims`, `clockTolerance`, `principal` mapping. |
| **Security headers on every response**, 404s and errors included: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (and `HTML_CSP` for `text/html`: same-origin scripts, styles, images, fonts and fetches, `form-action 'self'`, `base-uri 'none'`), `Strict-Transport-Security: max-age=63072000; includeSubDomains` on https. | Set the header in the response (the handler's value wins), or `router({ security: { csp: "...", htmlCsp: false, hsts: false, frameOptions: "SAMEORIGIN", ... } })`. |
| **`Cache-Control: no-store`** on responses to authenticated requests and on 401/403. | Set `Cache-Control` in the response, or `security: { noStore: false }`. |
| **CORS is off.** No CORS headers unless `cors()` is used; it echoes only listed origins, never `null`, adds `Vary: Origin`, answers preflights (403 for others), and `"*"` with `credentials` is a `RouterError`. | `cors({ origins, methods, allowHeaders, exposeHeaders, credentials, maxAge })`, or `origins: "*"` without credentials. |
| **CSRF checks** on state-changing requests (not GET/HEAD/OPTIONS/TRACE) authenticated by an ambient credential (`session`, `basic`, or any scheme with `ambient: true`): `Sec-Fetch-Site` must be `same-origin` or `none`, else `Origin` must be this origin; `null` never passes. | `csrf: { trustedOrigins: [...] }`; `csrf: false` on a route or the router. `csrf: true` on a route checks it without a cookie (login forms). |
| **Double-submit tokens** when asked: the `__Host-csrf` cookie must equal `X-CSRF-Token` or the `_csrf` form field (compared in constant time; the field is removed before validation). | Off unless `csrf: { token: true }`; mint with `csrfToken(c)`. |
| **Cookies** default to `HttpOnly; Secure; SameSite=Lax; Path=/`; `__Host-`/`__Secure-` prefixes and `SameSite=None` are enforced; values that could inject attributes are refused. | `c.setCookie(name, value, { ... })`, or `router({ cookies: {...} })`. |
| **Sessions are encrypted** (AES-GCM, `__Host-session`, 8 hours); a bad or expired one is a 401 that also clears the cookie. | `session({ encrypt: false })` signs instead; `maxAge`, `cookie`, `cookieOptions`. |
| **Request limits**: 1 MiB bodies (413 on `Content-Length` before reading, and while streaming), 32 KiB of headers (431), JSON nested at most 32 deep with at most 1000 keys (400, checked before `JSON.parse`), 30 s per request (503, `c.signal` aborted; the budget ends when the handler returns its response, so a streamed body is not cut off). | `router({ limits: {...} })`; a route's `limits` for `body`, `jsonDepth`, `jsonKeys` and `timeout`. A route's `timeout` replaces the router's, counted from the start of the request; `timeout: false` means none (a long-lived stream). |
| **`Content-Type` is enforced** for body schemas (415 with `Accept-Post`). | `bodyType: "form"` for urlencoded. |
| **Opaque 500s** with the request id; messages, stacks and types never reach the client. | `new HttpError(5xx, msg, { expose: true })`. |
| **Client IP ignores `X-Forwarded-For`** unless the peer (`CF-Connecting-IP`) is in `trustedProxies`; then it is read from the right. A bad proxy CIDR throws. | `router({ clientIp: { trustedProxies, peerHeader, forwardedHeader } })`. |
| **Redirects stay on this origin.** | `c.redirect(url, 302, { external: true })`. |
| **Responses match their schema** (unknown keys stripped). | Leave out `response`. |

## Authentication

An `AuthScheme` has a `name`, `authenticate(c)` returning a principal, null
("no credential of mine") or an `AuthError` (a `Challenge`), an optional
`challenge(error, c)` for `WWW-Authenticate`, an `ambient` flag for CSRF,
and an OpenAPI security scheme. `router({ auth: [a, b] })` tries them in
order: the first principal wins, the first error ends the request, and
when all return null a non-public route gets a 401 with every challenge.

**Unauthenticated answers.** A scheme may have `unauthenticated(c)`,
returning a `Response`, null or undefined. When no scheme found a
credential on a route that needs one, the route's schemes are asked in
order and the first `Response` is the answer instead of the 401 (a 302 to
a login page for a browser `GET` that accepts `text/html`, say); if none
returns one, it is the 401. It is never asked about a malformed or
refused credential, which stays that scheme's 400 or 401, nor on a public
route. The answer still gets the security headers, `Cache-Control:
no-store` and the headers set with `c.header`.

**AuthErrors after authentication.** A handler, a route's `use`
middleware or `authorize` may throw an `AuthError`, such as an
`insufficient_scope` that only the body reveals:
`throw new AuthError("insufficient_scope", "this tool needs notes:write", { scope: ["notes:write"] })`.
Once a route has matched, the answer is built as the router's own 401s
and 403s are: the error's status, JSON body and `headers`, and the
challenge that the scheme that authenticated the request writes for it
(`realm`, `resource_metadata` and `scope` included, in the usual order).
When the request is anonymous (a public route), every route scheme's
challenge is sent without the error's `error`, `error_description` or
`scope`, since RFC 6750 section 3.1 says a request that carried no
credentials gets no error information; the status and JSON body are still
the error's. Headers the scheme returned with the
principal (a `DPoP-Nonce`) stay on the answer. With `auth: "none"`, or
from router middleware before a route matches, there is no challenge.

A route cannot ask whether auth applies to it: under `auth: "none"`
`c.principal` is always null, the same as an anonymous caller on a public
route. Code that grants access by principal (per-tool scopes, say) should
fail closed on a null principal, as `@celld/mcp` does, rather than treat
"no auth configured" as "everything allowed".

A `Principal` has `subject`, `scopes`, `roles`, `claims`, `scheme`, and
optionally `clientId`, `tenant` and `cnf.jkt`. It is frozen.
`toPrincipal(input, scheme)` builds one from what a scheme returns, as the
router does (for tests, or for calling code on a principal's behalf). What a scheme
returns may also carry `headers`, which go on whatever response the
request gets, the handler's or a later error (a 403 for a scope, a 400
from validation), as `c.header` sets them; they are not part of the
principal. A resource server's fresh `DPoP-Nonce` travels this way.

| Scheme | Credential | Challenges |
| --- | --- | --- |
| `bearer({ verify })` | `Authorization: Bearer <token>` (RFC 6750) | `Bearer`, `Bearer error="invalid_token"`, `error="invalid_request"` (400), `error="insufficient_scope", scope="..."` (403); `realm` and `resource_metadata` when set |
| `jwtBearer({ keys, issuer, audience, algorithms, typ? })` | a JWT access token, verified with `@celld/jwt` (`keys` may be a `RemoteJwks`); an unreachable key set is a 503, an accepted algorithm the runtime cannot verify a 500 for `onError` | as `bearer`, with short reasons (`the access token expired`, `... is for another audience`) |
| `dpop({ verify, algs?, nonce? })` | `Authorization: DPoP <token>` + one `DPoP` proof (RFC 9449) | `DPoP algs="ES256 RS256 PS256"`, `error="invalid_dpop_proof"`, `use_dpop_nonce` with `DPoP-Nonce`; `realm` and `resource_metadata` when set |
| `apiKey({ header \| query, lookup })` | a key in `x-api-key` (or the header/parameter given) | `ApiKey realm="api", header="x-api-key"` |
| `basic({ verify })` | `Authorization: Basic` (RFC 7617, UTF-8), https only | `Basic realm="api", charset="UTF-8"` |
| `session({ keys })` | the `__Host-session` cookie | none (a 401 clears the cookie) |

**Challenge parameters.** `bearer`, `dpop` and `jwtBearer` take `realm`
and `resourceMetadata`; the second is RFC 9728's `resource_metadata`, the
URL of the Protected Resource Metadata a client discovers its
authorization servers from. Both go on every challenge those schemes
send, the 403 `insufficient_scope` one included, in the order `realm`,
the scheme's own (`algs`), `error`, `error_description`, `scope`,
`resource_metadata`. `challengeParams(options, error, leading)` builds
that list for a custom scheme's `challenge`. `formatChallenge` writes
every value as a quoted string, escaping `"` and `\` and replacing
characters a header cannot carry with `?`.

**API keys** should be stored hashed: `hashApiKey(key)` is the hex
SHA-256, and `hashedKeys({ "<hash>": principal })` is a ready `lookup`.
Keys should be long and random, which is what makes a fast hash enough.

**Token verifiers and `@celld/oauth`.** `bearer` and `dpop` do the HTTP
parsing and challenges and hand the checking to a `TokenVerifier`, which
gets `{ token, scheme, proof, method, url, request, context }` and returns
a principal (with `cnf.jkt` for a bound token, and any response `headers`),
null, or an `AuthError` (whose `headers` go on the error). `jwtVerifier(options)`
is the JWT one. Token introspection and full DPoP proof verification
(signature, `htm`, `htu`, `ath`, `jti` replay, nonces, the `jkt` binding)
belong to `@celld/oauth`, whose `@celld/oauth/router` subpath plugs its
`ResourceServer` into these hooks; the router does not depend on it. `dpop` refuses a principal
without `cnf.jkt`, so a verifier that forgets the binding fails closed.

**Cookies.** `cookieKeys([{ id, secret }, ...])` is a keyring, newest
first: `sign`/`verify` (HMAC-SHA256, `s1.<kid>.<value>.<mac>`) and
`seal`/`unseal` (AES-256-GCM, `e1.<kid>.<iv>.<data>`). The cookie's name is
bound into the MAC and the associated data. Older keys still open values
(`stale: true`), and `session` re-seals those with the current key, so a
secret rotates without logging anyone out. Secrets need 32 bytes.

**Timing-safe comparisons.** `timingSafeEqual(a, b)` compares every byte
(lengths may differ observably); `secretEquals(a, b)` compares HMACs under
a random key and leaks neither position nor length.

Durations (`maxAge`, `timeout`) are seconds or ISO 8601 strings without
years or months (`"PT8H"`, `"P30D"`), read with `Temporal.Duration`.

## OpenAPI

`openapi(app, { info, servers?, exclude? })` writes an OpenAPI 3.1
document: paths (`:id` as `{id}`), path and query parameters and request
bodies from the schemas as `parse` accepts them, 200 responses from
`response` schemas as it returns them, 400/401/403 where they can happen,
the schemes as `components.securitySchemes`, and per-operation security
with the route's scopes (`[{}, ...]` for public routes that accept a
credential). Named sieve schemas (`.meta({ id })`) become
`components.schemas`.

## Examples

[`examples/`](examples) has tested Workers: a CRUD API with OpenAPI, JWT
access tokens against a JWKS, a cookie-session app with CSRF, CORS for a
SPA, and an API-key webhook receiver.

## Tests

```sh
buck2 test root//src/celld/router/...
```

One suite per concern under `tests/`: routing and precedence, auth and
deny-by-default, each scheme's success and failure paths with exact
`WWW-Authenticate` values, validation and limits, security headers and
errors, CORS, CSRF, cookies and key rotation, client IPs and timing-safe
comparison, OpenAPI, and `types_test.ts`, whose assertions are types
(`const _: Equal<A, B> = true`), so `deno check` fails when inference
regresses.
