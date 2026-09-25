// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link session}: a principal kept in an encrypted (or signed) cookie.
 *
 * @module
 */

import { AuthError, type AuthScheme, type PrincipalInput } from "./auth.ts";
import type { Context } from "./context.ts";
import {
  checkCookieName,
  type CookieKey,
  CookieKeyring,
  type CookieOptions,
} from "./cookies.ts";
import { type Duration, durationMs } from "./duration.ts";

/** Options for {@link session}. */
export interface SessionOptions {
  /** The keyring, or keys for one (newest first). */
  readonly keys: CookieKeyring | readonly CookieKey[];
  /** The cookie; default `__Host-session`. */
  readonly cookie?: string;
  /** How long a session lasts from {@link SessionScheme.issue}; default 8 hours. */
  readonly maxAge?: Duration;
  /** Cookie attributes over the defaults (`HttpOnly; Secure; SameSite=Lax; Path=/`). */
  readonly cookieOptions?: CookieOptions;
  /**
   * Encrypt the session (AES-GCM), so the client cannot read its claims.
   * Default true; false signs it (HMAC) instead, readable but not changeable.
   */
  readonly encrypt?: boolean;
  /** Milliseconds since the epoch; default `Date.now`. */
  readonly now?: () => number;
  /** Default `session`. */
  readonly name?: string;
}

/** A session scheme, with the calls that start and end sessions. */
export interface SessionScheme extends AuthScheme {
  /** Sets the session cookie for `principal` on the response `c` sends. */
  issue(c: Context, principal: PrincipalInput): Promise<void>;
  /** Expires the session cookie. */
  clear(c: Context): void;
}

interface Stored {
  readonly v: 1;
  readonly sub: string;
  readonly scp: readonly string[];
  readonly rol: readonly string[];
  readonly clm: Readonly<Record<string, unknown>>;
  readonly cid?: string;
  readonly ten?: string;
  readonly iat: number;
  readonly exp: number;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

function parseStored(text: string): Stored | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const s = value as Partial<Stored>;
  if (
    typeof value !== "object" || value === null || s.v !== 1 ||
    typeof s.sub !== "string" || s.sub === "" || !isStringList(s.scp) ||
    !isStringList(s.rol) || typeof s.clm !== "object" || s.clm === null ||
    typeof s.iat !== "number" || typeof s.exp !== "number" ||
    (s.cid !== undefined && typeof s.cid !== "string") ||
    (s.ten !== undefined && typeof s.ten !== "string")
  ) {
    return null;
  }
  return s as Stored;
}

/**
 * Cookie sessions. The cookie holds the principal and its expiry, sealed
 * with the keyring's current key; any key in the ring opens it, and a
 * session opened with an older key is sealed again with the current one on
 * the way out, so rotating a secret needs no logout.
 *
 * Cookies are ambient credentials, so state-changing requests on a session
 * get the router's CSRF check.
 *
 * - No cookie: null.
 * - A cookie that does not open (tampered, another key, another cookie's
 *   value) or has expired: 401 `invalid_credentials`, and the response
 *   expires the cookie so the next request is anonymous.
 */
export function session(options: SessionOptions): SessionScheme {
  const cookie = options.cookie ?? "__Host-session";
  checkCookieName(cookie);
  const keys = options.keys instanceof CookieKeyring
    ? options.keys
    : new CookieKeyring(options.keys);
  const maxAgeMs = durationMs(options.maxAge ?? "PT8H", "session maxAge");
  const encrypt = options.encrypt ?? true;
  const now = options.now ?? Date.now;
  const attributes = options.cookieOptions ?? {};

  const write = async (c: Context, stored: Stored) => {
    const text = JSON.stringify(stored);
    const value = encrypt
      ? await keys.seal(cookie, text)
      : await keys.sign(cookie, text);
    const remaining = Math.max(0, Math.floor((stored.exp - now()) / 1000));
    c.setCookie(cookie, value, { ...attributes, maxAge: remaining });
  };
  const clear = (c: Context) => c.deleteCookie(cookie, attributes);

  return {
    name: options.name ?? "session",
    ambient: true,
    async authenticate(c) {
      const text = c.cookie(cookie);
      if (text === undefined || text === "") return null;
      const opened = encrypt
        ? await keys.unseal(cookie, text)
        : await keys.verify(cookie, text);
      const stored = opened === null ? null : parseStored(opened.value);
      if (stored === null || stored.exp <= now()) {
        clear(c);
        return new AuthError(
          "invalid_credentials",
          stored === null ? "the session is not valid" : "the session expired",
        );
      }
      if (opened!.stale) await write(c, stored);
      return {
        subject: stored.sub,
        scopes: stored.scp,
        roles: stored.rol,
        claims: stored.clm,
        ...(stored.cid === undefined ? {} : { clientId: stored.cid }),
        ...(stored.ten === undefined ? {} : { tenant: stored.ten }),
      };
    },
    async issue(c, principal) {
      const issued = now();
      await write(c, {
        v: 1,
        sub: principal.subject,
        scp: [...principal.scopes ?? []],
        rol: [...principal.roles ?? []],
        clm: { ...principal.claims },
        ...(principal.clientId === undefined
          ? {}
          : { cid: principal.clientId }),
        ...(principal.tenant === undefined ? {} : { ten: principal.tenant }),
        iat: issued,
        exp: issued + maxAgeMs,
      });
    },
    clear,
    openapi: { type: "apiKey", in: "cookie", name: cookie },
  };
}
