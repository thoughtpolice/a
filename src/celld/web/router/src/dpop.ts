// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link dpop}: RFC 9449 DPoP-bound access tokens. The scheme verifies the
 * proof itself, every check of RFC 9449 sections 4.3 and 7.1, and hands
 * only the access token to a plain {@link TokenVerifier}; then it checks
 * that the proof's key is the one the token is bound to (`cnf.jkt`).
 *
 * @module
 */

import { safeInt } from "@celld/core/bounds";
import {
  assertAlgorithmsSupported,
  decode,
  type Jwk,
  jwkThumbprint,
  type JwsAlgorithm,
  JwtError,
  toBase64Url,
  validatePublicJwk,
  verify as verifyJws,
} from "@celld/sec/jwt";
import {
  AuthError,
  type AuthScheme,
  type Challenge,
  type ChallengeOptions,
  challengeParams,
  parseAuthorization,
  type PrincipalInput,
  setAuthErrorHeader,
  TOKEN68,
} from "./auth.ts";
import { challengeOptions, run, type TokenVerifier } from "./bearer.ts";
import { type Context, requestOf } from "./context.ts";
import { HttpError, RouterError } from "./errors.ts";
import { cleartextRefusal } from "./public_url.ts";
import {
  clockValue,
  exactBoolean,
  HTTP_TOKEN,
  optionsRecord,
  optionText,
  optionType,
} from "./validation.ts";

/**
 * The asymmetric algorithms a DPoP proof may be signed with. A symmetric
 * key cannot prove possession to a server that does not hold it, and
 * `none` is never a signature.
 */
export const DPOP_ALGORITHMS = Object.freeze(
  [
    "ES256",
    "ES384",
    "ES512",
    "PS256",
    "PS384",
    "PS512",
    "RS256",
    "RS384",
    "RS512",
    "EdDSA",
    "Ed25519",
  ] as const satisfies readonly JwsAlgorithm[],
);

/** A DPoP proof algorithm; see {@link DPOP_ALGORITHMS}. */
export type DpopAlgorithm = typeof DPOP_ALGORITHMS[number];

/**
 * Remembers what has been seen, so each proof's `jti` is accepted once.
 * `claim` must be atomic: of concurrent calls for one key, exactly one
 * returns true.
 *
 * The contract on time, which every store must keep exactly: `expiresAt`
 * is in epoch milliseconds, and an entry is **live while `now <=
 * expiresAt`**, the last millisecond included. A claim of a key whose
 * entry is live returns false; the entry may be forgotten (and the key
 * claimed again) only once `now > expiresAt`. The scheme passes the last
 * millisecond at which it would still accept the proof, so a store that
 * forgot an entry at `expiresAt` itself would let the proof be replayed
 * once, at that millisecond. In SQL: live is `expires_at >= ?now`,
 * expired is `expires_at < ?now`.
 *
 * This is the shape of `@celld/sec/oauth/dpop`'s `ReplayStore`, so its stores
 * (a Durable Object's, say) fit here.
 */
export interface ReplayStore {
  /**
   * True when no live entry holds `key` (and one now does, until
   * `expiresAt`); false while one does.
   */
  claim(key: string, expiresAt: number): Promise<boolean>;
}

/**
 * Server-provided nonces (RFC 9449 section 8): every proof must carry one
 * `check` accepts, or the answer is `use_dpop_nonce` with a fresh one from
 * `issue` in `DPoP-Nonce`, which every answer to a DPoP request carries.
 * A nonce limits proof pre-generation and can bound a captured proof's useful
 * lifetime, but it does not make the proof single-use. Safe operation also
 * needs a shared atomic {@link ReplayStore}.
 */
export interface DpopNonceStrategy {
  /** The nonce to send in `DPoP-Nonce` now. */
  issue(): Promise<string>;
  /** Whether a proof's nonce is still accepted. */
  check(nonce: string): Promise<boolean>;
}

interface DpopBaseOptions extends ChallengeOptions {
  /**
   * Checks the access token and returns the principal, with the `cnf.jkt`
   * the token is bound to. It never sees the proof: the scheme has already
   * verified it, and checks the binding after `verify` returns. A plain
   * access-token check such as `jwtVerifier` is the right input.
   */
  readonly verify: TokenVerifier;
  /**
   * Accepted proof algorithms, all asymmetric; default ES256, RS256 and
   * PS256. Also the challenge's `algs`.
   */
  readonly algs?: readonly DpopAlgorithm[];
  /**
   * The URL the client used, which the proof's `htu` names and the
   * transport rule is applied to, for this scheme only. Default the
   * router's `c.publicUrl` (see `RouterOptions.publicUrl`), which is where
   * a proxy in front belongs; this override is for a scheme that must
   * answer for another URL than the rest of the router.
   */
  readonly publicUrl?: (c: Context) => URL;
  /** How old a proof's `iat` may be, in seconds (1 to 3600); default 60. */
  readonly maxAgeSec?: number;
  /** Clock skew allowed on `iat`, in seconds (0 to 300); default 5. */
  readonly clockToleranceSec?: number;
  /** Epoch milliseconds; default `Date.now`. */
  readonly now?: () => number;
  /** Default `dpop`. */
  readonly name?: string;
}

