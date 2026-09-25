// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A Worker that exercises `@celld/api/openai` on the real celld runtime: the
 * client streaming over real `fetch`, the `GptPacer` and `GptConversations`
 * Durable Objects over RPC, and an agent run inside a Workflow.
 * `tests/runtime_test.py` drives it against a fake Codex-style Responses
 * server whose address each request names in `?base=`, since its port is
 * only known once the test has bound it. This is a test fixture, not an
 * example of taking a base URL from a request.
 *
 * @module
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import {
  Conversation,
  type ConversationsApi,
  durableConversationStore,
  durablePacer,
  functionTool,
  GptClient,
  type PacerApi,
  runAgent,
  ToolRegistry,
} from "@celld/api/openai";
import { applyPatchTool, MemoryFileSystem } from "@celld/api/openai/coding";
import { runAgentWorkflow } from "@celld/api/openai/workflow";
import { v } from "@celld/sieve";

export { GptConversations, GptPacer } from "@celld/api/openai/durable";

interface Env {
  GPT_PACER: DurableObjectNamespace<PacerApi>;
  GPT_CONVERSATIONS: DurableObjectNamespace<ConversationsApi>;
  AGENT: Workflow<AgentParams, unknown>;
}

interface AgentParams {
  readonly base: string;
  readonly task: string;
}

const lookup = functionTool({
  name: "lookup",
  description: "Looks a key up.",
  parameters: v.object({ key: v.string() }),
  risk: "read",
  run: ({ key }) => `value-of-${key}`,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(env: Env, url: URL): GptClient {
  const base = url.searchParams.get("base");
  if (base === null) throw new Error("missing ?base=");
  return new GptClient({
    baseUrl: base,
    pacer: durablePacer(
      env.GPT_PACER,
      url.searchParams.get("pacer") ?? "default",
    ),
    retry: {
      backoffInitialMs: 50,
      backoffMaxMs: 200,
      maxRetries: Number(url.searchParams.get("retries") ?? 2),
    },
    idleTimeoutMs: Number(url.searchParams.get("idle") ?? 10_000),
    connectTimeoutMs: 10_000,
  });
}

/** Runs the agent over a stored conversation, one Workflow step per turn and tool batch. */
export class AgentWorkflow extends WorkflowEntrypoint<Env, AgentParams> {
  async run(event: WorkflowEvent<AgentParams>, step: WorkflowStep) {
    const gpt = new GptClient({
      baseUrl: event.payload.base,
      retry: { maxRetries: 0 },
    });
    const result = await runAgentWorkflow(step, "agent", {
      client: gpt,
      conversation: new Conversation({ id: `wf-${event.instanceId}` }).user(
        event.payload.task,
      ),
      tools: new ToolRegistry([lookup]),
      turnStep: {
        retries: { limit: 2, delay: "1 second", backoff: "constant" },
        timeout: "1 minute",
      },
    });
    return {
      stopReason: result.stopReason,
      text: result.text,
      turns: result.turns,
    };
  }
}

async function respond(
  env: Env,
  url: URL,
  request: Request,
): Promise<Response> {
  const body = await request.json() as { input: string; stream?: boolean };
  const gpt = client(env, url);
  if (!body.stream) {
    return json({ outcome: await gpt.tryRespond({ input: body.input }) });
  }
  const events: string[] = [];
  const deltas: string[] = [];
  try {
    const stream = gpt.stream({ input: body.input });
    for await (const event of stream) {
      events.push(event.type);
      if (event.type === "text.delta") deltas.push(event.delta);
    }
    return json({
      outcome: { ok: true, result: await stream.result },
      events,
      deltas,
    });
  } catch (error) {
    return json({
      outcome: { ok: false, error: (error as { toJSON(): unknown }).toJSON() },
      events,
      deltas,
    });
  }
}

async function agent(env: Env, url: URL, request: Request): Promise<Response> {
  const body = await request.json() as { id: string; task: string };
  const store = durableConversationStore(env.GPT_CONVERSATIONS, "runtime");
  const stored = await store.load(body.id);
  const conversation = stored === null
    ? new Conversation({ id: body.id, instructions: "You are a lookup agent." })
    : Conversation.fromJSON(stored);
  conversation.user(body.task);
  const fs = new MemoryFileSystem({ "notes.txt": "draft\n" });
  const result = await runAgent({
    client: client(env, url),
    conversation,
    tools: new ToolRegistry([lookup, applyPatchTool(fs)]),
    maxTurns: 5,
  });
  await store.save(conversation.toJSON());
  return json({ result, files: fs.snapshot() });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pacer = env.GPT_PACER.getByName(
      url.searchParams.get("pacer") ?? "default",
    );
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /respond":
          return await respond(env, url, request);
        case "POST /structured": {
          const { input } = await request.json() as { input: string };
          const schema = v.object({
            verdict: v.enum(["yes", "no"]),
            score: v.number().min(0).max(1),
          });
          const outcome = await client(env, url).tryStructured({
            input,
            schema,
            name: "verdict",
          });
          if (!outcome.ok) return json(outcome);
          // Reading the typed value here is the compile-time half of the test.
          const verdict: "yes" | "no" = outcome.result.value.verdict;
          return json({ ok: true, verdict, score: outcome.result.value.score });
        }
        case "GET /models":
          return json(await client(env, url).models.list());
        case "POST /agent":
          return await agent(env, url, request);
        case "GET /conversation":
          return json(
            await durableConversationStore(env.GPT_CONVERSATIONS, "runtime")
              .load(url.searchParams.get("id")!),
          );
        case "GET /pacer":
          return json(await pacer.snapshot());
        case "POST /pacer":
          return json(await pacer.configure(await request.json()));
        case "POST /pacer/unblock":
          await pacer.unblock();
          return json({ ok: true });
        case "POST /workflow": {
          const { id, task } = await request.json() as {
            id: string;
            task: string;
          };
          const instance = await env.AGENT.create({
            id,
            params: { base: url.searchParams.get("base")!, task },
          });
          return json({ id: instance.id });
        }
        case "GET /workflow": {
          const instance = await env.AGENT.get(url.searchParams.get("id")!);
          return json(await instance.status());
        }
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({
        error: String(error),
        stack: (error as Error).stack ?? null,
      }, 500);
    }
  },
};
