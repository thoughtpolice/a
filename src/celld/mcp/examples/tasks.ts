// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Long-running tools as tasks, run by a Durable Object per task.
 *
 * `POST /mcp` serves two task tools (the `io.modelcontextprotocol/tasks`
 * extension, which a client declares in its capabilities):
 *
 * - `build` answers at once with a task handle (`resultType: "task"`, a
 *   `taskId`, `pollIntervalMs`). The body runs in the `McpTasks` Durable
 *   Object, from its alarm: it asks for a confirmation, which a client sees
 *   as `status: "input_required"` on `tasks/get` and answers with
 *   `tasks/update`; the body then runs again from the top with the answer
 *   and finishes, and `tasks/get` returns the result;
 * - `soak` works until it is cancelled with `tasks/cancel`, reporting each
 *   round as the task's `statusMessage`.
 *
 * Task changes also go out as `notifications/tasks` on
 * `subscriptions/listen` streams, fed by the `McpChangeHub` Durable Object.
 * A listen stream first sends each watched task's current state, so a
 * change made before it opened is not missed; this server closes listen
 * streams gracefully after `LISTEN_LIFETIME_MS`, and clients listen again.
 *
 * ```sh
 * buck2 run root//src/celld/mcp/examples:tasks-dev
 * ```
 *
 * @module
 */

import {
  type ChangeHubApi,
  durableChangeSource,
  durableTaskStore,
  mcpHttpHandler,
  McpServer,
  type TaskObjectApi,
  ToolError,
} from "@celld/mcp";
import { v } from "@celld/sieve";
import { McpTaskObject } from "@celld/mcp/durable";

export { McpChangeHub } from "@celld/mcp/durable";

interface Env {
  readonly MCP_CHANGES: DurableObjectNamespace<ChangeHubApi>;
  readonly MCP_TASKS: DurableObjectNamespace<TaskObjectApi>;
  readonly MCP_STATE_SECRET: string;
  readonly LISTEN_LIFETIME_MS?: string;
}

/** Runs the task bodies, one object per task. */
export class McpTasks extends McpTaskObject<Env> {
  taskServer(): McpServer {
    return (built ??= build(this.env)).server;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function build(env: Env) {
  const server = new McpServer({
    info: { name: "builder", version: "1.0.0" },
    stateSecret: env.MCP_STATE_SECRET,
    changes: durableChangeSource(env.MCP_CHANGES),
    listenLifetimeMs: Number(env.LISTEN_LIFETIME_MS ?? 60_000),
    tasks: { store: durableTaskStore(env.MCP_TASKS), pollIntervalMs: 100 },
  });

  server.tool({
    name: "build",
    description: "Builds a target after a confirmation, as a task.",
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
        // `ctx.run` counts the body's runs: one up to the question, one after.
        return {
          structuredContent: { artifact: `${target}.tar`, runs: ctx.run },
        };
      },
    },
  });

  server.tool({
    name: "soak",
    description: "Runs a soak test until cancelled.",
    task: {
      ttlMs: 600_000,
      run: async (_args, ctx) => {
        let round = 0;
        while (!ctx.signal.aborted) {
          await ctx.status(`round ${++round}`);
          await sleep(100, ctx.signal);
        }
        return `stopped after ${round} rounds`;
      },
    },
  });

  return { server, handler: mcpHttpHandler(server, { path: "/mcp" }) };
}

let built: ReturnType<typeof build> | null = null;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    built ??= build(env);
    return built.handler(request);
  },
};
