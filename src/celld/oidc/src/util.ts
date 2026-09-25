// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Small pieces the subpaths share: JSON and redirect responses, reading
 * JSON documents and JWTs over `fetch`, and the default clock and fetch.
 *
 * @module
 */

import { JwtError } from "@celld/jwt";
import type { Clock, FetchLike } from "@celld/oauth";

/**
 * Rethrows `cause` when it is `@celld/jwt`'s `runtime_unsupported`: the
 * runtime cannot check the signature at all (celld 0.5.1 and Ed25519),
 * which is the server's misconfiguration, not a bad token, so it must not
 * be reported as one.
 */
export function rethrowRuntimeUnsupported(cause: unknown): void {
  if (cause instanceof JwtError && cause.code === "runtime_unsupported") {
    throw cause;
  }
}

/** `Date.now`, looked up when called. */
export const defaultClock: Clock = () => Date.now();

/** The global `fetch`, looked up when called so tests can replace it. */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** Headers for responses that carry credentials or personal data. */
export const NO_STORE: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  pragma: "no-cache",
};

/** A JSON response. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: HeadersInit = {},
): Response {
  const out = new Headers(headers);
  out.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: out });
}

/** A plain-text response that is never cached. */
export function textResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
  });
}

/** A 303 to `location` that is never cached. */
export function redirectResponse(
  location: string,
  headers: HeadersInit = {},
): Response {
  const out = new Headers(headers);
  out.set("location", location);
  for (const [name, value] of Object.entries(NO_STORE)) out.set(name, value);
  return new Response(null, { status: 303, headers: out });
}

/** Whether `value` is a JSON object (not an array or null). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Epoch seconds, rounded down. */
export function epochSeconds(now: Clock): number {
  return Math.floor(now() / 1000);
}

/** Whether `value` is an array of strings. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

/** The values of `aud`, a string or a list. */
export function audiences(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return isStringArray(value) ? value : [];
}

/** A GET's body as text, with its status and content type; throws on network errors. */
export async function fetchText(
  url: string,
  fetch: FetchLike,
  accept: string,
  signal?: AbortSignal,
): Promise<{ status: number; type: string; text: string }> {
  const response = await fetch(url, {
    headers: { accept },
    redirect: "error",
    signal,
  });
  return {
    status: response.status,
    type: (response.headers.get("content-type") ?? "").toLowerCase(),
    text: await response.text(),
  };
}

/** Whether a media type (from a `Content-Type`) is `expected`, ignoring parameters and case. */
export function isMediaType(type: string, expected: string): boolean {
  return type.split(";")[0].trim().toLowerCase() === expected;
}
