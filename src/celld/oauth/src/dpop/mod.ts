// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oauth/dpop`: Demonstrating Proof of Possession (RFC 9449), both
 * sides.
 *
 * ```ts
 * import { DpopKey, verifyDpopProof, memoryReplayStore } from "@celld/oauth/dpop";
 *
 * // Client: one key per client instance, a proof per request.
 * const key = await DpopKey.generate(); // ES256
 * const proof = await key.proof({ method: "GET", url, accessToken });
 *
 * // Server: every check of section 4.3, jti replay included.
 * const verified = await verifyDpopProof(proof, {
 *   method: request.method,
 *   url: request.url,
 *   accessToken,
 *   jkt: token.cnf.jkt,
 *   replay: memoryReplayStore(),
 * });
 * ```
 *
 * - Client: {@link DpopKey} (key pairs, proofs with normalized `htu`,
 *   `iat`, a random `jti`, `ath`, `nonce`; `jkt` for `dpop_jkt`) and
 *   {@link DpopNonceCache}.
 * - Server: {@link verifyDpopProof}, {@link ReplayStore} (in memory here, a
 *   Durable Object in `@celld/oauth/durable`), {@link DpopNonceIssuer}.
 *   The authorization and resource servers in `@celld/oauth/server` and
 *   `@celld/oauth/resource` use these; so can anything else.
 *
 * Keys default to ES256: celld's WebCrypto cannot verify Ed25519, so
 * servers here do not accept it unless configured to.
 *
 * @module
 */

export { htuMatches, normalizeHtu } from "./htu.ts";
export {
  accessTokenHash,
  checkDpopAlgorithm,
  DEFAULT_DPOP_ALGORITHMS,
  DPOP_ALGORITHMS,
  type DpopAlgorithm,
  DpopKey,
  type DpopKeyOptions,
  DpopNonceCache,
  type DpopProofOptions,
  hasPrivateMembers,
  isDpopAlgorithm,
} from "./key.ts";
export {
  DpopNonceIssuer,
  type DpopNonceIssuerOptions,
  type DpopNonceSource,
} from "./nonce.ts";
export {
  DpopError,
  type DpopErrorCode,
  type DpopVerifyOptions,
  memoryReplayStore,
  type ReplayStore,
  singleDpopHeader,
  type VerifiedDpopProof,
  verifyDpopProof,
} from "./verify.ts";
