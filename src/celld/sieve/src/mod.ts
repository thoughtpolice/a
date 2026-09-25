// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed schemas and validation for celld, imported as "@celld/sieve".
 *
 * ```ts
 * import { type Infer, v } from "@celld/sieve";
 *
 * const Finding = v.object({
 *   title: v.string().min(3),
 *   severity: v.enum(["low", "medium", "high"]),
 *   line: v.int().positive().optional(),
 * });
 * type Finding = Infer<typeof Finding>;
 * // { title: string; severity: "low" | "medium" | "high"; line?: number }
 *
 * const result = Finding.safeParse(JSON.parse(text));
 * if (!result.success) console.log(result.error.format());
 * ```
 *
 * The API follows zod 4, but the implementation is an interpreter over
 * plain definitions: no `eval` or `new Function`, which Workers isolates do
 * not allow, and no dependencies. Every schema is also a Standard Schema.
 * JSON Schema export lives in "@celld/sieve/json-schema" and definition
 * walking in "@celld/sieve/introspect", so neither is in a bundle that does
 * not import it.
 *
 * @module
 */

export * as v from "./v.ts";

export {
  type AnySchema,
  type Brand,
  CatchSchema,
  DefaultSchema,
  type Frozen,
  type Infer,
  type Input,
  NullableSchema,
  OptionalSchema,
  type Output,
  PipeSchema,
  ReadonlySchema,
  type RefineOptions,
  type SafeParseResult,
  Schema,
  TransformSchema,
} from "./schema.ts";
export {
  type CustomIssue,
  type FlattenedError,
  formatPath,
  type InvalidFormatIssue,
  type InvalidIntersectionIssue,
  type InvalidKeyIssue,
  type InvalidTypeIssue,
  type InvalidUnionIssue,
  type InvalidValueIssue,
  type Issue,
  type IssueCode,
  type Message,
  MISSING_KEY_MESSAGE,
  type NotMultipleOfIssue,
  type Path,
  type PathSegment,
  prettifyError,
  SieveError,
  type SizeOrigin,
  type TooBigIssue,
  type TooSmallIssue,
  type UnrecognizedKeysIssue,
} from "./errors.ts";
export type {
  CatchContext,
  CheckContext,
  CustomIssueInput,
  Meta,
  Primitive,
  RefinementOptions,
  RefinementState,
  TemporalType,
  TransformContext,
} from "./def.ts";
export {
  type DatetimeOptions,
  type JwtOptions,
  StringSchema,
  type TimeOptions,
} from "./string.ts";
export { TemporalSchema } from "./temporal.ts";
export {
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  JsonValueSchema,
} from "./json_value.ts";
export {
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
export {
  type Flatten,
  type Mask,
  type Merge,
  type ObjectInput,
  type ObjectOutput,
  ObjectSchema,
  type Shape,
  type StrictOptions,
} from "./object.ts";
export {
  ArraySchema,
  DiscriminatedUnionSchema,
  IntersectionSchema,
  LazySchema,
  MapSchema,
  RecordSchema,
  SetSchema,
  type TupleInput,
  type TupleOutput,
  TupleSchema,
  UnionSchema,
} from "./compose.ts";
export type {
  StandardIssue,
  StandardProps,
  StandardResult,
  StandardSchemaV1,
} from "./standard.ts";
