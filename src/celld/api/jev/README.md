<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/api/jev

A typed client for TypeSafe's System One API and its model, Jev, written for
celld Workers, Durable Objects and Workflows. It has no npm dependency; it
builds on two first-party libraries, [`@celld/sieve`](../../sieve) for the
request and response schemas and [`@celld/http`](../../http) for the retry
policy, the injectable runtime and `fetch`, and the test clock. The TypeSafe
docs at <https://docs.typesafe.ai> are the spec it follows, and the official
SDKs' `RetryPolicy` and constants pages supplied the defaults.

```python
celld.worker(
    name = "worker",
    main = "src/index.ts",
    deps = ["root//src/celld/api/jev:jev"],
)
```

| Import                | What it has                                                                       | Runtime imports      |
| --------------------- | --------------------------------------------------------------------------------- | -------------------- |
| `@celld/api/jev`          | builders, types, schemas, decoding, errors, retry policy, `JevClient`, helpers    | none                 |
| `@celld/api/jev/schemas`  | the API's sieve schemas, `requestIssues`, `responseSchema`                        | none                 |
| `@celld/api/jev/cache`    | `kvCache`, `memoryCache`, `cacheKey`                                              | none                 |
| `@celld/api/jev/limiter`  | `memoryLimiter`, `durableLimiter`, `TokenBucket`, `RateLimiterApi`                | none                 |
| `@celld/api/jev/durable`  | the `JevRateLimiter` Durable Object                                               | `cloudflare:workers` |
| `@celld/api/jev/workflow` | `askStep`                                                                         | none                 |
| `@celld/api/jev/testing`  | `fakeFetch`, `fakeBody`, `jsonResponse`, `virtualRuntime` (from `@celld/http`)    | none                 |

Only `./durable` imports `cloudflare:workers`, so everything else loads in a
plain `celld.test`. A test that imports `./durable` needs `fake_runtime = True`.
`@celld/api/jev` re-exports what callers need from its dependencies (the `Issue`
and `JsonValue` types, `Runtime`, `FetchLike`, `defaultRuntime`), so a Worker
that only asks questions depends on `root//src/celld/api/jev:jev` alone.

## Asking

```typescript
import { choice, JevClient, noul, score } from "@celld/api/jev";

const client = JevClient.fromEnv(env); // reads TYPESAFE_API_KEY
const { answers, model, usage, meta } = await client.ask({
  state: { ticket: { subject: "Payouts failing", body: text } },
  questions: {
    team: choice("Which team should handle this?", {
      billing: "Payments, invoicing, refunds",
      technical: "Bugs, outages, integrations",
      sales: null,
    }),
    urgent: noul("Does this convey urgency?", { true: "Time-sensitive" }),
    mood: score("How frustrated is the customer?", [
      "Calm",
      "Frustrated",
      "Very angry",
    ]),
  },
});

answers.team.choice; // "billing" | "technical" | "sales"
answers.team.probabilities.sales; // number
answers.mood.legend["2"]; // "Very angry"
answers.urgent.noul; // number
model; // "jev-1.13.0", the version that answered
meta; // { requestedModel, attempts, latencyMs, requestId, cache }
```

The answer types come from the questions. `choice` keeps its option names as a
union, `score` keeps its levels as a tuple, and `AnswersFor<Qs>` maps a whole
`questions` object to its answers, so the call site needs no casts. Reading an
option that was never asked for, or `.noul` on a Choice, fails to compile.
`choice(q, ["a", "b"])` is shorthand for undescribed options, and `score`
refuses fewer than two or more than ten levels at compile time when it is given
a literal tuple.

