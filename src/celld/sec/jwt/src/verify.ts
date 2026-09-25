// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link verify}: a token's signature, then its claims; and
 * {@link createVerifier}, the same checks prepared once, with the key
 * imported once.
 *
 * @module
 */

import { finite, jsonSnapshot } from "@celld/core/bounds";
import {
  checkClaimStructure,
  decode,
  type JwtClaims,
  type JwtHeader,
} from "./decode.ts";
import { JwtError } from "./errors.ts";
import { type KeySet, liveJwks, localJwks, RemoteJwks } from "./jwks.ts";
import {
  assertAlgorithmsSupported,
  importKey,
  isHmac,
  isJwsAlgorithm,
  isPss,
  type Jwks,
  type JwsAlgorithm,
  type KeyLike,
  keyLikeFits,
  sameAlgorithm,
  verifyBytes,
} from "./keys.ts";
import {
  type JwtLimits,
  type ResolvedLimits,
  resolveLimits,
} from "./limits.ts";

/**
 * What {@link verify} checks the token against: a key (a `CryptoKey`, a
 * JWK or an HMAC secret), a JWKS, or a {@link KeySet} such as `RemoteJwks`.
 */
export type VerifyKey = KeyLike | Jwks | KeySet;

/** The current time: a `Date`, epoch milliseconds, or a clock returning them. */
export type Now = Date | number | (() => number);

/**
 * Processors for critical header parameters (RFC 7515 section 4.1.11),
 * by name. A token whose `crit` names a parameter without a processor is
 * refused; a processor gets the header and the parameter's value and
 * throws to refuse the token (`crit`).
 */
export type CritProcessors = Readonly<
  Record<string, (header: JwtHeader, value: unknown) => void>
>;

/** The largest `clockTolerance`: one day. */
export const MAX_CLOCK_TOLERANCE = 86_400;

/** What {@link verify} requires of a token beyond its signature. */
export interface VerifyOptions {
  /**
   * The accepted `alg` values: a non-empty list of implemented algorithms.
   * There is no default, so the list is always a decision.
   */
  readonly algorithms: readonly JwsAlgorithm[];
  /** `iss` must be this, or one of these. */
  readonly issuer?: string | readonly string[];
  /** `aud` (a string or a list) must name this, or one of these. */
  readonly audience?: string | readonly string[];
  /** `sub` must be this. */
  readonly subject?: string;
  /**
   * The header's `typ` must be one of these, compared without case and
   * with an `application/` prefix ignored (RFC 7515 section 4.1.9).
   */
  readonly typ?: string | readonly string[];
  /** Claims the token must have, beyond those the options above imply. */
  readonly requiredClaims?: readonly string[];
  /** Processors for the critical header parameters the caller understands. */
  readonly crit?: CritProcessors;
  /**
   * Seconds of clock skew allowed for `exp`, `nbf` and `iat`: finite, 0 to
   * {@link MAX_CLOCK_TOLERANCE}; default 0.
   */
  readonly clockTolerance?: number;
  /** The oldest `iat` accepted, in seconds before now (finite); requires `iat`. */
  readonly maxTokenAge?: number;
  /**
   * The furthest `exp` accepted, in seconds after now (finite), so a token
   * cannot be minted to last for years; requires `exp`. A token past it
   * fails with `invalid_claim`.
   */
  readonly maxLifetime?: number;
  /** Default `Date.now`; a non-finite time throws a `RangeError`. */
  readonly now?: Now;
  /** Size caps for the token; see {@link JwtLimits}. */
  readonly limits?: JwtLimits;
}

/**
 * Turns verified claims into the caller's type, throwing when they do not
 * fit (a sieve schema's `parse`, say). A throw that is not a `JwtError`
 * becomes `invalid_claim`.
 */
export type ClaimsRefinement<C> = (claims: JwtClaims) => C;

