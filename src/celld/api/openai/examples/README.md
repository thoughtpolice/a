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
| [`threads`](threads.ts) | `GptConversations` and `GptPacer`: replayed reasoning, usage-limit holds |
| [`bridge`](bridge.ts) | `@celld/api/openai/jev`: `routeEffort`, `jevApprover`, `scoreOutput` |
| [`sandbox`](sandbox.ts) | `@celld/api/openai/sandbox` in a real busybox container: staged `apply_patch`, `strings` into `reverseEngineer` (`needs-docker`) |

```sh
buck2 test root//src/celld/api/openai/examples/...
buck2 run root//src/celld/api/openai/examples:chat-dev   # then curl 127.0.0.1:9876
```

Unscripted, the fake answers `echo: <your message>`, so the `-dev` targets
work with plain `curl`. `-- --live` reaches the real integration, which only
resolves on an exe.dev VM it is attached to.
