// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Policy-backed queries: "which documents may Alice read?" as a SQL
 * `WHERE` clause, from partial evaluation, instead of fetching every row
 * and asking Cedar about each.
 *
 * ```ts
 * import { planQuery } from "@celld/sec/cedar/query";
 * import { render, sql } from "@celld/sec/cedar/sql";
 *
 * const { where } = await planQuery(authorizer, { principal: alice, action: "read", context }, {
 *   type: "Doc",
 *   id: "d.id",
 *   attributes: {
 *     owner: { column: "d.owner_id", type: "entity", entityType: "User" },
 *     public: { column: "d.public", type: "bool" },
 *     classification: { column: "d.classification", type: "long" },
 *   },
 *   in: (folder) => folder.type === "Folder" ? sql`d.id IN (SELECT doc FROM doc_folders WHERE folder = ${folder.id})` : false,
 * });
 * const { text, params } = render(sql`SELECT d.* FROM docs d WHERE ${where}`);
 * ```
 *
 * The filter is exact, errors included. Cedar skips a policy whose
 * condition errors (reading an attribute a resource does not have), so a
 * condition compiles to SQL that is NULL exactly where Cedar's would error,
 * `&&`, `||` and `if` short-circuit as Cedar's do (`CASE a WHEN TRUE ...`),
 * and each policy is `COALESCE(condition, FALSE)`. The result is
 * `(any permit) AND NOT (any forbid)`, Cedar's own rule.
 *
 * What does not compile throws {@link QueryUnsupported} naming the policy:
 * arithmetic, extension functions on attributes, attributes compared with
 * attributes, entity attributes dereferenced without a column for the
 * path, tags. Fall back to `Authorizer.filter` over fetched rows then.
 *
 * The mapping is the application's promise about its table: a column is
 * NULL exactly when the resource lacks that attribute, entity columns hold
 * ids of one type, and `in` answers Cedar's `in` (the resource's
 * ancestors, which Cedar computes over the entities it is given). Columns
 * given as strings are trusted SQL text.
 *
 * @module
 */

import type { Authorizer, PartialRequest, Residuals } from "./authorizer.ts";
import type * as ffi from "./ffi.ts";
import { Fragment, join, raw, sql, type SqlValue } from "./sql.ts";
import { type EntityUid, formatUid, uid, uidFromJson } from "./values.ts";

/** A residual this module cannot turn into a filter. */
export class QueryUnsupported extends Error {
  override readonly name = "QueryUnsupported";
  readonly policyId?: string;
  constructor(message: string, policyId?: string) {
    super(
      policyId === undefined
        ? message
        : `policy ${JSON.stringify(policyId)}: ${message}`,
    );
    this.policyId = policyId;
  }
}

/** A literal a filter compares with. */
export type Literal = string | number | boolean | EntityUid;

/**
 * A condition on one resource, with Cedar's semantics: it is true, false,
 * or an error (which a policy treats as not applying).
 */
export type Filter =
  | { readonly kind: "const"; readonly value: boolean }
  | { readonly kind: "error"; readonly reason: string }
  | {
    readonly kind: "and" | "or";
    readonly left: Filter;
    readonly right: Filter;
  }
  | { readonly kind: "not"; readonly arg: Filter }
  | {
    readonly kind: "if";
    readonly cond: Filter;
    readonly then: Filter;
    readonly else: Filter;
  }
  /** Errors become false: whether a policy applies. */
  | { readonly kind: "applies"; readonly arg: Filter }
  /** A boolean attribute used as a condition. */
  | { readonly kind: "attr"; readonly path: readonly string[] }
  | {
    readonly kind: "eq";
    readonly path: readonly string[];
    readonly value: Literal;
  }
  | {
    readonly kind: "cmp";
    readonly path: readonly string[];
    readonly op: "<" | "<=" | ">" | ">=";
    readonly value: number;
  }
  /**
   * `resource.a.b has c` for the path `[a, b, c]`: an error when
   * `resource.a.b` is (missing, or not a record or entity), as Cedar's.
   */
  | { readonly kind: "has"; readonly path: readonly string[] }
  /**
   * True when `resource.path` can be read, an error when it cannot: an
   * operand Cedar evaluates for its errors alone (`[].contains(resource.x)`).
   */
  | { readonly kind: "defined"; readonly path: readonly string[] }
  /** `resource == value`. */
  | { readonly kind: "self"; readonly value: EntityUid }
  /** `resource in ancestor` (reflexive). */
  | { readonly kind: "in"; readonly ancestor: EntityUid }
  /**
   * `resource.path in [ancestors]` (reflexive): an error when the
   * attribute is missing or not an entity, even with no ancestors.
   */
  | {
    readonly kind: "attrIn";
    readonly path: readonly string[];
    readonly ancestors: readonly EntityUid[];
  }
  | {
    readonly kind: "like";
    readonly path: readonly string[];
    readonly pattern: readonly ffi.PatternElem[];
  }
  | {
    readonly kind: "contains";
    readonly path: readonly string[];
    readonly value: Literal;
  };

