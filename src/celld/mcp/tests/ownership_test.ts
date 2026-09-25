// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Who owns tasks, sealed multi round-trip state and idempotency slots
 * (DB-MCP-002): the principal's `key` (scheme, issuer, tenant, client and
 * subject), never its `subject` alone; every follow-up rechecks the scopes
 * the tool needed against the caller's current ones; anonymous callers own
 * nothing and reach a task only with its one-time token.
 */

import { assert, assertEquals } from "@celld/core/assert";
import {
  type ClientCapabilities,
  type JSONRPCNotification,
  type JSONRPCResponse,
  McpError,
  mcpHttpHandler,
  McpServer,
  MemoryChangeSource,
  type Principal,
  type TaskRecord,
  TASKS_EXTENSION,
  type TaskStore,
  unsafeMemoryIdempotencyStore,
  UnsafeMemoryTaskStore,
} from "@celld/mcp";
import { ProtocolError } from "@celld/sec/oauth";
import { ResourceServer } from "@celld/sec/oauth/resource";
import { type PrincipalInput, toPrincipal } from "@celld/web/router";
import { errorOf, request, resultOf, SECRET, SERVER_INFO } from "./fixture.ts";

const CAPS: ClientCapabilities = {
  extensions: { [TASKS_EXTENSION]: {} },
  elicitation: { form: {} },
};
/** The literal `_meta` keys, so this suite does not lean on the constants. */
const TASK_TOKEN = "celld/task-token";
const TASK_TOKENS = "celld/task-tokens";
const IDEMPOTENCY = "celld/idempotency-key";

