// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `apply_patch` format the Codex models are trained to write, parsed and
 * applied with the same rules as Codex's own implementation
 * (`codex-rs/apply-patch`: `parser.rs`, `streaming_parser.rs`,
 * `seek_sequence.rs`, `file_update.rs`, `text_file.rs`).
 *
 * ```text
 * *** Begin Patch
 * *** Add File: src/new.ts
 * +export const x = 1;
 * *** Update File: src/old.ts
 * *** Move to: src/renamed.ts
 * @@ function greet() {
 * -  return "hi";
 * +  return "hello";
 * *** Delete File: src/gone.ts
 * *** End Patch
 * ```
 *
 * What is the same as Codex: the lenient boundary check (whitespace around
 * the markers, a `<<'EOF'` heredoc wrapper), every parse error message and
 * its line number, context matching that falls back from exact to
 * trailing-whitespace, to trimmed, to Unicode-punctuation-normalised
 * comparison, `@@ context` anchors, `*** End of File`, a pure-addition
 * chunk appending at the end of the file, a trailing empty context line
 * that may be dropped, and line endings preserved per line (Codex's
 * `PreserveLineEndings` mode, the one its scenario suite runs), with
 * inserted lines taking the file's first line ending.
 *
 * One deliberate difference: a patch applies all or nothing. Codex applies
 * hunks one by one and leaves earlier ones in place when a later one fails;
 * here every change is computed first and nothing is written unless all of
 * them succeed.
 *
 * @module
 */

import { type FileSystem, normalizePath } from "./fs.ts";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT = "@@ ";
const EMPTY_CHANGE_CONTEXT = "@@";
const ENVIRONMENT_ID = "*** Environment ID:";

const HEADER_HELP =
  "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

/** A patch that could not be parsed or applied. */
export class ApplyPatchError extends Error {
  /** `parse` for a malformed patch, `apply` for one that does not fit the files. */
  readonly kind: "parse" | "apply";
  /** The patch line at fault, for hunk parse errors. */
  readonly lineNumber: number | null;

  constructor(
    kind: "parse" | "apply",
    message: string,
    lineNumber: number | null = null,
  ) {
    super(message);
    this.name = "ApplyPatchError";
    this.kind = kind;
    this.lineNumber = lineNumber;
  }
}

function invalidPatch(message: string): ApplyPatchError {
  return new ApplyPatchError("parse", `invalid patch: ${message}`);
}

function invalidHunk(message: string, line: number): ApplyPatchError {
  return new ApplyPatchError(
    "parse",
    `invalid hunk at line ${line}, ${message}`,
    line,
  );
}

/** One contiguous change within an updated file. */
export interface UpdateChunk {
  /** An anchor line (a function or class header) the change follows. */
  readonly changeContext: string | null;
  readonly oldLines: string[];
  readonly newLines: string[];
  /** Pairs of indices into old and new lines that were context lines. */
  readonly contextLineIndices: [number, number][];
  /** The old lines must be at the end of the file. */
  isEndOfFile: boolean;
}

/** One file operation. */
export type Hunk =
  | { readonly type: "add"; readonly path: string; contents: string }
  | { readonly type: "delete"; readonly path: string }
  | {
    readonly type: "update";
    readonly path: string;
    movePath: string | null;
    readonly chunks: UpdateChunk[];
  };

/** A parsed patch. */
export interface ParsedPatch {
  readonly hunks: Hunk[];
  /** A `*** Environment ID:` line, which Codex uses to pick a sandbox. */
  readonly environmentId: string | null;
}

type Mode =
  | { readonly kind: "not_started" }
  | { readonly kind: "started" }
  | { readonly kind: "add" }
  | { readonly kind: "delete" }
  | { readonly kind: "update"; readonly hunkLine: number }
  | { readonly kind: "ended" };

function newChunk(context: string | null = null): UpdateChunk {
  return {
    changeContext: context,
    oldLines: [],
    newLines: [],
    contextLineIndices: [],
    isEndOfFile: false,
  };
}

function pushContext(chunk: UpdateChunk, line: string): void {
  chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(line);
  chunk.newLines.push(line);
}

function emptyChunk(chunk: UpdateChunk | undefined): boolean {
  return chunk !== undefined && chunk.oldLines.length === 0 &&
    chunk.newLines.length === 0;
}

