<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/oidc examples

Standalone Workers using `@celld/sec/oidc`. Each runs in its own test under
`celld dev`; `login` and `broker` run against a fake OpenID Provider
([`login_upstream.ts`](login_upstream.ts),
[`broker_upstream.ts`](broker_upstream.ts)) built with `@celld/sec/oidc/testing`.
See [the convention](../../../examples/README.md).

| Example                       | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`provider`](provider.ts)     | an OpenID Provider on Durable Object records: PAR, a host login page bound to the browser that started the interaction, with a declared form and origin plus token CSRF checks, `prompt`, the `claims` parameter, UserInfo, code reuse revocation, RP-initiated logout ending the session and clearing the provider's cookie (and only asking, ending nothing, when the browser is not signed in as the hint's user), and a POST-only local sign-out; `provider-https` runs it under an https `ISSUER`, where its cookies are `__Host-` |
| [`login`](login.ts)           | a relying party web app: `LoginFlow` with a sealed login cookie, ID token validation, a session cookie, UserInfo, and logout by a CSRF-checked POST that clears the session before going to the provider                                                                                                                                                                                                                                                                                                                                |
| [`federation`](federation.ts) | a trust anchor and its subordinates: entity configurations, fetch/list/resolve endpoints, metadata policy, a trust mark, a chain the policy refuses                                                                                                                                                                                                                                                                                                                                                                                     |
| [`broker`](broker.ts)         | a provider that logs users in upstream with its own DPoP key, then issues its own tokens, with `acr`/`amr` carried over and bound token exchange                                                                                                                                                                                                                                                                                                                                                                                        |

```sh
buck2 test root//src/celld/sec/oidc/examples/...
buck2 run root//src/celld/sec/oidc/examples:provider-dev   # then curl 127.0.0.1:9876
```

The specs cannot sign DPoP proofs, so their own requests use Bearer tokens; the
`broker` spec checks the DPoP proofs the broker sends upstream, and
[`tests/flow_test.ts`](../tests/flow_test.ts) runs DPoP on every hop of a
federated broker. Keys that must outlive a `restart` are private JWKs, written
in the spec's `vars` as JSON objects.

A deployment pins the origin each example names itself by: `ISSUER` for
`provider` and `broker` (the issuer, and the broker's upstream redirect URI),
`APP_ORIGIN` for `login` (its redirect URI) and `FEDERATION_ORIGIN` for
`federation` (its entity identifiers). Without them, as under `celld dev`, an
example takes the request's origin only when its host is a loopback IP literal
and refuses any other host with a 421, so a `Host` header never picks an issuer
or a redirect URI. Development switches (`*_LOOPBACK_FOR_DEVELOPMENT`) and
secrets, including `provider`'s `DEMO_PASSWORD`, are only in the specs' (or the
fakes') `vars`.
