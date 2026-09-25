<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/mcp examples

Standalone Workers using `@celld/mcp`; see [the convention](../../examples/README.md).
The server examples' specs speak raw JSON-RPC over HTTP, as any MCP client
would: the `_meta` every request carries, the `MCP-Protocol-Version`,
`Mcp-Method` and `Mcp-Name` headers, JSON and server-sent event responses,
and the HTTP statuses. Server-made values (a `requestState`, a `taskId`,
an anonymous task's `celld/task-token`) travel between steps through the
spec's `save`.

| Example | What it shows |
| --- | --- |
| [`tools`](tools.ts) | a minimal server: `server/discover`, tools with structured output, progress as SSE, a resource template, a prompt, the protocol errors |
| [`approval`](approval.ts) | a multi round-trip request: `input_required`, the sealed `requestState` and what it binds, -32021 without the capability |
| [`tasks`](tasks.ts) | task tools run by the `McpTasks` Durable Object: polling `tasks/get`, `tasks/update`, `tasks/cancel` with the task's token (the endpoint is anonymous, so the id alone is refused), `notifications/tasks` on `subscriptions/listen` through `McpChangeHub` |
| [`protected`](protected.ts) | a resource server: `@celld/sec/oauth`'s `ResourceServer` and `jwtAccessTokenVerifier` (RFC 9068), 401 and 403 challenges, Protected Resource Metadata, per-tool scopes, a cached JWKS, notes kept per caller (`Principal.key`, so the same subject through another client sees none), capped in size and number |
| [`gateway`](gateway.ts) | a Worker as an MCP client: `McpClient` with an `OAuthSession` using client credentials, answering an elicitation for the user; a capped request body (413, 400), and a 502 that names only the kind of upstream failure |

Only `protected` authenticates its callers. The others are deliberately
unauthenticated, and say so in their source:

`protected` pins the router's canonical public origin to `MCP_RESOURCE`; deploy
it only behind ingress for that origin. Its `IDENTITY_SECRET` must be a stable,
private random secret of at least 32 bytes. Ownership names use a prepared,
domain-separated HMAC over the full verified principal key. The public secret
in its test spec is development-only. Migrating old unkeyed ownership names or
changing this secret requires an explicit storage migration.

- `tools`, `approval` and `tasks` are `{ public: true }` endpoints: anyone
  who can reach one may call every tool (none has `scopes`). `approval`'s
  `requestState` is bound to no caller, so whoever holds it can send the
  second round, and it can be sent again while it lasts. `tasks` lets
  anyone start tasks, each a Durable Object that runs until it ends or is
  cancelled (`soak` until its 10-minute TTL); a task is reachable only with
  the token its creation result carries.
- `gateway`'s own routes (`/forecast`, `/alerts`, `/tools`) have no
  authentication: anyone who can reach it calls the upstream under the
  gateway's client credentials. A deployment puts authentication in front.

`tools` also shows a cross-origin `Origin` refused with 403.

Two upstreams: [`issuer.ts`](issuer.ts) serves `protected`'s key set (and
mints tokens for `curl`), and [`weather.ts`](weather.ts) is the MCP server
and authorization server `gateway` calls, built with this library and
`@celld/sec/oauth`'s `testAuthorizationServer`.

```sh
buck2 test root//src/celld/mcp/examples/...
buck2 run root//src/celld/mcp/examples:tools-dev   # then POST to 127.0.0.1:9876/mcp
```
