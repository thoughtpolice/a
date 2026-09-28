// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The CBOR subset WebAuthn uses (RFC 8949): unsigned and negative
 * integers, byte and text strings, arrays, maps, `true`, `false` and
 * `null`. Attestation objects, COSE keys and authenticator extension
 * outputs are all in it.
 *
 * {@link decodeCbor} is strict about structure: definite lengths only, no
 * tags, floats, `undefined` or reserved encodings, no duplicate map keys,
 * integers within `Number.MAX_SAFE_INTEGER`, text that is valid UTF-8, a
 * bounded depth and, unless asked for one item at an offset, no trailing
 * bytes. It does not insist on CTAP2's canonical form (shortest integers,
 * sorted keys), which the spec says decoders SHOULD enforce: nothing here
 * re-encodes and compares, signatures cover the bytes as sent, and
 * relying-party libraries commonly accept both, so refusing an
 * authenticator's unsorted key would only lock its user out.
 * {@link encodeCbor} writes the canonical form, for test authenticators.
 *
 * @module
 */

/** A decoded CBOR value. Maps keep integer and text keys apart. */
export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array<ArrayBuffer>
  | readonly CborValue[]
  | CborMap;

/** A CBOR map: integer keys (COSE labels) and text keys, in wire order. */
export type CborMap = ReadonlyMap<number | string, CborValue>;

/** Malformed or unsupported CBOR. */
export class CborError extends Error {
  override readonly name = "CborError";
}

/** Options for {@link decodeCbor}. */
export interface DecodeOptions {
  /** Where to start; default 0. */
  readonly offset?: number;
  /**
   * Decode one item and report where it ended, instead of requiring it to
   * fill the input; for the COSE key and extensions inside authenticator
   * data. Default false.
   */
  readonly partial?: boolean;
  /** The deepest nesting of arrays and maps; default 8. */
  readonly maxDepth?: number;
}

/** A decoded item and the offset just past it. */
export interface Decoded {
  readonly value: CborValue;
  readonly end: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class Reader {
  offset: number;
  constructor(readonly bytes: Uint8Array, offset: number) {
    this.offset = offset;
  }

  byte(): number {
    if (this.offset >= this.bytes.length) {
      throw new CborError("CBOR ends in the middle of an item");
    }
    return this.bytes[this.offset++];
  }

  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.offset) {
      throw new CborError("a CBOR string runs past the end of the input");
    }
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  /** The argument of an initial byte with additional information `info`. */
  argument(info: number): number {
    if (info < 24) return info;
    let size: number;
    if (info === 24) size = 1;
    else if (info === 25) size = 2;
    else if (info === 26) size = 4;
    else if (info === 27) size = 8;
    else if (info === 31) {
      throw new CborError("indefinite-length CBOR is not allowed");
    } else throw new CborError(`reserved CBOR additional information ${info}`);
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + this.byte();
    if (!Number.isSafeInteger(value)) {
      throw new CborError("a CBOR integer or length is too large");
    }
    return value;
  }
}

