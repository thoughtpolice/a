<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/oauth examples

Standalone Workers using `@celld/sec/oauth`. Each runs in its own test under
`celld dev`; `service` and `dpop` run against fake upstreams built on
`@celld/sec/oauth/testing` ([`service_upstream.ts`](service_upstream.ts),
[`dpop_upstream.ts`](dpop_upstream.ts)). See
[the convention](../../../examples/README.md).

| Example                   | What it shows                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`server`](server.ts)     | a whole authorization server on the `OAuthRecords` Durable Object: PAR, a host login page (bound to the browser that started the interaction by an encrypted cookie, CSRF-checked, with a bounded form), code + PKCE, refresh rotation and reuse detection across a restart, revocation, introspection, JWKS; and a notes API on `@celld/web/router` behind oauth's `ResourceServer` |
| [`service`](service.ts)   | client credentials with `private_key_jwt`, service to service: discovery, a token per resource, reuse, and a fresh token when the API refuses the old one; no redirects for the token, a deadline and a capped answer                                                                                                                                                                |
| [`dpop`](dpop.ts)         | a DPoP client: bound tokens, nonces at both servers, `ath`; a replayed request and a bound token sent as Bearer, both refused; no redirects, a deadline and a capped answer                                                                                                                                                                                                          |
| [`device`](device.ts)     | the device authorization grant: user codes, `authorization_pending`, `slow_down`, a CSRF-checked verification page where approving needs the user's password, approval and denial                                                                                                                                                                                                    |
| [`exchange`](exchange.ts) | token exchange (RFC 8693) with the policy in the host's hook: audiences, narrower scopes, `act`, and every refusal                                                                                                                                                                                                                                                                   |

`server` puts oauth's `ResourceServer` behind `@celld/web/router` with
`oauthSchemes` from `@celld/sec/oauth/router`, whose challenges carry the RFC 9728
`resource_metadata`.

```sh
buck2 test root//src/celld/sec/oauth/examples/...
buck2 run root//src/celld/sec/oauth/examples:server-dev   # then curl 127.0.0.1:9876
```

`service` and `dpop` serve their one route without authentication, to stay about
the client side: anyone who can reach them reads the API through the Worker's
own credentials (a confused deputy). A real service authenticates its callers.

The three authorization servers (`server`, `device`, `exchange`) take their
issuer from `ISSUER`, which a deployment must set to its public origin. Without
it they serve only a loopback address (`127.0.0.1`, `[::1]`) and use the
request's origin, for development; any other `Host` gets 421, so a request
cannot choose the issuer.

The signing keys in the specs' `vars` are ES256 private JWKs, written as JSON
objects, which the harness passes through as JSON text; the Workers `JSON.parse`
them. A deployment keeps them, the client secrets, the cookie secret
(`COOKIE_SECRET`) and the demo password as secrets. `service`'s client key comes
from its upstream as base64url JSON.
