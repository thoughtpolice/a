// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `WWW-Authenticate` (RFC 9110 section 11.6.1), both ways:
 * {@link parseWwwAuthenticate} reads every challenge in a header, and
 * {@link formatChallenge} writes one. {@link resourceChallenge} picks out
 * the `Bearer` (RFC 6750) or `DPoP` (RFC 9449 section 7.1) challenge a
 * protected resource sent, with RFC 9728's `resource_metadata`.
 *
 * A header holds challenges, each a scheme followed by a token68 or by
 * comma-separated `name=value` parameters (a token or quoted string).
 * Commas separate both, so a comma followed by `token=` continues the
 * parameters and anything else starts a new challenge.
 *
 * @module
 */

/** One challenge. Parameter names are lowercased; values are unquoted. */
export interface AuthChallengeParams {
  readonly scheme: string;
  readonly params: Readonly<Record<string, string>>;
  readonly token68: string | null;
}

const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TOKEN68 = /^([A-Za-z0-9\-._~+/]+=*)[ \t]*(?=,|$)/;

/** Every challenge in a `WWW-Authenticate` value; stops at malformed input. */
export function parseWwwAuthenticate(header: string): AuthChallengeParams[] {
  const out: AuthChallengeParams[] = [];
  let i = 0;
  const n = header.length;
  const space = () => {
    while (i < n && (header[i] === " " || header[i] === "\t")) i++;
  };
  const separators = () => {
    while (
      i < n && (header[i] === " " || header[i] === "\t" || header[i] === ",")
    ) i++;
  };
  const token = () => {
    const start = i;
    while (i < n && TCHAR.test(header[i])) i++;
    return header.slice(start, i);
  };
  const quoted = (): string | null => {
    if (header[i] !== '"') return null;
    i++;
    let value = "";
    while (i < n) {
      const c = header[i++];
      if (c === '"') return value;
      if (c === "\\" && i < n) value += header[i++];
      else value += c;
    }
    return null;
  };
  const paramAhead = () => {
    const save = i;
    const name = token();
    space();
    const is = name !== "" && header[i] === "=";
    i = save;
    return is;
  };

  separators();
  while (i < n) {
    const scheme = token();
    if (scheme === "") break;
    const params: Record<string, string> = {};
    let token68: string | null = null;
    space();
    const bare = TOKEN68.exec(header.slice(i));
    if (bare !== null) {
      token68 = bare[1];
      i += bare[0].length;
    } else {
      for (;;) {
        separators();
        if (!paramAhead()) break;
        const name = token().toLowerCase();
        space();
        i++;
        space();
        const value = header[i] === '"' ? quoted() : token();
        if (value === null) {
          out.push({ scheme, params, token68 });
          return out;
        }
        params[name] = value;
        space();
        if (header[i] !== ",") break;
      }
    }
    out.push({ scheme, params, token68 });
    separators();
  }
  return out;
}

/**
 * One challenge as header text. Parameter values are quoted strings with
 * `"` and `\` escaped; characters a header cannot carry (controls, and
 * anything outside visible ASCII) are dropped. Parameters with undefined
 * values are left out.
 */
export function formatChallenge(
  scheme: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  if (!TOKEN.test(scheme)) throw new TypeError(`bad auth scheme ${scheme}`);
  const parts: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (!TOKEN.test(name)) throw new TypeError(`bad parameter name ${name}`);
    const clean = value.replace(/[^\x20-\x7E]/g, "").replace(/["\\]/g, "\\$&");
    parts.push(`${name}="${clean}"`);
  }
  return parts.length === 0 ? scheme : `${scheme} ${parts.join(", ")}`;
}

/** What a protected resource's `Bearer` or `DPoP` challenge says. */
export interface ResourceChallenge {
  /** `Bearer` or `DPoP`, as the server spelled it. */
  readonly scheme: string;
  /** RFC 9728: where the Protected Resource Metadata is. */
  readonly resourceMetadata: string | null;
  /** The scopes the request needs, split on spaces. */
  readonly scopes: readonly string[] | null;
  /** `invalid_token`, `insufficient_scope`, `use_dpop_nonce`, ... */
  readonly error: string | null;
  readonly description: string | null;
  /** DPoP only: the proof algorithms the resource accepts. */
  readonly algs: readonly string[] | null;
  readonly realm: string | null;
}

function split(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  return value.split(" ").filter((part) => part !== "");
}

/**
 * The challenge of `scheme` in a `WWW-Authenticate` value, or null.
 * Without a scheme, the `Bearer` or `DPoP` challenge that carries an
 * `error` (the one for the scheme the request used), else the `DPoP` one,
 * else the `Bearer` one.
 */
export function resourceChallenge(
  header: string | null | undefined,
  scheme?: "Bearer" | "DPoP",
): ResourceChallenge | null {
  if (header === null || header === undefined) return null;
  const all = parseWwwAuthenticate(header);
  const find = (name: string) =>
    all.find((challenge) =>
      challenge.scheme.toLowerCase() === name.toLowerCase()
    );
  const withError = [find("DPoP"), find("Bearer")].find((challenge) =>
    challenge?.params.error !== undefined
  );
  const found = scheme === undefined
    ? withError ?? find("DPoP") ?? find("Bearer")
    : find(scheme);
  if (found === undefined) return null;
  return {
    scheme: found.scheme,
    resourceMetadata: found.params.resource_metadata ?? null,
    scopes: split(found.params.scope),
    error: found.params.error ?? null,
    description: found.params.error_description ?? null,
    algs: split(found.params.algs),
    realm: found.params.realm ?? null,
  };
}

/** Every scheme with a challenge in the header, as written. */
export function challengeSchemes(header: string | null | undefined): string[] {
  if (header === null || header === undefined) return [];
  return parseWwwAuthenticate(header).map((challenge) => challenge.scheme);
}
