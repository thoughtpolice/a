// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Splitting large inputs (diffs, disassembly, logs, source) into pieces that
 * fit a context budget, at boundaries that keep each piece meaningful.
 *
 * ```ts
 * for (const chunk of chunkDiff(diff, { maxChars: 120_000 })) {
 *   await review(chunk.text); // each chunk repeats its files' headers
 * }
 * ```
 *
 * Sizes are in characters, not tokens: there is no tokenizer for these
 * models in reach, and about four characters a token is close enough for
 * English and code ({@link estimateTokens}). Leave headroom for the prompt,
 * the replayed conversation and the answer; {@link contextBudgetChars}
 * helps.
 *
 * @module
 */

import { modelInfo } from "./models.ts";

/** One piece of a split input. */
export interface Chunk {
  /** 0-based position among the chunks. */
  readonly index: number;
  /** How many chunks there are. */
  readonly total: number;
  readonly text: string;
  /** 1-based first and last line of the input this chunk covers. */
  readonly startLine: number;
  readonly endLine: number;
  /** A label, such as the files or functions it covers. */
  readonly label: string;
}

/** A rough token count: characters over four, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Characters of input that fit `model`'s context window after reserving
 * `reserveTokens` (default 32,000) for instructions, conversation and the
 * answer; `fraction` (default 0.5) of that, to stay clear of the edge.
 * Unknown models are assumed to have 128,000 tokens.
 */
export function contextBudgetChars(
  model: string,
  options: { readonly reserveTokens?: number; readonly fraction?: number } = {},
): number {
  const window = modelInfo(model)?.contextWindow ?? 128_000;
  const usable = Math.max(0, window - (options.reserveTokens ?? 32_000));
  return Math.floor(usable * (options.fraction ?? 0.5) * 4);
}

function checkMax(maxChars: number): void {
  if (!Number.isInteger(maxChars) || maxChars < 16) {
    throw new RangeError(
      `maxChars must be an integer of at least 16, got ${maxChars}`,
    );
  }
}

interface Unit {
  readonly lines: string[];
  readonly start: number;
  readonly label: string;
  /** Lines repeated at the top of every chunk holding part of this unit. */
  readonly header: string[];
}

