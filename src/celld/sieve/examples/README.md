<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sieve examples

Standalone Workers using `@celld/sieve`. Each runs in its own test under
`celld dev`; see [the convention](../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`signup`](signup.ts) | a validated JSON API: rewrites, defaults, flattened 400s, an async refinement against KV, a branded id |
| [`webhooks`](webhooks.ts) | dispatch on a `discriminatedUnion`, one route for an event or a batch (`v.union([Event, v.array(Event)])`), issue paths, `.catch()`, text issues |
| [`search`](search.ts) | query strings: coercion, lists, booleans done right, a cross-field `.check` |
| [`schema`](schema.ts) | a build-time `sieve_json_schema` file served as an asset, next to `toJSONSchema` at request time |
| [`tokens`](tokens.ts) | with `@celld/jwt`: `v.jwt()` before `verify`, and claims parsed after it |

```sh
buck2 test root//src/celld/sieve/examples/...
buck2 run root//src/celld/sieve/examples:signup-dev   # then curl 127.0.0.1:9876
```

`api.ts` is `@sieve-example/api` (`:api`), the `schema` example's
schemas; `:api-schema` is their JSON Schema, written at build time.
