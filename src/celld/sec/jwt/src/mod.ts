// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * JSON Web Tokens on WebCrypto, imported as "@celld/sec/jwt": decoding,
 * signing, verifying against keys or JWKS, and the key helpers around them.
 *
 * ```ts
 * import { createVerifier, generateKeyPair, RemoteJwks, sign } from "@celld/sec/jwt";
 *
 * const { privateKey, publicJwk } = await generateKeyPair("ES256", { kid: "k1" });
 * const token = await sign({ sub: "alice", aud: "api" }, privateKey, {
 *   alg: "ES256",
 *   kid: "k1",
 *   expiresIn: 300,
 * });
 * const verifier = createVerifier({
 *   keys: publicJwk,
 *   algorithms: ["ES256"],
 *   audience: "api",
 *   requiredClaims: ["exp"],
 * });
 * const { payload } = await verifier.verify(token);
 *
 * const accessTokens = createVerifier({
 *   keys: new RemoteJwks("https://auth.example.com/.well-known/jwks.json"),
 *   algorithms: ["RS256", "ES256"],
 *   issuer: "https://auth.example.com",
 *   audience: "api",
 *   typ: "at+jwt",
 *   requiredClaims: ["exp", "sub"],
 * });
 * await accessTokens.verify(accessToken);
 * ```
 *
 * Algorithms: HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512
 * and Ed25519 (as `EdDSA` or `Ed25519`). `none` is always refused, and a
 * key must fit its algorithm: its WebCrypto type, hash, curve and size
 * (RSA 2048 bits and up, HMAC secrets at least as long as the hash), so an
 * RSA public key can never be used as an HMAC secret. Failures throw a
 * `JwtError` with a `code`. A runtime whose WebCrypto lacks an operation
 * (celld cannot import an `oct` JWK) throws
 * `runtime_unsupported` with the runtime's error as the `cause`, never
 * `bad_signature`. Verification needs an explicit, non-empty algorithm
 * list; tokens are size-capped before decoding; numeric options are
 * checked finite; `RemoteJwks` fetches through a bounded egress policy.
 * Nothing uses `eval` or Node APIs.
 *
 * @module
 */

export { fromBase64Url, isBase64Url, toBase64Url } from "./base64url.ts";
export {
  decode,
  type DecodedJwt,
  type DecodeOptions,
  isJwt,
  type IsJwtOptions,
  JWT_PATTERN,
  type JwtClaims,
  type JwtHeader,
  REGISTERED_HEADER_PARAMETERS,
  tryDecode,
} from "./decode.ts";
export { JwtError, type JwtErrorCode } from "./errors.ts";
export {
  type FetchLike,
  JWKS_MAX_BYTES,
  JWKS_MAX_KEYS,
  JWKS_TIMEOUT_MS,
  type KeySet,
  localJwks,
  RemoteJwks,
  type RemoteJwksOptions,
  selectJwk,
} from "./jwks.ts";
export {
  assertAlgorithmsSupported,
  checkKey,
  exportPublicJwk,
  type GeneratedKeyPair,
  generateKeyPair,
  generateSecret,
  importJwk,
  importKey,
  isJwsAlgorithm,
  type Jwk,
  jwkFits,
  type Jwks,
  jwkThumbprint,
  JWS_ALGORITHMS,
  type JwsAlgorithm,
  type KeyLike,
  type KeyUsage,
  MIN_RSA_BITS,
  publicJwk,
  publicVerificationKeys,
  signBytes,
  validatePublicJwk,
  verifyBytes,
} from "./keys.ts";
export { DEFAULT_JWT_LIMITS, type JwtLimits, MAX_JWT_LIMIT } from "./limits.ts";
export { sign, type SignOptions } from "./sign.ts";
export {
  type ClaimsRefinement,
  createVerifier,
  type CritProcessors,
  type JwtVerifier,
  MAX_CLOCK_TOLERANCE,
  type Now,
  nowMs,
  type VerifiedJwt,
  type VerifierOptions,
  verify,
  type VerifyKey,
  type VerifyOptions,
} from "./verify.ts";
