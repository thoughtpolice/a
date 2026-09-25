<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/oidc examples

Standalone Workers using `@celld/oidc`. Each runs in its own test under
`celld dev`; `login` and `broker` run against a fake OpenID Provider
([`login_upstream.ts`](login_upstream.ts),
[`broker_upstream.ts`](broker_upstream.ts)) built with
`@celld/oidc/testing`. See [the convention](../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`provider`](provider.ts) | an OpenID Provider on Durable Object records: PAR, a host login page, `prompt`, the `claims` parameter, UserInfo, code reuse revocation, RP-initiated logout ending the session |
| [`login`](login.ts) | a relying party web app: `LoginFlow` with a sealed login cookie, ID token validation, a session cookie, UserInfo, logout at the provider |
| [`federation`](federation.ts) | a trust anchor and its subordinates: entity configurations, fetch/list/resolve endpoints, metadata policy, a trust mark, a chain the policy refuses |
| [`broker`](broker.ts) | a provider that logs users in upstream with its own DPoP key, then issues its own tokens, with `acr`/`amr` carried over and bound token exchange |

```sh
buck2 test root//src/celld/oidc/examples/...
buck2 run root//src/celld/oidc/examples:provider-dev   # then curl 127.0.0.1:9876
```

The specs cannot sign DPoP proofs, so their own requests use Bearer
tokens; the `broker` spec checks the DPoP proofs the broker sends
upstream, and [`tests/flow_test.ts`](../tests/flow_test.ts) runs DPoP on
every hop of a federated broker. Keys that must outlive a `restart` are
private JWKs, written in the spec's `vars` as JSON objects.
