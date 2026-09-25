// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link apiKey}: API keys in a header or query parameter, looked up by
 * their hash.
 *
 * @module
 */

import {
  AuthError,
  type AuthScheme,
  errorParams,
  type PrincipalInput,
} from "./auth.ts";
import type { Context } from "./context.ts";
import { RouterError } from "./errors.ts";

/** Options for {@link apiKey}: `header` or `query`, not both. */
export interface ApiKeyOptions {
  /** The header carrying the key; default `x-api-key` when `query` is not set. */
  readonly header?: string;
  /**
   * The query parameter carrying the key. Keys in URLs end up in logs;
   * prefer a header, and use this only for clients that cannot set one.
   */
  readonly query?: string;
  /**
   * The principal for a key, or null. Store keys hashed: look up
   * `await hashApiKey(key)` (or use {@link hashedKeys}), so a leaked table
   * holds no usable key and the lookup's timing reveals nothing about one.
   */
  readonly lookup: (
    key: string,
    c: Context,
  ) => PrincipalInput | null | Promise<PrincipalInput | null>;
  /** The challenge's realm; default `api`. */
  readonly realm?: string;
  /** Default `apiKey`. */
  readonly name?: string;
}

const KEY = /^[\x21-\x2B\x2D-\x7E]{1,512}$/;

/**
 * The lower-case hex SHA-256 of an API key: what to store instead of the
 * key. Keys should be long and random (32 bytes, say), which is what makes
 * a plain fast hash enough.
 */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

/**
 * A `lookup` over a table from key hashes ({@link hashApiKey}) to
 * principals, such as one parsed from a secret variable.
 */
export function hashedKeys(
  table: Readonly<Record<string, PrincipalInput>>,
): ApiKeyOptions["lookup"] {
  const map = new Map(
    Object.entries(table).map(([hash, p]) => [hash.toLowerCase(), p]),
  );
  return async (key) => map.get(await hashApiKey(key)) ?? null;
}

/**
 * API keys. No key: null (the 401 challenge is `ApiKey realm="api",
 * header="x-api-key"`). A key with spaces, commas or control characters,
 * or longer than 512: 400 `invalid_request`. An unknown key: 401
 * `invalid_credentials`.
 */
export function apiKey(options: ApiKeyOptions): AuthScheme {
  if (options.header !== undefined && options.query !== undefined) {
    throw new RouterError(
      "apiKey takes a header or a query parameter, not both",
    );
  }
  const query = options.query;
  const header = query === undefined
    ? (options.header ?? "x-api-key").toLowerCase()
    : undefined;
  const where: readonly [string, string] = header === undefined
    ? ["query", query!]
    : ["header", header];
  return {
    name: options.name ?? "apiKey",
    async authenticate(c) {
      let key: string | null;
      if (header !== undefined) {
        key = c.req.headers.get(header);
      } else {
        const values = c.url.searchParams.getAll(query!);
        if (values.length > 1) {
          return new AuthError(
            "invalid_request",
            "more than one API key was sent",
          );
        }
        key = values[0] ?? null;
      }
      if (key === null) return null;
      if (!KEY.test(key)) {
        return new AuthError("invalid_request", "the API key is malformed");
      }
      const principal = await options.lookup(key, c);
      return principal ??
        new AuthError("invalid_credentials", "the API key is not valid");
    },
    challenge(error) {
      return {
        scheme: "ApiKey",
        params: [
          ["realm", options.realm ?? "api"],
          where,
          ...errorParams(error),
        ],
      };
    },
    openapi: { type: "apiKey", in: where[0], name: where[1] },
  };
}
