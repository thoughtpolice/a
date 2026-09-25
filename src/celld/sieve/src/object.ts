// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link ObjectSchema}: a fixed set of keys, each with its own schema.
 *
 * Unknown keys are stripped by default. `.strict()` rejects them with one
 * `unrecognized_keys` issue (or one per key, at the key, with `perKey`),
 * `.loose()` keeps them as they are, and
 * `.catchall(schema)` validates them; all three set the def's `catchall`
 * (to `never`, `unknown` and the schema). A key whose schema accepts a
 * missing value (`.optional()`) and is missing stays missing in the output;
 * `.default()` fills it. A required key that is missing is reported with
 * the message "missing required key" rather than its schema's type error.
 *
 * @module
 */

import type { ObjectDef } from "./def.ts";
import {
  type Issue,
  makeIssue,
  type Message,
  messageField,
  missingKeyIssues,
  type Path,
} from "./errors.ts";
import { EnumSchema, NeverSchema, UnknownSchema } from "./primitives.ts";
import {
  all,
  type AnySchema,
  type Context,
  type Input,
  invalidType,
  OptionalSchema,
  type Output,
  type Payload,
  type Result,
  Schema,
  then,
} from "./schema.ts";

/** The schemas of an object's keys. */
export type Shape = { readonly [key: string]: AnySchema };

/** Flattens an intersection into one object type, for readable hovers. */
export type Flatten<T> = { [K in keyof T]: T[K] } & unknown;

type OptionalKeys<S extends Shape, Side extends "in" | "out"> = {
  [K in keyof S]: S[K] extends
    { readonly "~opt": { readonly [P in Side]: true } } ? K
    : never;
}[keyof S];

/**
 * The index signature a catchall adds. Its value type includes the declared
 * keys' types, so that the declared keys stay valid properties.
 */
type Extra<S extends Shape, C, Side extends "in" | "out"> = C extends AnySchema
  ? [Output<C>] extends [never] ? unknown
  : Side extends "out" ? { [key: string]: Output<C> | Output<S[keyof S]> }
  : { [key: string]: Input<C> | Input<S[keyof S]> }
  : unknown;

/** The output of an object schema with shape `S` and catchall `C`. */
export type ObjectOutput<S extends Shape, C = undefined> = Flatten<
  & { [K in Exclude<keyof S, OptionalKeys<S, "out">>]: Output<S[K]> }
  & { [K in OptionalKeys<S, "out">]?: Output<S[K]> }
  & Extra<S, C, "out">
>;

/** The input of an object schema with shape `S` and catchall `C`. */
export type ObjectInput<S extends Shape, C = undefined> = Flatten<
  & { [K in Exclude<keyof S, OptionalKeys<S, "in">>]: Input<S[K]> }
  & { [K in OptionalKeys<S, "in">]?: Input<S[K]> }
  & Extra<S, C, "in">
>;

/** Keys to pick, omit or make optional: `{ name: true }`. */
export type Mask<S> = { readonly [K in keyof S]?: true };