/** Codex's streaming parser, fed the whole patch at once. */
class Parser {
  mode: Mode = { kind: "not_started" };
  hunks: Hunk[] = [];
  environmentId: string | null = null;
  lineNumber = 0;

  #ensureUpdateNotEmpty(line: string): void {
    const last = this.hunks[this.hunks.length - 1];
    if (last?.type !== "update") return;
    if (last.chunks.length === 0 && this.mode.kind === "update") {
      throw invalidHunk(
        `Update file hunk for path '${last.path}' is empty`,
        this.mode.hunkLine,
      );
    }
    if (emptyChunk(last.chunks[last.chunks.length - 1])) {
      if (line === END_PATCH) {
        throw invalidHunk(
          "Update hunk does not contain any lines",
          this.lineNumber,
        );
      }
      throw invalidHunk(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        this.lineNumber,
      );
    }
  }

  #headers(trimmed: string): boolean {
    if (this.mode.kind === "started" && trimmed.startsWith(ENVIRONMENT_ID)) {
      if (this.environmentId !== null) {
        throw invalidPatch(
          "apply_patch environment_id cannot be specified more than once",
        );
      }
      const id = trimmed.slice(ENVIRONMENT_ID.length).trim();
      if (id === "") {
        throw invalidPatch("apply_patch environment_id cannot be empty");
      }
      this.environmentId = id;
      return true;
    }
    if (trimmed === END_PATCH) {
      this.#ensureUpdateNotEmpty(trimmed);
      this.mode = { kind: "ended" };
      return true;
    }
    if (trimmed.startsWith(ADD_FILE)) {
      this.#ensureUpdateNotEmpty(trimmed);
      this.hunks.push({
        type: "add",
        path: trimmed.slice(ADD_FILE.length),
        contents: "",
      });
      this.mode = { kind: "add" };
      return true;
    }
    if (trimmed.startsWith(DELETE_FILE)) {
      this.#ensureUpdateNotEmpty(trimmed);
      this.hunks.push({
        type: "delete",
        path: trimmed.slice(DELETE_FILE.length),
      });
      this.mode = { kind: "delete" };
      return true;
    }
    if (trimmed.startsWith(UPDATE_FILE)) {
      this.#ensureUpdateNotEmpty(trimmed);
      this.hunks.push({
        type: "update",
        path: trimmed.slice(UPDATE_FILE.length),
        movePath: null,
        chunks: [],
      });
      this.mode = { kind: "update", hunkLine: this.lineNumber };
      return true;
    }
    return false;
  }

  line(line: string): void {
    const trimmed = line.trim();
    switch (this.mode.kind) {
      case "not_started":
        if (trimmed === BEGIN_PATCH) {
          this.mode = { kind: "started" };
          return;
        }
        throw invalidPatch(
          "The first line of the patch must be '*** Begin Patch'",
        );
      case "started":
        if (this.#headers(trimmed)) return;
        throw invalidHunk(
          `'${trimmed}' is not a valid hunk header. ${HEADER_HELP}`,
          this.lineNumber,
        );
      case "add": {
        if (this.#headers(trimmed)) return;
        const last = this.hunks[this.hunks.length - 1];
        if (line.startsWith("+") && last?.type === "add") {
          last.contents += `${line.slice(1)}\n`;
          return;
        }
        throw invalidHunk(
          `'${trimmed}' is not a valid hunk header. ${HEADER_HELP}`,
          this.lineNumber,
        );
      }
      case "delete":
        if (this.#headers(trimmed)) return;
        throw invalidHunk(
          `'${trimmed}' is not a valid hunk header. ${HEADER_HELP}`,
          this.lineNumber,
        );
      case "update":
        this.#update(line);
        return;
      case "ended":
        if (trimmed === "") return;
        throw invalidPatch(
          "The last line of the patch must be '*** End Patch'",
        );
    }
  }

  #update(line: string): void {
    const updateLine = line.trimEnd();
    if (this.#headers(updateLine)) return;
    const hunk = this.hunks[this.hunks.length - 1];
    if (hunk?.type !== "update") throw invalidPatch("internal: no update hunk");
    const chunks = hunk.chunks;
    const last = () => chunks[chunks.length - 1];
    const unexpected = () =>
      invalidHunk(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        this.lineNumber,
      );
    const isContextMarker = updateLine === EMPTY_CHANGE_CONTEXT ||
      updateLine.startsWith(CHANGE_CONTEXT);
    if (last()?.isEndOfFile) {
      if (updateLine === "") return;
      if (!isContextMarker) {
        throw invalidHunk(
          `Expected update hunk to start with a @@ context marker, got: '${line}'`,
          this.lineNumber,
        );
      }
    }
    if (
      chunks.length === 0 && hunk.movePath === null &&
      updateLine.startsWith(MOVE_TO)
    ) {
      hunk.movePath = updateLine.slice(MOVE_TO.length);
      return;
    }
    if (isContextMarker && emptyChunk(last())) throw unexpected();
    if (updateLine === EMPTY_CHANGE_CONTEXT) {
      chunks.push(newChunk());
      return;
    }
    if (updateLine.startsWith(CHANGE_CONTEXT)) {
      chunks.push(newChunk(updateLine.slice(CHANGE_CONTEXT.length)));
      return;
    }
    if (updateLine === EOF_MARKER) {
      if (emptyChunk(last())) {
        throw invalidHunk(
          "Update hunk does not contain any lines",
          this.lineNumber,
        );
      }
      const chunk = last();
      if (chunk !== undefined) chunk.isEndOfFile = true;
      return;
    }
    const ensure = () => {
      if (chunks.length === 0) chunks.push(newChunk());
      return last()!;
    };
    if (line === "") {
      pushContext(ensure(), "");
      return;
    }
    if (line.startsWith(" ")) {
      pushContext(ensure(), line.slice(1));
      return;
    }
    if (line.startsWith("+")) {
      ensure().newLines.push(line.slice(1));
      return;
    }
    if (line.startsWith("-")) {
      ensure().oldLines.push(line.slice(1));
      return;
    }
    const chunk = last();
    if (
      chunk !== undefined &&
      (chunk.oldLines.length > 0 || chunk.newLines.length > 0)
    ) {
      throw invalidHunk(
        `Expected update hunk to start with a @@ context marker, got: '${line}'`,
        this.lineNumber,
      );
    }
    throw unexpected();
  }

  push(text: string): void {
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== "\n") continue;
      let line = text.slice(start, index);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      start = index + 1;
      this.lineNumber++;
      this.line(line);
    }
    this.#rest = text.slice(start);
  }

  #rest = "";

  finish(): ParsedPatch {
    if (this.#rest !== "") {
      const line = this.#rest;
      this.#rest = "";
      this.lineNumber++;
      if (line.trim() === END_PATCH) {
        this.#ensureUpdateNotEmpty(line.trim());
        this.mode = { kind: "ended" };
      } else {
        this.line(line);
      }
    }
    if (this.mode.kind !== "ended") {
      throw invalidPatch("The last line of the patch must be '*** End Patch'");
    }
    return { hunks: this.hunks, environmentId: this.environmentId };
  }
}

