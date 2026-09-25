// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks on the values typed methods put on a command line.
 *
 * Where the docs state a rule (comment at most 200 bytes, setup script at
 * most 10 KiB, `--cpus` even from 4 to 512, `--limit` 1 to 100, YYYY-MM
 * months), it is enforced exactly. Where they do not (VM, tag and
 * integration name syntax), the checks are conservative: VM names are DNS
 * labels because each becomes `<name>.exe.xyz`, and tags and names may not
 * contain whitespace or commas (the CLI splits `--tag` and `--integration`
 * on commas) or start with `-`. The server remains the judge; these only
 * catch what cannot be right before a request is spent on it.
 *
 * @module
 */

import { isDate, isYearMonth } from "@celld/isotime";
import { type AnySchema, type Output, v } from "@celld/sieve";
import { issuesFrom } from "./decode.ts";
import { ExeInvalidRequestError } from "./errors.ts";
import type { Issue, Path } from "./json.ts";

/** Collects issues and throws them together. */
export class Checks {
  readonly issues: Issue[] = [];

  add(path: Path, message: string): void {
    this.issues.push({ path, message });
  }

  /**
   * Parses `value` with a sieve schema and adds its issues under `path`.
   * With `message`, a failure is that one issue at `path` instead. Returns
   * the parsed value, or undefined when it failed.
   */
  schema<S extends AnySchema>(
    schema: S,
    path: Path,
    value: unknown,
    message?: string,
  ): Output<S> | undefined {
    const result = schema.safeParse(value);
    if (result.success) return result.data as Output<S>;
    if (message !== undefined) {
      this.add(path, message);
    } else {
      this.issues.push(...issuesFrom(result.error.issues, path));
    }
    return undefined;
  }

  /** Throws {@link ExeInvalidRequestError} when anything was added. */
  done(): void {
    if (this.issues.length > 0) throw new ExeInvalidRequestError(this.issues);
  }
}

const VM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORD = /^[^\s,-][^\s,]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const SIZE = /^\d+(?:\.\d+)?(?:[KMGT]i?B?)?$/i;
const DURATION = /^(?:\d+(?:ms|s|m|h|d|w|y))+$/;
const REGION = /^[a-z]{3}$/;

const VM_NAME_MESSAGE =
  "must be a VM name: 1-63 lowercase letters, digits and hyphens, not starting or ending with a hyphen";
const SIZE_MESSAGE = "must be a size such as 8, 8G, 8GB or 512M";

/** A VM name: a lowercase DNS label of 1 to 63 characters. */
export const VmName = v.string(VM_NAME_MESSAGE).regex(VM_NAME, VM_NAME_MESSAGE)
  .meta({ id: "VmName" });

/**
 * A tag, integration, key or pool name: no whitespace or commas (the CLI
 * splits lists on commas), and no leading `-` (it would read as a flag).
 * `what` names it in the message.
 */
export function word(what = "value") {
  const message =
    `must be a ${what} without whitespace or commas, not starting with '-'`;
  return v.string(message).regex(WORD, message);
}

/** {@link word}, named for JSON Schema. */
export const Word = word().meta({ id: "Word" });

/** A size such as `8`, `8G`, `8GB`, `16GiB`, `512M`, as the CLI takes them. */
export const Size = v.union([
  v.number(SIZE_MESSAGE).positive(SIZE_MESSAGE),
  v.string(SIZE_MESSAGE).regex(SIZE, SIZE_MESSAGE),
]).meta({ id: "Size" });

/** A month as `YYYY-MM`. */
export const Month = v.string("must be a month as YYYY-MM").refine(
  isYearMonth,
  "must be a month as YYYY-MM",
).meta({ id: "Month" });

/** A TCP port, 1 to 65535. */
export const Port = v.int("must be a whole number from 1 to 65535")
  .min(1, "must be a whole number from 1 to 65535")
  .max(65535, "must be a whole number from 1 to 65535")
  .meta({ id: "Port" });

/**
 * A region code: three lowercase letters, such as `lax`. {@link REGIONS}
 * lists the documented ones; others are left to the server.
 */
export const Region = v.string("must be a region code such as lax or fra")
  .regex(REGION, "must be a region code such as lax or fra")
  .meta({ id: "Region" });

