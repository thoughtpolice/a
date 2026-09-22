// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The entry codec WormLog and WormPaxos share: what one register holds.
 *
 * A register value is one tag byte and what follows it:
 *
 *   - `0x00` then the payload: an entry carrying bytes (a log record, or a
 *     WormPaxos command), which may be empty;
 *   - `0x01` and nothing else: a filled hole, written by whoever closes a slot
 *     that nobody will ever write.
 *
 * Anything else (an empty register, an unknown tag, a hole with trailing
 * bytes) is not an entry. Only the holder of a segment's capture can write
 * there, so a well-behaved chain never holds one; a reader reports it rather
 * than guessing.
 *
 * @module
 */

import { type Invalid, LIMITS, type TooLarge } from "@wormspace/segment/types";

export const TAG_VALUE = 0x00;
export const TAG_HOLE = 0x01;

/** The largest payload an entry can carry: a register, less the tag. */
export const MAX_PAYLOAD_BYTES = LIMITS.valueBytes - 1;

export type Entry =
  | { kind: "value"; value: Uint8Array }
  | { kind: "hole" };

/** The one encoding of a filled hole. */
export function holeBytes(): Uint8Array {
  return new Uint8Array([TAG_HOLE]);
}

/** Tags a payload, refusing one that would not fit in a register. */
export function encodeValue(
  value: Uint8Array,
): { ok: true; bytes: Uint8Array } | Invalid | TooLarge {
  if (!(value instanceof Uint8Array)) {
    return { ok: false, code: "INVALID", message: "value must be bytes" };
  }
  if (value.byteLength > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      code: "TOO_LARGE",
      message:
        `value of ${value.byteLength} bytes exceeds ${MAX_PAYLOAD_BYTES}`,
    };
  }
  const bytes = new Uint8Array(value.byteLength + 1);
  bytes[0] = TAG_VALUE;
  bytes.set(value, 1);
  return { ok: true, bytes };
}

/** Reads a register value back; the payload is a copy, never a view. */
export function decodeEntry(
  bytes: Uint8Array,
): { ok: true; entry: Entry } | Invalid {
  if (bytes.byteLength === 0) {
    return { ok: false, code: "INVALID", message: "an entry has a tag byte" };
  }
  switch (bytes[0]) {
    case TAG_VALUE:
      return {
        ok: true,
        entry: { kind: "value", value: bytes.slice(1) },
      };
    case TAG_HOLE:
      if (bytes.byteLength !== 1) {
        return {
          ok: false,
          code: "INVALID",
          message: "a hole entry carries no payload",
        };
      }
      return { ok: true, entry: { kind: "hole" } };
    default:
      return {
        ok: false,
        code: "INVALID",
        message: `unknown entry tag 0x${bytes[0].toString(16)}`,
      };
  }
}