/** A token whose signature and claims passed. */
export interface VerifiedJwt<C = JwtClaims> {
  readonly header: JwtHeader;
  readonly payload: C;
  readonly alg: JwsAlgorithm;
}

/**
 * Epoch milliseconds for a {@link Now}; throws a `RangeError` unless it is
 * finite and within `Date`'s range.
 */
export function nowMs(now: Now | undefined): number {
  if (now === undefined) return Date.now();
  const value = typeof now === "function"
    ? now()
    : typeof now === "number"
    ? now
    : now instanceof Date
    ? now.getTime()
    : Number.NaN;
  return finite(value, { name: "now", min: -8.64e15, max: 8.64e15 });
}

function list<T>(
  value: T | readonly T[] | undefined,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value as T];
}

function isKeySet(key: VerifyKey): key is KeySet {
  return typeof (key as Partial<KeySet>).resolve === "function";
}

function isJwks(key: VerifyKey): key is Jwks {
  return Array.isArray((key as Partial<Jwks>).keys);
}

const jwksSets = new WeakMap<Jwks, KeySet>();

function jwksSet(jwks: Jwks): KeySet {
  let set = jwksSets.get(jwks);
  if (set === undefined) {
    set = liveJwks(jwks);
    jwksSets.set(jwks, set);
  }
  return set;
}

function mediaType(typ: string): string {
  const lower = typ.toLowerCase();
  return lower.startsWith("application/") ? lower.slice(12) : lower;
}

/** Options checked and copied, ready to verify with. */
interface Policy {
  readonly algorithms: readonly JwsAlgorithm[];
  readonly issuers: readonly string[] | undefined;
  readonly audiences: readonly string[] | undefined;
  readonly subject: string | undefined;
  readonly types: readonly string[] | undefined;
  readonly required: ReadonlySet<string>;
  readonly crit: ReadonlyMap<
    string,
    (header: JwtHeader, value: unknown) => void
  >;
  readonly tolerance: number;
  readonly maxTokenAge: number | undefined;
  readonly maxLifetime: number | undefined;
  readonly now: Now | undefined;
  readonly limits: ResolvedLimits;
  readonly claims: ClaimsRefinement<unknown> | undefined;
}

function strings(
  value: string | readonly string[] | undefined,
  name: string,
): readonly string[] | undefined {
  const items = list(value);
  if (items === undefined) return undefined;
  if (!items.every((item) => typeof item === "string")) {
    throw new TypeError(`${name} must be a string or a list of strings`);
  }
  return Object.freeze([...items]);
}