/**
 * Options for {@link dpop}. Safe operation requires `replay`, an atomic store
 * shared by every server instance; `nonce` is an optional additional defense.
 * A caller that enforces single use elsewhere may instead opt into the
 * explicitly replayable `unsafeNoReplay: true` branch, optionally with a
 * nonce. The store's `claim` and the strategy's `issue`/`check` are captured
 * when the scheme is made. `realm` and `resourceMetadata` (RFC 9728) go on
 * every challenge.
 */
export type DpopOptions =
  & DpopBaseOptions
  & (
    | {
      readonly replay: ReplayStore;
      readonly nonce?: DpopNonceStrategy;
      readonly unsafeNoReplay?: never;
    }
    | {
      readonly unsafeNoReplay: true;
      readonly replay?: never;
      readonly nonce?: DpopNonceStrategy;
    }
  );

const DEFAULT_ALGS: readonly DpopAlgorithm[] = ["ES256", "RS256", "PS256"];
const PROOF = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_PROOF_LENGTH = 8192;
const MAX_JTI_LENGTH = 256;
/** JWK members that only a private or symmetric key has. */
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return toBase64Url(new Uint8Array(digest));
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * The comparable form of a URL for `htu` (RFC 9449 section 4.3, with RFC
 * 3986 syntax- and scheme-based normalization): lowercase scheme and host,
 * no default port or user information, unreserved escapes decoded and the
 * rest in upper case, no query or fragment. Null for text that is not a
 * URL.
 */
function normalizeHtu(url: string | URL): string | null {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) || parsed.username ||
    parsed.password
  ) return null;
  const path = (parsed.pathname === "" ? "/" : parsed.pathname).replace(
    /%([0-9A-Fa-f]{2})/g,
    (_match, hex: string) => {
      const char = String.fromCharCode(parseInt(hex, 16));
      return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
    },
  );
  return `${parsed.protocol}//${parsed.host}${path}`;
}

function proofError(message: string): AuthError {
  return new AuthError("invalid_dpop_proof", message);
}

/** What a verified proof told the scheme. */
interface CheckedProof {
  readonly jkt: string;
  readonly jti: string;
  readonly iat: number;
}

