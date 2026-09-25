// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An MCP endpoint behind `@celld/oauth`'s `ResourceServer`: the 401 and
 * 403 challenges (with `resource_metadata`, and DPoP's beside Bearer's),
 * per-tool scopes naming every scope in one challenge, scope hierarchies
 * through `scopeSatisfied`, the metadata document, that handlers see the
 * principal and never the token, and the algorithms accepted for access
 * tokens. Token verification itself is `@celld/oauth`'s and tested there.
 */

import { assert, assertEquals } from "@celld/assert";
import {
  type GeneratedKeyPair,
  generateKeyPair,
  type JwsAlgorithm,
  sign,
} from "@celld/jwt";
import {
  type HttpHandlerOptions,
  LATEST_PROTOCOL_VERSION,
  mcpHttpHandler,
  McpServer,
  META,
} from "@celld/mcp";
import { DEFAULT_DPOP_ALGORITHMS } from "@celld/oauth/dpop";
import {
  jwtAccessTokenVerifier,
  type JwtAccessTokenVerifierOptions,
  type ResourceDpopOptions,
  ResourceServer,
} from "@celld/oauth/resource";
import { v } from "@celld/sieve";
import { CLIENT_INFO, SERVER_INFO } from "./fixture.ts";

const ISSUER = "https://auth.test";
const RESOURCE = "https://mcp.test/mcp";
const METADATA = "https://mcp.test/.well-known/oauth-protected-resource/mcp";

const KEY = await generateKeyPair("ES256", { kid: "k1" });

/** An RFC 9068 access token for the resource, with `claims` over the usual ones. */
async function token(
  claims: Record<string, unknown> = {},
  key: GeneratedKeyPair = KEY,
  alg: JwsAlgorithm = "ES256",
  now: () => number = Date.now,
): Promise<string> {
  return await sign(
    {
      iss: ISSUER,
      sub: "user-7",
      aud: RESOURCE,
      scope: "mcp:read mcp:write",
      client_id: "app",
      jti: crypto.randomUUID(),
      ...claims,
    },
    key.privateKey,
    {
      alg,
      kid: key.publicJwk.kid,
      typ: "at+jwt",
      issuedAt: true,
      expiresIn: 300,
      now,
    },
  );
}

function resource(
  options: {
    readonly dpop?: ResourceDpopOptions | false;
    readonly verifier?: Partial<JwtAccessTokenVerifierOptions>;
  } = {},
): ResourceServer {
  return new ResourceServer({
    resource: RESOURCE,
    authorizationServers: [ISSUER],
    scopesSupported: ["mcp:read"],
    verifier: jwtAccessTokenVerifier({
      issuer: ISSUER,
      audience: RESOURCE,
      keys: { keys: [KEY.publicJwk] },
      ...options.verifier,
    }),
    dpop: options.dpop ?? false,
  });
}

/** A server with one open tool and scoped ones, behind `resource`. */
function protectedHandler(
  resource: ResourceServer,
  options: HttpHandlerOptions = {},
) {
  const server = new McpServer({ info: SERVER_INFO });
  server.tool({
    name: "whoami",
    run: (_args, ctx) => JSON.stringify(ctx.principal),
  });
  server.tool({
    name: "write",
    input: v.strictObject({ text: v.string() }),
    scopes: ["mcp:write"],
    run: ({ text }) => `wrote ${text}`,
  });
  server.tool({
    name: "admin",
    scopes: ["mcp:write", "mcp:admin"],
    run: () => "admin",
  });
  return mcpHttpHandler(server, { path: "/mcp", resource, ...options });
}

function call(
  handler: (request: Request) => Promise<Response>,
  name: string,
  token: string | null,
  args: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
    "mcp-method": "tools/call",
    "mcp-name": name,
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return handler(
    new Request(RESOURCE, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            [META.protocolVersion]: LATEST_PROTOCOL_VERSION,
            [META.clientCapabilities]: {},
            [META.clientInfo]: CLIENT_INFO,
          },
        },
      }),
    }),
  );
}