/** Checks and copies `options`; throws a `TypeError` or `RangeError`. */
function resolvePolicy(
  options: VerifyOptions & { readonly claims?: ClaimsRefinement<unknown> },
): Policy {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("verify needs options with algorithms");
  }
  const algorithms = options.algorithms;
  if (!Array.isArray(algorithms) || algorithms.length === 0) {
    throw new TypeError("algorithms must be a non-empty list");
  }
  for (const alg of algorithms) {
    if (!isJwsAlgorithm(alg)) {
      throw new TypeError(
        `algorithms: ${JSON.stringify(alg)} is not supported`,
      );
    }
  }
  const subject = options.subject;
  if (subject !== undefined && typeof subject !== "string") {
    throw new TypeError("subject must be a string");
  }
  const requiredClaims = strings(options.requiredClaims, "requiredClaims");
  const required = new Set(requiredClaims);
  const issuers = strings(options.issuer, "issuer");
  const audiences = strings(options.audience, "audience");
  if (issuers !== undefined) required.add("iss");
  if (audiences !== undefined) required.add("aud");
  if (subject !== undefined) required.add("sub");
  const maxTokenAge = options.maxTokenAge === undefined
    ? undefined
    : finite(options.maxTokenAge, { name: "maxTokenAge", min: 0 });
  if (maxTokenAge !== undefined) required.add("iat");
  const maxLifetime = options.maxLifetime === undefined
    ? undefined
    : finite(options.maxLifetime, { name: "maxLifetime", min: 0 });
  if (maxLifetime !== undefined) required.add("exp");
  const crit = new Map<string, (header: JwtHeader, value: unknown) => void>();
  if (options.crit !== undefined) {
    if (
      typeof options.crit !== "object" || options.crit === null ||
      Array.isArray(options.crit)
    ) {
      throw new TypeError("crit must map parameter names to processors");
    }
    for (const [name, processor] of Object.entries(options.crit)) {
      if (typeof processor !== "function") {
        throw new TypeError(`crit.${name} must be a function`);
      }
      crit.set(name, processor);
    }
  }
  if (options.claims !== undefined && typeof options.claims !== "function") {
    throw new TypeError("claims must be a function");
  }
  const now = options.now instanceof Date ? options.now.getTime() : options.now;
  // A fixed time is checked now; a clock, whenever it is read.
  if (now !== undefined && typeof now !== "function") nowMs(now);
  return Object.freeze({
    algorithms: Object.freeze([...algorithms]),
    issuers,
    audiences,
    subject,
    types: strings(options.typ, "typ"),
    required,
    crit,
    tolerance: finite(options.clockTolerance ?? 0, {
      name: "clockTolerance",
      min: 0,
      max: MAX_CLOCK_TOLERANCE,
    }),
    maxTokenAge,
    maxLifetime,
    now,
    limits: resolveLimits(options.limits),
    claims: options.claims,
  });
}

function numericDate(
  claims: JwtClaims,
  name: "exp" | "nbf" | "iat",
): number | undefined {
  const value = claims[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new JwtError("invalid_claim", `${name} must be a number`);
  }
  return value;
}

function checkClaims(claims: JwtClaims, policy: Policy): void {
  checkClaimStructure(claims);
  for (const name of policy.required) {
    // Own members only: `constructor` and the like are on every object.
    if (!Object.hasOwn(claims, name) || claims[name] === undefined) {
      throw new JwtError("missing_claim", `the token has no ${name}`);
    }
  }
  for (const name of ["iss", "sub", "jti"] as const) {
    if (claims[name] !== undefined && typeof claims[name] !== "string") {
      throw new JwtError("invalid_claim", `${name} must be a string`);
    }
  }
  const aud = claims.aud;
  const audiences = aud === undefined ? [] : Array.isArray(aud) ? aud : [aud];
  if (!audiences.every((item) => typeof item === "string")) {
    throw new JwtError("invalid_claim", "aud must be a string or strings");
  }
  const clock = nowMs(policy.now) / 1000;
  const tolerance = policy.tolerance;
  const exp = numericDate(claims, "exp");
  const nbf = numericDate(claims, "nbf");
  const iat = numericDate(claims, "iat");
  if (exp !== undefined && clock >= exp + tolerance) {
    throw new JwtError("expired", "the token has expired");
  }
  if (nbf !== undefined && clock < nbf - tolerance) {
    throw new JwtError("not_yet_valid", "the token is not valid yet");
  }
  if (iat !== undefined && iat > clock + tolerance) {
    throw new JwtError("not_yet_valid", "the token was issued in the future");
  }
  if (
    policy.maxTokenAge !== undefined && iat !== undefined &&
    clock - iat > policy.maxTokenAge + tolerance
  ) {
    throw new JwtError("too_old", "the token was issued too long ago");
  }
  if (
    policy.maxLifetime !== undefined && exp !== undefined &&
    exp - clock > policy.maxLifetime + tolerance
  ) {
    throw new JwtError(
      "invalid_claim",
      "the token's exp is further away than maxLifetime allows",
    );
  }
  if (
    policy.issuers !== undefined &&
    !policy.issuers.includes(claims.iss as string)
  ) {
    throw new JwtError(
      "issuer",
      `unexpected issuer ${JSON.stringify(claims.iss)}`,
    );
  }
  const expected = policy.audiences;
  if (
    expected !== undefined && !audiences.some((item) => expected.includes(item))
  ) {
    throw new JwtError("audience", "the token is not for this audience");
  }
  if (policy.subject !== undefined && claims.sub !== policy.subject) {
    throw new JwtError(
      "subject",
      `unexpected subject ${JSON.stringify(claims.sub)}`,
    );
  }
}

