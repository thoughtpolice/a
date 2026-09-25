// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A Worker that serves an MCP server from `@celld/mcp` on the real celld
 * runtime, for `tests/runtime_test.py`:
 *
 * - `POST /mcp`: the Streamable HTTP endpoint, behind a bearer token (a
 *   `ResourceServer` with a verifier of its own, Bearer only), with listen
 *   streams fed by the `McpChangeHub` Durable Object, and tasks kept and
 *   run by the `McpTasks` Durable Object (one per task).
 * - `GET /.well-known/oauth-protected-resource/mcp`: its metadata document.
 * - `POST /admin/publish`: publishes a change event to the hub (a test
 *   hook, not something to expose in a real Worker).
 * - `GET /client-check?target=...`: runs the TypeScript client against the
 *   endpoint over real fetch and reports what it saw, the client-to-server
 *   end-to-end half of the test.
 * - `POST /oauth-mcp`: a second MCP server behind OAuth, validating RFC 9068
 *   access tokens (audience, issuer, expiry, per-tool scopes) from
 *   `@celld/oauth`'s authorization server, in memory, at `/oauth`
 *   (metadata at `/.well-known/oauth-authorization-server/oauth`), with its
 *   Protected Resource Metadata at
 *   `/.well-known/oauth-protected-resource/oauth-mcp`. Both, and the
 *   `/mcp` resource server, are built per public origin
 *   (`X-Forwarded-Proto`/`-Host` when a proxy such as exe.dev's sets them),
 *   so tokens and challenges name the URL the client used.
 * - `GET /oauth-check?target=...`: runs `OAuthSession` as the MCP client's
 *   auth against that endpoint: a 401, discovery, dynamic registration,
 *   a pushed authorization request with PKCE, and a step-up.
 *
 * The live test on an exe.dev VM (`:live-run`) deploys this same project.
 *
 * @module
 */

import {
  type ChangeEvent,
  type ChangeHubApi,
  durableChangeSource,
  durableTaskStore,
  type ElicitResult,
  McpClient,
  McpError,
  mcpHeader,
  mcpHttpHandler,
  McpServer,
  type TaskObjectApi,
  ToolError,
} from "@celld/mcp";
import { v } from "@celld/sieve";
import { McpTaskObject } from "@celld/mcp/durable";
import { ProtocolError } from "@celld/oauth";
import { OAuthSession } from "@celld/oauth/client";
import { jwtAccessTokenVerifier, ResourceServer } from "@celld/oauth/resource";
import { oauthSchemes } from "@celld/oauth/router";
import { publicJwks } from "@celld/oauth/server";
import {
  type TestAuthorizationServer,
  testAuthorizationServer,
  testUserAgent,
} from "@celld/oauth/testing";

export { McpChangeHub } from "@celld/mcp/durable";

interface Env {
  MCP_CHANGES: DurableObjectNamespace<ChangeHubApi>;
  MCP_TASKS: DurableObjectNamespace<TaskObjectApi>;
  MCP_STATE_SECRET: string;
}

const TOKEN = "runtime-token";
const OTHER_TOKEN = "other-token";

/** Runs the server's task bodies, one object per task. */
export class McpTasks extends McpTaskObject<Env> {
  taskServer(): McpServer {
    return (built ??= build(this.env)).server;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function build(env: Env) {
  const changes = durableChangeSource(env.MCP_CHANGES, "default", {
    waitMs: 5000,
  });
  const server = new McpServer({
    info: { name: "celld-mcp-runtime", version: "0.1.0" },
    instructions: "A test server.",
    stateSecret: env.MCP_STATE_SECRET,
    changes,
    cache: { ttlMs: 30000, scope: "public" },
    tasks: { store: durableTaskStore(env.MCP_TASKS), pollIntervalMs: 100 },
  });
  server.tool({
    name: "echo",
    description: "Echoes its text.",
    input: v.strictObject({ text: v.string() }),
    run: ({ text }) => text,
  });
  server.tool({
    name: "add",
    input: v.strictObject({ a: v.int(), b: v.int() }),
    output: v.strictObject({ sum: v.int() }),
    run: ({ a, b }) => ({ structuredContent: { sum: a + b } }),
  });
  server.tool({
    name: "region",
    input: v.strictObject({ region: mcpHeader(v.string(), "Region") }),
    run: ({ region }) => `in ${region}`,
  });
  server.tool({
    name: "login",
    run: (_args, ctx) => {
      const answer = ctx.elicit("github", {
        mode: "form",
        message: "Your GitHub login?",
        requestedSchema: {
          type: "object",
          properties: { login: { type: "string" } },
          required: ["login"],
        },
      });
      if (answer.action !== "accept") throw new ToolError("login declined");
      return `hello ${answer.content?.login}`;
    },
  });
  server.tool({
    name: "slow",
    description: "Reports progress every 100 ms until done or cancelled.",
    input: v.strictObject({ steps: v.int().min(1), tag: v.string() }),
    run: async ({ steps, tag }, ctx) => {
      for (let step = 1; step <= steps; step++) {
        ctx.progress(step, { total: steps });
        const stopped = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 100);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve(true);
          }, { once: true });
        });
        if (stopped) {
          // Report the cancellation where the test can see it.
          await changes.publish({
            type: "resource",
            uri: `cancelled://${tag}`,
          });
          throw ctx.signal.reason ?? new Error("cancelled");
        }
      }
      return `finished ${steps}`;
    },
  });
  server.tool({
    name: "build",
    description: "Builds after a confirmation, as a task.",
    input: v.strictObject({ target: v.string() }),
    output: v.strictObject({ artifact: v.string(), runs: v.int() }),
    task: {
      run: async ({ target }, ctx) => {
        await ctx.status(`preparing ${target}`);
        const answer = ctx.elicit("confirm", {
          mode: "form",
          message: `Build ${target}?`,
          requestedSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        });
        if (answer.content?.ok !== true) throw new ToolError("not confirmed");
        await ctx.status(`building ${target}`);
        await sleep(200, ctx.signal);
        return {
          structuredContent: { artifact: `${target}.tar`, runs: ctx.run },
        };
      },
    },
  });
  server.tool({
    name: "spin",
    description: "Works until cancelled.",
    task: {
      ttlMs: 60_000,
      run: async (_args, ctx) => {
        let round = 0;
        while (!ctx.signal.aborted) {
          await ctx.status(`round ${++round}`);
          await sleep(100, ctx.signal);
        }
        return "stopped";
      },
    },
  });
  server.resource({
    uri: "config://app",
    name: "config",
    mimeType: "application/json",
    read: () => '{"debug":true}',
  });
  // One endpoint per public origin, since the resource names it.
  const handlers = new Map<string, (request: Request) => Promise<Response>>();
  const handler = (request: Request, origin: string) => {
    let found = handlers.get(origin);
    if (found === undefined) {
      const resource = tokenResource(`${origin}/mcp`);
      found = mcpHttpHandler(server, {
        path: "/mcp",
        resource,
        auth: oauthSchemes(resource, { publicUrl: (c) => publicUrl(c.req) }),
        keepAliveMs: 1000,
      });
      handlers.set(origin, found);
    }
    return found(request);
  };
  return { changes, handler, server };
}