/** `A` with `B`'s keys replacing its own. */
export type Merge<A, B> = Flatten<Omit<A, keyof B> & B>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setKey(target: Record<string, unknown>, key: string, value: unknown) {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

function has(record: Record<string, unknown>, key: string): boolean {
  return key === "__proto__" ? Object.hasOwn(record, key) : key in record;
}

/**
 * Options for `.strict()`: the unknown-key issue's message, and `perKey`
 * for one issue per unknown key at that key's path (so a form or a caller
 * can point at `questions.typo.critera`) instead of one on the object.
 */
export interface StrictOptions {
  readonly message?: string;
  readonly perKey?: boolean;
}

/** Selects the keys a mask names, or every key without a mask. */
function selected(mask: Mask<Shape> | undefined, key: string): boolean {
  return mask === undefined || mask[key] === true;
}

/**
 * A new object schema with another shape, and the unknown-key handling of
 * `keys` (default: `from`'s). It keeps the type
 * error message but not the checks (a refinement of the old shape need not
 * hold for the new one) or the metadata.
 */
function derive<S extends Shape, C extends AnySchema | undefined>(
  from: AnySchema,
  shape: Shape,
  keys: ObjectDef = from.def as ObjectDef,
): ObjectSchema<S, C> {
  const def = from.def as ObjectDef;
  const catchall = keys.catchall;
  return new ObjectSchema<S, C>({
    kind: "object",
    shape,
    checks: [],
    ...(catchall === undefined ? {} : { catchall }),
    ...(keys.perKey ? { perKey: true } : {}),
    ...(def.message === undefined ? {} : { message: def.message }),
  });
}

/** An object with a fixed shape; `C` is the catchall, if any. */
export class ObjectSchema<
  S extends Shape,
  C extends AnySchema | undefined = undefined,
> extends Schema<ObjectOutput<S, C>, ObjectInput<S, C>> {
  declare readonly def: ObjectDef;

  /** The key schemas. */
  get shape(): S {
    return this.def.shape as S;
  }

  /**
   * Rejects unknown keys with an `unrecognized_keys` issue on the object,
   * or with `{ perKey: true }` one issue per key at that key's path.
   */
  strict(options?: Message | StrictOptions): ObjectSchema<S, undefined> {
    const never = new NeverSchema({
      kind: "never",
      checks: [],
      ...messageField(options),
    });
    const perKey = typeof options === "object" &&
      (options as StrictOptions).perKey === true;
    return this.with({
      catchall: never,
      perKey: perKey ? true : undefined,
    }) as unknown as ObjectSchema<S, undefined>;
  }

  /** Drops unknown keys (the default). */
  strip(): ObjectSchema<S, undefined> {
    return this.with({
      catchall: undefined,
      perKey: undefined,
    }) as unknown as ObjectSchema<S, undefined>;
  }

  /** Keeps unknown keys as they are. */
  loose(): ObjectSchema<S, UnknownSchema> {
    const unknown = new UnknownSchema({ kind: "unknown", checks: [] });
    return this.with({
      catchall: unknown,
      perKey: undefined,
    }) as unknown as ObjectSchema<S, UnknownSchema>;
  }

  /** Validates unknown keys with `schema`. */
  catchall<T extends AnySchema>(schema: T): ObjectSchema<S, T> {
    return this.with({
      catchall: schema,
      perKey: undefined,
    }) as unknown as ObjectSchema<S, T>;
  }

  /** Adds keys (replacing any with the same name). */
  extend<X extends Shape>(shape: X): ObjectSchema<Merge<S, X>, C> {
    return derive(this, { ...this.def.shape, ...shape });
  }

  /** `extend` with another object's keys; its unknown-key mode wins. */
  merge<S2 extends Shape, C2 extends AnySchema | undefined>(
    other: ObjectSchema<S2, C2>,
  ): ObjectSchema<Merge<S, S2>, C2> {
    return derive(
      this,
      { ...this.def.shape, ...other.def.shape },
      other.def,
    );
  }

  /** Only the keys in `mask`. */
  pick<M extends Mask<S>>(
    mask: M,
  ): ObjectSchema<Flatten<Pick<S, Extract<keyof M, keyof S>>>, C> {
    const shape = Object.fromEntries(
      Object.entries(this.def.shape).filter(([key]) =>
        mask[key as keyof M] === true
      ),
    );
    return derive(this, shape);
  }

  /** All keys but those in `mask`. */
  omit<M extends Mask<S>>(mask: M): ObjectSchema<Flatten<Omit<S, keyof M>>, C> {
    const shape = Object.fromEntries(
      Object.entries(this.def.shape).filter(([key]) =>
        mask[key as keyof M] !== true
      ),
    );
    return derive(this, shape);
  }

  /** Every key (or those in `mask`) made optional. */
  partial(): ObjectSchema<{ [K in keyof S]: OptionalSchema<S[K]> }, C>;
  partial<M extends Mask<S>>(
    mask: M,
  ): ObjectSchema<
    { [K in keyof S]: K extends keyof M ? OptionalSchema<S[K]> : S[K] },
    C
  >;
  partial(mask?: Mask<Shape>): AnySchema {
    const shape = Object.fromEntries(
      Object.entries(this.def.shape).map(([key, schema]) => [
        key,
        selected(mask, key) ? schema.optional() : schema,
      ]),
    );
    return derive(this, shape);
  }

  /** Every key (or those in `mask`) with a top-level `.optional()` removed. */
  required(): ObjectSchema<{ [K in keyof S]: Unoptional<S[K]> }, C>;
  required<M extends Mask<S>>(
    mask: M,
  ): ObjectSchema<
    { [K in keyof S]: K extends keyof M ? Unoptional<S[K]> : S[K] },
    C
  >;
  required(mask?: Mask<Shape>): AnySchema {
    const shape = Object.fromEntries(
      Object.entries(this.def.shape).map(([key, schema]) => [
        key,
        selected(mask, key) && schema instanceof OptionalSchema
          ? schema.unwrap()
          : schema,
      ]),
    );
    return derive(this, shape);
  }

  /** An enum of the keys. */
  keyof(): EnumSchema<keyof S & string> {
    return new EnumSchema<keyof S & string>({
      kind: "enum",
      values: Object.keys(this.def.shape),
      checks: [],
    });
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    if (!isObject(input)) {
      return invalidType(path, "object", input, this.def.message);
    }
    const { shape, catchall } = this.def;
    const keys: string[] = [];
    const present: boolean[] = [];
    const results: Result[] = [];
    for (const key of Object.keys(shape)) {
      const here = has(input, key);
      keys.push(key);
      present.push(here);
      results.push(
        shape[key]["~run"](
          here ? input[key] : undefined,
          [...path, key],
          context,
        ),
      );
    }
    const issues: Issue[] = [];
    const unknown: string[] = [];
    for (const key of Object.keys(input)) {
      if (Object.hasOwn(shape, key) || catchall === undefined) continue;
      if (catchall.def.kind === "never") {
        unknown.push(key);
        continue;
      }
      keys.push(key);
      present.push(true);
      results.push(catchall["~run"](input[key], [...path, key], context));
    }
    return then(all(results), (payloads: Payload[]) => {
      const output: Record<string, unknown> = {};
      payloads.forEach((payload, index) => {
        issues.push(
          ...(present[index] ? payload.issues : missingKeyIssues(
            payload.issues,
            [...path, keys[index]],
          )),
        );
        if (payload.value !== undefined || present[index]) {
          setKey(output, keys[index], payload.value);
        }
      });
      if (unknown.length > 0 && this.def.perKey) {
        for (const key of unknown) {
          issues.push(
            makeIssue(
              [...path, key],
              { code: "unrecognized_keys", keys: [key] },
              catchall?.def.message,
            ),
          );
        }
      } else if (unknown.length > 0) {
        issues.push(
          makeIssue(
            path,
            { code: "unrecognized_keys", keys: unknown },
            catchall?.def.message,
          ),
        );
      }
      return { value: output, issues, aborted: false };
    });
  }
}

type Unoptional<T> = T extends OptionalSchema<infer U> ? U : T;