type Resolver = (header: JwtHeader, alg: JwsAlgorithm) => Promise<KeyLike>;

async function run(
  token: string,
  resolveKey: Resolver,
  policy: Policy,
): Promise<VerifiedJwt<unknown>> {
  const jwt = decode(token, { limits: policy.limits });
  const alg = jwt.header.alg;
  if (!isJwsAlgorithm(alg)) {
    throw new JwtError(
      "unsupported_alg",
      `unsupported alg ${JSON.stringify(alg)}`,
    );
  }
  if (!policy.algorithms.includes(alg)) {
    throw new JwtError("alg_not_allowed", `alg ${alg} is not allowed`);
  }
  for (const name of jwt.header.crit ?? []) {
    const processor = policy.crit.get(name);
    if (processor === undefined) {
      throw new JwtError(
        "crit",
        `critical header ${JSON.stringify(name)} is not understood`,
      );
    }
    try {
      processor(jwt.header, jwt.header[name]);
    } catch (cause) {
      throw new JwtError(
        "crit",
        `critical header ${JSON.stringify(name)} was refused`,
        { cause },
      );
    }
  }
  if (policy.types !== undefined) {
    const typ = jwt.header.typ;
    if (
      typeof typ !== "string" ||
      !policy.types.some((item) => mediaType(item) === mediaType(typ))
    ) {
      throw new JwtError("typ", `unexpected typ ${JSON.stringify(typ)}`);
    }
  }
  const key = await resolveKey(jwt.header, alg);
  if (!(await verifyBytes(alg, key, jwt.signingInput, jwt.signature))) {
    throw new JwtError("bad_signature", "the signature does not verify");
  }
  checkClaims(jwt.payload, policy);
  if (policy.claims === undefined) {
    return { header: jwt.header, payload: jwt.payload, alg };
  }
  let payload: unknown;
  try {
    payload = policy.claims(jwt.payload);
  } catch (cause) {
    if (cause instanceof JwtError) throw cause;
    throw new JwtError("invalid_claim", "the claims were refused", { cause });
  }
  return { header: jwt.header, payload, alg };
}

/**
 * Throws `ambiguous_key` for an RSA JWK without `alg` when `algorithms`
 * allows both RS* and PS*: one key is never used under both schemes.
 */
function checkRsaScheme(key: KeyLike, algorithms: readonly JwsAlgorithm[]) {
  if (key instanceof CryptoKey || key instanceof Uint8Array) return;
  if (key.kty !== "RSA" || key.alg !== undefined) return;
  const schemes = new Set(
    algorithms.filter((alg) => alg.startsWith("RS") || isPss(alg)).map(isPss),
  );
  if (schemes.size > 1) {
    throw new JwtError(
      "ambiguous_key",
      "an RSA JWK without alg cannot serve both RS* and PS*; set its alg or narrow algorithms",
    );
  }
}

/**
 * Throws a `TypeError` for a `RemoteJwks` under an HMAC algorithm: a
 * fetched set is public, so it can hold no secret to verify with.
 */
function checkPublicSet(key: VerifyKey, algorithms: readonly JwsAlgorithm[]) {
  if (key instanceof RemoteJwks && algorithms.some(isHmac)) {
    throw new TypeError(
      "a RemoteJwks holds public keys only; remove HS* from algorithms",
    );
  }
}

