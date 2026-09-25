// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The security headers every response gets unless it set its own, and
 * the cache rules for authenticated answers.
 *
 * @module
 */

/**
 * Header values; `false` turns one off. A response that already has a
 * header keeps its own value.
 */
export interface SecurityHeaders {
  /** `X-Content-Type-Options`; default `nosniff`. */
  readonly contentTypeOptions?: string | false;
  /** `Referrer-Policy`; default `no-referrer`. */
  readonly referrerPolicy?: string | false;
  /** `X-Frame-Options`; default `DENY`. */
  readonly frameOptions?: string | false;
  /**
   * `Content-Security-Policy` for responses that are not HTML; default
   * `default-src 'none'; frame-ancestors 'none'`.
   */
  readonly csp?: string | false;
  /** `Content-Security-Policy` for `text/html`; default {@link HTML_CSP}. */
  readonly htmlCsp?: string | false;
  /**
   * `Strict-Transport-Security`, sent only on https requests; default
   * `max-age=63072000; includeSubDomains` (two years).
   */
  readonly hsts?: string | false;
  /**
   * Keeps answers to authenticated requests, and 401s and 403s, out of
   * shared caches, so no cache hands one user's answer to the next.
   * Default true:
   *
   * - `Cache-Control: private, no-store` overrides every handler/upstream
   *   directive after authentication or credential refusal, including custom
   *   header schemes, malformed credentials, and login redirects;
   * - an authenticated answer gets `Vary: Authorization, Cookie`.
   *
   * `false` turns all of it off, for a router whose authenticated answers
   * may be shared.
   */
  readonly noStore?: boolean;
}

/** The default CSP for HTML: same-origin scripts, styles, images, fonts and fetches, no frames, no plugins. */
export const HTML_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The default CSP for everything else: nothing may load, nothing may frame it. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** The default HSTS value. */
export const HSTS = "max-age=63072000; includeSubDomains";

/** Adds `value` to `Vary` unless it (or `*`) is there. */
export function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (current === null) {
    headers.set("vary", value);
    return;
  }
  const names = current.split(",").map((name) => name.trim().toLowerCase());
  if (!names.includes(value.toLowerCase()) && !names.includes("*")) {
    headers.set("vary", `${current}, ${value}`);
  }
}

function setDefault(
  headers: Headers,
  name: string,
  value: string | false | undefined,
): void {
  if (value !== false && value !== undefined && !headers.has(name)) {
    headers.set(name, value);
  }
}

/** Adds the security headers `options` asks for to `headers`. */
export function applySecurityHeaders(
  headers: Headers,
  options: SecurityHeaders,
  https: boolean,
  authenticated: boolean,
  status: number,
): void {
  setDefault(
    headers,
    "x-content-type-options",
    options.contentTypeOptions ?? "nosniff",
  );
  setDefault(
    headers,
    "referrer-policy",
    options.referrerPolicy ?? "no-referrer",
  );
  setDefault(headers, "x-frame-options", options.frameOptions ?? "DENY");
  const type = (headers.get("content-type") ?? "").split(";")[0].trim()
    .toLowerCase();
  const csp = type === "text/html"
    ? options.htmlCsp ?? HTML_CSP
    : options.csp ?? API_CSP;
  setDefault(headers, "content-security-policy", csp);
  if (https) {
    setDefault(headers, "strict-transport-security", options.hsts ?? HSTS);
  }
  if (
    (options.noStore ?? true) &&
    (authenticated || status === 401 || status === 403)
  ) {
    headers.set("cache-control", "private, no-store");
    if (authenticated) {
      appendVary(headers, "Authorization");
      appendVary(headers, "Cookie");
    }
  }
}
