// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A JSON parser that enforces size, depth and collection limits while it
 * parses, so a hostile document is refused before it costs memory or stack.
 *
 * @module
 */

import { utf8Length } from "./collections.ts";
import { BoundsError, describe } from "./error.ts";
import { safeInt } from "./numbers.ts";
import { strictRecord } from "./record.ts";

const JSON_KEYS = Object.freeze([
  "maxDepth",
  "maxKeys",
  "maxItems",
  "maxBytes",
  "allowPrototypeKeys",
  "duplicateKeys",
]);

/** The deepest `maxDepth` accepted; the parser recurses once per level. */
export const MAX_JSON_DEPTH = 1000;

/** Limits for {@link parseJsonBounded}. */
export interface JsonLimits {
  /**
   * The most nested arrays and objects: `[]` is depth 1, `[[]]` depth 2, a
   * bare scalar depth 0. At most {@link MAX_JSON_DEPTH}.
   */
  readonly maxDepth: number;
  /** The most members in any one object (duplicates counted). */
  readonly maxKeys: number;
  /** The most elements in any one array. */
  readonly maxItems: number;
  /** The most UTF-8 bytes in the whole text. */
  readonly maxBytes?: number;
  /**
   * Accept `__proto__`, `constructor` and `prototype` as keys. They become
   * ordinary own properties and never touch a prototype. Default false.
   */
  readonly allowPrototypeKeys?: boolean;
  /**
   * What a key named twice in one object does: `"reject"` (the default)
   * refuses the document, `"last"` keeps the last value as `JSON.parse`
   * does.
   */
  readonly duplicateKeys?: "reject" | "last";
}

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// JSON strings forbid raw control characters, so the run stops at them.
// deno-lint-ignore no-control-regex
const PLAIN = /[^"\\\u0000-\u001f]*/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

class Parser {
  #i = 0;
  readonly #text: string;
  readonly #maxDepth: number;
  readonly #maxKeys: number;
  readonly #maxItems: number;
  readonly #prototypeKeys: boolean;
  readonly #lastWins: boolean;

  constructor(
    text: string,
    limits: {
      maxDepth: number;
      maxKeys: number;
      maxItems: number;
      prototypeKeys: boolean;
      lastWins: boolean;
    },
  ) {
    this.#text = text;
    this.#maxDepth = limits.maxDepth;
    this.#maxKeys = limits.maxKeys;
    this.#maxItems = limits.maxItems;
    this.#prototypeKeys = limits.prototypeKeys;
    this.#lastWins = limits.lastWins;
  }

  parse(): unknown {
    const value = this.#value(0);
    this.#space();
    if (this.#i !== this.#text.length) {
      this.#fail("unexpected text after the value");
    }
    return value;
  }

  #fail(what: string): never {
    const at = this.#i >= this.#text.length
      ? "at the end"
      : `at offset ${this.#i}`;
    throw new BoundsError("syntax", `not JSON: ${what} ${at}`);
  }

  #space(): void {
    const text = this.#text;
    let i = this.#i;
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
    this.#i = i;
  }

  #value(depth: number): unknown {
    this.#space();
    const c = this.#text[this.#i];
    switch (c) {
      case "{":
        return this.#object(this.#open(depth));
      case "[":
        return this.#array(this.#open(depth));
      case '"':
        return this.#string();
      case "t":
        return this.#literal("true", true);
      case "f":
        return this.#literal("false", false);
      case "n":
        return this.#literal("null", null);
      default:
        if (c === "-" || (c >= "0" && c <= "9")) return this.#number();
        return this.#fail("expected a value");
    }
  }

  #open(depth: number): number {
    if (depth + 1 > this.#maxDepth) {
      throw new BoundsError(
        "too_deep",
        `JSON nests deeper than ${this.#maxDepth} at offset ${this.#i}`,
      );
    }
    this.#i++;
    return depth + 1;
  }

  #literal<T>(word: string, value: T): T {
    if (!this.#text.startsWith(word, this.#i)) this.#fail("a bad literal");
    this.#i += word.length;
    return value;
  }

  #number(): number {
    NUMBER.lastIndex = this.#i;
    const match = NUMBER.exec(this.#text);
    if (match === null) this.#fail("a bad number");
    const end = this.#i + match[0].length;
    const next = this.#text[end];
    // "01" and "1." stop the pattern early; the rest must not be number text.
    if (next !== undefined && /[0-9.eE+-]/.test(next)) {
      this.#fail("a bad number");
    }
    this.#i = end;
    return Number(match[0]);
  }

  #string(): string {
    const text = this.#text;
    this.#i++;
    let result = "";
    for (;;) {
      PLAIN.lastIndex = this.#i;
      const run = PLAIN.exec(text)![0];
      result += run;
      this.#i += run.length;
      const c = text[this.#i];
      if (c === '"') {
        this.#i++;
        return result;
      }
      if (c !== "\\") {
        this.#fail(
          c === undefined
            ? "an unterminated string"
            : "a control character in a string",
        );
      }
      const escape = text[this.#i + 1];
      if (escape === "u") {
        const hex = text.slice(this.#i + 2, this.#i + 6);
        if (!HEX4.test(hex)) this.#fail("a bad \\u escape");
        result += String.fromCharCode(parseInt(hex, 16));
        this.#i += 6;
      } else if (escape !== undefined && Object.hasOwn(ESCAPES, escape)) {
        result += ESCAPES[escape];
        this.#i += 2;
      } else {
        this.#fail("a bad escape");
      }
    }
  }

  #array(depth: number): unknown[] {
    const items: unknown[] = [];
    this.#space();
    if (this.#text[this.#i] === "]") {
      this.#i++;
      return items;
    }
    for (;;) {
      if (items.length >= this.#maxItems) {
        throw new BoundsError(
          "too_many",
          `a JSON array has more than ${this.#maxItems} items`,
        );
      }
      items.push(this.#value(depth));
      this.#space();
      const c = this.#text[this.#i++];
      if (c === "]") return items;
      if (c !== ",") {
        this.#i--;
        this.#fail("expected , or ]");
      }
    }
  }

  #object(depth: number): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    this.#space();
    if (this.#text[this.#i] === "}") {
      this.#i++;
      return object;
    }
    let members = 0;
    for (;;) {
      this.#space();
      if (this.#text[this.#i] !== '"') this.#fail("expected a key");
      const at = this.#i;
      const key = this.#string();
      if (++members > this.#maxKeys) {
        throw new BoundsError(
          "too_many",
          `a JSON object has more than ${this.#maxKeys} keys`,
        );
      }
      if (!this.#prototypeKeys && FORBIDDEN.has(key)) {
        throw new BoundsError(
          "forbidden_key",
          `a JSON object has the key ${describe(key)} at offset ${at}`,
        );
      }
      if (!this.#lastWins && Object.hasOwn(object, key)) {
        throw new BoundsError(
          "duplicate_key",
          `a JSON object names ${describe(key)} twice (offset ${at})`,
        );
      }
      this.#space();
      if (this.#text[this.#i] !== ":") this.#fail("expected :");
      this.#i++;
      const value = this.#value(depth);
      // Assigning "__proto__" would set the prototype; define it instead.
      Object.defineProperty(object, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      this.#space();
      const c = this.#text[this.#i++];
      if (c === "}") return object;
      if (c !== ",") {
        this.#i--;
        this.#fail("expected , or }");
      }
    }
  }
}

/**
 * Parses `text` as JSON (RFC 8259, the grammar `JSON.parse` accepts) while
 * enforcing `limits`. Nesting, keys per object and items per array are
 * counted as the parser goes, so a document that breaks a limit is refused
 * when it reaches it, never after building the whole value. The result is
 * `unknown`: validate it before use.
 *
 * Unlike `JSON.parse`, keys named `__proto__`, `constructor` or `prototype`
 * and duplicate keys are refused by default (see {@link JsonLimits}).
 *
 * @throws {BoundsError} `syntax`, `too_large`, `too_deep`, `too_many`,
 * `forbidden_key`, `duplicate_key`, or `type` when `text` is not a string.
 * @throws {RangeError} for bad limits.
 */
export function parseJsonBounded(text: string, limits: JsonLimits): unknown {
  strictRecord(limits, JSON_KEYS, "JSON limits");
  if (
    limits.allowPrototypeKeys !== undefined &&
    typeof limits.allowPrototypeKeys !== "boolean"
  ) throw new TypeError("allowPrototypeKeys must be boolean");
  const maxDepth = safeInt(limits.maxDepth, {
    name: "maxDepth",
    min: 0,
    max: MAX_JSON_DEPTH,
  });
  const maxKeys = safeInt(limits.maxKeys, { name: "maxKeys", min: 0 });
  const maxItems = safeInt(limits.maxItems, { name: "maxItems", min: 0 });
  const maxBytes = limits.maxBytes === undefined
    ? undefined
    : safeInt(limits.maxBytes, { name: "maxBytes", min: 0 });
  const duplicates = limits.duplicateKeys === undefined
    ? "reject"
    : limits.duplicateKeys;
  if (duplicates !== "reject" && duplicates !== "last") {
    throw new RangeError(
      `duplicateKeys must be "reject" or "last", got ${describe(duplicates)}`,
    );
  }
  if (typeof text !== "string") {
    throw new BoundsError(
      "type",
      `JSON text must be a string, got ${describe(text)}`,
    );
  }
  // A string's UTF-8 form is never shorter than its UTF-16 length.
  if (
    maxBytes !== undefined &&
    (text.length > maxBytes || utf8Length(text) > maxBytes)
  ) {
    throw new BoundsError(
      "too_large",
      `the JSON text is larger than ${maxBytes} bytes`,
    );
  }
  return new Parser(text, {
    maxDepth,
    maxKeys,
    maxItems,
    prototypeKeys: limits.allowPrototypeKeys === true,
    lastWins: duplicates === "last",
  }).parse();
}
