<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/oauth

OAuth 2.1 for celld: a client, a resource server and an authorization
server, with DPoP (RFC 9449) on all three. JWS work is
[`@celld/jwt`](../jwt/README.md)'s and metadata validation is
[`@celld/sieve`](../sieve/README.md)'s. The `@celld/oauth/router` subpath
also uses [`@celld/router`](../router/README.md); nothing else imports it.
There are no other dependencies, no Node APIs and no `eval`.

```python
celld.library(
    name = "api",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/api",
    deps = ["root//src/celld/oauth:oauth"],
)
```

## Why it exists

`@celld/mcp` grew OAuth support for one protocol: discovery, PKCE, client
registration, a JWT verifier. Every other Worker that talks to an
identity provider, protects an API, or issues its own tokens needs the
same pieces, and some need more (an authorization server, DPoP, device
codes, token exchange). This library is that code made general, with
the parts MCP did not need and with sender-constrained tokens throughout.
MCP will move onto it later; OpenID Connect (`@celld/oidc`) builds on it.

## Subpaths

| Import                  | What it has                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `@celld/oauth`          | `ProtocolError`, `OAuthError`, metadata types and URL rules, PKCE, `WWW-Authenticate`, scopes, URNs     |
| `@celld/oauth/client`   | `OAuthClient` (every grant at one server), `OAuthSession` (call a resource), discovery, registration    |
| `@celld/oauth/dpop`     | `DpopKey`, `verifyDpopProof`, `ReplayStore`, `DpopNonceIssuer`, `DpopNonceCache`, `normalizeHtu`        |
| `@celld/oauth/resource` | `ResourceServer` (`verifyRequest` to a principal or a challenge), JWT and introspection verifiers       |
| `@celld/oauth/router`   | `oauthSchemes`, `resourceVerifier`, `protectedResourceRoutes`: a `ResourceServer` on `@celld/router`    |
| `@celld/oauth/server`   | `AuthorizationServer` (`(Request) => Response` endpoints), `RecordStore`, signing keys, client records  |
| `@celld/oauth/durable`  | `OAuthRecords`, `durableRecordStore`, `durableReplayStore`                                              |
| `@celld/oauth/testing`  | `testAuthorizationServer`, `testResourceServer`, `serveResource`, `testUserAgent`, `routeFetch`, clock |

Only `./durable` imports `cloudflare:workers`, so everything else loads in
a plain `celld.test`. Each role is its own entry point: a Worker that only
checks tokens never bundles the authorization server, and only
`./router` imports `@celld/router`.

### A client

`OAuthClient` speaks to one authorization server as one client:

```typescript
import { OAuthClient } from "@celld/oauth/client";
import { DpopKey } from "@celld/oauth/dpop";

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
const fresh = await client.refresh(tokens.refresh_token!);
```

It also has `clientCredentials`, `tokenExchange` (RFC 8693),
`deviceAuthorization` and `pollDeviceToken` (RFC 8628), `revoke`
(RFC 7009) and `introspect` (RFC 7662). Client authentication is a
`ClientAuthentication`: `none`, `client_secret_basic`,
`client_secret_post`, or `private_key_jwt` with any `@celld/jwt` key.

`OAuthSession` is for calling a protected resource without knowing its
authorization server in advance:

```typescript
import { OAuthSession } from "@celld/oauth/client";

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
const response = await session.fetch("https://api.example.com/files");
```

