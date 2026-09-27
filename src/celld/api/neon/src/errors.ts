// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Errors from Neon's SQL endpoint.
 *
 * A Postgres error arrives as a 400 with every field Postgres reports
 * (`code` is the SQLSTATE); everything else (the endpoint refusing the
 * request, a response too large, the network, a timeout) has its `kind`.
 *
 * @module
 */

/** Where a failure came from. */
export type NeonErrorKind =
  /** Postgres (or Neon's proxy) answered with an error; see `code`. */
  | "postgres"
  /** An HTTP status without a Postgres error body. */
  | "http"
  /** The response was larger than `maxResponseBytes`, or Neon's own limit (507). */
  | "too-large"
  /** No response in time; the statement may have run. */
  | "timeout"
  /** The connection failed; the statement may have run. */
  | "network"
  /** A response that is not what the endpoint sends. */
  | "response";

/** Fields of a Postgres error, as Neon forwards them. */
export interface PostgresErrorFields {
  /** The SQLSTATE (`23505` for a unique violation). Empty for proxy errors. */
  readonly code?: string;
  readonly severity?: string;
  readonly detail?: string;
  readonly hint?: string;
  /** 1-based character position in the statement. */
  readonly position?: number;
  readonly internalPosition?: number;
  readonly internalQuery?: string;
  readonly where?: string;
  readonly schema?: string;
  readonly table?: string;
  readonly column?: string;
  readonly dataType?: string;
  readonly constraint?: string;
  readonly file?: string;
  readonly line?: string;
  readonly routine?: string;
}

/** A failed request. */
export class NeonError extends Error implements PostgresErrorFields {
  override readonly name = "NeonError";
  readonly kind: NeonErrorKind;
  /** The HTTP status, when there was a response. */
  readonly status?: number;
  /** Neon's `neon-request-id`, for its support. */
  readonly requestId?: string;
  /**
   * Neon's `neon:retryable` flag, as sent. It is not a promise that the
   * statement did not run, nor that retrying helps (Neon sets it on a
   * malformed request header too), so the client never acts on it.
   */
  readonly neonRetryable?: boolean;
  readonly code?: string;
  readonly severity?: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly position?: number;
  readonly internalPosition?: number;
  readonly internalQuery?: string;
  readonly where?: string;
  readonly schema?: string;
  readonly table?: string;
  readonly column?: string;
  readonly dataType?: string;
  readonly constraint?: string;
  readonly file?: string;
  readonly line?: string;
  readonly routine?: string;

  constructor(
    kind: NeonErrorKind,
    message: string,
    fields: PostgresErrorFields & {
      readonly status?: number;
      readonly requestId?: string;
      readonly neonRetryable?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      fields.cause === undefined ? undefined : { cause: fields.cause },
    );
    this.kind = kind;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && key !== "cause") {
        Object.defineProperty(this, key, { value, enumerable: true });
      }
    }
  }
}

/** Common SQLSTATEs. */
export const SQLSTATE = Object.freeze({
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  notNullViolation: "23502",
  checkViolation: "23514",
  exclusionViolation: "23P01",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
  readOnlyTransaction: "25006",
  undefinedTable: "42P01",
  undefinedColumn: "42703",
  syntaxError: "42601",
  divisionByZero: "22012",
  invalidTextRepresentation: "22P02",
  queryCanceled: "57014",
});

/** Whether `error` is a Postgres error with SQLSTATE `code`. */
export function hasSqlState(error: unknown, code: string): error is NeonError {
  return error instanceof NeonError && error.kind === "postgres" &&
    error.code === code;
}

/**
 * Whether a transaction failed in a way that a fresh attempt of the whole
 * batch may succeed (a serialization failure or deadlock): Postgres rolled
 * it back, so nothing of it ran.
 */
export function isTransientConflict(error: unknown): error is NeonError {
  return hasSqlState(error, SQLSTATE.serializationFailure) ||
    hasSqlState(error, SQLSTATE.deadlockDetected);
}

const TEXT_FIELDS = [
  "code",
  "severity",
  "detail",
  "hint",
  "internalQuery",
  "where",
  "schema",
  "table",
  "column",
  "dataType",
  "constraint",
  "file",
  "line",
  "routine",
] as const;

/** Reads Neon's error body into fields; null when it is not one. */
export function errorFields(
  body: unknown,
): (PostgresErrorFields & { message: string; neonRetryable?: boolean }) | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.message !== "string") return null;
  const fields: Record<string, unknown> = { message: record.message };
  for (const key of TEXT_FIELDS) {
    const value = record[key];
    if (typeof value === "string" && value !== "") fields[key] = value;
  }
  for (const key of ["position", "internalPosition"] as const) {
    const value = Number(record[key]);
    if (
      record[key] !== null && record[key] !== undefined &&
      Number.isSafeInteger(value)
    ) fields[key] = value;
  }
  if (typeof record["neon:retryable"] === "boolean") {
    fields.neonRetryable = record["neon:retryable"];
  }
  return fields as unknown as PostgresErrorFields & {
    message: string;
    neonRetryable?: boolean;
  };
}