function resolverFor(key: VerifyKey, policy?: Policy): Resolver {
  if (isKeySet(key)) return (header, alg) => key.resolve(header, alg);
  if (isJwks(key)) return (header, alg) => jwksSet(key).resolve(header, alg);
  if (policy !== undefined) checkRsaScheme(key, policy.algorithms);
  return () => Promise.resolve(key);
}

/**
 * Verifies a compact JWS and its claims, in this order: it decodes within
 * the size limits (see `decode`); `alg` is implemented (never `none`) and
 * in `algorithms`; every `crit` name has a processor in `options.crit`,
 * which accepts it; `typ` is expected; the key fits `alg` (an RSA key is
 * never used as an HMAC secret, or the other way round) and the signature
 * verifies; then the claims, and last `options.claims`, when given, which
 * refines them to the caller's type. Throws a {@link JwtError} saying
 * which check failed, and a `TypeError` or `RangeError` for bad options
 * (an empty `algorithms`, a `NaN` tolerance, a `RemoteJwks` with HS* in
 * `algorithms`). `exp`, `nbf` and `iat` are checked whenever present, and
 * `iat` may never be in the future; `requiredClaims` makes them mandatory.
 * Unlike {@link createVerifier}, `verify` does not require `exp` by
 * default.
 *
 * This is the low-level form: a key given as a JWK or secret is imported
 * on every call. {@link createVerifier} checks the options and imports the
 * key once.
 */
export function verify(
  token: string,
  key: VerifyKey,
  options: VerifyOptions & { readonly claims?: undefined },
): Promise<VerifiedJwt>;
export function verify<C>(
  token: string,
  key: VerifyKey,
  options: VerifyOptions & { readonly claims: ClaimsRefinement<C> },
): Promise<VerifiedJwt<C>>;
export async function verify(
  token: string,
  key: VerifyKey,
  options: VerifyOptions & { readonly claims?: ClaimsRefinement<unknown> },
): Promise<VerifiedJwt<unknown>> {
  const policy = resolvePolicy(options);
  checkPublicSet(key, policy.algorithms);
  return await run(token, resolverFor(key, policy), policy);
}

/** Options for {@link createVerifier}: {@link VerifyOptions} and the keys. */
export interface VerifierOptions extends VerifyOptions {
  /**
   * The keys. A single key is bound to exactly one of `algorithms` (see
   * {@link createVerifier}); a JWKS is copied; a `KeySet` is used as it is.
   */
  readonly keys: VerifyKey;
  /**
   * Whether a token must have `exp`. Default true, unless `maxTokenAge` is
   * given (which bounds the token's life through `iat` instead): a token
   * with neither never expires. `false` is the explicit opt-out.
   */
  readonly requireExpiry?: boolean;
}

/** A prepared verifier; see {@link createVerifier}. */
export interface JwtVerifier<C = JwtClaims> {
  /** Checks runtime support and imports configured local keys once before traffic. */
  ready(): Promise<void>;
  /** The accepted algorithms, as given. */
  readonly algorithms: readonly JwsAlgorithm[];
  /** Verifies `token` as {@link verify} would with the prepared options. */
  verify(token: string): Promise<VerifiedJwt<C>>;
}

/**
 * Binds a single key to the one algorithm of `algorithms` it fits, and
 * returns a resolver that imports it once.
 */
function prepareKey(
  key: KeyLike,
  algorithms: readonly JwsAlgorithm[],
): Resolver {
  const fits: JwsAlgorithm[] = [];
  for (const alg of algorithms) {
    if (keyLikeFits(key, alg) && !fits.some((a) => sameAlgorithm(a, alg))) {
      fits.push(alg);
    }
  }
  if (fits.length === 0) {
    throw new JwtError(
      "key_mismatch",
      `the key fits none of ${algorithms.join(", ")}`,
    );
  }
  if (fits.length > 1) {
    throw new JwtError(
      "ambiguous_key",
      `the key fits ${
        fits.join(" and ")
      }; give the JWK an alg or narrow algorithms`,
    );
  }
  const bound = fits[0];
  let imported: Promise<CryptoKey> | undefined;
  return async (_header, alg) => {
    if (!sameAlgorithm(alg, bound)) {
      throw new JwtError("key_mismatch", `the key is bound to ${bound}`);
    }
    if (imported === undefined) {
      const importing = importKey(key, bound, "verify");
      imported = importing;
      importing.catch(() => {
        if (imported === importing) imported = undefined;
      });
    }
    return await imported;
  };
}

