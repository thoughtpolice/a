// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON edge, as pure functions: routing, base64, and the status map.
 *
 * Record payloads are bytes everywhere else in the service; base64 exists only
 * at this boundary, because JSON has no byte string. Nothing here validates
 * domain fields — `core.ts` does that once, for HTTP and native RPC callers
 * alike — so this module only turns a request into the shape a transition
 * accepts, and a result back into JSON.
 *
 * @module
 */

import {
  type AcquireLeaseRequest,
  type AnyResult,
  type AppendRequest,
  type Invalid,
  LIMITS,
  NAME_PATTERN,
  type ReadRequest,
  type RecordSnapshotRequest,
  type ReleaseLeaseRequest,
  type RenewLeaseRequest,
  type TooLarge,
  type TrimRequest,
} from "./types.ts";

/** The journal methods the HTTP surface exposes, one path segment each. */
export type Op =
  | "status"
  | "acquireLease"
  | "renewLease"
  | "releaseLease"
  | "append"
  | "read"
  | "recordSnapshot"
  | "trim";

/** A decoded call, discriminated so a dispatcher stays type-checked. */
export type Call =
  | { op: "status" }
  | { op: "acquireLease"; request: AcquireLeaseRequest }
  | { op: "renewLease"; request: RenewLeaseRequest }
  | { op: "releaseLease"; request: ReleaseLeaseRequest }
  | { op: "append"; request: AppendRequest }
  | { op: "read"; request: ReadRequest }
  | { op: "recordSnapshot"; request: RecordSnapshotRequest }
  | { op: "trim"; request: TrimRequest };

/** A resolved route, or the status and body the edge should answer with. */
export type Route =
  | { ok: true; name: string; op: Op }
  | { ok: false; status: number; code: string; message: string };

const OPERATIONS: Record<string, Op> = {
  "acquire-lease": "acquireLease",
  "renew-lease": "renewLease",
  "release-lease": "releaseLease",
  "append": "append",
  "read": "read",
  "record-snapshot": "recordSnapshot",
  "trim": "trim",
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
 * Resolves `GET /v1/logs/{name}` and `POST /v1/logs/{name}/{operation}`.
 *
 * The name segment is matched raw, without percent-decoding: every legal name
 * is already URL-safe, so an encoded one is simply a name the journal does not
 * have, and no escaped separator can reach the cell lookup.
 */
export function parseRoute(method: string, pathname: string): Route {
  const segments = pathname.split("/");
  if (segments.length < 4 || segments.length > 5) return NOT_FOUND;
  const [empty, version, collection, name] = segments;
  if (empty !== "" || version !== "v1" || collection !== "logs") {
    return NOT_FOUND;
  }

  let op: Op;
  if (segments.length === 4) {
    if (method !== "GET") return NOT_FOUND;
    op = "status";
  } else {
    if (method !== "POST") return NOT_FOUND;
    // Own keys only: a plain object lookup would resolve `constructor` or
    // `__proto__` to an inherited property and dispatch on a function.
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
      message: "malformed log name",
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
 * Turns a parsed body into a call. Only `append` needs real decoding; the
 * other operations are handed through with their fields untouched, because
 * every one of them is checked by the transition that consumes it.
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
  if (op !== "append") {
    return { ok: true, call: { op, request: fields } as unknown as Call };
  }
  const records = fields.records;
  if (!Array.isArray(records)) {
    return invalid("records must be an array of base64 strings");
  }
  const payloads: Uint8Array[] = [];
  for (const item of records) {
    if (typeof item !== "string") {
      return invalid("records must be an array of base64 strings");
    }
    const payload = decodeBase64(item);
    if (payload === null) return invalid("records must be base64");
    payloads.push(payload);
  }
  const request = { ...fields, records: payloads } as unknown as AppendRequest;
  return { ok: true, call: { op, request } };
}

/** Renders a result as JSON, re-encoding record payloads as base64. */
export function encodeResult(result: AnyResult): unknown {
  if (result.ok && "records" in result) {
    return {
      ...result,
      records: result.records.map((record) => ({
        seq: record.seq,
        term: record.term,
        payload: encodeBase64(record.payload),
      })),
    };
  }
  return result;
}

/** Maps a domain result onto the status code a client should act on. */
export function httpStatus(result: AnyResult): number {
  if (result.ok) return 200;
  switch (result.code) {
    case "INVALID":
      return 400;
    case "TOO_LARGE":
      return 413;
    case "LEASE_HELD":
    case "NOT_LEADER":
    case "SEQ_MISMATCH":
    case "SNAPSHOT_STALE":
      return 409;
    case "TRIMMED":
      return 410;
  }
}

/**
 * The prefix of every error the journal cell throws for a failure a client
 * should simply repeat: a segment call celld kept failing transiently past
 * the cell's own bounded retries, or a link capture taken from the journal
 * twice in one append. Only the message survives celld's RPC boundary, so
 * the edge recognises these by it, wherever it appears.
 */
export const UNAVAILABLE_PREFIX = "journal unavailable: ";

/**
 * Names the transient celld failure behind a thrown error, or `null` for a
 * bug the client must not retry into.
 *
 * Only celld's routing error carries a `code`. In 0.5.1 a crash failover
 * surfaces as a plain Error whose message starts with "remote RPC transport
 * failed" (the surviving node dialled the dead owner's tunnel); a write the
 * fleet could not prove durable as "route failed: DurabilityUnproven"; and a
 * cell whose state could not be restored from the bucket yet as "route RPC
 * <scope>: RestoreFailed". All are safe to repeat: the first and last never
 * started the method, and the second is exactly the ambiguous outcome the
 * `expectedNextSeq` replay contract settles. The journal cell's own
 * `UNAVAILABLE_PREFIX` errors carry their cause after the prefix.
 */
export function retryableCause(error: unknown): string | null {
  const thrown = error as
    | { code?: unknown; retryable?: unknown; message?: unknown }
    | null
    | undefined;
  const message = typeof thrown?.message === "string" ? thrown.message : "";
  const at = message.indexOf(UNAVAILABLE_PREFIX);
  if (at >= 0) return message.slice(at + UNAVAILABLE_PREFIX.length);
  if (thrown?.code === "owner_unreachable" || thrown?.retryable === true) {
    return "journal owner unreachable";
  }
  if (message.startsWith("remote RPC transport failed")) {
    return "journal owner unreachable";
  }
  if (message.startsWith("route failed") || message.startsWith("route RPC ")) {
    if (message.includes("DurabilityUnproven")) {
      return "durability unproven; the request may or may not have applied";
    }
    const at = message.lastIndexOf(": ");
    const reason = at >= 0 ? message.slice(at + 2) : message;
    return `journal route failed: ${reason}`;
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

/** Decodes into a fresh buffer per call, so no two records share storage. */
export function decodeBase64(text: string): Uint8Array | null {
  if (!BASE64.test(text)) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
