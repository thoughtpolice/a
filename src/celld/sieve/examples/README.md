<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sieve examples

Standalone Workers using `@celld/sieve`. Each runs in its own test under
`celld dev`; see [the convention](../../examples/README.md). Every body
is read under a byte cap with `@celld/core/bounds` (413 over it) before sieve
sees it: sieve checks values in memory and caps nothing itself.

| Example | What it shows |
| --- | --- |
| [`signup`](signup.ts) | a validated JSON API: rewrites, defaults, flattened 400s, an async refinement against a Durable Object, a branded id; the name is claimed with one `INSERT OR IGNORE`, since a KV `get` then `put` is not atomic |
| [`webhooks`](webhooks.ts) | dispatch on a `discriminatedUnion`, one route for an event or a batch (`v.union([Event, v.array(Event)])`), issue paths, `.catch()`, text issues; the sender is not authenticated (see the router's `webhook` example for that) |
| [`search`](search.ts) | query strings: coercion, lists, booleans done right, a cross-field `.check`; the query object has no prototype, so `__proto__` is just an unknown key |
| [`schema`](schema.ts) | a build-time `sieve_json_schema` file served as an asset, next to `toJSONSchema` at request time |
| [`tokens`](tokens.ts) | with `@celld/sec/jwt`: `v.jwt()` before `verify`, and claims parsed after it; minting needs an admin bearer token (`ADMIN_TOKEN`, a secret) |

```sh
buck2 test root//src/celld/sieve/examples/...
buck2 run root//src/celld/sieve/examples:signup-dev   # then curl 127.0.0.1:9876
```

`api.ts` is `@sieve-example/api` (`:api`), the `schema` example's
schemas; `:api-schema` is their JSON Schema, written at build time.