function item(reader: Reader, depth: number, maxDepth: number): CborValue {
  const initial = reader.byte();
  const major = initial >> 5;
  const info = initial & 31;
  switch (major) {
    case 0:
      return reader.argument(info);
    case 1: {
      const value = -1 - reader.argument(info);
      if (!Number.isSafeInteger(value)) {
        throw new CborError("a CBOR integer is too large");
      }
      return value;
    }
    case 2:
      return Uint8Array.from(reader.take(reader.argument(info)));
    case 3: {
      try {
        return decoder.decode(reader.take(reader.argument(info)));
      } catch {
        throw new CborError("a CBOR text string is not valid UTF-8");
      }
    }
    case 4:
    case 5: {
      if (depth >= maxDepth) {
        throw new CborError(`CBOR nests deeper than ${maxDepth}`);
      }
      const count = reader.argument(info);
      // Every element takes at least a byte: a count past the input is a lie.
      if (count > reader.bytes.length - reader.offset) {
        throw new CborError("a CBOR array or map is longer than the input");
      }
      if (major === 4) {
        const list: CborValue[] = [];
        for (let i = 0; i < count; i++) {
          list.push(item(reader, depth + 1, maxDepth));
        }
        return Object.freeze(list);
      }
      const map = new Map<number | string, CborValue>();
      for (let i = 0; i < count; i++) {
        const key = item(reader, depth + 1, maxDepth);
        if (typeof key !== "number" && typeof key !== "string") {
          throw new CborError("a CBOR map key must be an integer or text");
        }
        if (map.has(key)) {
          throw new CborError(
            `a CBOR map repeats the key ${JSON.stringify(key)}`,
          );
        }
        map.set(key, item(reader, depth + 1, maxDepth));
      }
      return map;
    }
    case 6:
      throw new CborError("CBOR tags are not allowed");
    default:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new CborError(
        info >= 25 && info <= 27
          ? "CBOR floats are not allowed"
          : `the CBOR simple value ${info} is not allowed`,
      );
  }
}

/**
 * Decodes one CBOR item from `bytes`. Throws {@link CborError} for
 * anything outside the subset (see the module documentation).
 */
export function decodeCbor(
  bytes: Uint8Array,
  options: DecodeOptions = {},
): Decoded {
  const reader = new Reader(bytes, options.offset ?? 0);
  const value = item(reader, 0, options.maxDepth ?? 8);
  if (!options.partial && reader.offset !== bytes.length) {
    throw new CborError("bytes follow the CBOR item");
  }
  return { value, end: reader.offset };
}

/** A value {@link encodeCbor} writes: maps may be plain objects (text keys). */
export type CborInput =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | readonly CborInput[]
  | ReadonlyMap<number | string, CborInput>
  | { readonly [key: string]: CborInput };

const encoder = new TextEncoder();

function head(major: number, value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CborError(`cannot encode ${value}`);
  }
  const top = major << 5;
  if (value < 24) return [top | value];
  const bytes: number[] = [];
  let size: number;
  let info: number;
  if (value < 0x100) [size, info] = [1, 24];
  else if (value < 0x10000) [size, info] = [2, 25];
  else if (value < 0x100000000) [size, info] = [4, 26];
  else [size, info] = [8, 27];
  let rest = value;
  for (let i = 0; i < size; i++) {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return [top | info, ...bytes];
}

function compare(a: Uint8Array, b: Uint8Array): number {
  // CTAP2 canonical order: major type, then shorter encodings, then bytes.
  if ((a[0] >> 5) !== (b[0] >> 5)) return (a[0] >> 5) - (b[0] >> 5);
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function write(value: CborInput, out: number[]): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CborError(`only safe integers encode, got ${value}`);
    }
    out.push(...(value >= 0 ? head(0, value) : head(1, -1 - value)));
  } else if (typeof value === "string") {
    const bytes = encoder.encode(value);
    out.push(...head(3, bytes.length), ...bytes);
  } else if (typeof value === "boolean") {
    out.push(value ? 0xf5 : 0xf4);
  } else if (value === null) {
    out.push(0xf6);
  } else if (value instanceof Uint8Array) {
    out.push(...head(2, value.length), ...value);
  } else if (Array.isArray(value)) {
    out.push(...head(4, value.length));
    for (const element of value) write(element, out);
  } else {
    const entries: [CborInput, CborInput][] = value instanceof Map
      ? [...value.entries()]
      : Object.entries(value);
    const encoded = entries.map(([key, element]) => {
      const keyBytes: number[] = [];
      write(key, keyBytes);
      return { key: Uint8Array.from(keyBytes), element };
    }).sort((a, b) => compare(a.key, b.key));
    out.push(...head(5, encoded.length));
    for (const { key, element } of encoded) {
      out.push(...key);
      write(element, out);
    }
  }
}

/** Encodes `value` in CTAP2 canonical CBOR. */
export function encodeCbor(value: CborInput): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  write(value, out);
  return Uint8Array.from(out);
}
