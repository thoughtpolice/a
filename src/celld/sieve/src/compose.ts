// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Schemas built from other schemas: arrays, tuples, records, maps, sets,
 * unions, discriminated unions, intersections and lazy (recursive) schemas.
 * Every element, entry and option is checked and all issues are kept.
 *
 * @module
 */

import type {
  ArrayDef,
  DiscriminatedUnionDef,
  IntersectionDef,
  KeyValueDef,
  LazyDef,
  Primitive,
  SetDef,
  TupleDef,
  UnionDef,
} from "./def.ts";
import {
  type Issue,
  makeIssue,
  type Message,
  messageField,
  missingKeyIssues,
  type Path,
  type PathSegment,
} from "./errors.ts";
import type { ObjectSchema } from "./object.ts";
import {
  all,
  type AnySchema,
  type Context,
  type Input,
  invalidType,
  ok,
  type Output,
  type Payload,
  type Result,
  Schema,
  then,
} from "./schema.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gather(payloads: Payload[], issues: Issue[]): unknown[] {
  return payloads.map((payload) => {
    issues.push(...payload.issues);
    return payload.value;
  });
}

/**
 * An array whose elements all match `T`. A hole is an element that is
 * `undefined`, so it fails unless `T` accepts `undefined`.
 */
export class ArraySchema<T extends AnySchema>
  extends Schema<Output<T>[], Input<T>[]> {
  declare readonly def: ArrayDef;

  /** The element schema. */
  get element(): T {
    return this.def.element as T;
  }

  /** At least `length` elements. */
  min(length: number, message?: Message): this {
    return this.addCheck({
      check: "min_length",
      value: length,
      ...messageField(message),
    });
  }

  /** At most `length` elements. */
  max(length: number, message?: Message): this {
    return this.addCheck({
      check: "max_length",
      value: length,
      ...messageField(message),
    });
  }

  /** Exactly `length` elements. */
  length(length: number, message?: Message): this {
    return this.addCheck({
      check: "length",
      value: length,
      ...messageField(message),
    });
  }

  /** At least one element: `min(1)`. The type stays `T[]`, as in zod 4. */
  nonempty(message?: Message): this {
    return this.min(1, message);
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    if (!Array.isArray(input)) {
      return invalidType(path, "array", input, this.def.message);
    }
    const element = this.def.element;
    // A hole is checked as `undefined` (`map` would skip it).
    const results: Result[] = [];
    for (let index = 0; index < input.length; index++) {
      results.push(element["~run"](input[index], [...path, index], context));
    }
    return then(all(results), (payloads) => {
      const issues: Issue[] = [];
      const value = gather(payloads, issues);
      return { value, issues, aborted: false };
    });
  }
}

/** The output of a tuple with items `T` and rest `R`. */
export type TupleOutput<T extends readonly AnySchema[], R> = [
  ...{ -readonly [K in keyof T]: Output<T[K]> },
  ...(R extends AnySchema ? Output<R>[] : []),
];

/** The input of a tuple with items `T` and rest `R`. */
export type TupleInput<T extends readonly AnySchema[], R> = [
  ...{ -readonly [K in keyof T]: Input<T[K]> },
  ...(R extends AnySchema ? Input<R>[] : []),
];

/**
 * A fixed-length array, or a fixed prefix then `rest`. Without `rest`,
 * extra elements are a `too_big` issue; missing ones are checked as
 * `undefined`, so optional items may be left off.
 */
export class TupleSchema<
  T extends readonly AnySchema[],
  R extends AnySchema | undefined = undefined,
> extends Schema<TupleOutput<T, R>, TupleInput<T, R>> {
  declare readonly def: TupleDef;

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    if (!Array.isArray(input)) {
      return invalidType(path, "array", input, this.def.message);
    }
    const { items, rest } = this.def;
    const issues: Issue[] = [];
    if (rest === undefined && input.length > items.length) {
      issues.push(
        makeIssue(path, {
          code: "too_big",
          origin: "array",
          maximum: items.length,
          inclusive: true,
        }),
      );
    }
    const results = items.map((item, index) =>
      item["~run"](input[index], [...path, index], context)
    );
    if (rest !== undefined) {
      for (let index = items.length; index < input.length; index++) {
        results.push(rest["~run"](input[index], [...path, index], context));
      }
    }
    return then(all(results), (payloads) => {
      const value = gather(payloads, issues);
      return { value, issues, aborted: false };
    });
  }
}

