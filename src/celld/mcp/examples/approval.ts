// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A tool that asks the user before it acts: multi round-trip requests.
 *
 * `POST /mcp` serves one tool, `deploy`. A staging deploy just runs. A
 * production deploy needs a confirmation with a reason, so the first call
 * answers `resultType: "input_required"` with an `elicitation/create`
 * request under the key `confirm` and a sealed `requestState`. The client
 * shows the form, then calls again with `inputResponses` and that exact
 * `requestState`; the handler runs from the top and this time gets the
 * answer. There is no session: everything the second round needs is in the
 * request.
 *
 * The state is AES-GCM under `MCP_STATE_SECRET` (a secret binding every
 * instance shares) and binds the method, the arguments and the caller, so
 * it cannot be read, edited or replayed against other arguments. A client
 * that did not declare form elicitation gets -32021 before anything runs.
 *
 * ```sh
 * buck2 run root//src/celld/mcp/examples:approval-dev
 * ```
 *
 * The spec's `curl` lines show each round; the second needs the
 * `requestState` from the first.
 *
 * @module
 */

import { mcpHttpHandler, McpServer } from "@celld/mcp";
import { v } from "@celld/sieve";

interface Env {
  readonly MCP_STATE_SECRET: string;
}

function build(env: Env): (request: Request) => Promise<Response> {
  const server = new McpServer({
    info: { name: "deployer", version: "1.0.0" },
    stateSecret: env.MCP_STATE_SECRET,
  });

  server.tool({
    name: "deploy",
    description: "Deploys a service; production asks for a confirmation.",
    input: v.strictObject({
      service: v.string(),
      environment: v.enum(["staging", "production"]),
    }),
    run: ({ service, environment }, ctx) => {
      if (environment === "staging") return `deployed ${service} to staging`;
      const answer = ctx.elicit("confirm", {
        mode: "form",
        message: `Deploy ${service} to production?`,
        requestedSchema: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Why, for the audit log" },
          },
          required: ["reason"],
        },
      });
      if (answer.action !== "accept") return `${service} was not deployed`;
      return `deployed ${service} to production: ${answer.content?.reason}`;
    },
  });

  return mcpHttpHandler(server, { path: "/mcp" });
}

let handler: ReturnType<typeof build> | null = null;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    handler ??= build(env);
    return handler(request);
  },
};
