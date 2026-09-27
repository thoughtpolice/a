// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The client for Neon's SQL-over-HTTP endpoint (`POST /sql`).
 *
 * Each request is one statement, or one transaction of several (a
 * "batch", committed at the end and rolled back whole on any error). There
 * are no sessions: nothing (temporary tables, `SET`, prepared statements)
 * outlives a request, and a transaction cannot wait on JavaScript between
 * its statements.
 *
 * Two ways to reach it:
 *
 * - Through an exe.dev HTTP proxy integration (the default): the
 *   integration holds the connection string and injects it as the
 *   `Neon-Connection-String` header, so the VM holds no password.
 *   `new NeonClient()` uses `https://neon-serverless.int.exe.xyz`;
 *   `integration` names another.
 * - Directly: `connectionString` is sent with every request, to
 *   `https://api.<region host>` (what Neon's own driver uses).
 *
 * @module
 */

import { BoundsError, readBounded } from "@celld/core/bounds";
import {
  backoffDelay,
  defaultRuntime,
  type FetchLike,
  globalFetch,
  type HttpRetryPolicy,
  mayRetry,
  rejectOnAbort,
  resolveRetryPolicy,
  type RetryFailure,
  type RetryOptions,
  type Runtime,
} from "@celld/http";
import { errorFields, isTransientConflict, NeonError } from "./errors.ts";
import { encodeParam } from "./params.ts";
import { Query } from "./sql.ts";
import {
  type Parser,
  parsers,
  type TypeOptions,
  ValueParseError,
} from "./types.ts";

/** A statement: a `sql` query, or text with `$n` placeholders and its parameters. */
export type Statement = Query | {
  readonly text: string;
  readonly params?: readonly unknown[];
};

/** A result column. */
export interface Field {
  readonly name: string;
  /** The type OID ({@link OID} names the built-in ones). */
  readonly dataTypeID: number;
  readonly tableID: number;
  readonly columnID: number;
  readonly dataTypeSize: number;
  readonly dataTypeModifier: number;
}

/** A row by column name. With two columns of one name, the last wins. */
export type Row = Record<string, unknown>;

/** One statement's result. */
export interface QueryResult<R> {
  readonly rows: R[];
  readonly fields: readonly Field[];
  /** The command tag's verb: `SELECT`, `INSERT`, `CREATE`, ... */
  readonly command: string;
  /** Rows the command affected or returned, when its tag says. */
  readonly rowCount: number | null;
}

/** Options of one request. */
export interface QueryOptions {
  readonly signal?: AbortSignal;
  /** How long one attempt may take, from sending to the last byte. */
  readonly timeoutMs?: number;
  /**
   * Run in a read-only transaction: Postgres refuses any write, so the
   * request is idempotent and a failed attempt is retried.
   */
  readonly readOnly?: boolean;
  /**
   * Declares the request safe to send twice (a read, or a write whose
   * repetition changes nothing), so failed attempts are retried. Default
   * false: a write whose response was lost may have run.
   */
  readonly idempotent?: boolean;
}

export type IsolationLevel =
  | "Serializable"
  | "RepeatableRead"
  | "ReadCommitted"
  | "ReadUncommitted";

/** Options of a transaction. */
export interface TransactionOptions extends QueryOptions {
  readonly isolation?: IsolationLevel;
  /** `DEFERRABLE` (with `Serializable` and `readOnly`). */
  readonly deferrable?: boolean;
  /**
   * Run the whole transaction again, up to this many times, when Postgres
   * aborts it for a serialization failure or deadlock (default 0). Safe:
   * an aborted transaction changed nothing.
   */
  readonly retryConflicts?: number;
}

/** Options of a {@link NeonClient}. */
export interface NeonClientOptions {
  /**
   * The endpoint's origin, `https://` without a path. Default: from
   * `integration`, or from `connectionString`'s host.
   */
  readonly baseUrl?: string;
  /** The exe.dev HTTP proxy integration's name; default `neon-serverless`. */
  readonly integration?: string;
  /**
   * `postgresql://user:password@host/db?sslmode=require`, sent as
   * `Neon-Connection-String` with every request. Leave it out when an
   * exe.dev integration injects it.
   */
  readonly connectionString?: string;
  /** Allows `http:` to a loopback `baseUrl`, for a fake in development and tests. */
  readonly allowLoopbackForDevelopment?: boolean;
  readonly types?: TypeOptions;
  /** Per attempt; default 30 s. */
  readonly timeoutMs?: number;
  /** The largest response read; default 16 MiB (Neon's own limit is 10 MB). */
  readonly maxResponseBytes?: number;
  /** Retries, for idempotent requests only. */
  readonly retry?: RetryOptions;
  readonly fetch?: FetchLike;
  readonly runtime?: Runtime;
}

export const DEFAULT_INTEGRATION = "neon-serverless";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

const DEFAULT_RETRY: HttpRetryPolicy = Object.freeze({
  maxRetries: 2,
  backoffInitialMs: 100,
  backoffMaxMs: 2_000,
  backoffJitter: 0.5,
  respectRetryAfter: true,
  maxRetryAfterMs: 10_000,
  budgetMs: 60_000,
  statuses: Object.freeze([502, 503, 504]),
  retryConnectionErrors: true,
  retryTimeouts: true,
});

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** The origin for `options`, checked. */
export function endpointOrigin(
  options: Pick<
    NeonClientOptions,
    | "baseUrl"
    | "integration"
    | "connectionString"
    | "allowLoopbackForDevelopment"
  >,
): string {
  let base = options.baseUrl;
  if (base === undefined && options.connectionString !== undefined) {
    const host = connectionHost(options.connectionString);
    // Neon's driver sends to api.<everything after the endpoint's label>.
    base = `https://${host.replace(/^[^.]+\./, "api.")}`;
  }
  if (base === undefined) {
    const name = options.integration ?? DEFAULT_INTEGRATION;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
      throw new TypeError(`${JSON.stringify(name)} is not an integration name`);
    }
    base = `https://${name}.int.exe.xyz`;
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new TypeError("baseUrl is not a URL");
  }
  if (url.username || url.password) {
    throw new TypeError("baseUrl must not carry credentials");
  }
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError(
      "baseUrl must be an origin, without a path, query or fragment",
    );
  }
  if (url.protocol !== "https:") {
    if (
      !(url.protocol === "http:" && options.allowLoopbackForDevelopment &&
        LOOPBACK.has(url.hostname))
    ) {
      throw new TypeError(
        "baseUrl must be https (http only to loopback with allowLoopbackForDevelopment)",
      );
    }
  }
  return url.origin;
}

