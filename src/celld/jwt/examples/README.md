<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/jwt examples

Standalone Workers using `@celld/jwt`. Each runs in its own test under
`celld dev`; `gateway` runs against a fake authorization server
([`upstream.ts`](upstream.ts)). See [the convention](../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`session`](session.ts) | HS256 session cookies: login, `verify` options, revocation on logout |
| [`issuer`](issuer.ts) | an ES256 issuer: keys in a Durable Object, thumbprint `kid`s, rotation, JWKS, introspection |
| [`gateway`](gateway.ts) | verifying access tokens with `RemoteJwks`: caching, rotation, the refetch cooldown, scopes |
| [`webhook`](webhook.ts) | partner-signed webhooks: a `KeySet` by `kid`, a body hash claim, replay protection, source blocks |

```sh
buck2 test root//src/celld/jwt/examples/...
buck2 run root//src/celld/jwt/examples:issuer-dev   # then curl 127.0.0.1:9876
```

The examples sign with ES256 and HS256: celld 0.5.1 signs Ed25519 but its
WebCrypto cannot verify it, and imports HMAC keys only as raw bytes, not
JWKs.
