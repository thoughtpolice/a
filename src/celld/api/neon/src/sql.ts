// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `sql` template: statements whose interpolations are always
 * parameters (`$1`, `$2`, ...), never text.
 *
 * ```ts
 * const q = sql`SELECT * FROM docs WHERE owner = ${owner} AND tags && ${tags}`;
 * // { text: "SELECT * FROM docs WHERE owner = $1 AND tags && $2", params: [...] }
 * ```
 *
 * A `Query` interpolated into another is spliced in with its parameters
 * renumbered; `ident` quotes a name and `raw` inserts trusted text.
 *
 * @module
 */

const PARAM = Symbol("param");
type Part = string | { readonly [PARAM]: unknown };

/** A statement: text with `$n` placeholders, and its parameters. */
export class Query {
  readonly #parts: readonly Part[];
  #rendered: { text: string; params: unknown[] } | null = null;

  constructor(parts: readonly Part[]) {
    this.#parts = parts;
  }

  /** The text, with `$1`, `$2`, ... for the parameters. */
  get text(): string {
    return this.#render().text;
  }

  /** The parameters, in placeholder order (not yet encoded). */
  get params(): readonly unknown[] {
    return this.#render().params;
  }

  /** The parts, for splicing into another query. */
  get parts(): readonly Part[] {
    return this.#parts;
  }

  #render() {
    if (this.#rendered !== null) return this.#rendered;
    let text = "";
    const params: unknown[] = [];
    for (const part of this.#parts) {
      if (typeof part === "string") {
        text += part;
      } else {
        params.push(part[PARAM]);
        text += `$${params.length}`;
      }
    }
    return this.#rendered = { text, params };
  }
}

/** Builds a query; interpolated values are parameters, queries are spliced. */
export function sql(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Query {
  const parts: Part[] = [];
  strings.forEach((text, i) => {
    if (text) parts.push(text);
    if (i < values.length) {
      const value = values[i];
      if (value instanceof Query) parts.push(...value.parts);
      else parts.push({ [PARAM]: value });
    }
  });
  return new Query(parts);
}

/** Trusted SQL text, never a request value. */
export function raw(text: string): Query {
  return new Query([text]);
}

/** A quoted identifier (`"name"`, or `"schema"."name"` for a list). */
export function ident(name: string | readonly string[]): Query {
  const names = typeof name === "string" ? [name] : name;
  if (
    names.length === 0 ||
    names.some((n) =>
      typeof n !== "string" || n.length === 0 || n.includes("\0")
    )
  ) {
    throw new TypeError("an identifier must be a non-empty string without NUL");
  }
  return raw(names.map((n) => `"${n.replaceAll('"', '""')}"`).join("."));
}

/** Queries joined by `separator` (trusted text). */
export function join(queries: readonly Query[], separator = ", "): Query {
  const parts: Part[] = [];
  queries.forEach((query, i) => {
    if (i > 0) parts.push(separator);
    parts.push(...query.parts);
  });
  return new Query(parts);
}
