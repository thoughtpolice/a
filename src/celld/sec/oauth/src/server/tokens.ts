// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The authorization server's tokens:
 *
 * - access tokens are JWTs in the RFC 9068 profile (`typ: at+jwt`, `iss`,
 *   `exp`, `aud`, `sub`, `client_id`, `iat`, `jti`, `scope`), signed with
 *   the first of the server's {@link SigningKey}s, with `cnf.jkt` when
 *   DPoP-bound (RFC 9449 section 6.1);
 * - refresh tokens are `<family>.<secret>`: the family names a stored
 *   record, which holds only hashes of the tokens.
 *
 * @module
 */

import {
  createVerifier,
  generateKeyPair,
  importKey,
  type Jwk,
  type Jwks,
  type JwsAlgorithm,
  type KeyLike,
  localJwks,
  publicJwk,
  sign,
} from "@celld/sec/jwt";
import {
  type Clock,
  formatScope,
  randomToken,
  rethrowRuntimeUnsupported,
} from "../util.ts";

/**
 * The algorithms a server may sign with: asymmetric ones only. A server's
 * keys are published in its JWKS, and an HMAC key has no public half:
 * publishing it would hand out the secret, and anyone verifying with it
 * could also mint tokens.
 */
export const SIGNING_ALGORITHMS = Object.freeze(
  [
    "RS256",
    "RS384",
    "RS512",
    "PS256",
    "PS384",
    "PS512",
    "ES256",
    "ES384",
    "ES512",
    "EdDSA",
    "Ed25519",
  ] as const satisfies readonly JwsAlgorithm[],
);

/** An asymmetric signing algorithm; see {@link SIGNING_ALGORITHMS}. */
export type SigningAlgorithm = typeof SIGNING_ALGORITHMS[number];

declare const SIGNING_KEY: unique symbol;

/**
 * A key the server signs access tokens with. Only
 * {@link generateSigningKey} and {@link signingKeyFromJwk} make one: the
 * type is branded, and the server checks at construction that every key
 * came from them, so a hand-built (say, HMAC) key cannot be configured.
 * Keys are frozen.
 */
export interface SigningKey {
  readonly alg: SigningAlgorithm;
  readonly kid: string;
  readonly privateKey: KeyLike;
  /** Published in the JWKS; never has a private or secret member. */
  readonly publicJwk: Jwk;
  readonly [SIGNING_KEY]: true;
}

const minted = new WeakSet<object>();

/** Members only a private or symmetric JWK has. */
const SECRET_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

function signingAlgorithm(alg: unknown): SigningAlgorithm {
  if (!(SIGNING_ALGORITHMS as readonly unknown[]).includes(alg)) {
    throw new TypeError(
      `a server signing key must use an asymmetric algorithm (${
        SIGNING_ALGORITHMS.join(", ")
      }), not ${String(alg)}`,
    );
  }
  return alg as SigningAlgorithm;
}

function mint(
  alg: SigningAlgorithm,
  kid: string,
  privateKey: KeyLike,
  publicJwkValue: Jwk,
): SigningKey {
  for (const member of SECRET_MEMBERS) {
    if (Object.hasOwn(publicJwkValue, member)) {
      throw new TypeError(`a public signing JWK must not carry ${member}`);
    }
  }
  const key = Object.freeze({
    alg,
    kid,
    privateKey,
    // Frozen all the way down (`key_ops`, `x5c`), so option snapshots keep
    // the key itself rather than a copy the brand does not know.
    publicJwk: Object.freeze(
      Object.fromEntries(
        Object.entries(publicJwkValue).map(([name, item]) => [
          name,
          Array.isArray(item) ? Object.freeze([...item]) : item,
        ]),
      ),
    ),
  }) as unknown as SigningKey;
  minted.add(key);
  return key;
}

/** Whether `value` is a {@link SigningKey} made by this module's helpers. */
export function isSigningKey(value: unknown): value is SigningKey {
  return typeof value === "object" && value !== null && minted.has(value);
}

/**
 * Checks a server's keys: at least one, each made by
 * {@link generateSigningKey} or {@link signingKeyFromJwk}, with distinct
 * `kid`s. Throws `TypeError`.
 */
export function checkSigningKeys(keys: readonly SigningKey[]): void {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new TypeError("an authorization server needs a signing key");
  }
  const kids = new Set<string>();
  for (const key of keys) {
    if (!isSigningKey(key)) {
      throw new TypeError(
        "signing keys must come from generateSigningKey or signingKeyFromJwk",
      );
    }
    if (kids.has(key.kid)) {
      throw new TypeError(`two signing keys have the kid ${key.kid}`);
    }
    kids.add(key.kid);
  }
}

/**
 * A new signing key: ES256 unless `alg` says otherwise, with a random
 * `kid` by default. Throws `TypeError` for an HMAC algorithm.
 */
export async function generateSigningKey(
  alg: JwsAlgorithm = "ES256",
  kid: string = randomToken(8),
): Promise<SigningKey> {
  const checked = signingAlgorithm(alg);
  const pair = await generateKeyPair(checked, { kid });
  return mint(checked, kid, pair.privateKey, { ...pair.publicJwk, use: "sig" });
}

