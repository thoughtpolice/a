<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/http

The pieces the celld HTTP clients (jev, exedev, openai, mcp) would otherwise
each copy: retry policies, a policy-bound `fetch` for untrusted URLs, an
injectable clock and `fetch`, error-body truncation, server-sent events, and
test doubles. It depends on `@celld/core/bounds` and `@celld/core/ip` and uses only
`fetch`, timers, `TextDecoder`/`TextEncoder` and streams, so it runs in
Workers, Durable Objects and Workflows.

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
| `@celld/http`         | retry policies, `mayRetry`, `isIdempotentMethod`, `MAX_RETRIES`, `Runtime`, `FetchLike`, `rejectOnAbort`, `truncatedBody`, `JsonValue` |
| `@celld/http/egress`  | `boundedFetch`, `EgressPolicy`, `BoundedResponse`, `EgressError`, `classifyHost`, `CROSS_ORIGIN_HEADERS` |
| `@celld/http/sse`     | `SseParser`, `Utf8Chunks`, `sseEvents`, `sseMessage`, `SSE_KEEPALIVE`, `DEFAULT_MAX_EVENT_LENGTH` |
| `@celld/http/testing` | `virtualRuntime`, `fakeStep`                                |

## Retry policies

The library has no default policy; each client owns its defaults and
resolves callers' overrides against them.

```typescript
import {
  backoffDelay,
  type HttpRetryPolicy,
  isIdempotentMethod,
  mayRetry,
  parseRetryAfter,
  resolveRetryPolicy,
  type RetryFailure,
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

// Attempt number `retry` (0 for the first) failed with a status:
const failure: RetryFailure = { kind: "status", status: response.status };
const idempotent = isIdempotentMethod(method); // or what the API documents
if (retry >= policy.maxRetries || !mayRetry(policy, failure, { idempotent })) {
  throw error;
}
const asked = policy.respectRetryAfter
  ? parseRetryAfter(response.headers, runtime.now())
  : null;
const wait = asked === null
  ? backoffDelay(policy, retry, runtime.random())
  : Math.min(asked, policy.maxRetryAfterMs);
// Then check `wait` against what is left of `budgetMs` before sleeping.
```

`RetryPolicy` holds the fields every client shares: `maxRetries`, the
backoff (`backoffInitialMs` doubling to `backoffMaxMs`, less
`backoffJitter` of each delay at random), `respectRetryAfter` with its
cap `maxRetryAfterMs`, and `budgetMs` for the whole call (`null` for none).
`HttpRetryPolicy` adds `statuses`, `retryConnectionErrors` and
`retryTimeouts`. A client that sorts failures into kinds of its own extends
`RetryPolicy` with a list instead, as openai does with `retryOn`.

### Which requests may be retried

A retry sends the request again, so it is only safe when acting twice is
the same as acting once. No failure proves the server did not act: a
status is an answer, a timeout leaves the request with the server, and
`fetch` also rejects when the connection breaks after the request was sent.
`mayRetry(policy, failure, { idempotent })` decides for an
`HttpRetryPolicy`, and the caller must declare `idempotent`; there is no
default, and a missing declaration throws.

| Failure (`kind`) | What happened | Retried when |
| --- | --- | --- |
| `connection` | `fetch` rejected before any response began | `idempotent` and `retryConnectionErrors` |
| `status` | a response arrived | `idempotent` and the status is in `statuses` |
| `timeout` | the client stopped waiting | `idempotent` and `retryTimeouts` |
| `body` | the response began, then its body failed | `idempotent` and `retryConnectionErrors` |

So a write (`POST`, a `tools/call`, a charge) is never repeated, whatever
the policy's `statuses` say.
`isIdempotentMethod(method)` gives RFC 9110's answer for a method (GET,
HEAD, OPTIONS, TRACE, PUT, DELETE); an API that reads over POST or writes
over GET should declare its own. A write carrying an idempotency key that
the server deduplicates durably may be declared idempotent. Nothing is
retried when `maxRetries` is 0; counting attempts, backoff and the budget
stay with the caller.

`resolveRetryPolicy(options, defaults)` keeps exactly the fields of
`defaults`, rejects unknown keys/accessors with `TypeError`, and an option
that is `undefined` takes the default. It throws
a `RangeError` naming the first bad field. The checks are:

