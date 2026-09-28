<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/ratelimit

Rate limits for celld. A limiter holds a few policies of `limit` units per
`window` with a `burst`. It decides each request with the generic cell rate
algorithm (GCRA), in memory or in Durable Objects that a whole fleet shares.
Router middleware answers 429 with `Retry-After` and the IETF `RateLimit`
fields.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    deps = [
        "root//src/celld/sec/ratelimit:ratelimit",
        "root//src/celld/web/router:router",
    ],
)
```

| Import | What it has |
| --- | --- |
| `@celld/sec/ratelimit` | policies, `memoryLimiter`, `LocalLimiter`, `durableLimiter`, `UpstreamLimit`, `ipKey`, the GCRA arithmetic |
| `@celld/sec/ratelimit/durable` | `RateLimitShard`, the Durable Object (the only module importing `cloudflare:workers`) |
| `@celld/sec/ratelimit/router` | `rateLimit` middleware, `byIp`, `byPrincipal` |
| `@celld/sec/ratelimit/testing` | `memoryNamespace` (the shard binding over maps), `ManualClock` |

It depends on `@celld/core` (addresses), `@celld/http` (the clock
`UpstreamLimit` waits on) and `@celld/web/router` (the middleware).

## A quick tour

```typescript
import { durableLimiter, type RateLimitShardApi } from "@celld/sec/ratelimit";
import { byIp, byPrincipal, rateLimit } from "@celld/sec/ratelimit/router";
import { apiKey, hashedKeys, router } from "@celld/web/router";
export { RateLimitShard } from "@celld/sec/ratelimit/durable";

interface Env {
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitShardApi>;
  readonly API_KEYS: string;
}

function build(env: Env) {
  // Every address: 120 requests a minute, 20 at once.
  const perAddress = durableLimiter(env.RATE_LIMITS, {
    name: "address",
    policies: [{ name: "address", limit: 120, window: "PT1M", burst: 20 }],
  });
  // Every caller: 10 a second and 1,000 an hour, both at once.
  const perCaller = durableLimiter(env.RATE_LIMITS, {
    name: "caller",
    policies: [
      { name: "second", limit: 10, window: 1 },
      { name: "hour", limit: 1000, window: "PT1H" },
    ],
  });
  const app = router<Env>({
    auth: apiKey({ lookup: hashedKeys(JSON.parse(env.API_KEYS)) }),
  }).use(rateLimit({ limiter: perAddress, key: byIp() }));
  app.get(
    "/reports",
    { use: [rateLimit({ limiter: perCaller, key: byPrincipal(), cost: 5 })] },
    (c) => c.json({ for: c.principal.subject }),
  );
  return app;
}
```

Bind the object in the project:

```python
celld.project(..., bindings = {"RATE_LIMITS": "RateLimitShard"})
```

A request that fits gets both limiters' policies:

```http
RateLimit-Policy: "address";q=120;w=60, "second";q=10;w=1, "hour";q=1000;w=3600
RateLimit: "address";r=19;t=1, "second";r=5;t=1, "hour";r=995;t=18
```

A request that does not is refused:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 1

{"error":"rate_limited","message":"too many requests","requestId":"..."}
```

## Policies

```typescript
{ name: "login", limit: 5, window: "PT15M", burst: 3 }
```

- **`limit` per `window`** is the long-run rate. The window is seconds, or an
  ISO 8601 duration without years or months, from 1 ms to 400 days.
- **`burst`** (default `limit`) is how much a key may spend at once after
  it has been idle. `{ limit: 60, window: "PT1M", burst: 1 }` spaces
  requests a second apart; `burst: 60` lets a quiet key send 60 at once.
- **`name`** is 1 to 64 of `a-z 0-9 _ -`. It names the policy in the
  headers and in storage.

A limiter has one to eight policies. **Every policy must admit a request,
and then each one charges it.** A refused request spends nothing, so a key
that one policy refuses keeps its budget in the others.

### The algorithm

Each key has, per policy, a theoretical arrival time (TAT): the moment the
key would be idle again if it spent nothing more. One unit takes
`T = window / limit`. A request of `cost` units moves the TAT to
`max(TAT, now) + cost × T`, and is admitted when that lands at most
`burst × T` after now. That gives three guarantees:

