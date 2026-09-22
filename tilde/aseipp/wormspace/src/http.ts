// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON edge, as pure functions: routing, base64, and the status map.
 *
 * Register values and allocation metadata are bytes everywhere else in the
 * service; base64 exists only at this boundary, because JSON has no byte
 * string. Nothing here validates domain fields — `core.ts` does that once, for
 * HTTP and native RPC callers alike — so this module only turns a request into
 * the shape a transition accepts, and a result back into JSON.
 *
 * @module
 */

import {
  type AllocRequest,
  type AnyResult,
  type CaptureRequest,
  type Invalid,
  LIMITS,
  type ListenRequest,
  NAME_PATTERN,
  type ReadRequest,
  type TooLarge,
  type TrimRequest,
  type WriteRequest,
} from "./types.ts";

/** The segment methods the HTTP surface exposes, one path segment each. */
export type Op =
  | "status"
  | "alloc"
  | "capture"
  | "write"
  | "read"
  | "trim"
  | "listen";

/** A decoded call, discriminated so a dispatcher stays type-checked. */
export type Call =
  | { op: "status" }
  | { op: "alloc"; request: AllocRequest }
  | { op: "capture"; request: CaptureRequest }
  | { op: "write"; request: WriteRequest }
  | { op: "read"; request: ReadRequest }
  | { op: "trim"; request: TrimRequest }
  | { op: "listen"; request: ListenRequest };

/** A resolved route, or the status and body the edge should answer with. */
export type Route =
  | { ok: true; name: string; op: Op }
  | { ok: false; status: number; code: string; message: string };

const OPERATIONS: Record<string, Op> = {
  "alloc": "alloc",
  "capture": "capture",
  "write": "write",
  "read": "read",
  "trim": "trim",
  "listen": "listen",
};

const NOT_FOUND: Route = {
  ok: false,
  status: 404,
  code: "NOT_FOUND",
  message: "unknown route",
};

function invalid(message: string): Invalid {
  return { ok: false, code: "INVALID", message };
}

function tooLarge(message: string): TooLarge {
  return { ok: false, code: "TOO_LARGE", message };
}

/**
 * Resolves `GET /v1/segments/{name}` and `POST /v1/segments/{name}/{operation}`.
 *
 * The name segment is matched raw, without percent-decoding: every legal name
 * is already URL-safe, so an encoded one is simply a name the service does not
 * have, and no escaped separator can reach the cell lookup.
 */
export function parseRoute(method: string, pathname: string): Route {
  const segments = pathname.split("/");
  if (segments.length < 4 || segments.length > 5) return NOT_FOUND;
  const [empty, version, collection, name] = segments;
  if (empty !== "" || version !== "v1" || collection !== "segments") {
    return NOT_FOUND;
  }

  let op: Op;
  if (segments.length === 4) {
    if (method !== "GET") return NOT_FOUND;
    op = "status";
  } else {
    if (method !== "POST") return NOT_FOUND;
    const known = Object.hasOwn(OPERATIONS, segments[4])
      ? OPERATIONS[segments[4]]
      : undefined;
    if (known === undefined) return NOT_FOUND;
    op = known;
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID",
      message: "malformed segment name",
    };
  }
  return { ok: true, name, op };
}

/** Reads a request body under the size cap, before handing it to JSON.parse. */
export function parseBody(
  text: string,
): { ok: true; body: unknown } | Invalid | TooLarge {
  if (text.length > LIMITS.bodyBytes) {
    return tooLarge(`body exceeds ${LIMITS.bodyBytes} bytes`);
  }
  if (text.trim() === "") return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return invalid("body must be a JSON object");
  }
}

/**
 * Turns a parsed body into a call. Only the byte fields need real decoding —
 * `alloc`'s `metadata` and `write`'s `values` — and everything else is handed
 * through untouched, because the transition that consumes it checks it.
 */
