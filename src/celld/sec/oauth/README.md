<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/oauth

OAuth 2.1 for celld: a client, a resource server and an authorization server,
with DPoP (RFC 9449) on all three. JWS work is
[`@celld/sec/jwt`](../jwt/README.md)'s and metadata validation is
[`@celld/sieve`](../../sieve/README.md)'s. Outbound fetches of documents a stranger
may name go through [`@celld/http`](../../http/README.md)'s `boundedFetch`, bodies
are read under the caps of [`@celld/core/bounds`](../../core/README.md#celldcorebounds), and address
literals are classified by [`@celld/core/ip`](../../core/README.md#celldcoreip). The
`@celld/sec/oauth/router` subpath also uses [`@celld/web/router`](../../web/router/README.md);
nothing else imports it. There are no other dependencies, no Node APIs and no
`eval`.

```python
celld.library(
    name = "api",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/api",
    deps = ["root//src/celld/sec/oauth:oauth"],
)
```

## Why it exists

`@celld/mcp` grew OAuth support for one protocol: discovery, PKCE, client
registration, a JWT verifier. Every other Worker that talks to an identity
provider, protects an API, or issues its own tokens needs the same pieces, and
some need more (an authorization server, DPoP, device codes, token exchange).
This library is that code made general, with the parts MCP did not need and with
sender-constrained tokens throughout. MCP will move onto it later; OpenID
Connect (`@celld/sec/oidc`) builds on it.

## Subpaths

| Import                      | What it has                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@celld/sec/oauth`          | `ProtocolError`, `OAuthError`, metadata types and URL rules, PKCE, `WWW-Authenticate`, scopes, URNs      |
| `@celld/sec/oauth/client`   | `OAuthClient` (every grant at one server), `OAuthSession` (call a resource), discovery, registration     |
| `@celld/sec/oauth/dpop`     | `DpopKey`, `verifyDpopProof`, `ReplayStore`, `DpopNonceIssuer`, `DpopNonceCache`, `normalizeHtu`         |
| `@celld/sec/oauth/resource` | `ResourceServer` (`verifyRequest` to a principal or a challenge), JWT and introspection verifiers        |
| `@celld/sec/oauth/router`   | `oauthSchemes`, `resourceVerifier`, `protectedResourceRoutes`: a `ResourceServer` on `@celld/web/router` |
| `@celld/sec/oauth/server`   | `AuthorizationServer` (`(Request) => Response` endpoints), `RecordStore`, signing keys, client records   |
| `@celld/sec/oauth/durable`  | `OAuthRecords`, `durableRecordStore`, `durableReplayStore`                                               |
| `@celld/sec/oauth/testing`  | `testAuthorizationServer`, `testResourceServer`, `serveResource`, `testUserAgent`, `routeFetch`, clock   |

Only `./durable` imports `cloudflare:workers`, so everything else loads in a
plain `celld.test`. Each role is its own entry point: a Worker that only checks
tokens never bundles the authorization server, and only `./router` imports
`@celld/web/router`.

### A client

`OAuthClient` speaks to one authorization server as one client:

```typescript
import { OAuthClient } from "@celld/sec/oauth/client";
import { DpopKey } from "@celld/sec/oauth/dpop";

const client = new OAuthClient({
  issuer: "https://auth.example.com",
  client: { method: "none", clientId: "my-cli" },
  redirectUri: "http://127.0.0.1:8765/callback",
  dpop: await DpopKey.generate(), // ES256
});

const pending = await client.authorizationUrl({
  scope: ["files:read"],
  resource: "https://api.example.com",
});
// Send the user to pending.url; keep `pending` (it holds the PKCE verifier).
const tokens = await client.completeAuthorization(pending, callbackUrl);
const fresh = await client.refresh(tokens);
```

Every credential-producing method returns an immutable `AuthorizedGrant`, with
issuer, client, exact resource ceiling, requested/granted scopes, acquisition
time, generation and proof-key identity. `refresh(grant)` cannot expand that
authority; `resourceHeaders(grant, resource, url, method)` refuses an uncovered
destination before creating a credential header. Copying or JSON-parsing a grant
loses its runtime authority. A different client instance cannot use it.

For persistence, use
`GrantCodec(aesGcmKey, { issuer, clientId, owner: client,
dpopJkt })`; `seal`
encrypts and authenticates a versioned record, while `open` validates identity,
schema and expiry. Keep the key confidential and persist the latest generation
atomically: encryption does not prevent replay of an older valid ciphertext.
Pass `generation` when opening against a stored generation fence.
`unsafeRestoreGrant`/`client.unsafeRestoreGrant` are migration boundaries only
for records read from an already authenticated confidential store.
`unsafeRefresh` similarly requires explicit issuer/client/resource/scope
attestation; it must not be used on credentials taken from an incoming request.

Pending authorization and device records are immutable runtime values too. Keep
PKCE/state/nonce confidential. After reading authenticated server storage,
`unsafeRestorePending` or `unsafeRestoreDevice` validates and transfers the
record to the current client. Browser-controlled JSON cannot serve as pending
state. Callbacks must match the registered URI spelling and static query, reject
duplicate singleton fields, and contain the expected `iss` by default. An
issuer-scoped `unsafeAllowMissingAuthorizationIssuer` supports a legacy
provider; never share that callback path across issuers.

It also has `clientCredentials`, `tokenExchange` (RFC 8693),
`deviceAuthorization` and `pollDeviceToken` (RFC 8628), `revoke` (RFC 7009) and
`introspect` (RFC 7662). Client authentication is a `ClientAuthentication`:
`none`, `client_secret_basic`, `client_secret_post`, or `private_key_jwt` with
any `@celld/sec/jwt` key.

`OAuthSession` is for calling a protected resource without knowing its
authorization server in advance:

```typescript
import { OAuthSession } from "@celld/sec/oauth/client";

const session = new OAuthSession({
  resource: "https://api.example.com",
  redirectUri: "http://127.0.0.1:8765/callback",
  registration: {
    metadataDocument: "https://tool.example.com/oauth/client.json",
    dynamic: { client_name: "My tool" },
  },
  userAgent, // opens the URL, resolves with the callback URL
  store, // your encrypted OAuthStore; default in memory
  dpop: await DpopKey.generate(),
});
const response = await session.resourceFetch("https://api.example.com/files");
```

On a 401 it reads the challenge's `resource_metadata` (RFC 9728), or tries the
well-known URLs, checks that the document's `resource` covers the URL being
called, discovers the authorization server (RFC 8414, then the OpenID Connect
locations), gets a client id (pre-registered, a Client ID Metadata Document when
the server supports them, a stored registration, then Dynamic Client
Registration), and runs the code flow through the `OAuthUserAgent`. It keeps
tokens per issuer and resource, refreshes them before they expire, refreshes
once on `invalid_token`, steps up on `insufficient_scope` (once per scope set),
and retries a resource's `use_dpop_nonce`. With `clientCredentials` it uses that
grant instead of a user. `resourceHeaders()`, `challenge()` and `observe()` are
public, so a transport with its own retry loop (MCP's) can drive it:
`const authContext = await resourceHeaders({ method, url, signal })` before
every request, send that exact returned header map, then
`observe({ url, headers, authContext })` after every response (a resource may
rotate its `DPoP-Nonce` on a 200, and the next proof must carry the new one),
and `challenge({ ..., authContext })` on a 401 or 403, which says whether to
send the request again. `resourceFetch` does exactly this, and `httpAuth()`
hands the three to a transport as `{ headers, challenge, observe }`
(`@celld/mcp`'s `HttpAuthProvider`).

Sessions that share one `store` (a session per request, or isolates over one
Durable Object) must give it an atomic `lock(name, work)`: a session takes it
around a refresh, re-reads the tokens once it holds it and uses what another
session already refreshed, and takes it around Dynamic Client Registration so
only one client is registered. A missing lock is rejected at construction.
`unsafeAllowUnlockedStore: true` is for explicitly single-owner migrations only;
two sessions refreshing one rotating token without a shared lock can revoke its
whole family. A process-local lock is not a distributed lock.
`memoryOAuthStore()` has an in-memory lock (one isolate). Before sending a
rotating refresh credential, the session durably removes that credential under
the lock, retaining its still-valid access token. Success installs the new
grant. An ambiguous response or process crash cannot replay the old refresh
token after restart: access can continue until expiry, then the user must
authorize again. The store must make this write durable before resolving. A
failed write prevents the outbound refresh; it must never be silently
acknowledged by a store adapter. `signOut({ revoke: true, signal })` serializes
local token deletion first, then attempts remote revocation of the captured old
token. It resolves to `{ revoked, error? }`: `revoked: false` means no
successful upstream revocation was confirmed. Sign-out aborts this session's
in-flight work and fences delayed credential writes; deployments must also
coordinate other instances and upstream revocation. Initial authorization and
proactive client credentials are singleflight, and cancelling one waiter does
not cancel other waiters. Failed authorization does not commit scopes. Store
failures reject sign-out: deletion is attempted even if reading the old token
fails, but a failed store deletion cannot be reported as a successful local
logout. A new login is not deleted when an older remote revocation finishes.

Persist the complete grant, including `provenance`, in an authenticated,
confidential store; raw token records are rejected. A split browser flow must
likewise protect the complete pending record's integrity and confidentiality.
After reading that host-owned store, call `session.unsafeRestorePending(record)`
before `completeAuthorization`. Never restore from callback/query/browser JSON.
Unmodified in-memory pending objects can transfer between compatible sessions;
spreading or JSON-roundtripping them deliberately loses runtime authority.

Numbers from the server are range-checked: a device authorization's `expires_in`
(1 s to a day) and `interval` (1 to 300 s; `slow_down` never waits longer), and
a token response's `expires_in` (whole seconds up to ten years); anything else
is a `token` error. A `private_key_jwt` `lifetimeSec` must be 1 to 300 (a
`RangeError` when the client is made).

The tokens go to the resource and nowhere else. `resourceFetch` and
`resourceHeaders` refuse, with the `OAuthError` kind `target` and before any
credential exists, a URL that is not `https:`, that carries user information, or
that the resource does not cover: another origin (a sibling host or port
included), or a path outside the resource's at a `/` boundary once dot segments
are resolved (`/v1x` and `/v1/../admin` are outside `/v1`), a path holding an
escaped `/`, `\` or `.` (`%2f`, `%5c`, `%2e`, which a proxy might decode before
routing), or, for a resource with a query, another query. `resourceFetch` also
sends `redirect: "error"`, so a redirect fails the request rather than carrying
the token on. `challenge()` ignores a response from a URL outside the resource,
and a session never moves to another authorization server: once it has
discovered one, a resource metadata document (from a challenge's
`resource_metadata`, say) naming only others is a `discovery` error. Its
resource is pinned the same way: a later document naming another resource (a
broader one would widen the audience of the tokens sent to the resource's URLs)
is a `discovery` error, and a challenge's `resource_metadata` on another origin
than the configured resource must name exactly that resource (RFC 9728 section
3.3). `unsafeHeaders()` and `unsafeFetch()` are the raw forms: they attach the
session's token to whatever URL they are given, and are for callers that have
checked the URL themselves.

Discovery, registration requests and metadata documents are fetched through
`@celld/http/egress`'s `boundedFetch`: https only, no redirects, a 5 s deadline,
at most 64 KiB, and public addresses only (a literal private, link-local or
loopback host is refused before anything is sent). `egress` adjusts the policy
on `OAuthSession`, `OAuthClient` and the discovery functions;
`allowLoopbackForDevelopment: true` allows `http://127.0.0.1:port` servers
during development (a name such as `localhost` never counts as loopback here).
Only literal addresses are checked: the runtime has no DNS hook, so a host name
that resolves to a private address is not caught. Token, PAR, device, revocation
and introspection requests carry credentials, so they follow the same rule with
a 10 s deadline and never a redirect, whatever `egress` says: a 307 cannot
re-send a secret, a code or a refresh token elsewhere. Their answers are read as
streams and dropped past 256 KiB, and parsed with depth and size limits, so a
server that never stops sending cannot exhaust memory. Metadata given to
`OAuthClient` directly is checked as discovered metadata is, and `OAuthClient`
and `OAuthSession` copy their options when made.

These protections also apply to injected fetch implementations: the wrapper sets
redirect refusal and bounds the returned response. A fetch implementation must
honor its AbortSignal. Literal/textual host filtering cannot inspect DNS
answers; use platform egress rules when untrusted names must never reach private
networks.

A server that requires an initial access token for Dynamic Client Registration
gets it from `registration.initialAccessTokens`, a map (or a function) keyed by
issuer. The token for an issuer is sent only to that issuer's registration
endpoint; a resource whose metadata names some other server gets no token at
all:

```typescript
registration: {
  dynamic: { client_name: "My tool" },
  initialAccessTokens: { "https://auth.example.com": env.DCR_TOKEN },
},
```

A host whose callback is a separate request (a Worker) uses `beginAuthorization`
and `completeAuthorization`. `PendingAuthorization` has runtime authority;
serializing it deliberately loses that authority. Keep its complete data in a
confidential, integrity-protected host store and explicitly restore it as
described above before completing the callback.

### A resource server

```typescript
import { jwtAccessTokenVerifier, ResourceServer } from "@celld/sec/oauth/resource";
import { durableReplayStore } from "@celld/sec/oauth/durable";

const api = new ResourceServer({
  resource: "https://api.example.com",
  authorizationServers: ["https://auth.example.com"],
  verifier: jwtAccessTokenVerifier({
    issuer: "https://auth.example.com",
    audience: "https://api.example.com",
    keys: "https://auth.example.com/jwks",
  }),
  scopesSupported: ["files:read", "files:write"],
  dpop: { replay: durableReplayStore(env.OAUTH_RECORDS) },
});

export default {
  async fetch(request: Request) {
    const metadata = api.handleMetadata(request); // RFC 9728 document
    if (metadata !== null) return metadata;
    const result = await api.verifyRequest(request, { scopes: ["files:read"] });
    if (!result.ok) return result.challenge.toResponse();
    return Response.json({ hello: result.principal.subject }, {
      headers: result.headers,
    });
  },
};
```

`verifyRequest` never throws for a bad request. A refusal is a `Challenge`
(status, `error`, headers, `toResponse()`); success is a `Principal` (`subject`,
`scopes`, `claims`, `clientId`, `issuer`, `expiresAt`, `cnf.jkt`, `tokenType`)
plus headers to add (`Cache-Control: private, no-store` and a fresh
`DPoP-Nonce`). Always apply those headers on direct, non-router handlers. The
principal never carries the token.
`verify({ method, url, authorization,
dpop })` is the same check over plain
values, which is what `@celld/sec/oauth/router` calls. `metadataResponse()` is the
metadata document as a response, for a host that routes the request itself.

Tokens come from the `Authorization` header only. Under `Bearer`, a token bound
to a DPoP key (`cnf.jkt`) is refused: a stolen bound token must not work as a
bearer token. Under `DPoP`, the token must be bound, and the request must carry
exactly one proof whose key has that thumbprint, whose `ath` hashes the token,
and whose `htm` and `htu` match the request. `dpop: { required: true, ... }`
refuses Bearer altogether; `dpop: false` refuses DPoP. A Bearer request with an
unbound token and a stray `DPoP` header is accepted and the header ignored.

`dpop` is required. Use `false`, or `{ replay }` with a shared atomic
`ReplayStore` (`durableReplayStore`) so each proof is accepted once. A
`DpopNonceSource` (`DpopNonceIssuer`) may be added as `{ replay, nonce }` to
reduce proof pre-generation, but its reusable nonces are not replay prevention.
`{ unsafeNoReplay: true }` (optionally with `nonce`) explicitly accepts captured
proofs again during their proof window and is only for a caller that enforces
single use elsewhere. Anything else, including a missing `dpop`, `{}`,
`{ nonce }`, or `{ required: true }` alone, is a `TypeError` at construction.
`unsafeMemoryReplayStore()` from `@celld/sec/oauth/dpop` keeps `jti`s
in this isolate only; it is for tests (`testResourceServer` uses it), because a
Worker's other isolates would accept the same proof again. `maxAgeSec` (1 to
3600, default 60) and `clockToleranceSec` (0 to 300, default 5) are checked at
construction, and `resource.dpop` exposes the validated settings.

The challenge names every accepted scheme: `Bearer` (with `realm` when set) and
`DPoP` (with `algs`), each with `resource_metadata`, and the `error`,
`error_description` and `scope` go on the scheme the request used. A request
without credentials gets no `error` (RFC 6750 section 3.1). A malformed
`Authorization` is 400 `invalid_request`; an unreachable JWKS or introspection
endpoint is 503. A token whose algorithm the runtime cannot verify is not a bad
token: `verify` throws the `JwtError` `runtime_unsupported`, and behind
`@celld/web/router` that is a 503 without an authentication challenge. Call
`await api.ready()`, `await authorizationServer.ready()` and
`await client.ready()` at startup to probe the configured cryptographic
algorithms before serving.

#### Behind `@celld/web/router`

```typescript
import { oauthSchemes, protectedResourceRoutes } from "@celld/sec/oauth/router";
import { router } from "@celld/web/router";

const app = router<Env>({ auth: oauthSchemes(api) });
protectedResourceRoutes(app, api); // GET /.well-known/oauth-protected-resource
app.get(
  "/files",
  { scopes: ["files:read"] },
  (c) => c.json({ hello: c.principal.subject }),
);
```

`oauthSchemes(resource)` returns the router schemes the resource server accepts:
`dpop` (with its `algs`) unless `dpop: false`, then `bearer` unless
`dpop: { required: true }`. The adapter delegates proof verification to
`ResourceServer`, which performs signature, token/key binding, replay and nonce
checks once, including when both nonce and replay are enabled. There is no
`proofVerified` bypass. The adapter uses the router's `c.publicUrl`; configure
public URL reconstruction on the router itself. Their challenges carry the
resource server's `realm` and `resource_metadata`, on 401s and on the router's
403 `insufficient_scope` alike. `resourceVerifier(resource)` is the
`TokenVerifier` under them: it calls `verify`, returns the principal with the
fresh `DPoP-Nonce` as response headers (which the router puts on whatever the
request gets, errors included), turns a refusal into an `AuthError` with its
status, code, description and `DPoP-Nonce`, and a 503 into an `HttpError`. Route
`scopes` are checked by the router, so `requiredScopes` is for scopes every
request needs.

Behind a proxy the Worker sees an internal URL, while a DPoP proof's `htu` names
the one the client used. Both functions check the request against the router's
own public URL, `c.publicUrl`, the one its transport and CSRF checks use;
configure it on the router (a trusted-proxy mode also needs a named peer source,
see `@celld/web/router`):

```typescript
const app = router<Env>({
  auth: oauthSchemes(api),
  publicUrl: { mode: "fixed", origin: "https://files.example.com" },
});
```

`{ mode: "trusted-proxy", ... }` reads it from the headers of proxies you name
instead; never read `X-Forwarded-Host` from anyone else.

A principal always carries the issuer of its token, which is part of its
ownership `key`: the verifier's (which must be one of `authorizationServers`),
or the only server when the verifier names none. A resource trusting several
authorization servers whose verifier leaves `issuer` out throws, rather than
merging two issuers' subjects into one owner.

A `ResourceServer` is one protected resource with one identifier: its tokens'
audience, and its metadata's `resource`, which RFC 9728 (section 3.3) requires
to be the identifier the metadata URL was derived from. So a Worker that answers
at several origins, each as itself, is several resources: build a
`ResourceServer` and its schemes per origin (cached in a `Map`), and pick one by
the request's public origin. `@celld/mcp`'s runtime test Worker does this.

`protectedResourceRoutes(app, resource)` serves the RFC 9728 metadata as public
`GET` (and `HEAD`) routes at the path of `resourceMetadataUrl`:
`/.well-known/oauth-protected-resource` followed by the resource's path, which
is `/.well-known/oauth-protected-resource` itself for a resource at the origin's
root. `{ root: true }` also serves it at that root form for a resource with a
path, for clients that only look there. The paths are absolute, so register them
on the router that serves the origin, not one mounted under a prefix.

`jwtAccessTokenVerifier` checks RFC 9068 tokens (`typ` `at+jwt`, and `iss`,
`exp`, `aud`, `sub`, `client_id`, `iat`, `jti`); `strict: false` accepts plain
JWTs with `iss`, `aud` and `exp` from issuers that predate the profile. A JWKS
URL is fetched by `@celld/sec/jwt`'s `RemoteJwks` under its egress policy (https, no
redirects, 5 s, 256 KiB, public addresses); `egress` adjusts it, and
`allowLoopbackForDevelopment: true` allows `http://127.0.0.1:port` for an issuer
on this machine (never a name such as `localhost`). As for the client, only
literal addresses are checked: a host name that resolves to a private address is
not caught. `introspectionVerifier` asks the authorization server through
bounded egress, authenticating as the resource with any `ClientAuthentication`,
and caches active answers by the token's hash for `cacheMs` (60 s) or until
`exp`, at most `maxEntries` (10 000) of them. These numbers are checked at
construction. It takes access tokens only: an active answer whose `token_type`
is not absent, `Bearer`, `DPoP`, `access_token` or RFC 8693's access token URI
is `invalid_token`, since a server answers a refresh token as active to the
client that holds it. Its request carries the resource's credentials, so it goes
through `boundedFetch` under the token-endpoint rule (https, public addresses,
never a redirect, 10 s, 256 KiB): `egress` adjusts it, and
`allowLoopbackForDevelopment` allows `http://127.0.0.1:port`. Both verifiers,
and `ResourceServer`, copy their options when made, and a missing `issuer` or
`audience` is a `TypeError`, never "any"; the metadata document is frozen.

