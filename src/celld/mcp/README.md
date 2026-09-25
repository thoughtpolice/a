<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/mcp

A client and a server for the Model Context Protocol, revision
[2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), for
celld Workers. That revision is stateless: there is no `initialize` handshake
and no session, every request carries its protocol version and client
capabilities in `_meta`, servers answer `server/discover`, server-to-client
requests travel inside results as multi round-trip requests (MRTR), and
change notifications arrive on `subscriptions/listen` streams.

The library has no npm dependency. It is built on the other celld
libraries:

- [`@celld/sieve`](../sieve/README.md) for tool schemas (the JSON Schema a
  tool advertises and the parser its arguments go through);
- [`@celld/router`](../router/README.md) for the HTTP endpoint, which is a
  route with the router's authentication, limits, security headers and
  error answers;
- [`@celld/oauth`](../oauth/README.md) for authorization on both sides: a
  `ResourceServer` behind the endpoint, and an `OAuthSession` as the
  client's credentials;
- [`@celld/http`](../http/README.md) for server-sent event parsing and
  framing;
- [`@celld/jwt`](../jwt/README.md) for base64url and
  [`@celld/ulid`](../ulid/README.md) for subscription epochs.

```python
celld.worker(
    name = "worker",
    main = "src/index.ts",
    deps = [
        "root//src/celld/mcp:mcp",
        "root//src/celld/oauth:oauth",  # for a ResourceServer or OAuthSession
        "root//src/celld/sieve:sieve",  # for tool schemas
    ],
)
```

A Worker imports `v` from `@celld/sieve`, and the OAuth pieces from
`@celld/oauth`, itself (strict deps): this library does not re-export them.

| Import               | What it has                                                                                                   | Runtime imports      |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------- |
| `@celld/mcp`         | `McpServer`, `mcpRoutes`, `mcpHttpHandler`, `mcpOriginCheck`, `mcpHeader`, `McpClient`, `httpTransport`, protocol types, validation, errors, change sources, tasks (`MemoryTaskStore`, `durableTaskStore`, `TaskHandle`) | none                 |
| `@celld/mcp/durable` | the `McpChangeHub` and `McpTaskObject` Durable Objects                                                        | `cloudflare:workers` |
| `@celld/mcp/testing` | `inProcessTransport`, `handlerFetch`, `testPrincipal`                                                         | none                 |

Only `./durable` imports `cloudflare:workers`, so everything else loads in a
plain `celld.test`. OAuth is `@celld/oauth`'s (see [Authorization](#authorization)).

## A server Worker

```typescript
import {
  type ChangeHubApi,
  durableChangeSource,
  mcpHeader,
  mcpHttpHandler,
  McpServer,
  ToolError,
} from "@celld/mcp";
import { jwtAccessTokenVerifier, ResourceServer } from "@celld/oauth/resource";
import { v } from "@celld/sieve";

export { McpChangeHub } from "@celld/mcp/durable";

interface Env {
  MCP_CHANGES: DurableObjectNamespace<ChangeHubApi>;
  MCP_STATE_SECRET: string;
}

function build(env: Env) {
  const changes = durableChangeSource(env.MCP_CHANGES);
  const server = new McpServer({
    info: { name: "weather", version: "1.0.0" },
    instructions: "Weather lookups by city.",
    stateSecret: env.MCP_STATE_SECRET, // seals MRTR requestState
    changes, // enables subscriptions/listen
    cache: { ttlMs: 300_000, scope: "public" },
  });

  server.tool({
    name: "get_weather",
    description: "Current weather for a city.",
    input: v.strictObject({
      city: v.string().describe("City name"),
      region: mcpHeader(v.string(), "Region"), // mirrored as Mcp-Param-Region
    }),
    output: v.object({ celsius: v.number(), conditions: v.string() }),
    annotations: { readOnlyHint: true },
    run: async ({ city, region }, ctx) => {
      ctx.progress(0.5, { total: 1, message: "asking the upstream API" });
      const found = await lookup(city, region, ctx.signal);
      if (found === null) throw new ToolError(`no weather for ${city}`);
      return { structuredContent: found }; // also sent as a text block
    },
  });

  server.resource({
    uri: "weather://stations",
    name: "stations",
    mimeType: "application/json",
    read: async () => JSON.stringify(await stations()),
  });

  const resource = new ResourceServer({
    resource: "https://weather.example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
    verifier: jwtAccessTokenVerifier({
      issuer: "https://auth.example.com",
      audience: "https://weather.example.com/mcp",
      keys: "https://auth.example.com/jwks",
    }),
  });
  const handler = mcpHttpHandler(server, { path: "/mcp", resource });
  return { handler, changes };
}

let built: ReturnType<typeof build> | null = null;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    built ??= build(env);
    return built.handler(request);
  },
};
```

```python
celld.project(
    name = "project",
    src = ":worker",
    bindings = {"MCP_CHANGES": "McpChangeHub"},
    script_name = "weather-mcp",
)
```

Registration checks what it can up front and throws: tool names (1-128 of
`A-Za-z0-9_.-`), duplicate names, schemas that do not compile or have no
JSON Schema form, invalid `x-mcp-header` annotations, unsupported URI
template syntax.

### Tools

`input` and `output` take a [`@celld/sieve`](../sieve/README.md) schema or
raw JSON Schema.

- A sieve `input` must be an object schema. Its input form
  (`toJSONSchema(schema, { io: "input", $schema: false })`) is the
  advertised `inputSchema`, so pick the object kind by what the tool should
  accept: `v.strictObject` refuses unknown arguments
  (`additionalProperties: false`), `v.looseObject` keeps them, and
  `v.object` accepts and drops them. Arguments are parsed by the schema and
  the handler receives the parsed output, typed (defaults filled in,
  transforms applied).
- A sieve `output`'s output form is the advertised `outputSchema`, and the
  `structuredContent` a handler returns is parsed by it before it is sent.
- `mcpHeader(schema, "Region")` adds `x-mcp-header: Region`, so the client
  mirrors the argument into `Mcp-Param-Region`; only on a string, integer
  or boolean property reachable through `properties`. Never use it for
  secrets: headers are visible to intermediaries.
