<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/oidc

OpenID Connect for celld: a relying party, an OpenID Provider, OpenID
Federation 1.0, and a broker that federates one provider to another with
DPoP on both sides. It is built on [`@celld/oauth`](../oauth/README.md),
which does the OAuth work (PKCE, PAR, DPoP, tokens, client
authentication, storage); this library adds what OpenID Connect and
Federation define on top. JWS is [`@celld/jwt`](../jwt/README.md)'s. No
other dependencies, no Node APIs, no `eval`.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/oidc:oidc"],
)
```

## Why it exists

`@celld/oauth` gets a Worker an access token. Logging a person in needs
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
| `@celld/oidc`            | standard claims and scopes, the `claims` parameter, `tokenHash` (`at_hash`/`c_hash`), `discoverOpenIdProvider` |
| `@celld/oidc/rp`         | `OidcClient`, `validateIdToken`, `LoginFlow`, `CookieSealer`                                       |
| `@celld/oidc/provider`   | `OpenIdProvider`: ID tokens, UserInfo, end session, request objects, on `AuthorizationServer`      |
| `@celld/oidc/federation` | entity statements, `FederationEntity` endpoints, `TrustChainResolver`, metadata policies, trust marks, registration |
| `@celld/oidc/broker`     | `UpstreamBroker`, `boundTokenExchange`                                                              |
| `@celld/oidc/testing`    | `testProvider`, `testBrowser`                                                                       |

Nothing imports `cloudflare:workers`. Storage that must be durable is
`@celld/oauth`'s `RecordStore`, so `durableRecordStore` and its
`OAuthRecords` Durable Object serve the provider, the broker and the
federation cache.

### A relying party

```typescript
import { CookieSealer, LoginFlow, OidcClient } from "@celld/oidc/rp";
import { DpopKey } from "@celld/oauth/dpop";

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
return await flow.start({ scope: ["profile", "email"], maxAge: 3600, returnTo: "/account" });
// GET /callback
const { login, returnTo, clearCookie } = await flow.finish(request);
const profile = await rp.userinfo(login.tokens, login.subject);
```

`OidcClient` discovers `/.well-known/openid-configuration` (then the RFC
8414 locations) and refuses a document for another issuer or without the
members Discovery requires. `authorizationUrl` always sends `openid` and
a fresh `nonce`, plus `prompt`, `max_age`, `acr_values`, `login_hint`,
`id_token_hint`, `claims` and `ui_locales` when asked; `@celld/oauth`
adds PKCE, `state`, PAR and `dpop_jkt`. The result is plain data to keep
privately until the callback. `completeLogin` checks the response (`iss`,
`state`, `error`), redeems the code, and validates the ID token.
`refresh` validates a refreshed ID token against the first (same `iss`,
`sub`, `aud`, `auth_time`). `userinfo` sends the token as Bearer or DPoP,
retries once on a `use_dpop_nonce` challenge, verifies a signed answer,
and refuses an answer about another `sub`. `fetchResource` calls any
resource the same way, and `logoutUrl` builds an RP-Initiated Logout URL.

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
import { OpenIdProvider } from "@celld/oidc/provider";
import { durableRecordStore } from "@celld/oauth/durable";
import { signingKeyFromJwk } from "@celld/oauth/server";
export { OAuthRecords } from "@celld/oauth/durable";

const op = new OpenIdProvider({
  issuer: "https://login.example.com",
  keys: [await signingKeyFromJwk(JSON.parse(env.SIGNING_JWK), "ES256")],
  store: durableRecordStore(env.OAUTH_RECORDS),
  clients: [{
    client_id: "web",
    redirect_uris: ["https://app.example.com/callback"],
    post_logout_redirect_uris: ["https://app.example.com/"],
  }],
  interaction: async (context) => {
    const session = await mySession(context.request);
    if (session === null || context.needsLogin(session.authTime)) {
      if (context.prompt.includes("none")) return { deny: { error: "login_required" } };
      return Response.redirect(`/login?i=${context.interactionId}`, 303);
    }
    return { grant: { subject: session.user, authTime: session.authTime, sessionId: session.id, amr: ["pwd"] } };
  },
  claims: ({ subject, claims }) => users.claims(subject, claims),
});

export default {
  fetch: async (request: Request) => await op.handle(request) ?? await myPages(request),
};
```

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
- ID tokens go into token responses of `openid` grants (code, refresh,
  device): `iss`, `sub`, `aud`, `exp`, `iat`, `auth_time`, `nonce` (not on
  refresh), `acr`, `amr`, `at_hash`, `sid`, and the claims the `claims`
  parameter asks for by name. Scope claims (`profile`, `email`, `address`,
  `phone`) go to UserInfo unless `scopeClaimsInIdToken`. The signing key
  is the client's `id_token_signed_response_alg` if the provider has one,
  else the first key.