export const TRUE: Filter = Object.freeze({ kind: "const", value: true });
export const FALSE: Filter = Object.freeze({ kind: "const", value: false });

// MARK: Residuals to filters

/** What an expression is, as far as a filter needs to know. */
type Term =
  | { readonly t: "lit"; readonly value: ffi.CedarValueJson }
  | { readonly t: "attr"; readonly path: readonly string[] }
  | { readonly t: "resource" }
  | { readonly t: "bool"; readonly filter: Filter };

/**
 * The filter of partial evaluation's answer for resources of type
 * `resourceType`: true for exactly the resources the full request would
 * allow.
 */
export function compileResiduals(
  residuals: Residuals,
  resourceType: string,
): Filter {
  if (residuals.invalid !== undefined) {
    throw new QueryUnsupported(
      `the request is invalid: ${
        residuals.invalid.map((d) => d.message).join("; ")
      }`,
    );
  }
  if (residuals.decision !== null) {
    return residuals.decision === "allow" ? TRUE : FALSE;
  }
  const errored = new Set(residuals.errored);
  const permits: Filter[] = [];
  const forbids: Filter[] = [];
  // Cedar answers residuals from a hash map; sorting by id makes the same
  // policies compile to the same SQL text every time.
  const ordered = [...residuals.residuals].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  for (const residual of ordered) {
    if (errored.has(residual.id)) continue;
    const condition = compilePolicy(residual.policy, resourceType, residual.id);
    (residual.effect === "permit" ? permits : forbids).push(applies(condition));
  }
  return and(anyOf(permits), not(anyOf(forbids)));
}

function compilePolicy(
  policy: ffi.PolicyJson,
  resourceType: string,
  id: string,
): Filter {
  const c = new Compiler(resourceType, id);
  if (policy.principal.op !== "All" || policy.action.op !== "All") {
    throw new QueryUnsupported("the principal and action must be known", id);
  }
  let filter = c.scope(policy.resource);
  for (const clause of policy.conditions) {
    const body = c.bool(clause.body);
    filter = and(filter, clause.kind === "when" ? body : not(body));
  }
  return filter;
}

class Compiler {
  readonly #type: string;
  readonly #id: string;
  constructor(resourceType: string, id: string) {
    this.#type = resourceType;
    this.#id = id;
  }

  #unsupported(what: string): never {
    throw new QueryUnsupported(what, this.#id);
  }

  scope(scope: ffi.ScopeConstraint): Filter {
    switch (scope.op) {
      case "All":
        return TRUE;
      case "==":
        return "entity" in scope
          ? this.#self(uidFromJson(scope.entity))
          : this.#unsupported("an unlinked slot");
      case "in":
        return "entity" in scope
          ? this.#in(uidFromJson(scope.entity))
          : this.#unsupported("an unlinked slot");
      case "is": {
        if (scope.entity_type !== this.#type) return FALSE;
        if (scope.in === undefined) return TRUE;
        return "entity" in scope.in
          ? this.#in(uidFromJson(scope.in.entity))
          : this.#unsupported("an unlinked slot");
      }
    }
  }

  #self(value: EntityUid): Filter {
    return value.type === this.#type ? { kind: "self", value } : FALSE;
  }

