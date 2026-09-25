// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The Standard Schema v1 interface (https://standardschema.dev), declared
 * here so nothing has to be fetched. Every sieve schema implements it, so a
 * library that accepts any Standard Schema accepts sieve schemas.
 *
 * @module
 */

/** A path segment in the object form the spec allows. */
export interface StandardPathSegment {
  readonly key: PropertyKey;
}

/** One problem with a value. */
export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | StandardPathSegment> | undefined;
}

/** The value on success, or the issues on failure. */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

/** Type-level input and output; never set at runtime. */
export interface StandardTypes<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

/** The `~standard` property. */
export interface StandardProps<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
  ) => StandardResult<Output> | Promise<StandardResult<Output>>;
  readonly types?: StandardTypes<Input, Output> | undefined;
}

/** Anything implementing Standard Schema v1. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardProps<Input, Output>;
}

/** The input type of a Standard Schema. */
export type StandardInput<S extends StandardSchemaV1> = NonNullable<
  S["~standard"]["types"]
>["input"];

/** The output type of a Standard Schema. */
export type StandardOutput<S extends StandardSchemaV1> = NonNullable<
  S["~standard"]["types"]
>["output"];
