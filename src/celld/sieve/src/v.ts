// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The builders, imported as the namespace `v`:
 *
 * ```ts
 * import { v } from "@celld/sieve";
 *
 * const User = v.object({ name: v.string().min(1), email: v.email() });
 * type User = v.Infer<typeof User>;
 * ```
 *
 * `null`, `undefined`, `enum` and `instanceof` are reserved words, so they
 * are exported under those names from functions with other names.
 *
 * @module
 */

import {
  ArraySchema,
  DiscriminatedUnionSchema,
  discriminatorTags,
  IntersectionSchema,
  LazySchema,
  MapSchema,
  RecordSchema,
  SetSchema,
  TupleSchema,
  UnionSchema,
} from "./compose.ts";
import type { DiscriminatedUnionDef, Primitive, TemporalType } from "./def.ts";
import { type Message, messageField } from "./errors.ts";
import { JsonValueSchema } from "./json_value.ts";
import { ObjectSchema, type Shape, type StrictOptions } from "./object.ts";
import {
  BigIntSchema,
  BooleanSchema,
  BytesSchema,
  DateSchema,
  EnumSchema,
  InstanceOfSchema,
  LiteralSchema,
  NeverSchema,
  NullSchema,
  NumberSchema,
  UndefinedSchema,
  UnknownSchema,
} from "./primitives.ts";
import {
  type AnySchema,
  NullableSchema,
  OptionalSchema,
  PipeSchema,
  type Schema,
  TransformSchema,
} from "./schema.ts";
import {
  type DatetimeOptions,
  type JwtOptions,
  StringSchema,
  type TimeOptions,
} from "./string.ts";
import { TemporalSchema } from "./temporal.ts";

export type {
  AnySchema,
  Brand,
  Infer,
  Input,
  Output,
  SafeParseResult,
  Schema,
} from "./schema.ts";
export { prettifyError } from "./errors.ts";
export type { JsonValue } from "./json_value.ts";

/** A string. */
export function string(message?: Message): StringSchema {
  return new StringSchema({
    kind: "string",
    coerce: false,
    checks: [],
    ...messageField(message),
  });
}

/** A finite number (no `NaN` or `Infinity`). */
export function number(message?: Message): NumberSchema {
  return new NumberSchema({
    kind: "number",
    coerce: false,
    checks: [],
    ...messageField(message),
  });
}

/** A safe integer: `number().int()`. */
export function int(message?: Message): NumberSchema {
  return number(message).int(message);
}

/** A bigint. */
export function bigint(message?: Message): BigIntSchema {
  return new BigIntSchema({
    kind: "bigint",
    coerce: false,
    checks: [],
    ...messageField(message),
  });
}

/** A boolean. */
export function boolean(message?: Message): BooleanSchema {
  return new BooleanSchema({
    kind: "boolean",
    coerce: false,
    checks: [],
    ...messageField(message),
  });
}

function nullSchema(message?: Message): NullSchema {
  return new NullSchema({ kind: "null", checks: [], ...messageField(message) });
}

function undefinedSchema(message?: Message): UndefinedSchema {
  return new UndefinedSchema({
    kind: "undefined",
    checks: [],
    ...messageField(message),
  });
}

export {
  enumSchema as enum,
  instanceOfSchema as instanceof,
  nullSchema as null,
  undefinedSchema as undefined,
};

/** Anything; the output is the input. */
export function unknown(): UnknownSchema {
  return new UnknownSchema({ kind: "unknown", checks: [] });
}

/**
 * Any plain JSON value, typed `JsonValue`: what `JSON.stringify` writes
 * as it is. `undefined`, functions, symbols, bigints, `NaN` and
 * `Infinity`, array holes, non-plain objects and cycles are issues.
 */
export function json(message?: Message): JsonValueSchema {
  return new JsonValueSchema({
    kind: "json",
    checks: [],
    ...messageField(message),
  });
}

/** Nothing: every value is an `invalid_type` issue. */
export function never(message?: Message): NeverSchema {
  return new NeverSchema({
    kind: "never",
    checks: [],
    ...messageField(message),
  });
}

