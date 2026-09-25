// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * JSON Schema (draft 2020-12) from sieve schemas, imported as
 * "@celld/sieve/json-schema".
 *
 * ```ts
 * import { toJSONSchema } from "@celld/sieve/json-schema";
 *
 * toJSONSchema(v.object({ name: v.string().min(1) }));
 * // {
 * //   $schema: "https://json-schema.org/draft/2020-12/schema",
 * //   type: "object",
 * //   properties: { name: { type: "string", minLength: 1 } },
 * //   required: ["name"],
 * //   additionalProperties: false,
 * // }
 * ```
 *
 * - `io: "output"` (the default) describes what `parse` returns, `"input"`
 *   what it accepts: defaults make keys optional on input, and the input
 *   side of a pipe is its first schema.
 * - Named schemas (`.meta({ id })`) become `$defs` entries referenced with
 *   `$ref`; so do the targets of `v.lazy`, named or not, which is how
 *   recursion is written. A lazy reference back to the root is `"#"`.
 * - Descriptions and other `meta` keys are copied onto the schema.
 * - What JSON cannot hold (transforms, `bigint`, `Date`, `Temporal` values,
 *   `Map`, `Set`, bytes, `undefined`, class instances) throws, or becomes
 *   `{}` with `unrepresentable: "any"`. Refinements are left out.
 * - A string converted to a `Temporal` value (`.toInstant()`, ...) is its
 *   string on input, with the format it is read in (`date-time`, `date`,
 *   `time` or `duration`).
 * - `$schema: false` leaves out the `$schema` URI.
 * - `target: "openai-strict"` writes what OpenAI's strict structured
 *   outputs and strict function tools accept, and throws, saying what to
 *   change, on a schema they would refuse; see {@link JsonSchemaOptions}.
 *
 * @module
 */

import { CIDR_V4_PATTERN, CIDR_V6_PATTERN } from "@celld/ip/patterns";
import { JWT_PATTERN } from "@celld/jwt";
import { ULID_PATTERN } from "@celld/ulid";
import { BASE64URL, HEX } from "./checks.ts";
import type { Meta, Primitive, SchemaDef, StringFormat } from "./def.ts";
import { defOf, idOf, isSchema } from "./introspect.ts";
import type { AnySchema } from "./schema.ts";
import { temporalFormat } from "./temporal.ts";

/** A JSON Schema object. */
export type JsonSchema = { [key: string]: unknown };

/** Options for {@link toJSONSchema}. */
export interface JsonSchemaOptions {
  /** Describe what `parse` returns (default) or what it accepts. */
  readonly io?: "output" | "input";
  /** Throw on a schema JSON cannot express (default), or use `{}`. */
  readonly unrepresentable?: "throw" | "any";
  /**
   * Draft 2020-12 (default), or the subset OpenAI's strict mode accepts
   * (`"openai-strict"`). The strict target:
   *
   * - describes the input (`io` defaults to `"input"`), which is what the
   *   model writes;
   * - needs an object at the root;
   * - gives every object `additionalProperties: false` (stripping ones
   *   too), and throws on loose objects, catchalls and records;
   * - makes every key required (`required: []` on an object with no
   *   keys), and throws on an `.optional()` or
   *   `.default()` key: use `.nullable()`, and the model sends `null`. A
   *   `.catch()` key is required too; the parse still falls back;
   * - writes discriminated unions as `anyOf`, not `oneOf`;
   * - throws on what would need `allOf`: intersections and strings with
   *   more than one pattern;
   * - leaves out `$schema`, `default` and `contentEncoding`.
   */
  readonly target?: "draft-2020-12" | "openai-strict";
  /**
   * Whether to write the `$schema` URI; the default is `true`, except for
   * the `openai-strict` target.
   */
  readonly $schema?: boolean;
}

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The JSON Schema `format` for a sieve string format that has one. */
function formatName(format: StringFormat): string {
  if (format === "url") return "uri";
  if (format === "datetime") return "date-time";
  return format;
}

function metaJson(meta: Meta | undefined): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (key !== "id" && value !== undefined) out[key] = value;
  }
  return out;
}

function jsonType(value: Primitive): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  return undefined;
}

function nullable(inner: JsonSchema): JsonSchema {
  if (inner.type === "null") return inner;
  if (
    typeof inner.type === "string" && !("enum" in inner) && !("const" in inner)
  ) {
    return { ...inner, type: [inner.type, "null"] };
  }
  return { anyOf: [inner, { type: "null" }] };
}

