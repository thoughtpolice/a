// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * JSON values, located problems, and a strict JSON reader.
 *
 * exe.dev's token rules are stricter than `JSON.parse`: no duplicate keys at
 * any level, integers written as integers, no raw newlines or NUL. `JSON.parse`
 * keeps the last duplicate and forgets how a number was written, so
 * {@link parseStrictJson} reads the text itself and reports both.
 *
 * @module
 */

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/** Any JSON value. */
export type JsonValue = JsonPrimitive | JsonValue[] | {
  [key: string]: JsonValue;
};

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** Where a problem is: object keys and array indices from the root. */
export type Path = readonly (string | number)[];

/** One problem with a request, a response or a stored value. */
export interface Issue {
  /** Location of the offending value, from the root of what was checked. */
  readonly path: Path;
  /** What is wrong, in a sentence. */
  readonly message: string;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Renders a path the way code would reach it: `vms[0].vm_name`. */
export function formatPath(path: Path): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else if (IDENTIFIER.test(part)) out += out === "" ? part : `.${part}`;
    else out += `[${JSON.stringify(part)}]`;
  }
  return out === "" ? "(root)" : out;
}

/** Renders issues on one line, for error messages. */
export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
    .join("; ");
}

/** True for `{}` literals and `Object.create(null)`, false for class instances. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A short description of a value's type, for messages. */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  return `a ${typeof value}`;
}

/** A number as it was written, so integer-ness can be checked. */
export interface StrictNumber {
  readonly value: number;
  /** The literal text, such as `2e9` or `2000000000.0`. */
  readonly text: string;
}

/** The result of {@link parseStrictJson}. */
export type StrictParse =
  | {
    readonly ok: true;
    readonly value: JsonValue;
    /** Every number literal, keyed by its path formatted with formatPath. */
    readonly numbers: ReadonlyMap<string, StrictNumber>;
  }
  | { readonly ok: false; readonly issues: readonly Issue[] };

class StrictReader {
  index = 0;
  readonly issues: Issue[] = [];
  readonly numbers = new Map<string, StrictNumber>();

  constructor(readonly text: string) {}

  fail(path: Path, message: string): never {
    this.issues.push({ path, message: `${message} at offset ${this.index}` });
    throw this;
  }

  space(): void {
    while (this.index < this.text.length) {
      const c = this.text[this.index];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.index++;
      else break;
    }
  }

  value(path: Path): JsonValue {
    this.space();
    const c = this.text[this.index];
    if (c === "{") return this.object(path);
    if (c === "[") return this.array(path);
    if (c === '"') return this.string(path);
    if (c === "t") return this.literal(path, "true", true);
    if (c === "f") return this.literal(path, "false", false);
    if (c === "n") return this.literal(path, "null", null);
    if (c === "-" || (c >= "0" && c <= "9")) return this.number(path);
    return this.fail(
      path,
      c === undefined
        ? "unexpected end of JSON"
        : `unexpected ${JSON.stringify(c)}`,
    );
  }

  literal<T extends JsonValue>(path: Path, word: string, value: T): T {
    if (this.text.startsWith(word, this.index)) {
      this.index += word.length;
      return value;
    }
    return this.fail(path, "invalid literal");
  }

  number(path: Path): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.text.slice(this.index),
    );
    if (match === null) return this.fail(path, "invalid number");
    this.index += match[0].length;
    const value = Number(match[0]);
    this.numbers.set(formatPath(path), { value, text: match[0] });
    return value;
  }

  string(path: Path): string {
    this.index++;
    let out = "";
    for (;;) {
      const c = this.text[this.index];
      if (c === undefined) return this.fail(path, "unterminated string");
      if (c === '"') {
        this.index++;
        return out;
      }
      if (c < " ") return this.fail(path, "control character in string");
      if (c !== "\\") {
        out += c;
        this.index++;
        continue;
      }
      const e = this.text[this.index + 1];
      const simple: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (e !== undefined && e in simple) {
        out += simple[e];
        this.index += 2;
      } else if (e === "u") {
        const hex = this.text.slice(this.index + 2, this.index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return this.fail(path, "invalid \\u escape");
        }
        out += String.fromCharCode(parseInt(hex, 16));
        this.index += 6;
      } else {
        return this.fail(path, "invalid escape");
      }
    }
  }

  array(path: Path): JsonValue[] {
    this.index++;
    const out: JsonValue[] = [];
    this.space();
    if (this.text[this.index] === "]") {
      this.index++;
      return out;
    }
    for (;;) {
      out.push(this.value([...path, out.length]));
      this.space();
      const c = this.text[this.index];
      if (c === ",") {
        this.index++;
      } else if (c === "]") {
        this.index++;
        return out;
      } else {
        return this.fail(path, "expected , or ] in array");
      }
    }
  }

  object(path: Path): JsonObject {
    this.index++;
    const out: JsonObject = {};
    const seen = new Set<string>();
    this.space();
    if (this.text[this.index] === "}") {
      this.index++;
      return out;
    }
    for (;;) {
      this.space();
      if (this.text[this.index] !== '"') {
        return this.fail(path, "expected a string key");
      }
      const key = this.string(path);
      if (seen.has(key)) {
        this.issues.push({ path: [...path, key], message: "duplicate key" });
      }
      seen.add(key);
      this.space();
      if (this.text[this.index] !== ":") {
        return this.fail([...path, key], "expected :");
      }
      this.index++;
      const value = this.value([...path, key]);
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.space();
      const c = this.text[this.index];
      if (c === ",") {
        this.index++;
      } else if (c === "}") {
        this.index++;
        return out;
      } else {
        return this.fail(path, "expected , or } in object");
      }
    }
  }
}

/**
 * Parses JSON the way `JSON.parse` does, but also reports duplicate keys at
 * any depth and records how each number was written. Returns issues instead
 * of throwing.
 */
export function parseStrictJson(text: string): StrictParse {
  const reader = new StrictReader(text);
  try {
    const value = reader.value([]);
    reader.space();
    if (reader.index !== text.length) {
      reader.fail([], "trailing text after the JSON value");
    }
    if (reader.issues.length > 0) return { ok: false, issues: reader.issues };
    return { ok: true, value, numbers: reader.numbers };
  } catch (error) {
    if (error !== reader) throw error;
    return { ok: false, issues: reader.issues };
  }
}

/** Parses JSON, returning `undefined` instead of throwing. */
export function tryParseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}