function boundariesStrict(lines: readonly string[]): void {
  const first = lines[0]?.trim();
  const last = lines[lines.length - 1]?.trim();
  if (first === BEGIN_PATCH && last === END_PATCH) return;
  if (first !== BEGIN_PATCH) {
    throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
  }
  throw invalidPatch("The last line of the patch must be '*** End Patch'");
}

/** Rust's `str::lines`: split on LF, drop one trailing CR per line. */
function rustLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

/**
 * Parses a patch. A patch wrapped in a `<<'EOF'` ... `EOF` heredoc (as
 * models sometimes write it for a shell) is unwrapped, as Codex does.
 *
 * @throws {ApplyPatchError} `parse`, with Codex's message.
 */
export function parsePatch(patch: string): ParsedPatch {
  let lines = rustLines(patch.trim());
  try {
    boundariesStrict(lines);
  } catch (error) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (
      lines.length >= 4 &&
      (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
      last.endsWith("EOF")
    ) {
      lines = lines.slice(1, -1);
      boundariesStrict(lines);
    } else {
      throw error;
    }
  }
  const parser = new Parser();
  parser.push(lines.join("\n"));
  return parser.finish();
}

// ---------------------------------------------------------------------------
// Applying.

const PUNCTUATION: Record<string, string> = {};
for (const c of "‐‑‒–—―−") PUNCTUATION[c] = "-";
for (const c of "‘’‚‛") PUNCTUATION[c] = "'";
for (const c of "“”„‟") PUNCTUATION[c] = '"';
for (
  const c of "            　"
) PUNCTUATION[c] = " ";