- numbers must be finite and in range. The waits (`backoffInitialMs`,
  `backoffMaxMs`, `maxRetryAfterMs`) are at most `MAX_TIMER_MS` from
  `@celld/core/bounds`, since a longer timer fires at once;
- `maxRetries` must be an integer from 0 to `MAX_RETRIES` (100), and
  `budgetMs` at least 1 or `null`;
- booleans must be booleans;
- a list accepts an iterable of at most 1024 items and loses duplicates. `statuses` must hold
  HTTP statuses, and comes back sorted.

The policy and its lists are frozen.

`parseRetryAfter` reads `retry-after-ms`, then `retry-after` as
delta-seconds or an HTTP-date. A date in the past means no wait. It returns
`null` when neither header can be read, and otherwise a safe integer (a
header of hundreds of digits is cut to `Number.MAX_SAFE_INTEGER`); capping
the wait at `maxRetryAfterMs` is left to the caller.

## Bounded egress

`boundedFetch(policy, fetch?)` returns a function with `fetch`'s signature
for URLs that come from outside: metadata and JWKS documents, federation
statements, client-supplied `jwks_uri`s and the like.

```typescript
import { boundedFetch } from "@celld/http/egress";
import { bytes, millis } from "@celld/core/bounds";

const get = boundedFetch({
  allow: (url, hop) => hop === 0 || url.hostname.endsWith(".example"),
  redirects: 2,
  timeoutMs: millis(5_000),
  maxBytes: bytes(64 * 1024),
  json: { maxDepth: 8, maxKeys: 64, maxItems: 100 },
  network: "public",
  budget: { fetches: 16 },
});
const response = await get(url, { signal });
const document: unknown = await response.json();
```

Before the first request and before each redirect hop, in this order:

1. the URL may not carry credentials (`user:pass@`) or a fragment;
2. the scheme must be `https:`; `http:` is allowed only to a loopback IP
   literal (`127.0.0.0/8`, `::1`), and only when the policy sets
   `allowCleartextLoopbackForDevelopment: true` (see below);
3. the host must be in `network`: `"public"` refuses loopback, private,
   CGNAT, link-local (including `169.254.169.254`), multicast,
   unspecified, reserved and documentation ranges, their IPv4-mapped,
   NAT64 and 6to4 forms, `localhost`/`*.localhost` and the hosts-file
   loopback aliases (`localhost.localdomain`, `localhost6`,
   `ip6-localhost`, ...), and names under `.local`, `.internal`,
   `.home.arpa` and `.localdomain`, trailing dots ignored; `"loopback"`
   also allows loopback; `"any"` allows everything;
4. `allow(url, hop)` must return `true` (hop 0 is the first request);
5. one fetch is taken from `budget.fetches`, when there is a budget. The
   budget object is decremented in place, so share one across the requests
   of one operation and give each operation its own.

