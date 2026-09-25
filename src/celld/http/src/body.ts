// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Error bodies, kept small because they end up on errors that are logged and
 * sent over RPC.
 *
 * @module
 */

/** Error bodies that are not JSON are cut to this many UTF-16 code units. */
export const MAX_ERROR_TEXT = 4096;

/** A JSON value, as `JSON.parse` returns it; what {@link truncatedBody} returns. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

/**
 * An error body as a client keeps it: `null` for an empty body, the parsed
 * value when the text is JSON, or else the text itself, cut to `maxChars`
 * with a trailing `…` when longer. The cut never splits a surrogate pair.
 */
export function truncatedBody(
  text: string,
  maxChars: number = MAX_ERROR_TEXT,
): JsonValue {
  if (text === "") return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    // Not JSON: keep it as text.
  }
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}
