// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  type ClientCapabilities,
  elicitForm,
  elicitUrl,
  InputRequired,
  listRoots,
  McpServer,
  missingCapabilities,
  type Principal,
  sampling,
  StateSealer,
} from "@celld/mcp";
import { testPrincipal } from "@celld/mcp/testing";
import {
  demoServer,
  errorOf,
  request,
  resultOf,
  SECRET,
  SERVER_INFO,
} from "./fixture.ts";

const FORM: ClientCapabilities = { elicitation: { form: {} } };

async function login(
  server: McpServer,
  extra: Record<string, unknown> = {},
  options: { capabilities?: ClientCapabilities; principal?: Principal | null } =
    {},
) {
  return await server.handle(
    request("tools/call", { name: "login", ...extra }, {
      capabilities: options.capabilities ?? FORM,
    }),
    { principal: options.principal ?? null },
  );
}

Deno.test("an elicitation round trip, as the spec's basic workflow", async () => {
  const server = demoServer();
  const first = resultOf(await login(server));
  assertEquals(first.resultType, "input_required");
  assertEquals(first.inputRequests, {
    github: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Your GitHub login?",
        requestedSchema: {
          type: "object",
          properties: { login: { type: "string" } },
          required: ["login"],
        },
      },
    },
  });
  assert(typeof first.requestState === "string", "requestState");
  // Interim results carry no caching hints.
  assertEquals([first.ttlMs, first.cacheScope], [undefined, undefined]);

  const done = resultOf(
    await login(server, {
      inputResponses: {
        github: { action: "accept", content: { login: "octocat" } },
      },
      requestState: first.requestState,
    }),
  );
  assertEquals(done.resultType, "complete");
  assertEquals(done.content, [{ type: "text", text: "hello octocat" }]);

  const declined = resultOf(
    await login(server, {
      inputResponses: { github: { action: "decline" } },
      requestState: first.requestState,
    }),
  );
  assertEquals(declined.content, [{ type: "text", text: "no login" }]);
});

Deno.test("requestState is opaque and tamper-evident", async () => {
  const server = demoServer();
  const first = resultOf(await login(server));
  const state = first.requestState as string;
  // The payload is encrypted: nothing of it is readable.
  assert(
    !atob(
      state.slice(3).replace(/-/g, "+").replace(/_/g, "/").padEnd(
        Math.ceil((state.length - 3) / 4) * 4,
        "=",
      ),
    ).includes("github"),
    "not readable",
  );
  const answer = { github: { action: "accept", content: { login: "x" } } };
  const flipped = state.slice(0, -2) +
    (state.at(-2) === "A" ? "B" : "A") + state.at(-1);
  for (const bad of [flipped, state + "A", "v1.", "v2." + state.slice(3), ""]) {
    assertEquals(
      errorOf(
        await login(server, { inputResponses: answer, requestState: bad }),
      ),
      { code: -32602, message: "Invalid requestState" },
      bad,
    );
  }
  // Another server's secret does not open it either.
  const other = demoServer({
    stateSecret: "another-secret-0123456789abcdefghij",
  });
  assertEquals(
    errorOf(await login(other, { inputResponses: answer, requestState: state }))
      .code,
    -32602,
  );
});

Deno.test("requestState is bound to the request, the principal and a deadline", async () => {
  let now = 1_000_000;
  const server = demoServer({ now: () => now, stateTtlMs: 1000 });
  const alice: Principal = testPrincipal("alice");
  const first = resultOf(await login(server, {}, { principal: alice }));
  const answer = { github: { action: "accept", content: { login: "x" } } };
  const retry = { inputResponses: answer, requestState: first.requestState };
  // A different principal cannot present it.
  assertEquals(
    errorOf(await login(server, retry, { principal: testPrincipal("mallory") }))
      .message,
    "Invalid requestState",
  );
  assertEquals(
    errorOf(await login(server, retry)).message,
    "Invalid requestState",
  );
  // Nor can a different request: other arguments, another tool.
  assertEquals(
    errorOf(
      await login(server, { ...retry, arguments: { extra: 1 } }, {
        principal: alice,
      }),
    )
      .message,
    "Invalid requestState",
  );
  assertEquals(
    errorOf(
      await server.handle(
        request("tools/call", {
          name: "echo",
          arguments: { text: "x" },
          ...retry,
        }),
        { principal: alice },
      ),
    ).message,
    "Invalid requestState",
  );
  assertEquals(
    resultOf(await login(server, retry, { principal: alice })).content,
    [{ type: "text", text: "hello x" }],
  );
  now += 1001;
  assertEquals(
    errorOf(await login(server, retry, { principal: alice })).message,
    "Expired requestState",
  );
});

