// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A JSON Schema 2020-12 validator for tool input and output schemas, with the
 * bounds the MCP spec asks for.
 *
 * Supported: boolean schemas; `type`, `enum`, `const`; the numeric, string,
 * array and object assertions (`multipleOf`, `minimum`, `exclusiveMaximum`,
 * `pattern`, `minItems`, `uniqueItems`, `required`, `dependentRequired`,
 * `minProperties`...); the applicators `allOf`, `anyOf`, `oneOf`, `not`,
 * `if`/`then`/`else`, `properties`, `patternProperties`,
 * `additionalProperties`, `propertyNames`, `prefixItems`, `items`,
 * `contains` with `minContains`/`maxContains`, `dependentSchemas`; and local
 * `$ref` (`#`, JSON pointers into the document, `#anchor` via `$anchor`).
 * Annotation keywords (`title`, `format`, `default`, `x-mcp-header`...) and
 * unknown keywords are ignored, as the spec says.
 *
 * Refused when the schema is compiled, so a server never registers a schema
 * it would enforce wrongly: a `$schema` other than 2020-12,
 * `unevaluatedProperties`, `unevaluatedItems`, `$dynamicRef`,
 * `$dynamicAnchor`, `$recursiveRef`, and any `$ref` that is not local (the
 * spec forbids dereferencing network URIs by default and says unresolved ones
 * SHOULD be rejected). Compilation also bounds nesting depth and the number
 * of subschemas, and validation bounds its work, so a hostile schema cannot
 * be a denial of service.
 *
 * @module
 */

import { canonicalJson, describe, isPlainObject, type Issue } from "./json.ts";
import type { Path } from "./json.ts";

/** A JSON Schema object. */
export type JsonSchema = { [key: string]: unknown };

/** The dialect this validator implements, and the default for MCP schemas. */
export const DIALECT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Bounds on schema size and validation work. */
export interface SchemaLimits {
  /** Deepest subschema nesting accepted at compile time; default 32. */
  readonly maxDepth?: number;
  /** Most subschemas accepted at compile time; default 2000. */
  readonly maxSubschemas?: number;
  /** Most subschema evaluations per validation; default 100000. */
  readonly maxSteps?: number;
  /** Deepest `$ref` chain per validation; default 64. */
  readonly maxRefDepth?: number;
}

/** A schema that failed to compile. */
export class SchemaError extends TypeError {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(
      `invalid JSON Schema: ${
        issues.slice(0, 5).map((issue) =>
          `${
            issue.path.length === 0 ? "(root)" : "/" + issue.path.join("/")
          }: ${issue.message}`
        ).join("; ")
      }`,
    );
    this.name = "SchemaError";
    this.issues = issues;
  }
}

/** A compiled schema. */
export interface CompiledSchema {
  /** The schema as given. */
  readonly schema: unknown;
  /** Every reason `value` does not conform, with instance paths; empty if it does. */
  validate(value: unknown): Issue[];
}

const UNSUPPORTED = [
  "unevaluatedProperties",
  "unevaluatedItems",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
];

const SCHEMA_KEYWORDS = [
  "not",
  "if",
  "then",
  "else",
  "additionalProperties",
  "propertyNames",
  "items",
  "contains",
];
const SCHEMA_ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_MAPS = [
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
];
const TYPES = [
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
];

/**
 * Compiles a schema, checking every keyword's value, local `$ref` targets,
 * and the bounds. Throws {@link SchemaError}.
 */
