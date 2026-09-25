// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The core: the {@link Schema} base class, the interpreter that runs a
 * schema's def against a value, and the wrappers every schema can build
 * (`optional`, `nullable`, `default`, `catch`, `pipe`, `transform`,
 * `readonly`).
 *
 * A parse walks the input once and returns a payload: the output value, the
 * issues found, and whether the value was of the wrong type (`aborted`).
 * Built-in checks run whenever the type was right, so a too-short string in
 * a bad object is still reported; refinements run only when there are no
 * issues yet, so they can trust their input, unless their `when` option
 * says otherwise. Nothing is async unless a
 * user function returns a Promise: the sync entry points refuse that, and
 * the async ones follow it.
 *
 * @module
 */

import { type Payload, runBuiltinCheck } from "./checks.ts";
import type {
  CatchContext,
  CatchDef,
  Check,
  CheckContext,
  CustomCheck,
  CustomIssueInput,
  DefaultDef,
  Meta,
  PipeDef,
  RefineCheck,
  RefinementOptions,
  SchemaDef,
  TransformContext,
  TransformDef,
  WrapperDef,
} from "./def.ts";
import {
  type Issue,
  kindOf,
  makeIssue,
  type Path,
  SieveError,
} from "./errors.ts";
import type {
  StandardProps,
  StandardResult,
  StandardSchemaV1,
} from "./standard.ts";

export type { Payload };

/** How a parse runs: whether a Promise from user code may be awaited. */
export interface Context {
  readonly async: boolean;
}

/** A payload, or a Promise of one once something async happened. */
export type Result = Payload | Promise<Payload>;

const SYNC: Context = { async: false };
const ASYNC: Context = { async: true };

const ASYNC_MESSAGE =
  "sieve: a refinement or transform returned a Promise; use parseAsync or safeParseAsync";

/** Refuses a Promise in a sync parse (after silencing its rejection). */
export function settle<T>(value: T, context: Context): T {
  if (value instanceof Promise && !context.async) {
    value.catch(() => {});
    throw new Error(ASYNC_MESSAGE);
  }
  return value;
}

/** Applies `fn` now, or when `value` resolves. */
export function then<A, B>(
  value: A | Promise<A>,
  fn: (value: A) => B | Promise<B>,
): B | Promise<B> {
  return value instanceof Promise ? value.then(fn) : fn(value);
}

/** Every value now, or a Promise of them if any is pending. */
export function all<T>(values: (T | Promise<T>)[]): T[] | Promise<T[]> {
  return values.some((value) => value instanceof Promise)
    ? Promise.all(values)
    : values as T[];
}

/** A passing payload. */
export function ok(value: unknown): Payload {
  return { value, issues: [], aborted: false };
}

/** A payload for a value of the wrong type. */
export function invalidType(
  path: Path,
  expected: string,
  input: unknown,
  message?: string,
): Payload {
  return {
    value: input,
    issues: [
      makeIssue(
        path,
        { code: "invalid_type", expected, received: kindOf(input) },
        message,
      ),
    ],
    aborted: true,
  };
}

/** A `custom` issue from what a refinement, check or transform added. */
export function customIssue(
  path: Path,
  issue: string | CustomIssueInput,
): Issue {
  const spec = typeof issue === "string" ? { message: issue } : issue;
  return makeIssue(
    spec.path === undefined ? path : [...path, ...spec.path],
    {
      code: "custom",
      ...(spec.params === undefined ? {} : { params: spec.params }),
    },
    spec.message,
  );
}

function runRefinement(
  check: RefineCheck | CustomCheck,
  payload: Payload,
  path: Path,
  context: Context,
): void | Promise<void> {
  if (check.check === "refine") {
    const passed = settle(check.fn(payload.value), context);
    return then(passed, (passed) => {
      if (passed) return;
      payload.issues.push(
        customIssue(path, {
          message: check.message ?? "invalid input",
          ...(check.path === undefined ? {} : { path: check.path }),
          ...(check.params === undefined ? {} : { params: check.params }),
        }),
      );
    });
  }
  const done = settle(
    check.fn({
      value: payload.value,
      path,
      addIssue: (issue) => payload.issues.push(customIssue(path, issue)),
    }),
    context,
  );
  return done instanceof Promise ? done.then(() => {}) : undefined;
}