type Key = PropertyKey;

/**
 * An object used as a dictionary. Every key goes through the key schema
 * (a failure is an `invalid_key` issue) and every value through the value
 * schema. With an enum or literal key schema every key is required.
 */
export class RecordSchema<K extends Schema<Key, Key>, V extends AnySchema>
  extends Schema<Record<Output<K>, Output<V>>, Record<Input<K>, Input<V>>> {
  declare readonly def: KeyValueDef;

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    if (!isObject(input)) {
      return invalidType(path, "object", input, this.def.message);
    }
    const { key: keySchema, value: valueSchema } = this.def;
    const keyDef = keySchema.def;
    const required = keyDef.kind === "enum" || keyDef.kind === "literal"
      ? (keyDef.values as readonly Primitive[]).filter((value) =>
        typeof value === "string"
      ) as string[]
      : [];
    const keys = [...new Set([...required, ...Object.keys(input)])];
    const entries = keys.map((key) =>
      then(keySchema["~run"](key, [], context), (keyPayload) => {
        if (keyPayload.issues.length > 0) {
          const issue = makeIssue([...path, key], {
            code: "invalid_key",
            origin: "record",
            issues: keyPayload.issues,
          });
          return { key, issues: [issue], skip: true, value: undefined };
        }
        const here = Object.hasOwn(input, key);
        return then(
          valueSchema["~run"](
            here ? input[key] : undefined,
            [...path, key],
            context,
          ),
          (payload) => ({
            key: String(keyPayload.value),
            issues: here
              ? payload.issues
              : missingKeyIssues(payload.issues, [...path, key]),
            skip: !here && payload.value === undefined,
            value: payload.value,
          }),
        );
      })
    );
    return then(all(entries), (done) => {
      const issues: Issue[] = [];
      const value: Record<string, unknown> = {};
      for (const entry of done) {
        issues.push(...entry.issues);
        if (entry.skip) continue;
        if (entry.key === "__proto__") {
          Object.defineProperty(value, entry.key, {
            value: entry.value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        } else {
          value[entry.key] = entry.value;
        }
      }
      return { value, issues, aborted: false };
    });
  }
}

function segment(key: unknown, index: number): PathSegment {
  return typeof key === "string" || typeof key === "number" ? key : index;
}

/**
 * A `Map`. Key failures are `invalid_key` issues; paths use the key when
 * it is a string or number, else the entry's position.
 */
export class MapSchema<K extends AnySchema, V extends AnySchema>
  extends Schema<Map<Output<K>, Output<V>>, Map<Input<K>, Input<V>>> {
  declare readonly def: KeyValueDef;

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    if (!(input instanceof Map)) {
      return invalidType(path, "Map", input, this.def.message);
    }
    const { key: keySchema, value: valueSchema } = this.def;
    const entries = [...input].map(([key, item], index) => {
      const at = [...path, segment(key, index)];
      return then(
        all([
          keySchema["~run"](key, [], context),
          valueSchema["~run"](item, at, context),
        ]),
        ([keyPayload, valuePayload]) => {
          const issues = keyPayload.issues.length === 0 ? [] : [
            makeIssue(at, {
              code: "invalid_key",
              origin: "map",
              issues: keyPayload.issues,
            }),
          ];
          issues.push(...valuePayload.issues);
          return { key: keyPayload.value, value: valuePayload.value, issues };
        },
      );
    });
    return then(all(entries), (done) => {
      const issues: Issue[] = [];
      const value = new Map<unknown, unknown>();
      for (const entry of done) {
        issues.push(...entry.issues);
        value.set(entry.key, entry.value);
      }
      return { value, issues, aborted: false };
    });
  }
}

