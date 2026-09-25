// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The target URI rules of RFC 9449 (sections 4.2 and 4.3): a proof's `htu`
 * is the request URI without its query and fragment, and the server
 * compares it with the URI it received after syntax- and scheme-based
 * normalization (RFC 3986 sections 6.2.2 and 6.2.3).
 *
 * @module
 */

const UNRESERVED = /[A-Za-z0-9\-._~]/;

function normalizePercent(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/**
 * The normalized `htu` for a request URL: lowercase scheme and host, no
 * default port, no user information, dot segments resolved, an empty path
 * as `/`, percent-encoded unreserved characters decoded and other escapes
 * in upper case, and no query or fragment. Throws `TypeError` for a URL
 * that does not parse.
 */
export function normalizeHtu(url: string | URL): string {
  const parsed = new URL(String(url));
  const path = parsed.pathname === "" ? "/" : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${normalizePercent(path)}`;
}

/** Whether a proof's `htu` names the request URL, after {@link normalizeHtu}. */
export function htuMatches(htu: unknown, url: string | URL): boolean {
  if (typeof htu !== "string") return false;
  try {
    return normalizeHtu(htu) === normalizeHtu(url);
  } catch {
    return false;
  }
}
