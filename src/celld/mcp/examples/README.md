<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/mcp examples

Standalone Workers using `@celld/mcp`; see [the convention](../../examples/README.md).
The server examples' specs speak raw JSON-RPC over HTTP, as any MCP client
would: the `_meta` every request carries, the `MCP-Protocol-Version`,
`Mcp-Method` and `Mcp-Name` headers, JSON and server-sent event responses,
and the HTTP statuses. Server-made values (a `requestState`, a `taskId`)
travel between steps through the spec's `save`.

| Example | What it shows |
| --- | --- |
| [`tools`](tools.ts) | a minimal server: `server/discover`, tools with structured output, progress as SSE, a resource template, a prompt, the protocol errors |
| [`approval`](approval.ts) | a multi round-trip request: `input_required`, the sealed `requestState` and what it binds, -32021 without the capability |
| [`tasks`](tasks.ts) | task tools run by the `McpTasks` Durable Object: polling `tasks/get`, `tasks/update`, `tasks/cancel`, `notifications/tasks` on `subscriptions/listen` through `McpChangeHub` |
| [`protected`](protected.ts) | a resource server: `@celld/oauth`'s `ResourceServer` and `jwtAccessTokenVerifier` (RFC 9068), 401 and 403 challenges, Protected Resource Metadata, per-tool scopes, a cached JWKS |
| [`gateway`](gateway.ts) | a Worker as an MCP client: `McpClient` with an `OAuthSession` using client credentials, answering an elicitation for the user |

Two upstreams: [`issuer.ts`](issuer.ts) serves `protected`'s key set (and
mints tokens for `curl`), and [`weather.ts`](weather.ts) is the MCP server
and authorization server `gateway` calls, built with this library and
`@celld/oauth`'s `testAuthorizationServer`.

```sh
buck2 test root//src/celld/mcp/examples/...
buck2 run root//src/celld/mcp/examples:tools-dev   # then POST to 127.0.0.1:9876/mcp
```
