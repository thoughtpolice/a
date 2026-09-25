<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/jwt examples

Standalone Workers using `@celld/sec/jwt`. Each runs in its own test under
`celld dev`; `gateway` runs against a fake authorization server
([`upstream.ts`](upstream.ts)). See [the convention](../../../examples/README.md).

| Example                 | What it shows                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`session`](session.ts) | HS256 session cookies: login, a prepared `createVerifier` with a `claims` refinement, revocation on logout                                                                                                                                                                                                                |
| [`issuer`](issuer.ts)   | an EdDSA issuer: keys in a Durable Object, thumbprint `kid`s, admin-only rotation that publishes a new key for the JWKS max-age before it signs and keeps old keys for the token lifetime, JWKS, introspection; minting needs a client token (`CLIENT_TOKEN`, a secret); `/introspect` is deliberately open (see its doc) |
| [`gateway`](gateway.ts) | verifying access tokens with `createVerifier` over `RemoteJwks`: caching, rotation, the refetch cooldown, scopes, 503 when the keys are unavailable                                                                                                                                                                       |
| [`webhook`](webhook.ts) | partner-signed webhooks: a prepared verifier per partner by `kid`, a body hash claim, replay protection, source blocks (by `CF-Connecting-IP`, which only Cloudflare's edge makes trustworthy)                                                                                                                            |

```sh
buck2 test root//src/celld/sec/jwt/examples/...
buck2 run root//src/celld/sec/jwt/examples:issuer-dev   # then curl 127.0.0.1:9876
```

Every example reads request bodies under a cap (413 beyond it); secrets and
development switches are in the specs' `vars`, never in `BUILD`.

The issuer signs with EdDSA; the gateway's upstream signs with ES256, and the
other examples with HS256. celld imports HMAC keys only as raw bytes, not
JWKs.
