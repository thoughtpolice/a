// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Errors from the Cloudflare API.
 *
 * The v4 API answers failures with its envelope (`success: false` and
 * `errors`, each with a numeric `code`); everything else (a status without
 * an envelope, the network, a timeout, a body too large) has its `kind`.
 *
 * @module
 */

/** Where a failure came from. */
export type CloudflareErrorKind =
  /** Cloudflare refused the request; see `errors` and their `code`s. */
  | "api"
  /** An HTTP status without an envelope (a proxy in the way, say). */
  | "http"
  /** 429: too many requests; `retryAfterMs` says how long, when it did. */
  | "rate-limited"
  /** The response was larger than `maxResponseBytes`. */
  | "too-large"
  /** No response in time; a write may have happened. */
  | "timeout"
  /** The connection failed; a write may have happened. */
  | "network"
  /** A response that is not what the endpoint sends. */
  | "response";

/** One entry of an envelope's `errors` or `messages`. */
export interface ApiMessage {
  readonly code: number;
  readonly message: string;
  readonly documentation_url?: string;
  /** The request field it is about, such as `{ pointer: "/name" }`. */
  readonly source?: { readonly pointer?: string };
  /**
   * The causes, outermost first: a malformed `Authorization` header is
   * 6003 with 6111 in its chain.
   */
  readonly error_chain?: readonly ApiMessage[];
}

/** A failed request. */
export class CloudflareError extends Error {
  override readonly name = "CloudflareError";
  readonly kind: CloudflareErrorKind;
  /** The HTTP status, when there was a response. */
  readonly status?: number;
  /** The envelope's `errors`, when it had any. */
  readonly errors: readonly ApiMessage[];
  /** The `cf-ray` of the response, for Cloudflare's support. */
  readonly rayId?: string;
  /** How long a 429 asked to wait, when it said. */
  readonly retryAfterMs?: number;
  /**
   * The error response's JSON, when it had some (URL Scanner's errors are
   * not envelopes, and carry the scan's `task`).
   */
  readonly body?: unknown;

  constructor(
    kind: CloudflareErrorKind,
    message: string,
    fields: {
      readonly status?: number;
      readonly errors?: readonly ApiMessage[];
      readonly rayId?: string;
      readonly retryAfterMs?: number;
      readonly body?: unknown;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, fields.cause === undefined ? {} : { cause: fields.cause });
    this.kind = kind;
    this.errors = Object.freeze([...(fields.errors ?? [])]);
    if (fields.status !== undefined) this.status = fields.status;
    if (fields.rayId !== undefined) this.rayId = fields.rayId;
    if (fields.retryAfterMs !== undefined) {
      this.retryAfterMs = fields.retryAfterMs;
    }
    if (fields.body !== undefined) this.body = fields.body;
  }

  /** Whether any of the envelope's errors, or their chains, has `code`. */
  hasCode(code: number): boolean {
    const search = (errors: readonly ApiMessage[]): boolean =>
      errors.some((error) =>
        error.code === code || search(error.error_chain ?? [])
      );
    return search(this.errors);
  }

  /** Whether Cloudflare answered 404. */
  get notFound(): boolean {
    return this.status === 404;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.errors.length === 0 ? {} : { errors: this.errors }),
      ...(this.rayId === undefined ? {} : { rayId: this.rayId }),
    };
  }
}

/**
 * The `errors` (or `messages`) of an envelope, keeping only well-formed
 * entries: an integer `code` and a string `message`, with their chains
 * (four deep at most).
 */
export function apiMessages(value: unknown, depth = 0): ApiMessage[] {
  if (!Array.isArray(value) || depth > 3) return [];
  const result: ApiMessage[] = [];
  for (const item of value.slice(0, 64)) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.code !== "number" || !Number.isSafeInteger(record.code) ||
      typeof record.message !== "string"
    ) continue;
    const entry: {
      code: number;
      message: string;
      documentation_url?: string;
      source?: { pointer?: string };
      error_chain?: ApiMessage[];
    } = { code: record.code, message: record.message.slice(0, 1000) };
    if (typeof record.documentation_url === "string") {
      entry.documentation_url = record.documentation_url;
    }
    const source = record.source;
    if (
      source !== null && typeof source === "object" &&
      typeof (source as { pointer?: unknown }).pointer === "string"
    ) {
      entry.source = { pointer: (source as { pointer: string }).pointer };
    }
    const chain = apiMessages(record.error_chain, depth + 1);
    if (chain.length > 0) entry.error_chain = chain;
    result.push(Object.freeze(entry));
  }
  return result;
}