On a 401 it reads the challenge's `resource_metadata` (RFC 9728), or tries
the well-known URLs, checks that the document's `resource` covers the URL
being called, discovers the authorization server (RFC 8414, then the
OpenID Connect locations), gets a client id (pre-registered, a Client ID
Metadata Document when the server supports them, a stored registration,
then Dynamic Client Registration), and runs the code flow through the
`OAuthUserAgent`. It keeps tokens per issuer and resource, refreshes them
before they expire, refreshes once on `invalid_token`, steps up on
`insufficient_scope` (once per scope set), and retries a resource's
`use_dpop_nonce`. With `clientCredentials` it uses that grant instead of
a user. `headers()`, `challenge()` and `observe()` are public, so a
transport with its own retry loop (MCP's) can drive it: `headers({
method, url })` before every request, `observe({ url, headers })` after
every response (a resource may rotate its `DPoP-Nonce` on a 200, and the
next proof must carry the new one), and `challenge(...)` on a 401 or 403,
which says whether to send the request again. `fetch` does exactly this.

A host whose callback is a separate request (a Worker) uses
`beginAuthorization` and `completeAuthorization`; `PendingAuthorization`
is plain data it can keep, privately, until then.

### A resource server

```typescript
import { jwtAccessTokenVerifier, ResourceServer } from "@celld/oauth/resource";
import { durableReplayStore } from "@celld/oauth/durable";

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
    return Response.json({ hello: result.principal.subject });
  },
};
```

`verifyRequest` never throws for a bad request. A refusal is a `Challenge`
(status, `error`, headers, `toResponse()`); success is a `Principal`
(`subject`, `scopes`, `claims`, `clientId`, `issuer`, `expiresAt`,
`cnf.jkt`, `tokenType`) plus headers to add (a fresh `DPoP-Nonce`). The
principal never carries the token. `verify({ method, url, authorization,
dpop })` is the same check over plain values, which is what
`@celld/oauth/router` calls. `metadataResponse()` is the metadata
document as a response, for a host that routes the request itself.

Tokens come from the `Authorization` header only. Under `Bearer`, a token
bound to a DPoP key (`cnf.jkt`) is refused: a stolen bound token must not
work as a bearer token. Under `DPoP`, the token must be bound, and the
request must carry exactly one proof whose key has that thumbprint, whose
`ath` hashes the token, and whose `htm` and `htu` match the request.
`dpop: { required: true }` refuses Bearer altogether; `dpop: false`
refuses DPoP. A Bearer request with an unbound token and a stray `DPoP`
header is accepted and the header ignored.

The challenge names every accepted scheme: `Bearer` (with `realm` when
set) and `DPoP` (with `algs`), each with `resource_metadata`, and the
`error`, `error_description` and `scope` go on the scheme the request
used. A request without credentials gets no `error` (RFC 6750 section
3.1). A malformed `Authorization` is 400 `invalid_request`; an
unreachable JWKS or introspection endpoint is 503. A token whose
algorithm the runtime cannot verify (celld and Ed25519) is not a bad
token: `verify` throws the `JwtError` `runtime_unsupported`, and behind
`@celld/router` that is a 500 for `onError`.

#### Behind `@celld/router`

```typescript
import { oauthSchemes, protectedResourceRoutes } from "@celld/oauth/router";
import { router } from "@celld/router";

const app = router<Env>({ auth: oauthSchemes(api) });
protectedResourceRoutes(app, api); // GET /.well-known/oauth-protected-resource
app.get("/files", { scopes: ["files:read"] }, (c) => c.json({ hello: c.principal.subject }));
```

`oauthSchemes(resource)` returns the router schemes the resource server
accepts: `dpop` (with its `algs`) unless `dpop: false`, then `bearer`
unless `dpop: { required: true }`. Their challenges carry the resource
server's `realm` and `resource_metadata`, on 401s and on the router's 403
`insufficient_scope` alike. `resourceVerifier(resource)` is the
`TokenVerifier` under them: it calls `verify`, returns the principal with
the fresh `DPoP-Nonce` as response headers (which the router puts on
whatever the request gets, errors included), turns a refusal into an
`AuthError` with its status, code, description and `DPoP-Nonce`, and a
503 into an `HttpError`. Route `scopes` are checked by the router, so
`requiredScopes` is for scopes every request needs.

Behind a proxy the Worker sees an internal URL, while a DPoP proof's `htu`
names the one the client used. Both take `publicUrl(c)`, which returns
that URL; only trust forwarded headers a proxy you control sets:

```typescript
const auth = oauthSchemes(api, {
  publicUrl: (c) => new URL(c.url.pathname + c.url.search, "https://files.example.com"),
});
```

A `ResourceServer` is one protected resource with one identifier: its
tokens' audience, and its metadata's `resource`, which RFC 9728 (section
3.3) requires to be the identifier the metadata URL was derived from. So a
Worker that answers at several origins, each as itself, is several
resources: build a `ResourceServer` and its schemes per origin (cached in a
`Map`), and pick one by the request's public origin. `@celld/mcp`'s
runtime test Worker does this.

`protectedResourceRoutes(app, resource)` serves the RFC 9728 metadata as
public `GET` (and `HEAD`) routes at the path of `resourceMetadataUrl`:
`/.well-known/oauth-protected-resource` followed by the resource's path,
which is `/.well-known/oauth-protected-resource` itself for a resource
at the origin's root. `{ root: true }` also serves it at that root form
for a resource with a path, for clients that only look there. The paths
are absolute, so register them on the router that serves the origin, not
one mounted under a prefix.

`jwtAccessTokenVerifier` checks RFC 9068 tokens (`typ` `at+jwt`, and
`iss`, `exp`, `aud`, `sub`, `client_id`, `iat`, `jti`); `strict: false`
accepts plain JWTs with `iss`, `aud` and `exp` from issuers that predate
the profile. `introspectionVerifier` asks the authorization server,
authenticating as the resource with any `ClientAuthentication`, and
caches active answers by the token's hash for `cacheMs` (60 s) or until
`exp`.

### An authorization server

```typescript
import { AuthorizationServer, signingKeyFromJwk } from "@celld/oauth/server";
import { durableRecordStore } from "@celld/oauth/durable";
export { OAuthRecords } from "@celld/oauth/durable";

