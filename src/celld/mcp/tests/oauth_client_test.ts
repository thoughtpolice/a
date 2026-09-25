// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP client authorizing with `@celld/oauth`'s `OAuthSession` as its
 * `HttpAuthProvider`, against `testAuthorizationServer` and an MCP server
 * behind a `ResourceServer`: a 401 leading to discovery, authorization and
 * a retry; a refused token refreshed once; step-up on a tool's
 * `insufficient_scope` (and not repeated when it does not help); client
 * credentials with a secret and with `private_key_jwt`; the split flow;
 * and DPoP nonces rotated on every answer, taken up through `observe`.
 * Discovery, registration and the security checks themselves are
 * `@celld/oauth`'s and tested there.
 */

import { assert, assertEquals } from "@celld/assert";
import { decode, generateKeyPair } from "@celld/jwt";
import {
  McpClient,
  McpError,
  mcpHttpHandler,
  McpServer,
  OAUTH_CLIENT_CREDENTIALS_EXTENSION,
} from "@celld/mcp";
import { OAuthError } from "@celld/oauth";
import {
  memoryOAuthStore,
  OAuthSession,
  type OAuthSessionOptions,
} from "@celld/oauth/client";
import {
  DpopKey,
  type DpopNonceSource,
  memoryReplayStore,
} from "@celld/oauth/dpop";
import {
  jwtAccessTokenVerifier,
  type ResourceDpopOptions,
  ResourceServer,
} from "@celld/oauth/resource";
import { type ClientConfig, publicJwks } from "@celld/oauth/server";
import {
  routeFetch,
  testAuthorizationServer,
  type TestAuthorizationServerOptions,
  testUserAgent,
} from "@celld/oauth/testing";
import { v } from "@celld/sieve";
import { CLIENT_INFO, SERVER_INFO } from "./fixture.ts";

const MCP = "https://mcp.test";
const ENDPOINT = `${MCP}/mcp`;
const ISSUER = "https://auth.test";
const APP = "https://app.test";
const CIMD = `${APP}/oauth/client.json`;
const REDIRECT = "http://127.0.0.1:8765/callback";

function mcpServer(): McpServer {
  const server = new McpServer({ info: SERVER_INFO });
  server.tool({
    name: "whoami",
    run: (_args, ctx) =>
      JSON.stringify({
        subject: ctx.principal?.subject,
        scopes: ctx.principal?.scopes,
      }),
  });
  server.tool({
    name: "write",
    input: v.strictObject({ text: v.string() }),
    scopes: ["mcp:write"],
    run: ({ text }) => `wrote ${text}`,
  });
  return server;
}

interface WorldOptions {
  readonly as?: Partial<TestAuthorizationServerOptions>;
  readonly clients?: readonly ClientConfig[];
  /** The resource server's DPoP settings; default Bearer only. */
  readonly dpop?: ResourceDpopOptions | false;
}

/** An MCP server and an authorization server, reachable through one fetch. */
async function world(options: WorldOptions = {}) {
  const routes: Record<string, (request: Request) => Promise<Response>> = {};
  const fetch = routeFetch(routes);
  const as = await testAuthorizationServer({
    issuer: ISSUER,
    clients: options.clients,
    clientIdMetadataDocuments: {},
    registration: {},
    fetch,
    ...options.as,
  });
  const resource = new ResourceServer({
    resource: ENDPOINT,
    authorizationServers: [ISSUER],
    scopesSupported: ["mcp:read"],
    verifier: jwtAccessTokenVerifier({
      issuer: ISSUER,
      audience: ENDPOINT,
      keys: publicJwks(as.keys),
    }),
    dpop: options.dpop ?? false,
  });
  const handler = mcpHttpHandler(mcpServer(), { path: "/mcp", resource });
  routes[MCP] = handler;
  routes[ISSUER] = as.handle;
  routes[APP] = (request) =>
    Promise.resolve(
      new URL(request.url).pathname === "/oauth/client.json"
        ? Response.json({
          client_id: CIMD,
          client_name: "Test app",
          redirect_uris: [REDIRECT],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
        })
        : new Response("not found", { status: 404 }),
    );
  /** The form bodies sent to an endpoint of the issuer, in order. */
  const forms = async (path: string) => {
    const out: Record<string, string>[] = [];
    for (const request of fetch.requests) {
      if (request.url !== `${ISSUER}${path}`) continue;
      out.push(
        Object.fromEntries(new URLSearchParams(await request.clone().text())),
      );
    }
    return out;
  };
  const tokenRequests = () => forms("/token");
  // The session pushes its authorization requests (RFC 9126) when the
  // server offers it, as this one does.
  const authorizations = () => forms("/par");
  const mcpPosts = () =>
    fetch.requests.filter((r) => r.url === ENDPOINT && r.method === "POST");
  return { as, fetch, resource, tokenRequests, authorizations, mcpPosts };
}