/** Exactly `value`, or any of `values`. */
export function literal<const T extends Primitive>(
  value: T | readonly T[],
  message?: Message,
): LiteralSchema<T> {
  const values: readonly Primitive[] = Array.isArray(value) ? value : [value];
  return new LiteralSchema<T>({
    kind: "literal",
    values,
    checks: [],
    ...messageField(message),
  });
}

function enumSchema<const T extends readonly [string, ...string[]]>(
  values: T,
  message?: Message,
): EnumSchema<T[number]> {
  return new EnumSchema<T[number]>({
    kind: "enum",
    values,
    checks: [],
    ...messageField(message),
  });
}

/** A valid `Date`. */
export function date(message?: Message): DateSchema {
  return new DateSchema({
    kind: "date",
    coerce: false,
    checks: [],
    ...messageField(message),
  });
}

function instanceOfSchema<
  // deno-lint-ignore no-explicit-any
  C extends abstract new (...args: any[]) => unknown,
>(
  cls: C,
  message?: Message,
): InstanceOfSchema<InstanceType<C>> {
  return new InstanceOfSchema<InstanceType<C>>({
    kind: "instanceof",
    class: cls,
    checks: [],
    ...messageField(message),
  });
}

/** A `Uint8Array`. */
export function bytes(message?: Message): BytesSchema {
  return new BytesSchema({
    kind: "bytes",
    checks: [],
    ...messageField(message),
  });
}

/** `string().email()`. */
export function email(message?: Message): StringSchema {
  return string().email(message);
}

/** `string().url()`. */
export function url(message?: Message): StringSchema {
  return string().url(message);
}

/** `string().uuid()`. */
export function uuid(message?: Message): StringSchema {
  return string().uuid(message);
}

function temporal<T>(type: TemporalType, message?: Message): TemporalSchema<T> {
  return new TemporalSchema<T>({
    kind: "temporal",
    type,
    coerce: false,
    checks: [],
    ...messageField(message),
  });
}

/**
 * A `Temporal.Instant`. For RFC 3339 text, use
 * `iso.datetime({ offset: true }).toInstant()`.
 */
export function instant(message?: Message): TemporalSchema<Temporal.Instant> {
  return temporal("instant", message);
}

/** A `Temporal.ZonedDateTime`; it has no RFC 3339 string form. */
export function zonedDateTime(
  message?: Message,
): TemporalSchema<Temporal.ZonedDateTime> {
  return temporal("zoned_date_time", message);
}

/** A `Temporal.PlainDate`; from text, `iso.date().toPlainDate()`. */
export function plainDate(
  message?: Message,
): TemporalSchema<Temporal.PlainDate> {
  return temporal("plain_date", message);
}

/** A `Temporal.PlainTime`; from text, `iso.time().toPlainTime()`. */
export function plainTime(
  message?: Message,
): TemporalSchema<Temporal.PlainTime> {
  return temporal("plain_time", message);
}

/**
 * A `Temporal.PlainDateTime`; from text,
 * `iso.datetime({ local: true }).toPlainDateTime()`.
 */
export function plainDateTime(
  message?: Message,
): TemporalSchema<Temporal.PlainDateTime> {
  return temporal("plain_date_time", message);
}

/** A `Temporal.Duration`; from text, `iso.duration().toDuration()`. */
export function duration(
  message?: Message,
): TemporalSchema<Temporal.Duration> {
  return temporal("duration", message);
}

/** `string().datetime(options)`. */
export function datetime(options?: string | DatetimeOptions): StringSchema {
  return string().datetime(options);
}

/** `string().isoDate()`. */
export function isoDate(message?: Message): StringSchema {
  return string().isoDate(message);
}

/** `string().base64()`. */
export function base64(message?: Message): StringSchema {
  return string().base64(message);
}

/** `string().base64url()`. */
export function base64url(message?: Message): StringSchema {
  return string().base64url(message);
}

/** `string().hex()`. */
export function hex(message?: Message): StringSchema {
  return string().hex(message);
}

/** `string().ipv4()`. */
export function ipv4(message?: Message): StringSchema {
  return string().ipv4(message);
}

