<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted and modified from Anthropic claude-plugins-official ab024cdc, mcp-server-dev/build-mcp-server and plugin-dev/mcp-integration, Apache-2.0. -->

# Server and client design

## Tools and protocol lifecycle

Implement initialize/version negotiation, declared capabilities and initialized
notification using the real SDK at the pinned version. Do not invent JSON-RPC
handlers from a scaffold or substitute a health endpoint for a real MCP call.
Stdio reserves stdout for protocol frames and logs to stderr; HTTP handles
session/stream lifecycle, origin checks, deadlines and cancellation. Clean up
transports on shutdown. Bound concurrency, input/output bytes and request time.

Tool names/descriptions identify concrete actions and exclusions. Tight JSON
schemas specify required fields, types, enums, bounds and output contracts.
Separate read from write/delete/billable actions; annotations such as readOnlyHint,
destructiveHint and idempotentHint communicate truth, but do not enforce policy.
Authoritative checks belong in each handler. Large catalogs can expose search
returning IDs/descriptions/schemas, then execute validating the selected operation
and authorization. Preserve deterministic pagination/cursors and actionable
structured errors. Don't force an arbitrary action-count threshold.

Resources identify readable context with URIs/MIME types; static resources and
RFC 6570 templates differ from side-effecting tools. Enforce tenant/path access
on reads, templates, lists and subscriptions. Advertise list/read/subscribe and
change notifications only when implemented. Prompts are user-selected message
templates; string arguments need validation/conversion and prompt generation
must not mutate state. Provide completion only when the server truly supports it.

Server instructions are concise tool-use hints, not authority to override host
policy. Logging redacts sensitive data; progress emits only when the client
provided the progress token. Long work honors AbortSignal. Sampling needs
advertised client support and user permission; unsupported sampling is explicit
unavailability, not invented inference. Roots need advertised support and approved
file URIs; validate every filesystem operation even with roots. Without roots,
require an explicitly configured allowed root rather than all user files.

## Authorization and elicitation

For HTTP validate issuer/signature/expiry **and audience/resource binding**.
Do not pass client bearer tokens through to an unrelated upstream API. Use
separate upstream credentials or an authorized exchange, scope them narrowly,
and isolate per-user/tenant sessions. Session IDs are not authentication.
OAuth requires protected-resource and authorization-server metadata, PKCE,
redirect validation, state/consent and secure refresh/revocation. Use available
SDK/auth provider facilities; audit CIMD fetching for SSRF/origin/size restrictions
and DCR registration abuse. Check actual client support for preregistered clients,
CIMD or DCR rather than promising a universal flow. Store secrets using managed
credential storage, never in project artifacts or chat. Local OAuth needs a real
loopback callback/headless policy and secure credential storage.

Elicitation is server-initiated input, not a tool schema or automatic approval.
Check negotiated form/url support before requesting it. Keep form schemas to
supported flat primitive/enum fields with clear titles/descriptions. Validate
accepted responses; decline/cancel do not authorize a side effect. Never collect
passwords/API keys/tokens in a form. If the host lacks required confirmation,
return a structured confirmation-required result **without executing**; implement
a real separately authorized continuation if requested. Don't suggest retrying
with an answer the tool cannot actually accept. Rich searchable/visual workflows
may need an app, which still cannot replace server authorization.

## OMP client configuration

Native project `.omp/mcp.json`, user active profile's `agent/mcp.json`.
Strict JSON top-level `mcpServers` map; optional `$schema`, `enabledServers` and
`disabledServers` lists. User denylist wins over allowlist. Duplicate names/endpoint
identities have precedence, not a general merge; use `/mcp list` for the winner.

Shared fields: `enabled` boolean, nonnegative `timeout` milliseconds (`0` disables),
`instructions` boolean, `requestIdFormat: number | string`, `auth`, `oauth`.
Stdio requires `command`, optional string `args[]`, `env` string map, `cwd`.
HTTP/SSE require `url`, optional `headers` string map; never command plus URL.
Discovery can infer transport; write explicit `type: stdio | http | sse`.
Timeout env override and print-mode readiness can change startup behavior;
consult `omp://mcp-config.md`, not an assumed fixed delay.

OAuth metadata includes auth `type`, `credentialId`, `tokenUrl`, `clientId`,
`clientSecret`, `resource`; OAuth flow options include `clientId`, `clientSecret`,
`scope`, `redirectUri`, `callbackPort`, `callbackPath`, `prompt`. Profile-scoped
managed credentials are separate from committed definitions. `auth.type: apikey`
does not inject a stored key; use approved env/headers indirection instead.

`${VAR}` / `${VAR:-default}` expansion and bare variable-name / `!command`
resolution are native trust boundaries: command indirection can execute shell
code. The validator never evaluates any of them. Portable Agent Plugins have
different literal secret semantics; do not copy substitutions blindly. Config
review precedes opening an untrusted checkout with credential-bearing profiles.
`instructions: false` can exclude server instructions; it is a recommendation,
not permission to mutate settings/config. OMP built-in browser support can suppress
duplicate browser servers. Do not disable native tools just to force an MCP port.

After authorized connection, `/mcp test <name>` checks actual connectivity;
`/mcp resources`, `/mcp prompts`, `/mcp notifications` inspect other capabilities.
Client support is not evidence that an independently authored server implements
a capability or that OMP supports apps/MCPB deployment.