  #in(ancestor: EntityUid): Filter {
    return { kind: "in", ancestor };
  }

  /** The expression as a condition. */
  bool(expr: ffi.Expr): Filter {
    const term = this.term(expr);
    switch (term.t) {
      case "bool":
        return term.filter;
      case "lit":
        return typeof term.value === "boolean"
          ? { kind: "const", value: term.value }
          : error("a non-boolean condition");
      case "attr":
        return { kind: "attr", path: term.path };
      case "resource":
        return error("an entity used as a condition");
    }
  }

  term(expr: ffi.Expr): Term {
    const [key] = Object.keys(expr);
    const node = (expr as Record<string, unknown>)[key];
    switch (key) {
      case "Value":
        return { t: "lit", value: node as ffi.CedarValueJson };
      case "Var":
        return node === "resource"
          ? { t: "resource" }
          : this.#unsupported(`an unknown ${String(node)}`);
      case "unknown": {
        const [arg] = node as ffi.Expr[];
        const name = arg !== undefined && "Value" in arg
          ? arg.Value
          : undefined;
        return name === "resource"
          ? { t: "resource" }
          : this.#unsupported(`an unknown ${JSON.stringify(name)}`);
      }
      case "Set": {
        const items = (node as ffi.Expr[]).map((item) => this.term(item));
        if (items.every((item) => item.t === "lit")) {
          return {
            t: "lit",
            value: items.map((item) =>
              (item as { value: ffi.CedarValueJson }).value
            ),
          };
        }
        return this.#unsupported("a set built from resource attributes");
      }
      case ".": {
        const { left, attr } = node as { left: ffi.Expr; attr: string };
        const base = this.term(left);
        if (base.t === "resource") return { t: "attr", path: [attr] };
        if (base.t === "attr") return { t: "attr", path: [...base.path, attr] };
        if (base.t === "lit" && isRecord(base.value)) {
          const value =
            (base.value as Record<string, ffi.CedarValueJson>)[attr];
          return value === undefined
            ? { t: "bool", filter: error(`no attribute ${attr}`) }
            : { t: "lit", value };
        }
        return this.#unsupported(
          "an attribute of something other than the resource",
        );
      }
      case "!":
        return {
          t: "bool",
          filter: not(this.bool((node as { arg: ffi.Expr }).arg)),
        };
      case "&&":
      case "||": {
        const { left, right } = node as { left: ffi.Expr; right: ffi.Expr };
        const l = this.bool(left);
        const r = this.bool(right);
        return { t: "bool", filter: key === "&&" ? and(l, r) : or(l, r) };
      }
      case "if-then-else": {
        const branches = node as {
          if: ffi.Expr;
          then: ffi.Expr;
          else: ffi.Expr;
        };
        return {
          t: "bool",
          filter: ite(
            this.bool(branches.if),
            this.bool(branches.then),
            this.bool(branches.else),
          ),
        };
      }
      case "==":
      case "!=": {
        const { left, right } = node as { left: ffi.Expr; right: ffi.Expr };
        const equal = this.#equal(this.term(left), this.term(right));
        return { t: "bool", filter: key === "==" ? equal : not(equal) };
      }
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const { left, right } = node as { left: ffi.Expr; right: ffi.Expr };
        return {
          t: "bool",
          filter: this.#compare(key, this.term(left), this.term(right)),
        };
      }
      case "in": {
        const { left, right } = node as { left: ffi.Expr; right: ffi.Expr };
        return {
          t: "bool",
          filter: this.#membership(this.term(left), this.term(right)),
        };
      }
      case "has": {
        const { left, attr } = node as {
          left: ffi.Expr;
          attr: string | string[];
        };
        const base = this.term(left);
        const attrs = typeof attr === "string" ? [attr] : attr;
        if (
          (base.t !== "resource" && base.t !== "attr") || attrs.length === 0
        ) {
          return this.#unsupported(
            "`has` on something other than the resource",
          );
        }
        // `e has a.b` is `e has a && e.a has b`: a missing `a` is false,
        // where `e.a has b` is an error.
        let path = base.t === "attr" ? base.path : [];
        let filter = TRUE;
        for (const name of attrs) {
          path = [...path, name];
          filter = and(filter, { kind: "has", path });
        }
        return { t: "bool", filter };
      }
      case "is": {
        const test = node as {
          left: ffi.Expr;
          entity_type: string;
          in?: ffi.Expr;
        };
        const base = this.term(test.left);
        if (base.t !== "resource") {
          return this.#unsupported("`is` on something other than the resource");
        }
        if (test.entity_type !== this.#type) {
          return { t: "bool", filter: FALSE };
        }
        return {
          t: "bool",
          filter: test.in === undefined
            ? TRUE
            : this.#membership(base, this.term(test.in)),
        };
      }
      case "like": {
        const { left, pattern } = node as {
          left: ffi.Expr;
          pattern: ffi.PatternElem[];
        };
        const base = this.term(left);
        if (base.t === "attr") {
          return {
            t: "bool",
            filter: { kind: "like", path: base.path, pattern },
          };
        }
        if (base.t === "lit") {
          return {
            t: "bool",
            filter: typeof base.value === "string"
              ? { kind: "const", value: matchLike(base.value, pattern) }
              : error("like on a non-string"),
          };
        }
        return this.#unsupported("like on the resource");
      }
      case "contains": {
        const { left, right } = node as { left: ffi.Expr; right: ffi.Expr };
        const set = this.term(left);
        const item = this.term(right);
        if (set.t === "attr" && item.t === "lit") {
          const literal = toLiteral(item.value);
          if (literal === undefined) {
            return this.#unsupported("contains of a set or record");
          }
          return {
            t: "bool",
            filter: { kind: "contains", path: set.path, value: literal },
          };
        }
        if (set.t === "lit" && Array.isArray(set.value)) {
          if (item.t === "lit") {
            return {
              t: "bool",
              filter: {
                kind: "const",
                value: set.value.some((v) => this.#same(v, item.value)),
              },
            };
          }
          if (item.t === "bool") {
            return this.#unsupported("comparing conditions");
          }
          // [a, b].contains(resource.x) is resource.x == a || resource.x == b,
          // and [].contains(resource.x) is still an error when resource.x is.
          const any = set.value.reduce<Filter>(
            (acc, v) => or(acc, this.#equal(item, { t: "lit", value: v })),
            FALSE,
          );
          return {
            t: "bool",
            filter: item.t === "attr" && set.value.length === 0
              ? {
                kind: "and",
                left: { kind: "defined", path: item.path },
                right: FALSE,
              }
              : any,
          };
        }
        return this.#unsupported("contains on the resource");
      }
      default:
        return this.#unsupported(`the operator ${JSON.stringify(key)}`);
    }
  }

  #equal(left: Term, right: Term): Filter {
    if (left.t === "lit" && right.t !== "lit") return this.#equal(right, left);
    if (left.t === "bool" || right.t === "bool") {
      return this.#unsupported("comparing conditions");
    }
    if (right.t !== "lit") {
      return this.#unsupported(
        "comparing an attribute or the resource with another",
      );
    }
    switch (left.t) {
      case "lit":
        return { kind: "const", value: this.#same(left.value, right.value) };
      case "resource": {
        const entity = asEntity(right.value);
        return entity === undefined ? FALSE : this.#self(entity);
      }
      case "attr": {
        const literal = toLiteral(right.value);
        if (literal === undefined) {
          return this.#unsupported(
            "comparing an attribute with a set or record",
          );
        }
        return { kind: "eq", path: left.path, value: literal };
      }
    }
  }

  /** Cedar's `==` on two literals, folded; extension values are not. */
  #same(a: ffi.CedarValueJson, b: ffi.CedarValueJson): boolean {
    if (hasExtension(a) || hasExtension(b)) {
      return this.#unsupported("comparing extension values");
    }
    return sameValue(a, b);
  }

  #compare(op: "<" | "<=" | ">" | ">=", left: Term, right: Term): Filter {
    const flipped = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as const;
    // Cedar orders datetimes and durations with `<` too.
    for (const side of [left, right]) {
      if (side.t === "lit" && hasExtension(side.value)) {
        return this.#unsupported("ordering extension values");
      }
    }
    if (left.t === "lit" && right.t === "attr") {
      return this.#compare(flipped[op], right, left);
    }
    if (left.t === "lit" && right.t === "lit") {
      if (typeof left.value !== "number" || typeof right.value !== "number") {
        return error("< on a non-integer");
      }
      const [a, b] = [left.value, right.value];
      return {
        kind: "const",
        value: op === "<"
          ? a < b
          : op === "<="
          ? a <= b
          : op === ">"
          ? a > b
          : a >= b,
      };
    }
    if (left.t === "attr" && right.t === "lit") {
      return typeof right.value === "number"
        ? { kind: "cmp", path: left.path, op, value: right.value }
        : error("< on a non-integer");
    }
    return this.#unsupported(
      "comparing an attribute with another, or datetime and decimal ordering",
    );
  }

  #membership(left: Term, right: Term): Filter {
    if (right.t !== "lit") {
      return this.#unsupported("`in` something other than a literal entity");
    }
    if (left.t !== "resource" && left.t !== "attr") {
      return this.#unsupported(
        "`in` on something other than the resource or its attributes",
      );
    }
    const ancestors = Array.isArray(right.value)
      ? right.value.map(asEntity)
      : [asEntity(right.value)];
    if (ancestors.some((a) => a === undefined)) {
      return error("`in` a non-entity");
    }
    // The left side is read (and must be an entity) even when the set is
    // empty; only the resource itself cannot fail.
    if (left.t === "attr") {
      return {
        kind: "attrIn",
        path: left.path,
        ancestors: ancestors as EntityUid[],
      };
    }
    return (ancestors as EntityUid[]).reduce<Filter>(
      (acc, ancestor) => or(acc, this.#in(ancestor)),
      FALSE,
    );
  }
}

