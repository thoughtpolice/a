// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/sec/oauth/dpop`: Demonstrating Proof of Possession (RFC 9449), both
 * sides.
 *
 * ```ts
 * import { DpopKey, verifyDpopProof } from "@celld/sec/oauth/dpop";
 * import { durableReplayStore } from "@celld/sec/oauth/durable";
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
 *   replay: durableReplayStore(env.OAUTH_RECORDS), // shared across isolates
 * });
 * ```
 *
 * - Client: {@link DpopKey} (key pairs, proofs with normalized `htu`,
 *   `iat`, a random `jti`, `ath`, `nonce`; `jkt` for `dpop_jkt`) and
 *   {@link DpopNonceCache}.
 * - Server: {@link verifyDpopProof}, {@link ReplayStore} (a Durable Object
 *   in `@celld/sec/oauth/durable`; {@link unsafeMemoryReplayStore} here is for
 *   tests and a single isolate), {@link DpopNonceIssuer}.
 *   The authorization and resource servers in `@celld/sec/oauth/server` and
 *   `@celld/sec/oauth/resource` use these; so can anything else.
 *
 * Keys default to ES256, the algorithm servers most widely accept; servers
 * here also accept Ed25519 (`EdDSA`) unless configured otherwise.
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
  type DpopVerifyBase,
  type DpopVerifyOptions,
  dpopWindow,
  type MemoryReplayStoreOptions,
  type ReplayStore,
  singleDpopHeader,
  unsafeMemoryReplayStore,
  type VerifiedDpopProof,
  verifyDpopProof,
} from "./verify.ts";
