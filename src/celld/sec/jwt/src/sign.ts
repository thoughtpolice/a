// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link sign}: a compact JWS over a claims set.
 *
 * @module
 */

import { finite } from "@celld/core/bounds";
import { toBase64Url } from "./base64url.ts";
import { checkHeader, decode, type JwtClaims } from "./decode.ts";
import { JwtError } from "./errors.ts";
import {
  isJwsAlgorithm,
  type JwsAlgorithm,
  type KeyLike,
  signBytes,
} from "./keys.ts";
import { type CritProcessors, type Now, nowMs } from "./verify.ts";
import { checkClaimStructure } from "./decode.ts";
import type { JwtLimits } from "./limits.ts";

/** How {@link sign} builds the header and the time claims. */
export interface SignOptions {
  /** Explicit nondefault size policy; the verifier must use matching limits. */
  readonly limits?: JwtLimits;
  /** Processors for explicitly understood critical header extensions. */
  readonly crit?: CritProcessors;
  readonly alg: JwsAlgorithm;
  readonly kid?: string;
  /** Default `JWT`; null leaves `typ` out. */
  readonly typ?: string | null;
  /**
   * More header parameters; they cannot change `alg`. The header must pass
   * the same checks `decode` applies: typed registered members, a valid
   * `crit` (distinct, present, unregistered names), and no `b64`, which is
   * not implemented (`unsupported`).
   */
  readonly header?: Readonly<Record<string, unknown>>;
  /** Set `iat` to now. */
  readonly issuedAt?: boolean;
  /** Set `exp` to now plus this many seconds (finite). */
  readonly expiresIn?: number;
  /** Set `nbf` to now plus this many seconds (0 for now; finite). */
  readonly notBefore?: number;
  /** Default `Date.now`. */
  readonly now?: Now;
}

/**
 * Signs `claims` as a compact JWS with `key`, which must fit `alg` (see
 * `importKey`). The time options overwrite the claims they set; times are
 * whole seconds. A non-finite clock or offset throws a `RangeError`.
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
  for (const name of ["alg", "kid", "typ"]) {
    if (options.header !== undefined && Object.hasOwn(options.header, name)) {
      throw new JwtError("malformed", `use the dedicated ${name} option`);
    }
  }
  const header: Record<string, unknown> = {
    alg: options.alg,
    ...(typ === null ? {} : { typ }),
    ...(options.kid === undefined ? {} : { kid: options.kid }),
    ...options.header,
  };
  header.alg = options.alg;
  checkHeader(header);
  for (const name of (header.crit ?? []) as string[]) {
    const processor =
      options.crit !== undefined && Object.hasOwn(options.crit, name)
        ? options.crit[name]
        : undefined;
    if (typeof processor !== "function") {
      throw new JwtError("crit", "critical header has no processor");
    }
    processor(header as { alg: string }, header[name]);
  }
  const expiresIn = options.expiresIn === undefined
    ? undefined
    : finite(options.expiresIn, { name: "expiresIn" });
  const notBefore = options.notBefore === undefined
    ? undefined
    : finite(options.notBefore, { name: "notBefore" });
  const now = Math.floor(nowMs(options.now) / 1000);
  const payload: Record<string, unknown> = { ...claims };
  if (options.issuedAt) payload.iat = now;
  if (expiresIn !== undefined) payload.exp = now + expiresIn;
  if (notBefore !== undefined) payload.nbf = now + notBefore;
  checkClaimStructure(payload);
  const input = `${toBase64Url(JSON.stringify(header))}.${
    toBase64Url(JSON.stringify(payload))
  }`;
  decode(`${input}.AA`, { limits: options.limits });
  const signature = await signBytes(
    options.alg,
    key,
    new TextEncoder().encode(input),
  );
  const token = `${input}.${toBase64Url(signature)}`;
  decode(token, { limits: options.limits });
  return token;
}
