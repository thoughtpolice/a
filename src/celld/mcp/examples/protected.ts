// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An MCP server behind OAuth: `@celld/oauth`'s `ResourceServer` validating
 * JWT access tokens, with per-tool scopes.
 *
 * `POST /mcp` serves a notes server to callers with a bearer token from
 * `OAUTH_ISSUER`. `jwtAccessTokenVerifier` checks each token's signature
 * against the issuer's JWK Set (fetched from `OAUTH_JWKS_URI` on first use,
 * then cached), and the RFC 9068 profile: `typ` `at+jwt`, the issuer, the
 * audience (it must name `MCP_RESOURCE`: a token minted for another server
 * is refused), expiry, and `sub`, `client_id`, `iat` and `jti`.
 * `list_notes` needs the `notes:read` scope and `add_note` `notes:write`;
 * `whoami` needs none. Notes are kept in KV per subject. The resource takes
 * Bearer tokens only (`dpop: false`), so its challenges name Bearer alone.
 *
 * - No token, or a bad one: 401 with a `WWW-Authenticate: Bearer` challenge
 *   naming the Protected Resource Metadata (`error="invalid_token"` when a
 *   token was sent).
 * - A good token without a tool's scope: 403 `insufficient_scope` with the
 *   scope to ask for, from the router, with the same `resource_metadata`.
 * - `GET /.well-known/oauth-protected-resource/mcp`: the metadata document
 *   (RFC 9728), which tells a client where to get tokens. It and the
 *   challenges name the resource's public URL (`MCP_RESOURCE`), not the
 *   address the Worker happens to be reached at.
 *
 * Handlers see the subject, scopes and claims, never the token itself, so
 * they cannot pass it on to another API.
 *
 * ```sh
 * buck2 run root//src/celld/mcp/examples:protected-dev
 * curl -sS localhost:9876/.well-known/oauth-protected-resource/mcp
 * ```
 *
 * The fake issuer (`issuer.ts`) mints tokens for `curl` at `POST /token`.
 *
 * @module
 */

import { mcpHttpHandler, McpServer } from "@celld/mcp";
import { jwtAccessTokenVerifier, ResourceServer } from "@celld/oauth/resource";
import { v } from "@celld/sieve";

interface Env {
  readonly MCP_RESOURCE: string;
  readonly OAUTH_ISSUER: string;
  readonly OAUTH_JWKS_URI: string;
  readonly NOTES: KVNamespace;
}

function build(env: Env): (request: Request) => Promise<Response> {
  const resource = new ResourceServer({
    resource: env.MCP_RESOURCE,
    authorizationServers: [env.OAUTH_ISSUER],
    scopesSupported: ["notes:read", "notes:write"],
    metadata: { resource_name: "Notes" },
    verifier: jwtAccessTokenVerifier({
      issuer: env.OAUTH_ISSUER,
      audience: env.MCP_RESOURCE,
      keys: env.OAUTH_JWKS_URI,
    }),
    dpop: false,
  });

  const server = new McpServer({ info: { name: "notes", version: "1.0.0" } });
  const notesOf = async (subject: string): Promise<string[]> =>
    await env.NOTES.get<string[]>(`notes:${subject}`, "json") ?? [];

  server.tool({
    name: "whoami",
    description: "Who the access token says the caller is.",
    run: (_args, ctx) =>
      JSON.stringify({
        subject: ctx.principal?.subject,
        scopes: ctx.principal?.scopes,
        client: ctx.principal?.clientId,
      }),
  });

  server.tool({
    name: "list_notes",
    scopes: ["notes:read"],
    output: v.strictObject({ notes: v.array(v.string()) }),
    run: async (_args, ctx) => ({
      structuredContent: { notes: await notesOf(ctx.principal!.subject) },
    }),
  });

  server.tool({
    name: "add_note",
    scopes: ["notes:write"],
    input: v.strictObject({ text: v.string().min(1) }),
    run: async ({ text }, ctx) => {
      const subject = ctx.principal!.subject;
      const notes = [...await notesOf(subject), text];
      await env.NOTES.put(`notes:${subject}`, JSON.stringify(notes));
      return `${notes.length} notes`;
    },
  });

  return mcpHttpHandler(server, { path: "/mcp", resource });
}

let handler: ReturnType<typeof build> | null = null;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    handler ??= build(env);
    return handler(request);
  },
};
