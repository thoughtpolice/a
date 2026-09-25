<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/oidc

OpenID Connect for celld: a relying party, an OpenID Provider, OpenID
Federation 1.0, and a broker that federates one provider to another with
DPoP on both sides. It is built on [`@celld/sec/oauth`](../oauth/README.md),
which does the OAuth work (PKCE, PAR, DPoP, tokens, client
authentication, storage); this library adds what OpenID Connect and
Federation define on top. JWS is [`@celld/sec/jwt`](../jwt/README.md)'s,
bounded reads are [`@celld/core/bounds`](../../core/README.md#celldcorebounds)'s, and outbound
fetches for discovery and federation go through
[`@celld/http`](../../http/README.md)'s `boundedFetch`. No other
dependencies, no Node APIs, no `eval`.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/sec/oidc:oidc"],
)
```

## Why it exists

`@celld/sec/oauth` gets a Worker an access token. Logging a person in needs
more: an ID token that says who they are and was minted for this login
(`nonce`, `at_hash`, `auth_time`), the provider's documents and endpoints
for it (Discovery, UserInfo, logout), and on the provider side the host
hooks that decide who is signed in. Federation adds the case where the two
parties have never met: each finds the other through a trust anchor both
trust, and the anchor's policies decide what either may use, including
whether tokens must be DPoP-bound. The broker is the common deployment
where one provider signs its users in at another and issues its own
tokens; DPoP has to hold on both hops without one party's key standing in
for the other's.

## Subpaths

| Import                   | What it has                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `@celld/sec/oidc`            | standard claims and scopes, the `claims` parameter, `tokenHash` (`at_hash`/`c_hash`), `discoverOpenIdProvider` |
| `@celld/sec/oidc/rp`         | `OidcClient`, `validateIdToken`, `LoginFlow`, `CookieSealer`                                       |
| `@celld/sec/oidc/provider`   | `OpenIdProvider`: ID tokens, UserInfo, end session, request objects, on `AuthorizationServer`      |
| `@celld/sec/oidc/federation` | entity statements, `FederationEntity` endpoints, `TrustChainResolver`, metadata policies, trust marks, registration |
| `@celld/sec/oidc/broker`     | `UpstreamBroker`, `boundTokenExchange`                                                              |
| `@celld/sec/oidc/testing`    | `testProvider`, `testBrowser`                                                                       |

Nothing imports `cloudflare:workers`. Storage that must be durable is
`@celld/sec/oauth`'s `RecordStore`, so `durableRecordStore` and its
`OAuthRecords` Durable Object serve the provider, the broker and the
federation cache.

### A relying party

```typescript
import { CookieSealer, LoginFlow, OidcClient } from "@celld/sec/oidc/rp";
import { DpopKey } from "@celld/sec/oauth/dpop";

const rp = new OidcClient({
  issuer: "https://login.example.com",
  client: { method: "none", clientId: "web" },
  redirectUri: "https://app.example.com/callback",
  dpop: await DpopKey.generate(),
});
const flow = new LoginFlow({
  client: rp,
  sealer: await CookieSealer.create({ secret: env.COOKIE_SECRET }),
});

// GET /login
return await flow.start(request, { scope: ["profile", "email"], maxAge: 3600, returnTo: "/account" });
// GET /callback
const { login, returnTo, clearCookie } = await flow.finish(request);
const profile = await rp.userinfo(login.tokens, login.subject);
```

`OidcClient` discovers `/.well-known/openid-configuration` (then the RFC
8414 locations) and refuses a document for another issuer or without the
members Discovery requires. `authorizationUrl` always sends `openid` and
a fresh `nonce`, plus `prompt`, `max_age`, `acr_values`, `login_hint`,
`id_token_hint`, `claims` and `ui_locales` when asked; `@celld/sec/oauth`
adds PKCE, `state`, PAR and `dpop_jkt`. The result is immutable, branded state
owned by this client; keep it privately until the callback. `completeLogin` checks the response (`iss`,
`state`, `error`), redeems the code, and validates the ID token.
`refresh` validates a refreshed ID token against the first (same `iss`,
`sub`, `aud`, `auth_time`; no `nonce`, or the first's unchanged). `userinfo` sends the token as Bearer or DPoP,
retries once on a `use_dpop_nonce` challenge, verifies a signed answer,
and refuses an answer about another `sub`. `logoutUrl` builds an
RP-Initiated Logout URL.

#### Discovery egress

Discovery goes through `@celld/sec/oauth`'s `metadataEgressPolicy` on
`@celld/http/egress`: https only, no redirects, a 5 second deadline, at
most 64 KiB read as a stream, bounded JSON, and no private, link-local
or loopback address (refused before anything is sent). The provider's
JWKS is a `RemoteJwks` under the same rules. For a provider on this
machine during development, `allowLoopbackForDevelopment: true` allows
`http:` to a loopback IP literal (`http://127.0.0.1:8080`, never
`http://localhost`); `egress` adjusts the policy (for instance
`{ network: "any" }` for a provider on a private network). Host names
are not resolved first: the runtime offers no DNS hook.

#### Resource-bound fetch