function snapshotKey(key: VerifyKey): VerifyKey {
  if (key instanceof CryptoKey) return key;
  if (key instanceof Uint8Array) return Uint8Array.from(key);
  if (isKeySet(key)) return key;
  return jsonSnapshot(key);
}

/**
 * A prepared {@link JwtVerifier}: the options are checked and copied now
 * (a `TypeError` or `RangeError` for bad ones, such as an empty
 * `algorithms` or a `NaN` tolerance), and keys are imported once and
 * reused.
 *
 * - A single key (`CryptoKey`, JWK or HMAC secret) is bound to the one
 *   algorithm in `algorithms` that it fits, and refused now when it fits
 *   none (`key_mismatch`) or several (`ambiguous_key`: an HMAC secret with
 *   both HS256 and HS512 allowed, say). A token under any other algorithm
 *   fails with `key_mismatch`.
 * - A JWKS is copied and served like `localJwks`, which caches imports.
 * - A `KeySet` (such as `RemoteJwks`) is used as it is.
 *
 * A token must have `exp` unless `maxTokenAge` is given or `requireExpiry`
 * is `false`, so a token with no lifetime is not accepted by default.
 * A `RemoteJwks` with HS* in `algorithms` is a `TypeError`.
 *
 * `claims`, when given, refines the verified claims to the caller's type.
 */
export function createVerifier(
  options: VerifierOptions & { readonly claims?: undefined },
): JwtVerifier;
export function createVerifier<C>(
  options: VerifierOptions & { readonly claims: ClaimsRefinement<C> },
): JwtVerifier<C>;
export function createVerifier(
  options: VerifierOptions & { readonly claims?: ClaimsRefinement<unknown> },
): JwtVerifier<unknown> {
  const requireExpiry = options.requireExpiry ??
    options.maxTokenAge === undefined;
  if (typeof requireExpiry !== "boolean") {
    throw new TypeError("requireExpiry must be a boolean");
  }
  const resolved = resolvePolicy(options);
  const policy: Policy = requireExpiry
    ? Object.freeze({
      ...resolved,
      required: new Set([...resolved.required, "exp"]),
    })
    : resolved;
  checkPublicSet(options.keys, policy.algorithms);
  const keys = snapshotKey(options.keys);
  const resolveKey = isKeySet(keys)
    ? resolverFor(keys)
    : isJwks(keys)
    ? resolverFor(localJwks(keys))
    : prepareKey(keys as KeyLike, policy.algorithms);
  return Object.freeze({
    algorithms: policy.algorithms,
    ready: async () => {
      await assertAlgorithmsSupported(policy.algorithms);
      if (!isKeySet(keys) && !isJwks(keys)) {
        await resolveKey(
          { alg: policy.algorithms[0] },
          policy.algorithms.find((alg) => keyLikeFits(keys as KeyLike, alg))!,
        );
      } else if (isJwks(keys)) {
        for (const jwk of keys.keys) {
          for (const alg of policy.algorithms) {
            if (keyLikeFits(jwk, alg)) {
              await resolveKey({
                alg,
                ...(jwk.kid === undefined ? {} : { kid: jwk.kid }),
              }, alg);
            }
          }
        }
      } else if (keys instanceof RemoteJwks) await keys.refresh();
    },
    verify: (token: string) => run(token, resolveKey, policy),
  });
}