type World = Awaited<ReturnType<typeof world>>;

function session(
  w: World,
  options: Partial<OAuthSessionOptions> = {},
): { auth: OAuthSession; agent: ReturnType<typeof testUserAgent> } {
  const agent = testUserAgent(w.fetch);
  const auth = new OAuthSession({
    resource: ENDPOINT,
    redirectUri: REDIRECT,
    registration: {
      metadataDocument: CIMD,
      dynamic: { client_name: "Test app" },
    },
    userAgent: agent,
    fetch: w.fetch,
    ...options,
  });
  return { auth, agent };
}

function client(w: World, auth: OAuthSession): McpClient {
  return McpClient.http(ENDPOINT, { info: CLIENT_INFO, fetch: w.fetch, auth });
}

async function whoami(mcp: McpClient): Promise<Record<string, unknown>> {
  const result = await mcp.callTool("whoami");
  return JSON.parse((result.content[0] as { text: string }).text);
}

async function failure(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof McpError, `not an McpError: ${error}`);
    return error;
  }
  throw new Error("resolved");
}

/** The OAuthError behind an `unauthorized` McpError. */
async function oauthFailure(promise: Promise<unknown>): Promise<OAuthError> {
  const error = await failure(promise);
  assertEquals(error.kind, "unauthorized");
  assert(error.cause instanceof OAuthError, `cause: ${error.cause}`);
  const cause = error.cause as OAuthError;
  assertEquals((error.data as Record<string, unknown>).kind, cause.kind);
  return cause;
}

Deno.test("a 401 runs discovery, authorization and a retry", async () => {
  const w = await world();
  const { auth, agent } = session(w);
  const mcp = client(w, auth);
  assertEquals(await whoami(mcp), { subject: "user-1", scopes: ["mcp:read"] });

  assertEquals(agent.requests.length, 1);
  const [request] = await w.authorizations();
  assertEquals(request.client_id, CIMD);
  assertEquals(request.code_challenge_method, "S256");
  assertEquals(request.resource, ENDPOINT);
  // No scope in the challenge, so the metadata's scopes_supported.
  assertEquals(request.scope, "mcp:read");
  const [token] = await w.tokenRequests();
  assertEquals(token.grant_type, "authorization_code");
  assertEquals(token.resource, ENDPOINT);
  // Discovery went through the challenge's resource_metadata.
  assertEquals(
    auth.discovery?.protectedResourceUrl,
    `${MCP}/.well-known/oauth-protected-resource/mcp`,
  );

  // The token is reused: no new authorization, and every MCP request after
  // the first carries it.
  await whoami(mcp);
  assertEquals(agent.requests.length, 1);
  const headers = w.mcpPosts().map((r) => r.headers.get("authorization"));
  assertEquals(headers[0], null);
  assert(headers.slice(1).every((h) => h?.startsWith("Bearer ey")), "bearer");
});

Deno.test("a refused token is refreshed once, then the request is retried", async () => {
  const w = await world();
  const store = memoryOAuthStore();
  const { auth, agent } = session(w, { store });
  const mcp = client(w, auth);
  await whoami(mcp);
  const tokens = (await auth.tokens())!;
  assert(tokens.refresh_token !== undefined, "a refresh token");
  await store.setTokens(ISSUER, ENDPOINT, {
    ...tokens,
    access_token: "garbage",
  });
  await whoami(mcp);
  assertEquals(agent.requests.length, 1);
  assertEquals(
    (await w.tokenRequests()).map((r) => r.grant_type),
    ["authorization_code", "refresh_token"],
  );
});

Deno.test("a tool's insufficient_scope steps up with the union of scopes", async () => {
  const w = await world();
  const { auth, agent } = session(w);
  const mcp = client(w, auth);
  await whoami(mcp);
  const result = await mcp.callTool("write", { text: "x" });
  assertEquals(result.content, [{ type: "text", text: "wrote x" }]);
  assertEquals(agent.requests.length, 2);
  assertEquals(
    (await w.authorizations()).map((r) => r.scope),
    ["mcp:read", "mcp:read mcp:write"],
  );
  assertEquals(await whoami(mcp), {
    subject: "user-1",
    scopes: ["mcp:read", "mcp:write"],
  });
});

Deno.test("a step-up that does not help is not repeated", async () => {
  const w = await world({
    as: { consent: () => ({ grant: { subject: "u", scope: ["mcp:read"] } }) },
  });
  const { auth, agent } = session(w);
  const cause = await oauthFailure(
    client(w, auth).callTool("write", { text: "x" }),
  );
  assertEquals(cause.kind, "insufficient_scope");
  // First authorization (401), one step-up (403), then give up.
  assertEquals(agent.requests.length, 2);
});