function normalise(line: string): string {
  let out = "";
  for (const char of line.trim()) out += PUNCTUATION[char] ?? char;
  return out;
}

/**
 * Where `pattern` occurs in `lines` at or after `start`, trying exact,
 * trailing-whitespace-insensitive, whitespace-trimmed, then punctuation-
 * normalised matches. With `eof`, the search starts where the pattern
 * would end the file. Codex's `seek_sequence` in `PreserveLineEndings` mode.
 */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;
  const searchStart = eof
    ? Math.max(lines.length - pattern.length, start)
    : start;
  const last = lines.length - pattern.length;
  const passes: ((a: string, b: string) => boolean)[] = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
    (a, b) => normalise(a) === normalise(b),
  ];
  for (const same of passes) {
    for (let index = searchStart; index <= last; index++) {
      let ok = true;
      for (let offset = 0; offset < pattern.length; offset++) {
        if (!same(lines[index + offset], pattern[offset])) {
          ok = false;
          break;
        }
      }
      if (ok) return index;
    }
  }
  return null;
}

type Ending = "\n" | "\r\n" | "\r";

interface SourceLine {
  text: string;
  ending: Ending | null;
}

function parseSource(
  contents: string,
): { lines: SourceLine[]; preferred: Ending } {
  const lines: SourceLine[] = [];
  let preferred: Ending | null = null;
  let lineStart = 0;
  let cursor = 0;
  while (cursor < contents.length) {
    const char = contents[cursor];
    let ending: Ending | null = null;
    if (char === "\r") ending = contents[cursor + 1] === "\n" ? "\r\n" : "\r";
    else if (char === "\n") ending = "\n";
    if (ending === null) {
      cursor++;
      continue;
    }
    preferred ??= ending;
    lines.push({ text: contents.slice(lineStart, cursor), ending });
    cursor += ending.length;
    lineStart = cursor;
  }
  if (lineStart < contents.length) {
    lines.push({ text: contents.slice(lineStart), ending: null });
  }
  return { lines, preferred: preferred ?? "\n" };
}

type Replacement = [start: number, oldLength: number, newLines: string[]];

function computeReplacements(
  lines: readonly string[],
  path: string,
  chunks: readonly UpdateChunk[],
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== null) {
      const found = seekSequence(
        lines,
        [chunk.changeContext],
        lineIndex,
        false,
      );
      if (found === null) {
        throw new ApplyPatchError(
          "apply",
          `Failed to find context '${chunk.changeContext}' in ${path}`,
        );
      }
      lineIndex = found + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, [...chunk.newLines]]);
      continue;
    }
    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    if (found === null && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (found === null) {
      throw new ApplyPatchError(
        "apply",
        `Failed to find expected lines in ${path}:\n${
          chunk.oldLines.join("\n")
        }`,
      );
    }
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= newSlice.length) break;
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([
          found + oldStart,
          oldContext - oldStart,
          newSlice.slice(newStart, newContext),
        ]);
      }
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) {
      replacements.push([
        found + oldStart,
        pattern.length - oldStart,
        newSlice.slice(newStart),
      ]);
    }
    lineIndex = found + pattern.length;
  }
  // A stable sort, as Rust's sort_by_key.
  return replacements.map((replacement, order) => ({ replacement, order }))
    .sort((a, b) => a.replacement[0] - b.replacement[0] || a.order - b.order)
    .map(({ replacement }) => replacement);
}

/**
 * The new contents of a file after an update's chunks, keeping each
 * unchanged line's ending and giving inserted lines the file's first
 * ending (LF for a file with none). Every line ends up terminated.
 *
 * @throws {ApplyPatchError} `apply` when a context or old lines are not found.
 */
