// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * JSON values and located problems.
 *
 * The JSON types are `@celld/sieve`'s. An {@link Issue} is anything with a
 * path and a message, so a sieve issue is one; the decoders that are still
 * written by hand report plain ones.
 *
 * @module
 */

export type { JsonObject, JsonPrimitive, JsonValue } from "@celld/sieve";
import type { JsonValue } from "@celld/sieve";

/** Where a problem is: object keys and array indices from the root. */
export type Path = readonly (string | number)[];

/** One problem with a request, a response, a stored value or model output. */
export interface Issue {
  /** Location of the offending value, from the root of what was checked. */
  readonly path: Path;
  /** What is wrong, in a sentence. */
  readonly message: string;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Renders a path the way code would reach it: `input[2].content[0].text`. */
export function formatPath(path: Path): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else if (IDENTIFIER.test(part)) out += out === "" ? part : `.${part}`;
    else out += `[${JSON.stringify(part)}]`;
  }
  return out === "" ? "(root)" : out;
}

/** Renders issues on one line, for error messages. */
export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
    .join("; ");
}

/** True for `{}` literals and `Object.create(null)`, false for class instances. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A short description of a value's type, for messages. */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") {
    const name = (value as { constructor?: { name?: unknown } }).constructor
      ?.name;
    return typeof name === "string" && name !== "Object"
      ? `a ${name}`
      : "an object";
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  return `a ${typeof value}`;
}

/** Parses JSON, returning `undefined` instead of throwing. */
export function tryParseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Lowercase hex SHA-256 of UTF-8 text. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