function sorted(defs: Map<string, JsonSchema>): JsonSchema {
  return Object.fromEntries(
    [...defs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  );
}

class Writer {
  readonly io: "output" | "input";
  readonly unrepresentable: "throw" | "any";
  readonly strict: boolean;
  readonly defs = new Map<string, JsonSchema>();
  readonly names = new Map<AnySchema, string>();
  readonly owners = new Map<string, AnySchema>();
  root: AnySchema | undefined;

  constructor(options: JsonSchemaOptions) {
    const target = options.target ?? "draft-2020-12";
    if (target !== "draft-2020-12" && target !== "openai-strict") {
      throw new Error(`sieve: unsupported JSON Schema target ${target}`);
    }
    this.strict = target === "openai-strict";
    this.io = options.io ?? (this.strict ? "input" : "output");
    this.unrepresentable = options.unrepresentable ?? "throw";
  }

  /** Adds `schema` to `$defs` as `name` (once) and returns the name. */
  define(schema: AnySchema, name: string): string {
    const known = this.names.get(schema);
    if (known !== undefined) return known;
    const owner = this.owners.get(name);
    if (owner !== undefined && owner !== schema) {
      throw new Error(
        `sieve: two different schemas are named ${JSON.stringify(name)}`,
      );
    }
    this.names.set(schema, name);
    this.owners.set(name, schema);
    this.defs.set(name, {});
    this.defs.set(name, this.body(schema, `#/$defs/${name}`));
    return name;
  }

  /** A fresh name for an unnamed lazy target. */
  fresh(): string {
    let index = 0;
    while (this.owners.has(`schema${index}`)) index++;
    return `schema${index}`;
  }

  /** A reference to a named schema, or the schema itself. */
  convert(schema: AnySchema, pointer: string): JsonSchema {
    const id = idOf(schema);
    if (id !== undefined && schema !== this.root) {
      return { $ref: `#/$defs/${this.define(schema, id)}` };
    }
    return this.body(schema, pointer);
  }

  /** The schema itself, with its metadata. */
  body(schema: AnySchema, pointer: string): JsonSchema {
    const def = defOf(schema);
    return { ...this.kind(def, pointer), ...metaJson(def.meta) };
  }

  lazy(target: AnySchema): JsonSchema {
    if (target === this.root) return { $ref: "#" };
    const name = this.names.get(target) ?? idOf(target) ?? this.fresh();
    return { $ref: `#/$defs/${this.define(target, name)}` };
  }

  /** Whether an object key with this schema may be absent. */
  optional(schema: AnySchema): boolean {
    return this.absentBy(schema) !== undefined;
  }

  /**
   * The wrapper that lets an object key with this schema be absent, if
   * any. A `.catch()` key is required in strict mode: the model always
   * sends it.
   */
  absentBy(schema: AnySchema): "optional" | "default" | "catch" | undefined {
    const def = defOf(schema);
    switch (def.kind) {
      case "optional":
        return "optional";
      case "default":
        return this.io === "input" ? "default" : undefined;
      case "catch":
        return this.io === "input" && !this.strict ? "catch" : undefined;
      case "nullable":
      case "readonly":
        return this.absentBy(def.inner);
      case "pipe":
        return this.absentBy(this.io === "input" ? def.in : def.out);
      default:
        return undefined;
    }
  }

  fail(kind: string, pointer: string): JsonSchema {
    if (this.unrepresentable === "any") return {};
    throw new Error(
      `sieve: ${kind} cannot be represented in JSON Schema (at ${pointer})`,
    );
  }

  /** Refuses what OpenAI's strict mode would refuse, saying how to fix it. */
  refuse(problem: string, pointer: string, fix: string): never {
    throw new Error(`sieve: openai-strict: ${problem} (at ${pointer}); ${fix}`);
  }

  kind(def: SchemaDef, pointer: string): JsonSchema {
    switch (def.kind) {
      case "string":
        return this.string(def.checks, pointer);
      case "number": {
        const out: JsonSchema = {
          type: def.checks.some((check) => check.check === "int")
            ? "integer"
            : "number",
        };
        for (const check of def.checks) {
          if (check.check === "min") {
            out[check.inclusive ? "minimum" : "exclusiveMinimum"] = Number(
              check.value,
            );
          } else if (check.check === "max") {
            out[check.inclusive ? "maximum" : "exclusiveMaximum"] = Number(
              check.value,
            );
          } else if (check.check === "multiple_of") {
            out.multipleOf = check.value;
          }
        }
        return out;
      }
      case "boolean":
        return { type: "boolean" };
      case "null":
        return { type: "null" };
      case "unknown":
      case "json":
        return {};
      case "never":
        return { not: {} };
      case "literal": {
        const types = new Set(def.values.map(jsonType));
        if (types.has(undefined)) return this.fail("literal", pointer);
        const type = types.size === 1 ? { type: [...types][0] } : {};
        return def.values.length === 1
          ? { ...type, const: def.values[0] }
          : { ...type, enum: [...def.values] };
      }
      case "enum":
        return { type: "string", enum: [...def.values] };
      case "object": {
        const properties: JsonSchema = {};
        const required: string[] = [];
        for (const [key, child] of Object.entries(def.shape)) {
          const at = `${pointer}/properties/${key}`;
          const absent = this.absentBy(child);
          if (this.strict && absent !== undefined) {
            this.refuse(
              `key ${
                JSON.stringify(key)
              } may be absent, but every key must be required`,
              at,
              `use .nullable() instead of .${absent}() in strict mode; the model sends null`,
            );
          }
          properties[key] = this.convert(child, at);
          if (absent === undefined) required.push(key);
        }
        const out: JsonSchema = { type: "object", properties };
        // OpenAI's strict mode wants `required` on every object, even an
        // empty one; draft 2020-12 needs it only when it lists something.
        if (required.length > 0 || this.strict) out.required = required;
        const catchall = def.catchall;
        if (this.strict) {
          if (catchall?.def.kind === "unknown") {
            this.refuse(
              "a loose object allows unknown keys, but additionalProperties must be false",
              pointer,
              "use v.object() or v.strictObject() instead of v.looseObject() or .loose() in strict mode",
            );
          }
          if (catchall !== undefined && catchall.def.kind !== "never") {
            this.refuse(
              "a catchall allows unknown keys, but additionalProperties must be false",
              pointer,
              "declare every key in the shape instead of using .catchall() in strict mode",
            );
          }
          out.additionalProperties = false;
        } else if (catchall === undefined) {
          if (this.io === "output") out.additionalProperties = false;
        } else if (catchall.def.kind === "never") {
          out.additionalProperties = false;
        } else if (catchall.def.kind !== "unknown") {
          out.additionalProperties = this.convert(
            catchall,
            `${pointer}/additionalProperties`,
          );
        }
        return out;
      }
      case "array": {
        const out: JsonSchema = {
          type: "array",
          items: this.convert(def.element, `${pointer}/items`),
        };
        return { ...out, ...this.lengths(def.checks, "Items") };
      }
      case "tuple": {
        const out: JsonSchema = {
          type: "array",
          prefixItems: def.items.map((item, index) =>
            this.convert(item, `${pointer}/prefixItems/${index}`)
          ),
          items: def.rest === undefined
            ? false
            : this.convert(def.rest, `${pointer}/items`),
        };
        let min = def.items.length;
        while (min > 0 && this.optional(def.items[min - 1])) min--;
        if (min > 0) out.minItems = min;
        return out;
      }
      case "record": {
        if (this.strict) {
          this.refuse(
            "a record allows any keys, but additionalProperties must be false",
            pointer,
            "use v.object() with fixed keys instead of v.record() in strict mode",
          );
        }
        const key = this.convert(def.key, `${pointer}/propertyNames`);
        const out: JsonSchema = { type: "object" };
        if (Object.keys(key).length !== 1 || key.type !== "string") {
          out.propertyNames = key;
        }
        const keyDef = def.key.def;
        if (keyDef.kind === "enum" || keyDef.kind === "literal") {
          out.required = keyDef.values.filter((value) =>
            typeof value === "string"
          );
        }
        out.additionalProperties = this.convert(
          def.value,
          `${pointer}/additionalProperties`,
        );
        return out;
      }
      case "union":
        return {
          anyOf: def.options.map((option, index) =>
            this.convert(option, `${pointer}/anyOf/${index}`)
          ),
        };
      case "discriminated_union": {
        const keyword = this.strict ? "anyOf" : "oneOf";
        return {
          [keyword]: def.options.map((option, index) =>
            this.convert(option, `${pointer}/${keyword}/${index}`)
          ),
        };
      }
      case "intersection":
        if (this.strict) {
          this.refuse(
            "an intersection becomes allOf, which is not supported",
            pointer,
            "combine objects with .extend() or .merge() instead of v.intersection() in strict mode",
          );
        }
        return {
          allOf: [
            this.convert(def.left, `${pointer}/allOf/0`),
            this.convert(def.right, `${pointer}/allOf/1`),
          ],
        };
      case "lazy":
        return this.lazy(def.getter());
      case "optional":
      case "catch":
        return this.convert(def.inner, pointer);
      case "nullable":
        return nullable(this.convert(def.inner, pointer));
      case "readonly":
        return { ...this.convert(def.inner, pointer), readOnly: true };
      case "default":
        if (this.strict) return this.convert(def.inner, pointer);
        return {
          ...this.convert(def.inner, pointer),
          default: def.factory === undefined ? def.value : def.factory(),
        };
      case "pipe": {
        const side = this.io === "output" || def.in.def.kind === "transform"
          ? def.out
          : def.in;
        const out = this.convert(side, pointer);
        // A string converted to a Temporal value: the input is a string in
        // the conversion's format, even if no check on it says so.
        const target = def.out.def;
        if (
          side === def.in && target.kind === "temporal" && target.coerce &&
          out.type === "string" && out.format === undefined
        ) {
          const format = temporalFormat(target.type);
          if (format !== undefined) out.format = formatName(format);
        }
        return out;
      }
      case "temporal": {
        const format = def.coerce ? temporalFormat(def.type) : undefined;
        if (this.io === "input" && format !== undefined) {
          return { type: "string", format: formatName(format) };
        }
        return this.fail(`Temporal (${def.type})`, pointer);
      }
      case "bigint":
      case "date":
      case "undefined":
      case "bytes":
      case "instanceof":
      case "map":
      case "set":
      case "transform":
        return this.fail(def.kind, pointer);
    }
  }

  lengths(
    checks: SchemaDef["checks"],
    suffix: "Length" | "Items",
  ): JsonSchema {
    const out: JsonSchema = {};
    const min = `min${suffix}`;
    const max = `max${suffix}`;
    for (const check of checks) {
      if (check.check === "min_length" || check.check === "length") {
        out[min] = Math.max(check.value, (out[min] as number | undefined) ?? 0);
      }
      if (check.check === "max_length" || check.check === "length") {
        out[max] = Math.min(
          check.value,
          (out[max] as number | undefined) ?? Infinity,
        );
      }
    }
    return out;
  }

  string(checks: SchemaDef["checks"], pointer: string): JsonSchema {
    const out: JsonSchema = {
      type: "string",
      ...this.lengths(checks, "Length"),
    };
    const patterns: string[] = [];
    for (const check of checks) {
      switch (check.check) {
        case "regex":
          patterns.push(check.pattern.source);
          break;
        case "starts_with":
          patterns.push(`^${escapeRegex(check.value)}`);
          break;
        case "ends_with":
          patterns.push(`${escapeRegex(check.value)}$`);
          break;
        case "includes":
          patterns.push(escapeRegex(check.value));
          break;
        case "format":
          switch (check.format) {
            case "base64":
              if (!this.strict) out.contentEncoding = "base64";
              break;
            case "base64url":
              patterns.push(BASE64URL.source);
              break;
            case "hex":
              patterns.push(HEX.source);
              break;
            case "cidrv4":
              patterns.push(CIDR_V4_PATTERN);
              break;
            case "cidrv6":
              patterns.push(CIDR_V6_PATTERN);
              break;
            case "ulid":
              patterns.push(ULID_PATTERN);
              break;
            case "jwt":
              patterns.push(JWT_PATTERN);
              break;
            default:
              out.format = formatName(check.format);
          }
          break;
      }
    }
    if (patterns.length > 0) out.pattern = patterns[0];
    if (patterns.length > 1 && this.strict) {
      this.refuse(
        `a string with ${patterns.length} patterns needs allOf, which is not supported`,
        pointer,
        "combine the pattern, format and affix checks into one .regex() in strict mode",
      );
    }
    if (patterns.length > 1) {
      out.allOf = patterns.slice(1).map((pattern) => ({ pattern }));
    }
    return out;
  }
}

function header(writer: Writer, options: JsonSchemaOptions): JsonSchema {
  return (options.$schema ?? !writer.strict) ? { $schema: DRAFT } : {};
}

/** The JSON Schema for `schema`, with a `$schema` key and any `$defs`. */
export function toJSONSchema(
  schema: AnySchema,
  options: JsonSchemaOptions = {},
): JsonSchema {
  const writer = new Writer(options);
  let root = schema;
  while (root.def.kind === "lazy") root = root.def.getter();
  writer.root = root;
  const body = writer.body(root, "#");
  if (writer.strict && body.type !== "object") {
    writer.refuse(
      `${
        body.type === undefined
          ? "the root has no single type"
          : `the root has type ${JSON.stringify(body.type)}`
      }, but it must be an object`,
      "#",
      "wrap the value in v.object({ ... }) in strict mode",
    );
  }
  const out: JsonSchema = { ...header(writer, options), ...body };
  if (writer.defs.size > 0) out.$defs = sorted(writer.defs);
  return out;
}

/**
 * One document whose `$defs` holds every named schema among `values` (a
 * module's exports, say), plus the named and lazy schemas they reference.
 * Values that are not named schemas are ignored; `$defs` is sorted by name.
 * The `openai-strict` target applies its rules to each entry, but there is
 * no root to require an object of.
 */
export function toJSONSchemaBundle(
  values: Readonly<Record<string, unknown>> | Iterable<unknown>,
  options: JsonSchemaOptions = {},
): JsonSchema {
  const writer = new Writer(options);
  const items = Symbol.iterator in values
    ? [...(values as Iterable<unknown>)]
    : Object.values(values);
  for (const value of items) {
    if (!isSchema(value)) continue;
    const id = idOf(value);
    if (id !== undefined) writer.define(value, id);
  }
  return { ...header(writer, options), $defs: sorted(writer.defs) };
}
