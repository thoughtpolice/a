// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic compare.py, Apache-2.0, ab024cdc.
import { Buffer } from "node:buffer";
import { lstat } from "node:fs/promises";
import { readWorkspaceFile } from "../../../lib/files.ts";
import { integer, list, object, sha, text } from "./common.ts";
type Mask = { start: number; end: number; why: string } | {
  regex: RegExp;
  why: string;
};
interface Tolerance {
  rel: string;
  abs: string;
  why: string;
}
interface Case {
  id: string;
  legacy: string;
  candidate: string;
  input?: string;
  masks: Mask[];
  tolerance?: Tolerance;
}
export interface ComparisonRow {
  id: string;
  inputHash: string;
  legacyHash: string;
  candidateHash: string;
  verdict: "same" | "differs" | "missing";
  empty: boolean;
  hiddenBytes: number;
  firstDifference: number | null;
  selfCheck: boolean;
  reasons: string[];
}
export interface Comparison {
  ok: boolean;
  oldest: number;
  cases: ComparisonRow[];
}
function decimal(token: string): { n: bigint; exponent: number } {
  if (
    token.length > 64 ||
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)
  ) throw new Error("Invalid decimal");
  const [mantissa, exponent = "0"] = token.toLowerCase().split("e"),
    fraction = mantissa.split(".")[1]?.length ?? 0;
  const e = Number(exponent) - fraction;
  if (!Number.isSafeInteger(e) || Math.abs(e) > 1000) {
    throw new Error("Decimal exponent exceeds limit");
  }
  return {
    n: BigInt(mantissa.replace(".", "").replace(/^\+/, "")),
    exponent: e,
  };
}
function tolerant(a: Buffer, b: Buffer, tolerance?: Tolerance): boolean {
  if (a.equals(b)) return true;
  if (!tolerance) return false;
  const pattern =
    /\d+(?:\.\d+){2,}|[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/g;
  const parts = (value: Buffer): string[] => {
    const raw = value.toString("latin1"), result: string[] = [];
    let pos = 0;
    for (const match of raw.matchAll(pattern)) {
      if (/^\d+(?:\.\d+){2,}$/.test(match[0])) continue;
      result.push(raw.slice(pos, match.index), match[0]);
      pos = match.index + match[0].length;
    }
    result.push(raw.slice(pos));
    return result;
  };
  const x = parts(a), y = parts(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    if (i % 2 === 0 || !/[.eE]/.test(x[i]) || !/[.eE]/.test(y[i])) return false;
    try {
      const p = decimal(x[i]),
        q = decimal(y[i]),
        ab = decimal(tolerance.abs),
        rel = decimal(tolerance.rel);
      const e = Math.min(
        p.exponent,
        q.exponent,
        ab.exponent,
        rel.exponent + Math.min(p.exponent, q.exponent),
      );
      const absolute = (n: bigint): bigint => n < 0n ? -n : n;
      const pn = p.n * 10n ** BigInt(p.exponent - e),
        qn = q.n * 10n ** BigInt(q.exponent - e);
      const diff = absolute(pn - qn),
        scale = absolute(pn) > absolute(qn) ? absolute(pn) : absolute(qn);
      const allowedAbs = ab.n * 10n ** BigInt(ab.exponent - e);
      const allowedRel = rel.exponent >= 0
        ? rel.n * scale * 10n ** BigInt(rel.exponent)
        : rel.n * scale / 10n ** BigInt(-rel.exponent);
      if (diff > allowedAbs && diff > allowedRel) return false;
    } catch {
      return false;
    }
  }
  return true;
}
function safeRegex(pattern: string): RegExp {
  let remaining = pattern, width = 0;
  while (remaining) {
    const token =
      /^(?:\\[dwsDWS]|\\[\\.^$[\]{}()*+?|/-]|\[(?:\\[dwsDWS]|[A-Za-z0-9 _:-]){1,80}\]|[A-Za-z0-9 _:/.-])(?:\{(\d{1,2})(?:,(\d{1,2}))?\})?/
        .exec(remaining);
    if (!token) {
      throw new Error(
        "Regex masks support only literals/classes/escapes and bounded {n}/{m,n}; no groups, alternation or unbounded repetition",
      );
    }
    const min = Number(token[1] ?? 1), max = Number(token[2] ?? token[1] ?? 1);
    if (min < 1 || max < min || max > 64 || (width += max) > 512) {
      throw new Error("Regex mask exceeds fixed bounded width");
    }
    remaining = remaining.slice(token[0].length);
  }
  return new RegExp(pattern, "g");
}
function masked(
  bytes: Buffer,
  masks: Mask[],
): { bytes: Buffer; hidden: number; free: number[][] } {
  const spans: number[][] = [];
  for (const m of masks) {
    if ("regex" in m) {
      for (const match of bytes.toString("latin1").matchAll(m.regex)) {
        if (spans.length >= 20000) throw new Error("Too many regex mask spans");
        spans.push([match.index, match.index + match[0].length]);
      }
    } else {spans.push([
        Math.min(m.start, bytes.length),
        Math.min(m.end + 1, bytes.length),
      ]);}
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], span[1]);
    } else merged.push(span);
  }
  const parts: Buffer[] = [], free: number[][] = [];
  let pos = 0, hidden = 0;
  for (const [start, end] of merged) {
    parts.push(bytes.subarray(pos, start));
    if (start > pos) free.push([pos, start]);
    if (end > start) {
      parts.push(Buffer.from("\0<MASK>\0"));
      hidden += end - start;
    }
    pos = end;
  }
  parts.push(bytes.subarray(pos));
  if (bytes.length > pos) free.push([pos, bytes.length]);
  return { bytes: Buffer.concat(parts), hidden, free };
}
function parseCase(value: unknown): Case {
  const c = object(value),
    masks: Mask[] = list(c.masks ?? [], 100).map((v) => {
      const m = object(v), why = text(m.why, 300);
      if (m.regex !== undefined) {
        if (m.start !== undefined || m.end !== undefined) {
          throw new Error("Mask needs either bytes or regex, not both");
        }
        return { regex: safeRegex(text(m.regex, 512)), why };
      }
      const start = integer(m.start, 0, 8 * 1024 * 1024),
        end = integer(m.end, start, 8 * 1024 * 1024);
      return { start, end, why };
    });
  let tolerance: Tolerance | undefined;
  if (c.tolerance !== undefined) {
    const t = object(c.tolerance),
      rel = t.rel === undefined ? "0" : text(t.rel, 64),
      abs = t.abs === undefined ? "0" : text(t.abs, 64);
    const relative = decimal(rel), absolute = decimal(abs);
    const bounded = (
      d: { n: bigint; exponent: number },
      capExponent: number,
    ): boolean => {
      const e = Math.min(d.exponent, capExponent);
      return d.n >= 0n &&
        d.n * 10n ** BigInt(d.exponent - e) <= 10n ** BigInt(capExponent - e);
    };
    if (
      !bounded(relative, -2) || !bounded(absolute, -6) ||
      relative.n === 0n && absolute.n === 0n
    ) {
      throw new Error(
        "Tolerance must be positive and at most 1% relative / 1e-6 absolute",
      );
    }
    tolerance = { rel, abs, why: text(t.why, 300) };
  }
  return {
    id: text(c.id, 100),
    legacy: text(c.legacy),
    candidate: text(c.candidate),
    input: c.input === undefined ? undefined : text(c.input),
    masks,
    tolerance,
  };
}
export async function compare(
  root: string,
  spec: unknown,
): Promise<Comparison> {
  const rows: ComparisonRow[] = [], ids = new Set<string>();
  let totalBytes = 0, oldest = Infinity;
  for (const value of list(object(spec).cases, 500)) {
    const c = parseCase(value);
    if (ids.has(c.id)) throw new Error("Duplicate case id");
    ids.add(c.id);
    const row: ComparisonRow = {
      id: c.id,
      inputHash: "",
      legacyHash: "",
      candidateHash: "",
      verdict: "missing",
      empty: true,
      hiddenBytes: 0,
      firstDifference: null,
      selfCheck: false,
      reasons: c.masks.map((m) => m.why).concat(
        c.tolerance ? [c.tolerance.why] : [],
      ),
    };
    rows.push(row);
    let a: Buffer, b: Buffer;
    try {
      const legacy = await readWorkspaceFile(root, c.legacy),
        candidate = await readWorkspaceFile(root, c.candidate);
      a = legacy.bytes;
      b = candidate.bytes;
      oldest = Math.min(
        oldest,
        (await lstat(legacy.path)).mtimeMs,
        (await lstat(candidate.path)).mtimeMs,
      );
      if (c.input) {
        const input = await readWorkspaceFile(root, c.input);
        row.inputHash = sha(input.bytes);
        totalBytes += input.bytes.length;
        oldest = Math.min(oldest, (await lstat(input.path)).mtimeMs);
      }
    } catch (error) {
      row.reasons.push(String(error));
      continue;
    }
    totalBytes += a.length + b.length;
    if (totalBytes > 64 * 1024 * 1024) {
      throw new Error("Comparisons exceed aggregate 64 MiB limit");
    }
    row.legacyHash = sha(a);
    row.candidateHash = sha(b);
    row.empty = !a.length && !b.length;
    const am = masked(a, c.masks), bm = masked(b, c.masks);
    row.hiddenBytes = am.hidden + bm.hidden;
    row.verdict = tolerant(am.bytes, bm.bytes, c.tolerance)
      ? "same"
      : "differs";
    if (row.verdict === "differs") {
      let i = 0;
      while (
        i < Math.min(am.bytes.length, bm.bytes.length) &&
        am.bytes[i] === bm.bytes[i]
      ) i++;
      row.firstDifference = i;
    }
    // A free-byte canary must fail; every sampled leading float digit must fail too.
    // Trailing rounding digits may legitimately vary within the declared tolerance.
    const biggest = am.free.reduce(
      (best, span) => span[1] - span[0] > best[1] - best[0] ? span : best,
      [0, 0],
    );
    const probes = new Set<number | undefined>([
      am.free[0]?.[0],
      am.free.at(-1)?.[1] === undefined ? undefined : am.free.at(-1)![1] - 1,
      Math.floor((biggest[0] + biggest[1]) / 2),
    ]);
    const detectable = (at: number | undefined): boolean => {
      if (
        at === undefined ||
        !am.free.some(([start, end]) => at >= start && at < end)
      ) return false;
      const changed = Buffer.from(a);
      changed[at] ^= 1;
      return !tolerant(am.bytes, masked(changed, c.masks).bytes, c.tolerance);
    };
    row.selfCheck = [...probes].some(detectable);
    if (c.tolerance && row.selfCheck) {
      let sampled = 0;
      for (
        const match of a.toString("latin1").slice(0, 1024 * 1024).matchAll(
          /[-+]?(?:(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+)/g,
        )
      ) {
        const digit = match.index + match[0].search(/\d/);
        if (
          am.free.some(([start, end]) => digit >= start && digit < end) &&
          !detectable(digit)
        ) row.selfCheck = false;
        if (++sampled >= 200) break;
      }
    }
  }
  return {
    ok: rows.length > 0 &&
      rows.every((r) => r.verdict === "same" && r.selfCheck) &&
      rows.some((r) => !r.empty),
    oldest,
    cases: rows,
  };
}
