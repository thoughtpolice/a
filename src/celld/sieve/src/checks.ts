// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The interpreter for built-in checks: lengths, bounds, patterns, string
 * formats and string rewrites. Each check is plain data in a def (see
 * `def.ts`); this module is what gives it meaning. Refinements, which call
 * user code and may be async, run in `schema.ts`.
 *
 * @module
 */

import { isCidrV4, isCidrV6, isIpv4, isIpv6 } from "@celld/ip";
import { isDate, isDateTime, isDuration, isTime } from "@celld/isotime";
import { isJwt } from "@celld/jwt";
import { isUlid } from "@celld/ulid";
import type { Check, FormatCheck } from "./def.ts";
import { type Issue, makeIssue, type Path, type SizeOrigin } from "./errors.ts";

/** The value a parse is building, and what is wrong with it so far. */
export interface Payload {
  value: unknown;
  issues: Issue[];
  /** The value is not of the schema's type, so its checks were skipped. */
  aborted: boolean;
}

function originOf(value: unknown): SizeOrigin {
  if (typeof value === "string") return "string";
  if (typeof value === "bigint") return "bigint";
  if (typeof value === "number") return "number";
  return value instanceof Uint8Array ? "bytes" : "array";
}

/**
 * Runs one built-in check against `payload.value`, adding issues to
 * `payload.issues`; rewrites replace `payload.value`.
 */
export function runBuiltinCheck(
  check: Exclude<Check, { check: "refine" | "custom" }>,
  payload: Payload,
  path: Path,
): void {
  const value = payload.value;
  const fail = (fields: Parameters<typeof makeIssue>[1]) =>
    payload.issues.push(makeIssue(path, fields, check.message));
  switch (check.check) {
    case "min_length":
    case "max_length":
    case "length": {
      const length = (value as { length: number }).length;
      const origin = originOf(value);
      const exact = check.check === "length" ? { exact: true as const } : {};
      if (check.check !== "max_length" && length < check.value) {
        fail({
          code: "too_small",
          origin,
          minimum: check.value,
          inclusive: true,
          ...exact,
        });
      }
      if (check.check !== "min_length" && length > check.value) {
        fail({
          code: "too_big",
          origin,
          maximum: check.value,
          inclusive: true,
          ...exact,
        });
      }
      return;
    }
    case "regex":
      check.pattern.lastIndex = 0;
      if (!check.pattern.test(value as string)) {
        fail({
          code: "invalid_format",
          format: "regex",
          pattern: String(check.pattern),
        });
      }
      return;
    case "starts_with":
      if (!(value as string).startsWith(check.value)) {
        fail({
          code: "invalid_format",
          format: "starts_with",
          prefix: check.value,
        });
      }
      return;
    case "ends_with":
      if (!(value as string).endsWith(check.value)) {
        fail({
          code: "invalid_format",
          format: "ends_with",
          suffix: check.value,
        });
      }
      return;
    case "includes":
      if (!(value as string).includes(check.value)) {
        fail({
          code: "invalid_format",
          format: "includes",
          includes: check.value,
        });
      }
      return;
    case "format":
      if (!hasFormat(check, value as string)) {
        fail({ code: "invalid_format", format: check.format });
      }
      return;
    case "trim":
      payload.value = (value as string).trim();
      return;
    case "to_lower_case":
      payload.value = (value as string).toLowerCase();
      return;
    case "to_upper_case":
      payload.value = (value as string).toUpperCase();
      return;
    case "min":
    case "max": {
      const n = value as number | bigint;
      const bound = check.value;
      const origin = originOf(value);
      if (check.check === "min") {
        if (check.inclusive ? n < bound : n <= bound) {
          fail({
            code: "too_small",
            origin,
            minimum: bound,
            inclusive: check.inclusive,
          });
        }
      } else if (check.inclusive ? n > bound : n >= bound) {
        fail({
          code: "too_big",
          origin,
          maximum: bound,
          inclusive: check.inclusive,
        });
      }
      return;
    }
    case "multiple_of":
      if (!isMultipleOf(value as number, check.value)) {
        fail({ code: "not_multiple_of", divisor: check.value });
      }
      return;
    case "int":
      if (!Number.isSafeInteger(value)) {
        fail({ code: "invalid_type", expected: "int", received: "number" });
      }
      return;
  }
}

function decimals(n: number): number {
  const [mantissa, exponent] = String(n).split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  return Math.max(0, fraction - Number(exponent ?? 0));
}

/** `value % step === 0`, exact for decimal steps such as `0.1`. */
export function isMultipleOf(value: number, step: number): boolean {
  const scale = 10 ** Math.max(decimals(value), decimals(step));
  return Math.round(value * scale) % Math.round(step * scale) === 0;
}

/**
 * Local part: no leading, trailing or doubled dot. Domain: dot-separated
 * labels of letters, digits and inner hyphens, ending in a 2+ letter TLD.
 */
const EMAIL =
  /^(?!\.)(?!.*\.\.)[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+(?<!\.)@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

/** RFC 9562 versions 1-8 (with the variant bits), plus the nil and max UUIDs. */
const UUID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Unpadded; a length of 1 mod 4 cannot come from any bytes. */
export const BASE64URL = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;

/** Any number of hex digits. */
export const HEX = /^[0-9a-fA-F]*$/;

function isUrl(text: string): boolean {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `text` has `check`'s format. Date and time formats come from
 * `@celld/isotime`, addresses and blocks from `@celld/ip`, `ulid` from
 * `@celld/ulid` and `jwt` from `@celld/jwt`, so sieve accepts exactly what
 * those libraries parse.
 */
function hasFormat(check: FormatCheck, text: string): boolean {
  switch (check.format) {
    case "email":
      return EMAIL.test(text);
    case "url":
      return isUrl(text);
    case "uuid":
      return UUID.test(text);
    case "date":
      return isDate(text);
    case "datetime":
      return isDateTime(text, check);
    case "time":
      return isTime(text, { precision: check.precision });
    case "duration":
      return isDuration(text);
    case "base64":
      return BASE64.test(text);
    case "base64url":
      return BASE64URL.test(text);
    case "hex":
      return HEX.test(text);
    case "ipv4":
      return isIpv4(text);
    case "ipv6":
      return isIpv6(text);
    case "cidrv4":
      return isCidrV4(text);
    case "cidrv6":
      return isCidrV6(text);
    case "ulid":
      return isUlid(text);
    case "jwt":
      return isJwt(text, { alg: check.alg });
  }
}