`resourceFetch(url, tokens, init)` and `resourceHeaders({ method, url },
tokens)` put the tokens only on URLs they are for: https (http to a
loopback literal only with `allowLoopbackForDevelopment`), no user
information or fragment, covered by configured endpoint policy, and covered
by the authorized grant's exact resources (same origin, path at or under the
resource's after dot segments are resolved). A default login grant with no
explicit resource covers only the exact provider UserInfo endpoint. Anything
else is the `OAuthError` `target`, thrown before any header exists, and
`resourceFetch` uses bounded, non-following fetch so a redirect cannot carry the
token elsewhere. `unsafeFetchResource` is the raw form (any URL, the
caller's redirect mode) for a caller that has checked the URL itself;
`resourceTarget(url)` is the check on its own.

#### Algorithm policy

The ID token algorithms accepted are `idTokenAlgorithms` (default
`DEFAULT_ID_TOKEN_ALGORITHMS`, never HMAC or `none`), narrowed to
`idTokenSignedResponseAlg` when the client registered one (from its
client information or registration response; federated clients set it
from their metadata), then to the provider's
`id_token_signing_alg_values_supported`. The intersection is computed
once: an empty one is a `TypeError` in the constructor (when `metadata`
is given, or the registered algorithm is not accepted) or the
`OAuthError` `discovery` from discovery, never a failed login later.
`refresh` passes `forbidNonce`, so a refreshed ID token carrying a
`nonce` is refused.

`validateIdToken` is OpenID Connect Core section 3.1.3.7 on its own, and
throws an `IdTokenError` whose `code` names the failed check: `alg` (in
the allowlist, never HMAC or `none`), `signature` (a `RemoteJwks` on
`jwks_uri` refetches for an unknown `kid`, which is key rotation), `iss`
exactly, `aud` (names the client, and no audience it does not trust),
`azp` (the client, required with several audiences), `exp`, `iat` (not in
the future, at most 10 minutes old), `nonce`, `auth_time` (required with
`max_age` and at most that old, unchanged on refresh), `acr` (one of an
essential request's values), `at_hash`, `c_hash` and `sub`.

`LoginFlow` keeps the pending login (PKCE verifier, `state`, `nonce`,
`max_age`) in a `__Host-` cookie sealed with AES-256-GCM by
`CookieSealer`, bound to the cookie's name and expiring after ten
minutes, so a Worker needs no store for the round trip and the callback
only completes in the browser that started it. `returnTo` must be a local
path. `CookieSealer` also seals sessions; old secrets can be kept for
rotation.

### A provider

```typescript
import { OpenIdProvider } from "@celld/sec/oidc/provider";
import { durableRecordStore } from "@celld/sec/oauth/durable";
import { signingKeyFromJwk } from "@celld/sec/oauth/server";
export { OAuthRecords } from "@celld/sec/oauth/durable";

const op = new OpenIdProvider({
  issuer: "https://login.example.com",
  keys: [await signingKeyFromJwk(JSON.parse(env.SIGNING_JWK), "ES256")],
  store: durableRecordStore(env.OAUTH_RECORDS),
  sessionSidKey: env.SESSION_SID_KEY, // 32 random bytes (base64url): keys the `sid` claim
  clients: [{
    client_id: "web",
    redirect_uris: ["https://app.example.com/callback"],
    post_logout_redirect_uris: ["https://app.example.com/"],
  }],
  interaction: async (context) => {
    const session = await mySession(context.request);
    if (session === null || context.needsLogin(session.authTime)) {
      if (context.prompt.includes("none")) return { deny: { error: "login_required" } };
      // Bind the interaction to this browser (a sealed cookie naming it)
      // before sending it to the login page.
      return new Response(null, {
        status: 303,
        headers: { location: `/login?i=${context.interactionId}`, "set-cookie": await bindInteraction(context.interactionId) },
      });
    }
    return { grant: { subject: session.user, authTime: session.authTime, sessionId: session.id, amr: ["pwd"] } };
  },
  claims: ({ subject, claims }) => users.claims(subject, claims),
});

export default {
  fetch: async (request: Request) => await op.handle(request) ?? await myPages(request),
};
```

The login and logout pages are the host's. The host must bind each
interaction to the browser that started it, so that a login page link
opened in another browser cannot finish it, and must CSRF-check its login
and logout forms. [`examples/provider.ts`](examples/provider.ts) does
both: the interaction hook sets a short-lived sealed `op_interaction`
cookie that `GET` and `POST /login` must match, and its forms go through
the router's CSRF policy (`csrf: true` with a double-submit token).

`OpenIdProvider` builds an `AuthorizationServer` and wraps it:

- `handle` serves `/.well-known/openid-configuration` (appended to the
  issuer, as Discovery says), UserInfo, `end_session`, the authorization
  endpoint (with request objects), and every authorization server
  endpoint. The RFC 8414 document carries the same OpenID members.
- The interaction hook sees `prompt`, `max_age`, `acr_values`,
  `login_hint`, a verified `id_token_hint`, the `claims` request and
  `needsLogin(authTime)`. Its grant is checked again against them:
  `prompt=login` needs an authentication after the request arrived,
  `max_age` needs a recent enough `authTime`, an essential `acr` must be
  met (`unmet_authentication_requirements`), and an `id_token_hint` must
  name the signed-in user; each failure goes back to the client as an
  error (`login_required`). With `prompt=none`, a page answer becomes
  `interaction_required`. `resumeAuthorization` applies the same checks.
  An unknown `prompt` value is `invalid_request`, and so is a repeated
  OpenID parameter (`nonce`, `prompt`, `max_age`, `claims`,
  `id_token_hint`, `acr_values`, `login_hint`, `display`, `ui_locales`),
  at the authorization endpoint (a plain 400), at the PAR endpoint and
  inside a request object; the OAuth ones are refused by `@celld/sec/oauth`.
- ID tokens go into token responses of `openid` grants (code, refresh,
  device): `iss`, `sub`, `aud`, `exp`, `iat`, `auth_time`, `nonce` (not on
  refresh), `acr`, `amr`, `at_hash`, `sid`, and the claims the `claims`
  parameter asks for by name. Scope claims (`profile`, `email`, `address`,
  `phone`) go to UserInfo unless `scopeClaimsInIdToken`. Every ID token
  carries the private claim `token_use: "id"` (see below). The signing
  key is the first key, or the one for the client's
  `id_token_signed_response_alg`; see "Algorithm policy".
- UserInfo is a `ResourceServer` over the provider's own token check, so
  it takes Bearer and DPoP tokens (with the provider's nonces and replay
  store), sees revocations, requires `openid`, and answers `sub` plus the
  scopes' claims and any the `claims` request named for UserInfo.
- A grant's `sessionId` becomes `sid`: an HMAC-SHA-256 of the issuer and
  the id under `sessionSidKey` (32 random bytes, base64url, a secret), so
  a `sid` neither discloses the id nor lets anyone test a guess at it. The
  key is required once a grant names a `sessionId`. A key shorter than 32
  bytes or with fewer than `SECRET_MIN_DISTINCT_BYTES` (12) distinct bytes
  (`"a".repeat(32)`, a repeated word) is a `TypeError`, as is the public
  `TEST_SESSION_SID_KEY` of `@celld/sec/oidc/testing` anywhere but
  `testProvider`; the same floor applies to `CookieSealer` and
  `encryptedSecretStore` secrets. A login session belongs to
  the first subject that uses it: a grant naming the same `sessionId` for
  another user, or an ended session, is `login_required`, and a lost race
  to record the session is read again and checked again.
- `end_session` (RP-Initiated Logout) takes an `id_token_hint` (expired
  or not), `client_id`, a `post_logout_redirect_uri` that must be
  registered for the client, and `state`. Registered
  `post_logout_redirect_uris` follow the redirect URI rule (https, http
  only to a loopback host, private-use schemes only for native clients,
  never `javascript:`): a configured client breaking it is a `TypeError`,
  a registration a 400, a federated client unknown, and a stored one is
  refused at logout; after the host's `endSession`
  hook it ends the session, and from then on its refresh tokens get
  `invalid_grant` and its access tokens no UserInfo. It ends the session
  only for a hint at most `endSessionHintMaxAgeSec` old (default
  `sessionTtlSec`, 30 days), and not when the hook answers. Without a
  hook, whoever holds the ID token ends the session from any browser,
  with no user present: ID tokens are logged, travel in logout URLs and
  sit with every relying party. A host that wants presence answers a
  confirmation page from the hook unless the browser's own session is the
  hint's `subject`, as `examples/provider.ts` does.
  `endLoginSession(sessionId)` does the same from the host's own logout.
- With `requestObjects`, a `request` parameter is a signed request object
  (RFC 9101): the client's registered keys (a `jwks` of at most 64 keys,
  none symmetric: a set holding an `oct` key or a `k` is refused whole,
  and its encryption keys are skipped; or a `jwks_uri` fetched under the
  server's `egress` policy), an
  asymmetric `alg`, `iss` the client, `aud` the issuer, `iat` required
  and at most an hour old (`maxTokenAge`), `exp` at most an hour after
  `iat` and after now (so a far-future `iat`/`exp` pair is refused), a
  `jti` used once, and no `sub`.

#### ID token hints

An `id_token_hint`, at the authorization endpoint or at `end_session`,
counts only when it is an ID token this provider issued to the client
making the request:

- signed by one of the provider's keys with `typ` `JWT`, and carrying the
  private claim `token_use: "id"`. The provider and its authorization
  server share keys, and access tokens (`typ` `at+jwt`) carry `sub`,
  `aud` and even `sid`; the marker and the `typ` keep an access token
  from passing as a hint, and a host's grant `claims` can never add the
  marker to one. RPs ignore claims they do not know, so it costs no
  interoperability. ID tokens issued before this marker existed are not
  accepted as hints;
- `iss`, `sub`, `aud`, `iat` and `exp` present, `aud` naming the client,
  and `azp` (when present, or with several audiences) the client. At the
  authorization endpoint the client is the request's; at `end_session` it
  is `client_id`, or without one the hint's `azp` or single audience, and
  it must be a registered client, or nothing ends;
- expired hints are accepted on purpose (a user logging out after the ID
  token lapsed is the common case): the signature and claims are checked
  as of the hint's `iat`. At `end_session` a hint older than
  `endSessionHintMaxAgeSec` still names the client but ends no session.

#### Algorithm policy

A client's `id_token_signed_response_alg` must be one of the provider's
keys' algorithms: configured clients are checked in the constructor (a
`TypeError`), dynamic registrations get `invalid_client_metadata`,
clients from `resolveClient` are unknown, and any other client (a stored
one, say) is `unauthorized_client` at the authorization endpoint. There
is no fallback to another key: a client that asked for RS256 never gets
an ES256 ID token. `id_token_signing_alg_values_supported` lists the
keys' algorithms.

#### Introspection and egress

`OpenIdProviderOptions` extends `@celld/sec/oauth`'s
`AuthorizationServerOptions`, so it takes its `introspection` policy
(default deny: every access token is `{ active: false }` until an
`audiences` map or `authorize` hook allows a resource server) and its
`egress` policy (https, public addresses, no redirects, bounded) for
what it fetches from URLs clients name (`jwks_uri` for request objects
too). There is no separate development switch for those, as on the
authorization server: during development, register the client's keys
inline (`jwks`), or set `egress: { network: "loopback",
allowCleartextLoopbackForDevelopment: true }` to allow
`http:` to a loopback IP literal (never `localhost`). Keys must come
from `generateSigningKey`/`signingKeyFromJwk` and have distinct `kid`s.
The provider copies its options when made (keys, clients, switches such
as `requestObjects`), so the signing key, the JWKS and the metadata
always agree; `OidcClient`, `LoginFlow`, `UpstreamBroker`,
`TrustChainResolver`, `FederationEntity`, `federatedClients` and
`ExplicitRegistration` copy theirs too.

An `openid` request without a resource gets an access token for UserInfo
(`resources.default` is the UserInfo URL, and UserInfo is always an
allowed resource). `OidcClient` adds UserInfo to a login's resources when
it names others, so one token works at both.

### Federation

```typescript
import { FederationEntity, TrustChainResolver, federatedClients } from "@celld/sec/oidc/federation";

const anchor = new FederationEntity({
  entityId: "https://ta.example.org",
  keys: [federationKey],
  subordinates: {
    "https://op.example.com": {
      jwks: OP_FEDERATION_JWKS,
      metadataPolicy: {
        openid_provider: { dpop_signing_alg_values_supported: { subset_of: ["ES256"] } },
        openid_relying_party: { dpop_bound_access_tokens: { value: true } },
      },
    },
  },
});

const resolver = new TrustChainResolver({
  trustAnchors: [{ entityId: "https://ta.example.org", jwks: TA_JWKS }],
  cache: durableRecordStore(env.OAUTH_RECORDS, { name: "federation" }),
});
const chain = await resolver.resolve("https://rp.example.net");
chain.metadata.openid_relying_party; // after the chain's policies
```

`FederationEntity` is one entity's endpoints as `(Request) => Response`
handlers: the entity configuration at `/.well-known/openid-federation`
(appended to the entity identifier), and with subordinates the fetch
(`?sub=`) and list endpoints, plus the resolve endpoint when it has a
resolver. It signs on request with the first federation key and the
configuration it was made with (copied then): rotate keys by making a new
entity, and use the function forms (`metadata`, `trustMarks`,
`subordinates: { get, list }`) for what changes while it runs. Its keys
must come from the key helpers, and a subordinate's or trust mark
owner's `jwks` must hold public keys only (a `TypeError` otherwise; for
`subordinates.get`, a 500 at the fetch).

