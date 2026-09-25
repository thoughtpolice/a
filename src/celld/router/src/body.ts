// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Request limits and body reading: the size limit (checked on
 * `Content-Length` before reading and again while reading), media types,
 * and a scan of JSON text that refuses deep nesting and huge objects
 * before `JSON.parse` sees it.
 *
 * @module
 */

import type { Duration } from "./duration.ts";
import { HttpError } from "./errors.ts";

/** What a request may cost. Every field has a default; see {@link DEFAULT_LIMITS}. */
export interface Limits {
  /** Largest body in bytes (413 above it). Default 1 MiB. */
  readonly body: number;
  /** Largest total size of the request's header names and values (431). Default 32 KiB. */
  readonly headers: number;
  /** Deepest nesting of arrays and objects in a JSON body (400). Default 32. */
  readonly jsonDepth: number;
  /** Most object members (and form fields) in a body (400). Default 1000. */
  readonly jsonKeys: number;
  /**
   * How long a request may take before the router answers 503 and aborts
   * `c.signal`; `false` for no limit. Default 30 seconds. It covers the
   * time until the handler returns its response: a streamed body is not
   * cut off.
   */
  readonly timeout: Duration | false;
}

/** The defaults: 1 MiB bodies, 32 KiB headers, depth 32, 1000 keys, 30 s. */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  body: 1024 * 1024,
  headers: 32 * 1024,
  jsonDepth: 32,
  jsonKeys: 1000,
  timeout: 30,
});

/** The total bytes of a request's header names and values, as sent. */
export function headerBytes(headers: Headers): number {
  let total = 0;
  headers.forEach((value, name) => {
    total += name.length + value.length + 4;
  });
  return total;
}

/** A 413 for a body over `limit`. */
function tooLarge(limit: number): HttpError {
  return new HttpError(413, `the body is larger than ${limit} bytes`);
}

/** Refuses a declared `Content-Length` over `limit` without reading anything. */
export function checkContentLength(request: Request, limit: number): void {
  const declared = request.headers.get("content-length");
  if (declared === null) return;
  const size = Number(declared);
  if (!/^\d+$/.test(declared.trim()) || !Number.isSafeInteger(size)) {
    throw new HttpError(400, "the Content-Length is not a number");
  }
  if (size > limit) throw tooLarge(limit);
}

/** The body's bytes, refusing (413) more than `limit` whatever `Content-Length` said. */
export async function readBytes(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  checkContentLength(request, limit);
  if (request.body === null) return new Uint8Array();
  if (request.bodyUsed) throw new Error("the request body was already read");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge(limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The body as UTF-8 text; 400 for bytes that are not UTF-8. */
export async function readText(
  request: Request,
  limit: number,
): Promise<string> {
  const bytes = await readBytes(request, limit);
  try {
    return decoder.decode(bytes);
  } catch {
    throw new HttpError(400, "the body is not UTF-8");
  }
}

/** The media type of `Content-Type`, lower case without parameters; null when absent. */
export function mediaType(request: Request): string | null {
  const header = request.headers.get("content-type");
  if (header === null) return null;
  return header.split(";")[0].trim().toLowerCase();
}

/** Whether `type` is JSON: `application/json` or any `application/*+json`. */
export function isJsonType(type: string | null): boolean {
  return type === "application/json" ||
    (type !== null && type.startsWith("application/") &&
      type.endsWith("+json"));
}

/** 415 unless the body is JSON. */
export function requireJson(request: Request): void {
  const type = mediaType(request);
  if (!isJsonType(type)) {
    throw new HttpError(
      415,
      `expected an application/json body, got ${type ?? "no Content-Type"}`,
      { headers: { "accept-post": "application/json" } },
    );
  }
}

/**
 * Throws a 400 when JSON `text` nests deeper than `maxDepth` or has more
 * than `maxKeys` object members, counting outside strings only. This runs
 * before `JSON.parse`, so a hostile document costs one linear scan.
 */
export function scanJson(
  text: string,
  maxDepth: number,
  maxKeys: number,
): void {
  let depth = 0;
  let keys = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    if (inString) {
      if (char === 0x5c) i++;
      else if (char === 0x22) inString = false;
      continue;
    }
    if (char === 0x22) inString = true;
    else if (char === 0x7b || char === 0x5b) {
      if (++depth > maxDepth) {
        throw new HttpError(
          400,
          `the JSON body nests deeper than ${maxDepth}`,
          {
            code: "json_too_deep",
          },
        );
      }
    } else if (char === 0x7d || char === 0x5d) depth--;
    else if (char === 0x3a && ++keys > maxKeys) {
      throw new HttpError(400, `the JSON body has more than ${maxKeys} keys`, {
        code: "json_too_many_keys",
      });
    }
  }
}

/** The body parsed as JSON under the limits; 415, 413 and 400 as they apply. */
export async function readJson(
  request: Request,
  limits: Limits,
): Promise<unknown> {
  requireJson(request);
  const text = await readText(request, limits.body);
  scanJson(text, limits.jsonDepth, limits.jsonKeys);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the body is not valid JSON", {
      code: "invalid_json",
    });
  }
}

/**
 * An `application/x-www-form-urlencoded` body as an object: a field sent
 * once is a string, one sent more than once a list (see {@link toRecord}).
 */
export async function readForm(
  request: Request,
  limits: Limits,
  arrays: ReadonlySet<string> = new Set(),
): Promise<Record<string, string | string[]>> {
  const type = mediaType(request);
  if (type !== "application/x-www-form-urlencoded") {
    throw new HttpError(
      415,
      `expected an application/x-www-form-urlencoded body, got ${
        type ?? "no Content-Type"
      }`,
      { headers: { "accept-post": "application/x-www-form-urlencoded" } },
    );
  }
  const params = new URLSearchParams(await readText(request, limits.body));
  let count = 0;
  for (const _ of params.keys()) {
    if (++count > limits.jsonKeys) {
      throw new HttpError(
        400,
        `the form has more than ${limits.jsonKeys} fields`,
        {
          code: "form_too_many_fields",
        },
      );
    }
  }
  return toRecord(params, arrays);
}

/**
 * Search or form parameters as an object. A name sent once is a string and
 * one sent more than once is a list, so a schema expecting a string
 * refuses a repeated parameter instead of silently taking one of them;
 * names in `arrays` are always lists.
 */
export function toRecord(
  params: URLSearchParams,
  arrays: ReadonlySet<string> = new Set(),
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    out[name] = values.length === 1 && !arrays.has(name) ? values[0] : values;
  }
  return out;
}
