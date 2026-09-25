// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Unpadded base64url (RFC 4648 section 5), the encoding of every JWS part.
 *
 * @module
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Each ASCII code's 6-bit value, or -1 outside the alphabet. */
const VALUES = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let index = 0; index < ALPHABET.length; index++) {
    table[ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

const encoder = new TextEncoder();

/** Bytes, or a string as UTF-8, in unpadded base64url. */
export function toBase64Url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[n >> 12 & 63] + ALPHABET[n >> 6 & 63] +
      ALPHABET[n & 63];
  }
  if (bytes.length - i === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >> 18] + ALPHABET[n >> 12 & 63];
  } else if (bytes.length - i === 2) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8;
    out += ALPHABET[n >> 18] + ALPHABET[n >> 12 & 63] + ALPHABET[n >> 6 & 63];
  }
  return out;
}

/**
 * The bytes of unpadded base64url text, or null when it is not exactly
 * that: padding, other characters, an impossible length, or leftover bits
 * that are not zero (so each byte string has one spelling). Every character
 * is checked before the output is allocated, and `maxBytes`, when given,
 * refuses (null) text that would decode to more bytes than that without
 * reading it.
 */
export function fromBase64Url(
  text: string,
  maxBytes?: number,
): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null;
  const size = Math.floor(text.length * 3 / 4);
  if (maxBytes !== undefined && size > maxBytes) return null;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 128 || VALUES[code] < 0) return null;
  }
  const out = new Uint8Array(size);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < text.length; i++) {
    buffer = (buffer << 6 | VALUES[text.charCodeAt(i)]) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = buffer >> bits & 255;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

/** Whether `text` is canonical unpadded base64url; see {@link fromBase64Url}. */
export function isBase64Url(text: string): boolean {
  return fromBase64Url(text) !== null;
}