Introspection and client metadata fetches deduplicate concurrent identical work.
Introspection caches inactive token hashes for two seconds; metadata misses for
at most five seconds. Each instance admits at most 32 simultaneous fetches,
eight per origin, and 120 new fetches per minute. Five infrastructure failures
open a one-second circuit breaker. Positive introspection results are deeply
immutable and expire at the earlier of local cache TTL and token expiry. These
are isolate-local budgets; use deployment-wide admission for aggregate
protection. `requireIssuer: true` requires the introspection `iss` extension;
the RFC-compatible default accepts its absence but always rejects a conflict.

### An authorization server

```typescript
import { AuthorizationServer, signingKeyFromJwk } from "@celld/sec/oauth/server";
import { durableRecordStore } from "@celld/sec/oauth/durable";
export { OAuthRecords } from "@celld/sec/oauth/durable";

const server = new AuthorizationServer({
  issuer: "https://auth.example.com",
  keys: [await signingKeyFromJwk(JSON.parse(env.SIGNING_JWK), "ES256")],
  store: durableRecordStore(env.OAUTH_RECORDS),
  clients: [{
    client_id: "my-cli",
    redirect_uris: ["http://127.0.0.1/callback"],
  }],
  resources: { allowed: ["https://api.example.com"] },
  interaction: async ({ request, interactionId }) => {
    const user = await sessionUser(request);
    if (user === null) {
      return Response.redirect(
        `https://auth.example.com/login?i=${interactionId}`,
        303,
      );
    }
    return { grant: { subject: user.id } };
  },
});

