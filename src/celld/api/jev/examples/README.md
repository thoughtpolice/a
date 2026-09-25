<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/api/jev examples

Standalone Workers using `@celld/api/jev`. Each is a
[`@celld/router`](../../../router) app whose bodies are checked by sieve
schemas before a handler runs (a 400 with the issues, or a 415 for a body
that is not JSON), and each runs against a fake TypeSafe
server ([`upstream.ts`](upstream.ts), around [`fake.ts`](fake.ts)) in its own
test; see [the convention](../../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`triage`](triage.ts) | Choice, Noul and Score in one request; typed answers; errors as data |
| [`limited`](limited.ts) | the `JevRateLimiter` Durable Object, the KV answer cache, 429 throttling |
| [`moderation`](moderation.ts) | `askStep` inside a Workflow; a second question only when needed |
| [`routing`](routing.ts) | confidence gating with `gateChoice`, `noulBand` and `topK` |
| [`scoring`](scoring.ts) | a pinned model and a `composite` score |

```sh
buck2 test root//src/celld/api/jev/examples/...
buck2 run root//src/celld/api/jev/examples:triage-dev   # then curl 127.0.0.1:9876
buck2 run root//src/celld/api/jev/examples:triage-dev -- --live --var TYPESAFE_API_KEY=...
```

`@celld/api/jev/examples/fake` (`:fake`) is the scriptable fake itself, for
other libraries' examples that also talk to TypeSafe.