function runChecks(
  payload: Payload,
  checks: readonly Check[],
  start: number,
  path: Path,
  context: Context,
): Result {
  for (let index = start; index < checks.length; index++) {
    const check = checks[index];
    if (check.check === "refine" || check.check === "custom") {
      if (payload.aborted) continue;
      const runs = check.when === undefined
        ? payload.issues.length === 0
        : check.when({ value: payload.value, issues: payload.issues });
      if (!runs) continue;
      const before = payload.issues.length;
      const stop = () => check.abort === true && payload.issues.length > before;
      const pending = runRefinement(check, payload, path, context);
      if (pending instanceof Promise) {
        return pending.then(() =>
          stop()
            ? payload
            : runChecks(payload, checks, index + 1, path, context)
        );
      }
      if (stop()) return payload;
    } else if (!payload.aborted) {
      runBuiltinCheck(check, payload, path);
    }
  }
  return payload;
}

function runSync(schema: AnySchema, input: unknown): Payload {
  const result = schema["~run"](input, [], SYNC);
  if (result instanceof Promise) throw new Error(ASYNC_MESSAGE);
  return result;
}

function toSafe<O>(payload: Payload): SafeParseResult<O> {
  return payload.issues.length === 0
    ? { success: true, data: payload.value as O }
    : { success: false, error: new SieveError(payload.issues) };
}

function toStandard<O>(payload: Payload): StandardResult<O> {
  return payload.issues.length === 0
    ? { value: payload.value as O }
    : { issues: payload.issues };
}

