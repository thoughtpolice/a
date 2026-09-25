// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Schemas for single values: numbers, bigints, booleans, `null`,
 * `undefined`, `unknown`, `never`, literals, enums, dates, class instances
 * and byte arrays.
 *
 * @module
 */

import type {
  AtomDef,
  BigIntDef,
  BooleanDef,
  DateDef,
  EnumDef,
  InstanceOfDef,
  LiteralDef,
  NumberDef,
  Primitive,
} from "./def.ts";
import { makeIssue, type Message, messageField, type Path } from "./errors.ts";
import {
  type Context,
  invalidType,
  ok,
  type Result,
  Schema,
} from "./schema.ts";

/** A finite number; `v.coerce.number()` applies `Number` first. */
export class NumberSchema<I = number> extends Schema<number, I> {
  declare readonly def: NumberDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    let value = input;
    if (this.def.coerce) {
      try {
        value = Number(input);
      } catch {
        value = NaN;
      }
    }
    return typeof value === "number" && Number.isFinite(value)
      ? ok(value)
      : invalidType(path, "number", value, this.def.message);
  }

  /** At least `value`. */
  min(value: number, message?: Message): this {
    return this.addCheck({
      check: "min",
      value,
      inclusive: true,
      ...messageField(message),
    });
  }

  /** At least `value`; the same as `min`. */
  gte(value: number, message?: Message): this {
    return this.min(value, message);
  }

  /** Greater than `value`. */
  gt(value: number, message?: Message): this {
    return this.addCheck({
      check: "min",
      value,
      inclusive: false,
      ...messageField(message),
    });
  }

  /** At most `value`. */
  max(value: number, message?: Message): this {
    return this.addCheck({
      check: "max",
      value,
      inclusive: true,
      ...messageField(message),
    });
  }

  /** At most `value`; the same as `max`. */
  lte(value: number, message?: Message): this {
    return this.max(value, message);
  }

  /** Less than `value`. */
  lt(value: number, message?: Message): this {
    return this.addCheck({
      check: "max",
      value,
      inclusive: false,
      ...messageField(message),
    });
  }

  /** Greater than 0. */
  positive(message?: Message): this {
    return this.gt(0, message);
  }

  /** At least 0. */
  nonnegative(message?: Message): this {
    return this.min(0, message);
  }

  /** Less than 0. */
  negative(message?: Message): this {
    return this.lt(0, message);
  }

  /** At most 0. */
  nonpositive(message?: Message): this {
    return this.max(0, message);
  }

  /** A multiple of `step`, exact for decimal steps such as `0.01`. */
  multipleOf(step: number, message?: Message): this {
    return this.addCheck({
      check: "multiple_of",
      value: step,
      ...messageField(message),
    });
  }

  /** A safe integer; failures are `invalid_type` with `expected: "int"`. */
  int(message?: Message): this {
    return this.addCheck({ check: "int", ...messageField(message) });
  }
}

/** A bigint; `v.coerce.bigint()` applies `BigInt` first. */
export class BigIntSchema<I = bigint> extends Schema<bigint, I> {
  declare readonly def: BigIntDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    let value = input;
    if (this.def.coerce) {
      try {
        value = BigInt(input as string);
      } catch {
        return invalidType(path, "bigint", input, this.def.message);
      }
    }
    return typeof value === "bigint"
      ? ok(value)
      : invalidType(path, "bigint", input, this.def.message);
  }

  /** At least `value`. */
  min(value: bigint, message?: Message): this {
    return this.addCheck({
      check: "min",
      value,
      inclusive: true,
      ...messageField(message),
    });
  }

  /** At least `value`; the same as `min`. */
  gte(value: bigint, message?: Message): this {
    return this.min(value, message);
  }

  /** Greater than `value`. */
  gt(value: bigint, message?: Message): this {
    return this.addCheck({
      check: "min",
      value,
      inclusive: false,
      ...messageField(message),
    });
  }

  /** At most `value`. */
  max(value: bigint, message?: Message): this {
    return this.addCheck({
      check: "max",
      value,
      inclusive: true,
      ...messageField(message),
    });
  }

  /** At most `value`; the same as `max`. */
  lte(value: bigint, message?: Message): this {
    return this.max(value, message);
  }

  /** Less than `value`. */
  lt(value: bigint, message?: Message): this {
    return this.addCheck({
      check: "max",
      value,
      inclusive: false,
      ...messageField(message),
    });
  }

  /** Greater than 0. */
  positive(message?: Message): this {
    return this.gt(0n, message);
  }

  /** At least 0. */
  nonnegative(message?: Message): this {
    return this.min(0n, message);
  }

  /** Less than 0. */
  negative(message?: Message): this {
    return this.lt(0n, message);
  }
}