function connectionHost(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new TypeError("connectionString is not a postgresql:// URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new TypeError("connectionString is not a postgresql:// URL");
  }
  if (!url.hostname) throw new TypeError("connectionString has no host");
  return url.hostname;
}

/** A Neon SQL-over-HTTP client. */
export class NeonClient {
  /** The `/sql` endpoint. */
  readonly url: string;
  readonly #connectionString?: string;
  readonly #parsers: ReadonlyMap<number, Parser>;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #retry: HttpRetryPolicy;
  readonly #fetch: FetchLike;
  readonly #runtime: Runtime;

  constructor(options: NeonClientOptions = {}) {
    this.url = `${endpointOrigin(options)}/sql`;
    if (options.connectionString !== undefined) {
      connectionHost(options.connectionString);
      this.#connectionString = options.connectionString;
    }
    this.#parsers = parsers(options.types);
    this.#timeoutMs = positive(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxResponseBytes = positive(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.#retry = resolveRetryPolicy(options.retry, DEFAULT_RETRY);
    this.#fetch = options.fetch ?? globalFetch;
    this.#runtime = options.runtime ?? defaultRuntime;
  }

  /** Runs one statement; rows by column name. */
  async query<R extends Row = Row>(
    statement: Statement,
    options: QueryOptions = {},
  ): Promise<QueryResult<R>> {
    if (options.readOnly) {
      const [result] = await this.transaction([statement], {
        ...options,
        readOnly: true,
      });
      return result as QueryResult<R>;
    }
    const body = await this.#post(
      single(statement),
      {},
      options,
      options.idempotent ?? false,
    );
    return this.#result(body, true) as QueryResult<R>;
  }

  /** Runs one statement; rows as arrays, in column order. */
  async arrays(
    statement: Statement,
    options: QueryOptions = {},
  ): Promise<QueryResult<unknown[]>> {
    const headers = options.readOnly ? batchHeaders({ readOnly: true }) : {};
    const payload = options.readOnly
      ? { queries: [single(statement)] }
      : single(statement);
    const body = await this.#post(
      payload,
      headers,
      options,
      (options.idempotent ?? false) || options.readOnly === true,
    );
    const results = options.readOnly ? batchResults(body, 1) : [body];
    return this.#result(results[0], false) as QueryResult<unknown[]>;
  }

  /** The rows of one statement. */
  async rows<R extends Row = Row>(
    statement: Statement,
    options?: QueryOptions,
  ): Promise<R[]> {
    return (await this.query<R>(statement, options)).rows;
  }

  /** The only row of one statement; a `rows` error for none or several. */
  async one<R extends Row = Row>(
    statement: Statement,
    options?: QueryOptions,
  ): Promise<R> {
    const rows = await this.rows<R>(statement, options);
    if (rows.length !== 1) {
      throw new NeonError("response", `expected one row, got ${rows.length}`);
    }
    return rows[0];
  }

  /** The row of one statement, or null; a `response` error for several. */
  async maybeOne<R extends Row = Row>(
    statement: Statement,
    options?: QueryOptions,
  ): Promise<R | null> {
    const rows = await this.rows<R>(statement, options);
    if (rows.length > 1) {
      throw new NeonError(
        "response",
        `expected at most one row, got ${rows.length}`,
      );
    }
    return rows[0] ?? null;
  }

  /** Runs one statement for its effect; the rows it affected. */
  async execute(statement: Statement, options?: QueryOptions): Promise<number> {
    return (await this.query(statement, options)).rowCount ?? 0;
  }

  /**
   * Runs statements as one transaction, committed after the last; any
   * error rolls all of them back and rejects. The results are in order.
   */
  async transaction(
    statements: readonly Statement[],
    options: TransactionOptions = {},
  ): Promise<QueryResult<Row>[]> {
    if (statements.length === 0) return [];
    const payload = { queries: statements.map(single) };
    const headers = batchHeaders(options);
    const idempotent = (options.idempotent ?? false) ||
      options.readOnly === true;
    const attempts = 1 +
      nonNegative(options.retryConflicts ?? 0, "retryConflicts");
    for (let attempt = 1;; attempt++) {
      try {
        const body = await this.#post(payload, headers, options, idempotent);
        return batchResults(body, statements.length).map((result) =>
          this.#result(result, true) as QueryResult<Row>
        );
      } catch (error) {
        if (attempt >= attempts || !isTransientConflict(error)) throw error;
        const delay = backoffDelay(
          this.#retry,
          attempt - 1,
          this.#runtime.random(),
        );
        await this.#runtime.sleep(delay, options.signal);
      }
    }
  }

  async #post(
    payload: unknown,
    extra: Record<string, string>,
    options: QueryOptions,
    idempotent: boolean,
  ): Promise<unknown> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "neon-raw-text-output": "true",
      "neon-array-mode": "true",
      ...extra,
    };
    if (this.#connectionString !== undefined) {
      headers["neon-connection-string"] = this.#connectionString;
    }
    const timeoutMs = positive(
      options.timeoutMs ?? this.#timeoutMs,
      "timeoutMs",
    );
    const started = this.#runtime.now();
    for (let retry = 0;; retry++) {
      const outcome = await this.#attempt(
        body,
        headers,
        timeoutMs,
        options.signal,
      );
      if ("value" in outcome) return outcome.value;
      const { failure, error } = outcome;
      const budget = this.#retry.budgetMs;
      const delay = backoffDelay(this.#retry, retry, this.#runtime.random());
      const inBudget = budget === null ||
        this.#runtime.now() + delay - started < budget;
      if (
        retry >= this.#retry.maxRetries || !inBudget ||
        !mayRetry(this.#retry, failure, { idempotent })
      ) throw error;
      await this.#runtime.sleep(delay, options.signal);
    }
  }

  async #attempt(
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
    outer: AbortSignal | undefined,
  ): Promise<{ value: unknown } | { failure: RetryFailure; error: NeonError }> {
    outer?.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(outer!.reason);
    outer?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const cancel = this.#runtime.setTimer(timeoutMs, () => {
      timedOut = true;
      controller.abort(
        new DOMException("the Neon request timed out", "TimeoutError"),
      );
    });
    const signal = controller.signal;
    const lost = (error: unknown, stage: "connection" | "body") => {
      if (outer?.aborted) throw outer.reason;
      if (timedOut) {
        return {
          failure: { kind: "timeout" } as const,
          error: new NeonError(
            "timeout",
            `no answer from Neon within ${timeoutMs} ms; the statement may have run`,
            { cause: error },
          ),
        };
      }
      return {
        failure: { kind: stage } as const,
        error: new NeonError(
          "network",
          `the connection to Neon failed; the statement may have run: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        ),
      };
    };
    try {
      let response: Response;
      try {
        response = await rejectOnAbort(
          this.#fetch(this.url, { method: "POST", headers, body, signal }),
          signal,
        );
      } catch (error) {
        return lost(error, "connection");
      }
      const requestId = response.headers.get("neon-request-id") ?? undefined;
      const limit = response.ok ? this.#maxResponseBytes : MAX_ERROR_BYTES;
      let bytes: Uint8Array;
      try {
        bytes = await rejectOnAbort(
          readBounded(response, { maxBytes: limit, signal }),
          signal,
        );
      } catch (error) {
        if (error instanceof BoundsError && response.ok) {
          return {
            failure: { kind: "status", status: 507 },
            error: new NeonError(
              "too-large",
              `the response is larger than ${limit} bytes`,
              { status: response.status, requestId },
            ),
          };
        }
        if (error instanceof BoundsError) {
          return {
            failure: { kind: "status", status: response.status },
            error: new NeonError(
              "http",
              `Neon answered ${response.status} with an oversized error`,
              { status: response.status, requestId },
            ),
          };
        }
        return lost(error, "body");
      }
      const text = new TextDecoder().decode(bytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (response.ok) {
        if (parsed === undefined) {
          return {
            failure: { kind: "status", status: 502 },
            error: new NeonError(
              "response",
              "Neon answered 200 with a body that is not JSON",
              { status: 200, requestId },
            ),
          };
        }
        return { value: parsed };
      }
      const fields = errorFields(parsed);
      if (response.status === 507) {
        return {
          failure: { kind: "status", status: 507 },
          error: new NeonError(
            "too-large",
            fields?.message ?? "the response is too large for Neon",
            { status: 507, requestId },
          ),
        };
      }
      if (fields !== null && response.status < 500) {
        const { message, ...rest } = fields;
        return {
          failure: { kind: "status", status: response.status },
          error: new NeonError("postgres", message, {
            ...rest,
            status: response.status,
            requestId,
          }),
        };
      }
      const message = fields?.message ?? text.slice(0, 200);
      return {
        failure: { kind: "status", status: response.status },
        error: new NeonError(
          fields?.code ? "postgres" : "http",
          `Neon answered ${response.status}: ${message}`,
          { ...(fields ?? {}), status: response.status, requestId },
        ),
      };
    } finally {
      cancel();
      outer?.removeEventListener("abort", onAbort);
    }
  }

  #result(body: unknown, byName: boolean): QueryResult<unknown> {
    if (body === null || typeof body !== "object") {
      throw new NeonError("response", "a result is not an object");
    }
    const record = body as Record<string, unknown>;
    if (!Array.isArray(record.fields) || !Array.isArray(record.rows)) {
      throw new NeonError("response", "a result has no fields or rows");
    }
    const fields = record.fields.map((f): Field => {
      const field = f as Record<string, unknown>;
      if (
        typeof field.name !== "string" ||
        !Number.isSafeInteger(field.dataTypeID)
      ) {
        throw new NeonError("response", "a result field is malformed");
      }
      return {
        name: field.name,
        dataTypeID: field.dataTypeID as number,
        tableID: Number(field.tableID ?? 0),
        columnID: Number(field.columnID ?? 0),
        dataTypeSize: Number(field.dataTypeSize ?? -1),
        dataTypeModifier: Number(field.dataTypeModifier ?? -1),
      };
    });
    const parse = fields.map((f) => this.#parsers.get(f.dataTypeID));
    const rows = record.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== fields.length) {
        throw new NeonError("response", "a row does not match its fields");
      }
      const values = row.map((value, i) => {
        if (value === null) return null;
        if (typeof value !== "string") {
          throw new NeonError(
            "response",
            "a value is not text (raw text output was not honoured)",
          );
        }
        const parser = parse[i];
        if (parser === undefined) return value;
        try {
          return parser(value);
        } catch (error) {
          const reason =
            error instanceof ValueParseError || error instanceof Error
              ? error.message
              : String(error);
          throw new NeonError(
            "response",
            `column ${JSON.stringify(fields[i].name)}: ${reason}`,
            { cause: error },
          );
        }
      });
      if (!byName) return values;
      const out: Row = {};
      fields.forEach((field, i) => {
        Object.defineProperty(out, field.name, {
          value: values[i],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      });
      return out;
    });
    const count = record.rowCount;
    return {
      rows,
      fields,
      command: typeof record.command === "string" ? record.command : "",
      rowCount: typeof count === "number" && Number.isSafeInteger(count)
        ? count
        : null,
    };
  }
}

function single(
  statement: Statement,
): { query: string; params: (string | null)[]; arrayMode: true } {
  if (statement instanceof Query) {
    return {
      query: statement.text,
      params: statement.params.map((p, i) => encodeParam(p, `$${i + 1}`)),
      arrayMode: true,
    };
  }
  if (
    statement === null || typeof statement !== "object" ||
    typeof statement.text !== "string"
  ) {
    throw new TypeError("a statement is a sql`...` query or { text, params }");
  }
  return {
    query: statement.text,
    params: (statement.params ?? []).map((p, i) => encodeParam(p, `$${i + 1}`)),
    arrayMode: true,
  };
}

function batchHeaders(options: TransactionOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.isolation !== undefined) {
    if (
      !["Serializable", "RepeatableRead", "ReadCommitted", "ReadUncommitted"]
        .includes(options.isolation)
    ) {
      throw new TypeError(
        `unknown isolation level ${JSON.stringify(options.isolation)}`,
      );
    }
    headers["neon-batch-isolation-level"] = options.isolation;
  }
  if (options.readOnly) headers["neon-batch-read-only"] = "true";
  if (options.deferrable) headers["neon-batch-deferrable"] = "true";
  return headers;
}

function batchResults(body: unknown, count: number): unknown[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== count) {
    throw new NeonError(
      "response",
      `a transaction answered ${
        Array.isArray(results) ? results.length : "no"
      } results for ${count} statements`,
    );
  }
  return results;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}