function urlWithScheme(value: string, schemes: readonly string[]): boolean {
  try {
    return schemes.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function urlMessage(schemes: readonly string[]): string {
  return `must be a ${schemes.map((s) => s.slice(0, -1)).join(" or ")} URL`;
}

/** An absolute `https:` URL. */
export const HttpsUrl = v.string(urlMessage(["https:"])).refine(
  (value) => urlWithScheme(value, ["https:"]),
  urlMessage(["https:"]),
).meta({ id: "HttpsUrl" });

/** Checks a VM name: a lowercase DNS label of 1 to 63 characters. */
export function checkVmName(checks: Checks, path: Path, name: unknown): void {
  checks.schema(VmName, path, name);
}

/** Checks a tag, integration or key name: no whitespace or commas, no leading `-`. */
export function checkWord(
  checks: Checks,
  path: Path,
  value: unknown,
  what = "value",
): void {
  checks.schema(word(what), path, value);
}

/** Checks a list of words. */
export function checkWords(
  checks: Checks,
  path: Path,
  values: readonly unknown[] | undefined,
  what: string,
): void {
  values?.forEach((value, index) =>
    checkWord(checks, [...path, index], value, what)
  );
}

/** Checks an email address (loosely: something@something). */
export function checkEmail(checks: Checks, path: Path, value: unknown): void {
  if (
    typeof value !== "string" || !EMAIL.test(value) || value.startsWith("-")
  ) {
    checks.add(path, "must be an email address");
  }
}

/** A size such as `8`, `8G`, `8GB`, `16GiB`, `512M`, as the CLI takes them. */
export type Size = number | string;

/** Checks and renders a size. */
export function sizeText(checks: Checks, path: Path, value: Size): string {
  checks.schema(Size, path, value, SIZE_MESSAGE);
  return typeof value === "number" ? String(value) : value;
}

/**
 * A size in GB (1024 MB, or 1024 GB per TB; the units' `i` and `B` are
 * ignored), for comparing sizes; undefined when unreadable.
 */
export function sizeInGb(value: Size | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const match = /^(\d+(?:\.\d+)?)([KMGT])?i?B?$/i.exec(text);
  if (match === null) return undefined;
  const number = Number(match[1]);
  switch ((match[2] ?? "G").toUpperCase()) {
    case "K":
      return number / 1024 / 1024;
    case "M":
      return number / 1024;
    case "T":
      return number * 1024;
    default:
      return number;
  }
}

/** Checks a whole number in a range. */
export function checkInteger(
  checks: Checks,
  path: Path,
  value: unknown,
  low: number,
  high = Number.MAX_SAFE_INTEGER,
): void {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < low ||
    value > high
  ) {
    checks.add(
      path,
      `must be a whole number from ${low}${
        high === Number.MAX_SAFE_INTEGER ? "" : ` to ${high}`
      }`,
    );
  }
}

/** Checks a duration such as `30d`, `2h`, `45m`, `1y`. */
export function checkDuration(
  checks: Checks,
  path: Path,
  value: unknown,
): void {
  if (typeof value !== "string" || !DURATION.test(value)) {
    checks.add(path, "must be a duration such as 45m, 2h, 30d or 1y");
  }
}

/** Checks a `YYYY-MM-DD` date, strictly: `2026-02-30` is refused. */
export function checkDate(checks: Checks, path: Path, value: unknown): void {
  if (typeof value !== "string" || !isDate(value)) {
    checks.add(path, "must be a date as YYYY-MM-DD");
  }
}

/** Checks a YYYY-MM month. */
export function checkMonth(checks: Checks, path: Path, value: unknown): void {
  checks.schema(Month, path, value);
}

/** Checks that `value` is one of `choices`. */
export function checkChoice<T extends string>(
  checks: Checks,
  path: Path,
  value: unknown,
  choices: readonly T[],
): value is T {
  if (
    typeof value !== "string" || !(choices as readonly string[]).includes(value)
  ) {
    checks.add(path, `must be one of ${choices.join(", ")}`);
    return false;
  }
  return true;
}

/** Checks text's UTF-8 length. */
export function checkBytes(
  checks: Checks,
  path: Path,
  value: string,
  max: number,
): void {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > max) checks.add(path, `is ${bytes} bytes; at most ${max}`);
}

/** Checks a TCP port. */
export function checkPort(checks: Checks, path: Path, value: unknown): void {
  checks.schema(Port, path, value, "must be a whole number from 1 to 65535");
}

/** Checks an https URL, or a URL with one of `schemes`. */
export function checkUrl(
  checks: Checks,
  path: Path,
  value: unknown,
  schemes: readonly string[] = ["https:"],
): void {
  if (typeof value !== "string" || !urlWithScheme(value, schemes)) {
    checks.add(path, urlMessage(schemes));
  }
}

/** The regions the docs list, as the CLI spells their codes. */
export const REGIONS = Object.freeze(
  {
    pdx: "Oregon, USA",
    lax: "Los Angeles, USA",
    nyc: "New York, USA",
    dal: "Dallas, USA",
    fra: "Frankfurt, Germany",
    tyo: "Tokyo, Japan",
    syd: "Sydney, Australia",
    sgp: "Singapore",
    lon: "London, UK",
  } as const,
);

/** A documented region code. */
export type RegionCode = keyof typeof REGIONS;