Deno.test("401 and 403 challenges, per-tool scopes, and the metadata document", async () => {
  const api = resource();
  assertEquals(api.metadata, {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp:read"],
  });
  const handler = protectedHandler(api);

  const missing = await call(handler, "whoami", null);
  assertEquals(missing.status, 401);
  assertEquals(
    missing.headers.get("www-authenticate"),
    `Bearer resource_metadata="${METADATA}"`,
  );
  const served = await handler(new Request(METADATA));
  assertEquals(await served.json(), api.metadata);

  for (
    const refused of [
      "garbage",
      // Issued two hours ago, so expired an hour and 55 minutes ago.
      await token({}, KEY, "ES256", () => Date.now() - 7_200_000),
      await token({ aud: "https://other.test/mcp" }),
      await token({ jti: undefined }),
    ]
  ) {
    const response = await call(handler, "whoami", refused);
    assertEquals(response.status, 401);
    const challenge = response.headers.get("www-authenticate")!;
    assert(
      challenge.startsWith('Bearer error="invalid_token", error_description="'),
      challenge,
    );
    assert(challenge.endsWith(`resource_metadata="${METADATA}"`), challenge);
  }

  const reader = await token({ scope: "mcp:read" });
  assertEquals((await call(handler, "whoami", reader)).status, 200);
  const forbidden = await call(handler, "write", reader, { text: "x" });
  assertEquals(forbidden.status, 403);
  assertEquals(
    forbidden.headers.get("www-authenticate"),
    `Bearer error="insufficient_scope", error_description="Missing scopes: mcp:write", scope="mcp:write", resource_metadata="${METADATA}"`,
  );
  // Every scope the operation needs is named in one challenge.
  const writer = await token({ scope: "mcp:read mcp:write" });
  const admin = await call(handler, "admin", writer);
  assertEquals(admin.status, 403);
  assert(
    admin.headers.get("www-authenticate")!.includes(
      'scope="mcp:write mcp:admin"',
    ),
    "all scopes",
  );
  const wrote = await call(handler, "write", writer, { text: "x" });
  assertEquals(wrote.status, 200);
  assertEquals((await wrote.json()).result.content, [{
    type: "text",
    text: "wrote x",
  }]);
});

Deno.test("a resource server taking DPoP challenges with both schemes", async () => {
  const handler = protectedHandler(resource({ dpop: {} }));
  const missing = await call(handler, "whoami", null);
  assertEquals(missing.status, 401);
  assertEquals(
    missing.headers.get("www-authenticate"),
    `DPoP algs="${
      DEFAULT_DPOP_ALGORITHMS.join(" ")
    }", resource_metadata="${METADATA}", Bearer resource_metadata="${METADATA}"`,
  );
  // A 403 names only the scheme the request used.
  const forbidden = await call(
    handler,
    "write",
    await token({ scope: "mcp:read" }),
    { text: "x" },
  );
  assertEquals(forbidden.status, 403);
  assert(
    forbidden.headers.get("www-authenticate")!.startsWith(
      'Bearer error="insufficient_scope"',
    ),
    forbidden.headers.get("www-authenticate")!,
  );
});

Deno.test("scope hierarchies through scopeSatisfied", async () => {
  const handler = protectedHandler(resource(), {
    scopeSatisfied: (granted, scope) =>
      granted.includes(scope) ||
      (granted.includes("mcp:admin") && scope.startsWith("mcp:")),
  });
  const admin = await token({ scope: "mcp:admin" });
  assertEquals(
    (await call(handler, "write", admin, { text: "x" })).status,
    200,
  );
  assertEquals((await call(handler, "admin", admin)).status, 200);
});

Deno.test("handlers see the principal, never the token", async () => {
  const handler = protectedHandler(resource());
  const sent = await token();
  const response = await call(handler, "whoami", sent);
  const text = (await response.json()).result.content[0].text as string;
  const principal = JSON.parse(text);
  assertEquals(principal.subject, "user-7");
  assertEquals(principal.scopes, ["mcp:read", "mcp:write"]);
  assertEquals(principal.clientId, "app");
  assertEquals(principal.claims.client_id, "app");
  assert(!text.includes(sent), "the raw token must not reach handlers");
  assert(!text.includes(sent.split(".")[2]), "not even its signature");
});

Deno.test("EdDSA access tokens need the algorithm listed explicitly", async () => {
  const ed = await generateKeyPair("EdDSA", { kid: "ed" });
  const keys = { keys: [ed.publicJwk] };
  const signed = await token({}, ed, "EdDSA");
  // Not among the default algorithms: celld's WebCrypto cannot verify it.
  const defaults = protectedHandler(resource({ verifier: { keys } }));
  assertEquals((await call(defaults, "whoami", signed)).status, 401);
  const listed = protectedHandler(
    resource({ verifier: { keys, algorithms: ["EdDSA"] } }),
  );
  assertEquals((await call(listed, "whoami", signed)).status, 200);
});