- Raw JSON Schema is compiled by this library's validator (see
  [JSON Schema support](#json-schema-support)) and advertised as given;
  the handler then gets the arguments unchanged, as
  `Record<string, unknown>`.

Without `input` a tool takes no arguments
(`{"type": "object", "additionalProperties": false}`). A task body
(`task.run`) gets the arguments parsed the same way; the stored task keeps
them as they were sent and parses them again on every run.

A handler returns a string (one text block) or result fields (`content`,
`structuredContent`, `isError`, `_meta`). The server:

- validates arguments against the input schema; a failure is a tool result
  with `isError: true` naming the paths (`a: expected number, received
  string`), so the model can correct itself;
- turns a thrown `ToolError` into an `isError` result with its message;
- turns a thrown `McpError` into that JSON-RPC error;
- turns anything else into an `isError` result saying only that the tool
  failed, and reports the error to `onError` (default `console.error`), so
  internal details do not reach the model;
- checks `structuredContent` against the output schema and the content
  blocks against the protocol; a failure there is a server bug, answered
  -32603.

`visible(info)` hides a tool, resource, template or prompt per request (by
`info.principal`, say); hidden entries are absent from lists and unknown to
calls. `requires` names client capabilities an entry needs; a request without
them gets -32021.

Lists come back sorted (tools and prompts by name, resources by URI,
templates by URI template), so the order is deterministic across requests and
isolates, and paginated at `pageSize` (default 100) with keyset cursors that
survive insertions.

### Resources, prompts, completion

`server.resource({ uri, read })` serves one URI; `read` returns text, bytes
(sent as `blob`), content items, or `{ contents, ttlMs, cacheScope }`.
`server.resourceTemplate({ uriTemplate, read })` serves a family:
`{var}` matches one path segment, `{+var}` anything, and values are
percent-decoded. A `read` returning `null` means "no such resource", which is
-32602 with `data.uri` (never -32002, never empty contents).

`server.prompt({ name, arguments, get })` checks required arguments (-32602)
before `get` runs. Prompts and templates take `complete: { arg: fn }`; the
server then advertises `completions` and answers `completion/complete`,
capping values at 100 with `total` and `hasMore`.

### Multi round-trip requests

Handlers of `tools/call`, `prompts/get` and `resources/read` ask the client
for input through their context:

```typescript
server.tool({
  name: "deploy",
  run: (_args, ctx) => {
    const answer = ctx.elicit("confirm", {
      mode: "form",
      message: "Deploy to production?",
      requestedSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    });
    if (answer.action !== "accept") return "not deployed";
    return deploy(answer.content!.reason as string);
  },
});
```

`ctx.elicit(key, params)` returns the client's answer when this retry carries
one. Otherwise it ends the round: the server answers `input_required` with the
request under `key` and a sealed `requestState`, and when the client retries,
the handler runs again from the top and this time gets the answer. Handlers
therefore need to be safe to re-run up to the point where they ask. The other
helpers:

- `ctx.ask({ a: elicitForm(...), b: listRoots() })` asks several questions in
  one round and returns all the answers once they are all in;
- `ctx.elicit(key, elicitUrl(message, url).params)` for URL mode, where
  `accept` only means the user agreed to go; the handler decides from its own
  records whether the interaction finished, and calls `ctx.inputRequired()`
  to have the client retry until it has;
- `ctx.state` and `ctx.setState(value)` carry the handler's own data between
  rounds;
- `ctx.inputRequired({ requests?, state? })` ends a round explicitly (with
  only a state, it is the spec's load-shedding shape);
- `ctx.sample(key, params)` and `ctx.roots(key)` for the deprecated sampling
  and roots features.

Each helper checks the client's declared capabilities first (an elicitation
needs `elicitation` with the right mode, where an empty object means form;
sampling with tools needs `sampling.tools`) and throws -32021 if they are
missing. A submitted form is checked against its `requestedSchema` (-32602).

`requestState` is AES-256-GCM under a key derived from `stateSecret`, so the
client can neither read nor change it. Inside, as the spec advises, it binds
the method and a digest of the request's params (everything but `_meta`,
`inputResponses` and `requestState`), the principal's `subject`, an expiry
(`stateTtlMs`, default 10 minutes), the keys it asked for, the answers from
earlier rounds (the client only resends the latest round), and the handler's
state. A state that fails any check is -32602 `Invalid requestState` (or
`Expired requestState`). Answers to keys that were not asked, and answers
sent without a `requestState`, are ignored. This bounds replay but does not
make a state single-use; a handler that must consume something at most once
has to record that itself. Every instance of a server must share the secret.

### Progress, logging and cancellation

`ctx.progress(value, { total, message })` sends `notifications/progress` only
if the request carried a `progressToken`, only when the value increases, and
never after the handler returns. `ctx.log(level, data, logger)` sends
`notifications/message` only if the server enables the (deprecated) logging
feature with `logging: true` and the request set
`io.modelcontextprotocol/logLevel` at or below `level`.

`ctx.signal` fires when the client closes the response stream, which is how
Streamable HTTP cancels. After that nothing more is sent for the request.

### Subscriptions