`TrustChainResolver.resolve` walks `authority_hints` up to a configured
anchor, depth first, never revisiting an entity on the path (loops), at
most `maxPathLength` intermediates deep. Every candidate chain goes through `validate`, shortest
first: section 10.2's signature rules (`ES[j]` verifies with a key in
`ES[j+1].jwks`, the leaf also with its own, the anchor with its
configured keys, `kid` required), `iat`/`exp` everywhere, the immediate
superior among the leaf's `authority_hints`; then every subordinate
statement's constraints (`max_path_length`, `naming_constraints` with
RFC 5280 host rules, `allowed_entity_types`); then the superior's
`metadata`, then the merged policies. A `crit` claim or a critical policy
operator it does not understand invalidates the chain. The chain expires
at its earliest `exp`, counting the trust marks it accepted, their
delegations, and the trust chains of their issuers (a mark is only as
good as its issuer's standing in the federation), so a cached chain or a
resolve response never carries a mark past its expiry or its issuer's
(a cache hit also drops any mark that has expired). A rejected mark
shortens nothing.
A chain with a mark rejected because its issuer could not be resolved
(a failure that may pass) is cached for at most `TRANSIENT_RETRY_SEC`
(60 seconds). Fetched statements are cached (memory or a
`RecordStore`) until they expire and are verified on every use; if a
resolution fails with cached statements it is tried once more from the
source, which is what happens after an anchor rotates its keys.

#### Federation limits

One `resolve` call is one resolution, and everything it causes shares
one budget: `maxFetches` network fetches (default 64) and `maxNodes`
statements and chains (default 256; cached statements count, so a warm
cache cannot make a resolution unbounded). The trust marks' issuers are
resolved inside the same resolution, for their keys only (their own
marks are not checked, so issuers never recurse), and one resolution per
issuer serves every mark it issued. A mark whose issuer's chain would
need the entity being resolved (a self-issued mark, an A <-> B cycle) is
rejected with the code `cycle`, one past `MAX_TRUST_MARK_DEPTH` with
`depth`; `rejectedTrustMarks` carries the `code`. A spent budget fails
the whole resolution with the `FederationError` `budget`. Only a chain
whose own marks were checked is cached past its resolution. A caller may
pass its own `budget` (`{ fetches, nodes }`, spent in place) to bound
several resolutions together. Within one resolution a URL is fetched at
most once: superiors that all name one `federation_fetch_endpoint` share
its answer (or its failure). Across resolutions each origin gets at most
`fetchRate` fetches per window (default `{ perOrigin: 120, windowSec: 60
}`); past it a fetch to that origin fails with `fetch` until the window
ends, so whatever makes the resolver fetch cannot aim it at one host
faster than that. Cached chains keep working while an origin is limited.

Bodies this package reads are capped while they stream: an explicit
registration's posted entity configuration at `STATEMENT_MAX_BYTES` (413
above it), `end_session`'s form at 16 KiB (413), and a UserInfo answer
at 256 KiB with bounded JSON (a `token` error).