const FORM = {
  mode: "form" as const,
  message: "Go?",
  requestedSchema: {
    type: "object" as const,
    properties: { label: { type: "string" as const } },
    required: ["label"],
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The owner and every caller that shares its subject but nothing else. */
const OWNER_PARTS: PrincipalInput = {
  subject: "user-1",
  scopes: ["tasks"],
  issuer: "https://a.example",
  clientId: "app-1",
};
const OWNER = toPrincipal(OWNER_PARTS, "bearer");
const INTRUDERS: Record<string, Principal> = {
  "another issuer": toPrincipal(
    { ...OWNER_PARTS, issuer: "https://b.example" },
    "bearer",
  ),
  "another client": toPrincipal(
    { ...OWNER_PARTS, clientId: "app-2" },
    "bearer",
  ),
  "another scheme": toPrincipal(
    { ...OWNER_PARTS, tokenType: "DPoP" },
    "dpop",
  ),
  "another tenant": toPrincipal({ ...OWNER_PARTS, tenant: "t-2" }, "bearer"),
  "no issuer": toPrincipal({ ...OWNER_PARTS, issuer: undefined }, "bearer"),
  // The claim WP-05's stopgap owner key read: equal, but not the issuer.
  "the same iss claim": toPrincipal({
    ...OWNER_PARTS,
    issuer: "https://b.example",
    claims: { iss: "https://a.example" },
  }, "bearer"),
};
/** The owner's key, but a token without the tool's scope. */
const WEAK = toPrincipal({ ...OWNER_PARTS, scopes: [] }, "bearer");

function ownedServer(options: { store?: TaskStore } = {}) {
  const changes = new MemoryChangeSource();
  const store = options.store ?? new UnsafeMemoryTaskStore();
  const server = new McpServer({
    info: SERVER_INFO,
    stateSecret: SECRET,
    changes,
    tasks: { store, pollIntervalMs: 10 },
    idempotency: { store: unsafeMemoryIdempotencyStore() },
  });
  const runs = { count: 0 };
  const seen: (Principal | null)[] = [];
  server.tool({
    name: "job",
    scopes: ["tasks"],
    task: {
      run: (_args, ctx) => {
        seen.push(ctx.principal);
        const answer = ctx.elicit("go", FORM);
        return `done ${answer.content?.label}`;
      },
    },
  });
  server.tool({
    name: "open-job",
    task: {
      run: (_args, ctx) => {
        const answer = ctx.elicit("go", FORM);
        return `done ${answer.content?.label}`;
      },
    },
  });
  server.tool({
    name: "confirm",
    scopes: ["tasks"],
    run: (_args, ctx) => {
      const answer = ctx.elicit("go", FORM);
      return `confirmed ${answer.content?.label}`;
    },
  });
  server.tool({
    name: "count",
    scopes: ["tasks"],
    run: () => `run ${++runs.count}`,
  });
  return { server, changes, runs, seen };
}

Deno.test("Daybreak direct server scope predicates require exact booleans", async () => {
  for (const value of ["true", "false", 1, 0, {}, null, undefined]) {
    const { server, runs } = ownedServer();
    await settle(
      call(
        server,
        "tools/call",
        { name: "count", arguments: {} },
        WEAK,
        {},
        (() => value) as unknown as (
          granted: readonly string[],
          scope: string,
        ) => boolean,
      ),
    );
    assertEquals(runs.count, 0);
  }
});

function call(
  server: McpServer,
  method: string,
  params: Record<string, unknown>,
  principal: Principal | null,
  meta: Record<string, unknown> = {},
  scopeSatisfied?: (granted: readonly string[], scope: string) => boolean,
): Promise<JSONRPCResponse | null> {
  return server.handle(request(method, params, { capabilities: CAPS, meta }), {
    principal,
    ...(scopeSatisfied === undefined ? {} : { scopeSatisfied }),
  });
}

/** How a call went: its result, its JSON-RPC error, or a thrown refusal. */
async function settle(
  pending: Promise<JSONRPCResponse | null>,
): Promise<
  | { readonly result: Record<string, unknown> }
  | { readonly error: { code: number; message: string; data?: unknown } }
  | { readonly refused: unknown }
> {
  let response: JSONRPCResponse | null;
  try {
    response = await pending;
  } catch (error) {
    return { refused: error };
  }
  if (response !== null && "error" in response) {
    return { error: response.error };
  }
  return { result: resultOf(response) };
}

/** Asserts `pending` was refused for the missing scopes, as a 403 would be. */
async function assertScopeRefused(
  pending: Promise<JSONRPCResponse | null>,
  what: string,
): Promise<void> {
  const outcome = await settle(pending);
  assert(
    "refused" in outcome,
    `${what}: expected an insufficient_scope refusal, got ${
      JSON.stringify(outcome)
    }`,
  );
  const error = outcome.refused;
  assert(error instanceof McpError, `${what}: ${error}`);
  assertEquals(error.kind, "unauthorized", what);
  assertEquals(error.status, 403, what);
  assertEquals(
    error.data,
    { error: "insufficient_scope", scope: ["tasks"] },
    what,
  );
}

async function pollStatus(
  server: McpServer,
  taskId: string,
  status: string,
  principal: Principal | null,
  meta: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const task = resultOf(
      await call(server, "tasks/get", { taskId }, principal, meta),
    );
    if (task.status === status) return task;
    await sleep(5);
  }
  throw new Error(`task ${taskId} never became ${status}`);
}

/** Opens a listen stream for `filter`, and returns what it acknowledged. */
async function listenAck(
  server: McpServer,
  filter: Record<string, unknown>,
  principal: Principal | null,
  meta: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const seen: JSONRPCNotification[] = [];
  const controller = new AbortController();
  const listening = server.handle(
    request("subscriptions/listen", { notifications: filter }, {
      capabilities: CAPS,
      meta,
    }),
    {
      principal,
      signal: controller.signal,
      emit: (notification) => {
        seen.push(notification);
      },
    },
  );
  let failure: unknown = null;
  listening.catch((error) => {
    failure = error;
  });
  for (let i = 0; i < 100 && seen.length === 0 && failure === null; i++) {
    await sleep(2);
  }
  controller.abort();
  const response = await listening.catch(() => null);
  if (failure !== null) throw failure;
  if (response !== null && "error" in response) {
    throw new Error(`listen failed: ${JSON.stringify(response.error)}`);
  }
  assertEquals(seen[0]?.method, "notifications/subscriptions/acknowledged");
  return seen[0].params?.notifications as Record<string, unknown>;
}

async function startJob(
  server: McpServer,
  principal: Principal | null,
  name = "job",
): Promise<{ taskId: string; meta: Record<string, unknown> }> {
  const created = resultOf(
    await call(server, "tools/call", { name }, principal),
  );
  assertEquals(created.resultType, "task");
  const taskId = created.taskId as string;
  const token = (created._meta as Record<string, unknown>)[TASK_TOKEN];
  const meta: Record<string, unknown> = token === undefined
    ? {}
    : { [TASK_TOKEN]: token };
  await pollStatus(server, taskId, "input_required", principal, meta);
  return { taskId, meta };
}

Deno.test("equal subjects from other issuers, clients, schemes or tenants cannot reach a task", async () => {
  for (const [who, intruder] of Object.entries(INTRUDERS)) {
    assert(intruder.key !== OWNER.key, who);
    const { server } = ownedServer();
    const { taskId } = await startJob(server, OWNER);

    assertEquals(
      errorOf(await call(server, "tasks/get", { taskId }, intruder)),
      { code: -32602, message: "Failed to retrieve task: Task not found" },
      `${who}: tasks/get`,
    );
    assertEquals(
      errorOf(
        await call(server, "tasks/update", {
          taskId,
          inputResponses: {
            go: { action: "accept", content: { label: "mallory" } },
          },
        }, intruder),
      ),
      { code: -32602, message: "Failed to update task: Task not found" },
      `${who}: tasks/update`,
    );
    assertEquals(
      errorOf(await call(server, "tasks/cancel", { taskId }, intruder)),
      { code: -32602, message: "Failed to cancel task: Task not found" },
      `${who}: tasks/cancel`,
    );
    assertEquals(
      await listenAck(server, { taskIds: [taskId] }, intruder),
      {},
      `${who}: listen`,
    );

    // Untouched: still waiting, and the owner's answer is the one used.
    const still = resultOf(
      await call(server, "tasks/get", { taskId }, OWNER),
    );
    assertEquals(still.status, "input_required", who);
    assertEquals(
      await listenAck(server, { taskIds: [taskId] }, OWNER),
      { taskIds: [taskId] },
      `${who}: the owner listens`,
    );
    resultOf(
      await call(server, "tasks/update", {
        taskId,
        inputResponses: { go: { action: "accept", content: { label: "own" } } },
      }, OWNER),
    );
    const done = await pollStatus(server, taskId, "completed", OWNER);
    assertEquals(
      (done.result as { content: unknown }).content,
      [{ type: "text", text: "done own" }],
      who,
    );
  }
});

Deno.test("sealed multi round-trip state belongs to the principal's key", async () => {
  const { server } = ownedServer();
  const first = resultOf(
    await call(server, "tools/call", { name: "confirm" }, OWNER),
  );
  assertEquals(first.resultType, "input_required");
  const retry = {
    name: "confirm",
    requestState: first.requestState,
    inputResponses: { go: { action: "accept", content: { label: "x" } } },
  };
  for (const [who, intruder] of Object.entries(INTRUDERS)) {
    assertEquals(
      errorOf(await call(server, "tools/call", retry, intruder)),
      { code: -32602, message: "Invalid requestState" },
      who,
    );
  }
  // Anonymous callers lack the tool's scope before the state is even opened.
  await assertScopeRefused(
    call(server, "tools/call", retry, null),
    "anonymous",
  );
  const done = resultOf(await call(server, "tools/call", retry, OWNER));
  assertEquals(done.content, [{ type: "text", text: "confirmed x" }]);
});

Deno.test("there is no tasks/list to enumerate anyone's tasks", async () => {
  const { server } = ownedServer();
  await startJob(server, OWNER);
  for (const who of [OWNER, ...Object.values(INTRUDERS), null]) {
    assertEquals(
      errorOf(await call(server, "tasks/list", {}, who)).code,
      -32601,
    );
  }
});

Deno.test("the task record's owner is the key, with the tool's scopes and the principal", async () => {
  const inner = new UnsafeMemoryTaskStore();
  const created: TaskRecord[] = [];
  const store: TaskStore = {
    attach: (runner) => inner.attach(runner),
    create: (record) => {
      created.push(structuredClone(record));
      return inner.create(record);
    },
    get: (taskId, owner) => inner.get(taskId, owner),
    update: (taskId, owner, responses) =>
      inner.update(taskId, owner, responses),
    cancel: (taskId, owner) => inner.cancel(taskId, owner),
  };
  const { server, seen } = ownedServer({ store });
  await startJob(server, OWNER);
  assertEquals(created.length, 1);
  const record = created[0] as TaskRecord & { scopes?: unknown };
  assertEquals(record.owner, OWNER.key);
  assertEquals(record.scopes, ["tasks"]);
  assertEquals(record.principal?.key, OWNER.key);
  // The body runs as the principal that created the task.
  assertEquals(seen[0]?.key, OWNER.key);
  assertEquals(seen[0]?.issuer, "https://a.example");
});

Deno.test("a scope downgrade after creation is refused on every follow-up", async () => {
  const { server } = ownedServer();
  const { taskId } = await startJob(server, OWNER);
  assertEquals(WEAK.key, OWNER.key);

  await assertScopeRefused(
    call(server, "tasks/get", { taskId }, WEAK),
    "tasks/get",
  );
  await assertScopeRefused(
    call(server, "tasks/update", {
      taskId,
      inputResponses: { go: { action: "accept", content: { label: "w" } } },
    }, WEAK),
    "tasks/update",
  );
  await assertScopeRefused(
    call(server, "tasks/cancel", { taskId }, WEAK),
    "tasks/cancel",
  );
  let listenError: unknown = null;
  try {
    await listenAck(server, { taskIds: [taskId] }, WEAK);
  } catch (error) {
    listenError = error;
  }
  assert(
    listenError instanceof McpError && listenError.kind === "unauthorized",
    `listen: ${listenError}`,
  );
  // Nothing changed.
  assertEquals(
    resultOf(await call(server, "tasks/get", { taskId }, OWNER)).status,
    "input_required",
  );

  // Sealed state carries the scopes too.
  const first = resultOf(
    await call(server, "tools/call", { name: "confirm" }, OWNER),
  );
  await assertScopeRefused(
    call(server, "tools/call", {
      name: "confirm",
      requestState: first.requestState,
      inputResponses: { go: { action: "accept", content: { label: "w" } } },
    }, WEAK),
    "round two",
  );

  // A broader scope satisfies the stored one when the transport says so.
  const broad = toPrincipal(
    { ...OWNER_PARTS, scopes: ["tasks:admin"] },
    "bearer",
  );
  const implies = (granted: readonly string[], scope: string) =>
    granted.includes(scope) || granted.includes(`${scope}:admin`);
  await assertScopeRefused(
    call(server, "tasks/get", { taskId }, broad),
    "without the hierarchy",
  );
  assertEquals(
    resultOf(
      await call(server, "tasks/get", { taskId }, broad, {}, implies),
    ).status,
    "input_required",
  );
});

Deno.test("anonymous callers reach a task only with its token", async () => {
  const { server } = ownedServer();
  const created = resultOf(
    await call(server, "tools/call", { name: "open-job" }, null),
  );
  const taskId = created.taskId as string;
  const token = (created._meta as Record<string, unknown>)?.[TASK_TOKEN];
  assert(
    typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token),
    `token ${token}`,
  );
  const mine = { [TASK_TOKEN]: token };
  await pollStatus(server, taskId, "input_required", null, mine);

  // Another anonymous caller who learned the id, with no token or another.
  const other = resultOf(
    await call(server, "tools/call", { name: "open-job" }, null),
  );
  const otherToken = (other._meta as Record<string, unknown>)[TASK_TOKEN];
  for (
    const meta of [{}, { [TASK_TOKEN]: otherToken }, {
      [TASK_TOKEN]: "A".repeat(43),
    }]
  ) {
    const what = JSON.stringify(meta);
    const get = errorOf(
      await call(server, "tasks/get", { taskId }, null, meta),
    );
    assertEquals(get.code, -32602, what);
    assertEquals(
      errorOf(
        await call(
          server,
          "tasks/update",
          {
            taskId,
            inputResponses: {
              go: { action: "accept", content: { label: "mallory" } },
            },
          },
          null,
          meta,
        ),
      ).code,
      -32602,
      what,
    );
    assertEquals(
      errorOf(await call(server, "tasks/cancel", { taskId }, null, meta)).code,
      -32602,
      what,
    );
    const presented = (meta as Record<string, unknown>)[TASK_TOKEN];
    assertEquals(
      await listenAck(server, { taskIds: [taskId] }, null, {
        [TASK_TOKENS]: presented === undefined ? {} : { [taskId]: presented },
      }),
      {},
      what,
    );
  }
  assertEquals(
    errorOf(await call(server, "tasks/get", { taskId }, null)).message,
    `Failed to retrieve task: anonymous task operations need the task's token in _meta["${TASK_TOKEN}"]`,
  );
  // A malformed token is a params error, not a lookup.
  assertEquals(
    errorOf(
      await call(server, "tasks/get", { taskId }, null, { [TASK_TOKEN]: 7 }),
    ).code,
    -32602,
  );
  // Credentials do not stand in for the token: an anonymous task has no owner.
  assertEquals(
    errorOf(await call(server, "tasks/get", { taskId }, OWNER, mine)).message,
    "Failed to retrieve task: Task not found",
  );

  // The token holder listens, answers and finishes it.
  assertEquals(
    await listenAck(server, { taskIds: [taskId] }, null, {
      [TASK_TOKENS]: { [taskId]: token },
    }),
    { taskIds: [taskId] },
  );
  resultOf(
    await call(
      server,
      "tasks/update",
      {
        taskId,
        inputResponses: {
          go: { action: "accept", content: { label: "anon" } },
        },
      },
      null,
      mine,
    ),
  );
  const done = await pollStatus(server, taskId, "completed", null, mine);
  assertEquals((done.result as { content: unknown }).content, [{
    type: "text",
    text: "done anon",
  }]);
  // Authenticated tasks carry no token.
  const owned = resultOf(
    await call(server, "tools/call", { name: "open-job" }, OWNER),
  );
  assertEquals(
    (owned._meta as Record<string, unknown>)[TASK_TOKEN],
    undefined,
  );
});