- A key never spends more than `burst` units at once.
- A key never spends more than `burst + limit × t / window` over any span
  `t`. A property test checks this over random traffic.
- `retryAfterMs` is exact: the same request 1 ms sooner is refused, and on
  time it is admitted.

An idle key has no state. The TAT is kept as the time of the last decision
plus an offset, not as one epoch timestamp, because an epoch millisecond
count carries only about a quarter of a microsecond of precision. At the
fastest allowed rate, a million units a second, a single timestamp would
drift 2% with every unit.

## Limiters

- **`memoryLimiter({ policies })`** keeps state in this isolate. It is for
  tests and single-process programs; a fleet spreads requests over many
  isolates.
- **`new LocalLimiter({ policies })`** is the same limiter, but synchronous.
  It fits inside one Durable Object, for example to cap each WebSocket
  connection's message rate. Keys are kept in recency order up to
  `maxKeys` (default 10,000); past that the least recently used key is
  forgotten, which gives it its full burst back.
- **`durableLimiter(env.RATE_LIMITS, { name, policies })`** is shared by the
  whole fleet. It is described below.

All of them implement `RateLimiter`:

| Call | What it does |
| --- | --- |
| `limit(key, { cost?, maxDelayMs? })` | Admits and charges, or refuses and charges nothing. |
| `peek(key, { cost? })` | Says whether the request would be admitted, spending nothing. |
| `refund(key, { cost? })` | Gives back units an admitted request spent. |
| `charge(key, { cost? })` | Spends units whether or not the key has them, past its burst if need be. |
| `hold(key, { forMs })` | Refuses every request of the key for a while, whatever the policies say. |
| `reset(key)` | Forgets everything the key spent, and any hold. |

A `Decision` has `allowed`, `retryAfterMs` (when refused), `delayMs` (see
pacing), `remaining` (the fewest units left across the policies), and each
policy's `remaining` and `resetMs`. While the key is held, every
`remaining` is 0 and no `resetMs` ends before the hold does.

A `cost` is a number of units from every policy (default 1), or units by
policy name, such as `{ requests: 1, tokens: 800 }`, where a policy left out
spends nothing. A policy that a request spends nothing from still refuses
it while the key is in debt there (see charging, below).

A key is any non-empty string of up to 4096 UTF-8 bytes. `ipKey(address)`
turns a client address into one: one key per IPv4 address and one per IPv6
/64, because a client usually controls a whole /64. An IPv4-mapped IPv6
address counts as its IPv4 address. A missing address (`null`) maps to the
single key `ip:unknown`, so hiding the address does not escape the limit.

### Counting only failures

A login throttle should count wrong passwords, not logins. Charge the
attempt before checking it and refund it when it succeeds. Parallel guesses
are then capped by the limit, which checking first and charging only on
failure would not do:

```typescript
const failures = durableLimiter(env.RATE_LIMITS, {
  name: "login-failures",
  policies: [{ name: "failures", limit: 5, window: "PT15M" }],
});

const decision = await failures.limit(`user:${username}`);
if (!decision.allowed) return tooMany(decision.retryAfterMs);
if (await passwordMatches(username, password)) {
  await failures.refund(`user:${username}`);
  return signIn(username);
}
return wrongPassword();
```

### Pacing

`maxDelayMs` changes the limiter from refusing work to pacing it. A request
that would have to wait up to that long is admitted with its slot reserved,
and `delayMs` tells the caller how long to wait first. This suits calls to an
upstream with its own limit:

```typescript
const decision = await upstream.limit("openai", { maxDelayMs: 10_000 });
if (!decision.allowed) throw new Error("the upstream is saturated");
await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
```

### Calling an upstream

A client of an API with its own limits wants three more things, which
`@celld/api/jev` and `@celld/api/exedev` use:

- **Costs by policy.** An API that limits requests and tokens gets one
  policy for each, and a call costs one request and its tokens.
- **Charging afterwards.** How many tokens a call used is known only from
  its answer. `charge` spends them then, even past the burst. The key is
  then in debt, and is refused until the debt is paid off at the policy's
  rate. Debt stops 400 days past the burst.
