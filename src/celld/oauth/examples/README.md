<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/oauth examples

Standalone Workers using `@celld/oauth`. Each runs in its own test under
`celld dev`; `service` and `dpop` run against fake upstreams built on
`@celld/oauth/testing` ([`service_upstream.ts`](service_upstream.ts),
[`dpop_upstream.ts`](dpop_upstream.ts)). See
[the convention](../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`server`](server.ts) | a whole authorization server on the `OAuthRecords` Durable Object: PAR, a host login page, code + PKCE, refresh rotation and reuse detection across a restart, revocation, introspection, JWKS; and a notes API on `@celld/router` behind oauth's `ResourceServer` |
| [`service`](service.ts) | client credentials with `private_key_jwt`, service to service: discovery, a token per resource, reuse, and a fresh token when the API refuses the old one |
| [`dpop`](dpop.ts) | a DPoP client: bound tokens, nonces at both servers, `ath`; a replayed request and a bound token sent as Bearer, both refused |
| [`device`](device.ts) | the device authorization grant: user codes, `authorization_pending`, `slow_down`, a verification page, approval and denial |
| [`exchange`](exchange.ts) | token exchange (RFC 8693) with the policy in the host's hook: audiences, narrower scopes, `act`, and every refusal |

`server` puts oauth's `ResourceServer` behind `@celld/router` with
`oauthSchemes` from `@celld/oauth/router`, whose challenges carry the RFC
9728 `resource_metadata`.

```sh
buck2 test root//src/celld/oauth/examples/...
buck2 run root//src/celld/oauth/examples:server-dev   # then curl 127.0.0.1:9876
```

The signing keys in the specs' `vars` are ES256 private JWKs, written as
JSON objects, which the harness passes through as JSON text; the Workers
`JSON.parse` them. A deployment keeps them, and the client secrets, as
secrets. `service`'s client key comes from its upstream as base64url JSON.