/** `string().ipv6()`. */
export function ipv6(message?: Message): StringSchema {
  return string().ipv6(message);
}

/** `string().cidrv4()`. */
export function cidrv4(message?: Message): StringSchema {
  return string().cidrv4(message);
}

/** `string().cidrv6()`. */
export function cidrv6(message?: Message): StringSchema {
  return string().cidrv6(message);
}

/** `string().ulid()`. */
export function ulid(message?: Message): StringSchema {
  return string().ulid(message);
}

/** `string().jwt(options)`: the shape of a JWT, not its signature. */
export function jwt(options?: string | JwtOptions): StringSchema {
  return string().jwt(options);
}

/**
 * The ISO 8601 formats, as zod 4's `z.iso`: `date` is `isoDate`,
 * `datetime` is `datetime`, `time` is `isoTime` and `duration` is
 * `isoDuration`.
 */
export const iso = Object.freeze({
  /** `string().isoDate()`. */
  date(message?: Message): StringSchema {
    return string().isoDate(message);
  },
  /** `string().isoTime(options)`. */
  time(options?: string | TimeOptions): StringSchema {
    return string().isoTime(options);
  },
  /** `string().datetime(options)`. */
  datetime(options?: string | DatetimeOptions): StringSchema {
    return string().datetime(options);
  },
  /** `string().isoDuration()`. */
  duration(message?: Message): StringSchema {
    return string().isoDuration(message);
  },
});

/** An object with these keys; unknown keys are stripped. */
export function object<S extends Shape>(
  shape: S,
  message?: Message,
): ObjectSchema<S> {
  return new ObjectSchema<S>({
    kind: "object",
    shape,
    checks: [],
    ...messageField(message),
  });
}

/**
 * An object that rejects unknown keys: `object(shape, message).strict()`.
 * The message is the type error's, as for `object`; `perKey: true` reports
 * each unknown key at its own path (see `.strict()`).
 */
export function strictObject<S extends Shape>(
  shape: S,
  options?: Message | StrictOptions,
): ObjectSchema<S> {
  const perKey = typeof options === "object" && "perKey" in options &&
    options.perKey === true;
  return object(shape, options).strict(perKey ? { perKey } : undefined);
}

/** An object that keeps unknown keys: `object(shape).loose()`. */
export function looseObject<S extends Shape>(
  shape: S,
  message?: Message,
): ObjectSchema<S, UnknownSchema> {
  return object(shape, message).loose();
}

/** An array of `element`. */
export function array<T extends AnySchema>(
  element: T,
  message?: Message,
): ArraySchema<T> {
  return new ArraySchema<T>({
    kind: "array",
    element,
    checks: [],
    ...messageField(message),
  });
}

/** A tuple of `items`, then any number of `rest`. */
export function tuple<
  const T extends readonly AnySchema[],
  R extends AnySchema | undefined = undefined,
>(items: T, rest?: R, message?: Message): TupleSchema<T, R> {
  return new TupleSchema<T, R>({
    kind: "tuple",
    items,
    ...(rest === undefined ? {} : { rest }),
    checks: [],
    ...messageField(message),
  });
}

/** An object used as a dictionary from `key` to `value`. */
export function record<
  K extends Schema<PropertyKey, PropertyKey>,
  V extends AnySchema,
>(key: K, value: V, message?: Message): RecordSchema<K, V> {
  return new RecordSchema<K, V>({
    kind: "record",
    key,
    value,
    checks: [],
    ...messageField(message),
  });
}

/** A `Map` from `key` to `value`. */
export function map<K extends AnySchema, V extends AnySchema>(
  key: K,
  value: V,
  message?: Message,
): MapSchema<K, V> {
  return new MapSchema<K, V>({
    kind: "map",
    key,
    value,
    checks: [],
    ...messageField(message),
  });
}

/** A `Set` of `value`. */
export function set<V extends AnySchema>(
  value: V,
  message?: Message,
): SetSchema<V> {
  return new SetSchema<V>({
    kind: "set",
    value,
    checks: [],
    ...messageField(message),
  });
}

