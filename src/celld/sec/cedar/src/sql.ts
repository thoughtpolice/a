// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * SQL for a Durable Object's SQLite.
 *
 * Statements are {@link Fragment}s built with the {@link sql} tag, whose
 * interpolations become `?` parameters. A {@link SqlDriver} runs them:
 * reads, and atomic batches of writes whose `expect`ed row counts are
 * checked inside the transaction, which is how the stores in
 * "@celld/sec/cedar/store" do optimistic concurrency without holding a
 * transaction across an `await` (a Durable Object cannot).
 *
 * @module
 */

/** A parameter value; booleans bind as 1 and 0. */
export type SqlValue = string | number | boolean | null;

/** A row as a driver returns it. */
export type Row = Record<string, unknown>;

const PARAM = Symbol("param");
type Part = string | { readonly [PARAM]: SqlValue };

/** A piece of SQL with its parameters kept apart from its text. */
export class Fragment {
  readonly parts: readonly Part[];
  constructor(parts: readonly Part[]) {
    this.parts = parts;
    Object.freeze(this);
  }

  /** Whether this fragment is only text (no parameters), such as a column. */
  get isRaw(): boolean {
    return this.parts.every((part) => typeof part === "string");
  }
}

/**
 * Builds a fragment: interpolated values become parameters, interpolated
 * fragments are spliced in.
 *
 * ```ts
 * const where = sql`owner = ${owner} AND ${raw("created")} > ${since}`;
 * ```
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: readonly (SqlValue | Fragment)[]
): Fragment {
  const parts: Part[] = [];
  strings.forEach((text, i) => {
    if (text) parts.push(text);
    if (i < values.length) {
      const value = values[i];
      if (value instanceof Fragment) parts.push(...value.parts);
      else parts.push(param(value));
    }
  });
  return new Fragment(parts);
}

function param(value: SqlValue): Part {
  switch (typeof value) {
    case "string":
    case "boolean":
      return { [PARAM]: value };
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("a SQL parameter must be a finite number");
      }
      return { [PARAM]: value };
    default:
      if (value === null) return { [PARAM]: null };
      throw new TypeError(`a ${typeof value} cannot be a SQL parameter`);
  }
}

/**
 * Trusted SQL text: a table or column name the application wrote, never a
 * value from a request.
 */
export function raw(text: string): Fragment {
  return new Fragment([text]);
}

/** A SQL identifier, quoted (`"name"`), for names that are not literals in code. */
export function ident(name: string): Fragment {
  if (name.length === 0 || name.includes("\0")) {
    throw new TypeError("bad SQL identifier");
  }
  return raw(`"${name.replaceAll('"', '""')}"`);
}

/** Fragments joined by `separator` (trusted text, such as `" AND "`). */
export function join(
  fragments: readonly Fragment[],
  separator: string,
): Fragment {
  const parts: Part[] = [];
  fragments.forEach((fragment, i) => {
    if (i > 0) parts.push(separator);
    parts.push(...fragment.parts);
  });
  return new Fragment(parts);
}

/** A rendered statement. */
export interface Rendered {
  readonly text: string;
  readonly params: readonly SqlValue[];
}

/** Renders a fragment with `?` placeholders; booleans bind as 1 and 0. */
export function render(fragment: Fragment): Rendered {
  let text = "";
  const params: SqlValue[] = [];
  for (const part of fragment.parts) {
    if (typeof part === "string") {
      text += part;
    } else {
      text += "?";
      const value = part[PARAM];
      params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
  }
  return { text, params };
}

/** A write in a batch, with the rows it must change. */
export interface Statement {
  readonly sql: Fragment;
  /**
   * The rows it must change (a number), or `"some"` for at least one;
   * anything else rolls the batch back with a {@link SqlConflictError}.
   */
  readonly expect?: number | "some";
}

/** A batch rolled back because a statement changed the wrong number of rows. */
export class SqlConflictError extends Error {
  override readonly name = "SqlConflictError";
  /** The index of the statement in its batch. */
  readonly statement: number;
  readonly rows: number;
  constructor(statement: number, rows: number, expected: number | "some") {
    super(
      `statement ${statement} changed ${rows} row(s), expected ${expected}`,
    );
    this.statement = statement;
    this.rows = rows;
  }
}

/** Runs statements against one SQLite database. */
export interface SqlDriver {
  /** Runs a read (or any statement) and returns its rows. */
  query<T extends Row = Row>(statement: Fragment): Promise<T[]>;
  /** Runs writes atomically, checking each `expect`; returns rows changed. */
  batch(statements: readonly Statement[]): Promise<number[]>;
  /** Runs DDL (`CREATE TABLE IF NOT EXISTS ...`), one statement per fragment. */
  migrate(statements: readonly Fragment[]): Promise<void>;
}

function check(index: number, rows: number, expect: Statement["expect"]): void {
  if (expect === undefined) return;
  if (expect === "some" ? rows < 1 : rows !== expect) {
    throw new SqlConflictError(index, rows, expect);
  }
}

// MARK: Durable Objects

/** Options for {@link durableObjectSql}. */
export interface DurableObjectSqlOptions {
  /**
   * Wait for `storage.sync()` after each batch (default true), so a write is
   * durable in the fleet before the caller hears it succeeded.
   */
  readonly sync?: boolean;
}

/**
 * A driver over a Durable Object's SQLite. Statements run synchronously
 * (celld's `sql.exec`), and a batch is one `transactionSync`.
 */
export function durableObjectSql(
  storage: DurableObjectStorage,
  options: DurableObjectSqlOptions = {},
): SqlDriver & {
  /** The synchronous read, for code already inside the object. */
  querySync<T extends Row = Row>(statement: Fragment): T[];
} {
  const sync = options.sync ?? true;
  const exec = (fragment: Fragment) => {
    const { text, params } = render(fragment);
    return storage.sql.exec(text, ...(params as SqlStorageBindable[]));
  };
  const querySync = <T extends Row>(statement: Fragment): T[] =>
    exec(statement).toArray() as unknown as T[];
  return {
    querySync,
    query: <T extends Row>(statement: Fragment) =>
      Promise.resolve(querySync<T>(statement)),
    async batch(statements) {
      const rows = storage.transactionSync(() =>
        statements.map((statement, i) => {
          const cursor = exec(statement.sql);
          cursor.toArray();
          check(i, cursor.rowsWritten, statement.expect);
          return cursor.rowsWritten;
        })
      );
      if (sync && statements.length > 0) await storage.sync();
      return rows;
    },
    migrate(statements) {
      storage.transactionSync(() => {
        for (const statement of statements) exec(statement).toArray();
      });
      return Promise.resolve();
    },
  };
}