Deno.test("answers count only for questions that were asked", async () => {
  const server = demoServer();
  const answer = { github: { action: "accept", content: { login: "forged" } } };
  // Without a requestState, inputResponses are ignored and the server asks.
  const unsolicited = resultOf(await login(server, { inputResponses: answer }));
  assertEquals(unsolicited.resultType, "input_required");
  // Answers to unasked keys are ignored too.
  const first = resultOf(await login(server));
  const wrongKey = resultOf(
    await login(server, {
      inputResponses: { other: { action: "accept" } },
      requestState: first.requestState,
    }),
  );
  assertEquals(wrongKey.resultType, "input_required");
  // A malformed answer to an asked key is invalid params.
  assertEquals(
    errorOf(
      await login(server, {
        inputResponses: { github: { action: "maybe" } },
        requestState: first.requestState,
      }),
    ),
    {
      code: -32602,
      message:
        'Invalid input response: params.inputResponses.github.action: expected "accept" or "decline" or "cancel", got "maybe"',
    },
  );
});

Deno.test("a submitted form must match the schema it was asked with", async () => {
  const server = demoServer();
  const first = resultOf(await login(server));
  assertEquals(
    errorOf(
      await login(server, {
        inputResponses: {
          github: { action: "accept", content: { user: "x" } },
        },
        requestState: first.requestState,
      }),
    ),
    {
      code: -32602,
      message:
        "Input response github does not match the requested schema: login: is required",
    },
  );
});

Deno.test("input requests need the client's capabilities", async () => {
  const server = demoServer();
  assertEquals(errorOf(await login(server, {}, { capabilities: {} })), {
    code: -32021,
    message: "Missing required client capability: elicitation",
    data: { requiredCapabilities: { elicitation: { form: {} } } },
  });
  // An empty elicitation capability means form mode.
  assertEquals(
    resultOf(await login(server, {}, { capabilities: { elicitation: {} } }))
      .resultType,
    "input_required",
  );
  assertEquals(
    errorOf(
      await login(server, {}, { capabilities: { elicitation: { url: {} } } }),
    ).code,
    -32021,
  );
  assertEquals(
    missingCapabilities({ elicitation: {} }, { elicitation: { url: {} } }),
    {
      elicitation: { url: {} },
    },
  );
  assertEquals(
    missingCapabilities({ sampling: {} }, { sampling: { tools: {} } }),
    { sampling: { tools: {} } },
  );
  assertEquals(
    missingCapabilities({ roots: {}, sampling: { tools: {} } }, {
      roots: {},
      sampling: { tools: {} },
    }),
    null,
  );
});

Deno.test("several rounds accumulate answers, with handler state", async () => {
  const server = new McpServer({ info: SERVER_INFO, stateSecret: SECRET });
  const runs: string[] = [];
  server.tool({
    name: "wizard",
    run: (_args, ctx) => {
      runs.push(`state=${JSON.stringify(ctx.state)}`);
      const name = ctx.elicit("name", {
        message: "Name?",
        requestedSchema: {
          type: "object",
          properties: { v: { type: "string" } },
        },
      });
      ctx.setState({ step: 2 });
      const both = ctx.ask({
        color: elicitForm("Color?", {
          type: "object",
          properties: { v: { type: "string" } },
        }),
        roots: listRoots(),
      });
      const roots = both.roots as { roots: { uri: string }[] };
      return `${name.content?.v}/${
        (both.color as { content?: { v?: string } }).content?.v
      }/${roots.roots.length}`;
    },
  });
  const caps = { elicitation: {}, roots: {} };
  const call = async (extra: Record<string, unknown> = {}) =>
    resultOf(
      await server.handle(
        request("tools/call", { name: "wizard", ...extra }, {
          capabilities: caps,
        }),
      ),
    );
  const one = await call();
  assertEquals(Object.keys(one.inputRequests as object), ["name"]);
  const two = await call({
    inputResponses: { name: { action: "accept", content: { v: "ada" } } },
    requestState: one.requestState,
  });
  // Both remaining questions come in one round.
  assertEquals(Object.keys(two.inputRequests as object), ["color", "roots"]);
  // The retry sends only this round's answers; "name" rides in the state.
  const three = await call({
    inputResponses: {
      color: { action: "accept", content: { v: "red" } },
      roots: { roots: [{ uri: "file:///a" }] },
    },
    requestState: two.requestState,
  });
  assertEquals(three.content, [{ type: "text", text: "ada/red/1" }]);
  assertEquals(runs, ["state=null", "state=null", 'state={"step":2}']);
});

