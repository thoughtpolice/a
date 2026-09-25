// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The Streamable HTTP request metadata headers: `MCP-Protocol-Version`,
 * `Mcp-Method`, `Mcp-Name`, and the `Mcp-Param-{Name}` headers that
 * `x-mcp-header` annotations in a tool's `inputSchema` ask for, with the
 * `=?base64?...?=` sentinel encoding for values that are not plain ASCII.
 *
 * The client uses these to build requests, the server to check that headers
 * and body agree (a mismatch is `HeaderMismatch`, -32020).
 *
 * @module
 */

import type { AnySchema } from "@celld/sieve";
import { fromBase64, isPlainObject, type Issue, toBase64 } from "./json.ts";
import type { Path } from "./json.ts";

/**
 * `schema` annotated with `x-mcp-header: name`, so its JSON Schema asks the
 * client to mirror the argument into `Mcp-Param-{name}` on Streamable HTTP.
 * Only for a string, integer or boolean property directly reachable through
 * `properties` (the server refuses the tool otherwise). Never use it for
 * secrets: headers are visible to intermediaries.
 *
 * ```ts
 * input: v.strictObject({ region: mcpHeader(v.string(), "Region") })
 * ```
 */
export function mcpHeader<S extends AnySchema>(schema: S, name: string): S {
  return schema.meta({ "x-mcp-header": name });
}

/** The header names, in their canonical spelling. */
export const HEADER = {
  protocolVersion: "MCP-Protocol-Version",
  method: "Mcp-Method",
  name: "Mcp-Name",
  paramPrefix: "Mcp-Param-",
} as const;

/**
 * The methods whose requests carry `Mcp-Name`, and the params field it
 * mirrors. The tasks extension routes `tasks/*` by task id, so intermediaries
 * can send every request for a task to the instance holding it.
 */
export const NAME_SOURCE: Readonly<
  Record<string, "name" | "uri" | "taskId">
> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
  "tasks/get": "taskId",
  "tasks/update": "taskId",
  "tasks/cancel": "taskId",
};

const SENTINEL = /^=\?base64\?(.*)\?=$/s;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PLAIN = /^[\x20-\x7e\t]*$/;

/**
 * Encodes a value for `Mcp-Name` or `Mcp-Param-*`: as-is when it is visible
 * ASCII, space and tab with no leading or trailing whitespace, and otherwise
 * (or when it looks like the sentinel) as `=?base64?{UTF-8 base64}?=`.
 */
export function encodeHeaderValue(value: string): string {
  const plain = PLAIN.test(value) && value.trim() === value &&
    !SENTINEL.test(value);
  if (plain) return value;
  return `=?base64?${toBase64(new TextEncoder().encode(value))}?=`;
}

/**
 * Decodes an `Mcp-Name` or `Mcp-Param-*` value. Returns `null` when the value
 * has characters a header value may not carry, or a sentinel whose payload is
 * not base64 of valid UTF-8.
 */
export function decodeHeaderValue(raw: string): string | null {
  if (!PLAIN.test(raw)) return null;
  const match = SENTINEL.exec(raw);
  if (match === null) return raw;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64(match[1]),
    );
  } catch {
    return null;
  }
}

/** One `x-mcp-header` annotation, at a statically reachable property. */
export interface ParamHeader {
  /** The `x-mcp-header` value: the `{Name}` of `Mcp-Param-{Name}`. */
  readonly name: string;
  /** The chain of `properties` keys from the root to the annotated property. */
  readonly path: readonly string[];
}

const SUBSCHEMA_ONE = [
  "additionalProperties",
  "items",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
];
const SUBSCHEMA_LIST = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SUBSCHEMA_MAP = [
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
];
const HEADER_TYPES = new Set(["string", "integer", "boolean", "null"]);

/**
 * The `x-mcp-header` annotations of an `inputSchema`, with every violation of
 * the spec's constraints: a non-empty token, unique ignoring case, only on
 * string, integer or boolean properties, and only on properties reachable
 * from the root through `properties` keys alone. A client MUST drop a tool
 * with any issue from `tools/list`; a server should refuse to register it.
 */
