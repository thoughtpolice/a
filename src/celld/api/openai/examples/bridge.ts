// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Jev as the control plane around GPT, with `@celld/api/openai/jev`.
 *
 * `POST /tasks` with `{"task"}` runs a small database assistant in three
 * Jev-guided steps, each a single typed question to Jev whose calibrated
 * probability the result carries:
 *
 * 1. `routeEffort` picks the reasoning effort for the task; when Jev is not
 *    confident enough it falls back to `high` and says it did not decide.
 * 2. The agent runs with a `run_sql` tool gated by `jevApprover`: Jev judges
 *    each call against the task, and only a clearly safe one runs. A denial
 *    goes back to the model as the call's output, with the probability.
 * 3. `scoreOutput` grades the answer on a five-level rubric.
 *
 * The Worker needs both the LLM integration and a TypeSafe key
 * (`TYPESAFE_API_KEY`); the fake serves both.
 *
 * ```sh
 * buck2 run root//src/celld/api/openai/examples:bridge-dev
 * curl -sS -X POST localhost:9876/tasks -H 'content-type: application/json' -d '{"task": "How many users signed up today?"}'
 * ```
 *
 * @module
 */

import { JevClient, type JevEnv } from "@celld/api/jev";
import {
  Conversation,
  functionTool,
  GptClient,
  type GptEnv,
  type GptError,
  runAgent,
  ToolRegistry,
} from "@celld/api/openai";
import { jevApprover, routeEffort, scoreOutput } from "@celld/api/openai/jev";
import { router } from "@celld/router";
import { v } from "@celld/sieve";

const runSql = functionTool({
  name: "run_sql",
  description: "Runs one SQL statement against the production database.",
  parameters: v.strictObject({ query: v.string() }),
  risk: "write",
  run: ({ query }) =>
    /^select count/i.test(query) ? "42" : `ran: ${query.slice(0, 80)}`,
});

const app = router<GptEnv & JevEnv>({ auth: "none" });

app.post("/tasks", {
  body: v.strictObject({ task: v.string().trim().min(1) }),
  limits: { timeout: 600 },
}, async (c) => {
  const { task } = c.body;
  const jev = JevClient.fromEnv(c.env);
  try {
    const route = await routeEffort(jev, task);
    const result = await runAgent({
      client: GptClient.fromEnv(c.env),
      conversation: new Conversation({
        instructions: "You answer questions about our database with SQL.",
      }).user(task),
      tools: new ToolRegistry([runSql]),
      request: { reasoning: { effort: route.effort } },
      approve: jevApprover(jev, { task }),
      maxTurns: 4,
      signal: c.signal,
    });
    const graded = await scoreOutput(jev, { task, output: result.text });
    return c.json({
      effort: route.effort,
      decided: route.decided,
      answer: result.text,
      toolOutputs: result.conversation.items.flatMap((item) =>
        item.type === "function_call_output" ? [item.output] : []
      ),
      score: graded.score,
      level: graded.level,
    });
  } catch (error) {
    // A GptError, or a Jev failure (JevError), both with a kind.
    const data = error instanceof Error && "toJSON" in error
      ? (error as GptError).toJSON()
      : { kind: "error", message: String(error) };
    return c.json({ kind: data.kind, error: data.message }, 502);
  }
});

export default { fetch: app.fetch };
