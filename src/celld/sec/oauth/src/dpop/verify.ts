// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The server half of DPoP: {@link verifyDpopProof} runs every check of
 * RFC 9449 section 4.3 (and 7.1 for resource requests), with replay
 * prevention through a {@link ReplayStore} and nonces from a
 * {@link DpopNonceSource}.
 *
 * @module
 */

import { jsonSnapshot, safeInt, strictRecord } from "@celld/core/bounds";
import {
  decode,
  type Jwk,
  jwkThumbprint,
  JwtError,
  validatePublicJwk,
  verify,
} from "@celld/sec/jwt";
import {
  type Clock,
  defaultClock,
  isObject,
  rethrowRuntimeUnsupported,
  sha256,
} from "../util.ts";
import { htuMatches } from "./htu.ts";
import {
  accessTokenHash,
  DEFAULT_DPOP_ALGORITHMS,
  type DpopAlgorithm,
  hasPrivateMembers,
  isDpopAlgorithm,
} from "./key.ts";
import type { DpopNonceSource } from "./nonce.ts";

/**
 * Remembers what has been seen, so a DPoP proof (or a client assertion)
 * is accepted once. `claim` is atomic: of concurrent calls for one key,
 * exactly one returns true. An entry is live while `now <= expiresAt`
 * (epoch milliseconds): `expiresAt` is the last millisecond at which the
 * proof is still accepted, so a claim at that very millisecond is
 * refused, and the entry may be forgotten from the next one on.
 */
export interface ReplayStore {
  /**
   * True the first time `key` is claimed while no live entry holds it;
   * false while one does (up to and including `expiresAt`).
   */
  claim(key: string, expiresAt: number): Promise<boolean>;
}

/** Options for {@link unsafeMemoryReplayStore}. */
export interface MemoryReplayStoreOptions {
  readonly now?: Clock;
  /** The most live entries kept; default 100 000, a whole number from 1. */
  readonly maxEntries?: number;
}

/**
 * An in-memory {@link ReplayStore}, bounded by `maxEntries`, for tests and
 * a single isolate only. It is unsafe for a deployment: a Worker runs in
 * many isolates, each with its own map, so a proof replayed to another
 * isolate is accepted again. Use a shared atomic store
 * (`durableReplayStore` in `@celld/sec/oauth/durable`). Server nonces are an
 * additional defense, not a replacement for atomic replay claims.
 *
 * When it holds `maxEntries` live entries it refuses new claims, failing
 * closed: forgetting a live entry would let its proof be replayed. Throws
 * `RangeError` for a bad `maxEntries`.
 */