function error(reason: string): Filter {
  return { kind: "error", reason };
}

function isRecord(value: ffi.CedarValueJson): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !("__entity" in value) && !("__extn" in value);
}

function asEntity(value: ffi.CedarValueJson): EntityUid | undefined {
  if (
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    "__entity" in value
  ) {
    return uidFromJson(value as ffi.EntityUidJson);
  }
  return undefined;
}

function toLiteral(value: ffi.CedarValueJson): Literal | undefined {
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) return value;
  return asEntity(value);
}

function hasExtension(value: ffi.CedarValueJson): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasExtension);
  if ("__extn" in value) return true;
  return !("__entity" in value) &&
    Object.values(value as Record<string, ffi.CedarValueJson>).some(
      hasExtension,
    );
}

/** Cedar's `==` on values without extension values. */
function sameValue(a: ffi.CedarValueJson, b: ffi.CedarValueJson): boolean {
  const ea = asEntity(a);
  const eb = asEntity(b);
  if (ea !== undefined || eb !== undefined) {
    return ea !== undefined && eb !== undefined &&
      formatUid(ea) === formatUid(eb);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    // Sets: equal as sets.
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.every((x) => b.some((y) => sameValue(x, y))) &&
      b.every((y) => a.some((x) => sameValue(x, y)));
  }
  if (isRecord(a) || isRecord(b)) {
    // Records: the same keys, whatever their order, with equal values.
    if (!isRecord(a) || !isRecord(b)) return false;
    const ra = a as Record<string, ffi.CedarValueJson>;
    const rb = b as Record<string, ffi.CedarValueJson>;
    const keys = Object.keys(ra);
    return keys.length === Object.keys(rb).length &&
      keys.every((k) => Object.hasOwn(rb, k) && sameValue(ra[k], rb[k]));
  }
  return a === b;
}