Deno.test("idempotency slots belong to the principal's key", async () => {
  for (const [who, intruder] of Object.entries(INTRUDERS)) {
    const { server, runs } = ownedServer();
    const keyed = { [IDEMPOTENCY]: "same-key-0001" };
    const text = async (principal: Principal) =>
      (resultOf(
        await call(server, "tools/call", { name: "count" }, principal, keyed),
      ).content as { text: string }[])[0].text;
    assertEquals(await text(OWNER), "run 1", who);
    assertEquals(await text(intruder), "run 2", who);
    assertEquals(await text(OWNER), "run 1", `${who}: the stored answer`);
    assertEquals(await text(intruder), "run 2", `${who}: its own answer`);
    assertEquals(runs.count, 2, who);
  }
});

/**
 * An OAuth resource server trusting two issuers, whose tokens name the
 * same subject: `a1` (issuer A, client 1), `b1` (issuer B, client 1), `a2`
 * (issuer A, client 2), and `a1-weak` (as `a1`, without the scope).
 */
function twoIssuers(): ResourceServer {
  const tokens: Record<string, { issuer: string; clientId: string }> = {
    a1: { issuer: "https://a.example", clientId: "app-1" },
    b1: { issuer: "https://b.example", clientId: "app-1" },
    a2: { issuer: "https://a.example", clientId: "app-2" },
    "a1-weak": { issuer: "https://a.example", clientId: "app-1" },
  };
  return new ResourceServer({
    resource: "https://mcp.test/mcp",
    authorizationServers: ["https://a.example", "https://b.example"],
    scopesSupported: ["tasks"],
    dpop: false,
    verifier: {
      verify: (token) => {
        const found = Object.hasOwn(tokens, token) ? tokens[token] : undefined;
        if (found === undefined) {
          return Promise.reject(
            new ProtocolError("invalid_token", { status: 401 }),
          );
        }
        return Promise.resolve({
          subject: "user-1",
          scopes: token.endsWith("-weak") ? [] : ["tasks"],
          audience: ["https://mcp.test/mcp"],
          issuer: found.issuer,
          clientId: found.clientId,
          claims: { iss: found.issuer, sub: "user-1" },
        });
      },
    },
  });
}

