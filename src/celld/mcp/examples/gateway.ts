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
 * `OAuthSession` from `@celld/sec/oauth/client`, with `clientCredentials`, is
 * the client's `auth` and authenticates as the Worker itself, with no user:
 * on the first 401 it reads the server's Protected Resource Metadata,
 * discovers the authorization server, asks for a token for exactly that
 * resource (RFC 8707) with the client credentials grant, and retries. The
 * token is kept (in memory, per isolate) until it nears expiry. The
 * credentials are only ever sent to the issuer they name. The client
 * declares the MCP client credentials extension in its capabilities.
 *
 * The gateway's own routes are deliberately unauthenticated, to keep the
 * example about the client side. Anyone who can reach this Worker calls
 * the upstream under the gateway's own client credentials: its scopes, its
 * rate limits, its audit trail. A deployment must put authentication in
 * front (for example `@celld/web/router` with an auth scheme) and decide which
 * callers may use which upstream tools. `POST /alerts` reads at most 16 KiB
 * of body (413 over that, 400 for anything but JSON), and an upstream
 * failure is a 502 naming only its kind; the details, which can include
 * the upstream's URL, go to the log.
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
import { OAuthSession } from "@celld/sec/oauth/client";
import {
  BoundsError,
  parseJsonBounded,
  readTextBounded,
} from "@celld/core/bounds";

interface Env {
  readonly WEATHER_MCP_URL: string;
  readonly WEATHER_ISSUER: string;
  readonly WEATHER_CLIENT_ID: string;
  readonly WEATHER_CLIENT_SECRET: string;
  /** "true" lets the session reach an upstream on http://127.0.0.1. */
  readonly OAUTH_LOOPBACK_FOR_DEVELOPMENT?: string;
}

const INFO = { name: "weather-gateway", version: "1.0.0" };
const MAX_BODY_BYTES = 16_384;

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
    allowLoopbackForDevelopment: env.OAUTH_LOOPBACK_FOR_DEVELOPMENT === "true",
  });
  return McpClient.http(env.WEATHER_MCP_URL, {
    info: INFO,
    auth: auth.httpAuth(),
    allowLoopbackForDevelopment: env.OAUTH_LOOPBACK_FOR_DEVELOPMENT === "true",
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
    let body: unknown;
    try {
      const text = await readTextBounded(request, { maxBytes: MAX_BODY_BYTES });
      body = parseJsonBounded(text, { maxDepth: 4, maxKeys: 8, maxItems: 8 });
    } catch (error) {
      if (!(error instanceof BoundsError)) throw error;
      return error.code === "too_large"
        ? Response.json({ error: "body too large" }, { status: 413 })
        : Response.json({ error: "expected a JSON body" }, { status: 400 });
    }
    const { city, email } =
      (typeof body === "object" && body !== null ? body : {}) as {
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
      // The caller learns only the kind of failure. The message can name
      // the upstream's URL or quote its answers, so it goes to the log.
      if (error instanceof McpError) {
        console.error(`upstream ${error.kind}: ${error.message}`);
        return Response.json({ error: error.kind }, { status: 502 });
      }
      throw error;
    }
  },
};