function size(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Packs units greedily into chunks of at most `maxChars`, splitting a unit
 * that is too big by lines (each part keeps the unit's header), and a line
 * that is too big by characters.
 */
function pack(units: readonly Unit[], maxChars: number): Chunk[] {
  interface Draft {
    lines: string[];
    start: number;
    end: number;
    labels: string[];
    /** The header of the last unit added, so its sibling hunks skip it. */
    header: readonly string[] | null;
  }
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  const flush = () => {
    if (current !== null && current.lines.length > 0) drafts.push(current);
    current = null;
  };
  for (const unit of units) {
    const whole = [...unit.header, ...unit.lines];
    if (size(whole) <= maxChars) {
      const shared = current !== null && unit.header.length > 0 &&
        current.header === unit.header;
      const adding = shared ? unit.lines : whole;
      if (current !== null && size(current.lines) + size(adding) > maxChars) {
        flush();
      }
      current ??= {
        lines: [],
        start: unit.start,
        end: unit.start,
        labels: [],
        header: null,
      };
      current.lines.push(
        ...(current.header === unit.header && unit.header.length > 0
          ? unit.lines
          : whole),
      );
      current.header = unit.header;
      current.end = unit.start + unit.lines.length - 1;
      if (unit.label !== "" && !current.labels.includes(unit.label)) {
        current.labels.push(unit.label);
      }
      continue;
    }
    flush();
    const room = Math.max(16, maxChars - size(unit.header));
    let part: string[] = [];
    let partStart = unit.start;
    unit.lines.forEach((line, offset) => {
      const pieces = line.length + 1 > room
        ? Array.from(
          { length: Math.ceil(line.length / (room - 1)) },
          (_, i) => line.slice(i * (room - 1), (i + 1) * (room - 1)),
        )
        : [line];
      for (const piece of pieces) {
        if (part.length > 0 && size(part) + piece.length + 1 > room) {
          drafts.push({
            lines: [...unit.header, ...part],
            start: partStart,
            end: unit.start + offset - (piece === pieces[0] ? 1 : 0),
            labels: unit.label === "" ? [] : [unit.label],
            header: null,
          });
          part = [];
          partStart = unit.start + offset;
        }
        part.push(piece);
      }
    });
    if (part.length > 0) {
      drafts.push({
        lines: [...unit.header, ...part],
        start: partStart,
        end: unit.start + unit.lines.length - 1,
        labels: unit.label === "" ? [] : [unit.label],
        header: null,
      });
    }
  }
  flush();
  return drafts.map((draft, index) => ({
    index,
    total: drafts.length,
    text: draft.lines.join("\n"),
    startLine: draft.start,
    endLine: Math.max(draft.start, draft.end),
    label: draft.labels.join(", "),
  }));
}

/** Options for {@link chunkLines}. */
export interface LineChunkOptions {
  readonly maxChars: number;
  /** Lines repeated from the end of one chunk at the start of the next. */
  readonly overlapLines?: number;
  /** Prefix each line with its 1-based number (`12: ...`). */
  readonly numberLines?: boolean;
}

/** Splits text by lines. Overlap and numbering help logs and source. */
export function chunkLines(text: string, options: LineChunkOptions): Chunk[] {
  checkMax(options.maxChars);
  const overlap = options.overlapLines ?? 0;
  const lines = splitLines(text).map((line, index) =>
    options.numberLines ? `${index + 1}: ${line}` : line
  );
  if (overlap === 0) {
    return pack(
      lines.map((line, index) => ({
        lines: [line],
        start: index + 1,
        label: "",
        header: [],
      })),
      options.maxChars,
    );
  }
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let used = 0;
    while (
      end < lines.length &&
      (end === start || used + lines[end].length + 1 <= options.maxChars)
    ) {
      used += lines[end].length + 1;
      end++;
    }
    chunks.push({
      index: chunks.length,
      total: 0,
      text: lines.slice(start, end).join("\n").slice(0, options.maxChars),
      startLine: start + 1,
      endLine: end,
      label: "",
    });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks.map((chunk) => ({ ...chunk, total: chunks.length }));
}

/** Splits a log, numbering its lines so findings can cite them. */
export function chunkLog(
  text: string,
  options: { readonly maxChars: number },
): Chunk[] {
  return chunkLines(text, { maxChars: options.maxChars, numberLines: true });
}

/**
 * Splits a unified diff (git or plain) into chunks of whole files where
 * possible; a file too big for one chunk is split between hunks, and each
 * part repeats the file's header (`diff --git`, `---`, `+++`) so it stands
 * alone. Labels list the files.
 *
 * A file starts at `diff --git` or `Index:`; in a plain diff (no such
 * lines), at a `---` line followed by `+++` once the previous file has had
 * a hunk.
 */
export function chunkDiff(
  diff: string,
  options: { readonly maxChars: number },
): Chunk[] {
  checkMax(options.maxChars);
  const lines = splitLines(diff);
  interface File {
    start: number;
    lines: string[];
    git: boolean;
    hunks: boolean;
  }
  const files: File[] = [];
  let current: File | null = null;
  lines.forEach((line, index) => {
    const git = /^(diff --git |Index: )/.test(line);
    const plain = line.startsWith("--- ") &&
      (lines[index + 1] ?? "").startsWith("+++ ") &&
      (current === null || (!current.git && current.hunks));
    if (git || plain || current === null) {
      current = { start: index + 1, lines: [], git, hunks: false };
      files.push(current);
    }
    current.lines.push(line);
    if (line.startsWith("@@")) current.hunks = true;
  });
  const units: Unit[] = [];
  for (const file of files) {
    const firstHunk = file.lines.findIndex((line) => line.startsWith("@@"));
    const plus = file.lines.find((line) => line.startsWith("+++ "));
    const gitName = /^diff --git a\/(.*) b\/(.*)$/.exec(file.lines[0] ?? "");
    const label =
      (gitName?.[2] ?? plus?.slice(4).replace(/^b\//, "").split("\t")[0] ?? "")
        .trim();
    if (firstHunk <= 0 || size(file.lines) <= options.maxChars) {
      units.push({ lines: file.lines, start: file.start, label, header: [] });
      continue;
    }
    const header = file.lines.slice(0, firstHunk);
    let hunk: string[] = [];
    let hunkStart = file.start + firstHunk;
    file.lines.slice(firstHunk).forEach((line, offset) => {
      if (line.startsWith("@@") && hunk.length > 0) {
        units.push({ lines: hunk, start: hunkStart, label, header });
        hunk = [];
        hunkStart = file.start + firstHunk + offset;
      }
      hunk.push(line);
    });
    if (hunk.length > 0) {
      units.push({ lines: hunk, start: hunkStart, label, header });
    }
  }
  return pack(units, options.maxChars);
}

const FUNCTION_START = [
  /^[0-9a-fA-F]+ <[^>]+>:\s*$/, // objdump: 0000000000401136 <main>:
  /^\s*;\s*(=+\s*)?(S U B R O U T I N E|FUNCTION|Function)\b/, // IDA and Ghidra banners
  /^(sub|fcn|func|loc)[._][0-9a-fA-F]+:?\s*$/, // sub_401000:
  /^[A-Za-z_.$][\w.$@]*:\s*$/, // plain labels: main:
  /^\s*\/\/ Function:? /, // decompiler comments
];

function functionName(line: string): string {
  const objdump = /<([^>]+)>:/.exec(line);
  if (objdump !== null) return objdump[1];
  const label = /^([\w.$@]+):?\s*$/.exec(line.trim());
  if (label !== null) return label[1];
  return line.trim().replace(/^[;/\s=]+/, "").slice(0, 60);
}

/**
 * Splits disassembly or decompiler output at function boundaries (objdump
 * `<name>:` lines, IDA/Ghidra banners, `sub_XXXX:` and bare labels),
 * packing whole functions together where they fit. Labels list the
 * functions.
 */
export function chunkDisassembly(
  text: string,
  options: { readonly maxChars: number },
): Chunk[] {
  checkMax(options.maxChars);
  const lines = splitLines(text);
  const units: { start: number; lines: string[]; label: string }[] = [];
  lines.forEach((line, index) => {
    if (
      FUNCTION_START.some((pattern) => pattern.test(line)) || units.length === 0
    ) {
      units.push({
        start: index + 1,
        lines: [],
        label: FUNCTION_START.some((pattern) => pattern.test(line))
          ? functionName(line)
          : "",
      });
    }
    units[units.length - 1].lines.push(line);
  });
  return pack(units.map((unit) => ({ ...unit, header: [] })), options.maxChars);
}

/**
 * Runs `fn` over chunks with at most `concurrency` (default 2, gentle on a
 * shared subscription) at once, returning results in chunk order.
 */
export async function mapChunks<T>(
  chunks: readonly Chunk[],
  fn: (chunk: Chunk) => Promise<T>,
  options: { readonly concurrency?: number } = {},
): Promise<T[]> {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `concurrency must be a positive integer, got ${concurrency}`,
    );
  }
  const results: T[] = new Array(chunks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
      while (next < chunks.length) {
        const index = next++;
        results[index] = await fn(chunks[index]);
      }
    }),
  );
  return results;
}
