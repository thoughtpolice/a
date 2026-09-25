// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link session}: a principal kept in an encrypted (or signed) cookie.
 *
 * @module
 */

import {
  AuthError,
  type AuthScheme,
  markDelegating,
  type PrincipalInput,
  toPrincipal,
} from "./auth.ts";
import type { Context } from "./context.ts";
import { compileCookies } from "./compile.ts";
import {
  checkCookieName,
  type CookieKey,
  CookieKeyring,
  cookieMaxAgeMs,
  type CookieOptions,
  serializeCookie,
} from "./cookies.ts";
import type { Duration } from "./duration.ts";
import { cleartextRefusal } from "./public_url.ts";
import {
  clockValue,
  HTTP_TOKEN,
  optionsRecord,
  optionText,
  optionType,
} from "./validation.ts";
import { parseJsonBounded } from "@celld/core/bounds";

/** Options for {@link session}. */
export interface SessionOptions {
  /** The keyring, or keys for one (newest first). */
  readonly keys: CookieKeyring | readonly CookieKey[];
  /** The cookie; default `__Host-session`. */
  readonly cookie?: string;
  /** How long a session lasts from {@link SessionScheme.issue}; default 8 hours, at most 400 days. */
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
  /**
   * Sets the session cookie for `principal` on the response `c` sends.
   * Pass the principal the login produced (`c.principal`, or one from an
   * OpenID Connect login): its `scheme` and `issuer` are kept, so the
   * session's principal has the same `key`. A principal without a scheme
   * is the session scheme's own.
   */
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
  /** The scheme that first authenticated the principal, when not `session`. */
  readonly sch?: string;
  /** The credential's issuer at login, when there was one. */
  readonly iss?: string;
  readonly iat: number;
  readonly exp: number;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

/** An absent or string part of a principal's key, without its NUL separator. */
function optionalKeyPart(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "string" && !value.includes("\u0000"));
}

function parseStored(text: string): Stored | null {
  let value: unknown;
  try {
    value = parseJsonBounded(text, {
      maxDepth: 32,
      maxItems: 1024,
      maxKeys: 256,
    });
  } catch {
    return null;
  }
  const s = value as Partial<Stored>;
  if (
    typeof value !== "object" || value === null || s.v !== 1 ||
    typeof s.sub !== "string" || s.sub === "" || !isStringList(s.scp) ||
    !isStringList(s.rol) || typeof s.clm !== "object" || s.clm === null ||
    typeof s.iat !== "number" || !Number.isFinite(s.iat) ||
    !Number.isFinite(s.exp) || s.exp! <= s.iat || Array.isArray(s.clm) ||
    !optionalKeyPart(s.cid) || !optionalKeyPart(s.ten) ||
    !optionalKeyPart(s.sch) || !optionalKeyPart(s.iss) ||
    s.sub.includes("\u0000")
  ) {
    return null;
  }
  try {
    toPrincipal({
      subject: s.sub!,
      scopes: s.scp,
      roles: s.rol,
      claims: s.clm,
      clientId: s.cid,
      tenant: s.ten,
      issuer: s.iss,
    }, s.sch ?? "session");
  } catch {
    return null;
  }
  return s as Stored;
}

/**
 * Cookie sessions. The cookie holds the principal (its subject, scopes,
 * roles, claims, client, tenant, and the scheme and issuer that first
 * authenticated it, so its `key` stays the one it had at login) and its
 * expiry, sealed
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
  optionsRecord(options, [
    "keys",
    "cookie",
    "maxAge",
    "cookieOptions",
    "encrypt",
    "now",
    "name",
  ], "session options");
  optionType(options.encrypt, "boolean", "session encrypt");
  optionType(options.now, "function", "session now");
  optionText(options.name, "session name", HTTP_TOKEN);
  const cookie = options.cookie ?? "__Host-session";
  checkCookieName(cookie);
  const keys = options.keys instanceof CookieKeyring
    ? options.keys
    : new CookieKeyring(options.keys);
  const maxAgeMs = cookieMaxAgeMs(options.maxAge ?? "PT8H", "session maxAge");
  const encrypt = options.encrypt ?? true;
  const name = options.name ?? "session";
  const clock = options.now ?? Date.now;
  const now = () => clockValue(clock(), "session clock");
  const attributes = compileCookies(options.cookieOptions);
  serializeCookie(cookie, "", attributes);

  const write = async (c: Context, stored: Stored) => {
    const text = JSON.stringify(stored);
    const value = encrypt
      ? await keys.seal(cookie, text)
      : await keys.sign(cookie, text);
    const remaining = Math.max(0, Math.floor((stored.exp - now()) / 1000));
    c.setCookie(cookie, value, { ...attributes, maxAge: remaining });
  };
  const clear = (c: Context) => c.deleteCookie(cookie, attributes);

  // Its principals name the scheme that first authenticated them (sealed
  // in the cookie at login), not `session`, so their key survives login.
  return markDelegating<SessionScheme>({
    name,
    ambient: true,
    async authenticate(c) {
      const text = c.cookie(cookie);
      if (text === undefined || text === "") return null;
      const refused = cleartextRefusal(c, "session cookies");
      if (refused !== null) return refused;
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
        ...(stored.sch === undefined ? {} : { scheme: stored.sch }),
        ...(stored.iss === undefined ? {} : { issuer: stored.iss }),
        expiresAt: stored.exp,
      };
    },
    async issue(c, principal) {
      principal = toPrincipal(principal, principal.scheme ?? name);
      for (const part of [principal.scheme, principal.issuer]) {
        if (!optionalKeyPart(part)) {
          throw new TypeError(
            "a session principal's scheme and issuer must be strings without NUL",
          );
        }
      }
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
        ...(principal.scheme === undefined || principal.scheme === name
          ? {}
          : { sch: principal.scheme }),
        ...(principal.issuer === undefined ? {} : { iss: principal.issuer }),
        iat: issued,
        exp: issued + maxAgeMs,
      });
    },
    clear,
    openapi: { type: "apiKey", in: "cookie", name: cookie },
  });
}