`state`, `instructions` and every criterion take a string or plain JSON
structure (see the docs' "Advanced: structure" page). The builders check a
question when they build it, so a malformed one throws where it is written.

### Speculative fan-out

Put every question the code might need in one request and ignore the ones that
turn out not to matter. Questions run in parallel against one copy of the state,
so extra ones cost input tokens and little time.

```typescript
const { answers } = await client.ask({
  state: ticket,
  questions: {
    category: choice("What is this?", [
      "bug_report",
      "billing",
      "feature_request",
    ]),
    severity: score("How severe is the bug?", ["Cosmetic", "Degraded", "Down"]),
    repro: noul("Does it include steps to reproduce?"),
    refund: noul("Does the customer ask for a refund?"),
  },
});
if (answers.category.choice === "bug_report" && answers.severity.score > 1.5) {
  escalate();
}
```

### Routing on confidence

`confidence` is TypeSafe's own statistic over the answer's probabilities. The
helpers read it as given and never compute one of their own.

```typescript
import { gate, gateChoice, noulBand, topK } from "@celld/api/jev";

gate(answers.team, { act: 0.85, review: 0.6 }); // "act" | "review" | "escalate"

// The docs' voice-banking example: escalate under 0.6, and approve a
// transfer only at 0.85 or more.
const { decision, choice } = gateChoice(answers.intent, {
  floor: 0.6,
  act: { approve_transfer: 0.85 },
});

noulBand(answers.refund, { yes: 0.7, no: 0.3 }); // "yes" | "no" | "uncertain"
topK(answers.team, 2); // [{ option, probability }, ...], ties in asked order
```

### Composite scores

```typescript
import { composite, mostLikelyLevel, normalizeScore } from "@celld/api/jev";

const ic = composite(
  { python: 0.4, leadership: 0.1, design: 0.4, generalist: 0.1 },
  answers,
);
ic.value; // weighted mean in [0, 1]
ic.parts.design.contribution; // what each input added
normalizeScore(answers.mood); // score / (levels - 1)
mostLikelyLevel(answers.mood); // 0 | 1 | 2, the mode; `score` is the mean
```

Score answers are normalised to 0 to 1, Noul answers count as their probability,
and plain numbers must already lie in 0 to 1. The weights need not sum to 1
because the result is a weighted mean.

## Pinned models and aliases

`jev-latest` and `jev-preview` are aliases. TypeSafe moves them when it ships a
release, and the response's `model` then names the new version. A threshold
tuned against `jev-1.13.0` may not hold for whatever `jev-latest` means next
month. So:

- pin a versioned ID (`new JevClient({ model: "jev-1.13.0", ... })`, or `model`
  on the request) wherever thresholds or cached answers matter;
- log `result.model`, which is always the versioned ID that answered;
- the answer cache only works for versioned IDs. `isPinnedModel` is the test.

The default model is `jev-latest`, the SDKs' default.

## Workers wiring

The key belongs in a secret binding, never in source or `vars`.
`JevClient.fromEnv(env)` reads `TYPESAFE_API_KEY`, plus the optional
`TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` (the SDKs' variable names).

### A fleet-wide rate limiter

TypeSafe limits each account by requests per minute and input tokens per second,
and its docs warn that the numbers change while it adds capacity.
`JevRateLimiter` is one Durable Object per account that every Worker asks before
each attempt:

```typescript
import { JevClient } from "@celld/api/jev";
import { durableLimiter, type RateLimiterApi } from "@celld/api/jev/limiter";
export { JevRateLimiter } from "@celld/api/jev/durable";

interface Env {
  TYPESAFE_API_KEY: string;
  JEV_LIMITER: DurableObjectNamespace<RateLimiterApi>;
}

const client = JevClient.fromEnv(env, {
  limiter: durableLimiter(env.JEV_LIMITER), // the object named "default"
});
```

```python
celld.project(
    name = "project",
    src = ":worker",
    script_name = "triage",
    bindings = {"JEV_LIMITER": "JevRateLimiter"},
)
```

How it behaves:

- It is a token bucket in two dimensions. The defaults are Jev 1.13's documented
  1,200 requests a minute and 250,000 tokens a second, each with a one-second
  burst.
  `await env.JEV_LIMITER.getByName("default")
  .configure({ requestsPerMinute: 600 })`
  changes them; `snapshot()` reads the limits and current levels.
- The docs give no tokenizer, so the limiter does not guess token counts.
  Admission reserves `reserveTokens` (client option, default 0), and the
  response's `usage.input_tokens` is charged afterwards. The token bucket may go
  into debt, and no request is admitted until it refills.
- A 429 or 529 with `retry-after` calls `throttle`, which holds every caller
  sharing the object, not only the one that was refused.
- If the object is unreachable, the request goes ahead and `onLimiterError`
  hears about it. The server's 429 is still the authority, and a limiter outage
  should not stop traffic.
- A limiter wait counts against the retry budget. A request the limiter cannot
  admit within the budget fails with kind `timeout`, and no HTTP request is
  made.
- The bucket levels are kept in memory. They are soft state: an evicted object
  restarts with full buckets, which admits at most one burst early. The
  configured limits are durable. `configure` writes them to the object's SQLite
  in one synchronous `sql.exec` statement and waits for `storage.sync()` before
  it returns.

`memoryLimiter()` is the same bucket inside one isolate, for one process or for
tests.

### Answer cache

```typescript
import { kvCache } from "@celld/api/jev/cache";

const client = JevClient.fromEnv(env, {
  model: "jev-1.13.0",
  cache: kvCache(env.JEV_CACHE, { ttlSeconds: 86_400 }),
});
```

```python
celld.project(..., kv_namespaces = {"JEV_CACHE": "jev-answer-cache"})
```

The cache is opt-in. The key is `jev/v1/` plus the SHA-256 of the canonical JSON
of `{model, state, questions}`. Key order is kept, since the order of options
and fields is part of what the model reads. It is used only for versioned
models: with an alias, `meta.cache` is `"bypass"` and the cache is not touched.
A response from a model other than the pinned one is not stored. Hits are
decoded against the questions again, so a corrupt entry is a miss, and cache
read or write failures never fail a request. `meta.cache` reports `hit`, `miss`,
`bypass` or `off`. `memoryCache()` keeps entries in the isolate.

### Workflows

```typescript
import { askStep } from "@celld/api/jev/workflow";

const outcome = await askStep(step, "triage", client, { state, questions });
if (outcome.ok) outcome.result.answers.team.choice;
```

The call runs inside `step.do` under a stable name, so a replay reuses the
stored answer instead of paying for it again. The step stores a plain
`JevOutcome`. Transient failures that outlast the client's own retries are
thrown, and the step's durable retries take over (default: 5 retries,
exponential from 10 s, 2 minute timeout). Permanent failures are returned as
`{ok: false, error}`. Step results are capped at 1 MiB; 255-option Choices asked
many times over could approach that.

## Errors

Every failure is a `JevError` subclass with a `kind`:

| kind              | When                                            | Retried by default |
| ----------------- | ----------------------------------------------- | ------------------ |
| `invalid_request` | the request failed validation; nothing was sent | no                 |
| `bad_request`     | 400                                             | no                 |
| `authentication`  | 401                                             | no                 |
| `permission`      | 403                                             | no                 |
| `not_found`       | 404                                             | no                 |
| `validation`      | 422; `issues` holds the server's located detail | no                 |
| `rate_limited`    | 429                                             | yes                |
| `overloaded`      | 529                                             | yes                |
| `server`          | other 5xx                                       | yes                |
| `http`            | any other status, including 408                 | no                 |
| `connection`      | no response, or a body cut short                | yes                |
| `timeout`         | an attempt or the whole budget ran out of time  | yes                |
| `aborted`         | the caller's signal fired                       | never              |
| `decode`          | a 2xx that does not answer what was asked       | no                 |

Errors carry `status`, `retryAfterMs`, `requestId` (`x-typesafe-request-id`),
`body` (JSON, or text cut to 4 KiB by `@celld/http`'s `truncatedBody`),
`issues`, `attempts` and `retryable`. `issues` are sieve issues (`{code, path,
message, ...}`): a refused request or a bad response has the schema's issues,
and a 422's `{"detail": [{"loc", "msg"}]}` becomes `custom` issues with
`body` dropped from the location. The error's message renders them as
`path: message` joined by `; `.

Durable Object RPC and Workflow steps keep only an error's name and message.
Code that crosses those boundaries should use `client.tryAsk`, which returns
`{ok: true, result}` or `{ok: false, error}` with `error` as plain
`JevErrorData`, or `error.toJSON()`. `jevErrorFromData` rebuilds the class on
the other side.

## Retry policy

The policy is `@celld/http`'s `HttpRetryPolicy`, exported here as
`RetryPolicy`, with jev's own defaults. `resolveRetryPolicy(options, base?)`
fills a partial policy from `base` (default `DEFAULT_RETRY_POLICY`); an
option set to `undefined` takes the default, and a bad value is a
`RangeError` naming the field. The defaults come from the SDKs:

| Setting                                  | Default                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `maxRetries`                             | 2, so three attempts                                        |
| `backoffInitialMs`, `backoffMaxMs`       | 500 ms doubling to 5 s                                      |
| `backoffJitter`                          | 0.25 of each delay randomly subtracted; 1 is full jitter    |
| `statuses`                               | 429 and 500 to 599, which includes 529                      |
| `respectRetryAfter`, `maxRetryAfterMs`   | yes, capped at 60 s                                         |
| `retryConnectionErrors`, `retryTimeouts` | yes                                                         |
| `budgetMs`                               | 30 s for the whole call (the Python SDK's); `null` disables |
| `timeoutMs` (client option)              | 10 s per attempt                                            |

`retry-after-ms` wins over `retry-after`, which may be delta-seconds or an
HTTP-date. A server-requested wait above the cap is cut to the cap. The client
never starts a retry whose wait would reach the budget, and throws the last
error instead. The caller's `signal` cancels the attempt, a limiter wait or a
retry sleep. The SDKs also retry 408; this policy never retries a 4xx other than
429 unless `statuses` names it. All of it can be overridden per client and per
call (`ask(request, { retry, timeoutMs, signal })`).

## What is validated, and why

Nothing is sent until the request passes `AskRequestSchema`, a sieve schema
of the `POST /v1/systemone` body. A refused request wastes a round trip and a
rate-limit slot. A request that `JSON.stringify` quietly alters gets a wrong
answer back. All problems are reported together with their paths
(`questions.team.criteria.a`):

- there is at least one question, and no id is empty;
- `model` is a non-blank string;
- `state` is present and is a string, object or array, never `null`;
- the request has only `state`, `questions` and `model`, and each question
  only `type`, `instructions` and `criteria`, so a typo like `critera` is
  caught (as an `unrecognized_keys` issue at `questions.typo.critera`);
- `instructions` are non-blank, and objects and arrays are non-empty;
- a Choice has 1 to 255 options with non-blank names;
- a Score has 2 to 10 levels;
- a Noul's `criteria`, if present, describes `true` and/or `false` and nothing
  else;
- descriptions and levels are non-blank strings, non-empty structure or `null`;
- every value is plain JSON (`v.json()`). `undefined`, functions, symbols,
  bigints, `NaN` and `Infinity`, array holes, dates, maps, class instances and
  cycles are all refused.

Token counts are not checked. The docs give a budget (64k per request, 32k for
the state plus the longest question) but no tokenizer, so the server's 422
decides.

### The schemas

`@celld/api/jev/schemas` (also exported from `@celld/api/jev`) has the schemas the
client uses. Each is named with `.meta({ id })`, and `:schemas-json-schema`
writes them as one JSON Schema bundle at build time, checked against
[`tests/golden/schemas.schema.json`](tests/golden/schemas.schema.json).

| Schema                  | `id`             | What it is                                              |
| ----------------------- | ---------------- | ------------------------------------------------------- |
| `AskRequestSchema`      | `AskRequest`     | the `POST /v1/systemone` body: `model`, `state`, `questions` |
| `QuestionsSchema`       | `Questions`      | at least one question by non-empty id                  |
| `QuestionSchema`        | `Question`       | Noul, Choice or Score, told apart by `type`            |
| `NoulQuestionSchema`, `ChoiceQuestionSchema`, `ScoreQuestionSchema` | `NoulQuestion`, ... | one question type, strict |
| `EntrySchema`           | `Entry`          | instructions: non-blank text or non-empty JSON structure |
| `CriterionSchema`       | `Criterion`      | an entry or `null`                                      |
| `StateSchema`           | `State`          | text or JSON structure, possibly blank or empty         |
| `ModelNameSchema`       | `ModelName`      | a non-blank model name                                  |
| `UsageSchema`, `ModelCardSchema`, `ModelListSchema` | `Usage`, ... | response parts; `release_date` is an ISO 8601 date |

`requestIssues(request, model)` returns the issues of `{...request, model}`
against `AskRequestSchema`. `responseSchema(questions, options?)` builds the
schema a response must match to answer those questions (see below);
`decodeResponse` and `decodeModels` throw `JevDecodeError` with its issues.
The builders parse each question with `QuestionSchema`.

The request checks used to be hand-written. What went with them: `LIMITS`,
`questionIssues` (use `QuestionSchema.safeParse`), `jsonIssues` (use
`v.json()`), `formatPath` and `formatIssues` (use sieve's `formatPath` and
`prettifyError`), `isPlainObject`, `describeValue` and the `Path` type.
`JsonValue`, `JsonObject`, `JsonPrimitive` and `canonicalJson` stay.

## What is decoded, and how strictly

The typed answers promise that `answers.team.choice` is one of the options that
were sent, and the decoder checks this before returning. A response must:

- answer every question asked and no other, each with the question's `type`;
- give Choice probabilities for exactly the options sent, with `choice` among
  them and carrying the largest probability;
- give Score probabilities and legend for exactly `"0"` to `"n-1"`, repeat each
  string level verbatim in the legend, and keep `score` within 0 to n-1;
- keep every probability, `noul` and `confidence` a finite number in 0 to 1, and
  token counts non-negative integers.

The probability-sum check is strict. The docs say each distribution sums to 1,
so a sum more than `probabilityTolerance` (default 0.01, configurable via
`decode`) from 1 is a `decode` error. The same tolerance bounds how far `choice`
may sit below the largest probability. Unknown fields are dropped. A mismatch
fails the whole response and lists every path.

## Testing code that uses it

```typescript
import {
  fakeBody,
  fakeFetch,
  jsonResponse,
  virtualRuntime,
} from "@celld/api/jev/testing";

const fetch = fakeFetch(({ body }) =>
  jsonResponse(fakeBody(body.questions, { answers: { urgent: { noul: 0.2 } } }))
);
const client = new JevClient({
  apiKey: "test",
  fetch,
  runtime: virtualRuntime(),
});
// fetch.calls records every request; the virtual runtime sleeps instantly.
```

## Examples

[`examples/`](examples) has standalone Workers using this library, each a
[`@celld/router`](../../router) app with sieve body schemas and each
tested under `celld dev` against a fake upstream
(`buck2 test root//src/celld/api/jev/examples/...`) and runnable with
`buck2 run root//src/celld/api/jev/examples:<name>-dev`.

## This package's tests

`buck2 test root//src/celld/api/jev/...` runs one Deno suite per concern (builders
and compile-time types, schemas, decoding, errors, retry policy, client,
helpers, cache, limiter, workflow), `:schemas-golden-test` (the JSON Schema
bundle against its golden file; after an intended change, copy the output of
`buck2 build root//src/celld/api/jev:schemas-json-schema --show-output` over it),
plus `:runtime-test`. That test starts the
project in `tests/runtime/` under `celld dev` and points it at a fake TypeSafe
server on loopback. It covers real `fetch` timeouts, the limiter object's
pacing, throttling and token charging, limits surviving a supervisor restart,
and the KV cache.
