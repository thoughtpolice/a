// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The two kinds of failure this library deals in:
 *
 * - {@link ProtocolError}: an OAuth error response a server sends, with
 *   one of the registered {@link OAuthErrorCode}s (RFC 6749 section 5.2
 *   and its extensions). Server and resource code throws it and turns it
 *   into a `Response`; the client reads servers' refusals into it.
 * - {@link OAuthError}: a client-side failure with a {@link OAuthErrorKind}
 *   saying which step failed, carrying the server's code when there was
 *   one. It has a plain-data form (`toJSON`, {@link oauthErrorFromData})
 *   that survives Durable Object RPC, and {@link attemptOAuth} turns it
 *   into an `{ok, ...}` outcome.
 *
 * @module
 */

import { jsonResponse, NO_STORE } from "./util.ts";

/**
 * The registered OAuth error codes: RFC 6749 sections 4.1.2.1 and 5.2,
 * RFC 6750 (`invalid_token`, `insufficient_scope`), RFC 7009
 * (`unsupported_token_type`), RFC 7591 (client metadata), RFC 8628 (device
 * polling), RFC 8707 (`invalid_target`), RFC 9101/9126 (request URIs) and
 * RFC 9449 (DPoP). Any other string is allowed too, for extensions.
 */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "access_denied"
  | "server_error"
  | "temporarily_unavailable"
  | "invalid_token"
  | "insufficient_scope"
  | "unsupported_token_type"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "invalid_software_statement"
  | "unapproved_software_statement"
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "invalid_target"
  | "invalid_request_uri"
  | "invalid_request_object"
  | "invalid_dpop_proof"
  | "use_dpop_nonce"
  | (string & Record<never, never>);

/** An OAuth error response body (RFC 6749 section 5.2). */
export interface ErrorResponseBody {
  readonly error: OAuthErrorCode;
  readonly error_description?: string;
  readonly error_uri?: string;
}

/** Fields a {@link ProtocolError} is built from beyond its code. */
export interface ProtocolErrorInit {
  /** HTTP status; default 400, or 401 for `invalid_client`. */
  readonly status?: number;
  readonly description?: string;
  readonly uri?: string;
  /** Headers to send with the response (`WWW-Authenticate`, `DPoP-Nonce`). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly cause?: unknown;
}

const DESCRIPTION = /^[\x20\x21\x23-\x5B\x5D-\x7E]*$/;

/**
 * An OAuth error response. `error_description` is limited to the
 * characters RFC 6749 allows; others are replaced with `?` so a message
 * cannot break the JSON or header it is put in.
 */
export class ProtocolError extends Error {
  override name = "ProtocolError";
  readonly code: OAuthErrorCode;
  readonly status: number;
  readonly description: string | null;
  readonly uri: string | null;
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: OAuthErrorCode, init: ProtocolErrorInit = {}) {
    super(
      init.description === undefined ? code : `${code}: ${init.description}`,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.code = code;
    this.status = init.status ?? (code === "invalid_client" ? 401 : 400);
    this.description = init.description === undefined
      ? null
      : safeDescription(init.description);
    this.uri = init.uri ?? null;
    this.headers = init.headers ?? {};
  }

  /** The response body. */
  toJSON(): ErrorResponseBody {
    return {
      error: this.code,
      ...(this.description === null
        ? {}
        : { error_description: this.description }),
      ...(this.uri === null ? {} : { error_uri: this.uri }),
    };
  }

  /** A JSON error response with `no-store` caching and this error's headers. */
  toResponse(): Response {
    return jsonResponse(this.status, this.toJSON(), {
      ...NO_STORE,
      ...this.headers,
    });
  }
}

/** A description with every character RFC 6749 does not allow replaced. */
export function safeDescription(text: string): string {
  if (DESCRIPTION.test(text)) return text;
  return Array.from(text, (char) => DESCRIPTION.test(char) ? char : "?")
    .join("");
}

/** Which client step failed. */
export type OAuthErrorKind =
  /** Protected resource or authorization server metadata was missing or invalid. */
  | "discovery"
  /** The server lacks something required: PKCE S256, a grant, an endpoint. */
  | "unsupported"
  /** No way to obtain a client id, or registration failed. */
  | "registration"
  /** A user must authorize, and there is no user agent to ask. */
  | "interaction_required"
  /** The authorization response carried an error (the user refused, say). */
  | "authorization"
  /** The authorization response's `iss` did not match the issuer (RFC 9207). */
  | "issuer_mismatch"
  /** The authorization response's `state` was missing or wrong. */
  | "state_mismatch"
  /** An endpoint refused (its `error` is kept), or answered something malformed. */
  | "token"
  /** A step-up for the same scopes was already tried. */
  | "insufficient_scope"
  /** A DPoP proof could not be made, or the server's DPoP answer was wrong. */
  | "dpop"
  /** The network failed, or an endpoint answered 5xx. */
  | "network";

/** An {@link OAuthError} as plain data. Absent facts are `null`. */
export interface OAuthErrorData {
  readonly kind: OAuthErrorKind;
  readonly message: string;
  /** The OAuth `error` code from the server, if any. */
  readonly error: string | null;
  /** The server's `error_description`, if any. */
  readonly description: string | null;
  /** The HTTP status, if a response came back. */
  readonly status: number | null;
  /** The authorization server involved, when known. */
  readonly issuer: string | null;
  readonly retryable: boolean;
}

/** Fields an {@link OAuthError} is built from. */
export interface OAuthErrorInit {
  readonly error?: string | null;
  readonly description?: string | null;
  readonly status?: number | null;
  readonly issuer?: string | null;
  readonly cause?: unknown;
}

/** A client-side OAuth failure. Narrow on `kind`, then `error`. */
export class OAuthError extends Error {
  override name = "OAuthError";
  readonly kind: OAuthErrorKind;
  readonly error: string | null;
  readonly description: string | null;
  readonly status: number | null;
  readonly issuer: string | null;

  constructor(
    kind: OAuthErrorKind,
    message: string,
    init: OAuthErrorInit = {},
  ) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.kind = kind;
    this.error = init.error ?? null;
    this.description = init.description ?? null;
    this.status = init.status ?? null;
    this.issuer = init.issuer ?? null;
  }

  /** Whether trying again later may help. */
  get retryable(): boolean {
    return this.kind === "network" ||
      this.error === "temporarily_unavailable" ||
      (this.status !== null && (this.status === 429 || this.status >= 500));
  }

  toJSON(): OAuthErrorData {
    return {
      kind: this.kind,
      message: this.message,
      error: this.error,
      description: this.description,
      status: this.status,
      issuer: this.issuer,
      retryable: this.retryable,
    };
  }
}

/** Whether `value` is an {@link OAuthError}. */
export function isOAuthError(value: unknown): value is OAuthError {
  return value instanceof OAuthError;
}

/** Rebuilds an {@link OAuthError} from its plain-data form. */
export function oauthErrorFromData(data: OAuthErrorData): OAuthError {
  return new OAuthError(data.kind, data.message, data);
}

/** The outcome of {@link attemptOAuth}. */
export type OAuthOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: OAuthErrorData };

/** Runs `work`, returning OAuthErrors as data and rethrowing anything else. */
export async function attemptOAuth<T>(
  work: () => Promise<T>,
): Promise<OAuthOutcome<T>> {
  try {
    return { ok: true, result: await work() };
  } catch (error) {
    if (error instanceof OAuthError) {
      return { ok: false, error: error.toJSON() };
    }
    throw error;
  }
}
