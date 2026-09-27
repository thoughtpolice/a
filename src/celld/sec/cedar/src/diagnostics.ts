// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Cedar's errors and warnings with positions a person can use.
 *
 * Cedar reports spans as byte offsets into the UTF-8 text it parsed; a
 * {@link Diagnostic} adds 1-based lines and columns (in characters) and the
 * policy the span is in, and {@link formatDiagnostic} renders one against
 * its source the way compilers do.
 *
 * @module
 */

import type { DetailedError, Severity } from "./ffi.ts";

/** A span of source text. Lines and columns are 1-based. */
export interface Span {
  /** UTF-16 offsets into the source string, end exclusive. */
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly label?: string;
}

/** An error or warning from Cedar. */
export interface Diagnostic {
  readonly severity: Severity;
  readonly message: string;
  readonly help?: string;
  readonly code?: string;
  readonly url?: string;
  /** The policy or template the diagnostic is about, when Cedar says. */
  readonly policyId?: string;
  /** Positions in the policy's text (or the text that was parsed). */
  readonly spans: readonly Span[];
  readonly related: readonly Diagnostic[];
}

/** The result of parsing or checking something Cedar reads. */
export type Checked<T> =
  | {
    readonly ok: true;
    readonly value: T;
    readonly warnings: readonly Diagnostic[];
  }
  | { readonly ok: false; readonly errors: readonly Diagnostic[] };

/** A failure carrying Cedar's diagnostics, thrown by the `...OrThrow` forms. */
export class CedarError extends Error {
  override readonly name = "CedarError";
  readonly diagnostics: readonly Diagnostic[];
  constructor(
    what: string,
    diagnostics: readonly Diagnostic[],
    sources: SourceOf = () => undefined,
  ) {
    super(
      `${what}:\n${
        diagnostics.map((d) => formatDiagnostic(d, sources(d))).join("\n")
      }`,
    );
    this.diagnostics = diagnostics;
  }
}

/** Finds the text a diagnostic's spans point into. */
export type SourceOf = (diagnostic: Diagnostic) => string | undefined;

/** The value of a {@link Checked}, or a {@link CedarError}. */
export function orThrow<T>(
  checked: Checked<T>,
  what = "cedar",
  sources?: SourceOf,
): T {
  if (!checked.ok) throw new CedarError(what, checked.errors, sources);
  return checked.value;
}

/** UTF-16 index of each UTF-8 byte offset into `text`. */
function byteIndex(text: string): (byte: number) => number {
  const cache = new Map<number, number>();
  return (byte) => {
    const hit = cache.get(byte);
    if (hit !== undefined) return hit;
    let bytes = 0;
    let i = 0;
    while (i < text.length && bytes < byte) {
      const code = text.codePointAt(i)!;
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      i += code >= 0x10000 ? 2 : 1;
    }
    cache.set(byte, i);
    return i;
  };
}

/** 1-based line and column (in code points) of UTF-16 index `index`. */
function position(text: string, index: number): [number, number] {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return [line, [...text.slice(lineStart, index)].length + 1];
}

/**
 * Converts Cedar's errors. `source` is the text the offsets point into (a
 * policy's, or the whole text parsed), found per error by `sourceFor` when
 * errors name different policies.
 */
export function toDiagnostics(
  errors: readonly DetailedError[],
  options: {
    readonly severity?: Severity;
    readonly policyId?: (
      error: DetailedError,
      index: number,
    ) => string | undefined;
    readonly source?: (policyId: string | undefined) => string | undefined;
  } = {},
): Diagnostic[] {
  return errors.map((error, index) => {
    const policyId = options.policyId?.(error, index);
    return convertOne(
      error,
      policyId,
      options.source?.(policyId),
      options.severity ?? "error",
    );
  });
}

function convertOne(
  error: DetailedError,
  policyId: string | undefined,
  source: string | undefined,
  severity: Severity,
): Diagnostic {
  const toIndex = source === undefined
    ? (byte: number) => byte
    : byteIndex(source);
  const spans = (error.sourceLocations ?? []).map((location): Span => {
    const start = toIndex(location.start);
    const end = toIndex(location.end);
    const [line, column] = source === undefined
      ? [0, 0]
      : position(source, start);
    const [endLine, endColumn] = source === undefined
      ? [0, 0]
      : position(source, end);
    return {
      start,
      end,
      line,
      column,
      endLine,
      endColumn,
      ...(location.label ? { label: location.label } : {}),
    };
  });
  return {
    severity: error.severity ?? severity,
    message: error.message,
    ...(error.help ? { help: error.help } : {}),
    ...(error.code ? { code: error.code } : {}),
    ...(error.url ? { url: error.url } : {}),
    ...(policyId !== undefined ? { policyId } : {}),
    spans,
    related: (error.related ?? []).map((related) =>
      convertOne(related, policyId, source, severity)
    ),
  };
}

/**
 * Renders a diagnostic, with the source lines its spans cover when
 * `source` is given:
 *
 * ```text
 * error: for policy `owner`, attribute `nope` on entity type `Doc` not found
 *   --> owner:1:61
 *    |
 *  1 | permit(principal, action, resource) when { resource.nope == 1 };
 *    |                                            ^^^^^^^^^^^^^
 *    = help: did you mean `level`?
 * ```
 */
export function formatDiagnostic(
  diagnostic: Diagnostic,
  source?: string,
): string {
  const lines = [`${diagnostic.severity}: ${diagnostic.message}`];
  const where = diagnostic.policyId ?? "<policies>";
  const text = source?.split("\n");
  for (const span of diagnostic.spans) {
    if (text === undefined || span.line === 0) {
      lines.push(
        `  --> ${where}@${span.start}..${span.end}${
          span.label ? ` (${span.label})` : ""
        }`,
      );
      continue;
    }
    const gutter = String(span.endLine).length;
    const pad = " ".repeat(gutter);
    lines.push(`${pad}--> ${where}:${span.line}:${span.column}`, `${pad} |`);
    for (let n = span.line; n <= span.endLine; n++) {
      const content = text[n - 1] ?? "";
      const chars = [...content];
      const from = n === span.line ? span.column - 1 : 0;
      const to = n === span.endLine ? span.endColumn - 1 : chars.length;
      lines.push(`${String(n).padStart(gutter)} | ${content}`);
      const width = Math.max(1, to - from);
      const marker = `${" ".repeat(from)}${"^".repeat(width)}`;
      lines.push(
        `${pad} | ${marker}${
          n === span.endLine && span.label ? ` ${span.label}` : ""
        }`,
      );
    }
  }
  if (diagnostic.help) lines.push(`${" ".repeat(2)}= help: ${diagnostic.help}`);
  for (const related of diagnostic.related) {
    lines.push(
      ...formatDiagnostic(related, source).split("\n").map((line) =>
        `  ${line}`
      ),
    );
  }
  return lines.join("\n");
}
