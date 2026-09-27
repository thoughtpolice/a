// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in for Neon's SQL endpoint, for tests of code that uses
 * `NeonClient`: pass `fake.fetch` as the client's `fetch`.
 *
 * ```ts
 * const fake = new FakeNeon((call) => resultOf([["id", OID.int4]], [["1"]]));
 * const client = new NeonClient({ fetch: fake.fetch });
 * ```
 *
 * It answers what `answer` returns for each statement (a batch calls it
 * once per statement and fails whole when one throws a {@link FakePgError}),
 * and records every request in `calls`. It runs no SQL.
 *
 * @module
 */

import type { FetchLike } from "@celld/http";

/** One statement as the fake received it. */
export interface FakeCall {
  readonly query: string;
  readonly params: readonly (string | null)[];
  readonly headers: Readonly<Record<string, string>>;
  /** Its index in a batch, or null for a single statement. */
  readonly batchIndex: number | null;
}

/** A result in Neon's array-mode, raw-text shape. */
export interface FakeResult {
  readonly fields: readonly {
    readonly name: string;
    readonly dataTypeID: number;
  }[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly command?: string;
  readonly rowCount?: number | null;
}

/** Throw it from an answer to fail the request as Postgres would. */
export class FakePgError extends Error {
  readonly code: string;
  readonly fields: Readonly<Record<string, string | number>>;
  constructor(
    code: string,
    message: string,
    fields: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.code = code;
    this.fields = fields;
  }
}

/** A result from columns (`[name, oid]`) and text rows. */
export function resultOf(
  columns: readonly (readonly [string, number])[],
  rows: readonly (readonly (string | null)[])[],
  command = "SELECT",
): FakeResult {
  return {
    fields: columns.map(([name, dataTypeID]) => ({ name, dataTypeID })),
    rows,
    command,
    rowCount: rows.length,
  };
}

/** A fake Neon endpoint. */
export class FakeNeon {
  readonly calls: FakeCall[] = [];
  readonly #answer: (call: FakeCall) => FakeResult | Promise<FakeResult>;

  constructor(answer: (call: FakeCall) => FakeResult | Promise<FakeResult>) {
    this.#answer = answer;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => headers[key] = value);
    const body = await request.json() as {
      query?: string;
      params?: (string | null)[];
      queries?: { query: string; params?: (string | null)[] }[];
    };
    try {
      if (body.queries !== undefined) {
        const results = [];
        for (const [i, q] of body.queries.entries()) {
          const call = {
            query: q.query,
            params: q.params ?? [],
            headers,
            batchIndex: i,
          };
          this.calls.push(call);
          results.push(shape(await this.#answer(call)));
        }
        return Response.json({ results });
      }
      const call = {
        query: body.query ?? "",
        params: body.params ?? [],
        headers,
        batchIndex: null,
      };
      this.calls.push(call);
      return Response.json(shape(await this.#answer(call)));
    } catch (error) {
      if (!(error instanceof FakePgError)) throw error;
      return Response.json(
        {
          message: error.message,
          code: error.code,
          severity: "ERROR",
          ...error.fields,
          "neon:retryable": false,
        },
        { status: 400 },
      );
    }
  };
}

function shape(result: FakeResult) {
  return {
    fields: result.fields.map((f) => ({
      name: f.name,
      dataTypeID: f.dataTypeID,
      tableID: 0,
      columnID: 0,
      dataTypeSize: -1,
      dataTypeModifier: -1,
      format: "text",
    })),
    rows: result.rows,
    command: result.command ?? "SELECT",
    rowCount: result.rowCount ?? result.rows.length,
    rowAsArray: true,
  };
}
