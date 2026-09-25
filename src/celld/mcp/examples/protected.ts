// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An MCP server behind OAuth: `@celld/sec/oauth`'s `ResourceServer` validating
 * JWT access tokens, with per-tool scopes.
 *
 * `POST /mcp` serves a notes server to callers with a bearer token from
 * `OAUTH_ISSUER`. `jwtAccessTokenVerifier` checks each token's signature
 * against the issuer's JWK Set (fetched from `OAUTH_JWKS_URI` on first use,
 * then cached), and the RFC 9068 profile: `typ` `at+jwt`, the issuer, the
 * audience (it must name `MCP_RESOURCE`: a token minted for another server
 * is refused), expiry, and `sub`, `client_id`, `iat` and `jti`.
 * `list_notes` needs the `notes:read` scope and `add_note` `notes:write`;
 * `whoami` needs none. The resource takes Bearer tokens only (`dpop:
 * false`), so its challenges name Bearer alone.
 *
 * Notes are kept in KV per caller: under a keyed HMAC of the principal's `key`
 * (issuer, client id and subject), not of its `subject` alone, so the same
 * user through another client is another owner. Each note is its own KV
 * key, so two concurrent `add_note` calls cannot overwrite each other, and
 * `list_notes` reads them back with one bounded `list`. A note is at most
 * 1000 characters and a caller keeps at most 100. KV has no atomic count,
 * so concurrent adds can pass that cap by a few; a store that must hold an
 * exact limit, or must never lose a write, belongs in a Durable Object.
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

import { mcpHttpHandler, McpServer, ToolError } from "@celld/mcp";
import {
  jwtAccessTokenVerifier,
  ResourceServer,
} from "@celld/sec/oauth/resource";
import { v } from "@celld/sieve";
import { opaqueIdentity } from "@celld/core/bounds";

interface Env {
  readonly MCP_RESOURCE: string;
  readonly OAUTH_ISSUER: string;
  readonly OAUTH_JWKS_URI: string;
  /** "true" lets the fake issuer's http://127.0.0.1 JWKS through. */
  readonly JWKS_LOOPBACK_FOR_DEVELOPMENT?: string;
  readonly NOTES: KVNamespace;
  /** Independent stable random key; changing it moves the ownership namespace. */
  readonly IDENTITY_SECRET: string;
}

const MAX_NOTES = 100;

async function build(
  env: Env,
): Promise<(request: Request) => Promise<Response>> {
  if (
    typeof env.IDENTITY_SECRET !== "string" ||
    env.IDENTITY_SECRET.length < 32 || env.IDENTITY_SECRET.length > 4096
  ) {
    throw new TypeError(
      "IDENTITY_SECRET must be a stable random secret of at least 32 bytes",
    );
  }
  const identityKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.IDENTITY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const ownerOf = async (key: string): Promise<string> =>
    `notes:${await opaqueIdentity(identityKey, "celld/mcp/notes", key)}:`;
  const resource = new ResourceServer({
    resource: env.MCP_RESOURCE,
    authorizationServers: [env.OAUTH_ISSUER],
    scopesSupported: ["notes:read", "notes:write"],
    metadata: { resource_name: "Notes" },
    verifier: jwtAccessTokenVerifier({
      issuer: env.OAUTH_ISSUER,
      audience: env.MCP_RESOURCE,
      keys: env.OAUTH_JWKS_URI,
      allowLoopbackForDevelopment: env.JWKS_LOOPBACK_FOR_DEVELOPMENT === "true",
    }),
    dpop: false,
  });

  const server = new McpServer({ info: { name: "notes", version: "1.0.0" } });
  const notesOf = async (owner: string): Promise<string[]> => {
    const { keys } = await env.NOTES.list({ prefix: owner, limit: MAX_NOTES });
    if (keys.length === 0) return [];
    const texts = await env.NOTES.get(keys.map((key) => key.name), "text");
    return keys.map((key) => texts.get(key.name)).filter((text) =>
      text !== null && text !== undefined
    );
  };

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
      structuredContent: {
        notes: await notesOf(await ownerOf(ctx.principal!.key)),
      },
    }),
  });

  server.tool({
    name: "add_note",
    scopes: ["notes:write"],
    input: v.strictObject({ text: v.string().min(1).max(1000) }),
    run: async ({ text }, ctx) => {
      const owner = await ownerOf(ctx.principal!.key);
      const { keys } = await env.NOTES.list({
        prefix: owner,
        limit: MAX_NOTES,
      });
      if (keys.length >= MAX_NOTES) {
        throw new ToolError(`a caller keeps at most ${MAX_NOTES} notes`);
      }
      // Keys sort by time, then a random suffix for notes in the same
      // millisecond, so a list reads them back oldest first.
      const id = `${
        Date.now().toString().padStart(16, "0")
      }:${crypto.randomUUID()}`;
      await env.NOTES.put(`${owner}${id}`, text);
      return `${keys.length + 1} notes`;
    },
  });

  return mcpHttpHandler(server, {
    path: "/mcp",
    resource,
    router: {
      publicUrl: { mode: "fixed", origin: new URL(env.MCP_RESOURCE).origin },
    },
  });
}

let handler: ReturnType<typeof build> | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    handler ??= build(env);
    return await (await handler)(request);
  },
};