let built: ReturnType<typeof build> | null = null;

/** A resource server accepting the two fixed tokens, as Bearer only. */
function tokenResource(resource: string): ResourceServer {
  return new ResourceServer({
    resource,
    authorizationServers: ["https://auth.example"],
    scopesSupported: ["mcp"],
    dpop: false,
    verifier: {
      verify(token) {
        const subject = token === TOKEN
          ? "tester"
          : token === OTHER_TOKEN
          ? "other"
          : null;
        if (subject === null) {
          return Promise.reject(
            new ProtocolError("invalid_token", {
              status: 401,
              description: "unknown token",
            }),
          );
        }
        return Promise.resolve({
          subject,
          scopes: [],
          audience: [resource],
          claims: {},
        });
      },
    },
  });
}

/** The origin the client used, as a trusted proxy reports it. */
function publicOrigin(request: Request): string {
  const host = request.headers.get("x-forwarded-host");
  const proto = request.headers.get("x-forwarded-proto");
  return host !== null && proto !== null
    ? `${proto}://${host}`
    : new URL(request.url).origin;
}

/** The URL the client used: what a DPoP proof's `htu` names. */
function publicUrl(request: Request): URL {
  const url = new URL(request.url);
  return new URL(url.pathname + url.search, publicOrigin(request));
}

