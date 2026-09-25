// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading schemas as data, imported as "@celld/sieve/introspect": for code
 * generators, documentation, and `@celld/sieve/json-schema`, which is built
 * on it.
 *
 * Every schema's `def` is a frozen descriptor (the types are below): a
 * `kind`, its `checks` with their parameters, its children and its `meta`.
 * {@link childrenOf} lists a schema's children as labelled edges, and
 * {@link walk} visits a whole tree once per schema, following lazy schemas,
 * so recursive types terminate.
 *
 * ```ts
 * import { idOf, walk } from "@celld/sieve/introspect";
 *
 * walk(Api, (schema, trail) => {
 *   const id = idOf(schema);
 *   if (id !== undefined) console.log(id, trail.map((edge) => edge.key));
 * });
 * ```
 *
 * The format is versioned by {@link DEF_VERSION}. Within a version, new
 * kinds, check names, optional fields and meta keys may be added, but no
 * field changes meaning or goes away; anything else bumps the version.
 *
 * @module
 */

import type { SchemaDef } from "./def.ts";
import { type AnySchema, Schema } from "./schema.ts";

export type * from "./def.ts";

/** The version of the definition format. */
export const DEF_VERSION = 1;

/** Whether `value` is a sieve schema. */
export function isSchema(value: unknown): value is AnySchema {
  return value instanceof Schema;
}

/** A schema's definition. */
export function defOf(schema: AnySchema): SchemaDef {
  return schema.def;
}

/** The schema's `meta.id`: its name in JSON Schema and generated code. */
export function idOf(schema: AnySchema): string | undefined {
  return schema.def.meta?.id;
}

/** Follows lazy schemas to the schema they stand for. */
export function resolveLazy(schema: AnySchema): AnySchema {
  let current = schema;
  const seen = new Set<AnySchema>();
  while (current.def.kind === "lazy") {
    if (seen.has(current)) {
      throw new Error("sieve: a lazy schema returns itself");
    }
    seen.add(current);
    current = current.def.getter();
  }
  return current;
}

/** How a child hangs off its parent. */
export type EdgeRole =
  | "shape"
  | "catchall"
  | "element"
  | "item"
  | "rest"
  | "key"
  | "value"
  | "option"
  | "left"
  | "right"
  | "target"
  | "inner"
  | "in"
  | "out";

/**
 * A child schema. `key` is the object key for `shape` edges and the
 * position for `item` and `option` edges.
 */
export interface Edge {
  readonly role: EdgeRole;
  readonly key?: string | number;
  readonly schema: AnySchema;
}

/** The direct children of a schema, in definition order. */
export function childrenOf(schema: AnySchema): Edge[] {
  const def = schema.def;
  switch (def.kind) {
    case "object": {
      const edges: Edge[] = Object.entries(def.shape).map(([key, child]) => ({
        role: "shape",
        key,
        schema: child,
      }));
      if (def.catchall !== undefined) {
        edges.push({ role: "catchall", schema: def.catchall });
      }
      return edges;
    }
    case "array":
      return [{ role: "element", schema: def.element }];
    case "tuple": {
      const edges: Edge[] = def.items.map((item, key) => ({
        role: "item",
        key,
        schema: item,
      }));
      if (def.rest !== undefined) {
        edges.push({ role: "rest", schema: def.rest });
      }
      return edges;
    }
    case "record":
    case "map":
      return [
        { role: "key", schema: def.key },
        { role: "value", schema: def.value },
      ];
    case "set":
      return [{ role: "value", schema: def.value }];
    case "union":
    case "discriminated_union":
      return def.options.map((option, key) => ({
        role: "option",
        key,
        schema: option,
      }));
    case "intersection":
      return [
        { role: "left", schema: def.left },
        { role: "right", schema: def.right },
      ];
    case "lazy":
      return [{ role: "target", schema: def.getter() }];
    case "optional":
    case "nullable":
    case "readonly":
    case "default":
    case "catch":
      return [{ role: "inner", schema: def.inner }];
    case "pipe":
      return [
        { role: "in", schema: def.in },
        { role: "out", schema: def.out },
      ];
    default:
      return [];
  }
}

/**
 * Called for each schema with the edges from the root to it. Returning
 * `false` skips the schema's children.
 */
export type Visitor = (
  schema: AnySchema,
  trail: readonly Edge[],
) => void | false;

/**
 * Visits `root` and everything under it depth first, parents before
 * children, each schema instance once (the first path to it wins).
 */
export function walk(root: AnySchema, visitor: Visitor): void {
  const seen = new Set<AnySchema>();
  const visit = (schema: AnySchema, trail: readonly Edge[]) => {
    if (seen.has(schema)) return;
    seen.add(schema);
    if (visitor(schema, trail) === false) return;
    for (const edge of childrenOf(schema)) visit(edge.schema, [...trail, edge]);
  };
  visit(root, []);
}

/**
 * Whether parsing can change the value: a transform, default, catch,
 * string rewrite or coercion somewhere in the tree. When it cannot, the
 * output is the input (minus stripped keys) and `schema.is` is sound.
 */
export function transforms(root: AnySchema): boolean {
  let found = false;
  walk(root, (schema) => {
    const def = schema.def;
    if (
      def.kind === "transform" || def.kind === "default" ||
      def.kind === "catch" || ("coerce" in def && def.coerce) ||
      def.checks.some((check) =>
        check.check === "trim" || check.check === "to_lower_case" ||
        check.check === "to_upper_case"
      )
    ) {
      found = true;
    }
    return found ? false : undefined;
  });
  return found;
}