export default {
  async fetch(request: Request) {
    return await server.handle(request) ?? await myPages(request);
  },
};
```

```python
celld.project(..., bindings = {"OAUTH_RECORDS": "OAuthRecords"})
```

`handle` routes by path to the metadata document
(`/.well-known/oauth-authorization-server{issuer path}`), `/authorize`, `/par`,
`/token`, `/revoke`, `/introspect`, `/jwks`, `/register` and
`/device_authorization` (the paths are options), and answers null for anything
else. Each endpoint is also a method, `(Request) =>
Promise<Response>`, for
hosts with their own router.

The library renders no pages. Login and consent are the host's, through the
`interaction` hook: it sees the validated request (client, scopes, resources,
every parameter) and grants, denies, or answers with its own `Response`. In the
last case the request is kept for ten minutes, the host's page reads it with
`server.interaction(id)`, and `server.resumeAuthorization(id, decision)` returns
the redirect back to the client. The host must make sure the decision comes from
the browser session that started it, and CSRF-check its login form:
[`examples/server.ts`](examples/server.ts) sets an encrypted cookie naming the
interaction in the hook and requires it, and the router's CSRF token, on the
login page and its POST. Device codes work the same way:
`server.device(userCode)` and `server.decideDevice(userCode, decision)` from the
host's verification page. User codes are eight letters drawn without modulo
bias; polls that race each other are re-evaluated, so parallel polling gets
`slow_down` too. Errors that cannot go back to the client are a plain-text 400.

Token exchange uses `tokenExchange: { sourceAudiences, authorize }`. The server
verifies its own subject access token, exact source audience, expiry, subject,
scope attenuation and DPoP key binding before claiming the proof and calling the
pure `authorize` decision. A returned subject cannot change, and scope cannot
grow. The policy explicitly decides which target resources this client may
receive. Actor tokens require the separately named `unsafeTokenExchange`
custom-validation boundary; nested actor chains are bounded in the safe policy.
An `audience` the decision returns is held to the same policy as a requested
resource (secure URLs `resources.allowed` allows for the client; an empty list
is refused), so a hook echoing the request cannot mint tokens for anything. Its
`scope` is held to the requested scope's policy too (scope tokens in
`scopesSupported` and the acting client's `scope` allowlist, else
`invalid_scope`), so a hook passing on the subject token's scopes cannot hand
the acting client a scope it could not ask for. A `tokenResponse` hook adds
members to token responses, which is where an OpenID layer puts `id_token`.
`metadata` adds members to the metadata document.

With only `resources.default`, only those exact audiences may be issued. List
additional audiences in `resources.allowed` or provide a per-client predicate;
unrestricted issuance requires `unsafeAllowAnyResource: true`. Refresh always
narrows its existing resource/scope ceiling. All client sources pass the same
redirect, grant, authentication and public-key validator, and duplicate static
client IDs fail startup.

One-shot grants prepare signing, extension output and nonce responses before
their atomic commit. Interaction and token-response hooks must be pure
decisions: they may run more than once in a failed or concurrent attempt.
Perform application effects after the host commits its own transaction. A
RecordStore implementation must provide atomic, definitive CAS outcomes;
deployment retries after an ambiguous RPC commit require host transaction
identity/idempotency. The library cannot undo a remote write that succeeded
after its transport reported failure.

`limiter(endpoint, request)` runs before expensive public endpoint work, and
must return exactly `true` to admit. It covers authorization, PAR, registration,
token/exchange, revocation, introspection and device flows. A refusal is 429
with `Retry-After: 1`; the host should use a shared limiter for distributed
deployments and rate-limit user-code attempts uniformly. Never identify code
validity through a rate-limit key or response.

`OAUTH_LIMITS` publishes the wire caps: tokens/assertions 16 KiB, Authorization
16,400 characters, URLs 16 KiB, identifiers 4 KiB, nonces/errors 1 KiB, 64
resources and 256 scope tokens of at most 256 characters. Stream and JSON limits
apply in addition. Remote error descriptions are available only as bounded
diagnostics; default error messages omit remote text.

Clients come from `clients`, from Dynamic Client Registration
(`registration: {}`, optionally with an `initialAccessToken`; registered clients
get only the user-facing grants, code, refresh and device, unless
`registration.grantTypes` lists `client_credentials` or token exchange, which
mint tokens with no user; a registered client is kept for
`registration.clientTtlSec`, 30 days by default, renewed whenever it
authenticates, so registrations nobody uses expire; a registration keeps only
the members in `CLIENT_METADATA_MEMBERS`, the RFC 7591 and OpenID Connect
registration metadata, and drops the rest, so a client never chooses its own
`client_id`, secret or `client_secret_expires_at`), from a `resolveClient` hook
for ids nothing else knows (OpenID Federation's automatic registration in
`@celld/sec/oidc` resolves trust chains there), or from Client ID Metadata Documents
(`clientIdMetadataDocuments: { allowUrl }`). The restrictive callback is
required unless `unsafeAllowArbitraryClientMetadataUrls: true` is explicitly
chosen. Fetching a document, or a registered client's `jwks_uri`, means fetching
a URL a stranger chose, so both go through `@celld/http/egress`'s
`boundedFetch`: https only, no redirects, a 5 s deadline, a streamed byte cap (5
KiB for a metadata document, 64 KiB for a key set, whatever `Content-Length`
claims), and public addresses only: a literal private, link-local or loopback
host is refused before anything is sent, and a `jwks_uri` naming one is refused
at registration. `egress` adjusts that policy for every such fetch. The runtime
cannot see what a name resolves to, so `allowUrl` is still the way to limit
documents to hosts you trust. A registered `jwks` holds at most 64 public
keys: private members, symmetric keys, and signing-only operations are
`invalid_client_metadata`. Encryption keys published alongside (a `use`
other than `sig`, an encryption `alg` such as `ECDH-ES`, encryption
`key_ops`) are skipped and never verify anything, as `@celld/sec/jwt`'s
`publicVerificationKeys` does; a `private_key_jwt` client needs at least one
signature-verification key. `private_key_jwt` assertions
verify under asymmetric algorithms only (`assertionAlgorithms` must be a subset
of `SIGNING_ALGORITHMS`; the constructor throws `TypeError` otherwise).

Signing keys come only from `generateSigningKey` or `signingKeyFromJwk`, and
only for asymmetric algorithms (`SIGNING_ALGORITHMS`): `SigningKey` is a branded
type, and the constructor refuses any other object, so an HMAC secret can never
be configured, and so never published in the JWKS. The constructor also checks
every lifetime (`accessTokenTtlSec` and the rest are whole numbers in range; a
`RangeError` otherwise), and that `defaultScopes` are in `scopesSupported` and
`resources.default` are secure URLs in a listed `resources.allowed`. A request
that names no scope or resource gets the defaults, which then pass exactly the
checks an explicit value would: the client's own `scope` allowlist and
`resources.allowed` for that client. An optional pure
`resources.authorize({ resource, client, scope, grantType })` check further
constrains every issued grant; only literal `true` permits it. Token exchange
requires an explicit source-audience and target policy and does not inherit
unrequested subject scopes.

PAR, pending interactions and authorization codes bind a digest of the resolved
client metadata. A resolver can set `registration_generation` to bind external
trust/configuration generations; the OIDC federation resolver includes the
validated chain and expiry. Changing that generation invalidates pending grants.

Introspection (`/introspect`) is off until configured. Only confidential clients
may call it, and an access token is described only when `introspection` allows
it: `audiences` maps a client id to the resources whose tokens it may see (one
of the token's `aud` must be among them), and `authorize(client, claims)`
decides per token; either or both may be set, and with neither every access
token is `{ active: false }`. The answer carries `active`, `scope`, `client_id`,
`sub`, `exp`, `iat`, `aud`, `token_type` and `cnf`; `claims` names more to
include. A refresh token is described only to the client it was issued to.

```typescript
introspection: {
  audiences: { "reports-api": ["https://api.example.com"] },
  claims: ["acr"],
},
```

Request bodies are read as streams and stopped at a cap: 16 KiB for the token,
PAR, device and authorization forms, 4 KiB for revocation and introspection, and
64 KiB for registration JSON (at most 8 levels deep and 256 members or items per
object or array, no duplicate keys). A larger `Content-Length` is refused before
reading; a chunked body is cut off at the cap. Over the cap is 413
`invalid_request`.

### Storage

The server keeps codes, refresh token families, registered clients, pushed
requests, device codes, interactions, revoked token ids and seen `jti`s in a
`RecordStore`: single-key `get`, `put`, `create` (only if absent), `swap`
(compare-and-set on a version) and `delete`, with expiry. Single use and
rotation are built from `create` and `swap`, so any store with those is correct
under concurrency.

- `unsafeMemoryRecordStore({ maxEntries? })` is for tests and single-isolate
  demos: single use and rotation hold only within one isolate. It holds at most
  `maxEntries` records (default 100 000), purges expired ones when full, and
  then throws rather than growing.
- `durableRecordStore(namespace, { shards = 16, name = "oauth" })` spreads keys
  over `OAuthRecords` Durable Objects by a hash of the key. Each object keeps
  records in its SQLite database, reads and writes with synchronous statements
  before its first `await` (so each call is atomic), and waits for
  `storage.sync()` before answering. An alarm deletes expired records. Choose
  `shards` and `name` once: changing them strands what is already stored.

The server never stores its own secrets: codes, refresh tokens, device codes,
pushed request ids, interaction ids and registered client secrets are kept as
SHA-256 hashes (device user codes, which redeem nothing by themselves, are kept
as typed). That is this server's discipline, not a property of `RecordStore`:
anything else kept in one must be hashed or encrypted by its user, as
`@celld/sec/oidc/broker`'s `encryptedSecretStore` does for upstream tokens.
`server.client(id)` and every hook see a frozen view of a client without its
secret or its hash, and the server copies its options when it is made. That is a
property of the server's records, not of a `RecordStore`: any other code that
keeps a secret it must use again in one (an upstream refresh token, say) has to
encrypt it, as `@celld/sec/oidc/broker`'s `encryptedSecretStore` does.

## Security defaults

| Default                                                                                                                          | Where          | Why                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| PKCE S256 on every authorization; `plain` never sent or accepted                                                                 | client, server | OAuth 2.1; `plain` protects nothing against a reader of the request       |
| A server whose metadata lacks S256 is refused (`assumePkce` overrides)                                                           | client         | no silent downgrade                                                       |
| Redirect URIs match exactly; only loopback IP literals may vary the port                                                         | server         | RFC 9700, RFC 8252 section 7.3                                            |
| Codes live 60 s and are single use; a reuse within the next hour revokes their tokens                                            | server         | RFC 6749 section 4.1.2                                                    |
| `iss` in every authorization response, checked before anything else                                                              | server, client | RFC 9207 mix-up defense                                                   |
| A fresh 128-bit `state`, checked                                                                                                 | client         | CSRF                                                                      |
| Refresh tokens rotate on every use; an old one revokes the whole family, however many rotations ago it was spent                 | server         | OAuth 2.1 section 4.3.1                                                   |
| Concurrent use of one refresh token also revokes the family                                                                      | server         | the loser of the race looks like a replay                                 |
| Refresh families end 30 days after issue, or 14 days unused                                                                      | server         | bounded lifetime                                                          |
| Access tokens are RFC 9068 JWTs for the requested resources only, 5 minutes                                                      | server         | audience restriction (RFC 8707)                                           |
| A request without a resource is refused unless a default is configured                                                           | server         | every token names its audience                                            |
| Tokens are DPoP-bound whenever a proof is sent; public clients' refresh tokens too                                               | server         | RFC 9449 section 5                                                        |
| A Bearer answer to a DPoP request is refused (`allowBearerFallback` overrides)                                                   | client         | no silent loss of binding                                                 |
| A DPoP-bound token presented as Bearer is refused                                                                                | resource       | stolen tokens stay useless                                                |
| DPoP at a resource needs a shared replay store; `dpop` has no default                                                            | resource       | only atomic `jti` claims make each proof single-use                       |
| Client secrets compared in constant time; registered ones stored hashed                                                          | server         | timing and leaks                                                          |
| A client must use its registered authentication method; two at once is an error                                                  | server         | no downgrade to `none`                                                    |
| Client assertions: `aud` is the issuer, `iat` required and at most 5 minutes old, `exp` at most 5 minutes ahead, `jti` used once | server, client | draft-ietf-oauth-rfc7523bis                                               |
| Signing keys are asymmetric and made by the helpers; the JWKS never carries a secret                                             | server         | a published HMAC key forges tokens                                        |
| Default scopes and resources pass the same per-client checks as requested ones                                                   | server         | nothing by omission                                                       |
| Introspection answers nothing until a policy names who may see which audiences; minimal claims                                   | server         | no token oracle                                                           |
| Request bodies are capped while streamed (16 KiB forms, 4 KiB introspection and revocation, 64 KiB registration)                 | server         | memory                                                                    |
| `jwks_uri` and metadata documents: https, no redirects, 5 s, capped, literal public-address filtering                            | server         | textual SSRF filtering; DNS needs platform control                        |
| `none` is never an algorithm; HMAC is not accepted for access tokens, proofs or client assertions                                | everywhere     | `@celld/sec/jwt` refuses `none`; nobody shares a secret with a resource   |
| Every endpoint and metadata URL is `https:` (`http:` only to a loopback IP literal, never `localhost`)                           | everywhere     | RFC 8414, RFC 9728                                                        |
| A session's token goes only to URLs its resource covers, over https, with no redirects                                           | client         | a token is not a password for every host                                  |
| Initial access tokens are keyed by issuer; another server named by resource metadata gets none                                   | client         | registration secrets stay with their issuer                               |
| Discovery and registration fetches: https, no redirects, 5 s, 64 KiB, public addresses                                           | client         | SSRF, hung and huge answers                                               |
| Metadata whose `issuer` or `resource` does not match is never used                                                               | client         | RFC 8414 section 3.3, RFC 9728 section 3.3                                |
| Dynamic Client Registration and metadata documents are off                                                                       | server         | opt in to open registration                                               |
| Token responses are `no-store`                                                                                                   | server         | RFC 6749 section 5.1                                                      |
| Error descriptions are limited to RFC 6749's characters; header values are escaped                                               | everywhere     | no injection into JSON or headers                                         |

## DPoP

Clients hold a `DpopKey` (ES256 by default; RSA, the other ECDSA curves and
Ed25519 are available, and servers accept Ed25519 proofs by default). A proof
has `typ` `dpop+jwt`, the public key in `jwk`, a random 128-bit `jti`, `htm`,
`htu` (the URL without query or fragment), `iat`, and `ath` and `nonce` when
there are an access token and a server nonce. `key.jkt` is the RFC 7638
thumbprint, sent as `dpop_jkt` to bind the authorization code (RFC 9449 section
10). An extractable key can be exported and reloaded, which keeps tokens bound
to it usable across restarts; a session drops stored tokens bound to a key it
does not hold.

`DpopNonceCache` keeps each server's `DPoP-Nonce` by origin, so an authorization
server's nonce never goes to a resource. Clients retry once on `use_dpop_nonce`:
a 400 from an authorization server, a 401 challenge from a resource.

`verifyDpopProof` makes the checks of RFC 9449 section 4.3 in order: compact JWS
of at most 8 KiB; an allowed asymmetric `alg`; a public `jwk` without private
members; the signature; `typ`; `jti`, `htm`, `htu` and `iat` present; `htm`
equal to the method; `htu` equal to the URL after RFC 3986 normalization (case,
default ports, dot segments, percent encoding), ignoring query and fragment;
`iat` at most 60 s old and at most 5 s ahead; the nonce, if the server uses
them; `ath` against the token; the key's thumbprint against the token's
`cnf.jkt`; and last, the `jti` claimed in the `ReplayStore` (keyed by thumbprint
and `jti`, kept until the proof could no longer pass: a `ReplayStore` entry is
live while `now <= expiresAt`, and `expiresAt` is the last millisecond the age
check accepts), so a proof refused for another reason does not use up its `jti`.
`verifyDpopProof` needs a `replay` store or `unsafeNoReplay: true` (a
`TypeError` otherwise). A `nonce` may be added to either mode, but reusable
server nonces do not make a proof single-use. `unsafeNoReplay: true` accepts a
captured proof again for its whole window and is only for a caller that enforces
single use itself. Failures are `DpopError`s with RFC 9449's codes,
`invalid_dpop_proof` or `use_dpop_nonce`. The authorization server goes one step
further: it spends a token or PAR request's `jti` only once the grant itself has
passed its checks (a known code, refresh token or device code, scopes and
resources), before its first write, so requests with fresh proofs and a bogus
code leave no replay records behind.

`DpopNonceIssuer` hands out stateless nonces: a time slot and an HMAC of it.
Every isolate with the same secret issues and accepts the same nonces; a nonce
is good for its slot and the next (`lifetimeSec`, 300 by default, is two slots).

The authorization server verifies proofs at the token and PAR endpoints against
its configured endpoint URLs, not `request.url`, so it works behind a proxy; a
resource server takes `url` for the same reason.

## Security-boundary migration notes

Security option records reject unknown keys, wrong boolean types, getters and
non-data nested configuration. Register all redirect URIs and resource audiences
explicitly; a default resource does not authorize arbitrary other resources.
Call `ready()` at startup to probe the algorithms used by each client/server.

Safe client APIs return runtime-branded `AuthorizedGrant` values; copying or
JSON-roundtripping one does not preserve authority. Use `GrantCodec` for
authenticated encrypted persistence. The `unsafeRestore*` APIs are only for
already authenticated, confidential host storage, never request JSON. Hosts must
fence the latest stored generation: AEAD cannot detect replay of an old valid
ciphertext by itself.

Concurrent low-level `client.refresh(grant)` calls coalesce only for identical
scope/resource attenuation, including separately decoded copies of the same
owner-local generation. Credential/provenance identity is checked with bounded
SHA-256 digests before use; `await client.validateGrant(grant)` is required
before direct use of an explicitly restored credential. The synchronous
`assertGrant` checks brand and provenance only. Canceling a waiter does not
cancel the shared rotation. After success the old grant is retired. After an
uncertain outcome, the still-live access token remains usable but the safe
client will not resend its refresh token; `GrantCodec.seal` omits that uncertain
refresh credential. Across processes, use a durable shared lock and write-ahead
refresh intent, as `OAuthSession` does. A raw `unsafeRefresh` call transfers
that responsibility to the caller.

A client retains at most 4,096 generation states, including retired and uncertain
tombstones; they are never silently evicted. Successor capacity is reserved
before credential-bearing grant requests, so hitting the cap cannot consume a
refresh token and lose its replacement. At capacity, create a new client
lifecycle and reauthorize or migrate the latest authenticated grant under the
host's shared lock/freshness policy. Ownerless codecs do not share a global
generation registry. The OAuth assertion upper bound is 16 KiB; default JWT
signing/verifying applies its stricter 8 KiB compact-token cap first.

| Threat/boundary                         | Library guarantee                                                                                     | Host responsibility                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Untrusted callback/token/metadata       | Bounded parsing, exact issuer/audience/destination, immutable verified state, provenance-bound grants | Choose trusted issuers and permitted resources; protect client secrets and pending flows                                  |
| Attacker-triggered outbound work        | No redirects, byte/time/JSON caps, CIMD/introspection singleflight and isolate-local budgets          | Restrict permitted hosts; enforce DNS/connect-time address policy and deployment-wide admission                           |
| Replay and concurrent state transitions | Atomic RecordStore CAS, prepared grant responses, shared DPoP replay key, safe refresh coordination   | Supply shared atomic stores/locks; persist refresh intent and generation fencing; handle ambiguous remote commit outcomes |
| Authenticated response caching          | Direct verifier success headers are private/no-store; router adapter preserves protection             | Apply direct response headers; configure proxy/CDN caches consistently                                                    |

Security regressions live in `tests/hardening_test.ts` (current audit IDs),
`tests/regressions_test.ts`, `tests/sweep_test.ts`, `tests/followup_test.ts`,
and `tests/flow_test.ts`. Buck checks and runs the five examples plus deployed
Worker/Durable Object CAS/replay scenarios. These deterministic tests establish
the stated invariants; they are not a claim that all failure schedules or all
host deployments have been exhaustively verified.

## RFC coverage

| Specification                                                                   | Client               | Resource            | Server                    |
| ------------------------------------------------------------------------------- | -------------------- | ------------------- | ------------------------- |
| OAuth 2.1 (draft-ietf-oauth-v2-1) / RFC 6749: code, refresh, client credentials | yes                  |                     | yes                       |
| RFC 6750 Bearer tokens (header only)                                            | yes                  | yes                 |                           |
| RFC 7636 PKCE (S256 only)                                                       | yes                  |                     | yes                       |
| RFC 8414 authorization server metadata, plus OpenID Connect Discovery locations | yes                  |                     | yes (OAuth location)      |
| RFC 9728 protected resource metadata and `resource_metadata`                    | yes                  | yes                 |                           |
| RFC 9207 `iss` in authorization responses                                       | yes                  |                     | yes                       |
| RFC 8707 resource indicators                                                    | yes                  | yes (audience)      | yes                       |
| RFC 9126 pushed authorization requests                                          | yes (automatic)      |                     | yes (optionally required) |
| RFC 9449 DPoP: proofs, nonces, `ath`, `dpop_jkt`, bound refresh tokens          | yes                  | yes                 | yes                       |
| RFC 9068 JWT access tokens                                                      |                      | yes                 | yes                       |
| RFC 7662 introspection                                                          | yes                  | yes (verifier)      | yes                       |
| RFC 7009 revocation                                                             | yes                  |                     | yes                       |
| RFC 8693 token exchange                                                         | yes                  |                     | yes (host hook)           |
| RFC 8628 device authorization                                                   | yes                  |                     | yes                       |
| RFC 7591 dynamic client registration                                            | yes                  |                     | yes                       |
| draft-ietf-oauth-client-id-metadata-document                                    | yes                  |                     | yes                       |
| RFC 7523 `private_key_jwt` client authentication (7523bis audience)             | yes                  | yes (introspection) | yes                       |
| RFC 8252 loopback redirects                                                     | yes                  |                     | yes                       |
| RFC 7638 JWK thumbprints                                                        | via `@celld/sec/jwt` |                     |                           |

## Not done

- OpenID Connect: ID tokens, UserInfo, `nonce` and `prompt` handling are for
  `@celld/sec/oidc`, through the hooks above.
- RFC 7592 client configuration management (the server issues no registration
  access tokens), software statements, and `jwks_uri` rotation policy beyond
  `RemoteJwks`'s.
- JAR (RFC 9101) request objects, JARM, RAR (RFC 9396) `authorization_details`,
  mutual TLS (RFC 8705), and the implicit and password grants (removed by OAuth
  2.1).
- Tokens in the query or body (RFC 6750 sections 2.2 and 2.3).
- Refresh token grace periods: a lost response during rotation means the user
  authorizes again.
- Revoked JWT access tokens stay valid at resources that verify locally until
  they expire (five minutes); introspection sees the revocation.
- Rate limits on user codes, the token endpoint and registration are the host's:
  registration open to anyone lets anyone store a client record (up to
  `clientTtlSec`), so rate-limit `server.registration(request)` per caller, or
  set an `initialAccessToken`.

## Examples

[`examples/`](examples) has standalone Workers using this library, each tested
under `celld dev`: a whole authorization server on the Durable Object store with
an API on `@celld/web/router` and a login page bound to the browser that started the
interaction, a client credentials service, a DPoP client against a server that
demands nonces, the device grant, and token exchange
(`buck2 test root//src/celld/sec/oauth/examples/...`, and
`buck2 run root//src/celld/sec/oauth/examples:<name>-dev`).

## Tests

```sh
buck2 test root//src/celld/sec/oauth/...
```

The Deno suites: `core` (RFC 7636's PKCE vector, challenges, URL rules, errors),
`dpop` (RFC 9449's proofs of figures 2 and 13, its `jkt` and `ath`, and every
refusal), `client`, `resource`, `router` (the `@celld/web/router` schemes:
challenges, nonces on success and on a 403, replay, a 503), `server` (every
endpoint and its negatives), `flow` (sessions against the servers in one
process, with and without DPoP, nonces at both servers, step-up, refresh,
registration), `durable` (`OAuthRecords` over a fake SQL storage and the server
over it), and `regressions` (one or more tests per Daybreak audit finding, named
after it). `:runtime-test` runs `tests/runtime/worker.ts` under `celld dev`: the
Durable Object on real SQLite and RPC, a whole authorization with and without
DPoP, a replayed proof refused by the durable replay store, and refresh rotation
and reuse detection surviving a supervisor restart.