Deno.test("without a user agent the flow cannot run", async () => {
  const w = await world();
  const { auth } = session(w, { userAgent: undefined });
  assertEquals(
    (await oauthFailure(whoami(client(w, auth)))).kind,
    "interaction_required",
  );
});

Deno.test("client credentials with a secret", async () => {
  const w = await world({
    clients: [{
      client_id: "svc",
      client_secret: "pw",
      grant_types: ["client_credentials"],
    }],
  });
  const auth = new OAuthSession({
    resource: ENDPOINT,
    clientCredentials: { issuer: ISSUER, clientId: "svc", clientSecret: "pw" },
    fetch: w.fetch,
  });
  const mcp = McpClient.http(ENDPOINT, {
    info: CLIENT_INFO,
    fetch: w.fetch,
    auth,
    capabilities: { extensions: { [OAUTH_CLIENT_CREDENTIALS_EXTENSION]: {} } },
  });
  assertEquals(await whoami(mcp), { subject: "svc", scopes: ["mcp:read"] });
  const [token] = await w.tokenRequests();
  assertEquals(token.grant_type, "client_credentials");
  assertEquals(token.resource, ENDPOINT);
  assertEquals(token.scope, "mcp:read");
  assertEquals(
    w.fetch.requests.some((r) => r.url.startsWith(`${ISSUER}/authorize`)),
    false,
  );
  // The extension was declared on the MCP requests.
  const body = await w.mcpPosts().at(-1)!.clone().json();
  assertEquals(
    Object.keys(
      body.params._meta["io.modelcontextprotocol/clientCapabilities"]
        .extensions,
    ),
    [OAUTH_CLIENT_CREDENTIALS_EXTENSION],
  );
});

Deno.test("client credentials with a private_key_jwt assertion", async () => {
  const key = await generateKeyPair("ES256", { kid: "signer-1" });
  const w = await world({
    clients: [{
      client_id: "signer",
      jwks: { keys: [key.publicJwk] },
      grant_types: ["client_credentials"],
    }],
  });
  const auth = new OAuthSession({
    resource: ENDPOINT,
    clientCredentials: {
      issuer: ISSUER,
      clientId: "signer",
      privateKey: key.privateKey,
      alg: "ES256",
      kid: "signer-1",
    },
    fetch: w.fetch,
  });
  assertEquals((await whoami(client(w, auth))).subject, "signer");
  const [token] = await w.tokenRequests();
  assertEquals(
    token.client_assertion_type,
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  );
});

Deno.test("a split flow for hosts whose callback is another request", async () => {
  const w = await world();
  const { auth } = session(w, { userAgent: undefined });
  const pending = await auth.beginAuthorization();
  // The host stores `pending` (plain data), sends the user to pending.url,
  // and later gets the callback.
  const stored = JSON.parse(JSON.stringify(pending));
  const callback = await testUserAgent(w.fetch).authorize({
    url: new URL(pending.url),
    redirectUri: pending.redirectUri,
    state: pending.state,
    issuer: pending.issuer,
    resource: ENDPOINT,
    scopes: [],
    signal: new AbortController().signal,
  });
  const fresh = session(w, {
    userAgent: undefined,
    store: memoryOAuthStore(),
  }).auth;
  const tokens = await fresh.completeAuthorization(stored, callback);
  assertEquals(tokens.token_type, "Bearer");
  assertEquals(await whoami(client(w, fresh)), {
    subject: "user-1",
    scopes: ["mcp:read"],
  });
});

Deno.test("DPoP: nonces rotated on every answer are taken up through observe", async () => {
  // Each nonce the resource hands out replaces the one before, and only the
  // latest is accepted.
  let issued = 0;
  const nonce: DpopNonceSource = {
    current: () => Promise.resolve(`nonce-${++issued}`),
    check: (value: string) => Promise.resolve(value === `nonce-${issued}`),
  };
  const w = await world({
    dpop: { required: true, nonce, replay: memoryReplayStore() },
  });
  const { auth } = session(w, { dpop: await DpopKey.generate() });
  const mcp = client(w, auth);
  assertEquals((await whoami(mcp)).subject, "user-1");
  // The challenges named DPoP, with its algorithms.
  assertEquals((await auth.tokens())?.token_type, "DPoP");
  for (let i = 0; i < 3; i++) {
    const before = w.mcpPosts().length;
    await whoami(mcp);
    assertEquals(w.mcpPosts().length - before, 1, "no use_dpop_nonce retry");
    const sent = w.mcpPosts().at(-1)!;
    assert(
      sent.headers.get("authorization")!.startsWith("DPoP "),
      "a DPoP token",
    );
    assertEquals(
      decode(sent.headers.get("dpop")!).payload.nonce,
      `nonce-${issued - 1}`,
    );
  }
});