/** A `Set`; element paths are positions in iteration order. */
export class SetSchema<V extends AnySchema>
  extends Schema<Set<Output<V>>, Set<Input<V>>> {
  declare readonly def: SetDef;

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    if (!(input instanceof Set)) {
      return invalidType(path, "Set", input, this.def.message);
    }
    const element = this.def.value;
    const results = [...input].map((item, index) =>
      element["~run"](item, [...path, index], context)
    );
    return then(all(results), (payloads) => {
      const issues: Issue[] = [];
      const value = new Set(gather(payloads, issues));
      return { value, issues, aborted: false };
    });
  }
}

/**
 * Whether an aborted option failed only on an unknown discriminator: the
 * value had the right type and a tag, just not a known one. That got
 * further than an option of the wrong type, so it is worth reporting.
 */
function unknownTag(payload: Payload): boolean {
  if (!payload.aborted || payload.issues.length !== 1) return false;
  const issue = payload.issues[0];
  return issue.code === "invalid_union" && issue.discriminator !== undefined;
}

function unionFailure(
  failures: Payload[],
  input: unknown,
  path: Path,
  message: string | undefined,
): Payload {
  const plausible = failures.filter((payload) => !payload.aborted);
  if (plausible.length === 1) return plausible[0];
  if (plausible.length === 0) {
    const tagged = failures.filter(unknownTag);
    if (tagged.length === 1) return tagged[0];
  }
  return {
    value: input,
    issues: [
      makeIssue(
        path,
        {
          code: "invalid_union",
          errors: failures.map((payload) => payload.issues),
        },
        message,
      ),
    ],
    aborted: plausible.length === 0,
  };
}

/**
 * The first option (in order) that accepts the value. When none does, the
 * option that got furthest is reported as it is: the one option that had
 * the right type, or else the one discriminated union that failed only on
 * an unknown tag (so `v.union([Event, v.array(Event)])` still says
 * "unknown type; expected ..."). Otherwise one `invalid_union` issue holds
 * every option's issues.
 */
export class UnionSchema<T extends readonly AnySchema[]>
  extends Schema<Output<T[number]>, Input<T[number]>> {
  declare readonly def: UnionDef;

  /** The options. */
  get options(): T {
    return this.def.options as unknown as T;
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    const { options, message } = this.def;
    const failures: Payload[] = [];
    const step = (start: number): Result => {
      for (let index = start; index < options.length; index++) {
        const result = options[index]["~run"](input, path, context);
        if (result instanceof Promise) {
          return result.then((payload) => {
            if (payload.issues.length === 0) return payload;
            failures.push(payload);
            return step(index + 1);
          });
        }
        if (result.issues.length === 0) return result;
        failures.push(result);
      }
      return unionFailure(failures, input, path, message);
    };
    return step(0);
  }
}

const tagCache = new WeakMap<DiscriminatedUnionDef, Map<unknown, AnySchema>>();

/** Maps each discriminator value to its option; throws on a bad option. */
export function discriminatorTags(
  def: DiscriminatedUnionDef,
): Map<unknown, AnySchema> {
  let tags = tagCache.get(def);
  if (tags !== undefined) return tags;
  tags = new Map();
  for (const option of def.options) {
    const optionDef = option.def;
    const tag = optionDef.kind === "object"
      ? optionDef.shape[def.discriminator]?.def
      : undefined;
    if (tag?.kind !== "literal" && tag?.kind !== "enum") {
      throw new Error(
        `sieve: every discriminatedUnion option needs a literal or enum ${
          JSON.stringify(def.discriminator)
        } key`,
      );
    }
    for (const value of tag.values) {
      if (tags.has(value)) {
        throw new Error(
          `sieve: discriminator value ${JSON.stringify(value)} is used twice`,
        );
      }
      tags.set(value, option);
    }
  }
  tagCache.set(def, tags);
  return tags;
}

/**
 * A union of objects told apart by one key. The key's value picks the
 * option directly; an unknown value is an `invalid_union` issue at the key.
 */
export class DiscriminatedUnionSchema<
  K extends string,
  T extends readonly ObjectSchema<
    // deno-lint-ignore no-explicit-any
    any,
    // deno-lint-ignore no-explicit-any
    any
  >[],