A `subscriptions/listen` request gets an SSE stream that starts with
`notifications/subscriptions/acknowledged`, listing the subset of the filter
the server honours, and then carries only the notification types the client
opted in to, each tagged with `io.modelcontextprotocol/subscriptionId` (the
listen request's id). The server attaches to its change source before the
acknowledgement, so a change published after the client sees the
acknowledgement is always delivered. With `listenLifetimeMs` the server ends
streams gracefully with a result tagged the same way.

Changes come from a `ChangeSource`. `MemoryChangeSource` works within one
isolate. Workers do not share memory, so across a deployment use the
`McpChangeHub` Durable Object: `durableChangeSource(namespace)` returns a
source (each listen stream long-polls the hub's sequence-numbered log over
RPC) and a publisher (`await changes.publish({ type: "tools" })` from any
request). The hub keeps its log in memory; if it restarts, pollers see a new
epoch and each stream tells its client that everything it watches may have
changed. Change events are `tools`, `prompts`, `resources`,
`{ type: "resource", uri }` and `reset`.

### Tasks

The tasks extension ([`io.modelcontextprotocol/tasks`](#specifications))
lets a tool answer `tools/call` with a task handle instead of its result; the
client polls `tasks/get`, answers the task's input requests with
`tasks/update`, and may send `tasks/cancel`. Enable it with a store, and give
tools a `task`:

```typescript
import { durableTaskStore, McpServer, s, type TaskObjectApi } from "@celld/mcp";
import { McpTaskObject } from "@celld/mcp/durable";

interface Env {
  MCP_TASKS: DurableObjectNamespace<TaskObjectApi>;
}

function build(env: Env) {
  const server = new McpServer({
    info,
    tasks: { store: durableTaskStore(env.MCP_TASKS), ttlMs: 3_600_000 },
  });
  server.tool({
    name: "deploy",
    input: v.strictObject({ service: v.string() }),
    task: {
      pollIntervalMs: 2000,
      run: async ({ service }, ctx) => {
        await ctx.status(`building ${service}`);
        const image = (ctx.state as string | null) ?? await buildImage(service);
        await ctx.save(image); // survives the next run
        const answer = ctx.elicit("confirm", {
          mode: "form",
          message: `Roll out ${image}?`,
          requestedSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        });
        if (answer.content?.ok !== true) return "not deployed";
        await rollOut(image, ctx.signal); // aborts on tasks/cancel
        return `deployed ${image}`;
      },
    },
  });
  return { server };
}

// One Durable Object per task runs the bodies:
export class McpTasks extends McpTaskObject<Env> {
  taskServer() {
    return build(this.env).server; // build once and cache in a real Worker
  }
}
```

```python
celld.project(..., bindings = {"MCP_TASKS": "McpTasks"})
```

- **Who decides.** The server does, per request. A tool with only `task`
  always runs as a task; a tool with `run` and `task` runs synchronously and
  may call `ctx.task({ state, statusMessage, ttlMs, pollIntervalMs })` to
  continue as one, after any multi round-trip input (the extension advises
  resolving that first). A task needs the client to have declared the
  extension on that request; otherwise `ctx.task()` and task-only tools
  answer -32021 naming it, as the extension requires. The capability is
  advertised through `server/discover`'s `extensions`.
- **Creating.** The server stores the task before answering: the
  `CreateTaskResult` carries `resultType: "task"`, the id, `working`, ISO
  timestamps, `ttlMs` (default one hour, `null` for unlimited) and
  `pollIntervalMs` (default 1000).
- **Ids and callers.** A task id is 144 random bits. Each task is bound to
  the `subject` of the principal that created it; `tasks/get`, `tasks/update`
  and `tasks/cancel` from anyone else get the same -32602 "Task not found" as
  an unknown id, so ids leak nothing. All three need the extension (-32021)
  and, on HTTP, `Mcp-Name` set to the task id (-32020 otherwise).
- **The body** gets a `TaskContext`: the arguments, `principal`, the
  creating request's capabilities, `signal` (cancellation or expiry),
  `status(message)`, `state`/`save(state)`, and the same input helpers as
  handlers (`elicit`, `ask`, `input`, `inputRequired`, and the deprecated
  `sample` and `roots`). It returns what a tool returns; the result, checked
  like a synchronous one, becomes the completed task's `result`. A thrown
  `ToolError` or any other non-JSON-RPC failure completes the task with
  `isError: true`; a JSON-RPC `McpError` (or an output schema violation,
  -32603) fails it with that `error`.
- **Input.** When the body asks for input it ends its run; the task becomes
  `input_required` with every outstanding request in `inputRequests`, the
  same requests on every poll. `tasks/update` answers are checked against the
  request (and a form against its `requestedSchema`, -32602); answers to keys
  not outstanding are ignored. Once none is outstanding, the body runs again
  from the top and finds its answers, like a multi round-trip handler. Keys
  are never reused within a task. `ctx.inputRequired()` without requests
  yields: the body runs again after the poll interval, which lets long work
  proceed in checkpointed steps.
- **Cancelling** makes the task `cancelled` at once (terminal) and aborts the
  body's signal; whatever the body returns afterwards is dropped. A terminal
  task ignores it.
- **Expiry.** After `ttlMs` from creation a task is deleted; the first
  `tasks/get` after that says "Task has expired", later ones "Task not
  found".
- **Notifications.** A `subscriptions/listen` filter may name `taskIds`
  (needs the extension, -32021). The server honours the caller's own live
  tasks, sends each one's current state right after the acknowledgement,
  then a `notifications/tasks` (the full `tasks/get` answer) on every change.
  It needs a `changes` source that can also publish, such as
  `durableChangeSource`.

Where the work runs: `MemoryTaskStore` keeps tasks in the isolate and runs
bodies on timers there, for tests and single processes. `durableTaskStore`
makes each task a `McpTaskObject` Durable Object named by its id, so every
isolate reaches the same task. Creating one writes the record to the
object's SQLite storage, sets an alarm for now and waits for `sync()`
before the server answers. The alarm handler runs the body inside the
object, independent of the request that created it; polls, updates and
cancels are RPCs that interleave with it, and status changes are visible
immediately. When an update answers the last outstanding request, the object
sets its alarm again; at the TTL, the alarm deletes the task. Alarms are
delivered at least once: one that throws or whose object is evicted mid-run
is retried, so a body may run again from the top with the state it last
saved. Bodies must therefore be safe to repeat, as with multi round-trip
handlers, and `ctx.save` is the checkpoint.

### The HTTP endpoint

The Streamable HTTP endpoint is a [`@celld/router`](../router/README.md)
route. `mcpRoutes(app, path, server, options)` adds `POST path` to an
application's own router, next to its other routes and under its auth:

```typescript
import { mcpRoutes } from "@celld/mcp";
import { oauthSchemes, protectedResourceRoutes } from "@celld/oauth/router";
import { router } from "@celld/router";

const app = router<Env>({ auth: oauthSchemes(resource) });
protectedResourceRoutes(app, resource); // RFC 9728 metadata, public
app.get("/health", { public: true }, (c) => c.json({ ok: true }));
mcpRoutes(app, "/mcp", server, { allowedOrigins: ["https://app.example.com"] });
export default { fetch: app.fetch };
```

`mcpHttpHandler(server, { path, auth, resource, ...options })` is the same
over a private router, for a Worker that serves nothing else: `auth` is
router schemes or `"none"`, by default `oauthSchemes(resource)` when a
`resource` is given (and `"none"` otherwise); with a `resource` it also
serves the metadata at `/.well-known/oauth-protected-resource{path}` and at
the origin's `/.well-known/oauth-protected-resource`. Without `path` every
path is the endpoint. It returns `(request, env?, ctx?) => Promise<Response>`.

| Check                                                               | Failure                               |
| ------------------------------------------------------------------- | ------------------------------------- |
| `Origin` present and not in `allowedOrigins` (`mcpHttpHandler`: before anything else) | 403, -32600          |
| path                                                                | the router's 404                      |
| method is POST                                                      | the router's 405, `Allow: OPTIONS, POST`; `OPTIONS` is 204 |
| declared `Content-Length` over `maxBodyBytes` (default 4 MiB)       | the router's 413                      |
| authentication (the route needs a principal unless `public`)        | 401 with every scheme's challenge, or the scheme's 400/401 for a bad credential |
| `Origin` (for `mcpRoutes`)                                          | 403, -32600                           |
| `Content-Type: application/json`                                    | 415, -32600                           |
| body size while reading, and UTF-8                                  | 413, -32600; 400, -32700              |
| JSON, then one JSON-RPC request or notification                     | 400, -32700 or -32600                 |
| `Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version` present and match  | 400, -32020                           |
| `_meta` has the version and capabilities                            | 400, -32602                           |
| version supported                                                   | 400, -32022 with `supported`          |
| method known and the feature present                                | 404, -32601                           |
| params                                                              | 400, -32602                           |
| `Mcp-Param-*` match the tool's `x-mcp-header` arguments             | 400, -32020                           |
| the tool's `scopes`                                                 | 403 `insufficient_scope`              |
| client capabilities a handler needs                                 | 400, -32021                           |

The router's own answers (404, 405, 401, 413 before reading, 503) have its
JSON error body (`{ "error", "message", "requestId" }`); the endpoint's have
a JSON-RPC one. Every answer gets the router's security headers and
`X-Request-Id`, and `Cache-Control: no-store` when authenticated.

Notifications get 202. Errors raised while a request runs (unknown tool,
missing resource, invalid `requestState`) are JSON-RPC errors with status
200. A request is answered with one JSON response unless the handler emits a
notification before it finishes; then the response becomes an SSE stream
(`X-Accel-Buffering: no`, a `:` keep-alive comment every `keepAliveMs`,
default 15 s) carrying the notifications and the final response.
`subscriptions/listen` is always a stream and needs
`Accept: text/event-stream` (406 otherwise). `Mcp-Session-Id` and
`Last-Event-ID` are ignored and never sent.

The request's signal (`c.signal`) aborts when the client goes away, and
closing a stream aborts it too; either cancels the handler (`ctx.signal`),
and a request cancelled before its answer gets 499. `timeout` (seconds or
an ISO 8601 duration; default none) is the route's time budget until a
response starts: when it runs out the router answers 503 and the handler's
signal aborts. A stream, once started, is never cut off.

A tool's `scopes` are checked once the tool is known: a principal without
all of them makes the route throw
`AuthError("insufficient_scope", "Missing scopes: ...", { scope })`, whose
`scope` names every scope the call needs (the spec asks for one challenge
per operation). The router answers 403 with the challenge of the scheme
that authenticated the request, `resource_metadata` included:
`Bearer error="insufficient_scope", error_description="Missing scopes: notes:write", scope="notes:write", resource_metadata="..."`.
An anonymous caller (a `public` route) gets every scheme's challenge, and
with `auth: "none"` there is no challenge, just the 403: a tool with
`scopes` is never served without a principal that has them.
`scopeSatisfied(granted, scope)` supplies scope hierarchies (a broader scope
implying narrower ones); the default is exact membership.

The principal (`@celld/router`'s: `subject`, `scopes`, `claims`,
`clientId`, ...) reaches handlers as `ctx.principal`, binds `requestState`
and owns tasks. Handlers never see the credential.

The route checks `Origin` before authentication (a router `before` hook),
so on an application's router with auth a cross-origin request without
credentials gets the 403, not a 401. `app.use(mcpOriginCheck(allowedOrigins))`
extends the check to every path of the router (requests under
`/.well-known/` pass).

## A client

```typescript
import { McpClient, memoryCache } from "@celld/mcp";

const client = McpClient.http("https://weather.example.com/mcp", {
  info: { name: "my-agent", version: "1.0.0" },
  headers: async () => ({ authorization: `Bearer ${await token()}` }),
  handlers: {
    elicitation: async (params, { key, signal }) => await askUser(params),
    elicitationModes: ["form", "url"],
  },
  cache: memoryCache(),
  cacheContext: userId, // allows caching "private" results for this user
});

const { supportedVersions, capabilities } = await client.discover();
const tools = await client.listAllTools();
const result = await client.callTool("get_weather", {
  city: "Oslo",
  region: "eu",
}, {
  onProgress: (p) => console.log(p.progress, p.total),
  signal: AbortSignal.timeout(30_000),
});
if (result.isError) console.log("tool error", result.content);
```

Every request carries `io.modelcontextprotocol/protocolVersion`,
`clientCapabilities` (derived from the handlers plus `capabilities`) and
`clientInfo`, and on HTTP the `MCP-Protocol-Version`, `Mcp-Method` and
`Mcp-Name` headers (base64 sentinel-encoded when needed). Other behaviour:

- **Versions.** `discover()` switches to the first of `versions` the server
  lists. Without it, an -32022 on any call switches to a mutually supported
  version and retries once; none in common is an `unsupported_version` error.
- **Tools and headers.** `listTools()` drops tools whose `x-mcp-header`
  annotations break the spec's rules (warning through `onWarning`) and
  remembers the rest, so `callTool` can mirror annotated arguments into
  `Mcp-Param-*` headers. If the server still answers -32020, the client
  refreshes the tool list and retries once. `structuredContent` is checked
  against a known `outputSchema` (`validateToolOutput`, default on).
- **MRTR.** `callTool`, `getPrompt` and `readResource` answer
  `input_required` results through the handlers and retry with
  `inputResponses` and the exact `requestState` (and without one when the
  server sent none), each time under a new request id, up to
  `maxInputRounds` (default 8). A form answer is checked against the
  requested schema before it is sent. A request the client has no handler
  for is an `input_unhandled` error.
- **Results.** A result without `resultType` (a pre-2026-07-28 server) is
  complete; an unknown `resultType`, `input_required` from a method that may
  not send it, or a malformed result is a `decode` error.
- **Streams.** A response stream that ends without its response is re-issued
  under a new id (`reissueOnBrokenStream`, default once); a JSON-RPC request
  from the server is a `decode` error.
- **Timeouts and cancellation.** `timeoutMs` (default 60 s) per round,
  restarted by each progress notification, and capped at `maxTimeoutMs`
  (default 10 minutes). A caller's `signal` aborts the fetch, which closes
  the stream and cancels the request on the server.
- **Caching.** With `cache`, complete results of `server/discover`, the list
  methods and `resources/read` with `ttlMs > 0` are kept until they go stale.
  Keys are the method plus every param but `_meta`; `public` results are
  shared, `private` ones are kept only under `cacheContext` and never shared
  across contexts; MRTR retries are never cached; `{ fresh: true }` skips the
  lookup. List-changed and resource-updated notifications from `listen`
  invalidate the matching entries.
- **Subscriptions.** `client.listen(filter)` returns an async iterable of
  notifications with `acknowledged` (the honoured filter), `close()` and
  `endedGracefully`. Iteration ends when the server closes the subscription
  or the caller does, and throws when the stream drops; reconnecting is the
  caller's choice.
- **Tasks.** With `tasks: true` (or options), the client declares the
  extension and `callTool` follows a task handle to its end: it polls
  `tasks/get` no faster than the task's `pollIntervalMs` (without one,
  `initialPollMs`, default 500), backing off to `maxPollMs` (default 10 s)
  while nothing changes; answers each new input request once through the
  handlers (`InputContext.taskId` says which task) and sends the answers with
  `tasks/update`; retries transient poll failures (`maxPollErrors`); and
  returns the result. A failed task throws its JSON-RPC error (`rpc`), a
  cancelled one `task_cancelled`, and aborting the call cancels the task.
  `onTask` receives the `TaskHandle` first (to persist `taskId`),
  `onTaskStatus` each new state. `startToolCall` returns
  `{ type: "complete", result }` or `{ type: "task", task }` without
  waiting; `client.task(taskId, name)` resumes a stored id. A handle has
  `get()`, `update(responses)`, `cancel()`, `result(options)` and
  `tryResult()`. With `notifications: true` the client also listens for
  `notifications/tasks` while waiting, so a change arrives without waiting
  for the next poll. A task result from anything but `tools/call`, or when
  the client did not declare the extension, is a `decode` error.
- **Errors.** Everything throws `McpError` with a `kind` (`rpc`, `http`,
  `unauthorized`, `connection`, `stream`, `decode`, `timeout`, `aborted`,
  `unsupported_version`, `input_unhandled`, `input_rounds`,
  `invalid_request`, `task_cancelled`), the JSON-RPC `code` and `data`, the HTTP `status`, the
  `method`, `wwwAuthenticate` on 401/403, and getters for `retryable`,
  `supportedVersions`, `requiredCapabilities` and `resourceNotFound` (which
  also accepts the -32002 of older servers). `toJSON()` and
  `mcpErrorFromData` carry it across RPC; `attempt(() => ...)` returns
  `{ ok, result }` or `{ ok: false, error }`.

`client.request(method, params)` sends any other method (an extension's,
say) with the same `_meta`, headers and error handling.

`auth` (on `McpClient.http` or `httpTransport`) takes an `HttpAuthProvider`,
the shape of `@celld/oauth`'s `OAuthSession`, which is one as it is:
`headers({ method, url })` supplies credentials for each request
(overriding `headers`); `observe({ url, headers })`, if present, sees every
other response (a resource may rotate its `DPoP-Nonce` on a 200); and
`challenge({ status, headers, method, url, attempt, signal })` answers a
401 or 403 by resolving true once new credentials are ready, and the
request is sent again, at most `maxAuthAttempts` (default 3) times. False,
or a rejection, fails the request as `unauthorized` (with the rejection as
`cause` and its `toJSON()` as `data`). Anything else that authenticates
HTTP requests can be another.

## Authorization

Authorization is [`@celld/oauth`](../oauth/README.md)'s on both sides; this
library adds what is MCP's: per-tool scopes, the client credentials
extension's id, and the transport's `HttpAuthProvider` seam.

### Resource server

```typescript
import { mcpHttpHandler } from "@celld/mcp";
import { jwtAccessTokenVerifier, ResourceServer } from "@celld/oauth/resource";

const resource = new ResourceServer({
  resource: "https://weather.example.com/mcp", // the canonical URI
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["weather:read"],
  verifier: jwtAccessTokenVerifier({
    issuer: "https://auth.example.com",
    audience: "https://weather.example.com/mcp",
    keys: "https://auth.example.com/.well-known/jwks.json",
  }),
  dpop: false, // Bearer only; leave it out to take DPoP-bound tokens too
});
const handler = mcpHttpHandler(server, { path: "/mcp", resource });
server.tool({ name: "set_alert", scopes: ["weather:write"], run: ... });
```

Behind the endpoint, `oauthSchemes(resource)` from `@celld/oauth/router`
authenticates requests: Bearer and, unless `dpop: false`, DPoP (RFC 9449),
with the challenges the resource server writes (`realm`, `algs` and
`resource_metadata`, which names the metadata document at the resource's
public URL, not the address the Worker is reached at). What to know:

- **RFC 9068 strictly.** `jwtAccessTokenVerifier` wants `typ` `at+jwt` and
  `iss`, `exp`, `aud` (naming this resource), `sub`, `client_id`, `iat` and
  `jti`; `strict: false` accepts plain JWTs with `iss`, `aud` and `exp`
  from issuers that predate the profile. `introspectionVerifier` asks the
  authorization server instead (RFC 7662).
- **Algorithms.** The default list (`DEFAULT_ACCESS_TOKEN_ALGORITHMS`) is
  RSA, RSA-PSS and ECDSA. EdDSA is left out, since celld's WebCrypto cannot
  verify Ed25519; list it in `algorithms` where the runtime can. A token
  signed with an algorithm the runtime cannot verify is a 500 (`JwtError`
  `runtime_unsupported`), not a refused token.
- **DPoP in challenges.** A resource server takes DPoP unless `dpop: false`,
  and then every 401 challenges both schemes:
  `DPoP algs="ES256 ...", resource_metadata="...", Bearer resource_metadata="..."`.
  A refusal names only the scheme the request used. Choose explicitly.
- **Metadata.** The document (RFC 9728, with
  `bearer_methods_supported: ["header"]`) is served by `mcpHttpHandler`, or
  by `protectedResourceRoutes(app, resource)` on an application's router.
  Put extra members (`resource_name`) in `metadata`.
- **Invalid, expired and foreign tokens** are 401 `invalid_token`, a
  malformed `Authorization` 400 `invalid_request`, and an unreachable key
  set or introspection endpoint 503; a tool's missing scopes are 403
  `insufficient_scope` (see [The HTTP endpoint](#the-http-endpoint)).
- **No token passthrough.** `ctx.principal` has the subject, scopes, client
  id and claims only, so a handler cannot pass the token on to an upstream
  API (the spec forbids it; a server calling upstreams gets its own tokens
  for them).
- **Other credentials.** Any `@celld/router` scheme works: `bearer({ verify
  })` with a verifier of your own, `apiKey`, or an `AuthScheme` reading
  identity headers a trusted proxy adds. A `ResourceServer` with a custom
  `AccessTokenVerifier` keeps the metadata and challenges for tokens that
  are not JWTs.

### Client

```typescript
import { McpClient } from "@celld/mcp";
import { OAuthSession } from "@celld/oauth/client";
import { DpopKey } from "@celld/oauth/dpop";

const auth = new OAuthSession({
  resource: "https://weather.example.com/mcp",
  redirectUri: "http://127.0.0.1:8765/callback",
  registration: {
    metadataDocument: "https://agent.example.com/oauth/client.json",
    dynamic: { client_name: "My agent" }, // the deprecated fallback
  },
  userAgent, // opens the URL, returns the callback URL
  store, // your encrypted OAuthStore; default in memory
  dpop: await DpopKey.generate(), // optional: sender-constrained tokens
});
const client = McpClient.http("https://weather.example.com/mcp", { info, auth });
```

`OAuthSession` is the transport's `HttpAuthProvider` as it is. On a 401 it
discovers the Protected Resource Metadata (the challenge's
`resource_metadata`, else the well-known URLs; the document's `resource`
must be the endpoint or an ancestor path on its origin) and the
authorization server's metadata (RFC 8414, then OpenID Connect's
locations), refuses a server without PKCE S256, gets a client id
(pre-registered, a Client ID Metadata Document, a stored registration, then
Dynamic Client Registration), and sends the user through the
`OAuthUserAgent` (PKCE, `state`, `resource`, `iss` checked per RFC 9207,
pushed authorization requests when offered). Tokens are kept per issuer and
resource and refreshed before they expire; a 401 for a token that was sent
refreshes once, then starts over; a 403 `insufficient_scope` (a tool's
`scopes`) re-authorizes with the union of the scopes so far and the
challenge's, once per scope set. With a `dpop` key, tokens are bound to it,
and the nonces the endpoint rotates on its answers are taken up through
`observe`. Failures are `OAuthError`s, which reach MCP callers as the
`cause` of an `unauthorized` McpError.

A host whose callback is another request (a Worker) calls
`beginAuthorization()`, keeps the returned `PendingAuthorization` (plain
data, private: it holds the PKCE verifier), and passes the callback URL to
`completeAuthorization(pending, url)`.

With `clientCredentials: { issuer, clientId, clientSecret }` (or
`privateKey`, `alg` and `kid` for `private_key_jwt`), the session uses the
client credentials grant instead of a user, only ever with the issuer
named. That is the `io.modelcontextprotocol/oauth-client-credentials`
extension: declare `OAUTH_CLIENT_CREDENTIALS_EXTENSION` in the MCP
client's `capabilities.extensions`.

### Testing

`@celld/oauth/testing` has `testAuthorizationServer` (an in-memory
`AuthorizationServer` with a fresh key and consent that grants at once, or
as a test decides), `testUserAgent` (follows the authorization redirects)
and `routeFetch` (a `fetch` per origin). The server has no switches to
misbehave: a wrong `issuer`, a missing `iss` or no S256 are tested in
`@celld/oauth` itself, and a test that needs one from an MCP client wraps
`routeFetch` to rewrite the answer. `testPrincipal(subject, { scopes })` from
`@celld/mcp/testing` builds a principal for requests handed to a server
directly, with `@celld/router`'s `toPrincipal`, as the router would.

## Testing

```typescript
import { handlerFetch, inProcessTransport } from "@celld/mcp/testing";

// Protocol only, no HTTP:
const direct = new McpClient({ transport: inProcessTransport(server), info });
// The full Streamable HTTP rules, in process:
const http = McpClient.http("https://mcp.test/mcp", {
  info,
  fetch: handlerFetch(mcpHttpHandler(server, { path: "/mcp" })),
});
```

`inProcessTransport` copies messages through JSON both ways, so a value that
would not survive the wire does not survive in tests either.

The package's own tests: one Deno suite per concern (`framing`, `server`,
`headers`, `http`, `mrtr`, `subscriptions`, `progress`, `cancellation`,
`client`, `cache`, `jsonschema`, `tasks`, `tasks_client`, `oauth_client`,
`oauth_server`), and `:runtime-test`, which runs `tests/runtime/worker.ts` under `celld dev` and
drives it from Python as a raw HTTP client: header validation and statuses,
JSON and SSE framing, `server/discover`, tool calls with `Mcp-Param-*`, an
MRTR round trip with a tampered state, a listen stream fed through
`McpChangeHub`, cancellation by closing a stream, tasks stored and run by
`McpTaskObject` (input through `tasks/update`, another caller refused,
cancellation, `notifications/tasks`), OAuth challenges and metadata (also
behind a proxy's `X-Forwarded-*`) with `@celld/oauth`'s authorization
server in memory, and the TypeScript client, with an `OAuthSession`,
calling the Worker over real fetch, including a task with input and an
authorization with a step-up.

```sh
buck2 test root//src/celld/mcp/...
```

### Live test

`:live-run` runs the runtime-test project on an exe.dev VM and drives it
over the network. Nothing runs it automatically.

```sh
buck2 run root//src/celld/mcp:live-run -- celld-mcp-test.exe.xyz [--token-file F] [--port N]
```

It installs, under `~/.cache/celld-live` on the VM, the toolchain's pinned
celld release for the VM's architecture (copied from this machine, checked
by digest) and Deno (pinned by `buck/bin/deno`); refuses to start if
anything listens on the port (default 8000, the VM's proxy port); starts
`celld dev` there in its own process group; and runs:

1. `tests/live/client.ts` (the `:live-client` bundle) from this machine
   against `https://<vm>.exe.xyz`, through exe.dev's HTTPS proxy, with a
   VM-scoped token in `X-Exedev-Authorization` (the proxy consumes it, so
   MCP's own `Authorization` passes through untouched). The token comes from
   `--token-file`, `$EXEDEV_TOKEN`, or is minted with
   `ssh exe.dev ssh-key generate-api-key --vm=<vm> --label=mcp-live --exp=1d`,
   and is never printed;
2. the same client on the VM against `http://127.0.0.1:<port>`;
3. `tests/live/sdk_interop.ts` on the VM: the official
   `@modelcontextprotocol/client` (2.1.0 by default, `--sdk-version`),
   through Deno's `npm:` support with its cache in
   `~/.cache/celld-live/deno-dir`, pinned to protocol 2026-07-28.

The client checks discovery, tools (structured output, `Mcp-Param-*`), an
MRTR elicitation, progress over SSE, resources, a listen stream through
`McpChangeHub`, tasks run by `McpTaskObject` (input through `tasks/update`,
cancellation, `notifications/tasks`), bearer refusals, and the OAuth flow
against the Worker's in-memory authorization server (which, like the metadata,
names the public origin the proxy reports in `X-Forwarded-*`), including a
step-up and a tampered token. Afterwards the server is stopped and its run
directory removed; the installed tools stay cached. The report is JSON on
stdout; the exit status is 0 only if every run passed and the port is free
again.

## Examples

[`examples/`](examples/README.md) has standalone Workers, each tested under
`celld dev` by a spec of raw HTTP requests: a minimal server, a multi
round-trip request, tasks on their Durable Object with a listen stream, an
OAuth resource server, and a Worker calling another MCP server as a client
with client credentials.

```sh
buck2 test root//src/celld/mcp/examples/...
```

## Protocol decisions

Where the spec leaves room or disagrees with itself, this is what the library
does.

- **Unsupported versions include `server/discover`.** The version check
  applies to every request, discovery too; the error lists the supported
  versions either way.
- **HTTP statuses.** The spec fixes 400 for -32020, -32021, -32022 and
  malformed `_meta`, and 404 for -32601. Other request validation failures
  (bad params) are 400 as well. Errors raised while running a request
  (unknown tool, missing resource, bad `requestState`) are 200, as a JSON-RPC
  error is a normal answer; -32021 stays 400 wherever it is raised.
- **JSON or SSE.** The server picks per request: JSON unless a notification
  is emitted before the result. A client that does not accept
  `text/event-stream` gets JSON and no notifications.
- **Tool input validation.** The schema's `InvalidParamsError` examples list
  "invalid tool arguments", but the tools page lists input validation errors
  as tool execution errors. Arguments that fail the schema are an `isError`
  result, so the model can correct them; an unknown tool is -32602.
- **Origin.** The spec requires validating `Origin` without saying against
  what. Checking it against `Host` does not stop DNS rebinding (the attacker
  controls both), so by default any `Origin` is refused and browsers must be
  allowed explicitly with `allowedOrigins`.
- **Header checks for notifications.** The spec defines no header
  requirements for notification POSTs, so none are checked; every valid
  notification gets 202, since no client notification has an effect on this
  transport.
- **`Mcp-Param-*` without an argument.** A header present for an argument
  that is absent or null is a mismatch (-32020); the spec only says the
  client must omit it.
- **Ending a subscription.** The cancellation page says a server tearing
  down a subscription MUST send `notifications/cancelled`; the subscriptions
  page says it SHOULD send a successful listen result. On HTTP the server
  sends the result and closes the stream; `notifications/cancelled` is left
  to stdio, where the schema scopes it.
- **Tasks: `tasks/get`'s `resultType`.** The extension says it MUST be
  `complete`, but its "task with JSON-RPC execution error" example shows
  `task`. The server sends `complete`; the client accepts either.
- **Tasks: what a body's failure is.** A thrown `ToolError`, or any error
  that is not a JSON-RPC one, completes the task with `isError: true`, as
  the synchronous path does; the extension forbids `failed` for non-JSON-RPC
  errors. A thrown `McpError` and an output that fails the tool's schema
  (a server bug, -32603 on the synchronous path) fail it.
- **Tasks: cancellation is immediate.** The extension lets a server keep a
  cancelled task working or finish it another way. This server marks it
  `cancelled` at once and drops the body's outcome, so the state machine
  never goes back from a client's cancel; the body only learns through its
  signal.
- **Tasks: expiry.** The extension allows marking an expired task `failed`
  before deleting it; this server deletes it at the TTL, which it also
  allows ("Task has expired" once, then "Task not found").
- **Tasks: other callers.** Tasks are bound to the principal's `subject`,
  and a foreign or unknown id get the same error. Without authentication
  (no principal) every task has the same owner, and the id is the only
  secret, which the extension permits.
- **Tasks: input validation.** `tasks/update` checks answers when they
  arrive (shape, and forms against their schema) and refuses the whole
  update with -32602 on a bad one, rather than letting the body fail later.
- **Tasks: listen snapshots.** The extension does not say whether a new
  listen stream gets the current state of the tasks it names. The server
  sends it right after the acknowledgement, so a task that finished before
  the subscription is not waited on forever.
- **OAuth: which `resource` a metadata document may name.** RFC 9728 wants
  it identical to the URL the metadata was derived from, while the MCP spec
  allows a less specific canonical URI (`https://mcp.example.com` for
  `https://mcp.example.com/mcp`). `OAuthSession` accepts the endpoint itself or
  an ancestor path on the same origin, and nothing else, and sends the
  document's value, as given, as `resource`.
- **OAuth: a metadata document with the wrong `issuer`.** It is never used;
  the client goes on to the next well-known URL rather than failing at
  once, and fails only if none is usable.
- **OAuth: step-up limits.** "No more than a few times" is one step-up per
  distinct scope set; a 401 is answered once per request, at most
  `maxAuthAttempts` in all.
- **OAuth: the client credentials extension's metadata.** It requires
  `private_key_jwt` or `client_secret_basic` in
  `token_endpoint_auth_methods_supported`, but its example sends the secret
  in the body. The client uses `client_secret_basic` when listed, else
  `client_secret_post`, and treats an absent list as RFC 8414's default,
  `client_secret_basic`.
- **Resource subscriptions** match URIs exactly. The spec allows updates for
  sub-resources of a subscribed URI but does not define "sub-resource".
- **Unsupported listen filters.** When no type in the filter can be honoured,
  the server acknowledges `{}` and ends the stream at once with the graceful
  result, rather than holding an idle stream open.
- **Tool errors that are not `ToolError`** do not show their message, which
  may carry internal details; the handler decides what the model sees.
- **Tool names** follow the spec's SHOULD rules strictly at registration.
- **Output schemas on the client.** A tool whose `outputSchema` this
  validator cannot compile (another dialect, `unevaluatedProperties`) is
  still offered; its output is just not checked.

## Specifications

What this library implements, and from which revision:

- The MCP specification, revision
  [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
  (the pages under `specification/2026-07-28/` on modelcontextprotocol.io,
  and its `schema.ts`, ported in `src/types.ts`).
- The tasks extension, `io.modelcontextprotocol/tasks`, from
  [modelcontextprotocol/ext-tasks](https://github.com/modelcontextprotocol/ext-tasks)
  at commit `6c0997fbc040e6145c5cbd1e757aef9debb94303` (2026-09-23):
  `specification/2026-07-28/tasks.md` and `schema/2026-07-28/schema.ts`
  (identical to `draft/` at that commit apart from links), with
  `seps/2663-tasks-extension.md` (SEP-2663, status Final) for rationale. The
  overview page at modelcontextprotocol.io/extensions/tasks points there.

- Authorization: the 2026-07-28 pages `basic/authorization/index`,
  `authorization-server-discovery`, `client-registration` and
  `security-considerations`, with the RFCs they cite (6750, 7591, 7636, 7662,
  8414, 8707, 9068, 9207, 9728, OpenID Connect Discovery 1.0 and
  Registration 1.0, draft-ietf-oauth-client-id-metadata-document-00).
- The OAuth client credentials extension,
  `io.modelcontextprotocol/oauth-client-credentials`, from
  [modelcontextprotocol/ext-auth](https://github.com/modelcontextprotocol/ext-auth)
  at commit `fb374c7db2b34f18ca9183882e0beecdf661892b`:
  `specification/draft/oauth-client-credentials.mdx`, with the overview at
  modelcontextprotocol.io/extensions/auth/oauth-client-credentials.

## JSON Schema support

The validator implements the 2020-12 assertion and applicator vocabularies:
types, `enum`, `const`, numeric, string, array and object keywords,
`allOf`/`anyOf`/`oneOf`/`not`, `if`/`then`/`else`, `properties`,
`patternProperties`, `additionalProperties`, `propertyNames`,
`prefixItems`/`items`, `contains` with `minContains`/`maxContains`,
`dependentRequired`/`dependentSchemas`, and local `$ref` (JSON pointers and
`$anchor`). It refuses, at compile time, other dialects,
`unevaluatedProperties`/`unevaluatedItems`, dynamic references and any
non-local `$ref` (the spec forbids fetching them by default). Compilation
bounds depth (32) and subschemas (2000), and validation bounds steps
(100 000) and `$ref` nesting (64). `format` is an annotation only.
`minLength`/`maxLength` count code points.

## Not done

- **stdio.** Not needed in Workers. The server's `prepare`/`execute` split
  and the `Transport` interface are the seams a newline-delimited transport
  (with `notifications/cancelled` for cancellation) would use.
- **Legacy (2025-11-25 and earlier) interop.** No `initialize` handshake,
  sessions, GET streams, resumable streams, server-to-client requests on
  streams, or the HTTP+SSE transport. A modern client meeting a legacy
  server sees an `http` error (or `rpc`), not a fallback. That includes the
  experimental 2025-11-25 tasks (`tasks/result`, `tasks/list`, the `task`
  request parameter), which the extension replaces and is not
  wire-compatible with.
- **OAuth extras.** Enterprise-managed authorization (the ext-auth
  extension) is not implemented; see `@celld/oauth`'s "Not done" for the
  rest. `OAuthUserAgent` has no browser or loopback listener
  implementation: hosts provide their own.
- **Serving stale cache entries on errors**, which the caching page allows.
- **Integration points**: MCP servers hosted as celld services and MCP tools
  fed into `@celld/api/openai`'s agent loop are for later.