export function applyChunks(
  contents: string,
  path: string,
  chunks: readonly UpdateChunk[],
): string {
  const source = parseSource(contents);
  const replacements = computeReplacements(
    source.lines.map((line) => line.text),
    path,
    chunks,
  );
  const out: SourceLine[] = [];
  let sourceIndex = 0;
  for (const [start, oldLength, newLines] of replacements) {
    if (start < sourceIndex) {
      throw new ApplyPatchError("apply", `Overlapping changes in ${path}`);
    }
    out.push(...source.lines.slice(sourceIndex, start));
    out.push(...newLines.map((text) => ({ text, ending: source.preferred })));
    sourceIndex = start + oldLength;
  }
  out.push(...source.lines.slice(sourceIndex));
  return out.map((line) => line.text + (line.ending ?? source.preferred)).join(
    "",
  );
}

/** What a successful patch changed, by the paths the patch named. */
export interface AppliedPatch {
  readonly added: string[];
  readonly modified: string[];
  readonly deleted: string[];
  /** Codex's summary: `Success. Updated the following files:` then `A/M/D path`. */
  readonly summary: string;
}

function resolve(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.ok) throw new ApplyPatchError("apply", normalized.message);
  if (normalized.path === "") {
    throw new ApplyPatchError("apply", `not a file path: ${path}`);
  }
  return normalized.path;
}

/**
 * Parses and applies a patch to `fs`, all or nothing.
 *
 * @throws {ApplyPatchError} `parse` or `apply`; nothing is written then.
 */
export async function applyPatch(
  fs: FileSystem,
  patch: string,
): Promise<AppliedPatch> {
  const { hunks } = parsePatch(patch);
  if (hunks.length === 0) {
    throw new ApplyPatchError("apply", "No files were modified.");
  }
  // Planned state: path -> new content, or null for deleted.
  const planned = new Map<string, string | null>();
  const read = async (path: string) =>
    planned.has(path) ? planned.get(path)! : await fs.read(path);
  const kind = async (path: string) => {
    if (planned.has(path)) return planned.get(path) === null ? null : "file";
    for (const [planPath, content] of planned) {
      if (content !== null && planPath.startsWith(`${path}/`)) return "dir";
    }
    return await fs.kind(path);
  };
  const operations: ({ op: "write"; path: string; content: string } | {
    op: "remove";
    path: string;
  })[] = [];
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const hunk of hunks) {
    const path = resolve(hunk.path);
    switch (hunk.type) {
      case "add": {
        if (await kind(path) === "dir") {
          throw new ApplyPatchError(
            "apply",
            `Failed to write file ${hunk.path}: it is a directory`,
          );
        }
        planned.set(path, hunk.contents);
        operations.push({ op: "write", path, content: hunk.contents });
        added.push(hunk.path);
        break;
      }
      case "delete": {
        if (await kind(path) !== "file") {
          throw new ApplyPatchError(
            "apply",
            `Failed to delete file ${hunk.path}`,
          );
        }
        planned.set(path, null);
        operations.push({ op: "remove", path });
        deleted.push(hunk.path);
        break;
      }
      case "update": {
        const original = await kind(path) === "file" ? await read(path) : null;
        if (original === null) {
          throw new ApplyPatchError(
            "apply",
            `Failed to read file to update ${hunk.path}: no such file`,
          );
        }
        const updated = applyChunks(original, hunk.path, hunk.chunks);
        if (hunk.movePath === null) {
          planned.set(path, updated);
          operations.push({ op: "write", path, content: updated });
          modified.push(hunk.path);
          break;
        }
        const destination = resolve(hunk.movePath);
        if (await kind(destination) === "dir") {
          throw new ApplyPatchError(
            "apply",
            `Failed to write file ${hunk.movePath}: it is a directory`,
          );
        }
        planned.set(destination, updated);
        operations.push({ op: "write", path: destination, content: updated });
        if (destination !== path) {
          planned.set(path, null);
          operations.push({ op: "remove", path });
        }
        modified.push(hunk.movePath);
        break;
      }
    }
  }
  for (const operation of operations) {
    if (operation.op === "write") {
      await fs.write(operation.path, operation.content);
    } else await fs.remove(operation.path);
  }
  const summary = [
    "Success. Updated the following files:",
    ...added.map((path) => `A ${path}`),
    ...modified.map((path) => `M ${path}`),
    ...deleted.map((path) => `D ${path}`),
  ].join("\n") + "\n";
  return { added, modified, deleted, summary };
}
