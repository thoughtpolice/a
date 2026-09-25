// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * JSON Web Tokens on WebCrypto, imported as "@celld/jwt": decoding,
 * signing, verifying against keys or JWKS, and the key helpers around them.
 *
 * ```ts
 * import { generateKeyPair, RemoteJwks, sign, verify } from "@celld/jwt";
 *
 * const { privateKey, publicJwk } = await generateKeyPair("ES256", { kid: "k1" });
 * const token = await sign({ sub: "alice", aud: "api" }, privateKey, {
 *   alg: "ES256",
 *   kid: "k1",
 *   expiresIn: 300,
 * });
 * const { payload } = await verify(token, { keys: [publicJwk] }, {
 *   audience: "api",
 *   requiredClaims: ["exp"],
 * });
 *
 * const issuer = new RemoteJwks("https://auth.example.com/.well-known/jwks.json");
 * await verify(accessToken, issuer, { issuer: "https://auth.example.com", audience: "api" });
 * ```
 *
 * Algorithms: HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512
 * and Ed25519 (as `EdDSA` or `Ed25519`). `none` is always refused, and a
 * key must fit its algorithm: its WebCrypto type, hash, curve and size
 * (RSA 2048 bits and up, HMAC secrets at least as long as the hash), so an
 * RSA public key can never be used as an HMAC secret. Failures throw a
 * `JwtError` with a `code`. A runtime whose WebCrypto lacks an operation
 * (celld 0.5.1 cannot verify Ed25519 or import an `oct` JWK) throws
 * `runtime_unsupported` with the runtime's error as the `cause`, never
 * `bad_signature`. Nothing uses `eval` or Node APIs.
 *
 * @module
 */

export { fromBase64Url, isBase64Url, toBase64Url } from "./base64url.ts";
export {
  decode,
  type DecodedJwt,
  isJwt,
  type IsJwtOptions,
  JWT_PATTERN,
  type JwtClaims,
  type JwtHeader,
  tryDecode,
} from "./decode.ts";
export { JwtError, type JwtErrorCode } from "./errors.ts";
export {
  type FetchLike,
  type KeySet,
  localJwks,
  RemoteJwks,
  type RemoteJwksOptions,
  selectJwk,
} from "./jwks.ts";
export {
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
  MIN_RSA_BITS,
  publicJwk,
  signBytes,
  verifyBytes,
} from "./keys.ts";
export { sign, type SignOptions } from "./sign.ts";
export {
  type Now,
  nowMs,
  type VerifiedJwt,
  verify,
  type VerifyKey,
  type VerifyOptions,
} from "./verify.ts";
