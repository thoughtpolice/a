// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Proactive content negotiation on `Accept` (RFC 9110 section 12.5.1), for
 * `c.accepts`.
 *
 * @module
 */

interface Range {
  readonly type: string;
  readonly subtype: string;
  readonly q: number;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** The media ranges of an `Accept` header; malformed ones are skipped. */
function ranges(header: string): Range[] {
  const out: Range[] = [];
  for (const part of header.split(",")) {
    const [range, ...params] = part.split(";").map((item) => item.trim());
    const [type, subtype, ...rest] = range.toLowerCase().split("/");
    if (
      rest.length > 0 || type === undefined || subtype === undefined ||
      !TOKEN.test(type) || !TOKEN.test(subtype) ||
      (type === "*" && subtype !== "*")
    ) {
      continue;
    }
    let q = 1;
    let valid = true;
    for (const param of params) {
      const [name, value] = param.split("=").map((item) => item.trim());
      if (name.toLowerCase() !== "q") continue;
      if (value === undefined || !QVALUE.test(value)) valid = false;
      else q = Number(value);
    }
    if (valid) out.push({ type, subtype, q });
  }
  return out;
}

/** How specific `range` is about `type/subtype`: 3 exact, 2 `type/*`, 1 any, 0 no match. */
function specificity(range: Range, type: string, subtype: string): number {
  if (range.type === "*") return 1;
  if (range.type !== type) return 0;
  if (range.subtype === "*") return 2;
  return range.subtype === subtype ? 3 : 0;
}

/**
 * The best of `offered` for `header`, or null; see `Context.accepts`. An
 * absent header takes anything; one with no valid ranges takes nothing.
 */
export function negotiate(
  header: string | null,
  offered: readonly string[],
): string | null {
  if (offered.length === 0) return null;
  if (header === null) return offered[0];
  const accepted = ranges(header);
  let best: string | null = null;
  let bestQ = 0;
  for (const media of offered) {
    const [type, subtype = ""] = media.split(";")[0].trim().toLowerCase()
      .split("/");
    let q = 0;
    let most = 0;
    for (const range of accepted) {
      const level = specificity(range, type, subtype);
      if (level > most) {
        most = level;
        q = range.q;
      } else if (level === most && level > 0) {
        q = Math.max(q, range.q);
      }
    }
    if (q > bestQ) {
      best = media;
      bestQ = q;
    }
  }
  return best;
}
