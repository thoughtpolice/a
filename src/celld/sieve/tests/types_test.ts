// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Compile-time checks: `deno check` fails if inference regresses. Each
// `const _name: true = ...` only compiles when the two types are identical.

import { assert } from "@celld/assert";
import {
  type Brand,
  type Flatten,
  type Infer,
  type Input,
  type JsonObject,
  type JsonValue,
  JsonValueSchema,
  type SafeParseResult,
  type StandardSchemaV1,
  StringSchema,
  TemporalSchema,
  v,
} from "@celld/sieve";
import type { Equal } from "./fixture.ts";

const User = v.object({
  name: v.string(),
  age: v.number().optional(),
  tags: v.array(v.string()).default([]),
  role: v.enum(["admin", "user"]),
  nick: v.string().nullish(),
  note: v.string().nullable(),
});

const _output: Equal<Infer<typeof User>, {
  name: string;
  age?: number | undefined;
  tags: string[];
  role: "admin" | "user";
  nick?: string | null | undefined;
  note: string | null;
}> = true;

const _input: Equal<Input<typeof User>, {
  name: string;
  age?: number | undefined;
  tags?: string[] | undefined;
  role: "admin" | "user";
  nick?: string | null | undefined;
  note: string | null;
}> = true;

const _namespace: Equal<v.Infer<typeof User>, Infer<typeof User>> = true;

const Loose = v.looseObject({ a: v.string() });
const _loose: Equal<
  Infer<typeof Loose>,
  { [key: string]: unknown; a: string }
> = true;

const Catchall = v.object({ a: v.string() }).catchall(v.number());
const catchall: Infer<typeof Catchall> = { a: "x", other: 1 };
const _catchallKnown: Equal<typeof catchall.a, string> = true;
const _catchallExtra: Equal<typeof catchall.other, string | number> = true;

const Strict = v.strictObject({ a: v.string() });
const _strict: Equal<Infer<typeof Strict>, { a: string }> = true;

const Base = v.object({ a: v.string(), b: v.number(), c: v.boolean() });
const _pick: Equal<Infer<ReturnType<typeof Base.pick<{ a: true }>>>, {
  a: string;
}> = true;
const Omitted = Base.omit({ a: true });
const _omit: Equal<Infer<typeof Omitted>, { b: number; c: boolean }> = true;
const Partial = Base.partial();
const _partial: Equal<Infer<typeof Partial>, {
  a?: string | undefined;
  b?: number | undefined;
  c?: boolean | undefined;
}> = true;
const SomePartial = Base.partial({ b: true });
const _somePartial: Equal<Infer<typeof SomePartial>, {
  a: string;
  b?: number | undefined;
  c: boolean;
}> = true;
const Required = Partial.required();
const _required: Equal<Infer<typeof Required>, {
  a: string;
  b: number;
  c: boolean;
}> = true;
const Extended = Base.extend({ a: v.number(), d: v.null() });
const _extend: Equal<Infer<typeof Extended>, {
  a: number;
  b: number;
  c: boolean;
  d: null;
}> = true;
const Merged = v.object({ x: v.string() }).merge(v.object({ y: v.int() }));
const _merge: Equal<Infer<typeof Merged>, { x: string; y: number }> = true;
const Keys = Base.keyof();
const _keyof: Equal<Infer<typeof Keys>, "a" | "b" | "c"> = true;

const Transformed = v.string().transform((text) => text.length);
const _transform: Equal<Infer<typeof Transformed>, number> = true;
const _transformIn: Equal<Input<typeof Transformed>, string> = true;
const AsyncTransformed = v.string().transform((text) =>
  Promise.resolve(text.length > 1)
);
const _asyncTransform: Equal<Infer<typeof AsyncTransformed>, boolean> = true;
const Piped = v.string().pipe(v.coerce.number());
const _pipe: Equal<Infer<typeof Piped>, number> = true;
const _pipeIn: Equal<Input<typeof Piped>, string> = true;
const Pre = v.preprocess((x) => x, v.int());
const _preprocess: Equal<Infer<typeof Pre>, number> = true;
const _preprocessIn: Equal<Input<typeof Pre>, unknown> = true;