/** A boolean; `v.coerce.boolean()` applies `Boolean` (so `"false"` is `true`). */
export class BooleanSchema<I = boolean> extends Schema<boolean, I> {
  declare readonly def: BooleanDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    const value = this.def.coerce ? Boolean(input) : input;
    return typeof value === "boolean"
      ? ok(value)
      : invalidType(path, "boolean", input, this.def.message);
  }
}

/** Exactly `null`. */
export class NullSchema extends Schema<null> {
  declare readonly def: AtomDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    return input === null
      ? ok(null)
      : invalidType(path, "null", input, this.def.message);
  }
}

/** Exactly `undefined`. */
export class UndefinedSchema extends Schema<undefined> {
  declare readonly def: AtomDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    return input === undefined
      ? ok(undefined)
      : invalidType(path, "undefined", input, this.def.message);
  }
}

/** Anything. */
export class UnknownSchema extends Schema<unknown> {
  declare readonly def: AtomDef;

  protected "~parse"(input: unknown, _path: Path, _context: Context): Result {
    return ok(input);
  }
}

/** Nothing. */
export class NeverSchema extends Schema<never> {
  declare readonly def: AtomDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    return invalidType(path, "never", input, this.def.message);
  }
}

/** One of a fixed set of primitive values. */
export class LiteralSchema<T extends Primitive> extends Schema<T> {
  declare readonly def: LiteralDef;

  /** The allowed values. */
  get values(): readonly T[] {
    return this.def.values as readonly T[];
  }

  /** The allowed value; throws when there are several. */
  get value(): T {
    if (this.def.values.length !== 1) {
      throw new Error("sieve: this literal has several values; use .values");
    }
    return this.def.values[0] as T;
  }

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    if (this.def.values.includes(input as Primitive)) return ok(input);
    return {
      value: input,
      issues: [
        makeIssue(
          path,
          { code: "invalid_value", values: this.def.values },
          this.def.message,
        ),
      ],
      aborted: true,
    };
  }
}

/** One of a fixed set of strings. */
export class EnumSchema<T extends string> extends Schema<T> {
  declare readonly def: EnumDef;

  /** The allowed strings, in order. */
  get options(): readonly T[] {
    return this.def.values as readonly T[];
  }

  /** Each allowed string, keyed by itself: `Color.enum.red === "red"`. */
  get enum(): { readonly [K in T]: K } {
    return Object.fromEntries(
      this.def.values.map((value) => [value, value]),
    ) as {
      readonly [K in T]: K;
    };
  }

  /** The enum without `values`. */
  exclude<const K extends readonly T[]>(
    values: K,
    message?: Message,
  ): EnumSchema<Exclude<T, K[number]>> {
    return new EnumSchema<Exclude<T, K[number]>>({
      kind: "enum",
      values: this.def.values.filter((value) => !values.includes(value as T)),
      checks: [],
      ...messageField(message),
    });
  }

  /** The enum of only `values`. */
  extract<const K extends readonly T[]>(
    values: K,
    message?: Message,
  ): EnumSchema<K[number]> {
    return new EnumSchema<K[number]>({
      kind: "enum",
      values: this.def.values.filter((value) => values.includes(value as T)),
      checks: [],
      ...messageField(message),
    });
  }

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    if (this.def.values.includes(input as string)) return ok(input);
    return {
      value: input,
      issues: [
        makeIssue(
          path,
          { code: "invalid_value", values: this.def.values },
          this.def.message,
        ),
      ],
      aborted: true,
    };
  }
}

/** A valid `Date`; `v.coerce.date()` applies `new Date` first. */
export class DateSchema<I = Date> extends Schema<Date, I> {
  declare readonly def: DateDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    let value = input;
    if (this.def.coerce) {
      try {
        value = new Date(input as string);
      } catch {
        return invalidType(path, "date", input, this.def.message);
      }
    }
    return value instanceof Date && !Number.isNaN(value.getTime())
      ? ok(value)
      : invalidType(path, "date", value, this.def.message);
  }
}

/** An instance of a class. */
export class InstanceOfSchema<T> extends Schema<T> {
  declare readonly def: InstanceOfDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    return input instanceof this.def.class
      ? ok(input)
      : invalidType(path, this.def.class.name, input, this.def.message);
  }
}

/** A `Uint8Array` (subclasses included), with length checks in bytes. */
export class BytesSchema extends Schema<Uint8Array> {
  declare readonly def: AtomDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    return input instanceof Uint8Array
      ? ok(input)
      : invalidType(path, "Uint8Array", input, this.def.message);
  }

  /** At least `length` bytes. */
  min(length: number, message?: Message): this {
    return this.addCheck({
      check: "min_length",
      value: length,
      ...messageField(message),
    });
  }

  /** At most `length` bytes. */
  max(length: number, message?: Message): this {
    return this.addCheck({
      check: "max_length",
      value: length,
      ...messageField(message),
    });
  }

  /** Exactly `length` bytes. */
  length(length: number, message?: Message): this {
    return this.addCheck({
      check: "length",
      value: length,
      ...messageField(message),
    });
  }
}
