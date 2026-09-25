// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Regressions for the sweep of the process and storage families (WP-14)
// in `@celld/api/openai`. Each test names its finding (DB-SWP-F<n>-<k>).

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import {
  apiErrorFromEvent,
  apiErrorFromResponse,
  Conversation,
  ConversationConflictError,
  type ConversationData,
  functionTool,
  GptClient,
  GptDecodeError,
  integrationBaseUrl,
  kvConversationStore,
  memoryConversationStore,
  runAgent,
  type ToolCall,
  ToolRegistry,
} from "@celld/api/openai";
import {
  globMatcher,
  MemoryFileSystem,
  readOnlyTools,
} from "@celld/api/openai/coding";
import {
  FakeResponses,
  fakeStep,
  virtualRuntime,
} from "@celld/api/openai/testing";
import {
  DEFAULT_MUTATING_TOOLS_STEP,
  DEFAULT_TOOLS_STEP,
  runAgentWorkflow,
} from "@celld/api/openai/workflow";
import { v } from "@celld/sieve";

function fn(name: string, args: unknown): ToolCall {
  return {
    kind: "function",
    callId: `c-${name}`,
    name,
    arguments: JSON.stringify(args),
  };
}

// MARK: F14

// DB-SWP-F14-19: grep_files compiled the model's pattern with `new RegExp`
// and ran it in the isolate, where a backtracking pattern cannot be
// interrupted. Patterns are literal by default now; a regex needs a
// workspace that searches out of process (a sandbox), and is refused
// otherwise.
Deno.test("grep_files matches literally unless asked, and never runs a regex here", async () => {
  const fs = new MemoryFileSystem({
    "src/a.ts": "const x = eval(input);\nsafe();",
    "hostile.txt": `${"a".repeat(40)}!`,
  });
  const registry = new ToolRegistry(readOnlyTools(fs));
  const grep = async (args: Record<string, unknown>) =>
    (await registry.execute([fn("grep_files", {
      path: null,
      include: null,
      limit: null,
      regex: null,
      ...args,
    })]))[0];
  assertEquals(
    (await grep({ pattern: "eval(" })).output,
    "src/a.ts:1: const x = eval(input);",
  );
  const refused = await grep({ pattern: "(a+)+$", regex: true });
  assertEquals(refused.status, "error");
  assert(refused.output.includes("regular expression"), refused.output);
});

// DB-SWP-F14-20: globs became regular expressions built from the model's
// (or a caller's) text, and `**a**a**b` compiles to nested `.*`s that
// backtrack polynomially on a long path. Globs are matched directly now.
Deno.test("glob matching is linear in the path", () => {
  const glob = globMatcher(`${"**a".repeat(12)}b`);
  const started = performance.now();
  assert(!glob.test("a".repeat(3_000)), "no b");
  assert(performance.now() - started < 500, "matched in time");
  assert(glob.test(`${"a/".repeat(11)}ab`), "matches");
  assert(globMatcher("*.ts").test("src/a.ts"), "*.ts in a subdirectory");
  assert(!globMatcher("src/*.ts").test("src/deep/a.ts"), "* stops at /");
  assert(globMatcher("src/**/*.ts").test("src/deep/er/a.ts"), "**");
  assert(globMatcher("src/**/*.ts").test("src/a.ts"), "**/ matches nothing");
  assert(globMatcher("a?.md").test("ab.md"), "?");
  assert(!globMatcher("a?.md").test("abc.md"), "? is one character");
  assert(!globMatcher("a?.md").test("a/.md"), "? is not /");
  assert(globMatcher("[x].md").test("[x].md"), "brackets are literal");
});

// MARK: F9

// DB-SWP-F9-21: the fallback text of a policy error was looked up in a
// plain object by the server's `code`, so `constructor` or `toString`
// came back as a function's source in the error message.
Deno.test("an error code that names a prototype member has no fallback text", () => {
  for (const code of ["constructor", "toString", "__proto__", "valueOf"]) {
    const error = apiErrorFromResponse(
      403,
      JSON.stringify({ error: { code } }),
      new Headers(),
      null,
    );
    assert(!error.message.includes("native code"), error.message);
    assert(!error.message.includes("[object"), error.message);
    const event = apiErrorFromEvent({ code }, "the response failed", null);
    assert(!event.message.includes("native code"), event.message);
    assert(!event.message.includes("[object"), event.message);
  }
});

// MARK: F12

