// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * JSON plumbing shared by the server and client: located problems, a
 * canonical encoding for digests, and base64 in both alphabets (base64url
 * is `@celld/jwt`'s).
 *
 * @module
 */

import {
  fromBase64Url as jwtFromBase64Url,
  toBase64Url as jwtToBase64Url,
} from "@celld/jwt";

/** Where a problem is: object keys and array indices from the root. */
export type Path = readonly (string | number)[];

/** One located problem with a message, schema or value. */
export interface Issue {
  /** Location of the offending value, from the root of what was checked. */
  readonly path: Path;
  /** What is wrong, in a sentence. */
  readonly message: string;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Renders a path the way code would reach it: `params.arguments[2].name`. */
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

/** True for `{}` literals and `Object.create(null)`, false for class instances and arrays. */
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
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  return `a ${typeof value}`;
}

/**
 * JSON with object keys sorted at every level, so equal values encode
 * equally. Used for digests and cache keys, never for the wire.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined)
      .sort();
    return `{${
      keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Standard base64 of bytes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Bytes of standard base64; throws on anything else. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error("not canonical base64");
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Unpadded base64url of bytes (`@celld/jwt`'s). */
export function toBase64Url(bytes: Uint8Array): string {
  return jwtToBase64Url(bytes);
}

/** Bytes of unpadded base64url; throws on anything else. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const bytes = jwtFromBase64Url(text);
  if (bytes === null) throw new Error("not base64url");
  return bytes;
}

/** Unpadded base64url SHA-256 of UTF-8 text. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return toBase64Url(new Uint8Array(digest));
}