Every statement is fetched through `@celld/http/egress`'s `boundedFetch`
under `@celld/sec/oauth`'s `metadataEgressPolicy`: https only, no redirects,
a 5 second deadline, at most 256 KiB (`STATEMENT_MAX_BYTES`) read as a
stream, and no private, link-local or loopback address (checked on the
literal host before anything is sent; host names are not resolved, as
the runtime offers no DNS hook). `allowLoopbackForDevelopment` allows
`http:` to a loopback IP literal, and `egress` adjusts the policy.
Federation key sets (`jwks`, a trust mark owner's) hold at most 64 keys
(`MAX_FEDERATION_KEYS`).

The resolve endpoint is public, so a request names one `sub` (an entity
identifier the resolver's egress policy could fetch: never a private
literal host on the public network) and at most four trust anchors
(`MAX_RESOLVE_ANCHORS`), and all its work shares one `resolveBudget`
(default 32 fetches and 128 nodes).

Metadata policies implement all seven standard operators with their
value types, combination rules (`one_of` never with `add`, `subset_of`
or `superset_of`; `value` and `add` against the others' values) and merge
rules (equal `value` and `default`, union of `add` and `superset_of`,
intersection of `one_of` (non-empty) and `subset_of`, OR of `essential`),
applied in the order `value`, `add`, `default`, `one_of`, `subset_of`,
`superset_of`, `essential`, with `scope` as a list. `resolveMetadataPolicy`
and `applyMetadataPolicy` are exported for other uses.

Trust marks on the leaf are validated against the anchor's
`trust_mark_issuers` (the anchor itself may always issue), with the
issuer's keys from its own chain to the same anchor, and a delegation
from the type's owner when `trust_mark_owners` names one. Valid marks are
in `chain.trustMarks`; the rest in `rejectedTrustMarks` with the reason.
`FederationEntity.issueTrustMark` and `issueTrustMarkDelegation` issue
them.

Registration, provider side: `federatedClients({ resolver })` is a
`resolveClient` for the provider. A client id that is an entity
identifier resolves to the RP's chain; its `openid_relying_party`
metadata after policies becomes the client, which must list `automatic`
in `client_registration_types` and authenticate with `private_key_jwt`
using the keys in that metadata (at PAR and the token endpoint, with the
provider's issuer as audience, as section 12.1.1.2 requires). Anyone can
name an entity identifier as `client_id`, so one lookup spends at most
`resolveBudget` (default 16 fetches and 64 nodes, within the resolver's
limits), and a failed lookup is remembered for 60 seconds.
`ExplicitRegistration` is the `federation_registration_endpoint`: the RP
posts its entity configuration (`aud` the provider), the provider
resolves a chain with it as the leaf, stores the client until the chain
expires, and answers an `explicit-registration-response+jwt`.

Registration, RP side: `federatedOidcClient` resolves the provider's
chain (its `openid_provider` metadata is used instead of Discovery) and
the RP's own (to see what the policies made of its metadata), then builds
an `OidcClient` with the entity identifier as `client_id`,
`private_key_jwt` with the RP's key, PAR always, and DPoP as the next
section describes. The provider's `issuer` must be its entity identifier
(an `OAuthError` `discovery` otherwise): the chain vouches for the entity,
not for whatever issuer its metadata names.

### The broker

```typescript
import { boundTokenExchange, encryptedSecretStore, UpstreamBroker } from "@celld/sec/oidc/broker";

const secrets = await encryptedSecretStore(durableRecordStore(env.OAUTH_RECORDS), {
  secret: env.BROKER_SECRET, // 32 random bytes (base64url)
});
const broker = new UpstreamBroker({ upstream: upstreamClient, sealer, secrets });
const op = new OpenIdProvider({
  ...,
  interaction: (context) => broker.begin(context.interactionId, context.request, { maxAge: context.maxAge }),
  claims: ({ subject, claims }) => broker.claims(subject, claims),
  tokenExchange: boundTokenExchange({ sourceAudiences: [API_AUDIENCE] }),
});
// GET /upstream/callback
return await broker.finish(op, request, { sessionId });
```

`begin` sends the user to the upstream with the pending login sealed in a
cookie; `finish` completes the upstream login (the ID token validated, the
upstream UserInfo read), keeps the upstream tokens under the downstream
subject, and resumes the downstream authorization with the upstream's
`auth_time`, `acr` and `amr` (without an upstream `auth_time` the grant
has none, so `prompt=login` and `max_age` fail closed instead of
counting the upstream login as fresh). Records are keyed by the upstream
issuer and the subject (`brokerRecordKey`), and a record from another
upstream never reads as this broker's; the default subject is the
upstream `sub`, unique only within that upstream. `fetchUpstream` calls upstream APIs for a
user with the broker's tokens and key, refreshing them when they expire,
through the upstream client's `resourceFetch`: a URL the upstream tokens
are not for is refused before any token is read (`unsafeFetchUpstream`
is the raw form).

#### Broker storage

The broker must use its users' upstream access and refresh tokens again,
so unlike the authorization server's own records it cannot store them
hashed. It keeps them in a `SecretStore` (`get`, `put`, `swap`, the
`RecordStore` contract with confidentiality at rest required), and
`encryptedSecretStore(recordStore, { secret, previous })` provides one
over any `RecordStore`: each value sealed with AES-256-GCM under a key
derived from the operator secret (HKDF-SHA-256), with the record key as
associated data, so a dump of the store holds no usable token and a
value copied under another user's key does not open. `previous` secrets
still open old values during a rotation, and a value opened with one is
sealed again under `secret` as it is read (a compare-and-swap that keeps
its expiry, best effort). Values nobody reads stay under the old secret
until they expire, so drop a previous secret once the broker's
`keepSec` (default 30 days) has passed since the rotation; a value no
secret opens reads as absent (the user signs in upstream again).

`upstreamTokens` combines isolate-local singleflight with a durable CAS
refresh intent shared across isolates. Only the fenced owner contacts the
upstream; waiters reread committed results. A 20-second network deadline is
inside a 30-second intent, and waiters return a bounded 503 rather than hang.
Uncommitted tokens are never returned. After a crash or ambiguous network
failure the rotation token is never retried: an expired intent requires a
fresh upstream login, which atomically replaces it. This deliberate recovery
rule trades availability for preventing upstream family revocation; a generic
store cannot know whether a remote server consumed a rotation token. A still
valid previous access token may be used by the failed attempt's caller.

## Security contracts and migration

Supplied, discovered and federation-derived provider metadata go through the
same strict validator and endpoint policy, then become deeply immutable.
Unknown protocol extensions remain JSON data, not executable properties.
Metadata, chain and resolved-client cache hits return frozen graphs, without
re-copying the graph on every hit. Reconfiguration creates a new client.

`await rp.ready()`, `await op.ready()` and `await entity.ready()` check configured
crypto before traffic. The prepared ID-token validator is reused across login
and refresh; `createIdTokenValidator` exposes the same base-policy/per-login
split for custom flows. `completeLogin` passes the validated authorization code
only to the bounded ID-token check, so every present `c_hash` is checked without
persisting the code. `requireCodeHash` is an explicit low-level policy for flows
whose profile requires the hash; ordinary code flow does not require it absent.

`Login.tokens` is OAuth's immutable, runtime-owned `AuthorizedGrant`, not an
arbitrary `TokenSet`. Use `rp.refresh(login.tokens, login.claims)` and
`rp.logoutUrl({ idTokenHint: login.tokens })`; hints, refresh and resource calls
reject a grant owned by another issuer/client/client-instance/DPoP generation.
Refresh narrows or preserves resources and scopes. Configuring API A and B
does not authorize sending A's token to B. Raw HTTP is available only through
the explicit unsafe methods. JSON serialization loses runtime ownership:
only after authenticating confidential storage may a host call
`rp.unsafeRestoreGrant(saved)` or `rp.unsafeRestorePendingLogin(saved)`.
The broker and LoginFlow do this behind their authenticated storage boundary.
Never apply those methods to a browser-supplied JSON object or unsigned cookie.

UserInfo uses credential-endpoint egress policy before constructing headers,
with bounded duration/body/JSON and no followed redirects. Unsigned replies
must be `application/json`; signed replies require the exact separately
registered `userinfoSignedResponseAlg` and corresponding provider capability,
and carry the provider's `iss`, the client in `aud` and the login's `sub`;
`exp` is optional there (Core section 5.3.2) and enforced when present.
Registering signing rejects an unexpected unsigned reply. DNS rebinding cannot
be prevented by validating URL spelling: deploy with platform DNS/IP outbound
controls. Private-network access requires explicit policy. Handlers compare
the request URL's origin to the configured public origin before credentials;
trusted reverse-proxy reconstruction belongs at the router boundary, before
passing the Request here. Never trust arbitrary forwarded headers.

`LoginFlow.start(request, options)` and `broker.begin(id, request, options)`
use distinct sealed state-specific cookies for parallel tabs; pass the actual
incoming Request. Four pending cookies per flow and a 16 KiB incoming Cookie
budget bound browser storage. Each expires in ten minutes and completion
deletes the exact transaction cookie. HTTPS defaults use `__Host-`, Secure,
HttpOnly, SameSite=Lax and Path=/, with no Domain. Sealed values are at most
3800 bytes, JSON at most2700 bytes/depth16/256 values, and at most three previous
keys are tried. Larger sessions belong in encrypted server storage, with an
opaque session cookie. Session TTL is bounded to30 days. Errors must clear a
failed transaction cookie at the application boundary when an HTTP response
is produced; failed/expired state never redeems a code.

Provider capability policy is reject-or-implement, for static, resolved and
registered clients and again before issuing tokens:

| Client metadata requirement | Supported behavior |
| --- | --- |
| `subject_type: public` | Public subjects; `pairwise`/sector metadata rejected |
| `id_token_signed_response_alg` | Exact available asymmetric signing algorithm |
| `request_object_signing_alg` | Exact algorithm, only with request objects enabled |
| `post_logout_redirect_uris` | Registered exact URI; verified ID-token hint |
| `userinfo_signed_response_alg` | Rejected: this provider implements JSON UserInfo |
| ID-token/UserInfo/request encryption | Rejected: no encryption capability |
| `default_max_age`, `require_auth_time`, `default_acr_values` | Rejected; explicit request freshness/ACR is enforced |
| Front/back-channel logout configuration | Rejected; RP-initiated logout only |

General `essential`, `value` and `values` claim constraints are rejected before
authorization unless implemented (`id_token.acr` and `auth_time`). Unconstrained
claim projection is bounded, prototype-safe and cannot override protocol
claims. Do not assume a hook can silently promise unsupported constraints.
The Ed25519 WebCrypto key supports both standardized JOSE wire names: `EdDSA`
(RFC8037) and fully specified `Ed25519` (RFC9864). Both are consistently listed
by RP, request-object and federation policy. They remain exact wire values:
metadata and configured policy must match the chosen signer; no token's header
is rewritten or treated as another algorithm. Readiness checks runtime support.

Automatic federated clients require PAR. Client generation includes the chosen
chain, accepted trust marks and expiry; pending protocol records are bound to
that generation. RP-side federated clients refuse operations after the earlier
provider/self-chain expiry or `policyMaxAgeSec` (default/maximum one hour):
construct a replacement after re-resolution. The returned `validUntil` is the
exact epoch-millisecond deadline, so callers need not reconstruct this bound.
Revocation is observable within bounded statement/cache lifetimes (resolver
default one hour, resolved client default five minutes, never past chain/mark
expiry), not instantaneously; use operator invalidation or a revocation feed
for immediate changes. Negative resolved-client cache TTL is60 seconds.

Superior naming constraints cover the leaf and every subordinate intermediate.
DNS comparison is lowercase ASCII (URL IDNA normalization), strips a terminal
dot, ignores ports, and compares label boundaries; IP literals cannot satisfy
a DNS constraint. Trust-mark policy uses own entries only: an explicit empty
issuer list means any chain-trusted issuer for that explicit type, never an
inherited/prototype rule. Statements have bounded JSON/schema/hints/keys/marks.
Resolvers share one fetch/node budget across branches/marks and deduplicate
same-URL work; per-origin120/minute and global512/minute defaults supplement
per-resolution64-fetch/256-node limits. List endpoints cap256 IDs/64 KiB and
run at most8 lookups concurrently within5 seconds. Data hooks are trusted pure
lookups, receive cancellation signals, have a2-second deadline and bounded
JSON output, and must honor cancellation; synchronous CPU work cannot be
preempted by a JavaScript library. Never put external side effects in them.

Broker keys are `broker:v2:` plus a fixed52-character HMAC digest; raw issuer
and subject never enter record keys. Supply a stable independent
`identitySecret` to `encryptedSecretStore`; retain it while rotating encryption
`secret`/`previous`. Upgrades intentionally do not probe legacy raw-identity
keys: either require re-login (old records expire), or perform an access-controlled
offline migration that decrypts and re-seals each value under its derived v2
key because AEAD associated data changes. Do not log legacy keys/preimages.

## DPoP across federation

Three parties, three keys: the app (A), the broker (B) and the upstream
provider (U). A and B are relying parties in the federation, B and U are
providers. Each key stays with its owner.

```
        app A                       broker B                       upstream U
   key K_A (DPoP)            key K_B (DPoP, as RP of U)
      |  PAR, private_key_jwt(A)  |                                   |
      |  DPoP proof by K_A,       |                                   |
      |  dpop_jkt = jkt(K_A) ---->|  PAR, private_key_jwt(B)          |
      |                           |  DPoP proof by K_B,               |
      |                           |  dpop_jkt = jkt(K_B) ------------>|
      |                           |<-- code bound to jkt(K_B) --------|
      |                           |  token request, proof by K_B ---->|
      |                           |<-- tokens, cnf.jkt = jkt(K_B) ----|
      |                           |  UserInfo, DPoP by K_B ---------->|
      |<-- code bound to jkt(K_A) |                                   |
      |  token request, K_A ----->|                                   |
      |<-- tokens, cnf.jkt = jkt(K_A)                                 |
      |  UserInfo, DPoP by K_A -->|                                   |
      |  token exchange, K_A ---->|  (subject token's cnf.jkt must be jkt(K_A);
      |<-- new token, cnf.jkt = jkt(K_A)       the new one is bound to it too)
```

What is bound to what:

| Hop | Code bound to | Tokens bound to | Proven by | Who holds the tokens |
| --- | --- | --- | --- | --- |
| A → B | `jkt(K_A)` (`dpop_jkt` at PAR) | `jkt(K_A)` | A's proofs at B's token endpoint, UserInfo, resources | A |
| B → U | `jkt(K_B)` | `jkt(K_B)` | B's proofs at U | B, in its store; never sent downstream |
| exchange at B | | `jkt(K_A)` again | A's proof, which must match the subject token's `cnf.jkt` | A |

- The federation decides that DPoP is used. A policy such as
  `openid_relying_party: { dpop_bound_access_tokens: { value: true } }`
  makes every RP's resolved metadata require it. The provider's
  `federatedClients` puts that into the client record, so the
  authorization server refuses a token or PAR request from that client
  without a proof (`invalid_dpop_proof`). The RP's `federatedOidcClient`
  reads its own resolved metadata and refuses to start without a key.
- The federation limits the algorithms. A policy on
  `openid_provider.dpop_signing_alg_values_supported` (`subset_of`)
  narrows what each provider advertises; the RP checks its key's
  algorithm against the resolved list before sending anything.
- The two hops are independent. A downstream token is bound to the app's
  key and names the broker as issuer; it is refused upstream (another
  issuer) and as a Bearer token anywhere. The broker's upstream tokens are
  bound to the broker's key and never leave the broker; its key never
  signs for the app, and the app's key never reaches the upstream.
- Token exchange at the broker (`boundTokenExchange`) keeps the binding:
  the requester must prove the key the subject token is bound to (the
  authorization server passes the proof's thumbprint as `jkt`), the new
  token is bound to that same key, a bound token cannot be exchanged into
  an unbound one or rebound to another key, scopes can only narrow, and a
  client exchanges only its own tokens unless listed as an actor (`act`).
  Re-exchange preserves the existing actor chain; a different authorized
  actor is nested above it, with the server's four-actor depth limit.
- Client authentication is separate from DPoP: `private_key_jwt` proves
  the RP's registered keys from the federation metadata; DPoP proves the
  per-instance key the tokens are bound to.

## Security defaults

| Default | Where | Why |
| --- | --- | --- |
| Every login sends a fresh 128-bit `nonce`, and the ID token must carry it | rp | replay of an ID token into another login |
| ID tokens: `iss` exact, `aud` names the client and no untrusted party, `azp` with several audiences | rp | tokens minted for someone else |
| ID token `alg` from an allowlist; HMAC and `none` never | rp | the client secret is not a signing key; no unsigned tokens |
| The allowlist is intersected with the registered `id_token_signed_response_alg` and the provider's metadata; empty is a configuration error | rp | no silent algorithm drift, no login failing at token time |
| Tokens go only to the `userinfo_endpoint` and configured `resources`, https, no redirects | rp, broker | a caller-chosen URL cannot collect the access token |
| Discovery and JWKS: https, public addresses, no redirects, 5 s, bounded bodies | rp | SSRF, hung or huge answers |
| `at_hash` checked whenever present; `c_hash` too | rp | a swapped access token or code |
| `max_age` enforced on both sides against `auth_time` | rp, provider | a stale session passed off as fresh |
| A refreshed ID token must keep `sub` and `auth_time`, and carries no `nonce` | rp, provider | OpenID Connect Core 12.2 |
| UserInfo answers about another `sub` are refused | rp | a swapped token changing who the user is |
| The pending login lives in a sealed, name-bound, ten-minute `__Host-` cookie | rp | login CSRF, tampering, and no store needed |
| `returnTo` must be a local path | rp | open redirects |
| The host's grant is re-checked against `prompt`, `max_age`, `acr` and `id_token_hint` | provider | a host that forgets a parameter fails closed |
| `prompt=none` never shows a page | provider | the RP asked for no interaction |
| Logout only redirects to a registered `post_logout_redirect_uri` | provider | open redirects |
| An ended session gets no ID tokens on refresh and no UserInfo | provider | logout means logout |
| `sid` is an HMAC of the host's session id under `sessionSidKey`; a session is one user's | provider | the id is not disclosed or guessable; no session fixation across users |
| `id_token_hint` must be an ID token (`typ` `JWT`, `token_use: "id"`) for the requesting client | provider | an access token or another client's token cannot end a session or steer a login |
| Unknown `prompt` values and repeated OpenID parameters are `invalid_request` | provider | parameter confusion between parsers |
| A client's `id_token_signed_response_alg` must have a key; no fallback | provider | a login failing silently in another algorithm |
| Request objects: client keys (never `oct`), asymmetric, `aud` the issuer, one use, no `sub`, `iat` required, an hour at most from issue and from now | provider | forged or replayed requests; no reuse as a client assertion; no far-future objects |
| Protocol claims in ID tokens cannot come from the claims hook | provider | a user attribute cannot set `iss` or `nonce` |
| Federation JWTs need their exact `typ` and a `kid`; asymmetric algorithms only | federation | cross-JWT confusion (RFC 8725) |
| Unknown critical claims and critical policy operators invalidate the chain | federation | no silent weakening |
| Loops, paths longer than `maxPathLength`, and one `maxFetches`/`maxNodes` budget for a resolution and its trust mark issuers end a resolution | federation | resource exhaustion |
| Trust mark issuer cycles and self-issued marks are `cycle`; issuers are resolved once, for keys only | federation | unbounded recursion |
| Statements are fetched without following redirects, over https to public addresses, in 5 s and 256 KiB, and must be `application/entity-statement+jwt` | federation | SSRF, hung or huge answers, confusion with other content |
| The resolve endpoint takes one public `sub`, four anchors and a per-request budget | federation | an open fetch proxy |
| Automatic registration needs `automatic`, `private_key_jwt`, and the RP's resolved keys | federation | the federation vouches for the client's keys, nothing else does |
| A bound subject token is only exchanged with its own key's proof | broker | stolen tokens stay useless |
| Upstream tokens are encrypted at rest (`SecretStore`), refreshed once per subject, and only committed tokens are returned | broker | a store dump or a refresh race does not leak or fork tokens |

## Specification coverage

| Specification | RP | Provider | Notes |
| --- | --- | --- | --- |
| OpenID Connect Core 1.0: code flow, ID token validation (3.1.3.7), `at_hash`/`c_hash` | yes | yes | code flow only (no implicit or hybrid) |
| Core: `nonce`, `prompt`, `max_age`, `acr_values`, `login_hint`, `id_token_hint`, `ui_locales` | yes | yes | `display` and `claims_locales` are passed through, not acted on |
| Core: standard claims, scope claims (5.4), `claims` parameter (5.5) | yes | yes | `value`/`values` of claim requests other than `acr` are not enforced |
| Core: UserInfo (5.3), plain JSON | yes | yes | signed UserInfo: verified by the RP, not produced by the provider |
| Core: request objects by value (6.1) | | yes | not `request_uri`, not encrypted |
| Core: refresh with ID tokens (12.2) | yes | yes | |
| OpenID Connect Discovery 1.0 | yes | yes | no WebFinger |
| OpenID Connect RP-Initiated Logout 1.0 | yes | yes | |
| RFC 9449 DPoP at UserInfo and across a broker | yes | yes | |
| RFC 8693 token exchange keeping `cnf.jkt` | | yes (broker) | |
| OpenID Federation 1.0: entity statements (3), configuration endpoint (9) | yes | yes | |
| Federation: fetch (8.1), list (8.2), resolve (8.3) endpoints | | yes | resolve is unauthenticated, and bounded per request |
| Federation: trust chain resolution and validation (10) | yes | yes | |
| Federation: metadata policy, all standard operators (6.1) | yes | yes | |
| Federation: constraints (6.2) | yes | yes | |
| Federation: trust marks and delegation (7), validation | yes | yes | issuance too; no status or listing endpoints |
| Federation: automatic registration (12.1) | yes | yes | PAR with `private_key_jwt`, or a request object at the provider |
| Federation: explicit registration (12.2) | | yes | entity configuration bodies; not `trust-chain+json` |

## Not done

- Implicit and hybrid flows, `form_post` and other response modes,
  `id_token` response types: `@celld/sec/oauth` serves `code` with `query`
  only, as OAuth 2.1 does.
- Pairwise subject identifiers, encrypted ID tokens or UserInfo, signed
  UserInfo answers from the provider, `request_uri` by reference,
  front- and back-channel logout, session management iframes, WebFinger,
  dynamic registration of OpenID-specific client metadata beyond what
  `@celld/sec/oauth` validates.
- Federation: the trust mark status and listing endpoints, historical
  keys, `trust_chain` and `peer_trust_chain` header parameters on
  requests, `signed_jwks_uri`, `trust-chain+json` registration bodies,
  mutual TLS, and authenticated federation endpoints (section 8.8).
- RP-side automatic registration with a request object: `OidcClient`
  uses PAR, which the provider must offer.
- Downstream DPoP in the example specs: a spec cannot sign proofs, so the
  broker example's downstream client uses Bearer; `tests/flow_test.ts`
  covers DPoP on both hops.
- A token signed with an algorithm the runtime cannot verify is not
  reported as a bad signature: `@celld/sec/jwt`'s `runtime_unsupported` error
  is rethrown from ID token, UserInfo, request object and federation
  checks, so it surfaces as a server error naming the cause.

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev`: `provider` (an OpenID Provider on the Durable
Object store with a login page bound to the browser that started the
interaction, CSRF-checked forms, `prompt`, logout that clears the
provider's cookie, and restarts), `login` (a relying party web app with
`LoginFlow`, a cookie session, and a CSRF-checked POST logout against a
fake provider), `federation` (a trust anchor with leaf entities,
policies, trust marks and the federation endpoints) and `broker` (a
provider that signs users in at a fake upstream with DPoP on the upstream
hop). Run one with `buck2 run root//src/celld/sec/oidc/examples:<name>-dev`.

## Tests

```sh
buck2 test root//src/celld/sec/oidc/...
```

The Deno suites: `core` (claims, hashes, the `claims` parameter,
Discovery, sealed cookies), `idtoken` (OpenID Connect Core appendix A's
tokens verified with the appendix A.7 key, `at_hash` and `c_hash`
vectors, and every refusal of `validateIdToken`, key rotation), `provider`
(the configuration, logins, UserInfo with Bearer and DPoP and nonces, the
`claims` parameter, `prompt`/`max_age`/`acr`/`id_token_hint` enforcement,
resumed interactions, refresh, logout, request objects), `rp`
(`LoginFlow`), `policy` (the Federation specification's policy example of
section 6.1.5, table 1, and every operator, combination and merge),
`regressions` (one or more tests per Daybreak audit finding, named
after it), `chain` (anchor, intermediate and leaf fixtures: expiry, bad signatures,
untrusted anchors, loops, path length, naming constraints, entity types,
superior metadata, policy conflicts, critical claims, the statement
cache and key rotation, trust marks and delegation, the resolve
endpoint), and `flow` (a federation of an anchor, an upstream provider, a
broker and an app: automatic registration, DPoP-bound tokens on both hops,
token exchange keeping the binding, refusals, explicit registration,
logout). `:runtime-test` runs `tests/runtime/worker.ts` under
`celld dev`: a DPoP login with UserInfo on the `OAuthRecords` Durable
Object, a refresh after a restart, a logout whose ended session outlives
another restart, and a trust chain through the durable statement cache,
refetched after a restart rotates the keys.
