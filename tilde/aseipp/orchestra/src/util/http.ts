// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP boundary helpers for the public Worker.
 *
 * This module owns Orchestra's JSON response format, request validation, and
 * the adaptation of typed object outcomes into HTTP responses.
 * Centralizing these rules keeps each object focused on
 * its state machine and makes validation behavior uniform across endpoints.
 *
 * @module
 */

import type { JsonObject, Outcome } from "../model.ts";
import type { RpcResult } from "./rpc.ts";

/**
 * Serializes a value as Orchestra's indented, newline-terminated JSON format.
 *
 * @param value JSON-serializable response value.
 * @param init Standard response metadata; caller headers are preserved.
 * @returns A response with a UTF-8 JSON content type.
 */
export function responseJson(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value, null, 2) + "\n", {
    ...init,
    headers,
  });
}

/**
 * Builds Orchestra's common JSON error envelope.
 *
 * @param status HTTP status code.
 * @param error Stable human-readable error summary.
 * @param details Optional diagnostics, normally an upstream response or error message.
 */
export function responseError(
  status: number,
  error: string,
  details: unknown = undefined,
): Response {
  return responseJson(
    { error, ...(details === undefined ? {} : { details }) },
    { status },
  );
}

/**
 * Parses a request body and requires a non-null, non-array JSON object.
 *
 * @throws {TypeError} When the body is invalid JSON or not an object.
 */
export async function requestObject(request: Request): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new TypeError("request body must be JSON");
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("request body must be a JSON object");
  }
  return value as JsonObject;
}

/**
 * Validates a name used in URLs, cell names, queues, agents, or test IDs.
 *
 * Names are deliberately restrictive because they become routing keys.
 *
 * @throws {TypeError} When the value is not 1–128 safe name characters.
 */
export function requireName(value: unknown, field: string): string {
  if (
    value === "__proto__" || value === "constructor" || value === "prototype"
  ) {
    throw new TypeError(`${field} is a reserved dictionary name`);
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new TypeError(
      `${field} must contain only letters, digits, '.', '_', or '-'`,
    );
  }
  return value;
}

/**
 * Validates a general, non-empty protocol string.
 *
 * @throws {TypeError} When the value is empty, non-string, or over 1024 characters.
 */
export function requireString(value: unknown, field: string): string {
  if (
    value === "__proto__" || value === "constructor" || value === "prototype"
  ) {
    throw new TypeError(`${field} is a reserved dictionary name`);
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new TypeError(
      `${field} must be a non-empty string of at most 1024 characters`,
    );
  }
  return value;
}

/**
 * Validates a safe integer with a configurable inclusive lower bound.
 *
 * @throws {TypeError} When the value is not a safe integer or is too small.
 */
export function requireInteger(
  value: unknown,
  field: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(
      `${field} must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value as number;
}

/**
 * Validates a test outcome at an untyped JSON boundary.
 *
 * @throws {TypeError} When the value is not an Orchestra outcome.
 */
export function requireOutcome(value: unknown, field = "outcome"): Outcome {
  if (value !== "pass" && value !== "fail" && value !== "infra_failure") {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

/** Returns an exception's message or a stable string conversion for non-errors. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Preserve the public status/envelope without exposing internal RPC wrappers. */
export function rpcResponse<T>(result: RpcResult<T>, status = 200): Response {
  return result.ok
    ? responseJson(result.value, { status })
    : responseError(result.status, result.error, result.details);
}