- **Holding.** When the upstream answers 429 with `Retry-After`, `hold`
  refuses every request of the key for that long, so every caller sharing
  the limiter waits, not only the one that was refused. The hold leaves the
  policies' budgets alone. A request that may wait (`maxDelayMs`) is
  admitted to start when the hold ends, spaced from the others by the
  policies. A hold never shortens one already in place, and `reset` lifts
  it.

```typescript
const upstream = durableLimiter(env.RATE_LIMITS, {
  name: "llm",
  policies: [
    { name: "requests", limit: 600, window: "PT1M", burst: 10 },
    { name: "tokens", limit: 20_000, window: 1 },
  ],
});

const decision = await upstream.limit("account", { cost: { requests: 1 } });
if (!decision.allowed) return tooMany(decision.retryAfterMs);
const response = await callTheModel();
if (response.status === 429) {
  await upstream.hold("account", { forMs: retryAfterMs(response) });
} else {
  await upstream.charge("account", { cost: { tokens: response.usage.tokens } });
}
```

The request spends no tokens up front, so it is admitted unless the token
policy is in debt from earlier answers.

A client with a retry budget wraps this in an `UpstreamLimit`, which
`@celld/api/jev` and `@celld/api/exedev` share:

```typescript
const limit = new UpstreamLimit(upstream, {
  key: "account",
  cost: { requests: 1 },
  onError: (error) => console.warn("limiter", error),
});

switch (await limit.admit({ deadline, runtime, signal })) {
  case "refused": // the limiter would not admit it before the deadline
    throw new Error("rate limited");
  case "admitted": // the cost is spent; limit.giveBack() if nothing is sent
  case "unavailable": // the limiter failed, and onError heard why: go ahead
}
```

- **`admit`** sleeps out the limiter's refusals on `runtime`'s clock, and
  answers `refused` as soon as a wait would reach the deadline: the limiter
  said when it would admit the call, so asking again sooner cannot help. A
  `signal` stops the wait, and an admission that arrives afterwards is
  given back.
- **`giveBack`**, **`charge`**, **`refund`** and **`hold`** settle the call
  and pass on a `Retry-After`.
- **The limiter's failures never stop a call.** The upstream's 429 stays
  the authority, so a failure goes to `onError`, `admit` answers
  `unavailable`, and the other methods resolve all the same.

`resolveLimits(limits, defaults)` checks limits stated in the upstream's
own terms, such as requests a minute, before a client turns them into
policies: only the defaults' names, each a whole number from 1.

## The Durable Object limiter

`durableLimiter` spreads keys over `shards` objects (default 16), picked by
each key's hash. Each decision is one RPC to one shard. A shard's methods
are synchronous, so no two callers can spend the same unit. Each admitted
request writes its state to the shard's SQLite inside `transactionSync`, so
an evicted or restarted object forgets nothing.

- **Storage never holds the key as written.** A shard stores SHA-256 of
  the limiter name and the key, or HMAC-SHA-256 under `secret` (at least 32
  bytes). The unkeyed hash of an IPv4 address can be found by trying all
  2^32 of them; a secret stops that.
- **Refusals are cached in the isolate** until the key could spend a unit
  of every policy again. A refused client that keeps retrying costs no RPCs
  until then. Only requests that spend from every policy use the cache,
  since one that spends nothing from a policy may be admitted sooner, and a
  request that may wait (`maxDelayMs`) uses it only while it would have to
  wait longer than it may. A
  `reset` or `refund` made in another isolate reaches this cache only when
  the cached refusal expires. Set `denyCache: false` to turn it off.
- **There is no storage barrier.** A shard does not wait for
  `storage.sync()`. If a node is lost before its writes reach the fleet's
  storage, it forgets its last few decisions and admits at most those
  requests again. Waiting would put a storage round trip on every request.
- **Failures** reject with `RateLimitUnavailable`. The middleware answers
  503 by default (see below).
- **A hold** is stored beside the key's policies, as one more row that is
  swept once it ends.
- **Changing** `name`, `shards` or `secret` moves every key to new storage,
  which starts all of them afresh. Changing a policy's numbers keeps each
  key's state, and the state is read with the new numbers. Idle rows are
  swept a few at a time on each write, so storage grows only with the keys
  that are busy.

Export the class from the Worker and bind it:

```typescript
export { RateLimitShard } from "@celld/sec/ratelimit/durable";
```

