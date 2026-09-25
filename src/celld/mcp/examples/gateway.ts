// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A Worker that is an MCP client: plain HTTP routes in front of another
 * team's MCP server, authenticated with OAuth client credentials.
 *
 * - `GET /forecast?city=Oslo` calls the upstream's `forecast` tool and
 *   answers its structured content; a tool error is a 404.
 * - `POST /alerts` with `{"city", "email"?}` calls `subscribe_alert`. That
 *   tool asks for a contact address with a form elicitation; `McpClient`
 *   answers it through the `elicitation` handler, here from the request
 *   body (declining without an `email`), and retries with the answer and
 *   the server's `requestState`.
 * - `GET /tools` lists the upstream's tools.
 *
 * `OAuthSession` from `@celld/oauth/client`, with `clientCredentials`, is
 * the client's `auth` and authenticates as the Worker itself, with no user:
 * on the first 401 it reads the server's Protected Resource Metadata,
 * discovers the authorization server, asks for a token for exactly that
 * resource (RFC 8707) with the client credentials grant, and retries. The
 * token is kept (in memory, per isolate) until it nears expiry. The
 * credentials are only ever sent to the issuer they name. The client
 * declares the MCP client credentials extension in its capabilities.
 *
 * ```sh
 * buck2 run root//src/celld/mcp/examples:gateway-dev
 * curl -sS 'localhost:9876/forecast?city=Oslo'
 * curl -sS -X POST localhost:9876/alerts -d '{"city": "Oslo", "email": "ops@example.com"}'
 * ```
 *
 * @module
 */

import {
  McpClient,
  McpError,
  OAUTH_CLIENT_CREDENTIALS_EXTENSION,
} from "@celld/mcp";
import { OAuthSession } from "@celld/oauth/client";

interface Env {
  readonly WEATHER_MCP_URL: string;
  readonly WEATHER_ISSUER: string;
  readonly WEATHER_CLIENT_ID: string;
  readonly WEATHER_CLIENT_SECRET: string;
}

const INFO = { name: "weather-gateway", version: "1.0.0" };

let auth: OAuthSession | null = null;

/** A client for one request; `email` answers the alert tool's question. */
function client(env: Env, email?: unknown): McpClient {
  auth ??= new OAuthSession({
    resource: env.WEATHER_MCP_URL,
    clientCredentials: {
      issuer: env.WEATHER_ISSUER,
      clientId: env.WEATHER_CLIENT_ID,
      clientSecret: env.WEATHER_CLIENT_SECRET,
    },
  });
  return McpClient.http(env.WEATHER_MCP_URL, {
    info: INFO,
    auth,
    capabilities: { extensions: { [OAUTH_CLIENT_CREDENTIALS_EXTENSION]: {} } },
    handlers: {
      elicitation: () =>
        typeof email === "string"
          ? { action: "accept", content: { email } }
          : { action: "decline" },
    },
  });
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => block.text ?? "").join("\n");
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/forecast") {
    const city = url.searchParams.get("city");
    if (city === null) {
      return Response.json({ error: "missing ?city=" }, { status: 400 });
    }
    const result = await client(env).callTool("forecast", { city });
    return result.isError
      ? Response.json({ error: textOf(result.content) }, { status: 404 })
      : Response.json(result.structuredContent);
  }
  if (request.method === "POST" && url.pathname === "/alerts") {
    const { city, email } = await request.json() as {
      city?: unknown;
      email?: unknown;
    };
    if (typeof city !== "string") {
      return Response.json({ error: "expected {city}" }, { status: 400 });
    }
    const result = await client(env, email).callTool("subscribe_alert", {
      city,
    });
    return Response.json({ message: textOf(result.content) });
  }
  if (request.method === "GET" && url.pathname === "/tools") {
    const tools = await client(env).listAllTools();
    return Response.json(tools.map((tool) => tool.name));
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      // What went wrong upstream, never the credentials.
      if (error instanceof McpError) {
        return Response.json(
          { error: error.kind, message: error.message },
          { status: 502 },
        );
      }
      throw error;
    }
  },
};
