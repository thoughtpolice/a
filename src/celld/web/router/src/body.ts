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

import { BoundsError, readBounded } from "@celld/core/bounds";
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
   * How long a request may take before the router answers 504 (the
   * outcome is unknown: it may still take effect) and aborts `c.signal`;
   * `false` for none of its own, which still ends at `maxTimeout`.
   * Default 30 seconds. It covers the time until the handler returns its
   * response: a streamed body is not cut off. Stopping the work is
   * cooperative: the router's body readers stop, and the router does not
   * start a later stage (authorization, validation, `use`, the handler)
   * once the budget is spent, but code that ignores `c.signal` runs on
   * after the 504, its result discarded.
   */
  readonly timeout: Duration | false;
  /**
   * The longest `timeout` this router or any route it serves may set,
   * and the budget of a `timeout: false`. Default 5 minutes; at most
   * 2^31 - 1 ms (about 24.8 days), the longest delay a timer takes.
   * Router-wide only.
   */
  readonly maxTimeout: Duration;
  /** Longest request URL, in bytes (414 above it). Default 16 KiB. */
  readonly maxUrlBytes: number;
  /** Longest query string, in bytes, without the `?` (414). Default 8 KiB. */
  readonly maxQueryBytes: number;
  /**
   * Most query fields (non-empty `&`-separated pieces) (400
   * `too_many_query_fields`). Default 256.
   */
  readonly maxQueryFields: number;
}

/**
 * The defaults: 1 MiB bodies, 32 KiB headers, depth 32, 1000 keys, 30 s
 * (and at most 5 minutes for any route),
 * 16 KiB URLs, 8 KiB queries with at most 256 fields.
 */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  body: 1024 * 1024,
  headers: 32 * 1024,
  jsonDepth: 32,
  jsonKeys: 1000,
  timeout: 30,
  maxTimeout: 300,
  maxUrlBytes: 16 * 1024,
  maxQueryBytes: 8 * 1024,
  maxQueryFields: 256,
});

/**
 * Refuses a request URL over the URL, query or query-field limits. This
 * runs before routing, and costs one scan of at most `maxQueryBytes`, so
 * nothing parses an oversized query.
 */
export function checkUrl(url: string, limits: Limits): void {
  // A serialized URL is ASCII (anything else is percent-encoded), so its
  // length is its size in bytes.
  if (url.length > limits.maxUrlBytes) {
    throw new HttpError(
      414,
      `the URL is longer than ${limits.maxUrlBytes} bytes`,
    );
  }
  const mark = url.indexOf("?");
  if (mark === -1) return;
  const hash = url.indexOf("#", mark);
  const end = hash === -1 ? url.length : hash;
  if (end - mark - 1 > limits.maxQueryBytes) {
    throw new HttpError(
      414,
      `the query is longer than ${limits.maxQueryBytes} bytes`,
    );
  }
  let fields = 0;
  let empty = true;
  for (let i = mark + 1; i <= end; i++) {
    if (i === end || url.charCodeAt(i) === 0x26) {
      if (!empty && ++fields > limits.maxQueryFields) {
        throw new HttpError(
          400,
          `the query has more than ${limits.maxQueryFields} fields`,
          { code: "too_many_query_fields" },
        );
      }
      empty = true;
    } else {
      empty = false;
    }
  }
}

/** The total bytes of a request's header names and values, as sent. */
export function headerBytes(headers: Headers): number {
  let total = 0;
  headers.forEach((value, name) => {
    total += name.length + value.length + 4;
  });
  return total;
}

/** A 413 for a body over `limit`. */
export function tooLarge(limit: number): HttpError {
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

/**
 * The body's bytes, refusing (413) more than `limit` whatever
 * `Content-Length` said, chunked bodies included. When `signal` aborts the
 * read stops, the body is cancelled, and this rejects with its reason.
 */
export async function readBytes(
  request: Request,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  checkContentLength(request, limit);
  try {
    return await readBounded(request, {
      maxBytes: limit,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (!(error instanceof BoundsError)) throw error;
    if (error.code === "too_large") throw tooLarge(limit);
    throw new Error("the request body was already read", { cause: error });
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** `bytes` as UTF-8 text; 400 for bytes that are not UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string {
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

/** JSON `text` parsed under the depth and key limits; 400 otherwise. */
export function parseJsonText(text: string, limits: Limits): unknown {
  scanJson(text, limits.jsonDepth, limits.jsonKeys);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the body is not valid JSON", {
      code: "invalid_json",
    });
  }
}

/** Whether the body is an `application/x-www-form-urlencoded` form. */
export function isForm(request: Request): boolean {
  return mediaType(request) === "application/x-www-form-urlencoded";
}

/** 415 unless the body is an urlencoded form. */
export function requireForm(request: Request): void {
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
}

/**
 * Urlencoded form `text` as an object, at most `limits.jsonKeys` fields
 * (400 above): a field sent once is a string, one sent more than once a
 * list (see {@link toRecord}).
 */
export function parseFormText(
  text: string,
  limits: Limits,
  arrays: ReadonlySet<string> = new Set(),
): Record<string, string | string[]> {
  const params = new URLSearchParams(text);
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
  // One pass: each name's values gather in its list as they come.
  const lists = new Map<string, string[]>();
  for (const [name, value] of params) {
    const list = lists.get(name);
    if (list === undefined) lists.set(name, [value]);
    else list.push(value);
  }
  const out: Record<string, string | string[]> = Object.create(null);
  for (const [name, values] of lists) {
    out[name] = values.length === 1 && !arrays.has(name) ? values[0] : values;
  }
  return out;
}