## The middleware

```typescript
rateLimit({ limiter, key, cost?, headers?, unavailable?, onUnavailable? })
```

Where it runs decides what it can key on:

| Placement | Runs | Use it for |
| --- | --- | --- |
| `app.use(rateLimit(...))` | before authentication, for every route and 404 | a per-address limit on everything |
| route `before: [rateLimit(...)]` | once matched, before the body limit and authentication | a login route's per-address limit, so a flood never reaches the password check |
| route `use: [rateLimit(...)]` | after authentication | a per-caller quota (`byPrincipal()`) |

- **`key`** returns the key, or `null` to let the request through
  uncharged. `byIp(options)` keys on `c.ip()`, which is only as trustworthy
  as the router's `clientIp` peer source: the default `CF-Connecting-IP` can
  be believed only on Cloudflare's edge (see the router README).
  `byPrincipal()` keys on `principal.key`, never on `subject`, which two
  issuers can share. It is `null` for an anonymous request.
- **`limiter`** is a limiter, or a function of the context that returns one,
  for a limiter built from `c.env`.
- **`cost`** is a number, or a function of the context. A cost above a
  policy's burst could never be admitted, so it is the application's error:
  it throws a `RangeError`, which the router answers with a 500.
- **`headers`** (default true) sends `RateLimit-Policy` and `RateLimit`
  ([draft-ietf-httpapi-ratelimit-headers-11](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)).
  Each limit on a route adds its policies to the same two fields. Give the
  policies on one route distinct names, since a later policy replaces an
  earlier one with the same name. `q` is the policy's `limit` and `w` its
  window in seconds. `r` is the units left and `t` the seconds until the
  key is back to its full burst. The partition key (`pk`) is left out,
  since it would tell the client how its requests are grouped.
- **`unavailable`**: when the limiter cannot answer, `"refuse"` (default)
  answers 503 with `Retry-After: 1`, and `"allow"` lets the request through
  unlimited. Refusing keeps a limit that guards credentials from failing
  open. `onUnavailable(error, c)` is the place to log the error.

A 429 says `rate_limited` and carries `Retry-After` in whole seconds
(rounded up, at least 1), along with the router's usual security headers and
request id.

## Testing an application

`memoryNamespace()` from `@celld/sec/ratelimit/testing` stands in for the
binding. It runs the real shard logic over maps, copies requests and answers
through `structuredClone` as RPC does, records every call in `calls`, and
fails every call while `failWith` is set. Pair it with a `ManualClock` to
move time:

```typescript
const clock = new ManualClock();
const namespace = memoryNamespace({ now: clock.now });
const limiter = durableLimiter(namespace, {
  name: "login",
  policies: [{ name: "failures", limit: 3, window: "PT15M" }],
  now: clock.now,
});
```

## Limits

A limiter has at most 8 policies. `limit` and `burst` are 1 to 10⁹, and one
unit takes at least a microsecond (so at most a million units a second).
A window is 1 ms to 400 days. A key is at most 4096 UTF-8 bytes. `shards`
is 1 to 1024. `maxDelayMs` is at most 2³¹ − 1 ms, a timer's range. A
request's cost is at most each policy's burst, and a charge's at most 10⁹
units a policy. A hold is at most 400 days.

## Examples

[`examples/`](examples) holds Workers that run under `celld dev` with the
real `RateLimitShard`:

- [`login`](examples/login.ts): a sign-in route with a per-address limit
  before the password check and a per-account failure limit that refunds
  on success. Its spec shows that the limits survive a restart.
- [`api`](examples/api.ts): per-key quotas with two policies, costs by
  route, and the `RateLimit` fields.

## Tests

```sh
buck/bin/buck2 test root//src/celld/sec/ratelimit/...
```

One suite per concern. `gcra` checks the arithmetic, including property
tests of the rate bound and of `retryAfterMs`, and exactness at a million
units a second. `policy` and `keys` check validation and keys. `limiter`
covers the in-memory limiters, `shard` the Durable Object's logic over a
map, `client` the `durableLimiter` wiring and its refusal cache, `upstream`
`UpstreamLimit`, `router` the middleware, and `readme` the examples on this
page. The examples'
specs run the real Durable Object under `celld dev`.
