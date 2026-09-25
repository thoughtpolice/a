// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `v.json()`: any plain JSON value, typed {@link JsonValue}.
 *
 * `JSON.stringify` quietly drops `undefined` and functions, turns `NaN`,
 * `Infinity` and array holes into `null`, calls `toJSON` on dates and
 * throws on bigints and cycles. This schema reports each of these, with
 * the path to it, before anything is sent: after a successful parse the
 * value serializes to what it is.
 *
 * @module
 */

import type { AtomDef } from "./def.ts";
import { type Issue, kindOf, makeIssue, type Path } from "./errors.ts";
import { type Context, ok, type Result, Schema } from "./schema.ts";

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** Any JSON value. */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function jsonIssues(
  value: unknown,
  path: Path,
  issues: Issue[],
  ancestors: Set<object>,
  message: string | undefined,
): void {
  const push = (received: string, text: string, at: Path = path) =>
    issues.push(
      makeIssue(
        at,
        { code: "invalid_type", expected: "JSON", received },
        message ?? text,
      ),
    );
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        push(kindOf(value), `${value} is not a JSON number`);
      }
      return;
    case "undefined":
      push("undefined", "undefined is not JSON; omit the key or use null");
      return;
    case "function":
    case "symbol":
    case "bigint":
      push(typeof value, `a ${typeof value} is not JSON`);
      return;
  }
  if (value === null) return;
  const object = value as object;
  if (ancestors.has(object)) {
    push("cycle", "cycle: the value contains itself");
    return;
  }
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index++) {
        if (!(index in object)) {
          push("hole", "an array hole is not JSON", [...path, index]);
        } else {
          jsonIssues(
            object[index],
            [...path, index],
            issues,
            ancestors,
            message,
          );
        }
      }
      return;
    }
    if (!isPlainObject(object)) {
      push(
        kindOf(object),
        `a ${kindOf(object)} is not a plain JSON object`,
      );
      return;
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      push("symbol key", "symbol keys are not JSON");
    }
    const record = object as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      jsonIssues(record[key], [...path, key], issues, ancestors, message);
    }
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Any plain JSON value: strings, finite numbers, booleans, `null`, arrays
 * without holes and plain objects (prototype `Object.prototype` or `null`,
 * no symbol keys) of these, with no cycles. Shared references that are not
 * cycles are fine. The output is the input, unchanged.
 *
 * Each problem is an `invalid_type` issue with `expected: "JSON"` at the
 * offending value's path; `received` is the value's kind (`undefined`,
 * `function`, `NaN`, `Date`, ...), `hole`, `cycle` or `symbol key`.
 */
export class JsonValueSchema extends Schema<JsonValue> {
  declare readonly def: AtomDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    const issues: Issue[] = [];
    jsonIssues(input, path, issues, new Set(), this.def.message);
    return issues.length === 0
      ? ok(input)
      : { value: input, issues, aborted: true };
  }
}
