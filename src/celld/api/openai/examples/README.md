<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/api/openai examples

Standalone Workers using `@celld/api/openai`. Each runs in its own test against a
fake LLM integration ([`upstream.ts`](upstream.ts)): `FakeResponses`
streaming scripted turns as the Codex backend does, plus the jev examples'
fake TypeSafe for the bridge; see [the convention](../../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`chat`](chat.ts) | a chat endpoint, whole or streamed as server-sent events; retries; usage limits |
| [`extract`](extract.ts) | structured output with a strict schema; refusals and schema errors |
| [`agent`](agent.ts) | a tool-using agent: typed tools, `approveByRisk`, bad arguments, the turn budget |
| [`review`](review.ts) | Blue Team: `securityReview` of a diff and `triage` of an alert |
| [`threads`](threads.ts) | `GptConversations` and `GptPacer`: replayed reasoning, usage-limit holds; threads per authenticated caller (bearer JWT, keyed-hash store names), conditional saves (a concurrent turn is a 409), a per-caller thread cap checked in the save's transaction, the pacer for the `pacer:admin` scope only |
| [`bridge`](bridge.ts) | `@celld/api/openai/jev`: `routeEffort`, `jevApprover`, `scoreOutput` |
| [`sandbox`](sandbox.ts) | `@celld/api/openai/sandbox` in a real busybox container: one sandbox per authenticated caller (bearer JWT, keyed-hash sandbox names), staged `apply_patch`, uploads under the workspace lease, a `grep_files` regex in busybox, `strings` into `reverseEngineer`, opaque 500s, the `hostile` tier (`needs-docker`) |

## Which examples authenticate

`threads` and `sandbox` authenticate every request with a bearer JWT
checked against a development secret in their spec's `vars` (the specs
carry pre-signed tokens), and name each caller's storage by a keyed hash
of the verified principal. The other five are **deliberately
unauthenticated** local demos, each saying so in its first lines. Never
deploy them as they are: anyone who can reach one can

- `chat`, `extract`: spend the subscription's quota, one model call per
  request on text of their choosing;
- `review`: spend it much faster, since a `/review` body may be 4 MiB
  (many chunks, each a high-effort call) and a request may run for 15
  minutes;
- `agent`: spend it, up to six turns a request, and approve the `reorder`
  write tool for themselves through the body's `allowOrders`, a demo
  toggle that a deployment ties to the caller's scopes instead;
- `bridge`: spend the subscription's quota and the TypeSafe key's, and
  drive an agent whose `run_sql` tool writes (here a stand-in that only
  echoes), with Jev judging each call against the caller's own prompt.

`sandbox` runs uploaded samples on the `hostile` tier, which refuses
when it cannot verify gVisor. The development specs deliberately exercise
runc: `sandbox.json` sets `UNSAFE_ANALYZER_ON_RUNC` to pick
`UnsafeTrustedAnalyzer` (the `trusted` tier, sharing the host kernel under
runc); its answers then say `"tier": "trusted (unsafe)"`.
`sandbox-hostile.json` runs the same Worker without the variable and shows
the refusal. Neither fixture replaces the required positive
`root//src/celld/box/sandbox:integration-runsc-test` acceptance lane on the
intended image/runtime.

```sh
buck2 test root//src/celld/api/openai/examples/...
buck2 run root//src/celld/api/openai/examples:chat-dev   # then curl 127.0.0.1:9876
```

Unscripted, the fake answers `echo: <your message>`, so the `-dev` targets
work with plain `curl`. `-- --live` reaches the real integration, which only
resolves on an exe.dev VM it is attached to.
