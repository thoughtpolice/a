<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/http

The pieces the celld HTTP clients (jev, exedev, openai, mcp) would otherwise
each copy: retry policies, an injectable clock and `fetch`, error-body
truncation, server-sent events, and test doubles. It has no dependencies and
uses only `fetch`, timers, `TextDecoder`/`TextEncoder` and streams, so it
runs in Workers, Durable Objects and Workflows.

```python
celld.library(
    name = "client",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/client",
    deps = ["root//src/celld/http:http"],
)
```

| Specifier             | What                                                        |
| --------------------- | ----------------------------------------------------------- |
| `@celld/http`         | retry policies, `Runtime`, `FetchLike`, `rejectOnAbort`, `truncatedBody`, `JsonValue` |
| `@celld/http/sse`     | `SseParser`, `Utf8Chunks`, `sseEvents`, `sseMessage`, `SSE_KEEPALIVE` |
| `@celld/http/testing` | `virtualRuntime`, `fakeStep`                                |

## Retry policies

The library has no default policy; each client owns its defaults and
resolves callers' overrides against them.

```typescript
import {
  backoffDelay,
  type HttpRetryPolicy,
  parseRetryAfter,
  resolveRetryPolicy,
  type RetryOptions,
} from "@celld/http";

export const DEFAULT_RETRY_POLICY: HttpRetryPolicy = Object.freeze({
  maxRetries: 2,
  backoffInitialMs: 500,
  backoffMaxMs: 8_000,
  backoffJitter: 0.25,
  statuses: Object.freeze([429, 500, 502, 503, 504]),
  respectRetryAfter: true,
  maxRetryAfterMs: 60_000,
  retryConnectionErrors: true,
  retryTimeouts: true,
  budgetMs: 120_000,
});

const policy = resolveRetryPolicy(options.retry, DEFAULT_RETRY_POLICY);
const wait = parseRetryAfter(response.headers, runtime.now()) ??
  backoffDelay(policy, retry, runtime.random());
```

`RetryPolicy` holds the fields every client shares: `maxRetries`, the
backoff (`backoffInitialMs` doubling to `backoffMaxMs`, less
`backoffJitter` of each delay at random), `respectRetryAfter` with its
cap `maxRetryAfterMs`, and `budgetMs` for the whole call (`null` for none).
`HttpRetryPolicy` adds `statuses`, `retryConnectionErrors` and
`retryTimeouts`. A client that sorts failures into kinds of its own extends
`RetryPolicy` with a list instead, as openai does with `retryOn`.

`resolveRetryPolicy(options, defaults)` keeps exactly the fields of
`defaults`, and an option that is `undefined` takes the default. It throws
a `RangeError` naming the first bad field. The checks are:

- numbers must be finite and in range;
- `maxRetries` must be a non-negative integer, and `budgetMs` at least 1 or
  `null`;
- booleans must be booleans;
- a list accepts any iterable and loses duplicates. `statuses` must hold
  HTTP statuses, and comes back sorted.

The policy and its lists are frozen.

`parseRetryAfter` reads `retry-after-ms`, then `retry-after` as
delta-seconds or an HTTP-date. A date in the past means no wait. It returns
`null` when neither header can be read; capping the wait at `maxRetryAfterMs`
is left to the caller.

## Runtime and fetch

`Runtime` is `now`, `random`, an abortable `sleep` and a cancellable
`setTimer`; `defaultRuntime` is the real one (frozen). `FetchLike` is the
shape of the global `fetch` (`string | URL | Request`, optional init), so
`fetch` itself, a service binding's `fetch` and other libraries' fetches
all fit; the clients call it with a URL string and an init. `globalFetch`
calls `fetch` late, so tests that replace `globalThis.fetch` are honoured. `rejectOnAbort(promise, signal)`
rejects with the signal's reason as soon as it aborts, so a `fetch` or body
read that ignores its signal cannot outlive a timeout.

`truncatedBody(text)` is how clients keep an error body. It returns `null`
when the body is empty, the parsed value when the body is JSON, and otherwise
the text, cut to `MAX_ERROR_TEXT` (4096) UTF-16 code units with a trailing
`…`. The cut never splits a surrogate pair. Its result type, `JsonValue`, is
structural, so it is assignable to `@celld/sieve`'s `JsonValue` without a
cast.

## Server-sent events

`SseParser` follows the WHATWG event-stream rules over text fed in any
chunking. It handles CR, LF and CRLF line endings (including a CRLF split
across chunks), comments, `data` lines joined by LF, a persistent `id` (one
containing NUL is ignored) and a digits-only `retry`. It scans each character once,
so a large event arriving in many small chunks costs linear time.
`finish()` reports `truncated` when an event had started but its blank line
never came, which for an API stream means the connection broke. The last
event id survives `finish()`, as it does when a client reconnects.
`Utf8Chunks` decodes bytes without breaking split characters and drops a
leading BOM.

`sseEvents(body)` puts the two together over a byte stream. It throws
`Error("truncated")` for a broken stream, and cancels the body when the
consumer leaves early, which releases a `fetch` connection.

For servers, `sseMessage(value)` frames one JSON value as a `message` event,
and `SSE_KEEPALIVE` is a `:` comment. The keep-alive is a single shared
buffer, so enqueue it only on default `ReadableStream`s, never on byte
streams that transfer their chunks.

## Test doubles

`virtualRuntime({ start?, random? })` sleeps instantly. It advances a
virtual clock and records each sleep in `sleeps`, and `advance(ms)` moves
the clock by hand. Timers stay real, so keep attempt timeouts short.

`fakeStep()` is a `WorkflowStep` with celld's replay semantics:

- a `do` name that already succeeded returns a structured clone of its stored
  result, and so does the first run;
- a throwing callback is retried without waiting, up to `retries.limit`
  (five when no `retries` is given);
- the callback gets a `WorkflowStepContext` with the attempt number and the
  effective config;
- `sleep` and `sleepUntil` are recorded once per name;
- `waitForEvent` rejects.

`log` lists `run <name> #<attempt>`, `threw <Error name>: <message>`,
`replay <name>`, `sleep <name> <duration>` and `sleepUntil <name> <epoch ms>`,
and `stored` holds the `do` results. Run the same Workflow code twice with
one `fakeStep()` to test replay.

## Tests

```sh
buck2 test root//src/celld/http/...
```
