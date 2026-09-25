// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link sign}: a compact JWS over a claims set.
 *
 * @module
 */

import { toBase64Url } from "./base64url.ts";
import type { JwtClaims } from "./decode.ts";
import { JwtError } from "./errors.ts";
import {
  isJwsAlgorithm,
  type JwsAlgorithm,
  type KeyLike,
  signBytes,
} from "./keys.ts";
import { type Now, nowMs } from "./verify.ts";

/** How {@link sign} builds the header and the time claims. */
export interface SignOptions {
  readonly alg: JwsAlgorithm;
  readonly kid?: string;
  /** Default `JWT`; null leaves `typ` out. */
  readonly typ?: string | null;
  /** More header parameters; they cannot change `alg`. */
  readonly header?: Readonly<Record<string, unknown>>;
  /** Set `iat` to now. */
  readonly issuedAt?: boolean;
  /** Set `exp` to now plus this many seconds. */
  readonly expiresIn?: number;
  /** Set `nbf` to now plus this many seconds (0 for now). */
  readonly notBefore?: number;
  /** Default `Date.now`. */
  readonly now?: Now;
}

/**
 * Signs `claims` as a compact JWS with `key`, which must fit `alg` (see
 * `importKey`). The time options overwrite the claims they set; times are
 * whole seconds.
 */
export async function sign(
  claims: JwtClaims,
  key: KeyLike,
  options: SignOptions,
): Promise<string> {
  if (!isJwsAlgorithm(options.alg)) {
    throw new JwtError(
      "unsupported_alg",
      `unsupported alg ${JSON.stringify(options.alg)}`,
    );
  }
  const typ = options.typ === undefined ? "JWT" : options.typ;
  const header: Record<string, unknown> = {
    alg: options.alg,
    ...(typ === null ? {} : { typ }),
    ...(options.kid === undefined ? {} : { kid: options.kid }),
    ...options.header,
  };
  header.alg = options.alg;
  const now = Math.floor(nowMs(options.now) / 1000);
  const payload: Record<string, unknown> = { ...claims };
  if (options.issuedAt) payload.iat = now;
  if (options.expiresIn !== undefined) payload.exp = now + options.expiresIn;
  if (options.notBefore !== undefined) payload.nbf = now + options.notBefore;
  const input = `${toBase64Url(JSON.stringify(header))}.${
    toBase64Url(JSON.stringify(payload))
  }`;
  const signature = await signBytes(
    options.alg,
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${toBase64Url(signature)}`;
}