/** Cedar's `like`: `*` matches any run of characters. */
export function matchLike(
  text: string,
  pattern: readonly ffi.PatternElem[],
): boolean {
  const chars = [...text];
  type Elem = "*" | { readonly c: string };
  const elems = pattern.flatMap((p): Elem[] =>
    p === "Wildcard" ? ["*"] : [...p.Literal].map((c) => ({ c }))
  );
  // Classic wildcard matching with backtracking over the last star.
  let t = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (t < chars.length) {
    const e = elems[p];
    if (p < elems.length && e !== "*" && e.c === chars[t]) {
      t++;
      p++;
    } else if (p < elems.length && e === "*") {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < elems.length && elems[p] === "*") p++;
  return p === elems.length;
}

// Constructors that fold constants without changing error behaviour:
// `false && x` is false and `true && x` is x, but `x && false` still
// errors when x does.

export function and(left: Filter, right: Filter): Filter {
  if (left.kind === "const") return left.value ? right : FALSE;
  if (left.kind === "error") return left;
  if (right.kind === "const") {
    // `x && true` is x, errors included; `x && false` is false only when
    // x cannot error.
    if (right.value) return left;
    if (isTotal(left)) return FALSE;
  }
  return { kind: "and", left, right };
}

export function or(left: Filter, right: Filter): Filter {
  if (left.kind === "const") return left.value ? TRUE : right;
  if (left.kind === "error") return left;
  if (right.kind === "const") {
    if (!right.value) return left;
    if (isTotal(left)) return TRUE;
  }
  return { kind: "or", left, right };
}

export function not(arg: Filter): Filter {
  if (arg.kind === "const") return { kind: "const", value: !arg.value };
  if (arg.kind === "not") return arg.arg;
  return arg.kind === "error" ? arg : { kind: "not", arg };
}

function ite(cond: Filter, then: Filter, otherwise: Filter): Filter {
  if (cond.kind === "const") return cond.value ? then : otherwise;
  if (cond.kind === "error") return cond;
  return { kind: "if", cond, then, else: otherwise };
}

function applies(arg: Filter): Filter {
  if (arg.kind === "const") return arg;
  if (arg.kind === "error") return FALSE;
  return isTotal(arg) ? arg : { kind: "applies", arg };
}

function anyOf(filters: readonly Filter[]): Filter {
  return filters.reduce<Filter>((acc, f) => or(acc, f), FALSE);
}

/** Whether a filter can never be an error (so `x && true` is `x`). */
function isTotal(filter: Filter): boolean {
  switch (filter.kind) {
    case "const":
    case "applies":
    case "self":
    case "in":
      return true;
    case "has":
      // `resource has a` cannot fail; `resource.a has b` can.
      return filter.path.length === 1;
    case "not":
      return isTotal(filter.arg);
    case "and":
    case "or":
      return isTotal(filter.left) && isTotal(filter.right);
    case "if":
      return isTotal(filter.cond) && isTotal(filter.then) &&
        isTotal(filter.else);
    default:
      return false;
  }
}

// MARK: Evaluating filters

/** A resource as {@link evaluate} sees it. */
export interface ResourceView {
  readonly uid: EntityUid;
  /** Attributes as Cedar JSON. */
  readonly attrs: { readonly [key: string]: ffi.CedarValueJson };
  /** Whether `entity` (not the resource itself) is an ancestor of the resource. */
  readonly isIn?: (ancestor: EntityUid) => boolean;
  /** Whether the entity `value` is in `ancestor` (not reflexive). */
  readonly isValueIn?: (value: EntityUid, ancestor: EntityUid) => boolean;
}

/**
 * Evaluates a filter on one resource: true, false, or undefined for an
 * error. The view holds the resource's attributes only, so reading through
 * an entity-valued attribute (`resource.owner.dept`, `resource.owner has
 * dept`) throws {@link QueryUnsupported} rather than guessing.
 */
export function evaluate(
  filter: Filter,
  resource: ResourceView,
): boolean | undefined {
  /** The record at `value` (undefined when Cedar would fail to read one). */
  const record = (
    value: ffi.CedarValueJson | undefined,
    path: readonly string[],
  ): Record<string, ffi.CedarValueJson> | undefined => {
    if (value !== undefined && asEntity(value) !== undefined) {
      throw new QueryUnsupported(
        `evaluate cannot read the attributes of the entity at ${
          ["resource", ...path].join(".")
        }`,
      );
    }
    return value !== undefined && isRecord(value)
      ? value as Record<string, ffi.CedarValueJson>
      : undefined;
  };
  const read = (path: readonly string[]): ffi.CedarValueJson | undefined => {
    let value: ffi.CedarValueJson | undefined = resource
      .attrs as ffi.CedarValueJson;
    for (const [i, key] of path.entries()) {
      const fields = record(value, path.slice(0, i));
      if (fields === undefined || !Object.hasOwn(fields, key)) return undefined;
      value = fields[key];
    }
    return value;
  };
  switch (filter.kind) {
    case "const":
      return filter.value;
    case "error":
      return undefined;
    case "and": {
      const l = evaluate(filter.left, resource);
      return l === undefined
        ? undefined
        : l
        ? evaluate(filter.right, resource)
        : false;
    }
    case "or": {
      const l = evaluate(filter.left, resource);
      return l === undefined
        ? undefined
        : l
        ? true
        : evaluate(filter.right, resource);
    }
    case "not": {
      const v = evaluate(filter.arg, resource);
      return v === undefined ? undefined : !v;
    }
    case "if": {
      const c = evaluate(filter.cond, resource);
      return c === undefined
        ? undefined
        : evaluate(c ? filter.then : filter.else, resource);
    }
    case "applies":
      return evaluate(filter.arg, resource) ?? false;
    case "attr": {
      const v = read(filter.path);
      return typeof v === "boolean" ? v : undefined;
    }
    case "eq": {
      const v = read(filter.path);
      if (v === undefined) return undefined;
      return sameValue(v, literalJson(filter.value));
    }
    case "cmp": {
      const v = read(filter.path);
      if (typeof v !== "number") return undefined;
      const b = filter.value;
      return filter.op === "<"
        ? v < b
        : filter.op === "<="
        ? v <= b
        : filter.op === ">"
        ? v > b
        : v >= b;
    }
    case "has": {
      const parent = filter.path.slice(0, -1);
      const fields = record(read(parent), parent);
      return fields === undefined
        ? undefined
        : Object.hasOwn(fields, filter.path[filter.path.length - 1]);
    }
    case "defined":
      return read(filter.path) === undefined ? undefined : true;
    case "self":
      return formatUid(resource.uid) === formatUid(filter.value);
    case "in":
      return formatUid(resource.uid) === formatUid(filter.ancestor) ||
        (resource.isIn?.(filter.ancestor) ?? false);
    case "attrIn": {
      const v = read(filter.path);
      if (v === undefined) return undefined;
      const entity = asEntity(v);
      if (entity === undefined) return undefined;
      return filter.ancestors.some((ancestor) =>
        formatUid(entity) === formatUid(ancestor) ||
        (resource.isValueIn?.(entity, ancestor) ?? false)
      );
    }
    case "like": {
      const v = read(filter.path);
      return typeof v === "string" ? matchLike(v, filter.pattern) : undefined;
    }
    case "contains": {
      const v = read(filter.path);
      if (!Array.isArray(v)) return undefined;
      return v.some((item) => sameValue(item, literalJson(filter.value)));
    }
  }
}

function literalJson(value: Literal): ffi.CedarValueJson {
  return typeof value === "object"
    ? { __entity: { type: value.type, id: value.id } }
    : value;
}

// MARK: SQL

/** How one attribute of the resource is stored. */
export type AttributeMapping =
  | {
    readonly type: "string" | "long" | "bool";
    readonly column: Fragment | string;
  }
  | {
    readonly type: "entity";
    readonly column: Fragment | string;
    /** The column holds ids of entities of this type. */
    readonly entityType: string;
    /** `resource.<attr> in ancestor`, beyond equality. */
    readonly in?: (ancestor: EntityUid) => Fragment | boolean;
  }
  | {
    /** A set stored as a JSON array in a text column. */
    readonly type: "set";
    readonly column: Fragment | string;
    readonly element: "string" | "long";
  }
  | {
    /**
     * A record, for `resource.a has b`: the column is NULL exactly when
     * the resource has no `a` (its fields need columns of their own).
     */
    readonly type: "record";
    readonly column: Fragment | string;
  };

/** How resources of one type are stored. */
export interface ResourceMapping {
  /** The resources' entity type (`Doc`). */
  readonly type: string;
  /** The column (or expression) holding a resource's id. */
  readonly id: Fragment | string;
  /** Attributes by dotted path (`owner`, `address.city`). */
  readonly attributes?: { readonly [path: string]: AttributeMapping };
  /**
   * `resource in ancestor` for an ancestor other than the resource itself:
   * a condition (an `EXISTS` over a membership table, say), or false.
   */
  readonly in?: (ancestor: EntityUid) => Fragment | boolean;
}

const column = (c: Fragment | string): Fragment =>
  typeof c === "string" ? raw(c) : c;
const TRUE_SQL = raw("TRUE");
const FALSE_SQL = raw("FALSE");
const ERROR_SQL = raw("CAST(NULL AS BOOLEAN)");

/**
 * The filter as a SQL condition for `mapping`, which is TRUE for rows the
 * policies allow and FALSE or NULL for the rest (so it can be used in a
 * `WHERE` directly).
 */
export function toSql(filter: Filter, mapping: ResourceMapping): Fragment {
  return new SqlRenderer(mapping).render(filter);
}

class SqlRenderer {
  readonly #mapping: ResourceMapping;
  constructor(mapping: ResourceMapping) {
    this.#mapping = mapping;
  }

  #attribute(path: readonly string[]): AttributeMapping {
    const key = path.join(".");
    const found = this.#mapping.attributes?.[key];
    if (found === undefined) {
      throw new QueryUnsupported(
        `the attribute ${key} of ${this.#mapping.type} has no column`,
      );
    }
    return found;
  }

  /** NULL where the attribute is missing, else `value`. */
  #guard(col: Fragment, value: Fragment): Fragment {
    return sql`CASE WHEN ${col} IS NULL THEN ${ERROR_SQL} ELSE ${value} END`;
  }

  #fragment(value: Fragment | boolean): Fragment {
    return typeof value === "boolean"
      ? (value ? TRUE_SQL : FALSE_SQL)
      : sql`(${value})`;
  }

  render(filter: Filter): Fragment {
    switch (filter.kind) {
      case "const":
        return filter.value ? TRUE_SQL : FALSE_SQL;
      case "error":
        return ERROR_SQL;
      case "and":
        return sql`(CASE ${this.render(filter.left)} WHEN TRUE THEN ${
          this.render(filter.right)
        } WHEN FALSE THEN FALSE END)`;
      case "or":
        return sql`(CASE ${
          this.render(filter.left)
        } WHEN TRUE THEN TRUE WHEN FALSE THEN ${
          this.render(filter.right)
        } END)`;
      case "not":
        return sql`(NOT ${this.render(filter.arg)})`;
      case "if":
        return sql`(CASE ${this.render(filter.cond)} WHEN TRUE THEN ${
          this.render(filter.then)
        } WHEN FALSE THEN ${this.render(filter.else)} END)`;
      case "applies":
        return sql`COALESCE(${this.render(filter.arg)}, FALSE)`;
      case "attr": {
        const attr = this.#attribute(filter.path);
        const col = column(attr.column);
        if (attr.type !== "bool") return this.#guard(col, ERROR_SQL);
        // SQLite keeps booleans as integers; compare, so 2 is not true.
        return sql`(${col} = 1)`;
      }
      case "eq":
        return this.#equal(filter.path, filter.value);
      case "cmp": {
        const attr = this.#attribute(filter.path);
        const col = column(attr.column);
        if (attr.type !== "long") return this.#guard(col, ERROR_SQL);
        // The operator is spliced into the text; a filter built by hand
        // must not carry anything else there.
        if (!["<", "<=", ">", ">="].includes(filter.op)) {
          throw new QueryUnsupported(
            `the comparison ${JSON.stringify(filter.op)}`,
          );
        }
        return sql`(${col} ${raw(filter.op)} ${filter.value})`;
      }
      case "has": {
        if (filter.path.length === 1) {
          const col = column(this.#attribute(filter.path).column);
          return sql`(${col} IS NOT NULL)`;
        }
        // `resource.a has b` is an error when `a` is missing, and when it
        // is neither a record nor an entity; only its column can say which.
        const parent = this.#attribute(filter.path.slice(0, -1));
        if (parent.type !== "record" && parent.type !== "entity") {
          return ERROR_SQL;
        }
        const col = column(this.#attribute(filter.path).column);
        return this.#guard(column(parent.column), sql`(${col} IS NOT NULL)`);
      }
      case "defined":
        return this.#guard(
          column(this.#attribute(filter.path).column),
          TRUE_SQL,
        );
      case "self":
        return filter.value.type === this.#mapping.type
          ? sql`(${column(this.#mapping.id)} = ${filter.value.id})`
          : FALSE_SQL;
      case "in": {
        const self = filter.ancestor.type === this.#mapping.type
          ? sql`(${column(this.#mapping.id)} = ${filter.ancestor.id})`
          : FALSE_SQL;
        const ancestors = this.#fragment(
          this.#mapping.in?.(filter.ancestor) ?? false,
        );
        return sql`(${self} OR ${ancestors})`;
      }
      case "attrIn": {
        const attr = this.#attribute(filter.path);
        const col = column(attr.column);
        if (attr.type !== "entity") return this.#guard(col, ERROR_SQL);
        const each = filter.ancestors.map((ancestor) => {
          const self = ancestor.type === attr.entityType
            ? sql`(${col} = ${ancestor.id})`
            : FALSE_SQL;
          const ancestors = this.#fragment(attr.in?.(ancestor) ?? false);
          return sql`(${self} OR ${ancestors})`;
        });
        return this.#guard(
          col,
          each.length === 0 ? FALSE_SQL : sql`(${join(each, " OR ")})`,
        );
      }
      case "like": {
        const attr = this.#attribute(filter.path);
        const col = column(attr.column);
        if (attr.type !== "string") return this.#guard(col, ERROR_SQL);
        // GLOB is case-sensitive, as Cedar's `like` is; SQLite's LIKE is not.
        return sql`(${col} GLOB ${globPattern(filter.pattern)})`;
      }
      case "contains": {
        const attr = this.#attribute(filter.path);
        const col = column(attr.column);
        const value = filter.value;
        if (attr.type !== "set") return this.#guard(col, ERROR_SQL);
        const matches = attr.element === "string"
          ? typeof value === "string"
          : typeof value === "number";
        if (!matches) return this.#guard(col, FALSE_SQL);
        return this.#guard(
          col,
          sql`EXISTS (SELECT 1 FROM json_each(${col}) AS e WHERE e.value = ${value as SqlValue})`,
        );
      }
    }
  }

  #equal(path: readonly string[], value: Literal): Fragment {
    const attr = this.#attribute(path);
    const col = column(attr.column);
    switch (attr.type) {
      case "string":
        return typeof value === "string"
          ? sql`(${col} = ${value})`
          : this.#guard(col, FALSE_SQL);
      case "long":
        return typeof value === "number"
          ? sql`(${col} = ${value})`
          : this.#guard(col, FALSE_SQL);
      case "bool":
        return typeof value === "boolean"
          ? sql`(${col} = ${value})`
          : this.#guard(col, FALSE_SQL);
      case "entity":
        return typeof value === "object" && value.type === attr.entityType
          ? sql`(${col} = ${value.id})`
          : this.#guard(col, FALSE_SQL);
      case "set":
        throw new QueryUnsupported(
          `comparing the set ${path.join(".")} for equality`,
        );
      case "record":
        // Literals here are never records.
        return this.#guard(col, FALSE_SQL);
    }
  }
}