function record(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

/**
 * RFC 9449 DPoP-bound tokens: `Authorization: DPoP <token>` plus one
 * `DPoP` proof header, checked in this order:
 *
 * 0. the request's public URL (or this scheme's `publicUrl`) is https or
 *    a loopback IP literal, unless the router allows cleartext
 *    credentials for development (else 403 `insecure_transport`);
 * 1. the token is token68 (else 400 `invalid_request`); there is exactly
 *    one proof, a compact JWS of at most 8 KiB;
 * 2. its header has `typ` `dpop+jwt`, an accepted asymmetric `alg`, and a
 *    `jwk` that is a public key (no private members, not `oct`), and the
 *    signature verifies under that `jwk`;
 * 3. `jti` (a string of at most 256 characters), `htm` (the request
 *    method), `htu` (the request's public URL, see `publicUrl`) and `iat`
 *    (at most `maxAgeSec` old and not in the future, within the
 *    tolerance) are present and right, and `ath` is the access token's
 *    SHA-256;
 * 4. with `nonce`, the proof's nonce is accepted (else `use_dpop_nonce`
 *    with a fresh `DPoP-Nonce`);
 * 5. `verify` accepts the token (else its error, or `invalid_token`), and
 *    the token is bound (`cnf.jkt`, else `invalid_token`) to the proof's
 *    key thumbprint;
 * 6. with `replay`, the proof's `jti` has not been used before with this
 *    key. This is the last step, so a proof refused for another reason
 *    does not use up its `jti`.
 *
 * Proof failures are 401 `invalid_dpop_proof`; no DPoP credential at all
 * is null (the 401 carries `DPoP algs="ES256 RS256 PS256"`). A proof
 * algorithm listed in `algs` that the runtime cannot verify is a
 * misconfiguration: the first such proof is thrown, a 500 for
 * `onError`, and every later one is 401 `invalid_dpop_proof`, so clients
 * cannot flood `onError`. List only algorithms the runtime has. Options
 * are copied when the scheme is made.
 */
export function dpop(options: DpopOptions): AuthScheme {
  optionsRecord(options, [
    "verify",
    "algs",
    "publicUrl",
    "maxAgeSec",
    "clockToleranceSec",
    "now",
    "name",
    "replay",
    "nonce",
    "unsafeNoReplay",
    "realm",
    "resourceMetadata",
  ], "dpop options");
  optionText(options.name, "dpop name", HTTP_TOKEN);
  if (!isObject(options) || !isFunction(options.verify)) {
    throw new RouterError("dpop needs a verify function");
  }
  const replay = options.replay;
  const nonce = options.nonce;
  const unsafeNoReplay = options.unsafeNoReplay;
  const hasReplay = isObject(replay) && isFunction(replay.claim);
  const hasNonce = isObject(nonce) && isFunction(nonce.issue) &&
    isFunction(nonce.check);
  if (unsafeNoReplay !== undefined && unsafeNoReplay !== true) {
    throw new RouterError("dpop unsafeNoReplay must be literal true");
  }
  if (replay !== undefined && !hasReplay) {
    throw new RouterError("dpop replay must be an atomic replay store");
  }
  if (nonce !== undefined && !hasNonce) {
    throw new RouterError("dpop nonce must be a nonce strategy");
  }
  if (replay !== undefined && unsafeNoReplay !== undefined) {
    throw new RouterError("dpop takes replay or unsafeNoReplay, not both");
  }
  if (!hasReplay && unsafeNoReplay !== true) {
    throw new RouterError(
      "dpop needs a replay store or unsafeNoReplay: true",
    );
  }
  // Captured now: reassigning `claim`, `issue` or `check` on the caller's
  // object afterwards (turning replay protection off, say) changes nothing.
  const claim = hasReplay ? replay!.claim.bind(replay) : undefined;
  const issueNonce = hasNonce ? nonce!.issue.bind(nonce) : undefined;
  const checkNonce = hasNonce ? nonce!.check.bind(nonce) : undefined;
  const verify = options.verify;
  const algs = options.algs ?? DEFAULT_ALGS;
  if (!Array.isArray(algs) || algs.length === 0) {
    throw new RouterError("dpop algs must list at least one algorithm");
  }
  for (const alg of algs) {
    if (!(DPOP_ALGORITHMS as readonly unknown[]).includes(alg)) {
      throw new RouterError(
        `dpop algs: ${JSON.stringify(alg)} is not an asymmetric JWS algorithm`,
      );
    }
  }
  const accepted: ReadonlySet<string> = new Set(algs);
  const maxAge = safeInt(options.maxAgeSec ?? 60, {
    name: "dpop maxAgeSec",
    min: 1,
    max: 3600,
  });
  const tolerance = safeInt(options.clockToleranceSec ?? 5, {
    name: "dpop clockToleranceSec",
    min: 0,
    max: 300,
  });
  const clock = options.now ?? Date.now;
  const now = () => clockValue(clock(), "DPoP clock");
  const publicUrl = options.publicUrl;
  if (
    !isFunction(clock) || (publicUrl !== undefined && !isFunction(publicUrl))
  ) {
    throw new RouterError("dpop now and publicUrl must be functions");
  }
  const name = options.name ?? "dpop";
  const challenge = challengeOptions(options);
  const leading: (readonly [string, string])[] = [["algs", algs.join(" ")]];

  /**
   * The last epoch millisecond at which a proof issued at `iat` (seconds)
   * is accepted; also the `expiresAt` of its replay record.
   */
  const lastAcceptedMs = (iat: number) => (iat + maxAge + tolerance) * 1000;

  /** The fresh nonce every answer to a DPoP request carries, if any. */
  const freshNonce = async () => {
    const value = await issueNonce!();
    if (typeof value !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value)) {
      throw new TypeError(
        "DPoP nonce issuance must return 1–512 visible ASCII characters",
      );
    }
    return value;
  };
  const nonceHeaders = async (): Promise<Record<string, string>> =>
    hasNonce ? { "dpop-nonce": await freshNonce() } : {};

  const refuse = async (error: AuthError): Promise<AuthError> => {
    if (!hasNonce || error.headers.has("dpop-nonce")) return error;
    setAuthErrorHeader(error, "dpop-nonce", await freshNonce());
    return error;
  };

  /** Steps 1 to 4 of {@link dpop}; an AuthError for the first failure. */
  const checkProof = async (
    c: Context,
    proof: string,
    token: string,
    target: URL,
  ): Promise<CheckedProof | AuthError> => {
    if (proof.length > MAX_PROOF_LENGTH) {
      return proofError("the DPoP proof is too long");
    }
    if (!PROOF.test(proof)) return proofError("the DPoP proof is malformed");
    let header: Record<string, unknown>;
    try {
      header = record(decode(proof).header);
    } catch {
      return proofError("the DPoP proof is not a JWT");
    }
    if (header.typ !== "dpop+jwt") {
      return proofError("the DPoP proof's typ is not dpop+jwt");
    }
    const alg = header.alg;
    if (typeof alg !== "string" || !accepted.has(alg)) {
      return proofError(
        `the DPoP proof's alg ${String(alg)} is not accepted`,
      );
    }
    const jwk = header.jwk;
    if (!isObject(jwk)) return proofError("the DPoP proof has no jwk");
    try {
      validatePublicJwk(jwk as Jwk);
    } catch {
      return proofError("the DPoP proof's jwk is not a public key");
    }
    if (
      jwk.kty === "oct" || PRIVATE_MEMBERS.some((member) => member in jwk)
    ) {
      return proofError("the DPoP proof's jwk is not a public key");
    }
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await verifyJws(proof, jwk as Jwk, {
        algorithms: [alg as DpopAlgorithm],
        typ: "dpop+jwt",
        clockTolerance: tolerance,
        now,
      }));
    } catch (error) {
      if (!(error instanceof JwtError)) throw error;
      if (error.code === "runtime_unsupported") {
        // A server capability failure is never evidence of an invalid proof.
        // ready() detects this before listen; remain fail-closed if omitted.
        throw new HttpError(503, "DPoP verification is unavailable", {
          cause: error,
        });
      }
      switch (error.code) {
        case "invalid_claim":
          return proofError("the DPoP proof's claims are malformed");
        case "expired":
        case "not_yet_valid":
          // A proof has no nbf, so this is a future iat.
          return proofError("the DPoP proof is from the future");
        case "bad_signature":
        case "key_mismatch":
          return proofError("the DPoP proof's signature does not verify");
        default:
          return proofError("the DPoP proof does not verify");
      }
    }
    const { jti, htm, htu, iat } = claims;
    if (jti === undefined || jti === "") {
      return proofError("the DPoP proof has no jti");
    }
    if (typeof jti !== "string" || jti.length > MAX_JTI_LENGTH) {
      return proofError("the DPoP proof's jti is not valid");
    }
    if (htm !== c.method) {
      return proofError(`htm is not ${c.method}`);
    }
    const expected = normalizeHtu(target);
    if (typeof htu !== "string" || normalizeHtu(htu) !== expected) {
      return proofError("htu does not match the request URL");
    }
    if (typeof iat !== "number" || !Number.isFinite(iat)) {
      return proofError("the DPoP proof has no iat");
    }
    // In milliseconds, the unit of the replay store's `expiresAt`: the
    // proof is accepted up to and including `lastAcceptedMs`, and the
    // claim below holds the jti at least that long.
    const clock = now();
    if (clock > lastAcceptedMs(iat)) {
      return proofError("the DPoP proof is too old");
    }
    if (iat * 1000 > clock + tolerance * 1000) {
      return proofError("the DPoP proof is from the future");
    }
    if (hasNonce) {
      if (typeof claims.nonce !== "string") {
        return new AuthError("use_dpop_nonce", "the DPoP proof needs a nonce");
      }
      if (!exactBoolean(await checkNonce!(claims.nonce), "DPoP nonce check")) {
        return new AuthError(
          "use_dpop_nonce",
          "the DPoP proof's nonce is stale",
        );
      }
    }
    if (typeof claims.ath !== "string") {
      return proofError("the DPoP proof has no ath");
    }
    if (claims.ath !== await sha256(token)) {
      return proofError("ath does not match the access token");
    }
    let jkt: string;
    try {
      jkt = await jwkThumbprint(jwk as Jwk);
    } catch {
      return proofError("the DPoP proof's jwk has no thumbprint");
    }
    return { jkt, jti, iat };
  };

  const authenticate = async (c: Context) => {
    const header = parseAuthorization(
      requestOf(c).headers.get("authorization"),
    );
    if (header === null || header.scheme.toLowerCase() !== "dpop") {
      return null;
    }
    const token = header.credentials;
    const target = publicUrl === undefined ? c.publicUrl : publicUrl(c);
    if (!(target instanceof URL)) {
      throw new TypeError("dpop publicUrl must return a URL");
    }
    const insecure = cleartextRefusal(c, "DPoP tokens", target);
    if (insecure !== null) return insecure;
    if (!TOKEN68.test(token)) {
      return new AuthError("invalid_request", "the DPoP token is malformed");
    }
    const sent = requestOf(c).headers.get("dpop");
    if (sent === null) {
      return await refuse(proofError("the request has no DPoP proof"));
    }
    const proof = await checkProof(c, sent.trim(), token, target);
    if (proof instanceof AuthError) return await refuse(proof);

    const verdict = await run(verify, {
      token,
      scheme: "DPoP",
      method: c.method,
      url: c.url.href,
      get request() {
        return c.req;
      },
      context: c,
    });
    if (verdict === null) {
      return await refuse(
        new AuthError("invalid_token", "the access token is not valid"),
      );
    }
    if (verdict instanceof AuthError) return await refuse(verdict);
    const bound = verdict.cnf?.jkt;
    if (bound === undefined) {
      return await refuse(
        new AuthError("invalid_token", "the access token is not DPoP-bound"),
      );
    }
    if (bound !== proof.jkt) {
      return await refuse(
        proofError(
          "the DPoP proof's key is not the one the token is bound to",
        ),
      );
    }
    if (hasReplay) {
      const key = `dpop:${await sha256(`${proof.jkt}\n${proof.jti}`)}`;
      // Live through the last millisecond the age check accepts (see
      // ReplayStore), plus one: a store that still takes an entry as gone
      // at `expiresAt` itself holds it through that millisecond too.
      const until = Math.max(lastAcceptedMs(proof.iat) + 1, now() + 1000);
      if (!exactBoolean(await claim!(key, until), "DPoP replay claim")) {
        return await refuse(proofError("the DPoP proof has been used before"));
      }
    }
    const headers = new Headers(verdict.headers);
    for (const [header, value] of Object.entries(await nonceHeaders())) {
      headers.set(header, value);
    }
    const principal: PrincipalInput = {
      ...verdict,
      tokenType: verdict.tokenType ?? "DPoP",
      headers,
    };
    return principal;
  };

  return Object.freeze({
    name,
    ambient: false,
    async ready() {
      await assertAlgorithmsSupported([...accepted] as DpopAlgorithm[]);
      await verify.ready?.();
    },
    authenticate,
    challenge(error: AuthError | undefined): Challenge {
      return {
        scheme: "DPoP",
        params: challengeParams(challenge, error, leading),
      };
    },
    openapi: Object.freeze({ type: "http", scheme: "dpop" }),
  });
}

