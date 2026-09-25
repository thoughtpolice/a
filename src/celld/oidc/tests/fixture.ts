// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers the suites share: rejections, a clock, keys, and signing ID
 * tokens to taste.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/assert";
import { type Jwk, type JwsAlgorithm, sign } from "@celld/jwt";
import { generateSigningKey, type SigningKey } from "@celld/oauth/server";
import { type ManualClock, manualClock } from "@celld/oauth/testing";

/** Runs `work` and checks that it throws an error with these fields. */
export async function rejects(
  work: () => Promise<unknown>,
  expected: Readonly<Record<string, unknown>>,
): Promise<Error> {
  try {
    await work();
  } catch (error) {
    assert(error instanceof Error, `expected an Error, got ${error}`);
    const record = error as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(expected)) {
      assertEquals(record[name], value, `${name} of ${error.message}`);
    }
    return error;
  }
  throw new Error(`expected a rejection like ${JSON.stringify(expected)}`);
}

/** 2026-09-25T12:00:00Z. */
export const START = Date.UTC(2026, 8, 25, 12);

/** A manual clock at {@link START}. */
export function clock(): ManualClock {
  return manualClock(START);
}

/** Epoch seconds of a clock. */
export function seconds(now: () => number): number {
  return Math.floor(now() / 1000);
}

/** A fresh signing key. */
export async function key(
  kid: string,
  alg: JwsAlgorithm = "ES256",
): Promise<SigningKey> {
  return await generateSigningKey(alg, kid);
}

/** The JWKS of keys, as a provider publishes it. */
export function jwksOf(...keys: SigningKey[]): { keys: Jwk[] } {
  return {
    keys: keys.map((item) => ({
      ...item.publicJwk,
      kid: item.kid,
      alg: item.alg,
    })),
  };
}

/** Signs `claims` as an ID token with `signer`. */
export async function idToken(
  signer: SigningKey,
  claims: Readonly<Record<string, unknown>>,
  header: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  return await sign(claims, signer.privateKey, {
    alg: signer.alg,
    kid: signer.kid,
    header,
  });
}

/** A response's JSON, after checking its status. */
export async function json(
  response: Response,
  status = 200,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text);
}
