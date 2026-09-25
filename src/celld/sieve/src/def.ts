// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The definitions behind schemas. Every schema carries one as `def`: a
 * frozen, plain descriptor with a `kind`, its `checks` (each a `check` name
 * plus its parameters), its children (`shape`, `element`, `options`,
 * `inner`, ...) and its `meta`. The interpreter in `schema.ts` reads these
 * and nothing else, so a tool that walks the tree sees everything a parse
 * does. The only functions in a def are the user's own: refinements,
 * transforms, default and catch factories, lazy getters and `instanceof`
 * classes; each sits in a node or check of its own kind, so a walker can
 * tell where they are even though it cannot see inside them.
 *
 * The shapes here are the format `@celld/sieve/introspect` documents; see
 * `DEF_VERSION` there.
 *
 * @module
 */

import type { Issue, Path } from "./errors.ts";
import type { AnySchema } from "./schema.ts";

/** A value `v.literal` accepts. */
export type Primitive = string | number | bigint | boolean | null | undefined;

/**
 * Descriptive metadata. `title`, `description`, `examples` and the other
 * keys go into JSON Schema as they are; `id` names the schema, making it a
 * `$defs` entry. An `id` belongs to the schema it was set on: schemas
 * derived from it (with `.describe`, `.min`, ...) do not inherit it.
 */
export interface Meta {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly examples?: readonly unknown[];
  readonly deprecated?: boolean;
  readonly [key: string]: unknown;
}

/** The string formats with a check of their own. */
export type StringFormat =
  | "email"
  | "url"
  | "uuid"
  | "datetime"
  | "date"
  | "base64"
  | "base64url"
  | "hex"
  | "ipv4"
  | "ipv6"
  | "cidrv4"
  | "cidrv6"
  | "ulid"
  | "jwt"
  | "time"
  | "duration";

interface CheckBase {
  /** A custom message for the issue this check raises. */
  readonly message?: string;
}

/** A minimum, maximum or exact `.length` of a string, array or bytes. */
export interface LengthCheck extends CheckBase {
  readonly check: "min_length" | "max_length" | "length";
  readonly value: number;
}

/** A regular expression a string must match. */
export interface RegexCheck extends CheckBase {
  readonly check: "regex";
  readonly pattern: RegExp;
}

/** A substring a string must start with, end with or contain. */
export interface AffixCheck extends CheckBase {
  readonly check: "starts_with" | "ends_with" | "includes";
  readonly value: string;
}

/**
 * A string format. `offset` and `local` apply to `datetime`, `precision`
 * to `datetime` and `time` (see `DatetimeOptions`), and `alg` to `jwt`.
 */
export interface FormatCheck extends CheckBase {
  readonly check: "format";
  readonly format: StringFormat;
  readonly offset?: boolean;
  readonly local?: boolean;
  readonly precision?: number;
  /** The `alg` a `jwt` header must name. */
  readonly alg?: string;
}

/** A string rewrite that runs in check order: `trim` or a case change. */
export interface OverwriteCheck extends CheckBase {
  readonly check: "trim" | "to_lower_case" | "to_upper_case";
}

/** A lower (`min`) or upper (`max`) bound on a number or bigint. */
export interface BoundCheck extends CheckBase {
  readonly check: "min" | "max";
  readonly value: number | bigint;
  readonly inclusive: boolean;
}

/** A number that must be a multiple of `value`. */
export interface MultipleOfCheck extends CheckBase {
  readonly check: "multiple_of";
  readonly value: number;
}

/** A number that must be a safe integer. */
export interface IntCheck extends CheckBase {
  readonly check: "int";
}

/** What a refinement's `when` sees: the value so far and its issues. */
export interface RefinementState {
  readonly value: unknown;
  readonly issues: readonly Issue[];
}

/**
 * When a refinement runs and what its failure does, as zod 4's options:
 * `when` decides whether it runs (by default, only on an issue-free value),
 * and `abort` skips the checks after it once it has raised an issue.
 */
export interface RefinementOptions {
  /**
   * Whether to run, given the value and the issues found so far. Without
   * it, the refinement runs only when there are none. It is never called
   * when the value has the wrong type.
   */
  readonly when?: (state: RefinementState) => boolean;
  /** Skip the checks after this one when it raises an issue. */
  readonly abort?: boolean;
}