const server = new AuthorizationServer({
  issuer: "https://auth.example.com",
  keys: [await signingKeyFromJwk(JSON.parse(env.SIGNING_JWK), "ES256")],
  store: durableRecordStore(env.OAUTH_RECORDS),
  clients: [{ client_id: "my-cli", redirect_uris: ["http://127.0.0.1/callback"] }],
  resources: { allowed: ["https://api.example.com"] },
  interaction: async ({ request, interactionId }) => {
    const user = await sessionUser(request);
    if (user === null) {
      return Response.redirect(`https://auth.example.com/login?i=${interactionId}`, 303);
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
(`/.well-known/oauth-authorization-server{issuer path}`), `/authorize`,
`/par`, `/token`, `/revoke`, `/introspect`, `/jwks`, `/register` and
`/device_authorization` (the paths are options), and answers null for
anything else. Each endpoint is also a method, `(Request) =>
Promise<Response>`, for hosts with their own router.

The library renders no pages. Login and consent are the host's, through
the `interaction` hook: it sees the validated request (client, scopes,
resources, every parameter) and grants, denies, or answers with its own
`Response`. In the last case the request is kept for ten minutes, the
host's page reads it with `server.interaction(id)`, and
`server.resumeAuthorization(id, decision)` returns the redirect back to
the client. The host must make sure the decision comes from the browser
session that started it. Device codes work the same way:
`server.device(userCode)` and `server.decideDevice(userCode, decision)`
from the host's verification page. Errors that cannot go back to the
client are a plain-text 400.

Token exchange is on when a `tokenExchange` hook decides what a subject
token is worth (`verifyAccessToken` is passed in for the server's own
tokens, and `jkt` is the thumbprint of the requester's DPoP proof, which
the issued token is bound to: a hook exchanging a bound subject token
should require it to equal the subject token's `cnf.jkt`). A `tokenResponse` hook adds members to token responses, which is
where an OpenID layer puts `id_token`. `metadata` adds members to the
metadata document.

Clients come from `clients`, from Dynamic Client Registration
(`registration: {}`, optionally with an `initialAccessToken`), from a
`resolveClient` hook for ids nothing else knows (OpenID Federation's
automatic registration in `@celld/oidc` resolves trust chains there), or
from Client ID Metadata Documents (`clientIdMetadataDocuments: {}`, with
`allowUrl` to limit what the server fetches). Fetching a document means
fetching a URL a stranger chose; run the server where that cannot reach
anything internal, or restrict it with `allowUrl`.

### Storage

The server keeps codes, refresh token families, registered clients,
pushed requests, device codes, interactions, revoked token ids and seen
`jti`s in a `RecordStore`: single-key `get`, `put`, `create` (only if
absent), `swap` (compare-and-set on a version) and `delete`, with expiry.
Single use and rotation are built from `create` and `swap`, so any store
with those is correct under concurrency.

- `memoryRecordStore()` is for tests and single-isolate use.
- `durableRecordStore(namespace, { shards = 16, name = "oauth" })` spreads
  keys over `OAuthRecords` Durable Objects by a hash of the key. Each
  object keeps records in its SQLite database, reads and writes with
  synchronous statements before its first `await` (so each call is
  atomic), and waits for `storage.sync()` before answering. An alarm
  deletes expired records. Choose `shards` and `name` once: changing them
  strands what is already stored.

Secrets are never stored: codes, refresh tokens, device codes, pushed
request ids, interaction ids and registered client secrets are kept as
SHA-256 hashes.

## Security defaults

| Default | Where | Why |
| --- | --- | --- |
| PKCE S256 on every authorization; `plain` never sent or accepted | client, server | OAuth 2.1; `plain` protects nothing against a reader of the request |
| A server whose metadata lacks S256 is refused (`assumePkce` overrides) | client | no silent downgrade |
| Redirect URIs match exactly; only loopback IP literals may vary the port | server | RFC 9700, RFC 8252 section 7.3 |
| Codes live 60 s and are single use; a reuse within the next hour revokes their tokens | server | RFC 6749 section 4.1.2 |
| `iss` in every authorization response, checked before anything else | server, client | RFC 9207 mix-up defense |
| A fresh 128-bit `state`, checked | client | CSRF |
| Refresh tokens rotate on every use; an old one revokes the whole family | server | OAuth 2.1 section 4.3.1 |
| Concurrent use of one refresh token also revokes the family | server | the loser of the race looks like a replay |
| Refresh families end 30 days after issue, or 14 days unused | server | bounded lifetime |
| Access tokens are RFC 9068 JWTs for the requested resources only, 5 minutes | server | audience restriction (RFC 8707) |
| A request without a resource is refused unless a default is configured | server | every token names its audience |
| Tokens are DPoP-bound whenever a proof is sent; public clients' refresh tokens too | server | RFC 9449 section 5 |
| A Bearer answer to a DPoP request is refused (`allowBearerFallback` overrides) | client | no silent loss of binding |
| A DPoP-bound token presented as Bearer is refused | resource | stolen tokens stay useless |
| Client secrets compared in constant time; registered ones stored hashed | server | timing and leaks |
| A client must use its registered authentication method; two at once is an error | server | no downgrade to `none` |
| Client assertions: `aud` is the issuer, at most 5 minutes, `jti` used once | server, client | draft-ietf-oauth-rfc7523bis |
| `none` is never an algorithm; HMAC is not accepted for access tokens or proofs | everywhere | `@celld/jwt` refuses `none`; nobody shares a secret with a resource |
| Every endpoint and metadata URL is `https:` (`http:` only on loopback) | everywhere | RFC 8414, RFC 9728 |
| Metadata whose `issuer` or `resource` does not match is never used | client | RFC 8414 section 3.3, RFC 9728 section 3.3 |
| Dynamic Client Registration and metadata documents are off | server | opt in to open registration |
| Token responses are `no-store` | server | RFC 6749 section 5.1 |
| Error descriptions are limited to RFC 6749's characters; header values are escaped | everywhere | no injection into JSON or headers |

## DPoP

Clients hold a `DpopKey` (ES256 by default; RSA and ECDSA curves are
available, and Ed25519 only when asked for, since celld's WebCrypto cannot
verify it). A proof has `typ` `dpop+jwt`, the public key in `jwk`, a
random 128-bit `jti`, `htm`, `htu` (the URL without query or fragment),
`iat`, and `ath` and `nonce` when there are an access token and a server
nonce. `key.jkt` is the RFC 7638 thumbprint, sent as `dpop_jkt` to bind
the authorization code (RFC 9449 section 10). An extractable key can be
exported and reloaded, which keeps tokens bound to it usable across
restarts; a session drops stored tokens bound to a key it does not hold.

`DpopNonceCache` keeps each server's `DPoP-Nonce` by origin, so an
authorization server's nonce never goes to a resource. Clients retry once
on `use_dpop_nonce`: a 400 from an authorization server, a 401 challenge
from a resource.

`verifyDpopProof` makes the checks of RFC 9449 section 4.3 in order:
compact JWS of at most 8 KiB; an allowed asymmetric `alg`; a public `jwk`
without private members; the signature; `typ`; `jti`, `htm`, `htu` and
`iat` present; `htm` equal to the method; `htu` equal to the URL after
RFC 3986 normalization (case, default ports, dot segments, percent
encoding), ignoring query and fragment; `iat` at most 60 s old and at
most 5 s ahead; the nonce, if the server uses them; `ath` against the
token; the key's thumbprint against the token's `cnf.jkt`; and last, the
`jti` claimed in the `ReplayStore` (keyed by thumbprint and `jti`, kept
until the proof could no longer pass), so a proof refused for another
reason does not use up its `jti`. Failures are `DpopError`s with RFC
9449's codes, `invalid_dpop_proof` or `use_dpop_nonce`.

`DpopNonceIssuer` hands out stateless nonces: a time slot and an HMAC of
it. Every isolate with the same secret issues and accepts the same
nonces; a nonce is good for its slot and the next (`lifetimeSec`, 300 by
default, is two slots).

The authorization server verifies proofs at the token and PAR endpoints
against its configured endpoint URLs, not `request.url`, so it works
behind a proxy; a resource server takes `url` for the same reason.

## RFC coverage

| Specification | Client | Resource | Server |
| --- | --- | --- | --- |
| OAuth 2.1 (draft-ietf-oauth-v2-1) / RFC 6749: code, refresh, client credentials | yes | | yes |
| RFC 6750 Bearer tokens (header only) | yes | yes | |
| RFC 7636 PKCE (S256 only) | yes | | yes |
| RFC 8414 authorization server metadata, plus OpenID Connect Discovery locations | yes | | yes (OAuth location) |
| RFC 9728 protected resource metadata and `resource_metadata` | yes | yes | |
| RFC 9207 `iss` in authorization responses | yes | | yes |
| RFC 8707 resource indicators | yes | yes (audience) | yes |
| RFC 9126 pushed authorization requests | yes (automatic) | | yes (optionally required) |
| RFC 9449 DPoP: proofs, nonces, `ath`, `dpop_jkt`, bound refresh tokens | yes | yes | yes |
| RFC 9068 JWT access tokens | | yes | yes |
| RFC 7662 introspection | yes | yes (verifier) | yes |
| RFC 7009 revocation | yes | | yes |
| RFC 8693 token exchange | yes | | yes (host hook) |
| RFC 8628 device authorization | yes | | yes |
| RFC 7591 dynamic client registration | yes | | yes |
| draft-ietf-oauth-client-id-metadata-document | yes | | yes |
| RFC 7523 `private_key_jwt` client authentication (7523bis audience) | yes | yes (introspection) | yes |
| RFC 8252 loopback redirects | yes | | yes |
| RFC 7638 JWK thumbprints | via `@celld/jwt` | | |

## Not done

- OpenID Connect: ID tokens, UserInfo, `nonce` and `prompt` handling are
  for `@celld/oidc`, through the hooks above.
- RFC 7592 client configuration management (the server issues no
  registration access tokens), software statements, and `jwks_uri`
  rotation policy beyond `RemoteJwks`'s.
- JAR (RFC 9101) request objects, JARM, RAR (RFC 9396)
  `authorization_details`, mutual TLS (RFC 8705), and the implicit and
  password grants (removed by OAuth 2.1).
- Tokens in the query or body (RFC 6750 sections 2.2 and 2.3).
- Refresh token grace periods: a lost response during rotation means the
  user authorizes again.
- Revoked JWT access tokens stay valid at resources that verify locally
  until they expire (five minutes); introspection sees the revocation.
- Rate limits on user codes, the token endpoint and registration are the
  host's.

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev`: a whole authorization server on the Durable
Object store with an API on `@celld/router`, a client credentials service,
a DPoP client against a server that demands nonces, the device grant, and
token exchange (`buck2 test root//src/celld/oauth/examples/...`, and
`buck2 run root//src/celld/oauth/examples:<name>-dev`).

## Tests

```sh
buck2 test root//src/celld/oauth/...
```

The Deno suites: `core` (RFC 7636's PKCE vector, challenges, URL rules,
errors), `dpop` (RFC 9449's proofs of figures 2 and 13, its `jkt` and
`ath`, and every refusal), `client`, `resource`, `router` (the
`@celld/router` schemes: challenges, nonces on success and on a 403,
replay, a 503), `server` (every endpoint
and its negatives), `flow` (sessions against the servers in one process,
with and without DPoP, nonces at both servers, step-up, refresh,
registration), and `durable` (`OAuthRecords` over a fake SQL storage and
the server over it). `:runtime-test` runs `tests/runtime/worker.ts` under
`celld dev`: the Durable Object on real SQLite and RPC, a whole
authorization with and without DPoP, a replayed proof refused by the
durable replay store, and refresh rotation and reuse detection surviving
a supervisor restart.