- UserInfo is a `ResourceServer` over the provider's own token check, so
  it takes Bearer and DPoP tokens (with the provider's nonces and replay
  store), sees revocations, requires `openid`, and answers `sub` plus the
  scopes' claims and any the `claims` request named for UserInfo.
- A grant's `sessionId` becomes `sid` (a hash of it). `end_session`
  (RP-Initiated Logout) takes an `id_token_hint` (expired or not),
  `client_id`, a `post_logout_redirect_uri` that must be registered for
  the client, and `state`; after the host's `endSession` hook it ends the
  session, and from then on its refresh tokens get `invalid_grant` and its
  access tokens no UserInfo. `endLoginSession(sessionId)` does the same
  from the host's own logout.
- With `requestObjects`, a `request` parameter is a signed request object
  (RFC 9101): the client's registered keys, an asymmetric `alg`, `iss`
  the client, `aud` the issuer, at most an hour of life, a `jti` used
  once, and no `sub`.

An `openid` request without a resource gets an access token for UserInfo
(`resources.default` is the UserInfo URL, and UserInfo is always an
allowed resource). `OidcClient` adds UserInfo to a login's resources when
it names others, so one token works at both.

### Federation

```typescript
import { FederationEntity, TrustChainResolver, federatedClients } from "@celld/oidc/federation";

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
resolver. It signs on request with the first federation key, so
configuration changes and key rotation take effect at once.

`TrustChainResolver.resolve` walks `authority_hints` up to a configured
anchor, depth first, never revisiting an entity on the path (loops), at
most `maxPathLength` intermediates deep and `maxFetches` fetches per
resolution. Every candidate chain goes through `validate`, shortest
first: section 10.2's signature rules (`ES[j]` verifies with a key in
`ES[j+1].jwks`, the leaf also with its own, the anchor with its
configured keys, `kid` required), `iat`/`exp` everywhere, the immediate
superior among the leaf's `authority_hints`; then every subordinate
statement's constraints (`max_path_length`, `naming_constraints` with
RFC 5280 host rules, `allowed_entity_types`); then the superior's
`metadata`, then the merged policies. A `crit` claim or a critical policy
operator it does not understand invalidates the chain. The chain expires
at its earliest `exp`. Fetched statements are cached (memory or a
`RecordStore`) until they expire and are verified on every use; if a
resolution fails with cached statements it is tried once more from the
source, which is what happens after an anchor rotates its keys.

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
provider's issuer as audience, as section 12.1.1.2 requires).
`ExplicitRegistration` is the `federation_registration_endpoint`: the RP
posts its entity configuration (`aud` the provider), the provider
resolves a chain with it as the leaf, stores the client until the chain
expires, and answers an `explicit-registration-response+jwt`.

Registration, RP side: `federatedOidcClient` resolves the provider's
chain (its `openid_provider` metadata is used instead of Discovery) and
the RP's own (to see what the policies made of its metadata), then builds
an `OidcClient` with the entity identifier as `client_id`,
`private_key_jwt` with the RP's key, PAR always, and DPoP as the next
section describes.

### The broker

```typescript
import { boundTokenExchange, UpstreamBroker } from "@celld/oidc/broker";

