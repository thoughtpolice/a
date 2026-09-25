// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The live test's client: drives the runtime-test Worker
 * (`tests/runtime/worker.ts`), deployed under `celld dev` on an exe.dev VM,
 * with the TypeScript client, over the network. `tests/live_run.py` runs it
 * twice: here, against `https://<vm>.exe.xyz` through exe.dev's HTTPS proxy
 * (authenticated to the proxy with a VM-scoped token in
 * `X-Exedev-Authorization`, which the proxy consumes, so it never collides
 * with MCP's own `Authorization`), and on the VM against localhost.
 *
 * Arguments: `--url <origin>`, `--where <label>`. The proxy token comes from
 * the `EXEDEV_TOKEN` environment variable and is never printed. Prints a
 * JSON report; exits 1 if any check failed.
 *
 * @module
 */

import {
  type ElicitResult,
  type FetchLike,
  McpClient,
  McpError,
  TaskHandle,
} from "@celld/mcp";
import { OAuthError } from "@celld/oauth";
import { OAuthSession } from "@celld/oauth/client";
import { testUserAgent } from "@celld/oauth/testing";

function flag(name: string, fallback: string): string {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : fallback;
}

const origin = new URL(flag("url", "http://127.0.0.1:8000")).origin;
const where = flag("where", "unknown");
const proxyToken = Deno.env.get("EXEDEV_TOKEN") ?? "";
const BEARER = "runtime-token";
const info = { name: "celld-mcp-live", version: "0.1.0" };

/** fetch, adding the proxy token to requests for the VM's origin. */
const fetcher: FetchLike = (input, init) => {
  const request = new Request(input, init);
  if (proxyToken !== "" && new URL(request.url).origin === origin) {
    request.headers.set("x-exedev-authorization", `Bearer ${proxyToken}`);
  }
  return fetch(request);
};

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: unknown;
}

const checks: Check[] = [];

function describe(error: unknown): unknown {
  if (error instanceof McpError) {
    return {
      ...error.toJSON(),
      cause: error.cause instanceof OAuthError
        ? error.cause.toJSON()
        : String(error.cause ?? ""),
    };
  }
  if (error instanceof OAuthError) return error.toJSON();
  return String(error);
}

async function check(
  name: string,
  body: () => Promise<unknown>,
  expect: (detail: unknown) => boolean = () => true,
): Promise<void> {
  const start = Date.now();
  try {
    const detail = await body();
    checks.push({ name, ok: expect(detail), ms: Date.now() - start, detail });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      ms: Date.now() - start,
      detail: describe(error),
    });
  }
}

