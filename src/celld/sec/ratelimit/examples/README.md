<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/ratelimit examples

Standalone Workers using `@celld/sec/ratelimit` with the real `RateLimitShard`
Durable Object; see [the convention](../../../examples/README.md). Every
spec checks the refusals as well as the admissions, and the
`RateLimit` fields each answer carries.

| Example | What it shows |
| --- | --- |
| [`login`](login.ts) | a sign-in route guarded two ways: a per-address limit that runs before the password derivation (a flood never reaches it), and a per-account limit on failures, charged up front and refunded on success, keyed by the lower-cased name whether or not the user exists; the lock holds across addresses and survives a restart; limiter keys stored under an HMAC secret |
| [`api`](api.ts) | API quotas: every request (401s and 404s included) charged to its address, each key charged after authentication to two policies at once (a minute and a day), routes with different costs, a refusal by one policy spending nothing from the other, and an oversized body refused before the key is charged |

The credentials and secrets the examples use (`USERS`, `API_KEYS`,
`SESSION_SECRET`, `RATE_LIMIT_SECRET`) live only in each spec's `vars`,
which the harness writes to `.dev.vars` for `celld dev`. They are public:
never deploy them. A deployment sets its own with `celld secret put`.
