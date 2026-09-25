<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# celld library examples

Every celld library under `src/celld/<lib>` keeps standalone example Workers
in `src/celld/<lib>/examples/`. Each example is one short, realistic Worker
with a doc comment saying what it shows and how to run it, and a spec that
runs it under `celld dev` against a fake of the service it talks to. This
package holds what they share:

| File | What it is |
| --- | --- |
| [`defs.bzl`](defs.bzl) | `celld_example` and `celld_example_upstream` |
| [`harness.py`](harness.py) | the runner behind every example's `-test` and `-dev` targets |
| [`upstream.ts`](upstream.ts) | `@celld/examples/upstream`: the host a fake upstream runs in |
| [`testdata/`](testdata) | the harness's own examples, which test it end to end: `echo` (with an upstream) and `plain` (without, as a pure library's are) |
| [`harness_test.py`](harness_test.py) | the matchers, including every way they must fail |

Examples so far: [assert](../assert/examples), [ulid](../ulid/examples),
[ip](../ip/examples), [isotime](../isotime/examples), [jwt](../jwt/examples),
[sieve](../sieve/examples), [router](../router/examples),
[container](../container/examples), [sandbox](../sandbox/examples),
[jev](../api/jev/examples),
[exedev](../api/exedev/examples), [openai](../api/openai/examples),
[mcp](../mcp/examples), [oauth](../oauth/examples),
[oidc](../oidc/examples).

## One example

```python
load("@root//src/celld/examples:defs.bzl", "celld_example")

celld_example(
    name = "triage",
    main = "triage.ts",            # the Worker
    upstream = ":upstream",        # its fake service (optional)
    deps = ["root//src/celld/api/jev:jev"],
    # Anything else is a celld.project attribute:
    bindings = {"JEV_LIMITER": "JevRateLimiter"},
    kv_namespaces = {"JEV_CACHE": "jev-example-answers"},
)
```

That gives, for `name = "triage"`:

| Target | What it does |
| --- | --- |
| `:triage` | the packaged `celld.project` (script name `<lib>-example-triage`) |
| `:triage-worker` | the bundle, with its `[check]` and `[lint]` tests |
| `:triage-deploy-test` | `celld deploy --dry-run` over the project |
| `:triage-test` | runs `triage.json` against the project under `celld dev` |
| `:triage-dev` | `buck2 run` it to keep the example up on `127.0.0.1:9876` |

Each example has its own test, so Buck runs them in parallel; one takes about
five seconds, most of it `celld dev` starting. `buck2 run :triage-dev` prints
a `curl` line for every request in the spec and serves until Ctrl-C;
`-- --port N`, `-- --state DIR` (keep the storage), `-- --live` (no fake:
the Worker reaches the real service) and `-- --var NAME=VALUE` (a Worker
variable, such as a real key with `--live`) change that.

## The fake upstream

A fake is a small Deno program that wraps the library's own test double
(`FakeExe`, `FakeResponses`, `fakeBody`, ...) in `serveUpstream`:

```typescript
import { serveUpstream } from "@celld/examples/upstream";

serveUpstream({
  fetch: (request) => answer(request),     // the fake service
  script: (instruction) => queue(instruction), // a spec's `script` entries
  vars: (origin) => ({ TYPESAFE_BASE_URL: origin, TYPESAFE_API_KEY: "example-key" }),
});
```

```python
celld_example_upstream(
    name = "upstream",
    main = "upstream.ts",
    deps = ["root//src/celld/api/jev/examples:fake"],
    run = [],  # programs it may start, such as ["/bin/sh"] for a fake VM
)
```

It is bundled like a Worker (strict deps, no `deno.json`) and run with the
repository's Deno, allowed only to listen and connect on loopback (and to run
what `run` lists). The harness passes a scratch directory as its only
argument (`scratchDirectory()`) and removes it afterwards. The host:

- listens on a free loopback port and prints `{"upstream": origin, "vars":
  {...}}`; the harness writes `vars` into the project's `.dev.vars`, so the
  Worker finds the fake through the library's own settings
  (`TYPESAFE_BASE_URL`, `OPENAI_BASE_URL`, `EXE_BASE_URL`, ...) and needs no
  test-only code;
- records every request (method, path, `Host`, headers, text, parsed JSON)
  for `GET /__upstream/requests?since=N`;
- passes `POST /__upstream/script` bodies to `script`.

Put the vars a real deployment needs as secrets (keys, tokens) in `vars`, not
in `celld_example(vars = ...)`, which would ship them in the project. A fake
reachable from another library's examples is a `celld.library` of its own,
as `@celld/api/jev/examples/fake` is for the openai bridge. Requests to
`<name>.localhost:<port>` also reach the fake, which is how the exedev
integration example sees `https://<name>.int.exe.xyz`.

## Specs

A spec is `<name>.json` beside the Worker (JSON cannot carry an SPDX header;
the checker skips it). It is a list of steps run in order:

