// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * ULIDs (https://github.com/ulid/spec), imported as "@celld/ulid": 128-bit
 * identifiers whose first 48 bits are a Unix time in milliseconds and whose
 * other 80 are random, written as 26 characters of Crockford base32 so they
 * sort by time as plain strings.
 *
 * ```ts
 * import { decodeTime, monotonicFactory, ulid } from "@celld/ulid";
 *
 * const id = ulid(); // "01J8Z7Q3W5N4B6C0XKPM2R9T8V"
 * decodeTime(id); // milliseconds since the epoch
 * const next = monotonicFactory();
 * next() < next(); // true, even within one millisecond
 * ```
 *
 * Decoding is case-insensitive; encoding is upper case. The letters I, L,
 * O and U are not in the alphabet and are rejected rather than read as 1, 1,
 * 0 and V. The clock and the random source are parameters, so tests can pin
 * both.
 *
 * @module
 */

/** Crockford's base32 alphabet, in digit order. */
export const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The largest time a ULID can hold: 2^48 - 1 milliseconds. */
export const MAX_TIME = 2 ** 48 - 1;

/**
 * A regular expression source for a ULID in either case; the first
 * character is at most 7, as the spec requires of a 128-bit value.
 */
export const ULID_PATTERN = "^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$";

const ULID = new RegExp(ULID_PATTERN);

const TIME_LENGTH = 10;
const RANDOM_BYTES = 10;

const DECODING: Readonly<Record<string, number>> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < ENCODING.length; i++) {
    table[ENCODING[i]] = i;
    table[ENCODING[i].toLowerCase()] = i;
  }
  return table;
})();

/** Fills its argument with random bytes, like `crypto.getRandomValues`. */
export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => void;

/** Milliseconds since the Unix epoch, like `Date.now`. */
export type Clock = () => number;

/** Where a factory gets its time and randomness. */
export interface UlidOptions {
  /** Default `crypto.getRandomValues`. */
  readonly random?: RandomSource;
  /** Default `Date.now`. */
  readonly now?: Clock;
}

/** Makes a ULID, at `time` if given, else at the factory's clock. */
export type UlidFactory = (time?: number) => string;

/** A malformed ULID or time, or a monotonic sequence that ran out. */
export class UlidError extends Error {
  override name = "UlidError";
}

const defaultRandom: RandomSource = (bytes) => {
  crypto.getRandomValues(bytes);
};

function checkTime(time: number): number {
  if (!Number.isSafeInteger(time) || time < 0 || time > MAX_TIME) {
    throw new UlidError(
      `ULID time must be an integer from 0 to ${MAX_TIME}, got ${time}`,
    );
  }
  return time;
}

/** The 10-character time part of a ULID. */
export function encodeTime(time: number): string {
  let rest = checkTime(time);
  let out = "";
  for (let i = 0; i < TIME_LENGTH; i++) {
    out = ENCODING[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ENCODING[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** Whether `text` is a ULID, in either case. */
export function isUlid(text: string): boolean {
  return ULID.test(text);
}

function checkUlid(text: string): void {
  if (!isUlid(text)) throw new UlidError(`not a ULID: ${JSON.stringify(text)}`);
}

/** The time in a ULID, in milliseconds since the epoch. */
export function decodeTime(id: string): number {
  checkUlid(id);
  let time = 0;
  for (let i = 0; i < TIME_LENGTH; i++) time = time * 32 + DECODING[id[i]];
  return time;
}

/** A ULID in its canonical, upper-case spelling. */
export function canonicalUlid(id: string): string {
  checkUlid(id);
  return id.toUpperCase();
}

/** The 16 big-endian bytes a ULID stands for. */
export function ulidToBytes(id: string): Uint8Array<ArrayBuffer> {
  checkUlid(id);
  const bytes = new Uint8Array(16);
  let time = decodeTime(id);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = time % 256;
    time = Math.floor(time / 256);
  }
  let buffer = 0;
  let bits = 0;
  let index = 6;
  for (let i = TIME_LENGTH; i < id.length; i++) {
    buffer = (buffer << 5) | DECODING[id[i]];
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes;
}

/** The ULID for 16 big-endian bytes; every 128-bit value is one. */
export function ulidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new UlidError(`a ULID is 16 bytes, got ${bytes.length}`);
  }
  let time = 0;
  for (let i = 0; i < 6; i++) time = time * 256 + bytes[i];
  return encodeTime(time) + encodeRandom(bytes.subarray(6));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same 128 bits as a lower-case UUID string. The result is not an RFC
 * 9562 UUID of any version: its version and variant bits are whatever the
 * ULID had.
 */
export function ulidToUuid(id: string): string {
  const hex = Array.from(
    ulidToBytes(id),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

/** The ULID with the same 128 bits as a UUID string, in either case. */
export function ulidFromUuid(uuid: string): string {
  if (!UUID.test(uuid)) {
    throw new UlidError(`not a UUID: ${JSON.stringify(uuid)}`);
  }
  const hex = uuid.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return ulidFromBytes(bytes);
}

/** A factory whose ULIDs each get fresh randomness. */
export function ulidFactory(options: UlidOptions = {}): UlidFactory {
  const random = options.random ?? defaultRandom;
  const now = options.now ?? Date.now;
  return (time) => {
    const bytes = new Uint8Array(RANDOM_BYTES);
    random(bytes);
    return encodeTime(time ?? now()) + encodeRandom(bytes);
  };
}

/**
 * A factory whose ULIDs strictly increase. Within one millisecond (or when
 * the clock goes back) it reuses the last time and adds one to the last
 * random part; when that part would overflow its 80 bits, it throws a
 * {@link UlidError} instead, as the spec says.
 */
export function monotonicFactory(options: UlidOptions = {}): UlidFactory {
  const random = options.random ?? defaultRandom;
  const now = options.now ?? Date.now;
  let lastTime = -1;
  const last = new Uint8Array(RANDOM_BYTES);
  return (time) => {
    const current = checkTime(time ?? now());
    if (current > lastTime) {
      lastTime = current;
      random(last);
    } else {
      let i = RANDOM_BYTES - 1;
      while (i >= 0 && last[i] === 255) i--;
      if (i < 0) {
        throw new UlidError(
          `monotonic ULID random part overflowed at time ${lastTime}`,
        );
      }
      last[i]++;
      last.fill(0, i + 1);
    }
    return encodeTime(lastTime) + encodeRandom(last);
  };
}

const defaultFactory = ulidFactory();

/** A new ULID at `time` (default now), with fresh randomness. */
export function ulid(time?: number): string {
  return defaultFactory(time);
}
