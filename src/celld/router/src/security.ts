// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The security headers every response gets unless it set its own.
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
   * `Cache-Control: no-store` on responses to authenticated requests and
   * on 401 and 403, so no shared cache keeps one user's answer for the
   * next. Default true.
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
    setDefault(headers, "cache-control", "no-store");
  }
}