export function compileSchema(
  schema: unknown,
  limits: SchemaLimits = {},
): CompiledSchema {
  const maxDepth = limits.maxDepth ?? 32;
  const maxSubschemas = limits.maxSubschemas ?? 2000;
  const issues: Issue[] = [];
  const anchors = new Map<string, unknown>();
  const refs: { ref: string; path: Path }[] = [];
  let count = 0;

  const walk = (node: unknown, path: Path, depth: number): void => {
    count++;
    if (count > maxSubschemas) {
      if (count === maxSubschemas + 1) {
        issues.push({ path, message: `more than ${maxSubschemas} subschemas` });
      }
      return;
    }
    if (depth > maxDepth) {
      issues.push({ path, message: `nested deeper than ${maxDepth}` });
      return;
    }
    if (typeof node === "boolean") return;
    if (!isPlainObject(node)) {
      issues.push({
        path,
        message: `a schema must be an object or boolean, got ${describe(node)}`,
      });
      return;
    }
    const bad = (key: string, message: string) =>
      issues.push({ path: [...path, key], message });
    for (const key of UNSUPPORTED) {
      if (key in node) bad(key, "is not supported by this validator");
    }
    if ("$schema" in node) {
      if (depth > 0) bad("$schema", "is only allowed at the root");
      else if (node.$schema !== DIALECT_2020_12) {
        bad(
          "$schema",
          `unsupported dialect ${
            JSON.stringify(node.$schema)
          }; only ${DIALECT_2020_12} is supported`,
        );
      }
    }
    if ("$ref" in node) {
      if (typeof node.$ref !== "string") bad("$ref", "must be a string");
      else refs.push({ ref: node.$ref, path: [...path, "$ref"] });
    }
    if ("$anchor" in node) {
      if (
        typeof node.$anchor !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9._-]*$/.test(node.$anchor)
      ) {
        bad("$anchor", "must be a plain-name fragment");
      } else if (anchors.has(node.$anchor)) {
        bad("$anchor", "is defined twice");
      } else anchors.set(node.$anchor, node);
    }
    if ("type" in node) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (
        types.length === 0 ||
        !types.every((type) => typeof type === "string" && TYPES.includes(type))
      ) {
        bad("type", "must be a type name or a non-empty array of them");
      }
    }
    if ("enum" in node && !Array.isArray(node.enum)) {
      bad("enum", "must be an array");
    }
    for (
      const key of [
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "minProperties",
        "maxProperties",
        "minContains",
        "maxContains",
      ]
    ) {
      if (
        key in node &&
        !(Number.isSafeInteger(node[key]) && (node[key] as number) >= 0)
      ) {
        bad(key, "must be a non-negative integer");
      }
    }
    for (
      const key of [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
      ]
    ) {
      if (
        key in node &&
        !(typeof node[key] === "number" && Number.isFinite(node[key]))
      ) {
        bad(key, "must be a number");
      }
    }
    if (
      "multipleOf" in node &&
      !(typeof node.multipleOf === "number" && node.multipleOf > 0)
    ) {
      bad("multipleOf", "must be a positive number");
    }
    if ("uniqueItems" in node && typeof node.uniqueItems !== "boolean") {
      bad("uniqueItems", "must be a boolean");
    }
    if ("pattern" in node) checkPattern(node.pattern, [...path, "pattern"]);
    if ("required" in node && !stringArray(node.required)) {
      bad("required", "must be an array of strings");
    }
    if ("dependentRequired" in node) {
      if (
        !isPlainObject(node.dependentRequired) ||
        !Object.values(node.dependentRequired).every(stringArray)
      ) {
        bad("dependentRequired", "must map names to arrays of strings");
      }
    }
    for (const key of SCHEMA_KEYWORDS) {
      if (key in node) walk(node[key], [...path, key], depth + 1);
    }
    for (const key of SCHEMA_ARRAYS) {
      if (!(key in node)) continue;
      const list = node[key];
      if (
        !Array.isArray(list) || (list.length === 0 && key !== "prefixItems")
      ) {
        bad(key, "must be a non-empty array of schemas");
        continue;
      }
      list.forEach((item, index) =>
        walk(item, [...path, key, index], depth + 1)
      );
    }
    for (const key of SCHEMA_MAPS) {
      if (!(key in node)) continue;
      const map = node[key];
      if (!isPlainObject(map)) {
        bad(key, "must be an object of schemas");
        continue;
      }
      for (const [name, item] of Object.entries(map)) {
        if (key === "patternProperties") {
          checkPattern(name, [...path, key, name]);
        }
        walk(item, [...path, key, name], depth + 1);
      }
    }
  };

  const checkPattern = (pattern: unknown, path: Path) => {
    if (typeof pattern !== "string") {
      issues.push({ path, message: "must be a string" });
      return;
    }
    try {
      new RegExp(pattern, "u");
    } catch {
      issues.push({ path, message: "is not a valid regular expression" });
    }
  };

  walk(schema, [], 0);
  const resolved = new Map<string, unknown>();
  for (const { ref, path } of refs) {
    const target = resolveRef(schema, anchors, ref);
    if (target === undefined) {
      issues.push({
        path,
        message: ref.startsWith("#")
          ? `does not resolve within the schema: ${ref}`
          : `non-local $ref is not dereferenced: ${ref}`,
      });
    } else resolved.set(ref, target);
  }
  if (issues.length > 0) throw new SchemaError(issues);
  const validator = new Validator(resolved, limits);
  return {
    schema,
    validate: (value) => validator.run(schema, value),
  };
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