function inheritMeta(meta: Meta | undefined): Meta | undefined {
  if (meta?.id === undefined) return meta;
  const { id: _, ...rest } = meta;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/** Any schema. */
// deno-lint-ignore no-explicit-any
export type AnySchema = Schema<any, any>;

/** What a schema produces. */
export type Output<S> = S extends AnySchema ? S["~types"]["output"] : never;

/** What a schema accepts (before defaults and transforms). */
export type Input<S> = S extends AnySchema ? S["~types"]["input"] : never;

/** What a schema produces; the same as {@link Output}. */
export type Infer<S> = Output<S>;

/** The type-only tag `.brand<B>()` adds to an output type. */
export interface Brand<B extends PropertyKey> {
  readonly "~brand": { readonly [K in B]: true };
}

/** The result of `safeParse`, with zod's field names. */
export type SafeParseResult<T> =
  | { readonly success: true; readonly data: T; readonly error?: undefined }
  | {
    readonly success: false;
    readonly data?: undefined;
    readonly error: SieveError;
  };

/**
 * Options for `.refine`: a message, extra path segments and params, and
 * when it runs (see {@link RefinementOptions}).
 */
export interface RefineOptions extends RefinementOptions {
  readonly message?: string;
  /** Appended to the value's path, e.g. to blame one field of an object. */
  readonly path?: Path;
  readonly params?: Readonly<Record<string, unknown>>;
}

type Defined<T> = T extends undefined ? never : T;

/** A value made shallowly read-only, as `.readonly()` types it. */
export type Frozen<T> = T extends Map<infer K, infer V> ? ReadonlyMap<K, V>
  : T extends Set<infer V> ? ReadonlySet<V>
  // deno-lint-ignore no-explicit-any
  : T extends (...args: any[]) => unknown ? T
  : Readonly<T>;

type OptIn<S> = S extends { readonly "~opt": { readonly in: true } } ? true
  : false;
type OptOut<S> = S extends { readonly "~opt": { readonly out: true } } ? true
  : false;

/**
 * A schema for values of type `O`, accepting `I`. Schemas are immutable:
 * every method returns a new schema, and `def` describes this one
 * completely.
 */
export abstract class Schema<O = unknown, I = O>
  implements StandardSchemaV1<I, O> {
  /** Type-level only; never set. */
  declare readonly "~types": { readonly output: O; readonly input: I };
  /** Type-level only: whether an object key using this schema is optional. */
  declare readonly "~opt"?: { readonly in: boolean; readonly out: boolean };
  /** The definition: what this schema checks, as plain data. */
  readonly def: SchemaDef;

  constructor(def: SchemaDef) {
    this.def = Object.freeze(def);
    Object.freeze(this);
  }

  /** Checks the type and builds the output; checks run afterwards. */
  protected abstract "~parse"(
    input: unknown,
    path: Path,
    context: Context,
  ): Result;

  /** Parses `input` at `path`: the type, then the checks. For schemas. */
  "~run"(input: unknown, path: Path, context: Context): Result {
    const result = this["~parse"](input, path, context);
    const checks = this.def.checks;
    if (checks.length === 0) return result;
    return then(
      result,
      (payload) => runChecks(payload, checks, 0, path, context),
    );
  }

  /** A copy with `patch` merged into the def; a set `meta.id` is dropped. */
  protected with(patch: Readonly<Record<string, unknown>>): this {
    const def: Record<string, unknown> = { ...this.def, ...patch };
    if (!("meta" in patch)) {
      const meta = inheritMeta(this.def.meta);
      if (meta === undefined) delete def.meta;
      else def.meta = meta;
    }
    const next = Object.create(Object.getPrototypeOf(this));
    next.def = Object.freeze(def);
    return Object.freeze(next);
  }

  /** A copy with one more check. */
  protected addCheck(check: Check): this {
    return this.with({ checks: [...this.def.checks, check] });
  }

  // The results are typed from `this["~types"]`, not `O`, so the tags that
  // only reach the output type there (`.brand()`) reach them too.

  /** The output for `input`; throws a {@link SieveError} listing every issue. */
  parse(input: unknown): this["~types"]["output"] {
    const payload = runSync(this, input);
    if (payload.issues.length > 0) throw new SieveError(payload.issues);
    return payload.value as O;
  }

  /** `{ success: true, data }` or `{ success: false, error }`; never throws for bad input. */
  safeParse(input: unknown): SafeParseResult<this["~types"]["output"]> {
    return toSafe<O>(runSync(this, input));
  }

  /** {@link parse}, awaiting async refinements and transforms. */
  async parseAsync(input: unknown): Promise<this["~types"]["output"]> {
    const payload = await this["~run"](input, [], ASYNC);
    if (payload.issues.length > 0) throw new SieveError(payload.issues);
    return payload.value as O;
  }

  /** {@link safeParse}, awaiting async refinements and transforms. */
  async safeParseAsync(
    input: unknown,
  ): Promise<SafeParseResult<this["~types"]["output"]>> {
    return toSafe<O>(await this["~run"](input, [], ASYNC));
  }

  /**
   * Whether `input` parses. The type guard is only sound when the output
   * is the input itself: no transform, default, catch or coercion.
   */
  is(input: unknown): input is this["~types"]["output"] {
    return runSync(this, input).issues.length === 0;
  }

  /** Standard Schema v1; `validate` is async only if the parse is. */
  get "~standard"(): StandardProps<I, O> {
    return {
      version: 1,
      vendor: "sieve",
      validate: (value: unknown) => {
        const result = this["~run"](value, [], ASYNC);
        return result instanceof Promise
          ? result.then(toStandard<O>)
          : toStandard<O>(result);
      },
    };
  }

  /** Also accepts `undefined`; an object key with this schema may be absent. */
  optional(): OptionalSchema<this> {
    return new OptionalSchema<this>({
      kind: "optional",
      inner: this,
      checks: [],
    });
  }

  /** Also accepts `null`. */
  nullable(): NullableSchema<this> {
    return new NullableSchema<this>({
      kind: "nullable",
      inner: this,
      checks: [],
    });
  }

  /** Also accepts `null` and `undefined`. */
  nullish(): OptionalSchema<NullableSchema<this>> {
    return this.nullable().optional();
  }

  /**
   * Uses `value` (or calls it, if it is a function) when the input is
   * `undefined`. Like zod 4, the default is the output as is and is not
   * parsed.
   */
  default(value: Defined<O> | (() => Defined<O>)): DefaultSchema<this> {
    const def: DefaultDef = typeof value === "function"
      ? {
        kind: "default",
        inner: this,
        checks: [],
        factory: value as () => unknown,
      }
      : { kind: "default", inner: this, checks: [], value };
    return new DefaultSchema<this>(def);
  }

  /** Uses `value` (or its result, if a function) whenever parsing fails. */
  catch(value: O | ((context: CatchContext) => O)): CatchSchema<this> {
    const def: CatchDef = typeof value === "function"
      ? {
        kind: "catch",
        inner: this,
        checks: [],
        factory: value as (context: CatchContext) => unknown,
      }
      : { kind: "catch", inner: this, checks: [], value };
    return new CatchSchema<this>(def);
  }

  /**
   * Maps the output through `fn`, which may add issues through its context
   * and may be async (then only the async parses work).
   */
  transform<R>(
    fn: (value: O, context: TransformContext) => R,
  ): PipeSchema<this, TransformSchema<Awaited<R>, O>> {
    const out = new TransformSchema<Awaited<R>, O>({
      kind: "transform",
      fn: fn as TransformDef["fn"],
      checks: [],
    });
    return this.pipe(out);
  }

  /** Parses the output with `next`. */
  pipe<T extends AnySchema>(next: T): PipeSchema<this, T> {
    return new PipeSchema<this, T>({
      kind: "pipe",
      in: this,
      out: next,
      checks: [],
    });
  }

  /**
   * Adds a `custom` issue when `predicate` returns something falsy. It runs
   * only when the value has no issues so far (unless `when` says
   * otherwise), and may be async.
   */
  refine(
    predicate: (value: O) => unknown,
    options?: string | RefineOptions,
  ): this {
    const spec = typeof options === "string" ? { message: options } : options;
    return this.addCheck({
      check: "refine",
      fn: predicate as (value: unknown) => unknown,
      ...spec,
    });
  }

  /**
   * Runs `fn`, which reports any number of issues with `addIssue` (zod's
   * `superRefine`). Like `refine`, it runs only on an issue-free value,
   * unless `options.when` says otherwise: a cross-field check on an object
   * can then run alongside the fields' own issues.
   */
  check(
    fn: (context: CheckContext<O>) => void | Promise<void>,
    options: RefinementOptions = {},
  ): this {
    return this.addCheck({
      check: "custom",
      fn: fn as CustomCheck["fn"],
      ...options,
    });
  }

  /** Tags the output type with `B`; nothing changes at runtime. */
  brand<B extends PropertyKey>(): this & {
    readonly "~types": { readonly output: O & Brand<B>; readonly input: I };
  } {
    return this as this & {
      readonly "~types": { readonly output: O & Brand<B>; readonly input: I };
    };
  }

  /** Freezes the output (shallowly) and types it read-only. */
  readonly(): ReadonlySchema<this> {
    return new ReadonlySchema<this>({
      kind: "readonly",
      inner: this,
      checks: [],
    });
  }

  /** Sets `meta.description`. */
  describe(description: string): this {
    return this.meta({ description });
  }

  /** Merges `meta` into this schema's metadata; `id` names the schema. */
  meta(meta: Meta): this {
    return this.with({ meta: { ...inheritMeta(this.def.meta), ...meta } });
  }

  /** `meta.description`, if set. */
  get description(): string | undefined {
    return this.def.meta?.description;
  }
}

/** `schema.optional()`. */
export class OptionalSchema<T extends AnySchema>
  extends Schema<Output<T> | undefined, Input<T> | undefined> {
  declare readonly def: WrapperDef;
  declare readonly "~opt": { readonly in: true; readonly out: true };

  /** The wrapped schema. */
  unwrap(): T {
    return this.def.inner as T;
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    return input === undefined
      ? ok(undefined)
      : this.def.inner["~run"](input, path, context);
  }
}

/** `schema.nullable()`. */
export class NullableSchema<T extends AnySchema>
  extends Schema<Output<T> | null, Input<T> | null> {
  declare readonly def: WrapperDef;
  declare readonly "~opt": T["~opt"];

  /** The wrapped schema. */
  unwrap(): T {
    return this.def.inner as T;
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    return input === null
      ? ok(null)
      : this.def.inner["~run"](input, path, context);
  }
}

/** `schema.default(value)`. */
export class DefaultSchema<T extends AnySchema>
  extends Schema<Defined<Output<T>>, Input<T> | undefined> {
  declare readonly def: DefaultDef;
  declare readonly "~opt": { readonly in: true; readonly out: false };

  /** The wrapped schema. */
  unwrap(): T {
    return this.def.inner as T;
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    if (input !== undefined) {
      return this.def.inner["~run"](input, path, context);
    }
    return ok(
      this.def.factory === undefined ? this.def.value : this.def.factory(),
    );
  }
}

/** `schema.catch(value)`. */
export class CatchSchema<T extends AnySchema>
  extends Schema<Output<T>, Input<T>> {
  declare readonly def: CatchDef;
  declare readonly "~opt": { readonly in: true; readonly out: OptOut<T> };

  /** The wrapped schema. */
  unwrap(): T {
    return this.def.inner as T;
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    const def = this.def;
    return then(def.inner["~run"](input, path, context), (payload) => {
      if (payload.issues.length === 0) return payload;
      return ok(
        def.factory === undefined
          ? def.value
          : def.factory({ input, issues: payload.issues }),
      );
    });
  }
}

/** `a.pipe(b)`, and `a.transform(fn)`. */
export class PipeSchema<A extends AnySchema, B extends AnySchema>
  extends Schema<Output<B>, Input<A>> {
  declare readonly def: PipeDef;
  declare readonly "~opt": { readonly in: OptIn<A>; readonly out: OptOut<B> };

  /** The first schema. */
  get in(): A {
    return this.def.in as A;
  }

  /** The schema its output goes through. */
  get out(): B {
    return this.def.out as B;
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    const out = this.def.out;
    return then(
      this.def.in["~run"](input, path, context),
      (payload) =>
        payload.issues.length > 0
          ? payload
          : out instanceof TransformSchema
          ? out["~transform"](payload.value, input, path, context)
          : out["~run"](payload.value, path, context),
    );
  }
}

/** A transform function as a schema; `.transform` pipes into one. */
export class TransformSchema<O, I> extends Schema<O, I> {
  declare readonly def: TransformDef;

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    return this.apply(input, input, path, context);
  }

  /** Runs on `value` inside a pipe whose input was `input`; for schemas. */
  "~transform"(
    value: unknown,
    input: unknown,
    path: Path,
    context: Context,
  ): Result {
    const result = this.apply(value, input, path, context);
    const checks = this.def.checks;
    if (checks.length === 0) return result;
    return then(
      result,
      (payload) => runChecks(payload, checks, 0, path, context),
    );
  }

  private apply(
    value: unknown,
    input: unknown,
    path: Path,
    context: Context,
  ): Result {
    const issues: Issue[] = [];
    const out = settle(
      this.def.fn(value, {
        input,
        path,
        addIssue: (issue) => issues.push(customIssue(path, issue)),
      }),
      context,
    );
    return then(
      out,
      (out): Payload => ({ value: out, issues, aborted: false }),
    );
  }
}

/** `schema.readonly()`. */
export class ReadonlySchema<T extends AnySchema>
  extends Schema<Frozen<Output<T>>, Input<T>> {
  declare readonly def: WrapperDef;
  declare readonly "~opt": T["~opt"];

  /** The wrapped schema. */
  unwrap(): T {
    return this.def.inner as T;
  }

  protected "~parse"(input: unknown, path: Path, context: Context): Result {
    return then(this.def.inner["~run"](input, path, context), (payload) => {
      if (
        payload.issues.length === 0 && typeof payload.value === "object" &&
        payload.value !== null
      ) {
        Object.freeze(payload.value);
      }
      return payload;
    });
  }
}
