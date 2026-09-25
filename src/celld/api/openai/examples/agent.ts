// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A tool-using agent: an inventory assistant that can look stock up and
 * order more, but only order when the caller allows it.
 *
 * `POST /ask` with `{"question", "allowOrders"?}` runs `runAgent`: the model
 * answers or calls tools, the loop runs the calls and sends their outputs
 * back (in call order), until the model answers or a budget runs out.
 * Read-only calls (`stock`, `mutates: false`) overlap; a mutating call
 * (`reorder`) runs alone, one at a time. Since one tool mutates, `runAgent`
 * also asks the model for one call at a time (`parallel_tool_calls:
 * false`). Tool arguments are typed by the tool's schema and
 * checked before the handler runs; bad arguments, unknown tools, denials
 * and handler errors all become the call's output for the model to read,
 * never an exception. `approveByRisk` lets `read` tools run and denies
 * `write` tools unless `allowOrders` is set.
 *
 * The response has the answer, the loop's counters and each tool output.
 *
 * **Deliberately unauthenticated**, as a local demo: anyone who can reach
 * this Worker spends the subscription's quota, up to six model turns per
 * request. `allowOrders` in the body is a demo toggle, so any caller may
 * approve the write tool for themselves. A deployment authenticates
 * callers and ties the approval to the principal instead, for example
 * allowing `write` tools only when the verified token carries an
 * `orders` scope (`c.principal.scopes`).
 *
 * ```sh
 * buck2 run root//src/celld/api/openai/examples:agent-dev
 * curl -sS -X POST localhost:9876/ask -H 'content-type: application/json' -d '{"question": "Is B2 in stock?"}'
 * ```
 *
 * @module
 */

import {
  approveByRisk,
  Conversation,
  functionTool,
  GptClient,
  type GptEnv,
  GptError,
  runAgent,
  ToolRegistry,
} from "@celld/api/openai";
import { router } from "@celld/web/router";
import { v } from "@celld/sieve";

const STOCK: Record<string, number> = { A1: 12, B2: 0 };

const Sku = v.string().regex(/^[A-Z][0-9]$/);

const stock = functionTool({
  name: "stock",
  description: "Units in stock for a SKU.",
  parameters: v.strictObject({ sku: Sku }),
  risk: "read",
  mutates: false,
  run: ({ sku }) =>
    sku in STOCK ? `${STOCK[sku]} in stock` : `unknown SKU ${sku}`,
});

const reorder = functionTool({
  name: "reorder",
  description: "Orders more units of a SKU from the supplier.",
  parameters: v.strictObject({
    sku: Sku,
    quantity: v.int().min(1).max(100),
  }),
  risk: "write",
  mutates: true,
  run: ({ sku, quantity }) => `ordered ${quantity} of ${sku}`,
});

// Deliberately unauthenticated: see the module documentation.
const app = router<GptEnv>({ auth: "none", limits: { maxTimeout: 600 } });

app.post("/ask", {
  body: v.strictObject({
    question: v.string().trim().min(1),
    allowOrders: v.boolean().default(false),
  }),
  limits: { timeout: 600 },
}, async (c) => {
  const { question, allowOrders } = c.body;
  try {
    const result = await runAgent({
      client: GptClient.fromEnv(c.env),
      conversation: new Conversation({
        instructions:
          "You manage a small warehouse. Check stock before ordering.",
      }).user(question),
      tools: new ToolRegistry([stock, reorder]),
      maxTurns: 6,
      // A demo toggle from the request body; a deployment decides this
      // from the authenticated principal, never from the request.
      approve: approveByRisk({
        allow: allowOrders ? ["read", "write"] : ["read"],
      }),
      signal: c.signal,
    });
    return c.json({
      answer: result.text,
      stopReason: result.stopReason,
      turns: result.turns,
      toolCalls: result.toolCalls,
      outputs: result.conversation.items.flatMap((item) =>
        item.type === "function_call_output" ? [item.output] : []
      ),
    });
  } catch (error) {
    if (!(error instanceof GptError)) throw error;
    const { kind, message } = error.toJSON();
    return c.json({ kind, error: message }, 502);
  }
});

export default { fetch: app.fetch };