export function paramHeaders(
  inputSchema: unknown,
): { headers: ParamHeader[]; issues: Issue[] } {
  const headers: ParamHeader[] = [];
  const issues: Issue[] = [];
  const reachable = new Set<unknown>();

  // Statically reachable properties: chains of `properties` keys only.
  const chain = (node: unknown, path: string[]) => {
    if (!isPlainObject(node) || !isPlainObject(node.properties)) return;
    for (const [key, sub] of Object.entries(node.properties)) {
      if (!isPlainObject(sub)) continue;
      const at = [...path, key];
      if ("x-mcp-header" in sub) {
        reachable.add(sub);
        const name = sub["x-mcp-header"];
        const where: Path = at.flatMap((part) => ["properties", part]);
        if (typeof name !== "string" || !TOKEN.test(name)) {
          issues.push({
            path: [...where, "x-mcp-header"],
            message: "must be a non-empty HTTP token",
          });
        } else if (
          headers.some((header) =>
            header.name.toLowerCase() === name.toLowerCase()
          )
        ) {
          issues.push({
            path: [...where, "x-mcp-header"],
            message: `duplicates the header name ${name}`,
          });
        } else {
          const types = Array.isArray(sub.type) ? sub.type : [sub.type];
          if (
            !types.every((type) => HEADER_TYPES.has(type as string)) ||
            types.every((type) => type === "null")
          ) {
            issues.push({
              path: [...where, "type"],
              message:
                "an x-mcp-header property must be a string, integer or boolean",
            });
          } else headers.push({ name, path: at });
        }
      }
      chain(sub, at);
    }
  };
  chain(inputSchema, []);

  // Any annotation not found above is misplaced.
  const scan = (node: unknown, path: Path) => {
    if (!isPlainObject(node)) return;
    if ("x-mcp-header" in node && !reachable.has(node)) {
      issues.push({
        path: [...path, "x-mcp-header"],
        message:
          "is only allowed on properties reachable through properties keys",
      });
    }
    for (const key of SUBSCHEMA_ONE) scan(node[key], [...path, key]);
    for (const key of SUBSCHEMA_LIST) {
      const list = node[key];
      if (Array.isArray(list)) {
        list.forEach((item, index) => scan(item, [...path, key, index]));
      }
    }
    for (const key of SUBSCHEMA_MAP) {
      const map = node[key];
      if (isPlainObject(map)) {
        for (const [name, item] of Object.entries(map)) {
          scan(item, [...path, key, name]);
        }
      }
    }
  };
  scan(inputSchema, []);
  return { headers, issues };
}

/** The argument value at a header's property path, or undefined. */
export function argumentAt(
  args: Record<string, unknown> | undefined,
  path: readonly string[],
): unknown {
  let node: unknown = args;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * The header value for an argument: strings as-is, integers in decimal,
 * booleans as `true`/`false`, each then encoded. `null` for an absent or null
 * argument (the header is omitted); throws a TypeError for any other value.
 */
export function paramHeaderValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return encodeHeaderValue(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        "an x-mcp-header argument must be a safe integer, not a fraction or an unsafe integer",
      );
    }
    return String(value);
  }
  throw new TypeError(
    "an x-mcp-header argument must be a string, integer or boolean",
  );
}

/**
 * Checks the `Mcp-Param-*` headers of a `tools/call` against its arguments.
 * Returns a mismatch description, or null when they agree. Integers compare
 * numerically (`42.0` matches 42).
 */
export function paramHeaderMismatch(
  headers: readonly ParamHeader[],
  args: Record<string, unknown> | undefined,
  get: (name: string) => string | null,
): string | null {
  for (const header of headers) {
    const field = HEADER.paramPrefix + header.name;
    const raw = get(field);
    const value = argumentAt(args, header.path);
    if (value === undefined || value === null) {
      if (raw !== null) {
        return `${field} is present but the argument is absent`;
      }
      continue;
    }
    if (raw === null) return `${field} is missing`;
    const decoded = decodeHeaderValue(raw);
    if (decoded === null) return `${field} has invalid characters or encoding`;
    let same: boolean;
    if (typeof value === "string") same = decoded === value;
    else if (typeof value === "boolean") same = decoded === String(value);
    else if (typeof value === "number") {
      same = /^-?[0-9]+(\.0+)?$/.test(decoded) && Number(decoded) === value;
    } else same = false;
    if (!same) {
      return `${field} header value ${
        JSON.stringify(decoded)
      } does not match body value ${JSON.stringify(value)}`;
    }
  }
  return null;
}
