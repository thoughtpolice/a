// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `gateway` example's upstream: a weather MCP server built with
 * `@celld/mcp` itself, behind OAuth, with its authorization server beside
 * it (`@celld/oauth`'s `AuthorizationServer` with an in-memory store, as
 * `testAuthorizationServer` sets it up).
 *
 * - `POST /mcp`: the MCP endpoint. Every request needs an access token for
 *   this resource from the issuer at `/as`; `forecast` needs the
 *   `weather:read` scope. `subscribe_alert` asks for the address to alert
 *   through a form elicitation (a multi round-trip request).
 * - `GET /.well-known/oauth-protected-resource/mcp`: its metadata.
 * - `/as/...` and `GET /.well-known/oauth-authorization-server/as`: the
 *   authorization server, which knows one confidential client, `gateway`,
 *   allowed only the client credentials grant, and issues RFC 9068 access
 *   tokens for this resource alone.
 *
 * Both are built on the first request, for the origin it was sent to. The
 * Worker gets the URL and its client's credentials as variables.
 *
 * @module
 */

import { serveUpstream } from "@celld/examples/upstream";
import { mcpHttpHandler, McpServer, ToolError } from "@celld/mcp";
import { jwtAccessTokenVerifier, ResourceServer } from "@celld/oauth/resource";
import { publicJwks } from "@celld/oauth/server";
import {
  type TestAuthorizationServer,
  testAuthorizationServer,
} from "@celld/oauth/testing";
import { v } from "@celld/sieve";

const CLIENT_ID = "gateway";
const CLIENT_SECRET = "gateway-example-secret";

const FORECASTS: Readonly<
  Record<string, { celsius: number; conditions: string }>
> = {
  oslo: { celsius: 4, conditions: "sleet" },
  lisbon: { celsius: 21, conditions: "sunny" },
};

interface Site {
  readonly as: TestAuthorizationServer;
  readonly mcp: (request: Request) => Promise<Response>;
}

async function site(origin: string): Promise<Site> {
  const resource = `${origin}/mcp`;
  const as = await testAuthorizationServer({
    issuer: `${origin}/as`,
    clients: [{
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_types: ["client_credentials"],
    }],
    scopesSupported: ["weather:read", "weather:alerts"],
    resources: { allowed: [resource] },
  });
  const server = new McpServer({
    info: { name: "weather", version: "2.1.0" },
    stateSecret: "weather-upstream-state-secret-0123456789",
  });
  server.tool({
    name: "forecast",
    description: "Today's forecast for a city.",
    input: v.strictObject({ city: v.string() }),
    output: v.strictObject({
      city: v.string(),
      celsius: v.number(),
      conditions: v.string(),
    }),
    scopes: ["weather:read"],
    run: ({ city }) => {
      const found = FORECASTS[city.toLowerCase()];
      if (found === undefined) throw new ToolError(`no forecast for ${city}`);
      return { structuredContent: { city, ...found } };
    },
  });
  server.tool({
    name: "subscribe_alert",
    description: "Alerts about severe weather in a city.",
    input: v.strictObject({ city: v.string() }),
    run: ({ city }, ctx) => {
      const answer = ctx.elicit("contact", {
        mode: "form",
        message: `Where should alerts for ${city} go?`,
        requestedSchema: {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
        },
      });
      if (answer.action !== "accept") return `no alerts for ${city}`;
      return `alerts for ${city} go to ${answer.content?.email}`;
    },
  });
  const protectedResource = new ResourceServer({
    resource,
    authorizationServers: [as.server.issuer],
    scopesSupported: ["weather:read"],
    verifier: jwtAccessTokenVerifier({
      issuer: as.server.issuer,
      audience: resource,
      keys: publicJwks(as.keys),
    }),
    // Bearer only: the gateway holds no DPoP key.
    dpop: false,
  });
  return {
    as,
    mcp: mcpHttpHandler(server, { path: "/mcp", resource: protectedResource }),
  };
}

const sites = new Map<string, Promise<Site>>();

serveUpstream({
  async fetch(request) {
    const url = new URL(request.url);
    let found = sites.get(url.origin);
    if (found === undefined) {
      found = site(url.origin);
      sites.set(url.origin, found);
    }
    const { as, mcp } = await found;
    return url.pathname === "/mcp" ||
        url.pathname.startsWith("/.well-known/oauth-protected-resource")
      ? await mcp(request)
      : await as.handle(request);
  },
  vars: (origin) => ({
    WEATHER_MCP_URL: `${origin}/mcp`,
    WEATHER_ISSUER: `${origin}/as`,
    WEATHER_CLIENT_ID: CLIENT_ID,
    WEATHER_CLIENT_SECRET: CLIENT_SECRET,
  }),
});
