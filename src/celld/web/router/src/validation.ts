// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { strictRecord } from "@celld/core/bounds";
import { RouterError } from "./errors.ts";

export const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/** Strict option validation, with the router's construction-error taxonomy. */
export function optionsRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): void {
  try {
    strictRecord(value, keys, name);
  } catch (cause) {
    throw new RouterError(`${name} must be a plain record of known options`, {
      cause,
    });
  }
}

export function optionType(
  value: unknown,
  type: "boolean" | "function" | "string",
  name: string,
): void {
  if (value !== undefined && typeof value !== type) {
    throw new RouterError(`${name} must be a ${type}`);
  }
}

export function optionText(
  value: unknown,
  name: string,
  pattern?: RegExp,
): void {
  // deno-lint-ignore no-control-regex
  const controls = /[\u0000-\u001f\u007f]/u;
  if (
    value !== undefined &&
    (typeof value !== "string" || value.length === 0 || value.length > 4096 ||
      controls.test(value) ||
      pattern !== undefined && !pattern.test(value))
  ) {
    throw new RouterError(`${name} must be a bounded valid string`);
  }
}

export function tokenList(
  value: unknown,
  name: string,
  pattern = HTTP_TOKEN,
  allowEmpty = true,
): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) || value.length > 256 ||
    !allowEmpty && value.length === 0 ||
    !value.every((v) =>
      typeof v === "string" && v.length > 0 && v.length <= 256 &&
      pattern.test(v)
    )
  ) throw new RouterError(`${name} must be a bounded list of valid tokens`);
}

/** A programmer error must not be converted into authorization by coercion. */
export function exactBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must return a boolean`);
  }
  return value;
}

export function clockValue(value: number, name = "now"): number {
  if (!Number.isFinite(value) || value < 0 || value > 8.64e15) {
    throw new TypeError(`${name} must return finite epoch milliseconds`);
  }
  return value;
}
