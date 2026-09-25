// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A tool-using agent: an inventory assistant that can look stock up and
 * order more, but only order when the caller allows it.
 *
 * `POST /ask` with `{"question", "allowOrders"?}` runs `runAgent`: the model
 * answers or calls tools, the loop runs the calls (in parallel, outputs in
 * call order) and sends their outputs back, until the model answers or a
 * budget runs out. Tool arguments are typed by the tool's schema and
 * checked before the handler runs; bad arguments, unknown tools, denials
 * and handler errors all become the call's output for the model to read,
 * never an exception. `approveByRisk` lets `read` tools run and denies
 * `write` tools unless `allowOrders` is set.
 *
 * The response has the answer, the loop's counters and each tool output.
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
import { router } from "@celld/router";
import { v } from "@celld/sieve";

const STOCK: Record<string, number> = { A1: 12, B2: 0 };

const Sku = v.string().regex(/^[A-Z][0-9]$/);

const stock = functionTool({
  name: "stock",
  description: "Units in stock for a SKU.",
  parameters: v.strictObject({ sku: Sku }),
  risk: "read",
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
  run: ({ sku, quantity }) => `ordered ${quantity} of ${sku}`,
});

const app = router<GptEnv>({ auth: "none" });

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