/** A `.refine` predicate: a falsy result raises a `custom` issue. */
export interface RefineCheck extends CheckBase, RefinementOptions {
  readonly check: "refine";
  readonly fn: (value: unknown) => unknown;
  /** Appended to the value's path in the issue. */
  readonly path?: Path;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** A `.check` function, which adds its own issues. */
export interface CustomCheck extends CheckBase, RefinementOptions {
  readonly check: "custom";
  readonly fn: (context: CheckContext<unknown>) => unknown;
}

/** Any check. */
export type Check =
  | LengthCheck
  | RegexCheck
  | AffixCheck
  | FormatCheck
  | OverwriteCheck
  | BoundCheck
  | MultipleOfCheck
  | IntCheck
  | RefineCheck
  | CustomCheck;

/** An issue a refinement, check or transform raises itself. */
export interface CustomIssueInput {
  readonly message: string;
  /** Appended to the value's path. */
  readonly path?: Path;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** What a `.check` function receives. */
export interface CheckContext<T> {
  readonly value: T;
  readonly path: Path;
  /** Adds a `custom` issue; a string is its message. */
  addIssue(issue: string | CustomIssueInput): void;
}

/** What a `.transform` function receives besides the value. */
export interface TransformContext {
  /**
   * What the schema `.transform` was called on received, before it parsed
   * it: in `a.transform(f)`, the input of `a`, so `f` can keep the original
   * alongside what `a` made of it. Every transform in a chain
   * (`a.transform(f).transform(g)`) sees the chain's input.
   */
  readonly input: unknown;
  readonly path: Path;
  /** Adds a `custom` issue; the parse fails but the transform's value is kept. */
  addIssue(issue: string | CustomIssueInput): void;
}

/** What a `.catch` factory receives. */
export interface CatchContext {
  readonly input: unknown;
  readonly issues: readonly Issue[];
}

interface DefBase {
  readonly checks: readonly Check[];
  /** A custom message for this schema's type error. */
  readonly message?: string;
  readonly meta?: Meta;
}

/** `v.string()`; `coerce` is set by `v.coerce.string()`. */
export interface StringDef extends DefBase {
  readonly kind: "string";
  readonly coerce: boolean;
}

/** `v.number()` (finite numbers); `v.int()` adds an `int` check. */
export interface NumberDef extends DefBase {
  readonly kind: "number";
  readonly coerce: boolean;
}

/** `v.bigint()`. */
export interface BigIntDef extends DefBase {
  readonly kind: "bigint";
  readonly coerce: boolean;
}

/** `v.boolean()`. */
export interface BooleanDef extends DefBase {
  readonly kind: "boolean";
  readonly coerce: boolean;
}

/** `v.date()`: a valid `Date`. */
export interface DateDef extends DefBase {
  readonly kind: "date";
  readonly coerce: boolean;
}

/** The `Temporal` types sieve has schemas for. */
export type TemporalType =
  | "instant"
  | "zoned_date_time"
  | "plain_date"
  | "plain_time"
  | "plain_date_time"
  | "duration";

/**
 * `v.instant()`, `v.plainDate()` and the other `Temporal` schemas, which
 * accept an instance of the type. With `coerce`, set by the string
 * conversions (`.toInstant()`, ...), it takes a string instead and parses
 * it with `@celld/isotime`'s strict parsers.
 */
export interface TemporalDef extends DefBase {
  readonly kind: "temporal";
  readonly type: TemporalType;
  readonly coerce: boolean;
}

/** A schema with no parameters; `json` is `v.json()`, any plain JSON value. */
export interface AtomDef extends DefBase {
  readonly kind: "null" | "undefined" | "unknown" | "never" | "bytes" | "json";
}

/** `v.literal(...)`. */
export interface LiteralDef extends DefBase {
  readonly kind: "literal";
  readonly values: readonly Primitive[];
}

/** `v.enum([...])`. */
export interface EnumDef extends DefBase {
  readonly kind: "enum";
  readonly values: readonly string[];
}

/** `v.instanceof(Class)`. */
export interface InstanceOfDef extends DefBase {
  readonly kind: "instanceof";
  // deno-lint-ignore no-explicit-any
  readonly class: abstract new (...args: any[]) => unknown;
}

/**
 * `v.object(shape)`. Without `catchall` unknown keys are stripped; a
 * `never` catchall (`.strict()`) rejects them, an `unknown` one (`.loose()`)
 * keeps them, and any other schema validates them.
 */
export interface ObjectDef extends DefBase {
  readonly kind: "object";
  readonly shape: Readonly<Record<string, AnySchema>>;
  readonly catchall?: AnySchema;
  /**
   * Set by `.strict({ perKey: true })`: one `unrecognized_keys` issue per
   * unknown key, at that key's path, instead of one on the object.
   */
  readonly perKey?: true;
}

/** `v.array(element)`. */
export interface ArrayDef extends DefBase {
  readonly kind: "array";
  readonly element: AnySchema;
}

/** `v.tuple(items, rest?)`. */
export interface TupleDef extends DefBase {
  readonly kind: "tuple";
  readonly items: readonly AnySchema[];
  readonly rest?: AnySchema;
}

/** `v.record(key, value)` and `v.map(key, value)`. */
export interface KeyValueDef extends DefBase {
  readonly kind: "record" | "map";
  readonly key: AnySchema;
  readonly value: AnySchema;
}

/** `v.set(value)`. */
export interface SetDef extends DefBase {
  readonly kind: "set";
  readonly value: AnySchema;
}

/** `v.union(options)`. */
export interface UnionDef extends DefBase {
  readonly kind: "union";
  readonly options: readonly AnySchema[];
}

/** `v.discriminatedUnion(discriminator, options)`; options are objects. */
export interface DiscriminatedUnionDef extends DefBase {
  readonly kind: "discriminated_union";
  readonly discriminator: string;
  readonly options: readonly AnySchema[];
}

/** `v.intersection(left, right)`. */
export interface IntersectionDef extends DefBase {
  readonly kind: "intersection";
  readonly left: AnySchema;
  readonly right: AnySchema;
}

/** `v.lazy(getter)`; the getter is called once and its result kept. */
export interface LazyDef extends DefBase {
  readonly kind: "lazy";
  readonly getter: () => AnySchema;
}

/** A wrapper around one schema: `.optional()`, `.nullable()`, `.readonly()`. */
export interface WrapperDef extends DefBase {
  readonly kind: "optional" | "nullable" | "readonly";
  readonly inner: AnySchema;
}

/** `.default(...)`: exactly one of `value` and `factory` is set. */
export interface DefaultDef extends DefBase {
  readonly kind: "default";
  readonly inner: AnySchema;
  readonly value?: unknown;
  readonly factory?: () => unknown;
}

/** `.catch(...)`: exactly one of `value` and `factory` is set. */
export interface CatchDef extends DefBase {
  readonly kind: "catch";
  readonly inner: AnySchema;
  readonly value?: unknown;
  readonly factory?: (context: CatchContext) => unknown;
}

/** `.pipe(out)`: `in`'s output is `out`'s input. `.transform` is a pipe too. */
export interface PipeDef extends DefBase {
  readonly kind: "pipe";
  readonly in: AnySchema;
  readonly out: AnySchema;
}

/** A transform function, the `out` of the pipe `.transform` builds. */
export interface TransformDef extends DefBase {
  readonly kind: "transform";
  readonly fn: (value: unknown, context: TransformContext) => unknown;
}

/** Every definition. */
export type SchemaDef =
  | StringDef
  | NumberDef
  | BigIntDef
  | BooleanDef
  | DateDef
  | TemporalDef
  | AtomDef
  | LiteralDef
  | EnumDef
  | InstanceOfDef
  | ObjectDef
  | ArrayDef
  | TupleDef
  | KeyValueDef
  | SetDef
  | UnionDef
  | DiscriminatedUnionDef
  | IntersectionDef
  | LazyDef
  | WrapperDef
  | DefaultDef
  | CatchDef
  | PipeDef
  | TransformDef;

/** Every `kind`. */
export type SchemaKind = SchemaDef["kind"];
