// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Issues and {@link SieveError}: what a failed parse reports.
 *
 * Every issue has a `code`, the `path` from the root of the input to the
 * value it is about, and a readable `message`; codes add their own fields
 * (`expected`, `minimum`, `keys`, ...). Parsing collects every issue it can
 * find rather than stopping at the first.
 *
 * @module
 */

/** One step into a value: an object key or an array index. */
export type PathSegment = string | number;

/** Where a value sits in the input, from the root. */
export type Path = readonly PathSegment[];

/** A custom message for a check or a type error: a string or `{ message }`. */
export type Message = string | { readonly message?: string };

interface IssueBase {
  readonly path: Path;
  readonly message: string;
}

/**
 * The value had the wrong type, or was missing: a required object key that
 * is absent is `received: "undefined"` with the message
 * {@link MISSING_KEY_MESSAGE}.
 */
export interface InvalidTypeIssue extends IssueBase {
  readonly code: "invalid_type";
  readonly expected: string;
  readonly received: string;
}

/** What a size or bound check measured. */
export type SizeOrigin = "string" | "number" | "bigint" | "array" | "bytes";

/** A length, size or number below its minimum. */
export interface TooSmallIssue extends IssueBase {
  readonly code: "too_small";
  readonly origin: SizeOrigin;
  readonly minimum: number | bigint;
  readonly inclusive: boolean;
  /** Set when the check was an exact length. */
  readonly exact?: true;
}

/** A length, size or number above its maximum. */
export interface TooBigIssue extends IssueBase {
  readonly code: "too_big";
  readonly origin: SizeOrigin;
  readonly maximum: number | bigint;
  readonly inclusive: boolean;
  /** Set when the check was an exact length. */
  readonly exact?: true;
}

/**
 * A string that does not have the required form. `format` is a string
 * format name, `regex`, `starts_with`, `ends_with` or `includes`.
 */
export interface InvalidFormatIssue extends IssueBase {
  readonly code: "invalid_format";
  readonly format: string;
  readonly pattern?: string;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly includes?: string;
}

/** A number that is not a multiple of `divisor`. */
export interface NotMultipleOfIssue extends IssueBase {
  readonly code: "not_multiple_of";
  readonly divisor: number;
}

/**
 * Keys a strict object does not declare: all of them at the object's path,
 * or with `.strict({ perKey: true })` one issue per key at the key's path.
 */
export interface UnrecognizedKeysIssue extends IssueBase {
  readonly code: "unrecognized_keys";
  readonly keys: readonly string[];
}

/**
 * No union option accepted the value. `errors` holds each option's issues;
 * a discriminated union with an unknown tag sets `discriminator` and
 * `options` instead, and its path points at the tag.
 */
export interface InvalidUnionIssue extends IssueBase {
  readonly code: "invalid_union";
  readonly errors: readonly (readonly Issue[])[];
  readonly discriminator?: string;
  readonly options?: readonly unknown[];
}

/** The value is not one of the allowed literal values. */
export interface InvalidValueIssue extends IssueBase {
  readonly code: "invalid_value";
  readonly values: readonly unknown[];
}

/** A record or map key failed its key schema; `issues` says why. */
export interface InvalidKeyIssue extends IssueBase {
  readonly code: "invalid_key";
  readonly origin: "record" | "map";
  readonly issues: readonly Issue[];
}

/** Both sides of an intersection passed but their results conflict. */
export interface InvalidIntersectionIssue extends IssueBase {
  readonly code: "invalid_intersection";
}

/** An issue raised by `.refine`, `.check` or a transform. */
export interface CustomIssue extends IssueBase {
  readonly code: "custom";
  readonly params?: Readonly<Record<string, unknown>>;
}

/** Everything a parse can report. */
export type Issue =
  | InvalidTypeIssue
  | TooSmallIssue
  | TooBigIssue
  | InvalidFormatIssue
  | NotMultipleOfIssue
  | UnrecognizedKeysIssue
  | InvalidUnionIssue
  | InvalidValueIssue
  | InvalidKeyIssue
  | InvalidIntersectionIssue
  | CustomIssue;

/** Every issue code. */
export type IssueCode = Issue["code"];

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An issue before it has a path and a message. */
export type IssueFields = Without<Issue, "path" | "message">;

/** The custom message in a {@link Message}, if there is one. */
export function messageOf(message: Message | undefined): string | undefined {
  return typeof message === "string" ? message : message?.message;
}

/** `{ message }` when there is a custom message, else `{}`, for spreading. */
export function messageField(
  message: Message | undefined,
): { readonly message?: string } {
  const text = messageOf(message);
  return text === undefined ? {} : { message: text };
}

/** Builds an issue, with the default message unless `message` is given. */
export function makeIssue(
  path: Path,
  fields: IssueFields,
  message?: string,
): Issue {
  return {
    ...fields,
    path,
    message: message ?? defaultMessage(fields),
  } as Issue;
}

/**
 * A short name for what a value is, used as `received`: `null`, `array`,
 * `NaN`, `Infinity`, a class name such as `Date`, or its `typeof`.
 */
export function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return "Infinity";
    return "number";
  }
  if (typeof value !== "object") return typeof value;
  if (value instanceof Date && Number.isNaN(value.getTime())) {
    return "Invalid Date";
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return "object";
  const name = (proto.constructor as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name !== "" ? name : "object";
}

/** Renders a value for a message: strings quoted, bigints with `n`. */
export function showValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  return String(value);
}

function unit(origin: SizeOrigin, n: number | bigint): string {
  const plural = n === 1 || n === 1n ? "" : "s";
  switch (origin) {
    case "string":
      return ` character${plural}`;
    case "array":
      return ` item${plural}`;
    case "bytes":
      return ` byte${plural}`;
    default:
      return "";
  }
}