```json
{
  "vars": {
    "EXTRA": "a Worker variable; {upstream} is the fake's origin",
    "SIGNING_JWK": { "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "d": "..." }
  },
  "steps": [
    {
      "name": "what this step shows, as a sentence",
      "restart": false,
      "script": { "answers": { "team": { "choice": "technical" } } },
      "request": { "method": "POST", "path": "/tickets", "json": { "subject": "..." } },
      "expect": { "status": 200, "json": { "team": "technical" } },
      "until": { "seconds": 30, "interval": 0.2 },
      "upstream": [{ "path": "/v1/systemone", "json": { "state": "..." } }]
    }
  ]
}
```

- `vars` (and the fake's `vars`) reach the Worker byte for byte. A string is
  the variable's text; anything else, such as a JWK object, arrives as
  compact JSON for the Worker to `JSON.parse`. celld reads `.dev.vars` with
  no escapes (a `\"` stays two characters), so the harness writes every
  value between single quotes, verbatim; a value with a line break is
  refused, since `.dev.vars` cannot carry one.
- `restart` stops and starts `celld dev` first, keeping its storage: for
  Durable Object and KV state that must survive.
- `script` is one entry for the fake, or a list of them, sent before the
  request. Each fake documents its entries at the top of its `upstream.ts`.
- `request` takes `method` (default `GET`, or `POST` with a body), `path`,
  `headers`, and `json` or a raw `body`. Redirects are not followed.
- `expect` holds matchers for `status` (default 200), `json`, `text`,
  `headers` (lower-case names; a repeated header shows its last value),
  `cookies` (every `Set-Cookie` line, in order, as a list) and `sse` (the
  body parsed as server-sent events, `[{"event", "data"}]`, with `data`
  parsed as JSON when it is). `save` reaches them the same way
  (`cookies.0`).
- `until` repeats the request until `expect` holds, for Workflows.
- `upstream` matches the list of requests the fake received since the last
  step that had an `upstream` check. `[]` says nothing reached it, and a
  Workflow's requests are checked by the step that waits for its result.
- `save` keeps values from the response under names, as dotted paths into
  it (`{"task": "json.result.taskId"}`; list indices are numbers). Later
  steps say `{task}` anywhere in `script`, `request`, `expect` or
  `upstream`: a string that is exactly `{task}` becomes the saved value,
  and one containing it gets its text. This is how a spec follows an id or
  token the Worker made up, such as an MCP `taskId` or `requestState`.
  A save of `{"path": "headers.location", "regex": "code=([^&]+)"}` keeps
  the first group of the pattern instead, such as an OAuth `code`.
- `request.url`, instead of `path`, is an absolute loopback URL: a saved
  `Location` to follow to the fake upstream or back to the Worker, as a
  browser would in a login redirect.

Matchers: an object matches an object with at least its keys; a list matches
a list of the same length element by element; scalars must be equal (`true`
is not `1`). The operators are `{"$exact": v}`, `{"$any": true}`,
`{"$absent": true}` (as an object's value), `{"$regex": r}`, `{"$contains":
v}` (substring, or a list element matching `v`), `{"$len": n}`, `{"$gt": n}`,
`$gte`, `$lt`, `$lte`, `{"$json": m}` (parse a string, then match) and
`{"$not": m}`.

`$exact` makes every object inside it match only with exactly its keys (and
lists, as always, only with their length), but still evaluates the
operators inside it: `{"$exact": {"id": {"$regex": "^t_"}, "n": 2}}` is
an object with just those two keys. An operator's own argument is matched
as usual, so write `$exact` again inside a `$contains` or `$json` to make
that exact too. Under `$exact`, a one-key object whose key is not an
operator is data, as JSON Schema's `{"$ref": "..."}` is.

A failing step prints each mismatch with its path, the response, the
requests the fake saw, and both processes' logs.

## Adding examples to a library

1. Make `src/celld/<lib>/examples/`, a package of its own whose `BUILD`
   loads `defs.bzl`.
2. If the library calls a service, write `upstream.ts` around the library's
   test double and declare it with `celld_example_upstream`. A library with
   no upstream (a pure one) needs none: leave `upstream` out, and specs
   cannot use `script` or `upstream`.
3. Per example, write `<name>.ts`: `export default { fetch }`, plus Durable
   Objects or Workflows where the library offers them. Start with a module
   doc comment: what it shows, the routes, and a `buck2 run
   root//src/celld/<lib>/examples:<name>-dev` plus `curl` block. Read
   settings through the library's `fromEnv` or `env`, never from requests.
4. Write `<name>.json`. Check behaviour, not only that it booted: status
   codes, response bodies, and what reached the upstream. Keep it
   deterministic: fixed ids, scripted answers, no clocks.
5. Add `celld_example(...)` to the `BUILD`, and a line to the package's
   `README.md` index.
6. `buck2 test root//src/celld/<lib>/examples/...`.

Everything stays on loopback. The harness removes proxies and `CELLD_*`,
`AWS_*` and `S3_*` variables from both processes' environments, and no
example needs a network, an account or a real token.
