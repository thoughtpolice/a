// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A minimal MCP server Worker: tools, resources and a prompt.
 *
 * `POST /mcp` is the Streamable HTTP endpoint of a small kitchen server:
 *
 * - `convert` turns an amount between cooking units, with structured
 *   output (also sent as a text block);
 * - `scale_recipe` scales a recipe for a number of servings, reporting
 *   progress per ingredient when the request carries a `progressToken`, in
 *   which case the answer is a server-sent event stream;
 * - `recipes://{name}` reads a recipe as JSON; an unknown name is -32602;
 * - `plan_meal` is a prompt taking a `guests` argument.
 *
 * Every request is one JSON-RPC message carrying its protocol version and
 * client capabilities in `_meta`, with the `MCP-Protocol-Version`,
 * `Mcp-Method` and (for calls, reads and prompts) `Mcp-Name` headers that
 * must agree with the body. There is no session and no `initialize`: a
 * client asks `server/discover` when it wants to know what is here.
 *
 * ```sh
 * buck2 run root//src/celld/mcp/examples:tools-dev
 * curl -sS localhost:9876/mcp -H 'content-type: application/json' \
 *   -H 'accept: application/json, text/event-stream' \
 *   -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/list' \
 *   -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {"_meta": {
 *     "io.modelcontextprotocol/protocolVersion": "2026-07-28",
 *     "io.modelcontextprotocol/clientCapabilities": {},
 *     "io.modelcontextprotocol/clientInfo": {"name": "curl", "version": "1"}}}}'
 * ```
 *
 * @module
 */

import { mcpHttpHandler, McpServer, ToolError } from "@celld/mcp";
import { v } from "@celld/sieve";

/** Millilitres per unit. */
const UNITS = { ml: 1, tsp: 5, tbsp: 15, cup: 240 } as const;

interface Ingredient {
  readonly name: string;
  readonly amount: number;
  readonly unit: keyof typeof UNITS | "g" | "each";
}

const RECIPES: Readonly<
  Record<string, { serves: number; ingredients: Ingredient[] }>
> = {
  pancakes: {
    serves: 4,
    ingredients: [
      { name: "flour", amount: 200, unit: "g" },
      { name: "milk", amount: 1.25, unit: "cup" },
      { name: "egg", amount: 2, unit: "each" },
    ],
  },
};

function build(): (request: Request) => Promise<Response> {
  const server = new McpServer({
    info: { name: "kitchen", version: "1.0.0" },
    instructions: "Cooking helpers: unit conversion and recipes.",
  });

  server.tool({
    name: "convert",
    description: "Converts an amount between cooking units.",
    input: v.strictObject({
      amount: v.number().min(0),
      from: v.enum(["ml", "tsp", "tbsp", "cup"]),
      to: v.enum(["ml", "tsp", "tbsp", "cup"]),
    }),
    output: v.strictObject({ amount: v.number(), unit: v.string() }),
    annotations: { readOnlyHint: true },
    run: ({ amount, from, to }) => ({
      structuredContent: {
        amount: Math.round(amount * UNITS[from] / UNITS[to] * 100) / 100,
        unit: to,
      },
    }),
  });

  server.tool({
    name: "scale_recipe",
    description: "Scales a recipe to a number of servings.",
    input: v.strictObject({
      recipe: v.string(),
      servings: v.int().min(1),
    }),
    run: async ({ recipe, servings }, ctx) => {
      const found = RECIPES[recipe];
      if (found === undefined) throw new ToolError(`no recipe ${recipe}`);
      const factor = servings / found.serves;
      const lines: string[] = [];
      for (const [index, item] of found.ingredients.entries()) {
        ctx.progress(index + 1, {
          total: found.ingredients.length,
          message: item.name,
        });
        // Stands in for real work between the progress reports.
        await new Promise((resolve) => setTimeout(resolve, 10));
        lines.push(`${item.amount * factor} ${item.unit} ${item.name}`);
      }
      return lines.join("\n");
    },
  });

  server.resourceTemplate({
    uriTemplate: "recipes://{name}",
    name: "recipe",
    mimeType: "application/json",
    read: (_uri, { name }) =>
      Object.hasOwn(RECIPES, name) ? JSON.stringify(RECIPES[name]) : null,
  });

  server.prompt({
    name: "plan_meal",
    description: "Plans a meal for some guests.",
    arguments: [{ name: "guests", required: true }],
    get: ({ guests }) => [{
      role: "user",
      content: {
        type: "text",
        text:
          `Plan a pancake brunch for ${guests} guests using the kitchen tools.`,
      },
    }],
  });

  return mcpHttpHandler(server, { path: "/mcp" });
}

let handler: ReturnType<typeof build> | null = null;

export default {
  fetch(request: Request): Promise<Response> {
    handler ??= build();
    return handler(request);
  },
};