export function unsafeMemoryReplayStore(
  options: MemoryReplayStoreOptions = {},
): ReplayStore {
  const now = options.now ?? defaultClock;
  const max = safeInt(options.maxEntries ?? 100_000, {
    name: "maxEntries",
    min: 1,
  });
  const seen = new Map<string, number>();
  return {
    claim(key, expiresAt) {
      const clock = now();
      const known = seen.get(key);
      if (known !== undefined && known >= clock) return Promise.resolve(false);
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
  };
}

/** Why a proof was refused: the two DPoP error codes of RFC 9449. */
export type DpopErrorCode = "invalid_dpop_proof" | "use_dpop_nonce";

/**
 * A refused proof. `use_dpop_nonce` means the client should retry with
 * the nonce the server sends in `DPoP-Nonce`.
 */
export class DpopError extends Error {
  override name = "DpopError";
  readonly code: DpopErrorCode;

  constructor(code: DpopErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/**
 * What {@link verifyDpopProof} checks a proof against. Freshness is a
 * required choice: a `replay` store (optionally with server nonces), or
 * `unsafeNoReplay: true`, which accepts a captured proof again for its
 * whole `iat` window and is only for a caller that enforces single use
 * itself. A nonce without a replay store is allowed only in that explicitly
 * unsafe branch: reusable server nonces do not make a proof single-use.
 */
export type DpopVerifyOptions =
  & DpopVerifyBase
  & (
    | {
      readonly replay: ReplayStore;
      readonly nonce?: DpopNonceSource;
      readonly unsafeNoReplay?: never;
    }
    | {
      readonly unsafeNoReplay: true;
      readonly replay?: never;
      readonly nonce?: DpopNonceSource;
    }
  );

/** The checks of {@link DpopVerifyOptions} other than freshness. */
export interface DpopVerifyBase {
  /** The request's method. */
  readonly method: string;
  /** The request's URL as the server sees it (its public URL behind a proxy). */
  readonly url: string | URL;
  /** The access token the request carries: `ath` must hash it. */
  readonly accessToken?: string;
  /** The thumbprint the access token is bound to (`cnf.jkt`): the proof's key must match. */
  readonly jkt?: string;
  /** Accepted algorithms; default {@link DEFAULT_DPOP_ALGORITHMS}. */
  readonly algorithms?: readonly DpopAlgorithm[];
  /**
   * How old `iat` may be, in seconds (before clock tolerance); default
   * 60. A proof from the future passes only within the tolerance. RFC 9449
   * leaves the window to the server.
   */
  readonly maxAgeSec?: number;
  /** Seconds of clock skew allowed on top of the window; default 5. */
  readonly clockToleranceSec?: number;
  /** Default `Date.now`. */
  readonly now?: Clock;
}

/** A proof that passed. */
export interface VerifiedDpopProof {
  /** The proof's public key. */
  readonly jwk: Jwk;
  /** Its RFC 7638 thumbprint: what tokens are bound to. */
  readonly jkt: string;
  readonly alg: DpopAlgorithm;
  readonly claims: Readonly<Record<string, unknown>>;
}

const MAX_PROOF_LENGTH = 8192;

/**
 * A proof's `iat` window, checked: `maxAgeSec` a whole number from 1 to
 * 3600 (default 60), `clockToleranceSec` from 0 to 300 (default 5), the
 * same ranges as `@celld/web/router`'s `dpop` scheme. Throws `RangeError`.
 */
export function dpopWindow(
  options: {
    readonly maxAgeSec?: number;
    readonly clockToleranceSec?: number;
  },
): { readonly maxAgeSec: number; readonly clockToleranceSec: number } {
  return {
    maxAgeSec: safeInt(options.maxAgeSec ?? 60, {
      name: "DPoP maxAgeSec",
      min: 1,
      max: 3600,
    }),
    clockToleranceSec: safeInt(options.clockToleranceSec ?? 5, {
      name: "DPoP clockToleranceSec",
      min: 0,
      max: 300,
    }),
  };
}

function invalid(message: string, cause?: unknown): DpopError {
  return new DpopError(
    "invalid_dpop_proof",
    message,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * The single DPoP proof among a request's `DPoP` header values, or null
 * when there is none. More than one (repeated headers, which `Headers`
 * joins with commas) is an error: RFC 9449 section 4.3 allows exactly one.
 */
export function singleDpopHeader(headers: Headers): string | null {
  const value = headers.get("dpop");
  if (value === null) return null;
  if (value.includes(",")) {
    throw invalid("a request carries exactly one DPoP header");
  }
  return value.trim();
}

/**
 * Verifies a DPoP proof, in RFC 9449 section 4.3's order, throwing a
 * {@link DpopError} for the first failure:
 *
 * 1. it is a compact JWS (at most 8 KiB) with `typ` `dpop+jwt`, an allowed
 *    asymmetric `alg` (never `none`), and a public `jwk` header with no
 *    private members;
 * 2. the signature verifies under that `jwk`;
 * 3. `jti`, `htm`, `htu` and `iat` are present; `htm` is the method and
 *    `htu` the URL (normalized, ignoring query and fragment);
 * 4. `iat` is at most `maxAgeSec` old and at most the tolerance ahead;
 * 5. with `nonce`, the proof carries one the source accepts
 *    (`use_dpop_nonce` otherwise);
 * 6. with `accessToken`, `ath` is its hash; with `jkt`, the key's
 *    thumbprint is `jkt`;
 * 7. with `replay`, the `jti` has not been seen for this key.
 *
 * The replay claim is the last step, so a proof refused for another reason
 * does not use up its `jti`.
 */
export async function verifyDpopProof(
  proof: string,
  options: DpopVerifyOptions,
): Promise<VerifiedDpopProof> {
  strictRecord(options as unknown, [
    "method",
    "url",
    "accessToken",
    "jkt",
    "algorithms",
    "maxAgeSec",
    "clockToleranceSec",
    "now",
    "replay",
    "nonce",
    "unsafeNoReplay",
  ], "DPoP verification options");
  if (
    options.unsafeNoReplay !== undefined && options.unsafeNoReplay !== true
  ) throw new TypeError("unsafeNoReplay must be literal true when present");
  if (
    options.replay !== undefined &&
    typeof options.replay?.claim !== "function"
  ) throw new TypeError("replay must be a ReplayStore");
  if (
    options.nonce !== undefined &&
    (typeof options.nonce?.current !== "function" ||
      typeof options.nonce?.check !== "function")
  ) throw new TypeError("nonce must be a DpopNonceSource");
  if (
    options.replay !== undefined && options.unsafeNoReplay !== undefined
  ) throw new TypeError("choose replay or unsafeNoReplay, not both");
  if (
    options.algorithms !== undefined &&
    (!Array.isArray(options.algorithms) || options.algorithms.length === 0 ||
      options.algorithms.length > 16 ||
      !options.algorithms.every(isDpopAlgorithm))
  ) throw new TypeError("DPoP algorithms must be a bounded asymmetric policy");
  if (
    options.accessToken !== undefined &&
    (typeof options.accessToken !== "string" ||
      options.accessToken.length === 0 || options.accessToken.length > 16_384)
  ) throw invalid("invalid access token length");
  // Before the proof is looked at: a caller that forgot the store would
  // otherwise accept every captured proof again.
  if (
    options.replay === undefined && options.unsafeNoReplay !== true
  ) {
    throw new TypeError(
      "verifyDpopProof needs a replay store or unsafeNoReplay: true",
    );
  }
  if (typeof proof !== "string" || proof.length > MAX_PROOF_LENGTH) {
    throw invalid("the proof is too long or not a string");
  }
  let header: Record<string, unknown>;
  try {
    header = decode(proof).header;
  } catch (cause) {
    throw invalid("the proof is not a JWT", cause);
  }
  const algorithms = options.algorithms ?? DEFAULT_DPOP_ALGORITHMS;
  const alg = header.alg;
  if (!isDpopAlgorithm(alg) || !algorithms.includes(alg)) {
    throw invalid(`alg ${JSON.stringify(alg)} is not accepted`);
  }
  let jwk = header.jwk;
  if (!isObject(jwk)) throw invalid("the proof has no jwk header");
  if (hasPrivateMembers(jwk)) {
    throw invalid("the jwk header carries a private key");
  }
  try {
    jwk = validatePublicJwk(jwk);
  } catch (cause) {
    throw invalid("the jwk header is not a public verification key", cause);
  }
  const { maxAgeSec: maxAge, clockToleranceSec: tolerance } = dpopWindow(
    options,
  );
  const now = options.now ?? defaultClock;
  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await verify(proof, jwk as Jwk, {
      algorithms: [alg],
      typ: "dpop+jwt",
      requiredClaims: ["jti", "htm", "htu", "iat"],
      maxTokenAge: maxAge,
      clockTolerance: tolerance,
      now,
    }));
  } catch (cause) {
    rethrowRuntimeUnsupported(cause);
    if (cause instanceof JwtError) {
      const reason: Partial<Record<string, string>> = {
        typ: "typ must be dpop+jwt",
        key_mismatch: "the jwk does not fit alg",
        bad_signature: "the signature does not verify",
        too_old: "iat is too far in the past",
        not_yet_valid: "iat is in the future",
        expired: "the proof has expired",
        missing_claim: cause.message,
        crit: cause.message,
      };
      throw invalid(reason[cause.code] ?? cause.message, cause);
    }
    throw invalid("the proof does not verify", cause);
  }
  if (typeof claims.jti !== "string" || claims.jti === "") {
    throw invalid("jti must be a non-empty string");
  }
  if (claims.jti.length > 256) throw invalid("jti is too long");
  if (typeof claims.iat !== "number") throw invalid("iat must be a number");
  if (claims.htm !== options.method) {
    throw invalid(`htm is not ${options.method}`);
  }
  if (!htuMatches(claims.htu, options.url)) {
    throw invalid("htu does not match the request URL");
  }
  if (options.nonce !== undefined) {
    if (typeof claims.nonce !== "string") {
      throw new DpopError("use_dpop_nonce", "the proof needs a nonce");
    }
    if ((await options.nonce.check(claims.nonce)) !== true) {
      throw new DpopError("use_dpop_nonce", "the proof's nonce is stale");
    }
  }
  if (options.accessToken !== undefined) {
    if (typeof claims.ath !== "string") {
      throw invalid("the proof has no ath for the access token");
    }
    if (claims.ath !== await accessTokenHash(options.accessToken)) {
      throw invalid("ath does not match the access token");
    }
  }
  let jkt: string;
  try {
    jkt = await jwkThumbprint(jwk as Jwk);
  } catch (cause) {
    throw invalid("the jwk has no thumbprint", cause);
  }
  if (options.jkt !== undefined && jkt !== options.jkt) {
    throw invalid("the proof's key is not the one the token is bound to");
  }
  if (options.replay !== undefined) {
    const key = `dpop:${await sha256(`${jkt}\n${claims.jti}`)}`;
    // The last millisecond the age check above accepts (`@celld/sec/jwt`
    // refuses only past maxAge + tolerance); the store keeps the entry
    // through it.
    const until = (claims.iat + maxAge + tolerance) * 1000;
    if (
      (await options.replay.claim(key, Math.max(until, now() + 1000))) !== true
    ) {
      throw invalid("the proof has been used before");
    }
  }
  return jsonSnapshot({ jwk: jwk as Jwk, jkt, alg, claims });
}