/** Any of `options`; the first that accepts the value wins. */
export function union<const T extends readonly [AnySchema, ...AnySchema[]]>(
  options: T,
  message?: Message,
): UnionSchema<T> {
  return new UnionSchema<T>({
    kind: "union",
    options,
    checks: [],
    ...messageField(message),
  });
}

/** An object schema with key `K`. */
type Tagged<K extends string> =
  // deno-lint-ignore no-explicit-any
  & ObjectSchema<any, any>
  & { readonly shape: { readonly [P in K]: AnySchema } };

/**
 * Objects told apart by `discriminator`, whose schema in every option is a
 * literal or enum. Throws if an option has none or two share a value.
 */
export function discriminatedUnion<
  K extends string,
  const T extends readonly [Tagged<K>, ...Tagged<K>[]],
>(
  discriminator: K,
  options: T,
  message?: Message,
): DiscriminatedUnionSchema<K, T> {
  const def: DiscriminatedUnionDef = {
    kind: "discriminated_union",
    discriminator,
    options,
    checks: [],
    ...messageField(message),
  };
  discriminatorTags(def);
  return new DiscriminatedUnionSchema<K, T>(def);
}

/** Values both schemas accept; their outputs are merged. */
export function intersection<A extends AnySchema, B extends AnySchema>(
  left: A,
  right: B,
): IntersectionSchema<A, B> {
  return new IntersectionSchema<A, B>({
    kind: "intersection",
    left,
    right,
    checks: [],
  });
}

/**
 * A schema built by `getter` on first use, for recursive types. TypeScript
 * needs the type spelled out for those:
 *
 * ```ts
 * type Tree = { value: number; children: Tree[] };
 * const Tree: v.Schema<Tree> = v.object({
 *   value: v.number(),
 *   children: v.array(v.lazy(() => Tree)),
 * });
 * ```
 */
export function lazy<T extends AnySchema>(getter: () => T): LazySchema<T> {
  let schema: T | undefined;
  return new LazySchema<T>({
    kind: "lazy",
    getter: () => schema ??= getter(),
    checks: [],
  });
}

/** `schema.optional()`. */
export function optional<T extends AnySchema>(schema: T): OptionalSchema<T> {
  return schema.optional();
}

/** `schema.nullable()`. */
export function nullable<T extends AnySchema>(schema: T): NullableSchema<T> {
  return schema.nullable();
}

/** Applies `fn` to the raw input, then parses its result with `schema`. */
export function preprocess<T extends AnySchema>(
  fn: (input: unknown) => unknown,
  schema: T,
): PipeSchema<TransformSchema<unknown, unknown>, T> {
  const transform = new TransformSchema<unknown, unknown>({
    kind: "transform",
    fn,
    checks: [],
  });
  return transform.pipe(schema);
}

/**
 * Schemas that convert the input first (`String`, `Number`, `Boolean`,
 * `BigInt`, `new Date`) and accept any input type.
 */
export const coerce = Object.freeze({
  /** `String(input)`. */
  string(message?: Message): StringSchema<unknown> {
    return new StringSchema<unknown>({
      kind: "string",
      coerce: true,
      checks: [],
      ...messageField(message),
    });
  },
  /** `Number(input)`, which must be finite. */
  number(message?: Message): NumberSchema<unknown> {
    return new NumberSchema<unknown>({
      kind: "number",
      coerce: true,
      checks: [],
      ...messageField(message),
    });
  },
  /** `Boolean(input)`: `"false"` and `"0"` are `true`. */
  boolean(message?: Message): BooleanSchema<unknown> {
    return new BooleanSchema<unknown>({
      kind: "boolean",
      coerce: true,
      checks: [],
      ...messageField(message),
    });
  },
  /** `BigInt(input)`; what `BigInt` rejects is an `invalid_type` issue. */
  bigint(message?: Message): BigIntSchema<unknown> {
    return new BigIntSchema<unknown>({
      kind: "bigint",
      coerce: true,
      checks: [],
      ...messageField(message),
    });
  },
  /** `new Date(input)`, which must be valid. */
  date(message?: Message): DateSchema<unknown> {
    return new DateSchema<unknown>({
      kind: "date",
      coerce: true,
      checks: [],
      ...messageField(message),
    });
  },
});