/**
 * A signing key from a private JWK (with `kid`), for keys kept in
 * secrets. Throws `TypeError` for an HMAC algorithm or a symmetric JWK.
 */
export async function signingKeyFromJwk(
  jwk: Jwk,
  alg: JwsAlgorithm,
): Promise<SigningKey> {
  const checked = signingAlgorithm(alg);
  if (jwk.kid === undefined) throw new TypeError("a signing JWK needs a kid");
  if (jwk.kty === "oct" || Object.hasOwn(jwk, "k")) {
    throw new TypeError("a server signing key cannot be a symmetric JWK");
  }
  const privateKey = await importKey(jwk, checked, "sign");
  const { key_ops: _ops, ext: _ext, ...rest } = publicJwk(jwk);
  return mint(checked, jwk.kid, privateKey, {
    ...rest,
    kid: jwk.kid,
    alg: checked,
    use: "sig",
  });
}

/** The JWKS of a server's keys; throws `TypeError` for a key not made by the helpers. */
export function publicJwks(keys: readonly SigningKey[]): Jwks {
  return {
    keys: keys.map((key) => {
      if (!isSigningKey(key)) {
        throw new TypeError(
          "signing keys must come from generateSigningKey or signingKeyFromJwk",
        );
      }
      return { ...key.publicJwk, kid: key.kid, alg: key.alg };
    }),
  };
}

/** What an access token asserts. */
export interface AccessTokenGrant {
  readonly subject: string;
  readonly clientId: string;
  readonly scope: readonly string[];
  /** RFC 8707 resources: the `aud`. */
  readonly audience: readonly string[];
  /** DPoP key thumbprint, for a bound token. */
  readonly jkt?: string;
  /** Epoch seconds the user authenticated. */
  readonly authTime?: number;
  /** RFC 8693 section 4.1: the acting party. */
  readonly act?: Readonly<Record<string, unknown>>;
  /** More claims; they cannot replace the registered ones. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

const RESERVED = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "nbf",
  "iat",
  "jti",
  "client_id",
  "scope",
  "cnf",
  "auth_time",
  "act",
]);

/**
 * Signs an RFC 9068 access token; returns it with its `jti` and expiry
 * (epoch seconds). `jti` is random unless given (a server that records it
 * before signing, so the token can be revoked from the start).
 */
export async function issueAccessToken(
  key: SigningKey,
  issuer: string,
  grant: AccessTokenGrant,
  lifetimeSec: number,
  now: Clock,
  jti: string = randomToken(16),
): Promise<{ token: string; jti: string; exp: number }> {
  const iat = Math.floor(now() / 1000);
  const extra: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(grant.claims ?? {})) {
    if (!RESERVED.has(name)) extra[name] = value;
  }
  const claims: Record<string, unknown> = {
    ...extra,
    iss: issuer,
    sub: grant.subject,
    aud: grant.audience.length === 1 ? grant.audience[0] : [...grant.audience],
    exp: iat + lifetimeSec,
    iat,
    jti,
    client_id: grant.clientId,
  };
  const scope = formatScope(grant.scope);
  if (scope !== "") claims.scope = scope;
  if (grant.authTime !== undefined) claims.auth_time = grant.authTime;
  if (grant.jkt !== undefined) claims.cnf = { jkt: grant.jkt };
  if (grant.act !== undefined) claims.act = grant.act;
  const token = await sign(claims, key.privateKey, {
    alg: key.alg,
    kid: key.kid,
    typ: "at+jwt",
  });
  return { token, jti, exp: iat + lifetimeSec };
}

/**
 * The claims of an access token this server issued, or null: its
 * signature under one of `keys`, `typ` `at+jwt`, `iss`, and not expired.
 * A runtime that cannot verify the keys' algorithm throws instead.
 */
export async function verifyOwnAccessToken(
  token: string,
  keys: readonly SigningKey[],
  issuer: string,
  now: Clock,
): Promise<Record<string, unknown> | null> {
  return await prepareOwnAccessTokenVerifier(keys, issuer, now)(token);
}

/** Internal prepared hot-path verifier; one immutable key/import cache per server. */
export function prepareOwnAccessTokenVerifier(
  keys: readonly SigningKey[],
  issuer: string,
  now: Clock,
): (token: string) => Promise<Record<string, unknown> | null> {
  const prepared = createVerifier({
    keys: localJwks(publicJwks(keys)),
    algorithms: [...new Set(keys.map((key) => key.alg))],
    typ: "at+jwt",
    issuer,
    requiredClaims: ["exp", "sub", "client_id", "jti"],
    now,
  });
  return async (token) => {
    if (
      typeof token !== "string" || token.length === 0 || token.length > 16_384
    ) return null;
    try {
      return (await prepared.verify(token)).payload;
    } catch (cause) {
      rethrowRuntimeUnsupported(cause);
      return null;
    }
  };
}

/** A refresh token's family and whole value. */
export function newRefreshToken(family: string): string {
  return `${family}.${randomToken(32)}`;
}

/** The family a refresh token names, or null for a malformed one. */
export function refreshFamily(token: string): string | null {
  const match = /^([A-Za-z0-9_-]{16,64})\.[A-Za-z0-9_-]{43}$/.exec(token);
  return match === null ? null : match[1];
}
