<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/web/router examples

Standalone Workers using `@celld/web/router`; see [the convention](../../../examples/README.md).
Every spec checks the refusals as well as the happy path: the status, the
error body and the exact `WWW-Authenticate`, CORS and cookie headers.

Storage identities use `opaqueIdentity` over the complete `principal.key`, with
an application-specific HMAC domain. Configure a stable, private
`IDENTITY_SECRET` of at least 32 bytes for CRUD, reports, SPA and webhook examples;
the session example uses its existing session secret with a separate domain.
The specs' public development secrets must never be deployed. Migrating existing
data from the former unkeyed SHA-256 names requires an explicit one-time storage
migration; changing the identity secret also changes every derived name.

| Example | What it shows |
| --- | --- |
| [`crud`](crud.ts) | a JSON CRUD API on KV: sieve validation (400 by field, 413, 415), per-route scopes over a hashed-token `bearer` verifier, bookmarks owned by the hash of `principal.key`, a paged list (KV `limit` and `cursor`), 404/405/`HEAD`/`OPTIONS`, response schemas dropping stored fields, `/openapi.json` generated once with its 201 and 204 answers |
| [`reports`](reports.ts) | `jwtBearer` with the issuer's JWKS (`RemoteJwks`, fetched once): scopes and a role, and every way a token is refused (audience, expiry, another key, HS256, `none`, query string) |
| [`session`](session.ts) | an HTML app on an encrypted `__Host-session` cookie: salted PBKDF2 password hashes (a fast unsalted one is refused), login CSRF, cross-site and same-site POSTs blocked, double-submit tokens, a tampered cookie cleared, logout (and that a cookie copied before logout still works until it expires) |
| [`spa`](spa.ts) | CORS for a single-page app: preflights before auth, other origins refused and never reflected, readable 401s, `Vary: Origin` |
| [`webhook`](webhook.ts) | an API-key webhook receiver: hashed keys, a sender CIDR allow list through `clientIpForAuthorization(c)` (spoofed `X-Forwarded-For` ignored, trusted proxies believed), deliveries claimed once through a Durable Object's atomic insert (`webhook_race-test` sends concurrent copies), each record deleted by the object's alarm after seven days |

The credentials the examples accept (the `API_TOKENS`, `USERS` and
`WEBHOOK_KEYS` tables and `SESSION_SECRET`) live only in each spec's
`vars`, which the harness writes to `.dev.vars` for `celld dev`; the
tokens and passwords are in the specs and the doc comments. They are public:
never deploy them. A deployment sets its own with `celld secret put`, and
until it does, each Worker refuses every credential (`session` answers an
opaque 500 without `SESSION_SECRET`).

[`issuer.ts`](issuer.ts) is the fake authorization server `reports` gets
its key set from; its tokens in `reports.json` were minted once with its
key and expire in 2100. The `session` spec replays a `Set-Cookie` line as
its `Cookie` header, so the attributes ride along as extra cookies the app
ignores.

```sh
buck2 test root//src/celld/web/router/examples/...
buck2 run root//src/celld/web/router/examples:session-dev   # then open 127.0.0.1:9876/login
```
