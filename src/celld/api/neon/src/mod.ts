// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Neon's serverless Postgres from celld, imported as "@celld/api/neon":
 * SQL over HTTPS through an exe.dev HTTP proxy integration that holds the
 * connection string, or straight to Neon with one.
 *
 * ```ts
 * import { NeonClient, sql } from "@celld/api/neon";
 *
 * const db = new NeonClient(); // https://neon-serverless.int.exe.xyz
 * const docs = await db.rows(sql`SELECT id, title FROM docs WHERE owner = ${owner} LIMIT ${50}`);
 * await db.transaction([
 *   sql`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${from}`,
 *   sql`UPDATE accounts SET balance = balance + ${amount} WHERE id = ${to}`,
 * ], { isolation: "Serializable", retryConflicts: 3 });
 * ```
 *
 * Subpaths: "./testing" (`FakeNeon`), and the separate target
 * "@celld/api/neon/reflection" (finding the integration through exe.dev's
 * reflection service).
 *
 * @module
 */

export {
  DEFAULT_INTEGRATION,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  endpointOrigin,
  type Field,
  type IsolationLevel,
  NeonClient,
  type NeonClientOptions,
  type QueryOptions,
  type QueryResult,
  type Row,
  type Statement,
  type TransactionOptions,
} from "./client.ts";
export {
  errorFields,
  hasSqlState,
  isTransientConflict,
  NeonError,
  type NeonErrorKind,
  type PostgresErrorFields,
  SQLSTATE,
} from "./errors.ts";
export {
  arrayLiteral,
  encodeParam,
  Json,
  json,
  type Param,
  ParamError,
} from "./params.ts";
export { ident, join, Query, raw, sql } from "./sql.ts";
export {
  OID,
  parseArray,
  parseBytea,
  parseDate,
  type Parser,
  parsers,
  parseTime,
  parseTimestamp,
  parseTimestamptz,
  type TypeOptions,
  ValueParseError,
} from "./types.ts";