// DB-SWP-F12-22 (the WP-09 note): a tool batch step was retried up to
// twice when the step itself was interrupted, repeating whatever its
// mutating calls had already done. A batch with a mutating call is not
// retried now unless the caller opts in by name.
Deno.test("a tool batch that mutates is never retried by its step", async () => {
  const configs = new Map<string, WorkflowStepConfig>();
  const recording = (): WorkflowStep => {
    const step = fakeStep();
    return {
      ...step,
      do: ((name: string, config: WorkflowStepConfig, run: () => unknown) => {
        configs.set(name, config);
        return step.do(name, config, run);
      }) as WorkflowStep["do"],
    };
  };
  const tool = (mutates: boolean) =>
    functionTool({
      name: "t",
      description: "A tool.",
      parameters: v.object({}),
      mutates,
      run: () => "done",
    });
  const run = async (mutates: boolean, unsafe = false) => {
    const fake = new FakeResponses([
      { toolCalls: [{ name: "t", arguments: {}, callId: "c1" }] },
      { text: "ok" },
    ]);
    await runAgentWorkflow(recording(), mutates ? "m" : "r", {
      client: new GptClient({
        fetch: fake.fetch,
        runtime: virtualRuntime(),
        model: "gpt-5.5",
        retry: { maxRetries: 0 },
      }),
      conversation: new Conversation({ id: "wf" }).user("go"),
      tools: new ToolRegistry([tool(mutates)]),
      ...(unsafe ? { unsafeRetryMutatingTools: true } : {}),
    });
  };
  await run(true);
  assertEquals(configs.get("m:tools-0")?.retries?.limit, 0);
  assertEquals(configs.get("m:tools-0"), DEFAULT_MUTATING_TOOLS_STEP);
  await run(false);
  assertEquals(configs.get("r:tools-0"), DEFAULT_TOOLS_STEP);
  configs.clear();
  await run(true, true);
  assertEquals(configs.get("m:tools-0"), DEFAULT_TOOLS_STEP);
});

// DB-SWP-F12-23: a conversation store's `save` replaced the stored
// conversation unconditionally, so two requests that each loaded it, took
// a turn and saved lost one turn. `save` now states what it expects to
// replace (or that it overwrites).
Deno.test("a save that expects another stored conversation is refused", async () => {
  const store = memoryConversationStore();
  const first = new Conversation({ id: "t" }).user("one");
  await store.save(first.toJSON(), { expectedItems: null });
  await assertRejects(
    store.save(first.toJSON(), { expectedItems: null }),
    ConversationConflictError,
  );
  const loaded = (await store.load("t")) as ConversationData;
  const mine = Conversation.fromJSON(loaded).user("two");
  const theirs = Conversation.fromJSON(loaded).user("three");
  await store.save(mine.toJSON(), { expectedItems: loaded.items.length });
  const conflict = await assertRejects(
    store.save(theirs.toJSON(), { expectedItems: loaded.items.length }),
    ConversationConflictError,
  );
  assertEquals([conflict.expected, conflict.actual], [1, 2]);
  await store.save(theirs.toJSON(), { overwrite: true });
  assertEquals((await store.load("t"))?.items.length, 2);
  const kv = kvConversationStore({} as KVNamespace);
  await assertRejects(
    kv.save(first.toJSON(), { expectedItems: null }),
    TypeError,
    "compare",
  );
});

// ----- Second round (WP-14b): findings filed by the other sweepers -----

function throwsA(kind: ErrorConstructor, run: () => unknown): boolean {
  try {
    run();
  } catch (error) {
    return error instanceof kind;
  }
  return false;
}

// DB-SWP-F2-301 / DB-SWP-F16-13.6: `baseUrl` could be `http:` to any host,
// and `integrationBaseUrl` took an ad-hoc `scheme: "http"`. Cleartext is
// now only to a loopback host, under `allowLoopbackForDevelopment`.
Deno.test("DB-SWP-F16-13.6: the API root is https unless loopback for development", () => {
  for (
    const options of [
      { baseUrl: "http://api.example.com/v1" },
      { baseUrl: "http://127.0.0.1:9/v1" },
      { baseUrl: "http://10.0.0.1/v1", allowLoopbackForDevelopment: true },
      {
        baseUrl: "http://api.example.com/v1",
        allowLoopbackForDevelopment: true,
      },
      { baseUrl: "https://user:pw@api.example.com/v1" },
    ]
  ) {
    assert(
      throwsA(TypeError, () => new GptClient(options)),
      JSON.stringify(options),
    );
  }
  const dev = new GptClient({
    baseUrl: "http://127.0.0.1:9/v1",
    allowLoopbackForDevelopment: true,
  });
  assertEquals(dev.baseUrl, "http://127.0.0.1:9/v1");
  assert(
    throwsA(
      TypeError,
      () => GptClient.fromEnv({ OPENAI_BASE_URL: "http://127.0.0.1:9/v1" }),
    ),
    "fromEnv without the development flag",
  );
  assertEquals(
    GptClient.fromEnv({
      OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
      OPENAI_LOOPBACK_FOR_DEVELOPMENT: "true",
    }).baseUrl,
    "http://127.0.0.1:9/v1",
  );
  assert(
    throwsA(TypeError, () =>
      integrationBaseUrl(
        "llm",
        {
          domain: "int.test",
          scheme: "http",
        } as Parameters<typeof integrationBaseUrl>[1],
      )),
    "scheme http",
  );
});

