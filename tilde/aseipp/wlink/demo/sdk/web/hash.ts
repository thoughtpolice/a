// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** The 64-bit FNV-1a the SDK's hosts hash frames and audio with. */

const OFFSET_LO = 0x84222325;
const OFFSET_HI = 0xcbf29ce4;

/**
 * A 64-bit FNV-1a kept as two 32-bit halves.
 *
 * JavaScript has no 64-bit integer other than `bigint`, whose allocation per
 * operation costs more than the rest of a frame. The prime is 2^40 + 0x1b3, so
 * multiplying by it touches only two limbs: the low half is an exact product
 * below 2^53, and the high half takes that product's carry plus the two
 * cross terms.
 */
export class Fnv1a {
  private lo = OFFSET_LO;
  private hi = OFFSET_HI;

  update(bytes: Uint8Array): void {
    let { lo, hi } = this;
    for (let i = 0; i < bytes.length; i++) {
      // `^` yields a signed 32-bit result, and the low half must stay
      // unsigned for the exact product below to be a positive double.
      lo = (lo ^ bytes[i]) >>> 0;
      const full = lo * 0x1b3;
      hi = (Math.imul(hi, 0x1b3) + Math.imul(lo, 0x100) + Math.floor(full / 0x100000000)) >>> 0;
      lo = full >>> 0;
    }
    this.lo = lo;
    this.hi = hi;
  }

  byte(value: number): void {
    let lo = (this.lo ^ (value & 0xff)) >>> 0;
    const full = lo * 0x1b3;
    this.hi = (Math.imul(this.hi, 0x1b3) + Math.imul(lo, 0x100) +
      Math.floor(full / 0x100000000)) >>> 0;
    lo = full >>> 0;
    this.lo = lo;
  }

  hex(): string {
    return hex(this.hi, this.lo);
  }
}

/** The 16 hexadecimal digits of a value held as two 32-bit halves. */
export function hex(high: number, low: number): string {
  return (high >>> 0).toString(16).padStart(8, "0") +
    (low >>> 0).toString(16).padStart(8, "0");
}

/** The hash of a byte string, for callers with nothing to accumulate. */
export function fnv1a(bytes: Uint8Array): string {
  const hash = new Fnv1a();
  hash.update(bytes);
  return hash.hex();
}