> extends Schema<Output<T[number]>, Input<T[number]>> {
  declare readonly def: DiscriminatedUnionDef;

  /** The options. */
  get options(): T {
    return this.def.options as unknown as T;
  }

  /** The key that tells the options apart. */
  get discriminator(): K {
    return this.def.discriminator as K;
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    if (!isObject(input)) {
      return invalidType(path, "object", input, this.def.message);
    }
    const tags = discriminatorTags(this.def);
    const key = this.def.discriminator;
    const option = tags.get(input[key]);
    if (option !== undefined) return option["~run"](input, path, context);
    return {
      value: input,
      issues: [
        makeIssue(
          [...path, key],
          {
            code: "invalid_union",
            errors: [],
            discriminator: key,
            options: [...tags.keys()],
          },
          this.def.message,
        ),
      ],
      aborted: true,
    };
  }
}

function isTemporal(value: unknown): value is { toString(): string } {
  return value instanceof Temporal.Instant ||
    value instanceof Temporal.ZonedDateTime ||
    value instanceof Temporal.PlainDate ||
    value instanceof Temporal.PlainTime ||
    value instanceof Temporal.PlainDateTime ||
    value instanceof Temporal.Duration;
}

type Merged = { ok: true; value: unknown } | { ok: false; path: Path };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function mergeValues(left: unknown, right: unknown): Merged {
  if (Object.is(left, right)) return { ok: true, value: left };
  if (
    left instanceof Date && right instanceof Date &&
    left.getTime() === right.getTime()
  ) {
    return { ok: true, value: left };
  }
  if (isTemporal(left) && isTemporal(right)) {
    return Object.getPrototypeOf(left) === Object.getPrototypeOf(right) &&
        left.toString() === right.toString()
      ? { ok: true, value: left }
      : { ok: false, path: [] };
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const value: Record<string, unknown> = { ...left };
    for (const key of Object.keys(right)) {
      if (!Object.hasOwn(left, key)) {
        value[key] = right[key];
        continue;
      }
      const merged = mergeValues(left[key], right[key]);
      if (!merged.ok) return { ok: false, path: [key, ...merged.path] };
      value[key] = merged.value;
    }
    return { ok: true, value };
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return { ok: false, path: [] };
    const value: unknown[] = [];
    for (let index = 0; index < left.length; index++) {
      const merged = mergeValues(left[index], right[index]);
      if (!merged.ok) return { ok: false, path: [index, ...merged.path] };
      value.push(merged.value);
    }
    return { ok: true, value };
  }
  return { ok: false, path: [] };
}

/**
 * Both schemas must accept the value; their outputs are merged (objects key
 * by key, arrays element by element). Outputs that disagree are an
 * `invalid_intersection` issue at the first conflict.
 */
export class IntersectionSchema<A extends AnySchema, B extends AnySchema>
  extends Schema<Output<A> & Output<B>, Input<A> & Input<B>> {
  declare readonly def: IntersectionDef;

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    const { left, right } = this.def;
    return then(
      all([
        left["~run"](input, path, context),
        right["~run"](input, path, context),
      ]),
      ([a, b]): Payload => {
        if (a.issues.length > 0 || b.issues.length > 0) {
          return {
            value: input,
            issues: [...a.issues, ...b.issues],
            aborted: a.aborted || b.aborted,
          };
        }
        const merged = mergeValues(a.value, b.value);
        if (merged.ok) return ok(merged.value);
        return {
          value: input,
          issues: [
            makeIssue([...path, ...merged.path], {
              code: "invalid_intersection",
            }),
          ],
          aborted: false,
        };
      },
    );
  }
}

/** A schema built on first use, for recursive types. */
export class LazySchema<T extends AnySchema>
  extends Schema<Output<T>, Input<T>> {
  declare readonly def: LazyDef;

  /** The schema the getter returns (built once). */
  get schema(): T {
    return this.def.getter() as T;
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    return this.def.getter()["~run"](input, path, context);
  }
}