const Id = v.string().uuid().brand<"UserId">();
const _brand: Equal<Infer<typeof Id>, string & Brand<"UserId">> = true;
const BrandedMin = Id.min(3);
const _brandKept: Equal<Infer<typeof BrandedMin>, string & Brand<"UserId">> =
  true;
// The brand reaches what parsing returns, not only `Infer`.
const _brandParse: Equal<
  ReturnType<typeof Id.parse>,
  string & Brand<"UserId">
> = true;
const _brandSafeParse: Equal<
  ReturnType<typeof Id.safeParse>,
  SafeParseResult<string & Brand<"UserId">>
> = true;
const unchecked: unknown = crypto.randomUUID();
if (Id.is(unchecked)) {
  const _brandGuard: string & Brand<"UserId"> = unchecked;
}
const _brandParseAsync: Equal<
  Awaited<ReturnType<typeof Id.parseAsync>>,
  string & Brand<"UserId">
> = true;
const _brandSafeParseAsync: Equal<
  Awaited<ReturnType<typeof Id.safeParseAsync>>,
  SafeParseResult<string & Brand<"UserId">>
> = true;

const Frozen = v.object({ a: v.array(v.string()) }).readonly();
const _readonly: Equal<Infer<typeof Frozen>, { readonly a: string[] }> = true;
const FrozenList = v.array(v.int()).readonly();
const _readonlyArray: Equal<Infer<typeof FrozenList>, readonly number[]> = true;

const Tuple = v.tuple([v.string(), v.int()]);
const _tuple: Equal<Infer<typeof Tuple>, [string, number]> = true;
const Rest = v.tuple([v.string()], v.boolean());
const _rest: Equal<Infer<typeof Rest>, [string, ...boolean[]]> = true;

const Dict = v.record(v.string(), v.int());
const _record: Equal<Infer<typeof Dict>, Record<string, number>> = true;
const Exhaustive = v.record(v.enum(["a", "b"]), v.boolean());
const _enumRecord: Equal<Infer<typeof Exhaustive>, Record<"a" | "b", boolean>> =
  true;
const Mapped = v.map(v.string(), v.date());
const _map: Equal<Infer<typeof Mapped>, Map<string, Date>> = true;
const Setted = v.set(v.bigint());
const _set: Equal<Infer<typeof Setted>, Set<bigint>> = true;

const Union = v.union([v.string(), v.int(), v.literal(null)]);
const _union: Equal<Infer<typeof Union>, string | number | null> = true;
const Shape = v.discriminatedUnion("kind", [
  v.object({ kind: v.literal("circle"), radius: v.number() }),
  v.object({ kind: v.literal("square"), side: v.number() }),
]);
const _discriminated: Equal<
  Infer<typeof Shape>,
  { kind: "circle"; radius: number } | { kind: "square"; side: number }
> = true;
const Both = v.intersection(
  v.object({ a: v.string() }),
  v.object({ b: v.int() }),
);
const _intersection: Equal<
  Flatten<Infer<typeof Both>>,
  { a: string; b: number }
> = true;

type Tree = { value: number; children: Tree[] };
const Tree: v.Schema<Tree> = v.object({
  value: v.number(),
  children: v.array(v.lazy(() => Tree)),
});
const _lazy: Equal<Infer<typeof Tree>, Tree> = true;

const Literals = v.literal(["a", 1, true]);
const _literals: Equal<Infer<typeof Literals>, "a" | 1 | true> = true;
const Colors = v.enum(["red", "green", "blue"]);
const _exclude: Equal<
  Infer<ReturnType<typeof Colors.exclude<["red"]>>>,
  "green" | "blue"
> = true;
const Warm = Colors.extract(["red"]);
const _extract: Equal<Infer<typeof Warm>, "red"> = true;
const _enumMap: Equal<typeof Colors.enum, {
  readonly red: "red";
  readonly green: "green";
  readonly blue: "blue";
}> = true;

const _coerceIn: Equal<Input<ReturnType<typeof v.coerce.number>>, unknown> =
  true;
const _coerceOut: Equal<Infer<ReturnType<typeof v.coerce.date>>, Date> = true;
const _bytes: Equal<Infer<ReturnType<typeof v.bytes>>, Uint8Array> = true;
class Thing {
  x = 1;
}
const _instance: Equal<
  Infer<ReturnType<typeof v.instanceof<typeof Thing>>>,
  Thing