Deno.test("load shedding: requestState alone, then the retry completes", async () => {
  const server = new McpServer({ info: SERVER_INFO, stateSecret: SECRET });
  server.tool({
    name: "busy",
    run: (_args, ctx) => {
      if (ctx.state === null) ctx.inputRequired({ state: { queued: true } });
      return `resumed with ${JSON.stringify(ctx.state)}`;
    },
  });
  const first = resultOf(
    await server.handle(request("tools/call", { name: "busy" })),
  );
  assertEquals(first.resultType, "input_required");
  assertEquals(first.inputRequests, undefined);
  const done = resultOf(
    await server.handle(
      request("tools/call", { name: "busy", requestState: first.requestState }),
    ),
  );
  assertEquals(done.content, [{
    type: "text",
    text: 'resumed with {"queued":true}',
  }]);
});

Deno.test("url elicitation, sampling and a thrown InputRequired", async () => {
  const server = new McpServer({ info: SERVER_INFO, stateSecret: SECRET });
  server.tool({
    name: "connect",
    run: (_args, ctx) => {
      const consent = ctx.elicit(
        "connect",
        elicitUrl("Connect your account", "https://example.com/connect?x=1")
          .params,
      );
      return consent.action;
    },
  });
  server.tool({
    name: "raw",
    run: () => {
      throw new InputRequired({
        s: sampling({
          messages: [{ role: "user", content: { type: "text", text: "2+2?" } }],
          maxTokens: 5,
          tools: [],
        }),
      });
    },
  });
  const url = resultOf(
    await server.handle(
      request("tools/call", { name: "connect" }, {
        capabilities: { elicitation: { url: {} } },
      }),
    ),
  );
  assertEquals(url.inputRequests, {
    connect: {
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Connect your account",
        url: "https://example.com/connect?x=1",
      },
    },
  });
  // Sampling with tools needs sampling.tools, checked even for a raw throw.
  assertEquals(
    errorOf(
      await server.handle(request("tools/call", { name: "raw" }, {
        capabilities: { sampling: {} },
      })),
    ).data,
    { requiredCapabilities: { sampling: { tools: {} } } },
  );
  assertEquals(
    resultOf(
      await server.handle(request("tools/call", { name: "raw" }, {
        capabilities: { sampling: { tools: {} } },
      })),
    ).resultType,
    "input_required",
  );
});

Deno.test("prompts and resources can ask for input too; lists cannot", async () => {
  const reported: unknown[] = [];
  const server = new McpServer({
    info: SERVER_INFO,
    stateSecret: SECRET,
    onError: (error) => reported.push(error),
  });
  server.prompt({
    name: "p",
    get: (_args, ctx) => {
      const answer = ctx.elicit("q", {
        message: "?",
        requestedSchema: { type: "object", properties: {} },
      });
      return [{ role: "user", content: { type: "text", text: answer.action } }];
    },
  });
  server.resource({
    uri: "x://gated",
    name: "gated",
    read: (ctx) => ctx.inputRequired({ state: 1 }),
  });
  const prompt = resultOf(
    await server.handle(
      request("prompts/get", { name: "p" }, { capabilities: FORM }),
    ),
  );
  assertEquals(prompt.resultType, "input_required");
  const read = resultOf(
    await server.handle(request("resources/read", { uri: "x://gated" })),
  );
  assertEquals(read.resultType, "input_required");
  // An input-required read carries no caching hints.
  assertEquals(read.ttlMs, undefined);
});

Deno.test("asking for input without a stateSecret is a server bug", async () => {
  const reported: unknown[] = [];
  const server = demoServer({
    stateSecret: undefined,
    onError: (error) => reported.push(error),
  });
  assertEquals(errorOf(await login(server)), {
    code: -32603,
    message: "Internal error",
  });
  assertEquals(
    (reported[0] as Error).message,
    "a handler asked for input, but the server has no stateSecret",
  );
});

Deno.test("the sealer round-trips and rejects short secrets", async () => {
  let threw = false;
  try {
    new StateSealer("short");
  } catch {
    threw = true;
  }
  assert(threw, "short secret");
  const sealer = new StateSealer(SECRET);
  const payload = {
    method: "tools/call",
    digest: "d",
    principal: null,
    expiresAt: 5,
    asked: { k: "roots/list" },
    answers: {},
    state: { n: [1, 2] },
  };
  const token = await sealer.seal(payload);
  assertEquals(await sealer.open(token), payload);
  // Each seal uses a fresh nonce.
  assert(token !== await sealer.seal(payload), "fresh nonce");
});