function post(body: Record<string, unknown>, token: string): Request {
  const params = body.params as Record<string, unknown>;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": body.method as string,
    authorization: `Bearer ${token}`,
  };
  const name = params.name ?? params.taskId;
  if (typeof name === "string") headers["mcp-name"] = name;
  return new Request("https://mcp.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

Deno.test("over HTTP: two issuers and two clients with one subject, and a downgraded token", async () => {
  const { server } = ownedServer();
  const endpoint = mcpHttpHandler(server, {
    path: "/mcp",
    resource: twoIssuers(),
  });
  const send = async (token: string, method: string, params = {}) => {
    const response = await endpoint(
      post(request(method, params, { capabilities: CAPS }) as never, token),
    );
    return { status: response.status, response, body: await response.json() };
  };
  const created = await send("a1", "tools/call", { name: "job" });
  assertEquals(created.status, 200);
  const taskId = created.body.result.taskId as string;
  assertEquals(created.body.result._meta[TASK_TOKEN], undefined);
  for (let i = 0; i < 400; i++) {
    const got = await send("a1", "tasks/get", { taskId });
    if (got.body.result.status === "input_required") break;
    await sleep(5);
  }
  for (const token of ["b1", "a2"]) {
    for (const method of ["tasks/get", "tasks/cancel"]) {
      const { status, body } = await send(token, method, { taskId });
      assertEquals(status, 200, `${token} ${method}`);
      assertEquals(body.error.code, -32602, `${token} ${method}`);
    }
    const update = await send(token, "tasks/update", {
      taskId,
      inputResponses: { go: { action: "accept", content: { label: "m" } } },
    });
    assertEquals(update.body.error.code, -32602, `${token} tasks/update`);
  }
  const weak = await send("a1-weak", "tasks/get", { taskId });
  assertEquals(weak.status, 403);
  assertEquals(weak.body.error, "insufficient_scope");
  assertEquals(
    weak.response.headers.get("www-authenticate"),
    `Bearer error="insufficient_scope", error_description="Missing scopes: tasks", scope="tasks", resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"`,
  );
  const mine = await send("a1", "tasks/get", { taskId });
  assertEquals(mine.body.result.status, "input_required");
});