const broker = new UpstreamBroker({ upstream: upstreamClient, sealer, store });
const op = new OpenIdProvider({
  ...,
  interaction: (context) => broker.begin(context.interactionId, { maxAge: context.maxAge }),
  claims: ({ subject, claims }) => broker.claims(subject, claims),
  tokenExchange: boundTokenExchange(),
});
// GET /upstream/callback
return await broker.finish(op, request, { sessionId });
```

`begin` sends the user to the upstream with the pending login sealed in a
cookie; `finish` completes the upstream login (the ID token validated, the
upstream UserInfo read), keeps the upstream tokens under the downstream
subject, and resumes the downstream authorization with the upstream's
`auth_time`, `acr` and `amr`. `fetchUpstream` calls upstream APIs for a
user with the broker's tokens and key, refreshing them when they expire.

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
- Client authentication is separate from DPoP: `private_key_jwt` proves
  the RP's registered keys from the federation metadata; DPoP proves the
  per-instance key the tokens are bound to.

## Security defaults

| Default | Where | Why |
| --- | --- | --- |
| Every login sends a fresh 128-bit `nonce`, and the ID token must carry it | rp | replay of an ID token into another login |
| ID tokens: `iss` exact, `aud` names the client and no untrusted party, `azp` with several audiences | rp | tokens minted for someone else |
| ID token `alg` from an allowlist; HMAC and `none` never | rp | the client secret is not a signing key; no unsigned tokens |
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
| `sid` is a hash of the host's session id | provider | the id is not disclosed |
| Request objects: client keys, asymmetric, `aud` the issuer, one use, no `sub`, an hour at most | provider | forged or replayed requests; no reuse as a client assertion |
| Protocol claims in ID tokens cannot come from the claims hook | provider | a user attribute cannot set `iss` or `nonce` |
| Federation JWTs need their exact `typ` and a `kid`; asymmetric algorithms only | federation | cross-JWT confusion (RFC 8725) |
| Unknown critical claims and critical policy operators invalidate the chain | federation | no silent weakening |
| Loops, paths longer than `maxPathLength`, and more than `maxFetches` fetches end a resolution | federation | resource exhaustion |
| Statements are fetched without following redirects, and must be `application/entity-statement+jwt` | federation | confusion with other content |
| Automatic registration needs `automatic`, `private_key_jwt`, and the RP's resolved keys | federation | the federation vouches for the client's keys, nothing else does |
| A bound subject token is only exchanged with its own key's proof | broker | stolen tokens stay useless |

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
| Federation: fetch (8.1), list (8.2), resolve (8.3) endpoints | | yes | resolve is unauthenticated |
| Federation: trust chain resolution and validation (10) | yes | yes | |
| Federation: metadata policy, all standard operators (6.1) | yes | yes | |
| Federation: constraints (6.2) | yes | yes | |
| Federation: trust marks and delegation (7), validation | yes | yes | issuance too; no status or listing endpoints |
| Federation: automatic registration (12.1) | yes | yes | PAR with `private_key_jwt`, or a request object at the provider |
| Federation: explicit registration (12.2) | | yes | entity configuration bodies; not `trust-chain+json` |

## Not done

- Implicit and hybrid flows, `form_post` and other response modes,
  `id_token` response types: `@celld/oauth` serves `code` with `query`
  only, as OAuth 2.1 does.
- Pairwise subject identifiers, encrypted ID tokens or UserInfo, signed
  UserInfo answers from the provider, `request_uri` by reference,
  front- and back-channel logout, session management iframes, WebFinger,
  dynamic registration of OpenID-specific client metadata beyond what
  `@celld/oauth` validates.
- Federation: the trust mark status and listing endpoints, historical
  keys, `trust_chain` and `peer_trust_chain` header parameters on
  requests, `signed_jwks_uri`, `trust-chain+json` registration bodies,
  mutual TLS, and authenticated federation endpoints (section 8.8).
- RP-side automatic registration with a request object: `OidcClient`
  uses PAR, which the provider must offer.
- Downstream DPoP in the example specs: a spec cannot sign proofs, so the
  broker example's downstream client uses Bearer; `tests/flow_test.ts`
  covers DPoP on both hops.
- Ed25519 keys: celld's WebCrypto cannot verify them, so defaults are
  ES256 (and RS256 for ID tokens from others). A token signed with an
  algorithm the runtime cannot verify is not reported as a bad signature:
  `@celld/jwt`'s `runtime_unsupported` error is rethrown from ID token,
  UserInfo, request object and federation checks, so it surfaces as a
  server error naming the cause.

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev`: `provider` (an OpenID Provider on the Durable
Object store with a login page stub, `prompt`, logout and restarts),
`login` (a relying party web app with `LoginFlow` and a cookie session
against a fake provider), `federation` (a trust anchor with leaf entities,
policies, trust marks and the federation endpoints) and `broker` (a
provider that signs users in at a fake upstream with DPoP on the upstream
hop). Run one with `buck2 run root//src/celld/oidc/examples:<name>-dev`.

## Tests

```sh
buck2 test root//src/celld/oidc/...
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
`chain` (anchor, intermediate and leaf fixtures: expiry, bad signatures,
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