const FORMAT_NAMES: Readonly<Record<string, string>> = {
  email: "email address",
  url: "URL",
  uuid: "UUID",
  datetime: "ISO 8601 datetime",
  date: "ISO 8601 date",
  base64: "base64 string",
  base64url: "base64url string",
  hex: "hex string",
  ipv4: "IPv4 address",
  ipv6: "IPv6 address",
  cidrv4: "IPv4 CIDR block",
  cidrv6: "IPv6 CIDR block",
  ulid: "ULID",
  jwt: "JWT",
  time: "ISO 8601 time",
  duration: "ISO 8601 duration",
};

/** The message of an issue about an object key that is absent. */
export const MISSING_KEY_MESSAGE = "missing required key";

/**
 * The issues of an absent key's schema, with {@link MISSING_KEY_MESSAGE}
 * for those that are about the key itself (at `at`) and say only that
 * `undefined` was the wrong value: a type, literal or union mismatch with
 * its default message. Custom messages and issues further in are kept.
 */
export function missingKeyIssues(issues: readonly Issue[], at: Path): Issue[] {
  return issues.map((issue) => {
    const about = issue.path.length === at.length &&
      issue.path.every((segment, index) => segment === at[index]);
    const mismatch = issue.code === "invalid_type"
      ? issue.received === "undefined"
      : issue.code === "invalid_value" || issue.code === "invalid_union";
    return about && mismatch && issue.message === defaultMessage(issue)
      ? { ...issue, message: MISSING_KEY_MESSAGE }
      : issue;
  });
}

function defaultMessage(fields: IssueFields): string {
  switch (fields.code) {
    case "invalid_type":
      return `expected ${fields.expected}, received ${fields.received}`;
    case "too_small": {
      const n = fields.minimum;
      if (fields.exact) {
        return `must have exactly ${n}${unit(fields.origin, n)}`;
      }
      if (fields.origin === "number" || fields.origin === "bigint") {
        return fields.inclusive
          ? `must be at least ${n}`
          : `must be greater than ${n}`;
      }
      return `must have at least ${n}${unit(fields.origin, n)}`;
    }
    case "too_big": {
      const n = fields.maximum;
      if (fields.exact) {
        return `must have exactly ${n}${unit(fields.origin, n)}`;
      }
      if (fields.origin === "number" || fields.origin === "bigint") {
        return fields.inclusive
          ? `must be at most ${n}`
          : `must be less than ${n}`;
      }
      return `must have at most ${n}${unit(fields.origin, n)}`;
    }
    case "invalid_format":
      switch (fields.format) {
        case "regex":
          return `must match ${fields.pattern}`;
        case "starts_with":
          return `must start with ${showValue(fields.prefix)}`;
        case "ends_with":
          return `must end with ${showValue(fields.suffix)}`;
        case "includes":
          return `must include ${showValue(fields.includes)}`;
        default:
          return `invalid ${FORMAT_NAMES[fields.format] ?? fields.format}`;
      }
    case "not_multiple_of":
      return `must be a multiple of ${fields.divisor}`;
    case "unrecognized_keys":
      return `unrecognized key${fields.keys.length === 1 ? "" : "s"}: ${
        fields.keys.map((key) => JSON.stringify(key)).join(", ")
      }`;
    case "invalid_union":
      return fields.discriminator === undefined
        ? "no union option matched"
        : `unknown ${fields.discriminator}; expected ${
          (fields.options ?? []).map(showValue).join(" | ")
        }`;
    case "invalid_value":
      return fields.values.length === 1
        ? `expected ${showValue(fields.values[0])}`
        : `expected one of ${fields.values.map(showValue).join(" | ")}`;
    case "invalid_key":
      return fields.issues.length === 0
        ? "invalid key"
        : `invalid key: ${fields.issues[0].message}`;
    case "invalid_intersection":
      return "intersection results could not be merged";
    case "custom":
      return "invalid input";
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Renders a path as `a.b[0]["odd key"]`; the root is the empty string. */
export function formatPath(path: Path): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (IDENTIFIER.test(segment)) {
      out += out === "" ? segment : `.${segment}`;
    } else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

/** One line per issue: `path: message`, or just the message at the root. */
export function prettifyIssues(issues: readonly Issue[]): string {
  return issues.map((issue) => {
    const where = formatPath(issue.path);
    return where === "" ? issue.message : `${where}: ${issue.message}`;
  }).join("\n");
}

/** Issues grouped for forms: root messages, and messages by top-level key. */
export interface FlattenedError {
  readonly formErrors: string[];
  readonly fieldErrors: Record<string, string[]>;
}

/** The error `parse` throws; `issues` has everything that went wrong. */
export class SieveError extends Error {
  override readonly name = "SieveError";
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(prettifyIssues(issues));
    this.issues = issues;
  }

  /**
   * Root issues as `formErrors`, the rest as `fieldErrors` keyed by the
   * first path segment (so `items[3].name` lands under `items`).
   */
  flatten(): FlattenedError {
    const formErrors: string[] = [];
    const fieldErrors: Record<string, string[]> = Object.create(null);
    for (const issue of this.issues) {
      if (issue.path.length === 0) {
        formErrors.push(issue.message);
      } else {
        const key = String(issue.path[0]);
        (fieldErrors[key] ??= []).push(issue.message);
      }
    }
    return { formErrors, fieldErrors };
  }

  /** The issues as readable lines, the same text as `message`. */
  format(): string {
    return prettifyIssues(this.issues);
  }
}

/** The issues of an error as readable `path: message` lines. */
export function prettifyError(error: SieveError): string {
  return error.format();
}
