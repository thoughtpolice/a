// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Every failure the library reports: one class with a `kind` discriminant and
 * a plain-data form that survives Durable Object RPC and Workflow steps
 * (which keep only an Error's name and message).
 *
 * The same class carries JSON-RPC errors both ways. A server handler throws
 * `McpError.invalidParams(...)` and the peer receives code -32602; a client
 * receiving that response throws an `McpError` of kind `rpc` with the same
 * code and data.
 *
 * @module
 */

import {
  HEADER_MISMATCH,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  LEGACY_RESOURCE_NOT_FOUND,
  METHOD_NOT_FOUND,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  PARSE_ERROR,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "./types.ts";
import type {
  ClientCapabilities,
  Error as RpcErrorObject,
  JSONValue,
} from "./types.ts";
import { isPlainObject } from "./json.ts";

/** What went wrong, from the caller's point of view. */
export type McpErrorKind =
  /** A JSON-RPC error, received from the peer or thrown to be sent; see `code`. */
  | "rpc"
  /** A non-2xx HTTP response without a JSON-RPC error body (such as a legacy server's 404). */
  | "http"
  /** 401 or 403: credentials missing, invalid or insufficient; see `wwwAuthenticate`. */
  | "unauthorized"
  /** No HTTP response: DNS, TLS, reset. */
  | "connection"
  /** The response stream broke off, even after re-issuing the request. */
  | "stream"
  /** A message or result without the documented shape. */
  | "decode"
  /** No final response within the timeout. */
  | "timeout"
  /** The caller's AbortSignal fired. */
  | "aborted"
  /** The server supports none of the client's protocol versions. */
  | "unsupported_version"
  /** The server asked for input the client has no handler for. */
  | "input_unhandled"
  /** The server kept asking for input past the round limit. */
  | "input_rounds"
  /** Refused before sending; the request or a tool definition is malformed. */
  | "invalid_request"
  /** A task (the tasks extension) ended as cancelled instead of with a result. */
  | "task_cancelled";

/** An error as plain data: structured-clone and JSON safe. Absent facts are `null`. */
export interface McpErrorData {
  readonly kind: McpErrorKind;
  readonly message: string;
  /** The JSON-RPC code, for `rpc`. */
  readonly code: number | null;
  /** The JSON-RPC error's `data`, or other detail. */
  readonly data: JSONValue | null;
  /** The HTTP status, when there was a response. */
  readonly status: number | null;
  /** The MCP method of the request that failed. */
  readonly method: string | null;
  /** The `WWW-Authenticate` header of a 401 or 403. */
  readonly wwwAuthenticate: string | null;
  /** Whether a later retry may succeed. */
  readonly retryable: boolean;
}

/** Fields an error is built from; missing ones default to null. */
export interface McpErrorInit {
  readonly code?: number | null;
  readonly data?: JSONValue | null;
  readonly status?: number | null;
  readonly method?: string | null;
  readonly wwwAuthenticate?: string | null;
  readonly cause?: unknown;
}

/** Base class of every error the library throws. Narrow on `kind`. */
export class McpError extends Error {
  readonly kind: McpErrorKind;
  readonly code: number | null;
  readonly data: JSONValue | null;
  status: number | null;
  method: string | null;
  readonly wwwAuthenticate: string | null;

  constructor(kind: McpErrorKind, message: string, init: McpErrorInit = {}) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "McpError";
    this.kind = kind;
    this.code = init.code ?? null;
    this.data = init.data ?? null;
    this.status = init.status ?? null;
    this.method = init.method ?? null;
    this.wwwAuthenticate = init.wwwAuthenticate ?? null;
  }

  /** A JSON-RPC error with any code. */
  static rpc(code: number, message: string, data?: JSONValue): McpError {
    return new McpError("rpc", message, { code, data: data ?? null });
  }

  /** -32700: the body is not JSON. */
  static parseError(message = "Parse error"): McpError {
    return McpError.rpc(PARSE_ERROR, message);
  }

  /** -32600: not a valid JSON-RPC request. */
  static invalidRequest(message: string): McpError {
    return McpError.rpc(INVALID_REQUEST, message);
  }

  /** -32601: an unknown method, or one whose server capability is absent. */
  static methodNotFound(method: string): McpError {
    return McpError.rpc(METHOD_NOT_FOUND, `Method not found: ${method}`, {
      method,
    });
  }

  /** -32602: unknown tool or prompt, resource not found, bad cursor, bad params. */
  static invalidParams(message: string, data?: JSONValue): McpError {
    return McpError.rpc(INVALID_PARAMS, message, data);
  }

  /** -32602 with `{uri}`: the resource does not exist. */
  static resourceNotFound(uri: string): McpError {
    return McpError.invalidParams("Resource not found", { uri });
  }

  /** -32603: something failed inside the server. */
  static internal(message = "Internal error"): McpError {
    return McpError.rpc(INTERNAL_ERROR, message);
  }

  /** -32020: HTTP headers missing, malformed, or not matching the body. */
  static headerMismatch(message: string): McpError {
    return McpError.rpc(HEADER_MISMATCH, `Header mismatch: ${message}`);
  }

  /** -32021: processing needs client capabilities the request did not declare. */
  static missingCapability(required: ClientCapabilities): McpError {
    return McpError.rpc(
      MISSING_REQUIRED_CLIENT_CAPABILITY,
      `Missing required client capability: ${Object.keys(required).join(", ")}`,
      { requiredCapabilities: required as JSONValue },
    );
  }

  /** -32022: the requested protocol version is not supported. */
  static unsupportedVersion(
    supported: readonly string[],
    requested: string,
  ): McpError {
    return McpError.rpc(
      UNSUPPORTED_PROTOCOL_VERSION,
      "Unsupported protocol version",
      { supported: [...supported], requested },
    );
  }

  /** Whether the failure is transient, so a later retry may succeed. */
  get retryable(): boolean {
    if (this.kind === "http") {
      return this.status !== null &&
        (this.status === 429 || this.status >= 500);
    }
    return this.kind === "connection" || this.kind === "stream" ||
      this.kind === "timeout";
  }

  /** For -32022: the versions the server listed. */
  get supportedVersions(): string[] | null {
    if (this.code !== UNSUPPORTED_PROTOCOL_VERSION) return null;
    const supported = isPlainObject(this.data) ? this.data.supported : null;
    return Array.isArray(supported) &&
        supported.every((item) => typeof item === "string")
      ? supported as string[]
      : null;
  }

  /** For -32021: the capabilities the server asked for. */
  get requiredCapabilities(): ClientCapabilities | null {
    if (this.code !== MISSING_REQUIRED_CLIENT_CAPABILITY) return null;
    const required = isPlainObject(this.data)
      ? this.data.requiredCapabilities
      : null;
    return isPlainObject(required) ? required as ClientCapabilities : null;
  }

  /**
   * Whether a `resources/read` failed because the resource does not exist:
   * -32602, or the -32002 that servers before 2026-07-28 send.
   */
  get resourceNotFound(): boolean {
    return this.kind === "rpc" && this.method === "resources/read" &&
      (this.code === INVALID_PARAMS || this.code === LEGACY_RESOURCE_NOT_FOUND);
  }

  /** The JSON-RPC error object to send; non-`rpc` kinds become -32603. */
  toRpcError(): RpcErrorObject {
    if (this.kind !== "rpc" || this.code === null) {
      return { code: INTERNAL_ERROR, message: "Internal error" };
    }
    const error: RpcErrorObject = { code: this.code, message: this.message };
    if (this.data !== null) error.data = this.data;
    return error;
  }

  /** The plain-data form; `JSON.stringify` uses it too. */
  toJSON(): McpErrorData {
    return {
      kind: this.kind,
      message: this.message,
      code: this.code,
      data: this.data,
      status: this.status,
      method: this.method,
      wwwAuthenticate: this.wwwAuthenticate,
      retryable: this.retryable,
    };
  }
}

/** True for any error this library throws. */
export function isMcpError(value: unknown): value is McpError {
  return value instanceof McpError;
}

/** Rebuilds the error from its plain-data form. */
export function mcpErrorFromData(data: McpErrorData): McpError {
  return new McpError(data.kind, data.message, {
    code: data.code,
    data: data.data,
    status: data.status,
    method: data.method,
    wwwAuthenticate: data.wwwAuthenticate,
  });
}

/** An error received from the peer, as an `rpc` McpError. */
export function mcpErrorFromRpc(
  error: RpcErrorObject,
  init: { status?: number | null; method?: string | null } = {},
): McpError {
  return new McpError("rpc", error.message, {
    code: error.code,
    data: error.data === undefined ? null : error.data as JSONValue,
    status: init.status ?? null,
    method: init.method ?? null,
  });
}

/** The outcome of a `try*` call: the result, or the error as plain data. */
export type McpOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: McpErrorData };

/** Runs `work`, returning McpErrors as data and rethrowing anything else. */
export async function attempt<T>(
  work: () => Promise<T>,
): Promise<McpOutcome<T>> {
  try {
    return { ok: true, result: await work() };
  } catch (error) {
    if (isMcpError(error)) return { ok: false, error: error.toJSON() };
    throw error;
  }
}
