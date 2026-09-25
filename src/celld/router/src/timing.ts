// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Comparisons for secrets that take the same time wherever the inputs
 * differ, so a caller cannot find a key or token byte by byte from how
 * long a refusal takes.
 *
 * @module
 */

const encoder = new TextEncoder();

function bytesOf(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

/**
 * Whether `a` and `b` are equal (strings compare as UTF-8), looking at
 * every byte whatever the first difference. The length is not secret: two
 * values of different lengths return false straight away. When the length
 * matters too, use {@link secretEquals}.
 */
export function timingSafeEqual(
  a: string | Uint8Array,
  b: string | Uint8Array,
): boolean {
  const left = bytesOf(a);
  const right = bytesOf(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

let comparisonKey: Promise<CryptoKey> | undefined;

async function hmac(data: Uint8Array): Promise<Uint8Array> {
  comparisonKey ??= crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  ) as Promise<CryptoKey>;
  const key = await comparisonKey;
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, data as Uint8Array<ArrayBuffer>),
  );
}

/**
 * Whether `a` and `b` are equal, leaking neither where they differ nor
 * their lengths: both go through HMAC-SHA256 under a random per-isolate
 * key and the digests are compared with {@link timingSafeEqual}.
 */
export async function secretEquals(
  a: string | Uint8Array,
  b: string | Uint8Array,
): Promise<boolean> {
  const [left, right] = await Promise.all([hmac(bytesOf(a)), hmac(bytesOf(b))]);
  return timingSafeEqual(left, right);
}