/** A SQLite GLOB pattern: case-sensitive, like Cedar's `like`. */
function globPattern(pattern: readonly ffi.PatternElem[]): string {
  return pattern.map((p) =>
    p === "Wildcard" ? "*" : p.Literal.replace(/[*?[]/g, (c) => `[${c}]`)
  ).join("");
}

// MARK: Planning

/** A request for a list: everything but the resource. */
export type ListRequest = Omit<PartialRequest, "resource">;

/** A compiled list query. */
export interface QueryPlan {
  /** The filter over resources of `mapping.type`. */
  readonly filter: Filter;
  /** The filter as SQL, to put in a `WHERE`. */
  readonly where: Fragment;
  /** Whether every resource is allowed (skip the filter) or none (skip the query). */
  readonly all: boolean;
  readonly none: boolean;
}

/**
 * Partially evaluates `request` with the resource unknown and compiles
 * what is left for `mapping`, with exactly the entities the request
 * carries: pass the principal and its ancestors, or use {@link planQuery},
 * which loads them. Throws {@link QueryUnsupported}.
 */
export function queryFilter(
  authorizer: Authorizer,
  request: ListRequest,
  mapping: ResourceMapping,
): QueryPlan {
  uid(mapping.type, "");
  const filter = compileResiduals(
    authorizer.partial({ ...request, resource: null }),
    mapping.type,
  );
  return {
    filter,
    where: toSql(filter, mapping),
    all: filter.kind === "const" && filter.value,
    none: filter.kind === "const" && !filter.value,
  };
}

/**
 * {@link queryFilter} after loading the principal and its ancestors with
 * the authorizer's entity loader, as `Authorizer.authorize` does for a
 * single request.
 */
export async function planQuery(
  authorizer: Authorizer,
  request: ListRequest,
  mapping: ResourceMapping,
): Promise<QueryPlan> {
  uid(mapping.type, "");
  const filter = compileResiduals(
    await authorizer.partialAuthorize({ ...request, resource: null }),
    mapping.type,
  );
  return {
    filter,
    where: toSql(filter, mapping),
    all: filter.kind === "const" && filter.value,
    none: filter.kind === "const" && !filter.value,
  };
}
