// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON edge of WormLog and WormPaxos, as pure functions: routing, body
 * decoding, base64 for log records, and the status map.
 *
 * Like `http.ts`, nothing here validates a domain field; the log library and
 * the cores do. Log records are bytes, so `append`'s `value` and every read
 * entry's `value` are base64 here and nowhere else. WormPaxos commands are
 * JSON already and pass through.
 *
 * Routes, all `POST` with a JSON object body (an empty body is `{}`):
 *
 *   /v1/wormlog/{log}/{init|append|read|tail|fill|trim|listen}
 *   /v1/wormpaxos/{group}/{replica}/{init|propose|learn|get|state}
 *
 * @module
 */

import { CHAIN_NAME_PATTERN } from "./chain.ts";
import { decodeBase64, encodeBase64 } from "@wormspace/segment/http";
import { REPLICA_PATTERN } from "./replica_core.ts";
import type { Invalid } from "@wormspace/segment/types";
import type { ReadLogRequest } from "./wormlog.ts";

export type LogOp =
  | "init"
  | "append"
  | "read"
  | "tail"
  | "fill"
  | "trim"
  | "listen";

export type PaxosOp = "init" | "propose" | "learn" | "get" | "state";

/** A resolved route, or the status and body the edge should answer with. */
export type LayerRoute =
  | { ok: true; layer: "wormlog"; log: string; op: LogOp }
  | {
    ok: true;
    layer: "wormpaxos";
    smr: string;
    replica: string;
    op: PaxosOp;
  }
  | { ok: false; status: number; code: string; message: string };

/**
 * A decoded log call. Everything but `append`'s record is handed on as it
 * came, for the library to check.
 */
export type LogCall =
  | { op: "init"; size: number }
  | { op: "append"; value: Uint8Array }
  | { op: "read"; request: ReadLogRequest }
  | { op: "tail" }
  | { op: "fill"; slot: number }
  | { op: "trim"; through: number }
  | {
    op: "listen";
    request: { from: number; since: number; timeoutMs?: number };
  };

/** A decoded replica call: the body's fields, checked by the core. */
export type PaxosCall = { op: PaxosOp; fields: Record<string, unknown> };

const LOG_OPS: Record<string, LogOp> = {
  init: "init",
  append: "append",
  read: "read",
  tail: "tail",
  fill: "fill",
  trim: "trim",
  listen: "listen",
};

const PAXOS_OPS: Record<string, PaxosOp> = {
  init: "init",
  propose: "propose",
  learn: "learn",
  get: "get",
  state: "state",
};

const NOT_FOUND: LayerRoute = {
  ok: false,
  status: 404,
  code: "NOT_FOUND",
  message: "unknown route",
};

function badName(what: string): LayerRoute {
  return {
    ok: false,
    status: 400,
    code: "INVALID",
    message: `malformed ${what} name`,
  };
}

function invalid(message: string): Invalid {
  return { ok: false, code: "INVALID", message };
}

function known<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Resolves a WormLog or WormPaxos path, or `null` when the path belongs to
 * neither (the segment routes, or nothing). Names are matched raw, as in
 * `http.ts`.
 */
export function parseLayerRoute(
  method: string,
  pathname: string,
): LayerRoute | null {
  const parts = pathname.split("/");
  const [empty, version, layer] = parts;
  if (empty !== "" || version !== "v1") return null;
  if (layer === "wormlog") {
    if (parts.length !== 5 || method !== "POST") return NOT_FOUND;
    const op = known(LOG_OPS, parts[4]);
    if (op === undefined) return NOT_FOUND;
    if (!CHAIN_NAME_PATTERN.test(parts[3])) return badName("log");
    return { ok: true, layer, log: parts[3], op };
  }
  if (layer === "wormpaxos") {
    if (parts.length !== 6 || method !== "POST") return NOT_FOUND;
    const op = known(PAXOS_OPS, parts[5]);
    if (op === undefined) return NOT_FOUND;
    if (!CHAIN_NAME_PATTERN.test(parts[3])) return badName("group");
    if (!REPLICA_PATTERN.test(parts[4])) return badName("replica");
    return { ok: true, layer, smr: parts[3], replica: parts[4], op };
  }
  return null;
}

function object(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

export function decodeLogRequest(
  op: LogOp,
  body: unknown,
): { ok: true; call: LogCall } | Invalid {
  const fields = object(body);
  if (fields === null) return invalid("body must be a JSON object");
  switch (op) {
    case "append": {
      if (typeof fields.value !== "string") {
        return invalid("value must be a base64 string");
      }
      const value = decodeBase64(fields.value);
      if (value === null) return invalid("value must be base64");
      return { ok: true, call: { op, value } };
    }
    case "init":
      return { ok: true, call: { op, size: fields.size as number } };
    case "tail":
      return { ok: true, call: { op } };
    case "fill":
      return { ok: true, call: { op, slot: fields.slot as number } };
    case "trim":
      return { ok: true, call: { op, through: fields.through as number } };
    case "read":
      return {
        ok: true,
        call: { op, request: fields as unknown as ReadLogRequest },
      };
    case "listen":
      return {
        ok: true,
        call: {
          op,
          request: fields as unknown as {
            from: number;
            since: number;
            timeoutMs?: number;
          },
        },
      };
  }
}

export function decodePaxosRequest(
  op: PaxosOp,
  body: unknown,
): { ok: true; call: PaxosCall } | Invalid {
  const fields = object(body);
  if (fields === null) return invalid("body must be a JSON object");
  return { ok: true, call: { op, fields } };
}

/** Renders a layer result as JSON, with log records as base64. */
export function encodeLayerResult(result: unknown): unknown {
  const fields = object(result);
  if (fields === null || !Array.isArray(fields.entries)) return result;
  return {
    ...fields,
    entries: fields.entries.map((entry: { value?: Uint8Array }) =>
      entry.value === undefined
        ? entry
        : { ...entry, value: encodeBase64(entry.value) }
    ),
  };
}

/** Maps a layer result onto the status a client should act on. */
export function layerStatus(result: { ok: boolean; code?: string }): number {
  if (result.ok) return 200;
  switch (result.code) {
    case "INVALID":
    case "OUT_OF_RANGE":
      return 400;
    case "TOO_LARGE":
      return 413;
    case "TRIMMED":
      return 410;
    case "CONTENDED":
      return 503;
    case "UNALLOCATED":
    case "CHAIN_MISMATCH":
    case "CONFLICT":
    case "ALREADY_ALLOCATED":
    case "ALREADY_WRITTEN":
    case "CAPTURE_STALE":
      return 409;
    default:
      // No layer answers with any other code; one that does is a bug.
      return 500;
  }
}