/** Options for {@link unsafeMemoryReplayStore}. */
export interface MemoryReplayStoreOptions {
  /** Default 100 000. */
  readonly maxEntries?: number;
  /** Epoch milliseconds; default `Date.now`. */
  readonly now?: () => number;
}

/**
 * A {@link ReplayStore} in this isolate's memory, for tests and
 * development. **Unsafe in production:** Workers run many isolates, each
 * with its own memory, and an isolate can be evicted at any time, so a
 * proof refused by one isolate is accepted by another. Use a store shared
 * by every isolate, such as a Durable Object. It holds at most
 * `maxEntries` live entries and refuses new claims when full (rather than
 * forgetting a live one, which would let that proof be replayed).
 */
export function unsafeMemoryReplayStore(
  options: MemoryReplayStoreOptions = {},
): ReplayStore {
  optionsRecord(options, ["maxEntries", "now"], "replay store options");
  optionType(options.now, "function", "replay store now");
  const max = safeInt(options.maxEntries ?? 100_000, {
    name: "maxEntries",
    min: 1,
    max: 10_000_000,
  });
  const now = options.now ?? Date.now;
  const seen = new Map<string, number>();
  return Object.freeze({
    claim(key: string, expiresAt: number): Promise<boolean> {
      const clock = clockValue(now(), "replay store clock");
      if (
        typeof key !== "string" || key.length === 0 || key.length > 4096 ||
        !Number.isFinite(expiresAt) || expiresAt < clock
      ) throw new TypeError("invalid replay claim");
      const known = seen.get(key);
      // Live while clock <= expiresAt (see ReplayStore).
      if (known !== undefined && clock <= known) return Promise.resolve(false);
      seen.delete(key);
      if (seen.size >= max) {
        for (const [entry, until] of seen) {
          if (until < clock) seen.delete(entry);
        }
        if (seen.size >= max) return Promise.resolve(false);
      }
      seen.set(key, expiresAt);
      return Promise.resolve(true);
    },
  });
}