function text(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

const elicited: string[] = [];
const client = McpClient.http(`${origin}/mcp`, {
  info,
  fetch: fetcher,
  headers: { authorization: `Bearer ${BEARER}` },
  tasks: { initialPollMs: 100 },
  handlers: {
    elicitation: (params): ElicitResult => {
      elicited.push(params.message);
      return params.message === "Your GitHub login?"
        ? { action: "accept", content: { login: "octocat" } }
        : { action: "accept", content: { ok: true } };
    },
  },
});

await check("discover", async () => {
  const found = await client.discover();
  return {
    versions: found.supportedVersions,
    extensions: found.capabilities.extensions,
  };
}, (d) =>
  JSON.stringify(d) ===
    JSON.stringify({
      versions: ["2026-07-28"],
      extensions: { "io.modelcontextprotocol/tasks": {} },
    }));

await check(
  "tools/list",
  async () => (await client.listAllTools()).map((tool) => tool.name),
  (d) => (d as string[]).join(",") === "add,build,echo,login,region,slow,spin",
);

await check("tools/call echo, structured add, Mcp-Param header", async () => ({
  echo: text(await client.callTool("echo", { text: "over the wire" })),
  add: (await client.callTool("add", { a: 20, b: 22 })).structuredContent,
  region: text(await client.callTool("region", { region: "eu-west" })),
}), (d) =>
  JSON.stringify(d) ===
    JSON.stringify({
      echo: "over the wire",
      add: { sum: 42 },
      region: "in eu-west",
    }));

await check(
  "MRTR elicitation round trip",
  async () => text(await client.callTool("login")),
  (d) => d === "hello octocat",
);

await check(
  "progress over SSE",
  async () => {
    const progress: number[] = [];
    const result = await client.callTool("slow", { steps: 3, tag: where }, {
      onProgress: (p) => progress.push(p.progress),
    });
    return { result: text(result), progress };
  },
  (d) =>
    JSON.stringify(d) ===
      JSON.stringify({ result: "finished 3", progress: [1, 2, 3] }),
);

await check(
  "resources/read and a missing resource",
  async () => {
    const config = await client.readResource("config://app");
    let missing = false;
    try {
      await client.readResource("config://missing");
    } catch (error) {
      missing = error instanceof McpError && error.resourceNotFound;
    }
    return { config: (config.contents[0] as { text: string }).text, missing };
  },
  (d) =>
    JSON.stringify(d) ===
      JSON.stringify({ config: '{"debug":true}', missing: true }),
);

await check("subscriptions/listen through McpChangeHub", async () => {
  const subscription = client.listen({ toolsListChanged: true });
  const acknowledged = await subscription.acknowledged;
  const published = await fetcher(`${origin}/admin/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "tools" }),
  });
  await published.body?.cancel();
  let notification = "";
  const timer = setTimeout(() => subscription.close(), 20_000);
  for await (const item of subscription) {
    notification = item.method;
    break;
  }
  clearTimeout(timer);
  subscription.close();
  return { acknowledged, notification };
}, (d) =>
  JSON.stringify(d) ===
    JSON.stringify({
      acknowledged: { toolsListChanged: true },
      notification: "notifications/tools/list_changed",
    }));

await check(
  "tasks: a tool run as a Durable Object task, with input",
  async () => {
    const statuses: string[] = [];
    let taskId = "";
    const result = await client.callTool("build", { target: where }, {
      onTask: (task) => {
        taskId = task.taskId;
      },
      onTaskStatus: (task) => statuses.push(task.status),
    });
    return {
      structured: result.structuredContent,
      statuses: [...new Set(statuses)],
      taskIdLength: taskId.length,
    };
  },
  (d) => {
    const detail = d as {
      structured: unknown;
      statuses: string[];
      taskIdLength: number;
    };
    return JSON.stringify(detail.structured) ===
        JSON.stringify({ artifact: `${where}.tar`, runs: 2 }) &&
      detail.statuses.includes("input_required") &&
      detail.statuses[detail.statuses.length - 1] === "completed" &&
      detail.taskIdLength === 24;
  },
);

await check("tasks: cancel", async () => {
  const started = await client.startToolCall("spin");
  if (started.type !== "task") throw new Error("expected a task");
  const task: TaskHandle = started.task;
  const before = (await task.get()).status;
  await task.cancel();
  let outcome = "";
  try {
    await task.result();
  } catch (error) {
    outcome = error instanceof McpError ? error.kind : String(error);
  }
  return { before, after: (await task.get()).status, outcome };
}, (d) =>
  JSON.stringify(d) ===
    JSON.stringify({
      before: "working",
      after: "cancelled",
      outcome: "task_cancelled",
    }));

await check("tasks: notifications/tasks on a listen stream", async () => {
  const listening = McpClient.http(`${origin}/mcp`, {
    info,
    fetch: fetcher,
    headers: { authorization: `Bearer ${BEARER}` },
    // Long polls, so the answer has to come from notifications.
    tasks: { notifications: true, initialPollMs: 60_000, maxPollMs: 60_000 },
    handlers: {
      elicitation: () => ({ action: "accept", content: { ok: true } }),
    },
  });
  const started = Date.now();
  const result = await listening.callTool("build", { target: "notified" });
  return { structured: result.structuredContent, ms: Date.now() - started };
}, (d) => {
  const detail = d as { structured: { artifact: string }; ms: number };
  return detail.structured.artifact === "notified.tar" && detail.ms < 30_000;
});

await check("bearer: missing and wrong tokens are refused", async () => {
  const outcome = async (headers: Record<string, string>) => {
    try {
      await McpClient.http(`${origin}/mcp`, { info, fetch: fetcher, headers })
        .listTools();
      return "accepted";
    } catch (error) {
      return error instanceof McpError
        ? `${error.kind} ${error.status} ${error.wwwAuthenticate}`
        : String(error);
    }
  };
  return {
    missing: await outcome({}),
    wrong: await outcome({ authorization: "Bearer nope" }),
  };
}, (d) => {
  const detail = d as { missing: string; wrong: string };
  return detail.missing.startsWith(
    "unauthorized 401 Bearer resource_metadata=",
  ) &&
    detail.wrong.includes('error="invalid_token"');
});

await check("oauth: 401, discovery, registration, PKCE, step-up", async () => {
  const agent = testUserAgent(fetcher);
  const auth = new OAuthSession({
    resource: `${origin}/oauth-mcp`,
    redirectUri: "http://127.0.0.1:8765/callback",
    registration: { dynamic: { client_name: "celld-mcp-live" } },
    userAgent: agent,
    fetch: fetcher,
  });
  const oauth = McpClient.http(`${origin}/oauth-mcp`, {
    info,
    fetch: fetcher,
    auth,
  });
  const whoami = JSON.parse(text(await oauth.callTool("whoami")));
  const write = text(await oauth.callTool("write", { text: "hi" }));
  // A tampered token is refused by the JWT validation.
  const token = (await auth.tokens())!.access_token;
  const tampered = token.slice(0, -6) +
    (token.endsWith("AAAAAA") ? "BBBBBB" : "AAAAAA");
  const refused = await fetcher(`${origin}/oauth-mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tampered}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  await refused.body?.cancel();
  return {
    whoami,
    write,
    issuer: auth.discovery?.issuer,
    resource: auth.discovery?.resource,
    scopes: agent.requests.map((r) => r.scopes.join(" ")),
    tampered: `${refused.status} ${refused.headers.get("www-authenticate")}`,
  };
}, (d) => {
  const detail = d as Record<string, unknown>;
  return JSON.stringify(detail.whoami) ===
      JSON.stringify({ subject: "oauth-user", scopes: ["mcp:read"] }) &&
    detail.write === "wrote hi" &&
    detail.issuer === `${origin}/oauth` &&
    detail.resource === `${origin}/oauth-mcp` &&
    JSON.stringify(detail.scopes) ===
      JSON.stringify(["mcp:read", "mcp:read mcp:write"]) &&
    String(detail.tampered).startsWith("401 ") &&
    String(detail.tampered).includes("invalid_token");
});

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify(
  {
    where,
    origin,
    viaProxy: proxyToken !== "",
    elicited,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  },
  null,
  2,
));
Deno.exit(failed.length === 0 ? 0 : 1);
