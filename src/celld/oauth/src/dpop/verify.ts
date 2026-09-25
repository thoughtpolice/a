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

import { decode, type Jwk, jwkThumbprint, JwtError, verify } from "@celld/jwt";
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
 * exactly one returns true. Entries may be forgotten after `expiresAt`
 * (epoch milliseconds), by which time the proof is too old anyway.
 */
export interface ReplayStore {
  /** True the first time `key` is claimed before it expires; false after. */
  claim(key: string, expiresAt: number): Promise<boolean>;
}

/** An in-memory {@link ReplayStore} for one isolate, bounded by `maxEntries`. */
export function memoryReplayStore(
  options: { readonly now?: Clock; readonly maxEntries?: number } = {},
): ReplayStore {
  const now = options.now ?? defaultClock;
  const max = options.maxEntries ?? 100_000;
  const seen = new Map<string, number>();
  return {
    claim(key, expiresAt) {
      const clock = now();
      const known = seen.get(key);
      if (known !== undefined && known > clock) return Promise.resolve(false);
      if (seen.size >= max) {
        for (const [entry, until] of seen) {
          if (until <= clock) seen.delete(entry);
        }
        if (seen.size >= max) seen.delete(seen.keys().next().value!);
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

/** What {@link verifyDpopProof} checks a proof against. */
export interface DpopVerifyOptions {
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
  /**
   * Remembers `jti`s so each proof is used once. Without one, replay is
   * limited only by the `iat` window (and nonces, if used); a server should
   * always pass one.
   */
  readonly replay?: ReplayStore;
  /** Where nonces come from; when set, every proof must carry a valid one. */
  readonly nonce?: DpopNonceSource;
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
  if (proof.length > MAX_PROOF_LENGTH) throw invalid("the proof is too long");
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
  const jwk = header.jwk;
  if (!isObject(jwk)) throw invalid("the proof has no jwk header");
  if (hasPrivateMembers(jwk)) {
    throw invalid("the jwk header carries a private key");
  }
  const maxAge = options.maxAgeSec ?? 60;
  const tolerance = options.clockToleranceSec ?? 5;
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
    if (!(await options.nonce.check(claims.nonce))) {
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
    const until = (claims.iat + maxAge + tolerance) * 1000;
    if (!(await options.replay.claim(key, Math.max(until, now() + 1000)))) {
      throw invalid("the proof has been used before");
    }
  }
  return { jwk: jwk as Jwk, jkt, alg, claims };
}