// DB-SWP-F7-303: timeouts had no timer ceiling (past 2^31 - 1 ms a timer
// fires at once), `maxPacerWaitMs` was unchecked (NaN never gave up on the
// pacer), and the agent's budget took NaN (which never stops a run).
Deno.test("DB-SWP-F7-303: client timeouts, the pacer wait and budgets are checked", async () => {
  for (
    const options of [
      { connectTimeoutMs: 2 ** 31 },
      { idleTimeoutMs: 2 ** 31 },
      { leaseMs: 2 ** 31 },
      { maxPacerWaitMs: NaN },
      { maxPacerWaitMs: -1 },
      { maxPacerWaitMs: Infinity },
    ]
  ) {
    assert(
      throwsA(RangeError, () => new GptClient(options)),
      JSON.stringify(options),
    );
  }
  const client = new GptClient({ fetch: new FakeResponses().fetch });
  for (
    const budget of [
      { tokens: NaN },
      { tokens: -1 },
      { timeMs: NaN },
      { timeMs: Infinity },
    ]
  ) {
    await assertRejects(
      runAgent({
        client,
        conversation: new Conversation().user("go"),
        budget,
      }),
      RangeError,
    );
  }
});

// DB-SWP-F7-301: the pacer's `waitMs` came over RPC and was used unchecked:
// NaN slept 0 ms, a hot poll of the pacer. An answer that is not a wait is
// a pacer failure: reported, and the call goes ahead unpaced.
Deno.test("DB-SWP-F7-301: a pacer wait that is not a number is a pacer error", async () => {
  const fake = new FakeResponses([{ text: "ok" }]);
  let asked = 0;
  const errors: unknown[] = [];
  const client = new GptClient({
    fetch: fake.fetch,
    runtime: virtualRuntime(),
    pacer: {
      acquire: () => {
        asked++;
        return {
          granted: false,
          waitMs: NaN,
          reason: "busy",
          block: null,
        };
      },
      release: () => {},
    },
    onPacerError: (error) => errors.push(error),
  });
  const turn = await client.respond({ input: "hi" });
  assertEquals(turn.finalText, "ok");
  assertEquals(asked, 1);
  assertEquals(errors.length, 1);
  assert(errors[0] instanceof RangeError, String(errors[0]));
});

// DB-SWP-F7-301 (conversations): token counts and turns were taken as any
// number, so NaN reached the stored usage.
Deno.test("DB-SWP-F7-301: stored usage and turns must be counts", () => {
  const good = new Conversation({ id: "u" }).user("x").toJSON();
  for (
    const bad of [
      { ...good, usage: { ...good.usage, inputTokens: NaN } },
      { ...good, usage: { ...good.usage, totalTokens: -1 } },
      { ...good, usage: { ...good.usage, outputTokens: 1.5 } },
      { ...good, turns: Infinity },
    ]
  ) {
    assert(
      throwsA(
        GptDecodeError as unknown as ErrorConstructor,
        () => Conversation.fromJSON(bad),
      ),
      JSON.stringify(bad.usage),
    );
  }
  Conversation.fromJSON(good);
});

// DB-SWP-F8-301: kvConversationStore kept conversations forever unless the
// caller set a TTL. It now expires them after 30 days by default; keeping
// them is `ttlSeconds: null`, said out loud.
Deno.test("DB-SWP-F8-301: KV conversations expire by default", async () => {
  const puts: unknown[] = [];
  const kv = {
    put: (_key: string, _value: string, options?: unknown) => {
      puts.push(options);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  const data = new Conversation({ id: "k" }).user("x").toJSON();
  await kvConversationStore(kv).save(data, { overwrite: true });
  await kvConversationStore(kv, { ttlSeconds: null }).save(data, {
    overwrite: true,
  });
  assertEquals(puts, [{ expirationTtl: 30 * 86_400 }, undefined]);
  for (const ttlSeconds of [NaN, 10, -1, 1.5, 2 ** 40]) {
    assert(
      throwsA(RangeError, () => kvConversationStore(kv, { ttlSeconds })),
      String(ttlSeconds),
    );
  }
});