> = true;
const Caught = v.int().catch(0);
const _catch: Equal<Infer<typeof Caught>, number> = true;
const Defaulted = v.string().optional().default("x");
const _default: Equal<Infer<typeof Defaulted>, string> = true;
const _defaultIn: Equal<Input<typeof Defaulted>, string | undefined> = true;

function standardOutput<S extends StandardSchemaV1>(
  _schema: S,
): NonNullable<S["~standard"]["types"]>["output"] {
  return undefined as never;
}
const _standard: Equal<
  ReturnType<typeof standardOutput<typeof User>>,
  Infer<typeof User>
> = true;

const Formats = v.object({
  block: v.cidrv4(),
  block6: v.cidrv6(),
  id: v.ulid(),
  token: v.jwt({ alg: "RS256" }),
  at: v.iso.time({ precision: 0 }),
  every: v.iso.duration().optional(),
  on: v.iso.date(),
  when: v.iso.datetime({ offset: true }),
});
const _formats: Equal<Infer<typeof Formats>, {
  block: string;
  block6: string;
  id: string;
  token: string;
  at: string;
  every?: string | undefined;
  on: string;
  when: string;
}> = true;
const _isoTime: Equal<ReturnType<typeof v.iso.time>, StringSchema> = true;
const _jwt: Equal<ReturnType<typeof v.jwt>, StringSchema> = true;
const _chain: Equal<
  ReturnType<StringSchema["ulid"]>,
  StringSchema
> = true;

const When = v.iso.datetime({ offset: true }).toInstant();
const _toInstant: Equal<Infer<typeof When>, Temporal.Instant> = true;
const _toInstantIn: Equal<Input<typeof When>, string> = true;
const Times = v.object({
  on: v.iso.date().toPlainDate(),
  at: v.iso.time().toPlainTime(),
  local: v.iso.datetime({ local: true }).toPlainDateTime(),
  every: v.iso.duration().toDuration().optional(),
});
const _temporalOut: Equal<Infer<typeof Times>, {
  on: Temporal.PlainDate;
  at: Temporal.PlainTime;
  local: Temporal.PlainDateTime;
  every?: Temporal.Duration | undefined;
}> = true;
const _temporalIn: Equal<Input<typeof Times>, {
  on: string;
  at: string;
  local: string;
  every?: string | undefined;
}> = true;
const Coerced = v.coerce.string().toDuration();
const _coercedIn: Equal<Input<typeof Coerced>, unknown> = true;
const Instances = v.object({
  instant: v.instant(),
  zoned: v.zonedDateTime(),
  date: v.plainDate(),
  time: v.plainTime(),
  local: v.plainDateTime(),
  duration: v.duration(),
});
const _instances: Equal<Infer<typeof Instances>, {
  instant: Temporal.Instant;
  zoned: Temporal.ZonedDateTime;
  date: Temporal.PlainDate;
  time: Temporal.PlainTime;
  local: Temporal.PlainDateTime;
  duration: Temporal.Duration;
}> = true;
const _instancesIn: Equal<Input<typeof Instances>, Infer<typeof Instances>> =
  true;
const _temporalSchema: Equal<
  ReturnType<typeof v.duration>,
  TemporalSchema<Temporal.Duration>
> = true;

const Payload = v.object({ data: v.json(), extra: v.json().optional() });
const _json: Equal<Infer<ReturnType<typeof v.json>>, JsonValue> = true;
const _jsonIn: Equal<Input<ReturnType<typeof v.json>>, JsonValue> = true;
const _jsonSchema: Equal<ReturnType<typeof v.json>, JsonValueSchema> = true;
const _jsonV: Equal<v.JsonValue, JsonValue> = true;
const _jsonValue: Equal<
  JsonValue,
  string | number | boolean | null | JsonValue[] | JsonObject
> = true;
const _payload: Equal<Infer<typeof Payload>, {
  data: JsonValue;
  extra?: JsonValue | undefined;
}> = true;

Deno.test("type-level assertions compile", () => {
  const value: unknown = { name: "x", role: "user", note: null };
  if (User.is(value)) {
    const name: string = value.name;
    assert(name === "x", "narrowed");
  }
});