export function decodeRequest(
  op: Op,
  body: unknown,
): { ok: true; call: Call } | Invalid {
  if (op === "status") return { ok: true, call: { op } };
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalid("body must be a JSON object");
  }
  const fields = body as Record<string, unknown>;
  switch (op) {
    case "alloc": {
      if (typeof fields.metadata !== "string") {
        return invalid("metadata must be a base64 string");
      }
      const metadata = decodeBase64(fields.metadata);
      if (metadata === null) return invalid("metadata must be base64");
      const request = { ...fields, metadata } as unknown as AllocRequest;
      return { ok: true, call: { op, request } };
    }
    case "write": {
      const values = fields.values;
      if (!Array.isArray(values)) {
        return invalid("values must be an array of base64 strings");
      }
      const decoded: Uint8Array[] = [];
      for (const item of values) {
        if (typeof item !== "string") {
          return invalid("values must be an array of base64 strings");
        }
        const value = decodeBase64(item);
        if (value === null) return invalid("values must be base64");
        decoded.push(value);
      }
      const request = { ...fields, values: decoded } as unknown as WriteRequest;
      return { ok: true, call: { op, request } };
    }
    case "capture":
    case "read":
    case "trim":
    case "listen":
      return { ok: true, call: { op, request: fields } as unknown as Call };
  }
}

/** Renders a result as JSON, re-encoding every byte field as base64. */
export function encodeResult(result: AnyResult): unknown {
  if (result.ok) {
    if ("registers" in result) {
      return {
        ...result,
        registers: result.registers.map((register) =>
          register.value === undefined
            ? register
            : { ...register, value: encodeBase64(register.value) }
        ),
      };
    }
    if ("allocated" in result) {
      return {
        ...result,
        metadata: result.metadata === null
          ? null
          : encodeBase64(result.metadata),
      };
    }
    return result;
  }
  if (result.code === "ALREADY_ALLOCATED") {
    return { ...result, metadata: encodeBase64(result.metadata) };
  }
  return result;
}

/** Maps a domain result onto the status code a client should act on. */
export function httpStatus(result: AnyResult): number {
  if (result.ok) return 200;
  switch (result.code) {
    case "INVALID":
    case "OUT_OF_RANGE":
      return 400;
    case "TOO_LARGE":
      return 413;
    case "UNALLOCATED":
    case "ALREADY_ALLOCATED":
    case "ALREADY_WRITTEN":
    case "CAPTURE_STALE":
      return 409;
    case "TRIMMED":
      return 410;
  }
}

/**
 * Names the transient celld failure behind a thrown error, or `null` for a
 * bug the client must not retry into.
 *
 * Copied from `tilde/aseipp/journal/src/http.ts` (the bundler cannot import
 * across packages), with only the service name in the messages changed.
 *
 * Only celld's routing error carries a `code`. In 0.5.1 a crash failover
 * surfaces as a plain Error whose message starts with "remote RPC transport
 * failed" (the surviving node dialled the dead owner's tunnel); a write the
 * fleet could not prove durable as "route failed: DurabilityUnproven"; and a
 * cell whose state could not be restored from the bucket yet as "route RPC
 * <scope>: RestoreFailed". All are safe to repeat: the first and last never
 * started the method, and the second is exactly the ambiguous outcome the
 * write-once replay settles (`ALREADY_WRITTEN` with `sameValue`).
 */
export function retryableCause(error: unknown): string | null {
  const thrown = error as
    | { code?: unknown; retryable?: unknown; message?: unknown }
    | null
    | undefined;
  if (thrown?.code === "owner_unreachable" || thrown?.retryable === true) {
    return "segment owner unreachable";
  }
  const message = typeof thrown?.message === "string" ? thrown.message : "";
  if (message.startsWith("remote RPC transport failed")) {
    return "segment owner unreachable";
  }
  if (message.startsWith("route failed") || message.startsWith("route RPC ")) {
    if (message.includes("DurabilityUnproven")) {
      return "durability unproven; the request may or may not have applied";
    }
    const at = message.lastIndexOf(": ");
    const reason = at >= 0 ? message.slice(at + 2) : message;
    return `segment route failed: ${reason}`;
  }
  return null;
}

// Spreading a whole megabyte into String.fromCharCode overflows the call
// stack, so the binary string is built in bounded pieces.
const CHUNK_CHARS = 0x8000;

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_CHARS) {
    parts.push(
      String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_CHARS)),
    );
  }
  return btoa(parts.join(""));
}

/** Decodes into a fresh buffer per call, so no two values share storage. */
export function decodeBase64(text: string): Uint8Array | null {
  if (!BASE64.test(text)) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