interface OAuthSite {
  readonly as: TestAuthorizationServer;
  readonly handler: (request: Request) => Promise<Response>;
}

const sites = new Map<string, Promise<OAuthSite>>();

/** The fake authorization server and the OAuth-protected MCP server for an origin. */
function oauthSite(origin: string): Promise<OAuthSite> {
  let site = sites.get(origin);
  if (site === undefined) {
    site = (async () => {
      // Dynamic registration is on, for the client; consent grants what
      // was asked for.
      const as = await testAuthorizationServer({
        issuer: `${origin}/oauth`,
        registration: {},
        consent: () => ({ grant: { subject: "oauth-user" } }),
      });
      const server = new McpServer({
        info: { name: "celld-mcp-runtime-oauth", version: "0.1.0" },
      });
      server.tool({
        name: "whoami",
        description: "Who the access token says the caller is.",
        run: (_args, ctx) =>
          JSON.stringify({
            subject: ctx.principal?.subject,
            scopes: ctx.principal?.scopes,
          }),
      });
      server.tool({
        name: "write",
        description: "Needs the mcp:write scope.",
        input: v.strictObject({ text: v.string() }),
        scopes: ["mcp:write"],
        run: ({ text }) => `wrote ${text}`,
      });
      const resource = new ResourceServer({
        resource: `${origin}/oauth-mcp`,
        authorizationServers: [as.server.issuer],
        scopesSupported: ["mcp:read"],
        verifier: jwtAccessTokenVerifier({
          issuer: as.server.issuer,
          audience: `${origin}/oauth-mcp`,
          keys: publicJwks(as.keys),
        }),
        // Bearer only: the client below has no DPoP key, and the test reads
        // the challenge as it is.
        dpop: false,
      });
      return {
        as,
        handler: mcpHttpHandler(server, {
          path: "/oauth-mcp",
          resource,
          auth: oauthSchemes(resource, {
            publicUrl: (c) => publicUrl(c.req),
          }),
        }),
      };
    })();
    sites.set(origin, site);
  }
  return site;
}

/** The OAuth client's view: a 401, discovery, registration, authorization, step-up. */
async function oauthCheck(target: string): Promise<Response> {
  const fetcher = (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, init);
  const agent = testUserAgent(fetcher);
  const auth = new OAuthSession({
    resource: target,
    redirectUri: "http://127.0.0.1:1/callback",
    registration: { dynamic: { client_name: "celld-mcp-runtime-client" } },
    userAgent: agent,
    fetch: fetcher,
  });
  const client = McpClient.http(target, {
    info: { name: "celld-mcp-runtime-oauth-client", version: "0.1.0" },
    auth,
  });
  const whoami = await client.callTool("whoami");
  const write = await client.callTool("write", { text: "hi" });
  return json({
    whoami: JSON.parse((whoami.content[0] as { text: string }).text),
    write: write.content,
    issuer: auth.discovery?.issuer,
    resource: auth.discovery?.resource,
    scopes: agent.requests.map((r) => r.scopes.join(" ")),
    resources: agent.requests.map((r) => r.resource),
    // Pushed (RFC 9126), so the URL carries only the request_uri; the
    // PKCE challenge went in the pushed request.
    pushed: agent.requests.map((r) => r.url.searchParams.has("request_uri")),
  });
}

