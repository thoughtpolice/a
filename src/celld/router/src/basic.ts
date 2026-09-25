// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link basic}: HTTP Basic authentication (RFC 7617), over https only.
 *
 * @module
 */

import { AuthError, type AuthScheme, type PrincipalInput } from "./auth.ts";
import type { Context } from "./context.ts";

/** Options for {@link basic}. */
export interface BasicOptions {
  /**
   * The principal for a user name and password, or null. Compare stored
   * password hashes, or use `timingSafeEqual`/`secretEquals` for a fixed
   * secret, never `===`.
   */
  readonly verify: (
    username: string,
    password: string,
    c: Context,
  ) => PrincipalInput | null | Promise<PrincipalInput | null>;
  /** Default `api`. */
  readonly realm?: string;
  /**
   * Accept Basic credentials on plain `http:` requests. Default false: the
   * password would cross the network in the clear.
   */
  readonly allowInsecure?: boolean;
  /** Default `basic`. */
  readonly name?: string;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeCredentials(text: string): [string, string] | null {
  if (!BASE64.test(text) || text.length % 4 !== 0) return null;
  let decoded: string;
  try {
    decoded = decoder.decode(
      Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1 || /\p{Cc}/u.test(decoded)) return null;
  return [decoded.slice(0, colon), decoded.slice(colon + 1)];
}

/**
 * HTTP Basic. Browsers send these credentials by themselves, so it is an
 * ambient scheme: state-changing requests it authenticates get the CSRF
 * check.
 *
 * - No Basic credential: null (the 401 carries
 *   `Basic realm="api", charset="UTF-8"`).
 * - On plain http without `allowInsecure`: 403 `insecure_transport`, and no
 *   challenge is ever sent there, so browsers do not prompt for a password.
 * - Malformed base64, no colon, or not UTF-8: 400 `invalid_request`.
 * - Wrong user name or password: 401 `invalid_credentials`, with the same
 *   challenge (RFC 7617 defines no error parameters).
 */
export function basic(options: BasicOptions): AuthScheme {
  const realm = options.realm ?? "api";
  const insecure = (c: Context) =>
    c.url.protocol !== "https:" && !(options.allowInsecure ?? false);
  return {
    name: options.name ?? "basic",
    ambient: true,
    async authenticate(c) {
      const header = c.req.headers.get("authorization");
      if (header === null) return null;
      const match = /^basic[ \t]+(.*)$/is.exec(header.trim());
      if (match === null) return null;
      if (insecure(c)) {
        return new AuthError(
          "insecure_transport",
          "Basic credentials are refused over plain http",
        );
      }
      const credentials = decodeCredentials(match[1].trim());
      if (credentials === null) {
        return new AuthError(
          "invalid_request",
          "the Basic credentials are malformed",
        );
      }
      const principal = await options.verify(credentials[0], credentials[1], c);
      return principal ??
        new AuthError(
          "invalid_credentials",
          "the user name or password is wrong",
        );
    },
    challenge(error, c) {
      if (insecure(c) || error?.code === "insecure_transport") return null;
      return {
        scheme: "Basic",
        params: [["realm", realm], ["charset", "UTF-8"]],
      };
    },
    openapi: { type: "http", scheme: "basic" },
  };
}
