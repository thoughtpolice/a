<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/mcp

A client and a server for the Model Context Protocol, revision
[2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), for
celld Workers. That revision is stateless: there is no `initialize` handshake
and no session, every request carries its protocol version and client
capabilities in `_meta`, servers answer `server/discover`, server-to-client
requests travel inside results as multi round-trip requests (MRTR), and change
notifications arrive on `subscriptions/listen` streams.

The library has no npm dependency. It is built on the other celld libraries:

- [`@celld/sieve`](../sieve/README.md) for tool schemas (the JSON Schema a tool
  advertises and the parser its arguments go through);
- [`@celld/web/router`](../web/router/README.md) for the HTTP endpoint, which is a route
  with the router's authentication, limits, security headers and error answers;
- [`@celld/sec/oauth`](../sec/oauth/README.md) for authorization on both sides: a
  `ResourceServer` behind the endpoint, and an `OAuthSession` as the client's
  credentials;
- [`@celld/http`](../http/README.md) for server-sent event parsing and framing;
- [`@celld/sec/jwt`](../sec/jwt/README.md) for base64url and
  [`@celld/core/ulid`](../core/README.md#celldcoreulid) for subscription epochs.

```python
celld.worker(
    name = "worker",
    main = "src/index.ts",
    deps = [
        "root//src/celld/mcp:mcp",
        "root//src/celld/sec/oauth:oauth",  # for a ResourceServer or OAuthSession
        "root//src/celld/sieve:sieve",  # for tool schemas
    ],
)
```

A Worker imports `v` from `@celld/sieve`, and the OAuth pieces from
`@celld/sec/oauth`, itself (strict deps): this library does not re-export them.

| Import               | What it has                                                                                                                                                                                                                                                                                             | Runtime imports      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `@celld/mcp`         | `McpServer`, `mcpRoutes`, `mcpHttpHandler`, `mcpOriginCheck`, `mcpHeader`, `McpClient`, `httpTransport`, protocol types, validation, errors, change sources, tasks (`UnsafeMemoryTaskStore`, `durableTaskStore`, `TaskHandle`), idempotency (`durableIdempotencyStore`, `unsafeMemoryIdempotencyStore`) | none                 |
| `@celld/mcp/durable` | the `McpChangeHub`, `McpTaskObject` and `McpIdempotencyObject` Durable Objects                                                                                                                                                                                                                          | `cloudflare:workers` |
| `@celld/mcp/testing` | `inProcessTransport`, `handlerFetch`, `testPrincipal`                                                                                                                                                                                                                                                   | none                 |

Only `./durable` imports `cloudflare:workers`, so everything else loads in a
plain `celld.test`. OAuth is `@celld/sec/oauth`'s (see
[Authorization](#authorization)).

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
import { jwtAccessTokenVerifier, ResourceServer } from "@celld/sec/oauth/resource";
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
    // "public" (shared across clients' cache contexts) only because no list
    // or read here varies by caller; the default is "private". With
    // `visible(info)` per-caller lists, keep it private.
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
    // Required: Bearer only here. DPoP needs a shared atomic replay store;
    // server nonces may be added, but do not replace replay prevention:
    // { replay: durableReplayStore(env.OAUTH_RECORDS), nonce }.
    dpop: false,
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
`A-Za-z0-9_.-`), duplicate names, schemas that do not compile or have no JSON
Schema form, invalid `x-mcp-header` annotations, unsupported URI template
syntax.

### Tools

`input` and `output` take a [`@celld/sieve`](../sieve/README.md) schema or raw
JSON Schema.

- A sieve `input` must be an object schema. Its input form
  (`toJSONSchema(schema, { io: "input", $schema: false })`) is the advertised
  `inputSchema`, so pick the object kind by what the tool should accept:
  `v.strictObject` refuses unknown arguments (`additionalProperties: false`),
  `v.looseObject` keeps them, and `v.object` accepts and drops them. Arguments
  are parsed by the schema and the handler receives the parsed output, typed
  (defaults filled in, transforms applied).
- A sieve `output`'s output form is the advertised `outputSchema`, and the
  `structuredContent` a handler returns is parsed by it before it is sent.
- `mcpHeader(schema, "Region")` adds `x-mcp-header: Region`, so the client
  mirrors the argument into `Mcp-Param-Region`; only on a string, integer or
  boolean property reachable through `properties`. Never use it for secrets:
  headers are visible to intermediaries.
- Raw JSON Schema is compiled by this library's validator (see
  [JSON Schema support](#json-schema-support)) and advertised as given; the
  handler then gets the arguments unchanged, as `Record<string, unknown>`.

Without `input` a tool takes no arguments
(`{"type": "object", "additionalProperties": false}`). A task body (`task.run`)
gets the arguments parsed the same way; the stored task keeps them as they were
sent and parses them again on every run.

A handler returns a string (one text block) or result fields (`content`,
`structuredContent`, `isError`, `_meta`). The server:

- validates arguments against the input schema; a failure is a tool result with
  `isError: true` naming the paths (`a: expected number, received
  string`), so
  the model can correct itself;
- turns a thrown `ToolError` into an `isError` result with its message;
- turns a thrown JSON-RPC `McpError` (kind `rpc`) into that JSON-RPC error;
- turns any other thrown `McpError` (an inner client's `unauthorized`, `http` or
  `timeout`) into the generic failure below: its text may be an upstream's, and
  an `unauthorized` one must not become this server's `403 insufficient_scope`,
  on which a client steps up and sends the call again;
- turns anything else into an `isError` result saying only that the tool failed,
  and reports the error to `onError` (default `console.error`), so internal
  details do not reach the model;
- checks `structuredContent` against the output schema and the content blocks
  against the protocol; a failure there is a server bug, answered -32603.

`visible(info)` hides a tool, resource, template or prompt per request (by
`info.principal`, say); hidden entries are absent from lists and unknown to
calls. `requires` names client capabilities an entry needs; a request without
them gets -32021.

Lists come back sorted (tools and prompts by name, resources by URI, templates
by URI template), so the order is deterministic across requests and isolates,
and paginated at `pageSize` (default 100) with keyset cursors that survive
insertions.

### Resources, prompts, completion

`server.resource({ uri, read })` serves one URI; `read` returns text, bytes
(sent as `blob`), content items, or `{ contents, ttlMs, cacheScope }`.
`server.resourceTemplate({ uriTemplate, read })` serves a family: `{var}`
matches one path segment, `{+var}` anything, and values are percent-decoded.
Templates are matched by a linear scan, not a regular expression, so a long URI
cannot make a match backtrack; a request's URI is at most 8 KiB (-32602 above
it). `compileUriTemplate(template)` returns
`{ variables, test(uri), match(uri) }` (it used to return a `RegExp`). A `read`
returning `null` means "no such resource", which is -32602 with `data.uri`
(never -32002, never empty contents).

`server.prompt({ name, arguments, get })` checks required arguments (-32602)
before `get` runs. Prompts and templates take `complete: { arg: fn }`; the
server then advertises `completions` and answers `completion/complete`, capping
values at 100 with `total` and `hasMore`.

### Multi round-trip requests

Handlers of `tools/call`, `prompts/get` and `resources/read` ask the client for
input through their context:

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
- `ctx.elicit(key, elicitUrl(message, url).params)` for URL mode, where `accept`
  only means the user agreed to go; the handler decides from its own records
  whether the interaction finished, and calls `ctx.inputRequired()` to have the
  client retry until it has;
- `ctx.state` and `ctx.setState(value)` carry the handler's own data between
  rounds;
- `ctx.inputRequired({ requests?, state? })` ends a round explicitly (with only
  a state, it is the spec's load-shedding shape);
- `ctx.sample(key, params)` and `ctx.roots(key)` for the deprecated sampling and
  roots features.

Each helper checks the client's declared capabilities first (an elicitation
needs `elicitation` with the right mode, where an empty object means form;
sampling with tools needs `sampling.tools`) and throws -32021 if they are
missing. A submitted form is checked against its `requestedSchema` (-32602).

`requestState` is AES-256-GCM under a key derived from `stateSecret` and
`stateAudience` (default the server's `info.name`), so the client can neither
read nor change it, and a state sealed by another server sharing the secret does
not open here; deployments that share both a secret and a name (staging and
production) set `stateAudience` to their public endpoint URL. `StateSealer`
takes the audience as its second argument. Inside, as the spec advises, it binds
the method and a digest of the request's params (everything but `_meta`,
`inputResponses` and `requestState`), the principal's `key` (see
[Ownership and follow-ups](#ownership-and-follow-ups)), the scopes the request
needed, an expiry (`stateTtlMs`, default 10 minutes), the keys it asked for, the
answers from earlier rounds (the client only resends the latest round), and the
handler's state. A state that fails any check is -32602 `Invalid requestState`
(or `Expired requestState`); a caller who still owns it but whose credential
lost the scopes it recorded is refused like a `tools/call` without them (403
`insufficient_scope` over HTTP). Answers to keys that were not asked, and
answers sent without a `requestState`, are ignored. This bounds replay but does
not make a state single-use; a handler that must consume something at most once
has to record that itself. Every instance of a server must share the secret.

### Progress, logging and cancellation

`ctx.progress(value, { total, message })` sends `notifications/progress` only if
the request carried a `progressToken`, only when the value increases, and never
after the handler returns. `ctx.log(level, data, logger)` sends
`notifications/message` only if the server enables the (deprecated) logging
feature with `logging: true` and the request set
`io.modelcontextprotocol/logLevel` at or below `level`.

`ctx.signal` fires when the client closes the response stream, which is how
Streamable HTTP cancels. After that nothing more is sent for the request.

Cancellation does not wait for the handler. The moment the signal fires,
`execute` resolves to null (over HTTP: a 499, or the end of the stream) and the
request's resources are released, whether or not the handler notices; what the
handler returns or throws later is dropped (logged with `console.debug`, never
an unhandled rejection). The handler's own work goes on until it observes
`ctx.signal`, so pass the signal to whatever it waits on (`fetch`, timers,
streams) to stop that work too. Task bodies behave the same on `tasks/cancel`
and expiry. A keyed `tools/call` (see [Retries](#retries)) is the exception: it
runs to its end so its answer can be recorded.

Work still running after its client left is not held with `waitUntil` (only a
keyed call's recording is), and at most `maxAbandonedRequests` (default 100)
such requests run at once: past that, new `tools/call`, `prompts/get` and
`resources/read` requests get -32603 with `data: {
busy: true }` before anything
runs, so a client that sends and leaves cannot pile up handlers.

### Subscriptions

A `subscriptions/listen` request gets an SSE stream that starts with
`notifications/subscriptions/acknowledged`, listing the subset of the filter the
server honours, and then carries only the notification types the client opted in
to, each tagged with `io.modelcontextprotocol/subscriptionId` (the listen
request's id). The server attaches to its change source before the
acknowledgement, so a change published after the client sees the acknowledgement
is always delivered. After `listenLifetimeMs` (default an hour, 1 ms to 2^31 - 1
ms) the server ends streams gracefully with a result tagged the same way. A
stream is authorized once, when it opens, so it also ends that way when the
credential it was opened with expires (`Principal.expiresAt`, which the router
fills from a token's `exp` or a session's expiry), whichever comes first; the
client reopens it with a fresh token. A listen request names at most 100 task
ids and 1000 resource URIs of at most 64 KiB together (`MAX_LISTEN_URI_TOTAL`;
-32602 above), and a resource subscription to a URI the server registered but
hides from the caller (`visible`) is not honoured. That check runs only when
some resource or template has `visible`, and a template whose leading or
trailing literal a URI lacks is ruled out before it is matched. A listener that
does not read gets its backlog (past 1000 events) replaced by one `reset`.

Changes come from a `ChangeSource`. `MemoryChangeSource` works within one
isolate. Workers do not share memory, so across a deployment use the
`McpChangeHub` Durable Object: `durableChangeSource(namespace)` returns a source
(each listen stream long-polls the hub's sequence-numbered log over RPC) and a
publisher (`await changes.publish({ type: "tools" })` from any request). The hub
keeps its log in memory; if it restarts, pollers see a new epoch and each stream
tells its client that everything it watches may have changed. Change events are
`tools`, `prompts`, `resources`, `{ type: "resource", uri }` and `reset`.

### Tasks

The tasks extension ([`io.modelcontextprotocol/tasks`](#specifications)) lets a
tool answer `tools/call` with a task handle instead of its result; the client
polls `tasks/get`, answers the task's input requests with `tasks/update`, and
may send `tasks/cancel`. Enable it with a store, and give tools a `task`:

```typescript
import { durableTaskStore, McpServer, type TaskObjectApi } from "@celld/mcp";
import { McpTaskObject } from "@celld/mcp/durable";
import { v } from "@celld/sieve";

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

- **Who decides.** The server does, per request. A tool with only `task` always
  runs as a task; a tool with `run` and `task` runs synchronously and may call
  `ctx.task({ state, statusMessage, ttlMs, pollIntervalMs })` to continue as
  one, after any multi round-trip input (the extension advises resolving that
  first). A task needs the client to have declared the extension on that
  request; otherwise `ctx.task()` and task-only tools answer -32021 naming it,
  as the extension requires. The capability is advertised through
  `server/discover`'s `extensions`.
- **Creating.** The server stores the task before answering: the
  `CreateTaskResult` carries `resultType: "task"`, the id, `working`, ISO
  timestamps, `ttlMs` (default one hour, `null` for unlimited) and
  `pollIntervalMs` (default 1000).
- **Ids and callers.** A task id is 144 random bits. Each task is owned by the
  `key` of the principal that created it, or, for an anonymous creator, by the
  task's token (see [Ownership and follow-ups](#ownership-and-follow-ups));
  `tasks/get`, `tasks/update` and `tasks/cancel` from anyone else get the same
  -32602 "Task not found" as an unknown id, so ids leak nothing. The owner must
  also still hold the scopes the task's tool needed. All three need the
  extension (-32021) and, on HTTP, `Mcp-Name` set to the task id (-32020
  otherwise). There is no `tasks/list`.
- **The body** gets a `TaskContext`: the arguments, `principal` (the creator's,
  as it was at creation: the body keeps running as it even if the credential
  later loses scopes; only follow-ups are rechecked), the creating request's
  capabilities, `signal` (cancellation or expiry), `status(message)`,
  `state`/`save(state)`, and the same input helpers as handlers (`elicit`,
  `ask`, `input`, `inputRequired`, and the deprecated `sample` and `roots`). It
  returns what a tool returns; the result, checked like a synchronous one,
  becomes the completed task's `result`. A thrown `ToolError` or any other
  non-JSON-RPC failure completes the task with `isError: true`; a JSON-RPC
  `McpError` (or an output schema violation, -32603) fails it with that `error`.
- **Input.** When the body asks for input it ends its run; the task becomes
  `input_required` with every outstanding request in `inputRequests`, the same
  requests on every poll. `tasks/update` answers are checked against the request
  (and a form against its `requestedSchema`, -32602); answers to keys not
  outstanding are ignored. Once none is outstanding, the body runs again from
  the top and finds its answers, like a multi round-trip handler. Keys are never
  reused within a task. `ctx.inputRequired()` without requests yields: the body
  runs again after the poll interval, which lets long work proceed in
  checkpointed steps.
- **Cancelling** makes the task `cancelled` at once (terminal) and aborts the
  body's signal; whatever the body returns afterwards is dropped. A terminal
  task ignores it.
- **Expiry.** After `ttlMs` from creation a task is deleted; the first
  `tasks/get` after that says "Task has expired", later ones "Task not found".
- **Notifications.** A `subscriptions/listen` filter may name `taskIds` (needs
  the extension, -32021). The server honours the caller's own live tasks (an
  anonymous caller names each task's token in `_meta["celld/task-tokens"]`, an
  object from id to token), refuses the stream when the caller owns one but
  lacks its scopes, sends each one's current state right after the
  acknowledgement, then a `notifications/tasks` (the full `tasks/get` answer) on
  every change. It needs a `changes` source that can also publish, such as
  `durableChangeSource`.

Where the work runs: `UnsafeMemoryTaskStore` keeps tasks in the isolate and runs
bodies on timers there, for tests and single processes. `durableTaskStore` makes
each task a `McpTaskObject` Durable Object named by its id, so every isolate
reaches the same task. Creating one writes the record to the object's SQLite
storage, sets an alarm for now and waits for `sync()` before the server answers.
The alarm handler runs the body inside the object, independent of the request
that created it; polls, updates and cancels are RPCs that interleave with it,
and status changes are visible immediately. When an update answers the last
outstanding request, the object sets its alarm again; at the TTL, the alarm
deletes the task. Alarms are delivered at least once: one that throws or whose
object is evicted mid-run is retried, so a body may run again from the top with
the state it last saved. Bodies must therefore be safe to repeat, as with multi
round-trip handlers, and `ctx.save` is the checkpoint.

### Ownership and follow-ups

Everything the server keeps between requests (tasks, sealed `requestState`,
idempotency slots) belongs to the caller's `Principal.key` from `@celld/web/router`:
the scheme, issuer, tenant, client id and subject, joined with NUL. The
`subject` alone never decides. A resource server trusting two issuers, or
`oauthSchemes` accepting both `bearer` and `dpop`, can see the same `sub` from
different callers; they are different owners, and none can read, answer, cancel
or listen to another's tasks or present its `requestState`. A principal without
a `key` (built by hand rather than by `toPrincipal`) fails the request with
-32603 rather than being recorded under a partial identity.

**Scope rechecks.** A task and a sealed state record the scopes their tool
needed (`ToolDefinition.scopes`). Every follow-up checks them against the
caller's current credential, as well as the tool's scopes now: `tasks/get`,
`tasks/update`, `tasks/cancel`, a listen stream naming the task, and every later
round of a multi round-trip request. A caller with the right key but a token
that no longer carries the scopes is refused: `execute` rejects with an
`unauthorized` McpError (`status: 403`,
`data: { error: "insufficient_scope", scope }`), which the HTTP endpoint answers
as 403 `insufficient_scope` with the scheme's challenge, the same as a
`tools/call` without them, so an OAuth client steps up. Only this refusal, made
before any handler runs, is an authorization failure (`isScopeRefusal`); an
`unauthorized` McpError a handler throws is answered as a tool failure (or
-32603), since the client would otherwise step up and send the executed request
again. The server also checks a tool's `scopes` on `tools/call` itself, so the
in-process transport enforces them too. Scope hierarchies come from
`ExecuteOptions.scopeSatisfied` (the endpoint passes its `scopeSatisfied`); the
default is exact membership. A task whose tool is no longer `visible` to the
caller reads as "Task not found".

**Anonymous callers own nothing.** On an endpoint with `{ public: true }`, or a
public route reached without a credential, there is no principal, so no key. A
task started anonymously is owned by a capability instead: its
`CreateTaskResult` carries a random 256-bit token in `_meta["celld/task-token"]`
(`TASK_TOKEN`), the store keeps only its SHA-256 digest, and `tasks/get`,
`tasks/update` and `tasks/cancel` must send the token back in the same `_meta`
key (-32602 without it, "Task not found" with another one). A listen stream
names tokens in `_meta["celld/task-tokens"]` (`TASK_TOKENS`: task id to token).
The id alone reaches nothing, and credentials do not stand in for the token.
`McpClient` does this by itself: `TaskHandle.token` holds the token, the handle
sends it on every request, and `client.task(id, name, { token })` resumes a
persisted anonymous task. Tasks started with credentials carry no token.
Anonymous multi round-trip state needs nothing extra: the sealed `requestState`
is already the capability, bound to one request and an expiry. Anonymous
idempotency keys share one namespace, so they must be unguessable. A task's
token is never stored in an idempotency slot: repeating the key of an anonymous
call that started a task is -32600 ("only its first answer carries the task's
token"), never the token, so an anonymous client that lost that first answer
cannot recover the task (it expires at its TTL).

**Release notes (breaking).**

- `TaskRecord` is version 2: `owner` is a `string` (a principal key, or
  `capability:` and a token digest) and a new `scopes` field holds the tool's
  scopes. `TaskStore`/`TaskObjectApi` take `owner: string`. Records from before
  (owned by a bare `subject`, version 1) are never opened again: they answer
  "Task not found" and expire at their TTL.
- Sealed state moved to `v2.` (a separate derived key); a `v1.` `requestState`
  in flight during the upgrade is -32602 and the client must start the request
  again.
- Idempotency slots are keyed by `Principal.key` instead of the interim owner
  key (WP-05's canonical JSON of scheme, `iss` claim, tenant, client and
  subject). With a persistent store, a key claimed before the upgrade no longer
  matches afterwards, so a retry across the upgrade may run once more within the
  store's TTL.
- Anonymous task follow-ups need the task token; clients other than `McpClient`
  must read `_meta["celld/task-token"]` from the creation result and send it
  back.
- `McpServer.execute` (and `handle`) reject with an `unauthorized` McpError for
  a missing scope instead of resolving; custom transports should answer it as
  403, and may check it with `isScopeRefusal`. A handler's own `unauthorized`
  McpError no longer escapes: it is a tool failure (`isError: true`) or -32603.

### The HTTP endpoint

The Streamable HTTP endpoint is a [`@celld/web/router`](../web/router/README.md) route.
`mcpRoutes(app, path, server, options)` adds `POST path` to an application's own
router, next to its other routes and under its auth:

```typescript
import { mcpRoutes } from "@celld/mcp";
import { oauthSchemes, protectedResourceRoutes } from "@celld/sec/oauth/router";
import { router } from "@celld/web/router";

const app = router<Env>({ auth: oauthSchemes(resource) });
protectedResourceRoutes(app, resource); // RFC 9728 metadata, public
app.get("/health", { public: true }, (c) => c.json({ ok: true }));
mcpRoutes(app, "/mcp", server, { allowedOrigins: ["https://app.example.com"] });
export default { fetch: app.fetch };
```

`mcpHttpHandler(server, options)` is the same over a private router, for a
Worker that serves nothing else. The options must choose how requests
authenticate; there is no default, and leaving the choice out is a type error
and throws a `TypeError`:

| Access                | Router auth                             | Also                                                                                                                  |
| --------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `{ resource, auth? }` | `auth`, else `oauthSchemes(resource)`   | metadata at `/.well-known/oauth-protected-resource{path}` and at the origin's `/.well-known/oauth-protected-resource` |
| `{ auth }`            | the router schemes given (at least one) |                                                                                                                       |
| `{ public: true }`    | `"none"`: anyone may call               | tools with `scopes` are refused; tasks are reachable only with their token                                            |

Next to `resource` or `auth`, `public: true` makes credentials optional (a sent
credential is still checked). `auth: "none"` and an empty scheme list are
refused: an endpoint without authentication is spelled `{ public: true }`.
Without `path` every path is the endpoint. It returns
`(request, env?, ctx?) => Promise<Response>`.

```typescript
mcpHttpHandler(server, { path: "/mcp", resource }); // OAuth
mcpHttpHandler(server, { path: "/mcp", auth: apiKey({ verify }) });
mcpHttpHandler(server, { path: "/mcp", public: true }); // no authentication
```

| Check                                                                                 | Failure                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `Origin` present and not in `allowedOrigins` (`mcpHttpHandler`: before anything else) | 403, -32600                                                                     |
| path                                                                                  | the router's 404                                                                |
| method is POST                                                                        | the router's 405, `Allow: OPTIONS, POST`; `OPTIONS` is 204                      |
| declared `Content-Length` over `maxBodyBytes` (default 4 MiB)                         | the router's 413                                                                |
| authentication (the route needs a principal unless `public`)                          | 401 with every scheme's challenge, or the scheme's 400/401 for a bad credential |
| `Origin` (for `mcpRoutes`)                                                            | 403, -32600                                                                     |
| `Content-Type: application/json`                                                      | 415, -32600                                                                     |
| body size while reading, and UTF-8                                                    | 413, -32600; 400, -32700                                                        |
| JSON, then one JSON-RPC request or notification                                       | 400, -32700 or -32600                                                           |
| `Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version` present and match                    | 400, -32020                                                                     |
| `_meta` has the version and capabilities                                              | 400, -32602                                                                     |
| version supported                                                                     | 400, -32022 with `supported`                                                    |
| method known and the feature present                                                  | 404, -32601                                                                     |
| params                                                                                | 400, -32602                                                                     |
| `Mcp-Param-*` match the tool's `x-mcp-header` arguments                               | 400, -32020                                                                     |
| the tool's `scopes`                                                                   | 403 `insufficient_scope`                                                        |
| a follow-up's stored scopes (task, listen, later round)                               | 403 `insufficient_scope`                                                        |
| client capabilities a handler needs                                                   | 400, -32021                                                                     |

The router's own answers (404, 405, 401, 413 before reading, 503, 504) have its
JSON error body (`{ "error", "message", "requestId" }`); the endpoint's have a
JSON-RPC one. Every answer gets the router's security headers and
`X-Request-Id`, and `Cache-Control: no-store` when authenticated.

Notifications get 202. Errors raised while a request runs (unknown tool, missing
resource, invalid `requestState`) are JSON-RPC errors with status 200. A request
is answered with one JSON response unless the handler emits a notification
before it finishes; then the response becomes an SSE stream
(`X-Accel-Buffering: no`, a `:` keep-alive comment every `keepAliveMs`, default
15 s, 0 for none, at most 300 000) carrying the notifications and the final
response. A client that stops reading an SSE response gets it closed (and the
request's work aborted) once `maxBufferedBytes` (default 1 MiB) is queued for
it, rather than the server buffering without bound. Bodies are parsed with depth
and width limits (64 deep, 10 000 members per object, 100 000 elements per
array): past them the answer is -32700. `subscriptions/listen` is always a
stream and needs `Accept: text/event-stream` (406 otherwise). `Mcp-Session-Id`
and `Last-Event-ID` are ignored and never sent.

The request's signal (`c.signal`) aborts when the client goes away, and closing
a stream aborts it too; either cancels the handler (`ctx.signal`), and a request
cancelled before its answer gets 499 at once, without waiting for the handler
(see [Progress, logging and cancellation](#progress-logging-and-cancellation)).
`timeout` (seconds or an ISO 8601 duration; default none) is the route's time
budget until a response starts: when it runs out the router answers 504 (the
outcome is unknown, so a client must not repeat a write on it), aborts the
handler's signal and starts no later stage. A stream, once started, is never cut
off.

A tool's `scopes` are checked once the tool is known: a principal without all of
them makes the route throw
`AuthError("insufficient_scope", "Missing scopes: ...", { scope })`, whose
`scope` names every scope the call needs (the spec asks for one challenge per
operation). The router answers 403 with the challenge of the scheme that
authenticated the request, `resource_metadata` included:
`Bearer error="insufficient_scope", error_description="Missing scopes: notes:write", scope="notes:write", resource_metadata="..."`.
An anonymous caller (a `public` route) gets every scheme's challenge, and with
`auth: "none"` there is no challenge, just the 403: a tool with `scopes` is
never served without a principal that has them. `scopeSatisfied(granted, scope)`
supplies scope hierarchies (a broader scope implying narrower ones); the default
is exact membership. Follow-ups are refused the same way when the caller lacks
the scopes stored with the task or sealed state (see
[Ownership and follow-ups](#ownership-and-follow-ups)).

The principal (`@celld/web/router`'s: `subject`, `scopes`, `claims`, `clientId`,
`issuer`, `key`, ...) reaches handlers as `ctx.principal`; its `key` binds
`requestState`, owns tasks and scopes idempotency slots. Handlers never see the
credential.

The route checks `Origin` before authentication (a router `before` hook), so on
an application's router with auth a cross-origin request without credentials
gets the 403, not a 401. `app.use(mcpOriginCheck(allowedOrigins))` extends the
check to every path of the router (requests under `/.well-known/` pass). An
`allowedOrigins` list is copied when the route is registered.

`mcpHttpHandler` builds its own router; `router` passes it options other than
`auth`. Behind a TLS-terminating proxy it needs the public URL
(`router: { publicUrl: { mode: "fixed", origin: "https://mcp.example" } }`, or a
trusted proxy with a named peer source), since the router refuses credentials
over plain http and checks DPoP proofs against that URL; a route `timeout` over
five minutes needs `router: { limits: { maxTimeout } }`.

The server copies its options when it is made, and each tool, resource, template
and prompt definition when it is registered (lists and plain data frozen;
schemas, stores and callbacks kept as given): changing a tool's `scopes` array
afterwards changes nothing. `scopes` must be a list of scope strings.

**Cleartext and proxies.** The router's credential schemes (bearer, DPoP, API
keys, ...) refuse a credential sent over plain `http:` unless the public URL's
host is a loopback IP literal: 403 `insecure_transport` (see
[`@celld/web/router`'s public URL](../web/router/README.md#the-public-url-and-cleartext-credentials)).
A Worker behind a TLS-terminating proxy sees an `http:` request URL, so it needs
the router's `publicUrl` (`{ mode: "fixed", origin }` or
`{ mode: "trusted-proxy", trustedProxies }`). `mcpHttpHandler` builds its own
router and cannot pass `publicUrl`; a proxied deployment mounts `mcpRoutes` on
its own `router({ auth, publicUrl })` instead.

## A client

`McpClient.http` (and `httpTransport`) send credentials only to an https
endpoint without user information or a fragment, and never follow a redirect
(`redirect: "error"`): the body carries tool arguments, sealed state and task
tokens. `allowLoopbackForDevelopment: true` also allows `http:` to a loopback IP
literal (`http://127.0.0.1:8787/mcp`, never `localhost`) for a server on this
machine. A bad endpoint is a `TypeError` before anything is sent. What comes
back is read under caps: a JSON answer and each SSE event at most
`maxResponseBytes` (default 4 MiB) and parsed with depth and width limits (a
`decode` error), and one SSE answer at most `maxStreamBytes` in all (default 64
MiB; a `stream` error).

Transport options are strict plain records: unknown keys, accessors, coercible
booleans/numbers and invalid header data fail before network activity. Static
headers and callback/provider method references are captured at construction;
provider methods retain their original `this` for private or mutable token
state. Dynamic headers are checked on every attempt (128 names, 16 KiB per
value, 64 KiB total), with case-insensitive duplicate names rejected. Provider
credentials override per-request and static headers case-insensitively, and
`authContext` is the exact object returned by that attempt's `headers` method.
Endpoints are canonicalized once so credential scoping and transport URLs agree.

```typescript
import { McpClient, memoryCache } from "@celld/mcp";

const client = McpClient.http("https://weather.example.com/mcp", {
  info: { name: "my-agent", version: "1.0.0" },
  // `session`: an OAuthSession (see Authorization); its credentials go only
  // to URLs inside its resource.
  auth: session.httpAuth(),
  handlers: {
    elicitation: async (params, { key, signal }) => await askUser(params),
    elicitationModes: ["form", "url"],
  },
  cache: memoryCache(),
  cacheContext: credentialHash, // allows caching "private" results for this credential
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

Credentials belong in `auth` (described at the end of [Retries](#retries)):
`session.httpAuth()` refuses any URL outside the session's resource. `headers`
(an object or a function) is raw: its values are sent as given on every request,
to whatever URL the client was given, with no such check.

Every request carries `io.modelcontextprotocol/protocolVersion`,
`clientCapabilities` (derived from the handlers plus `capabilities`) and
`clientInfo`, and on HTTP the `MCP-Protocol-Version`, `Mcp-Method` and
`Mcp-Name` headers (base64 sentinel-encoded when needed). Other behaviour:

- **Versions.** `discover()` switches to the first of `versions` the server
  lists. Without it, an -32022 on any call switches to a mutually supported
  version and retries once; none in common is an `unsupported_version` error.
- **Tools and headers.** `listTools()` drops tools whose `x-mcp-header`
  annotations break the spec's rules (warning through `onWarning`) and remembers
  the rest, so `callTool` can mirror annotated arguments into `Mcp-Param-*`
  headers. If the server still answers -32020, the client refreshes the tool
  list and retries once. `structuredContent` is checked against a known
  `outputSchema` (`validateToolOutput`, default on).
- **MRTR.** `callTool`, `getPrompt` and `readResource` answer `input_required`
  results through the handlers and retry with `inputResponses` and the exact
  `requestState` (and without one when the server sent none), each time under a
  new request id, up to `maxInputRounds` (default 8). A form answer is checked
  against the requested schema before it is sent. A request the client has no
  handler for is an `input_unhandled` error.
- **Results.** A result without `resultType` (a pre-2026-07-28 server) is
  complete; an unknown `resultType`, `input_required` from a method that may not
  send it, or a malformed result is a `decode` error.
- **Streams.** A JSON-RPC request from the server on a response stream is a
  `decode` error. A stream that ends without its response is a `stream` error
  with `accepted: true`: the server had the request, and may have acted on it.
  See [Retries](#retries).
- **Timeouts and cancellation.** `timeoutMs` (default 60 s) per round, restarted
  by each progress notification, and capped at `maxTimeoutMs` (default 10
  minutes); both are checked when the client is made (1 ms to 2^31 - 1 ms, a
  `RangeError`), and a per-call `timeoutMs` when the call starts. A caller's
  `signal` aborts the fetch, which closes the stream and cancels the request on
  the server.
- **Caching.** With `cache`, complete results of `server/discover`, the list
  methods and `resources/read` with `ttlMs > 0` are kept until they go stale.
  Keys are the endpoint, the method and every param but `_meta`; `public`
  results are shared by clients of the same endpoint, `private` ones are kept
  only under `cacheContext` (a hash of the credential, or the principal's key;
  never a bare user id) and never shared across contexts; MRTR retries are never
  cached; `{ fresh: true }` skips the lookup. A result's `ttlMs` counts for at
  most a day. List-changed and resource-updated notifications from `listen`
  invalidate the matching entries, and an answer that was in flight when one
  arrived is not stored. `listAllTools` follows at most 100 pages and 10 000
  tools, and refuses a repeated cursor (`decode`). A `listen` whose iterator
  leaves 1000 notifications unread fails with `stream`.
- **Subscriptions.** `client.listen(filter)` returns an async iterable of
  notifications with `acknowledged` (the honoured filter), `close()` and
  `endedGracefully`. Iteration ends when the server closes the subscription or
  the caller does, and throws when the stream drops; reconnecting is the
  caller's choice.
- **Tasks.** With `tasks: true` (or options), the client declares the extension
  and `callTool` follows a task handle to its end: it polls `tasks/get` no
  faster than the task's `pollIntervalMs` (without one, `initialPollMs`, default
  500), never faster than `minPollMs` (default 100 ms) nor slower than five
  minutes whatever the server says, backing off to `maxPollMs` (default 10 s)
  while nothing changes; answers each new input request once through the
  handlers (`InputContext.taskId` says which task) and sends the answers with
  `tasks/update`; retries transient poll failures (`maxPollErrors`); and returns
  the result. A failed task throws its JSON-RPC error (`rpc`), a cancelled one
  `task_cancelled`, and aborting the call cancels the task: the `aborted`
  error's `data` says `{ taskId, cancelled }`, and a cancel that failed (the
  task may still finish) is also reported to `onWarning`. `onTask` receives the
  `TaskHandle` first (to persist `taskId`), `onTaskStatus` each new state.
  `startToolCall` returns `{ type: "complete", result }` or
  `{ type: "task", task }` without waiting; `client.task(taskId, name)` resumes
  a stored id. A handle has `get()`, `update(responses)`, `cancel()`,
  `result(options)` and `tryResult()`. With `notifications: true` the client
  also listens for `notifications/tasks` while waiting, so a change arrives
  without waiting for the next poll. A task result from anything but
  `tools/call`, or when the client did not declare the extension, is a `decode`
  error.
- **Errors.** Everything throws `McpError` with a `kind` (`rpc`, `http`,
  `unauthorized`, `connection`, `stream`, `decode`, `timeout`, `aborted`,
  `unsupported_version`, `input_unhandled`, `input_rounds`, `invalid_request`,
  `task_cancelled`), the JSON-RPC `code` and `data`, the HTTP `status`, the
  `method`, `wwwAuthenticate` on 401/403, `accepted` (true once a response
  began, so the server may have acted; null when unknown), and getters for
  `retryable`, `supportedVersions`, `requiredCapabilities` and
  `resourceNotFound` (which also accepts the -32002 of older servers).
  `toJSON()` and `mcpErrorFromData` carry it across RPC; `attempt(() => ...)`
  returns `{ ok, result }` or `{ ok: false, error }`.

`client.request(method, params)` sends any other method (an extension's, say)
with the same `_meta`, headers and error handling.

### Retries

A request is sent again (under a new id) only when sending it twice has the same
effect as sending it once, and only after a failure that left no answer: its
response began and then broke off (`stream`), or the fetch failed
(`connection`). An HTTP status, a JSON-RPC error and a timeout are answers or
the caller's decision, and are never retried. `mayRetry` from
[`@celld/http`](../http/README.md#which-requests-may-be-retried) makes the
decision, with a `stream` failure counting as a broken body.

By default these are idempotent:

- the methods in `READ_ONLY_METHODS`: `server/discover`, the list methods,
  `resources/read`, `prompts/get`, `completion/complete`, `tasks/get` (and
  `initialize`, `ping`, `tasks/list` for servers that have them);
- a `tools/call` of a tool whose definition, from the client's last `listTools`,
  has `annotations.idempotentHint: true`; a `notifications/tools/list_changed`
  drops every such hint until the next `listTools`;
- but never a multi round-trip round carrying `inputResponses`: answering a form
  (an approval) is sent once, whatever the method or hint, unless the call has a
  key (next item);
- a `tools/call` with an `idempotencyKey` (below), to a server that advertises
  durable deduplication.

Everything else (other tools, `tasks/update`, `tasks/cancel`, the answers to
elicitation, extension methods) is sent once. When such a request fails after it
may have reached the server, the error keeps its `kind`, has `retryable: false`,
and its message says the server may have executed it. A `connection` failure
counts too: a fetch that rejects does not prove the server never saw the request
(a reset while a tool runs looks the same). So do the client's own `timeout` and
an HTTP 5xx or 499 without a JSON-RPC answer (the endpoint's 504 "may still take
effect", a proxy's 502): the request may still be running, so `retryable` is
false for them too. A 429 or other 4xx stays a refusal.

```typescript
const client = McpClient.http(url, {
  info,
  retry: {
    max: 2, // retries after the first attempt; default 1, 0 for none
    // `byDefault` is the rule above; return what the server guarantees.
    idempotent: (method, params, byDefault) =>
      byDefault || (method === "vendor/lookup"),
  },
});
```

A mutation becomes safe to retry with an idempotency key. The caller picks a
fresh random key per logical call and the client sends it as
`_meta["celld/idempotency-key"]` on every attempt and every multi round-trip
round:

```typescript
await client.callTool("charge", { cents: 500 }, {
  idempotencyKey: crypto.randomUUID(),
});
```

A server with `idempotency: { store }` runs a `tools/call` carrying a key once
per caller (its `Principal.key`; anonymous callers share one namespace), tool,
key and round, and answers duplicates with the stored result or error; a
duplicate while the first still runs gets -32600 with
`data: { idempotencyKey, inProgress: true }`, and the same key with other
arguments -32602. A keyed call is not cancelled when its client leaves: its
handler's `ctx.signal` never fires, since the key says the client will ask
again, so the handler runs to its end and the real answer is stored, not a
failure the abort caused. The answer is kept for `ttlMs` (default 24 hours): the
HTTP transport hands that write to the request's `ctx.waitUntil`, so the runtime
does not cancel it; a transport of your own passes `waitUntil` to `execute`. The
client, on `inProgress` for a keyed call, asks again under the same key with
backoff (25 ms doubling to 2 s) until the answer is there or `maxTimeoutMs` runs
out.

An anonymous caller's `input_required` answer is not replayed either: its sealed
`requestState` is the capability over the next round, so a duplicate gets -32600
("only its first answer carries the requestState").

A server with a store advertises it in `server/discover` as
`capabilities.experimental["celld/idempotency"]` (`IDEMPOTENCY_CAPABILITY`)
`= { durable }`, from the store's own `durable` flag. The client sends a keyed
call again only when that says `durable: true`; when it has not called
`discover()` yet it asks `server/discover` after the failure. A server without a
store ignores keys, and one with a per-isolate store may get the retry in
another isolate: against either, a retry could run the call twice, so the
failure has `retryable: false` instead.

`IdempotencyStore` is a `durable` flag and two methods: `claim(key, ttlMs)`
(atomic; `first: true` and a fresh `token` for exactly one of concurrent
claimers, otherwise the stored `result`, absent while running) and
`complete(key, token, result)`, which records the answer only while the claim
with that token still holds the key. A call that outlives its TTL may run again
on a retry; when the first one then finishes, its answer is dropped instead of
overwriting the retry's claim.
`durableIdempotencyStore(env.MCP_IDEMPOTENCY)` is the shipped durable one: one
`McpIdempotencyObject` Durable Object (from `@celld/mcp/durable`) per slot,
which writes the claim and the answer to its SQLite storage before answering and
deletes them from its alarm at the TTL. An answer over
`MAX_IDEMPOTENT_RESULT_BYTES` (1 MB of JSON) is recorded as -32603.
`unsafeMemoryIdempotencyStore()` keeps keys in one isolate's memory, for tests,
and says `durable: false`.

```typescript
export { McpIdempotencyObject } from "@celld/mcp/durable";

const server = new McpServer({
  info,
  idempotency: { store: durableIdempotencyStore(env.MCP_IDEMPOTENCY) },
});
```

```python
celld.project(..., bindings = {"MCP_IDEMPOTENCY": "McpIdempotencyObject"})
```

`auth` (on `McpClient.http` or `httpTransport`) takes an `HttpAuthProvider`,
which `@celld/sec/oauth`'s `OAuthSession` gives with `session.httpAuth()` (its
headers refuse any URL outside the session's resource):
`headers({ method, url, signal })` supplies credentials for each request
(overriding `headers`); the transport retains that exact object as
`authContext`. `observe({ url, headers, authContext })`, if present, sees every
other response (a resource may rotate its `DPoP-Nonce` on a 200); and
`challenge({ status, headers, method, url, attempt, signal, authContext })`
answers a 401 or 403 by resolving true once new credentials are ready, and the
request is sent again, at most `maxAuthAttempts` (default 3) times. False, or a
rejection, fails the request as `unauthorized` (with the rejection as `cause`
and its `toJSON()` as `data`). Anything else that authenticates HTTP requests
can be another.

Providers must bind response handling to that request context, not a mutable
"last token sent" field. A stale 401 must not delete a newer request's token.
Scope predicates must return exactly `true` or `false`; malformed results fail
opaquely and never execute a tool. Use `session.httpAuth()` for the OAuth
contract.

## Authorization

Authorization is [`@celld/sec/oauth`](../sec/oauth/README.md)'s on both sides; this
library adds what is MCP's: per-tool scopes, the client credentials extension's
id, and the transport's `HttpAuthProvider` seam.

### Resource server

```typescript
import { mcpHttpHandler } from "@celld/mcp";
import { jwtAccessTokenVerifier, ResourceServer } from "@celld/sec/oauth/resource";

const resource = new ResourceServer({
  resource: "https://weather.example.com/mcp", // the canonical URI
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["weather:read"],
  verifier: jwtAccessTokenVerifier({
    issuer: "https://auth.example.com",
    audience: "https://weather.example.com/mcp",
    keys: "https://auth.example.com/.well-known/jwks.json",
  }),
  dpop: false, // Bearer only; { replay: durableReplayStore(...) } takes DPoP too
});
const handler = mcpHttpHandler(server, { path: "/mcp", resource });
server.tool({ name: "set_alert", scopes: ["weather:write"], run: ... });
```

Behind the endpoint, `oauthSchemes(resource)` from `@celld/sec/oauth/router`
authenticates requests: Bearer and, unless `dpop: false`, DPoP (RFC 9449), with
the challenges the resource server writes (`realm`, `algs` and
`resource_metadata`, which names the metadata document at the resource's public
URL, not the address the Worker is reached at). What to know:

- **RFC 9068 strictly.** `jwtAccessTokenVerifier` wants `typ` `at+jwt` and
  `iss`, `exp`, `aud` (naming this resource), `sub`, `client_id`, `iat` and
  `jti`; `strict: false` accepts plain JWTs with `iss`, `aud` and `exp` from
  issuers that predate the profile. `introspectionVerifier` asks the
  authorization server instead (RFC 7662).
- **Algorithms.** The default list (`DEFAULT_ACCESS_TOKEN_ALGORITHMS`) is RSA,
  RSA-PSS, ECDSA and EdDSA; `algorithms` narrows it. A token signed with an
  algorithm the runtime cannot verify is a 500 (`JwtError`
  `runtime_unsupported`), not a refused token.
- **DPoP in challenges.** `dpop` has no default: `false`, or a shared atomic
  replay store (`{ replay }`), optionally with server nonces (`{ replay,
  nonce }`). Nonces limit proof pre-generation but do not make a captured proof
  single-use. Omitting the store requires the explicit
  `{ unsafeNoReplay: true }` opt-out and is safe only when another layer
  atomically enforces single use. With DPoP, every 401 challenges both schemes:
  `DPoP algs="ES256 ...", resource_metadata="...", Bearer resource_metadata="..."`.
  A refusal names only the scheme the request used. Choose explicitly.
- **Metadata.** The document (RFC 9728, with
  `bearer_methods_supported: ["header"]`) is served by `mcpHttpHandler`, or by
  `protectedResourceRoutes(app, resource)` on an application's router. Put extra
  members (`resource_name`) in `metadata`.
- **Invalid, expired and foreign tokens** are 401 `invalid_token`, a malformed
  `Authorization` 400 `invalid_request`, and an unreachable key set or
  introspection endpoint 503; a tool's missing scopes are 403
  `insufficient_scope` (see [The HTTP endpoint](#the-http-endpoint)).
- **No token passthrough.** `ctx.principal` has the subject, scopes, client id
  and claims only, so a handler cannot pass the token on to an upstream API (the
  spec forbids it; a server calling upstreams gets its own tokens for them).
- **Other credentials.** Any `@celld/web/router` scheme works:
  `bearer({ verify
  })` with a verifier of your own, `apiKey`, or an
  `AuthScheme` reading identity headers a trusted proxy adds. A `ResourceServer`
  with a custom `AccessTokenVerifier` keeps the metadata and challenges for
  tokens that are not JWTs.

### Client

```typescript
import { McpClient } from "@celld/mcp";
import { OAuthSession } from "@celld/sec/oauth/client";
import { DpopKey } from "@celld/sec/oauth/dpop";

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
const client = McpClient.http("https://weather.example.com/mcp", {
  info,
  auth: auth.httpAuth(),
});
```

`auth.httpAuth()` is the transport's `HttpAuthProvider`; its `headers` are the
session's `resourceHeaders`, which refuse a URL the resource does not cover
before any token is attached. On a 401 it discovers the Protected Resource
Metadata (the challenge's `resource_metadata`, else the well-known URLs; the
document's `resource` must be the endpoint or an ancestor path on its origin)
and the authorization server's metadata (RFC 8414, then OpenID Connect's
locations), refuses a server without PKCE S256, gets a client id
(pre-registered, a Client ID Metadata Document, a stored registration, then
Dynamic Client Registration), and sends the user through the `OAuthUserAgent`
(PKCE, `state`, `resource`, `iss` checked per RFC 9207, pushed authorization
requests when offered). Tokens are kept per issuer and resource and refreshed
before they expire; a 401 for a token that was sent refreshes once, then starts
over; a 403 `insufficient_scope` (a tool's `scopes`) re-authorizes with the
union of the scopes so far and the challenge's, once per scope set. With a
`dpop` key, tokens are bound to it, and the nonces the endpoint rotates on its
answers are taken up through `observe`. Failures are `OAuthError`s, which reach
MCP callers as the `cause` of an `unauthorized` McpError.

A host whose callback is another request (a Worker) calls
`beginAuthorization()`, keeps the returned `PendingAuthorization` (plain data,
private: it holds the PKCE verifier), and passes the callback URL to
`completeAuthorization(pending, url)`.

With `clientCredentials: { issuer, clientId, clientSecret }` (or `privateKey`,
`alg` and `kid` for `private_key_jwt`), the session uses the client credentials
grant instead of a user, only ever with the issuer named. That is the
`io.modelcontextprotocol/oauth-client-credentials` extension: declare
`OAUTH_CLIENT_CREDENTIALS_EXTENSION` in the MCP client's
`capabilities.extensions`.

### Testing

`@celld/sec/oauth/testing` has `testAuthorizationServer` (an in-memory
`AuthorizationServer` with a fresh key and consent that grants at once, or as a
test decides), `testUserAgent` (follows the authorization redirects) and
`routeFetch` (a `fetch` per origin). The server has no switches to misbehave: a
wrong `issuer`, a missing `iss` or no S256 are tested in `@celld/sec/oauth` itself,
and a test that needs one from an MCP client wraps `routeFetch` to rewrite the
answer. `testPrincipal(subject, { scopes })` from `@celld/mcp/testing` builds a
principal for requests handed to a server directly, with `@celld/web/router`'s
`toPrincipal`, as the router would; its `scheme`, `issuer`, `tenant` and
`clientId` options make principals with the same subject but different keys.

## Testing

```typescript
import { handlerFetch, inProcessTransport } from "@celld/mcp/testing";

// Protocol only, no HTTP:
const direct = new McpClient({ transport: inProcessTransport(server), info });
// The full Streamable HTTP rules, in process:
const http = McpClient.http("https://mcp.test/mcp", {
  info,
  fetch: handlerFetch(mcpHttpHandler(server, { path: "/mcp", public: true })),
});
```

`inProcessTransport` copies messages through JSON both ways, so a value that
would not survive the wire does not survive in tests either.

The package's own tests: one Deno suite per concern (`framing`, `server`,
`headers`, `http`, `mrtr`, `subscriptions`, `progress`, `cancellation`,
`client`, `retry`, `cache`, `jsonschema`, `tasks`, `tasks_client`,
`oauth_client`, `oauth_server`, `ownership`), and `:runtime-test`, which runs
`tests/runtime/worker.ts` under `celld dev` and drives it from Python as a raw
HTTP client: header validation and statuses, JSON and SSE framing,
`server/discover`, tool calls with `Mcp-Param-*`, an MRTR round trip with a
tampered state, a listen stream fed through `McpChangeHub`, cancellation by
closing a stream, tasks stored and run by `McpTaskObject` (input through
`tasks/update`, another caller refused, cancellation, `notifications/tasks`),
OAuth challenges and metadata (also behind a proxy's `X-Forwarded-*`) with
`@celld/sec/oauth`'s authorization server in memory, and the TypeScript client, with
an `OAuthSession`, calling the Worker over real fetch, including a task with
input and an authorization with a step-up.

Claim-race regressions wait for explicit handler-start barriers before advancing
their injected clock or submitting a duplicate. Timer turns do not establish
ordering across the server's asynchronous request digests.

That Worker is test-only; do not copy it. It trusts `X-Forwarded-Host` and
`X-Forwarded-Proto` from any peer (and builds an authorization server per
forwarded host), and `GET /oauth-check?target=` fetches whatever URL it is
given. That is tolerable only because the live test's VM is reachable solely
through exe.dev's proxy. A deployment uses the router's `publicUrl` (see
[The HTTP endpoint](#the-http-endpoint)).

```sh
buck2 test root//src/celld/mcp/...
```

### Live test

`:live-run` runs the runtime-test project on an exe.dev VM and drives it over
the network. Nothing runs it automatically.

```sh
buck2 run root//src/celld/mcp:live-run -- celld-mcp-test.exe.xyz [--token-file F] [--port N]
```

It installs, under `~/.cache/celld-live` on the VM, the toolchain's pinned celld
release for the VM's architecture (copied from this machine, checked by digest)
and Deno (pinned by `buck/bin/deno`); refuses to start if anything listens on
the port (default 8000, the VM's proxy port); starts `celld dev` there in its
own process group; and runs:

1. `tests/live/client.ts` (the `:live-client` bundle) from this machine against
   `https://<vm>.exe.xyz`, through exe.dev's HTTPS proxy, with a VM-scoped token
   in `X-Exedev-Authorization` (the proxy consumes it, so MCP's own
   `Authorization` passes through untouched). The token comes from
   `--token-file`, `$EXEDEV_TOKEN`, or is minted with
   `ssh exe.dev ssh-key generate-api-key --vm=<vm> --label=mcp-live --exp=1d`,
   and is never printed;
2. the same client on the VM against `http://127.0.0.1:<port>`;
3. `tests/live/sdk_interop.ts` on the VM: the official
   `@modelcontextprotocol/client` (2.1.0 by default, `--sdk-version`), through
   Deno's `npm:` support with its cache in `~/.cache/celld-live/deno-dir`,
   pinned to protocol 2026-07-28.

The client checks discovery, tools (structured output, `Mcp-Param-*`), an MRTR
elicitation, progress over SSE, resources, a listen stream through
`McpChangeHub`, tasks run by `McpTaskObject` (input through `tasks/update`,
cancellation, `notifications/tasks`), bearer refusals, and the OAuth flow
against the Worker's in-memory authorization server (which, like the metadata,
names the public origin the proxy reports in `X-Forwarded-*`, trusted without
checking the peer: test-only, see [Testing](#testing)), including a step-up and
a tampered token. Afterwards the server is stopped and its run directory
removed; the installed tools stay cached. The report is JSON on stdout; the exit
status is 0 only if every run passed and the port is free again.

## What this protects and what it does not

The server side checks what reaches the endpoint: `Origin`, authentication and
the cleartext rule, sizes, headers, `_meta`, params, each tool's scopes, and who
owns a task, a sealed state or an idempotency slot
([Ownership and follow-ups](#ownership-and-follow-ups)). It does not:

- **Limit the client's egress.** `httpTransport` fetches with the platform's
  default redirect handling (redirects are followed), reads a JSON response body
  without a size cap, and parses SSE with no cap on an event's size. Only an
  `auth` provider such as `session.httpAuth()` checks the URL before sending
  credentials; `headers` are sent as given. Point a client only at servers you
  trust with that much.
- **Work over cleartext behind a proxy by itself.** Credentials are refused over
  non-loopback `http:`; behind a TLS proxy the router needs `publicUrl`, which
  only `mcpRoutes` on your own router can set
  ([The HTTP endpoint](#the-http-endpoint)).
- **Notice revocation on listen streams.** A `subscriptions/listen` stream is
  authorized once, when it opens: it ends at the credential's expiry and after
  `listenLifetimeMs` (default an hour), but a revoked token keeps it open until
  then. Set a lifetime no longer than you are willing to let a revoked
  credential keep receiving notifications.
- **Bound handler time.** `timeout` defaults to none, so a caller can hold a
  handler open until it answers; a stream, once started, is never cut off.
- **Meter anonymous callers.** A `{ public: true }` endpoint is a cost surface:
  anyone who can reach it runs every tool without `scopes`, and each task call
  creates a task (a Durable Object and its alarms with `durableTaskStore`) that
  runs until it ends, is cancelled or expires. There is no quota; put rate
  limits in front.
- **Release an interrupted claim.** With `durableIdempotencyStore`, a claim
  whose server died mid-call (an evicted isolate) stays held, and duplicates get
  `inProgress`, until its TTL.
- **Revoke a running task.** A task body keeps its creator's principal as it was
  at creation, even after the credential is revoked or loses scopes; only
  follow-ups are rechecked.
- **Guard a handler's own requests.** A tool's `fetch` is its own. Use
  [`@celld/http/egress`](../http/README.md)'s `boundedFetch` for limits and an
  address policy; it sees hosts as URLs write them and cannot check what a DNS
  name resolves to.
- **Make the runtime test Worker safe to deploy.** `tests/runtime/worker.ts`
  trusts `X-Forwarded-*` from any peer and fetches `?target=`; it is for the
  tests and the live VM only ([Testing](#testing)).

## Examples

[`examples/`](examples/README.md) has standalone Workers, each tested under
`celld dev` by a spec of raw HTTP requests: a minimal server, a multi round-trip
request, tasks on their Durable Object with a listen stream, an OAuth resource
server, and a Worker calling another MCP server as a client with client
credentials. `tools`, `approval` and `tasks` are deliberately unauthenticated,
and so are `gateway`'s own routes; the examples README says what each exposes.

```sh
buck2 test root//src/celld/mcp/examples/...
```

## Protocol decisions

Where the spec leaves room or disagrees with itself, this is what the library
does.

- **Unsupported versions include `server/discover`.** The version check applies
  to every request, discovery too; the error lists the supported versions either
  way.
- **HTTP statuses.** The spec fixes 400 for -32020, -32021, -32022 and malformed
  `_meta`, and 404 for -32601. Other request validation failures (bad params)
  are 400 as well. Errors raised while running a request (unknown tool, missing
  resource, bad `requestState`) are 200, as a JSON-RPC error is a normal answer;
  -32021 stays 400 wherever it is raised.
- **JSON or SSE.** The server picks per request: JSON unless a notification is
  emitted before the result. A client that does not accept `text/event-stream`
  gets JSON and no notifications.
- **Tool input validation.** The schema's `InvalidParamsError` examples list
  "invalid tool arguments", but the tools page lists input validation errors as
  tool execution errors. Arguments that fail the schema are an `isError` result,
  so the model can correct them; an unknown tool is -32602.
- **Origin.** The spec requires validating `Origin` without saying against what.
  Checking it against `Host` does not stop DNS rebinding (the attacker controls
  both), so by default any `Origin` is refused and browsers must be allowed
  explicitly with `allowedOrigins`.
- **Header checks for notifications.** The spec defines no header requirements
  for notification POSTs, so none are checked; every valid notification gets
  202, since no client notification has an effect on this transport.
- **`Mcp-Param-*` without an argument.** A header present for an argument that
  is absent or null is a mismatch (-32020); the spec only says the client must
  omit it.
- **Ending a subscription.** The cancellation page says a server tearing down a
  subscription MUST send `notifications/cancelled`; the subscriptions page says
  it SHOULD send a successful listen result. On HTTP the server sends the result
  and closes the stream; `notifications/cancelled` is left to stdio, where the
  schema scopes it.
- **Tasks: `tasks/get`'s `resultType`.** The extension says it MUST be
  `complete`, but its "task with JSON-RPC execution error" example shows `task`.
  The server sends `complete`; the client accepts either.
- **Tasks: what a body's failure is.** A thrown `ToolError`, or any error that
  is not a JSON-RPC one, completes the task with `isError: true`, as the
  synchronous path does; the extension forbids `failed` for non-JSON-RPC errors.
  A thrown JSON-RPC `McpError` and an output that fails the tool's schema (a
  server bug, -32603 on the synchronous path) fail it.
- **Tasks: cancellation is immediate.** The extension lets a server keep a
  cancelled task working or finish it another way. This server marks it
  `cancelled` at once and drops the body's outcome, so the state machine never
  goes back from a client's cancel; the body only learns through its signal.
- **Tasks: expiry.** The extension allows marking an expired task `failed`
  before deleting it; this server deletes it at the TTL, which it also allows
  ("Task has expired" once, then "Task not found").
- **Tasks: other callers.** Tasks are bound to the principal's `key`, and a
  foreign or unknown id get the same error. Without authentication (no
  principal) a task is bound to a token returned in the creation result's
  `_meta`, not to the id: the extension would permit the id as the only secret,
  but ids travel in notifications and logs. Clients that ignore `_meta` cannot
  follow anonymous tasks.
- **Tasks: input validation.** `tasks/update` checks answers when they arrive
  (shape, and forms against their schema) and refuses the whole update with
  -32602 on a bad one, rather than letting the body fail later.
- **Tasks: listen snapshots.** The extension does not say whether a new listen
  stream gets the current state of the tasks it names. The server sends it right
  after the acknowledgement, so a task that finished before the subscription is
  not waited on forever.
- **OAuth: which `resource` a metadata document may name.** RFC 9728 wants it
  identical to the URL the metadata was derived from, while the MCP spec allows
  a less specific canonical URI (`https://mcp.example.com` for
  `https://mcp.example.com/mcp`). `OAuthSession` accepts the endpoint itself or
  an ancestor path on the same origin, and nothing else, and sends the
  document's value, as given, as `resource`.
- **OAuth: a metadata document with the wrong `issuer`.** It is never used; the
  client goes on to the next well-known URL rather than failing at once, and
  fails only if none is usable.
- **OAuth: step-up limits.** "No more than a few times" is one step-up per
  distinct scope set; a 401 is answered once per request, at most
  `maxAuthAttempts` in all.
- **OAuth: the client credentials extension's metadata.** It requires
  `private_key_jwt` or `client_secret_basic` in
  `token_endpoint_auth_methods_supported`, but its example sends the secret in
  the body. The client uses `client_secret_basic` when listed, else
  `client_secret_post`, and treats an absent list as RFC 8414's default,
  `client_secret_basic`.
- **Resource subscriptions** match URIs exactly. The spec allows updates for
  sub-resources of a subscribed URI but does not define "sub-resource".
- **Unsupported listen filters.** When no type in the filter can be honoured,
  the server acknowledges `{}` and ends the stream at once with the graceful
  result, rather than holding an idle stream open.
- **Tool errors that are not `ToolError`** do not show their message, which may
  carry internal details; the handler decides what the model sees.
- **Tool names** follow the spec's SHOULD rules strictly at registration.
- **Output schemas on the client.** A tool whose `outputSchema` this validator
  cannot compile (another dialect, `unevaluatedProperties`) is still offered;
  its output is just not checked.

## Specifications

What this library implements, and from which revision:

- The MCP specification, revision
  [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) (the
  pages under `specification/2026-07-28/` on modelcontextprotocol.io, and its
  `schema.ts`, ported in `src/types.ts`).
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
  8414, 8707, 9068, 9207, 9728, OpenID Connect Discovery 1.0 and Registration
  1.0, draft-ietf-oauth-client-id-metadata-document-00).
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
`unevaluatedProperties`/`unevaluatedItems`, dynamic references and any non-local
`$ref` (the spec forbids fetching them by default). Compilation bounds depth
(32) and subschemas (2000), and validation bounds steps (100 000) and `$ref`
nesting (64); each limit must be a whole number (`RangeError`). `format` is an
annotation only. `minLength`/`maxLength` count code points.

Regular expressions run on the JavaScript engine, which backtracks, and no step
budget sees inside them, so `pattern` and `patternProperties` are evaluated only
in schemas compiled with `trustPatterns: true`: the server's own tool schemas
and elicitation forms. In a schema from the other side (a server's output schema
or elicitation form, as a client sees it) `pattern` is ignored and
`patternProperties` makes the schema one the client does not check. Keep your
own patterns linear: they run on strings the peer chose.

## Not done

- **stdio.** Not needed in Workers. The server's `prepare`/`execute` split and
  the `Transport` interface are the seams a newline-delimited transport (with
  `notifications/cancelled` for cancellation) would use.
- **Legacy (2025-11-25 and earlier) interop.** No `initialize` handshake,
  sessions, GET streams, resumable streams, server-to-client requests on
  streams, or the HTTP+SSE transport. A modern client meeting a legacy server
  sees an `http` error (or `rpc`), not a fallback. That includes the
  experimental 2025-11-25 tasks (`tasks/result`, `tasks/list`, the `task`
  request parameter), which the extension replaces and is not wire-compatible
  with.
- **OAuth extras.** Enterprise-managed authorization (the ext-auth extension) is
  not implemented; see `@celld/sec/oauth`'s "Not done" for the rest.
  `OAuthUserAgent` has no browser or loopback listener implementation: hosts
  provide their own.
- **Serving stale cache entries on errors**, which the caching page allows.
- **Integration points**: MCP servers hosted as celld services and MCP tools fed
  into `@celld/api/openai`'s agent loop are for later.
