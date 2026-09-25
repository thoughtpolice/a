<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/router examples

Standalone Workers using `@celld/router`; see [the convention](../../examples/README.md).
Every spec checks the refusals as well as the happy path: the status, the
error body and the exact `WWW-Authenticate`, CORS and cookie headers.

| Example | What it shows |
| --- | --- |
| [`crud`](crud.ts) | a JSON CRUD API on KV: sieve validation (400 by field, 413, 415), per-route scopes over a hashed-token `bearer` verifier, 404/405/`HEAD`/`OPTIONS`, response schemas dropping stored fields, `/openapi.json` |
| [`reports`](reports.ts) | `jwtBearer` with the issuer's JWKS (`RemoteJwks`, fetched once): scopes and a role, and every way a token is refused (audience, expiry, another key, HS256, `none`, query string) |
| [`session`](session.ts) | an HTML app on an encrypted `__Host-session` cookie: login CSRF, cross-site and same-site POSTs blocked, double-submit tokens, a tampered cookie cleared, logout |
| [`spa`](spa.ts) | CORS for a single-page app: preflights before auth, other origins refused and never reflected, readable 401s, `Vary: Origin` |
| [`webhook`](webhook.ts) | an API-key webhook receiver: hashed keys, a sender CIDR allow list through `c.ip()` (spoofed `X-Forwarded-For` ignored, trusted proxies believed), idempotent deliveries |

[`issuer.ts`](issuer.ts) is the fake authorization server `reports` gets
its key set from; its tokens in `reports.json` were minted once with its
key and expire in 2100. The `session` spec replays a `Set-Cookie` line as
its `Cookie` header, so the attributes ride along as extra cookies the app
ignores.

```sh
buck2 test root//src/celld/router/examples/...
buck2 run root//src/celld/router/examples:session-dev   # then open 127.0.0.1:9876/login
```