Requests go out with `redirect: "manual"`. With `redirects: 0` any redirect
is an error; otherwise `Location` is resolved and checked as above, at most
`redirects` hops (up to 20) are followed, a URL seen before is a loop, and
the first hop to another origin drops every request header except
`CROSS_ORIGIN_HEADERS` for the rest of the chain: `accept`,
`accept-language`, `cache-control`, `content-encoding`,
`content-language`, `content-type`, `pragma` and `user-agent`. Any other
header may carry a credential (`authorization`, `cookie`, `dpop`,
`x-api-key`, a vendor's own), so the list names what is kept, not what
is secret. The method is normalized as `fetch` does (`post` is `POST`).
303 (and 301/302 after a POST) continue as GET without the body; a
307/308 with a streamed body fails, since the stream cannot be sent twice.
A redirect that keeps a body (a 307/308, or a 301/302 after another
method) to an origin other than the first request's is refused with
`redirect` before the target is fetched, since a body carries credentials
too (a client secret, an authorization code). `unsafeResendBodyCrossOrigin:
true` allows it for an API that really moves across origins.

`timeoutMs` covers the whole operation, including reading the body, and a
caller's `signal` is merged with it. The result is a `BoundedResponse`:
`status`, `statusText`, `ok`, `headers`, the final `url`, `redirected`, and
only bounded body readers. `bytes()`, `text()` and `json()` read the stream
up to `maxBytes`, whatever `Content-Length` says, and `json()` parses under
`json` (or `DEFAULT_JSON_LIMITS`), refusing prototype keys and duplicate
keys. `stream()` hands the body over as it arrives (for server-sent
events): it errors with `too_large` once more than `maxBytes` have passed
and with `timeout` at the deadline, cancelling the body, and ends the
deadline when read to the end or cancelled. The body can be read once;
call `discard()` when it is not read, which also ends the deadline timer;
after `stream()`, `discard()` cancels the stream (reads error with
`aborted`). Every failure is an `EgressError` whose
`code` is one of `url`, `scheme`, `network`, `denied`, `redirect`,
`timeout`, `aborted`, `budget`, `fetch`, `too_large`, `json`, `used`. A bad
policy throws when `boundedFetch` is called.

**Cleartext is a development switch.** The rule for the whole repository
is that plain `http:` is only ever turned on by a name that says
`ForDevelopment`. `network` chooses which hosts are reachable (a sidecar
on loopback over https is a production use) and never allows cleartext by
itself; `allowCleartextLoopbackForDevelopment: true` does, to loopback IP
literals only, and it is a `RangeError` with `network: "public"`. Clients
built on this map their own development flag onto it (jwt's and oauth's
`allowLoopbackForDevelopment`).

**Limits of the address check.** The network policy sees the host as the
URL writes it: IP literals, loopback and local-network names, on every
hop. A DNS name
is resolved by the platform when `fetch` connects, and neither Workers nor
Deno offers a hook to inspect or pin the resolved address, so a name that
resolves to a private address is not caught here. Where that matters,
narrow names with `allow` and rely on the platform's egress controls.
`classifyHost(hostname)` exposes the classification (`public`, `loopback`,
`local`, or `name` for a DNS name) for other URL policies.

## Runtime and fetch

`Runtime` is `now`, `random`, an abortable `sleep` and a cancellable
`setTimer`; `defaultRuntime` is the real one (frozen). Its `sleep` rejects,
and its `setTimer` throws, a `RangeError` for a delay that is not a number
from 0 to `MAX_TIMER_MS`: `setTimeout` would run such a delay at once, and a
bad wait would become a tight loop. `FetchLike` is the
shape of the global `fetch` (`string | URL | Request`, optional init), so
`fetch` itself, a service binding's `fetch` and other libraries' fetches
all fit; the clients call it with a URL string and an init. `globalFetch`
calls `fetch` late, so tests that replace `globalThis.fetch` are honoured. `rejectOnAbort(promise, signal)`
rejects with the signal's reason as soon as it aborts, so a `fetch` or body
read that ignores its signal cannot outlive a timeout.

`truncatedBody(text)` is how clients keep an error body. It returns `null`
when the body is empty, the parsed value when the body is JSON of at most
`MAX_ERROR_TEXT` (4096) UTF-16 code units, and otherwise the text, cut to
that length with a trailing `…`; longer JSON is cut like any text, so what
an error carries stays small. The cut never splits a surrogate pair. Its result type, `JsonValue`, is
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
event id survives `finish()`, as it does when a client reconnects. A
`retry` past `MAX_TIMER_MS` is ignored, as a timer cannot hold it.
`Utf8Chunks` decodes bytes without breaking split characters and drops a
leading BOM.

One event is capped: its data lines plus the line being read may hold at
most `maxEventLength` UTF-16 code units (`new SseParser({ maxEventLength })`,
default `DEFAULT_MAX_EVENT_LENGTH`, 8 Mi). Past it `push` throws a
`BoundsError` with code `too_large`, so a stream that never sends a newline
or a blank line cannot grow without limit. How many events a stream may
carry, and for how long, is the consumer's to bound (or use
`BoundedResponse.stream()`).

`sseEvents(body, { maxEventLength })` puts the two together over a byte
stream. It throws `Error("truncated")` for a broken stream and the
`BoundsError` for an event over the cap, and cancels the body when the
consumer leaves early or the cap is hit, which releases a `fetch`
connection.

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