/**
 * `request`, addressed to the public origin, for the authorization server,
 * which builds its URLs from the request. The MCP endpoints take the
 * public URL through `oauthSchemes`' `publicUrl` instead.
 */
function atOrigin(request: Request): Request {
  return new Request(publicUrl(request).href, request);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The client's view of the endpoint, over real fetch. */
async function clientCheck(target: string, env: Env): Promise<Response> {
  const { changes } = built ??= build(env);
  const elicited: unknown[] = [];
  const client = McpClient.http(target, {
    info: { name: "celld-mcp-runtime-client", version: "0.1.0" },
    headers: { authorization: `Bearer ${TOKEN}` },
    tasks: { initialPollMs: 50 },
    handlers: {
      elicitation: (params): ElicitResult => {
        elicited.push(params.message);
        return params.message === "Your GitHub login?"
          ? { action: "accept", content: { login: "octocat" } }
          : { action: "accept", content: { ok: true } };
      },
    },
  });
  const report: Record<string, unknown> = {};
  const discovered = await client.discover();
  report.versions = discovered.supportedVersions;
  report.tools = (await client.listAllTools()).map((tool) => tool.name);
  report.echo = (await client.callTool("echo", { text: "hi" })).content;
  report.add =
    (await client.callTool("add", { a: 2, b: 40 })).structuredContent;
  report.region =
    (await client.callTool("region", { region: "eu-west" })).content;
  report.login = (await client.callTool("login")).content;
  const statuses: string[] = [];
  report.build = (await client.callTool("build", { target: "app" }, {
    onTaskStatus: (task) => statuses.push(task.status),
  })).structuredContent;
  report.buildStatuses = [...new Set(statuses)];
  report.elicited = elicited;
  const progress: number[] = [];
  report.slow = (await client.callTool("slow", { steps: 3, tag: "client" }, {
    onProgress: (p) => progress.push(p.progress),
  })).content;
  report.progress = progress;
  report.config = (await client.readResource("config://app")).contents;
  try {
    await client.readResource("config://missing");
  } catch (error) {
    report.missing = error instanceof McpError && error.resourceNotFound;
  }
  const subscription = client.listen({ toolsListChanged: true });
  report.acknowledged = await subscription.acknowledged;
  await changes.publish({ type: "tools" });
  for await (const notification of subscription) {
    report.notification = notification.method;
    break;
  }
  return json(report);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    built ??= build(env);
    if (url.pathname === "/admin/publish" && request.method === "POST") {
      await built.changes.publish(await request.json() as ChangeEvent);
      return json({ ok: true });
    }
    if (
      url.pathname === "/oauth-mcp" ||
      url.pathname === "/.well-known/oauth-protected-resource/oauth-mcp" ||
      url.pathname.startsWith("/oauth/") ||
      url.pathname === "/.well-known/oauth-authorization-server/oauth"
    ) {
      const origin = publicOrigin(request);
      const site = await oauthSite(origin);
      return url.pathname.includes("oauth-mcp")
        ? await site.handler(request)
        : await site.as.handle(atOrigin(request));
    }
    if (url.pathname === "/oauth-check") {
      const target = url.searchParams.get("target");
      if (target === null) return json({ error: "missing ?target=" }, 400);
      try {
        return await oauthCheck(target);
      } catch (error) {
        return json({
          error: error instanceof McpError
            ? { ...error.toJSON(), cause: String(error.cause) }
            : String(error),
        }, 500);
      }
    }
    if (url.pathname === "/client-check") {
      const target = url.searchParams.get("target");
      if (target === null) return json({ error: "missing ?target=" }, 400);
      try {
        return await clientCheck(target, env);
      } catch (error) {
        return json({
          error: error instanceof McpError ? error.toJSON() : String(error),
        }, 500);
      }
    }
    return await built.handler(request, publicOrigin(request));
  },
};