function resolveRef(
  root: unknown,
  anchors: Map<string, unknown>,
  ref: string,
): unknown {
  if (!ref.startsWith("#")) return undefined;
  const fragment = ref.slice(1);
  if (fragment === "") return root;
  if (!fragment.startsWith("/")) return anchors.get(fragment);
  let node: unknown = root;
  for (const raw of fragment.slice(1).split("/")) {
    let token: string;
    try {
      token = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return undefined;
    }
    if (Array.isArray(node) && /^(0|[1-9][0-9]*)$/.test(token)) {
      node = node[Number(token)];
    } else if (isPlainObject(node) && Object.hasOwn(node, token)) {
      node = node[token];
    } else return undefined;
  }
  return typeof node === "boolean" || isPlainObject(node) ? node : undefined;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function hasType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

class Budget extends Error {}

class Validator {
  readonly #refs: Map<string, unknown>;
  readonly #maxSteps: number;
  readonly #maxRefDepth: number;
  readonly #patterns = new Map<string, RegExp>();
  #steps = 0;

  constructor(refs: Map<string, unknown>, limits: SchemaLimits) {
    this.#refs = refs;
    this.#maxSteps = limits.maxSteps ?? 100_000;
    this.#maxRefDepth = limits.maxRefDepth ?? 64;
  }

  run(schema: unknown, value: unknown): Issue[] {
    this.#steps = 0;
    const issues: Issue[] = [];
    try {
      this.#check(schema, value, [], issues, 0);
    } catch (error) {
      if (!(error instanceof Budget)) throw error;
      issues.push({ path: [], message: error.message });
    }
    return issues;
  }

  #valid(schema: unknown, value: unknown, path: Path, refDepth: number) {
    const issues: Issue[] = [];
    this.#check(schema, value, path, issues, refDepth);
    return issues.length === 0;
  }

  #regex(pattern: string): RegExp {
    let regex = this.#patterns.get(pattern);
    if (regex === undefined) {
      regex = new RegExp(pattern, "u");
      this.#patterns.set(pattern, regex);
    }
    return regex;
  }

  #check(
    schema: unknown,
    value: unknown,
    path: Path,
    issues: Issue[],
    refDepth: number,
  ): void {
    if (++this.#steps > this.#maxSteps) {
      throw new Budget(`validation exceeded ${this.#maxSteps} steps`);
    }
    if (schema === true) return;
    if (schema === false) {
      issues.push({ path, message: "no value is allowed here" });
      return;
    }
    const s = schema as Record<string, unknown>;
    const fail = (message: string) => issues.push({ path, message });

    if (typeof s.$ref === "string") {
      if (refDepth >= this.#maxRefDepth) {
        throw new Budget(`$ref nesting exceeded ${this.#maxRefDepth}`);
      }
      this.#check(this.#refs.get(s.$ref), value, path, issues, refDepth + 1);
    }
    if (s.type !== undefined) {
      const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
      if (!types.some((type) => hasType(value, type))) {
        fail(`expected ${types.join(" or ")}, got ${describe(value)}`);
        return;
      }
    }
    if (Array.isArray(s.enum)) {
      const key = canonicalJson(value);
      if (!s.enum.some((item) => canonicalJson(item) === key)) {
        fail(
          `must be one of ${
            s.enum.map((item) => JSON.stringify(item)).join(", ")
          }`,
        );
      }
    }
    if ("const" in s && canonicalJson(s.const) !== canonicalJson(value)) {
      fail(`must be ${JSON.stringify(s.const)}`);
    }

    if (typeof value === "number") this.#number(s, value, fail);
    if (typeof value === "string") this.#string(s, value, fail);
    if (Array.isArray(value)) {
      this.#array(s, value, path, issues, refDepth);
    }
    if (isPlainObject(value)) {
      this.#object(s, value, path, issues, refDepth);
    }

    if (Array.isArray(s.allOf)) {
      for (const sub of s.allOf) {
        this.#check(sub, value, path, issues, refDepth);
      }
    }
    if (Array.isArray(s.anyOf)) {
      if (!s.anyOf.some((sub) => this.#valid(sub, value, path, refDepth))) {
        fail("does not match any schema in anyOf");
      }
    }
    if (Array.isArray(s.oneOf)) {
      const matches = s.oneOf.filter((sub) =>
        this.#valid(sub, value, path, refDepth)
      ).length;
      if (matches !== 1) {
        fail(`matches ${matches} schemas in oneOf, expected exactly 1`);
      }
    }
    if (s.not !== undefined && this.#valid(s.not, value, path, refDepth)) {
      fail("must not match the schema in not");
    }
    if (s.if !== undefined) {
      const branch = this.#valid(s.if, value, path, refDepth) ? s.then : s.else;
      if (branch !== undefined) {
        this.#check(branch, value, path, issues, refDepth);
      }
    }
  }

  #number(
    s: Record<string, unknown>,
    value: number,
    fail: (message: string) => void,
  ): void {
    if (typeof s.minimum === "number" && value < s.minimum) {
      fail(`must be >= ${s.minimum}`);
    }
    if (typeof s.maximum === "number" && value > s.maximum) {
      fail(`must be <= ${s.maximum}`);
    }
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) {
      fail(`must be > ${s.exclusiveMinimum}`);
    }
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) {
      fail(`must be < ${s.exclusiveMaximum}`);
    }
    if (typeof s.multipleOf === "number") {
      const quotient = value / s.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        fail(`must be a multiple of ${s.multipleOf}`);
      }
    }
  }

  #string(
    s: Record<string, unknown>,
    value: string,
    fail: (message: string) => void,
  ): void {
    const length = [...value].length;
    if (typeof s.minLength === "number" && length < s.minLength) {
      fail(`must be at least ${s.minLength} characters`);
    }
    if (typeof s.maxLength === "number" && length > s.maxLength) {
      fail(`must be at most ${s.maxLength} characters`);
    }
    if (typeof s.pattern === "string" && !this.#regex(s.pattern).test(value)) {
      fail(`must match the pattern ${JSON.stringify(s.pattern)}`);
    }
  }

  #array(
    s: Record<string, unknown>,
    value: unknown[],
    path: Path,
    issues: Issue[],
    refDepth: number,
  ): void {
    const fail = (message: string) => issues.push({ path, message });
    if (typeof s.minItems === "number" && value.length < s.minItems) {
      fail(`must have at least ${s.minItems} items`);
    }
    if (typeof s.maxItems === "number" && value.length > s.maxItems) {
      fail(`must have at most ${s.maxItems} items`);
    }
    if (s.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = canonicalJson(item);
        if (seen.has(key)) {
          fail("items must be unique");
          break;
        }
        seen.add(key);
      }
    }
    const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : [];
    value.forEach((item, index) => {
      const sub = index < prefix.length ? prefix[index] : s.items;
      if (sub !== undefined) {
        this.#check(sub, item, [...path, index], issues, refDepth);
      }
    });
    if (s.contains !== undefined) {
      const count = value.filter((item, index) =>
        this.#valid(s.contains, item, [...path, index], refDepth)
      ).length;
      const min = typeof s.minContains === "number" ? s.minContains : 1;
      if (count < min) {
        fail(`must contain at least ${min} matching items`);
      }
      if (typeof s.maxContains === "number" && count > s.maxContains) {
        fail(`must contain at most ${s.maxContains} matching items`);
      }
    }
  }

  #object(
    s: Record<string, unknown>,
    value: Record<string, unknown>,
    path: Path,
    issues: Issue[],
    refDepth: number,
  ): void {
    const keys = Object.keys(value);
    const fail = (message: string) => issues.push({ path, message });
    if (typeof s.minProperties === "number" && keys.length < s.minProperties) {
      fail(`must have at least ${s.minProperties} properties`);
    }
    if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) {
      fail(`must have at most ${s.maxProperties} properties`);
    }
    if (Array.isArray(s.required)) {
      for (const name of s.required as string[]) {
        if (!Object.hasOwn(value, name)) {
          issues.push({ path: [...path, name], message: "is required" });
        }
      }
    }
    if (isPlainObject(s.dependentRequired)) {
      for (const [name, needs] of Object.entries(s.dependentRequired)) {
        if (!Object.hasOwn(value, name)) continue;
        for (const need of needs as string[]) {
          if (!Object.hasOwn(value, need)) {
            issues.push({
              path: [...path, need],
              message: `is required when ${name} is present`,
            });
          }
        }
      }
    }
    if (isPlainObject(s.dependentSchemas)) {
      for (const [name, sub] of Object.entries(s.dependentSchemas)) {
        if (Object.hasOwn(value, name)) {
          this.#check(sub, value, path, issues, refDepth);
        }
      }
    }
    const properties = isPlainObject(s.properties) ? s.properties : {};
    const patterns = isPlainObject(s.patternProperties)
      ? Object.entries(s.patternProperties)
      : [];
    for (const key of keys) {
      const at = [...path, key];
      if (s.propertyNames !== undefined) {
        const nameIssues: Issue[] = [];
        this.#check(s.propertyNames, key, at, nameIssues, refDepth);
        if (nameIssues.length > 0) {
          issues.push({ path: at, message: "is not an allowed property name" });
        }
      }
      let matched = false;
      if (Object.hasOwn(properties, key)) {
        matched = true;
        this.#check(properties[key], value[key], at, issues, refDepth);
      }
      for (const [pattern, sub] of patterns) {
        if (this.#regex(pattern).test(key)) {
          matched = true;
          this.#check(sub, value[key], at, issues, refDepth);
        }
      }
      if (!matched && s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) {
          issues.push({ path: at, message: "is not allowed" });
        } else {
          this.#check(s.additionalProperties, value[key], at, issues, refDepth);
        }
      }
    }
  }
}
