// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The reserved `_meta` keys, the key syntax rules, log levels, the
 * OpenTelemetry trace context keys, and the OAuth client credentials
 * extension id.
 *
 * @module
 */

import type { LoggingLevel } from "./types.ts";

/** `_meta` keys reserved by the 2026-07-28 specification. */
export const META = {
  /** Required on every request: the request's protocol version. */
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  /** Optional on requests: the client's `Implementation`. */
  clientInfo: "io.modelcontextprotocol/clientInfo",
  /** Required on every request: the client's capabilities for this request. */
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  /** Optional on requests: opts in to `notifications/message` at this level or above. */
  logLevel: "io.modelcontextprotocol/logLevel",
  /** On listen-stream notifications and the listen result: the listen request's id. */
  subscriptionId: "io.modelcontextprotocol/subscriptionId",
  /** On results: the server's `Implementation`. */
  serverInfo: "io.modelcontextprotocol/serverInfo",
  /** On requests: opts in to `notifications/progress`. */
  progressToken: "progressToken",
  /** W3C Trace Context `traceparent`. */
  traceparent: "traceparent",
  /** W3C Trace Context `tracestate`. */
  tracestate: "tracestate",
  /** W3C Baggage. */
  baggage: "baggage",
} as const;

/**
 * The extension a client that authenticates with OAuth client credentials
 * (no user; `OAuthSession` with `clientCredentials` from
 * `@celld/oauth/client`) declares in its `capabilities.extensions`.
 */
export const OAUTH_CLIENT_CREDENTIALS_EXTENSION =
  "io.modelcontextprotocol/oauth-client-credentials";

const LABEL = "[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const KEY = new RegExp(
  `^(?:${LABEL}(?:\\.${LABEL})*/)?(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)?$`,
);

/**
 * Whether `key` is a valid `_meta` key: an optional prefix of dot-separated
 * labels ending in `/`, then a name that, unless empty, starts and ends with
 * an alphanumeric and has only alphanumerics, `-`, `_` and `.` inside.
 */
export function isValidMetaKey(key: string): boolean {
  return KEY.test(key);
}

/**
 * Whether `key` has a prefix reserved for MCP: one whose second label is
 * `modelcontextprotocol` or `mcp` (`io.modelcontextprotocol/`, `dev.mcp/`).
 */
export function isReservedMetaKey(key: string): boolean {
  const slash = key.indexOf("/");
  if (slash === -1) return false;
  const labels = key.slice(0, slash).split(".");
  return labels.length >= 2 &&
    (labels[1] === "modelcontextprotocol" || labels[1] === "mcp");
}

/**
 * Whether `key` may name an extension in `capabilities.extensions`: a valid
 * key with a mandatory prefix.
 */
export function isValidExtensionId(key: string): boolean {
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1 && isValidMetaKey(key);
}

/** The log levels, least severe first. */
export const LOG_LEVELS: readonly LoggingLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

/** Whether `value` is a log level. */
export function isLoggingLevel(value: unknown): value is LoggingLevel {
  return typeof value === "string" &&
    (LOG_LEVELS as readonly string[]).includes(value);
}

/** Whether a message at `level` passes a request's `threshold`. */
export function logLevelAtLeast(
  level: LoggingLevel,
  threshold: LoggingLevel,
): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(threshold);
}

const TRACEPARENT =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-[0-9a-f-]*)?$/;

/**
 * Whether `value` is a W3C `traceparent`: version, trace id, parent id and
 * flags in lowercase hex, with version `ff` and all-zero ids invalid, and
 * trailing fields allowed only for versions after `00`.
 */
export function isTraceparent(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = TRACEPARENT.exec(value);
  if (match === null) return false;
  const [, version, traceId, parentId, , rest] = match;
  if (version === "ff") return false;
  if (version === "00" && rest !== undefined) return false;
  return !/^0+$/.test(traceId) && !/^0+$/.test(parentId);
}

/** The trace context keys a request carries, to copy onto outgoing requests. */
export function traceContext(
  meta: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (meta === undefined) return out;
  for (const key of [META.traceparent, META.tracestate, META.baggage]) {
    const value = meta[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
