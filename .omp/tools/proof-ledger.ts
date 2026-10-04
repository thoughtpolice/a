// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified TypeScript reimplementation of Anthropic's Apache-2.0 math-proof
// skills/siege/scripts/ledger.py, claude-plugins-official revision ab024cdc.
// This checks bookkeeping attestations, not mathematical validity.

import { Buffer } from "node:buffer";
import { lstat, readdir, rename, unlink } from "node:fs/promises";
import {
  readWorkspaceFile,
  workspacePath,
  writeWorkspaceFile,
} from "../lib/files.ts";
import { result, type Tool, type ToolAPI } from "../lib/tool.ts";

const MAX_ATTEMPTS = 3;
const STEM = /^[A-Za-z0-9_]+$/;
const STATUSES: Record<string, true> = {
  OPEN: true,
  PROVED: true,
  REFUTED: true,
  RETRACT: true,
  RETRACTED: true,
  SKETCHED: true,
};
const queues = new Map<string, Promise<void>>();

export type LedgerWriteParams =
  | { operation: "append"; directory: string; round: number }
  | { operation: "answers"; directory: string; stems: string[] }
  | {
    operation: "check";
    directory: string;
    round: number;
    wave: number;
    minRounds: number;
    attempt?: number;
  };
export interface GateParams {
  directory: string;
  round?: number;
}
export type LedgerRequest =
  | LedgerWriteParams
  | (GateParams & { operation: "gate" });
export interface LedgerOutcome {
  verdict:
    | "APPENDED"
    | "CONCLUDE"
    | "REJECT"
    | "ANSWERS"
    | "WAVE"
    | "RETRY"
    | "TAIL"
    | "ERROR";
  reason?: string;
  round?: number;
  appended?: number;
  attempt?: number;
  queries?: string[];
  floor?: number;
  answers?: { stem: string; status: "answered" | "partial" | "no answer" }[];
  totals?: { answered: number; partial: number; noAnswer: number };
}
interface Entry {
  id: number;
  status: string;
  text: string;
  tags: Set<string>;
  retractedBy?: number;
}
interface Part {
  round: number;
  name: string;
  text: string;
}
interface PlanState {
  round: number;
  attempts: number;
  wave: number;
  minRounds: number;
  terminal?: LedgerOutcome;
}
interface Move {
  from: string;
  to: string;
}

function positive(value: number, name: string, zero = false): void {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) {
    throw new Error(
      `${name} must be a ${zero ? "nonnegative" : "positive"} safe integer`,
    );
  }
}
function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error &&
    error.code === "ENOENT";
}
async function optionalFile(
  directory: string,
  name: string,
): Promise<Buffer | undefined> {
  try {
    return (await readWorkspaceFile(directory, name)).bytes;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function outputPath(directory: string, name: string): Promise<string> {
  const path = await workspacePath(directory, name);
  try {
    if (!(await lstat(path)).isFile()) {
      throw new Error(`Output ${name} is not a regular file`);
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return path;
}
function text(bytes: Buffer | undefined): string {
  return bytes?.toString("utf8") ?? "";
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function takeTags(input: string, tags: Set<string>): string {
  let rest = input;
  for (;;) {
    const match = /^[*_\s]*\[([A-Za-z]{1,16})\]\s*[:\-–—]?\s*/.exec(rest);
    if (!match || Object.hasOwn(STATUSES, match[1].toUpperCase())) return rest;
    tags.add(match[1].toUpperCase());
    rest = rest.slice(match[0].length);
  }
}
export function citedIds(input: string): Set<number> {
  const ids = new Set<number>();
  for (const match of input.matchAll(/#(\d+)\b(?![./]\d)/g)) {
    ids.add(Number(match[1]));
  }
  const words =
    /\b(?:entry|entries|claim|claims|item|items|id|ids|no\.|number)\s+#?L?(\d+)\b(?![./]\d)|\b(?:line|lines)\s+#?(\d+)\b(?![./]\d)/gi;
  for (const match of input.matchAll(words)) {
    ids.add(Number(match[1] ?? match[2]));
  }
  return ids;
}
function parseLedger(input: string): Map<number, Entry> {
  const entries = new Map<number, Entry>();
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*([1-9]\d*)\.\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) !== entries.size + 1) {
      throw new Error(
        "Ledger entries must have unique consecutive numbers starting at 1",
      );
    }
    let rest = match[2].replace(
      /^[*_\s]*(?:\(\s*(?:L|#)?\s*\d+\s*\)\s*[.:\-–—]?|(?:L|#)\s*\d+\s*[.:)\-–—])\s*/,
      "",
    );
    const tags = new Set<string>();
    rest = takeTags(rest, tags);
    const statusMatch = /^[*_\s\[]*([A-Za-z]+)[*_\]]*\s*[:.\-–—]?\s*(.*)$/.exec(
      rest,
    );
    if (
      !statusMatch || !Object.hasOwn(STATUSES, statusMatch[1].toUpperCase())
    ) throw new Error(`Entry ${match[1]} has an unknown or missing status`);
    const status = statusMatch[1].toUpperCase().replace("RETRACTED", "RETRACT");
    const body = takeTags(statusMatch[2], tags).trim();
    if (!body) {
      throw new Error(`Entry ${match[1]} has no claim or retraction reason`);
    }
    entries.set(Number(match[1]), {
      id: Number(match[1]),
      status,
      text: body,
      tags,
    });
  }
  for (const entry of entries.values()) {
    if (entry.status !== "RETRACT") continue;
    const targetMatch =
      /^[*_\s]*(?:entry|claim|item|line|no\.?|number)?\s*[#(]?\s*L?\s*(\d+)\s*[:)\-–—]?\s*(.*)$/i
        .exec(entry.text);
    const target = targetMatch
      ? entries.get(Number(targetMatch[1]))
      : undefined;
    if (
      !target || target.id >= entry.id || target.status === "RETRACT" ||
      !targetMatch?.[2].trim()
    ) {
      throw new Error(
        `Entry ${entry.id} must retract an earlier claim and give a reason`,
      );
    }
    target.retractedBy = entry.id;
  }
  return entries;
}
async function parts(directory: string): Promise<Part[]> {
  const found: Part[] = [];
  for (const name of await readdir(directory)) {
    const match = /^round(\d+)_ledger\.md$/.exec(name);
    if (!match) continue;
    const round = Number(match[1]);
    positive(round, "Persisted round");
    if (name !== `round${round}_ledger.md`) {
      throw new Error("Noncanonical round filename");
    }
    found.push({
      round,
      name,
      text: text(await optionalFile(directory, name)),
    });
  }
  found.sort((a, b) => a.round - b.round);
  parseLedger(found.map((part) => part.text).join(""));
  return found;
}
function priorText(all: Part[], round: number): string {
  return all.filter((part) => part.round < round).map((part) => part.text).join(
    "",
  );
}
function numberBlock(prior: string, block: string): string {
  let count = parseLedger(prior).size;
  const lines: string[] = [];
  for (const raw of block.split(/\r?\n/)) {
    let line = raw.trim().replace(/^(?:[-*]|\d+\.)\s+/, "");
    line = line.replace(
      /^(?:\((?:L|#)?\d+\)(?:[.:]\s*|\s+)|(?:L|#)\d+[.:]\s+)(?=\S)/,
      "",
    );
    if (line) lines.push(`${++count}. ${line}\n`);
  }
  const numbered = lines.join("");
  parseLedger(prior + numbered);
  return numbered;
}
async function pending(
  directory: string,
  all: Part[],
  round: number,
): Promise<string> {
  return numberBlock(
    priorText(all, round),
    text(await optionalFile(directory, `round${round}_ledger_block.md`)),
  );
}
async function prepareAppend(
  directory: string,
  all: Part[],
  round: number,
  numbered: string,
): Promise<{ writes: Map<string, string>; count: number }> {
  const existing = all.find((part) => part.round === round);
  if (existing && existing.text !== numbered) {
    throw new Error(
      "A committed round is immutable; record changes in a later round",
    );
  }
  if (!existing && all.some((part) => part.round > round)) {
    throw new Error(
      "Cannot insert an earlier round after later rounds are committed",
    );
  }
  const assembled = [...all.filter((part) => part.round !== round), {
    round,
    name: `round${round}_ledger.md`,
    text: numbered,
  }]
    .sort((a, b) => a.round - b.round).map((part) => part.text).join("");
  parseLedger(assembled);
  const writes = new Map<string, string>();
  if (!existing) writes.set(`round${round}_ledger.md`, numbered);
  if (text(await optionalFile(directory, "ledger.md")) !== assembled) {
    writes.set("ledger.md", assembled);
  }
  for (const name of writes.keys()) await outputPath(directory, name);
  return { writes, count: numbered.split("\n").filter(Boolean).length };
}
async function publish(
  directory: string,
  writes: Map<string, string>,
): Promise<void> {
  for (const [name, content] of writes) {
    await writeWorkspaceFile(directory, name, content, true);
  }
}

export function isAnswerEndLine(line: string, stem: string): boolean {
  if (!STEM.test(stem) || /\[[ xX]\]/.test(line)) return false;
  const normalized = line.replace(/\\_/g, "_").replace(
    /[^A-Za-z0-9_./ -]+/g,
    " ",
  ).replace(/\s+/g, " ").trim().replace(/^[- ]+/, "").replace(/^\d{1,2}\. /, "")
    .replace(/^(_+)END OF ANSWER (.*)\1$/i, "END OF ANSWER $2");
  return new RegExp(
    `^END OF ANSWER (?:[A-Za-z0-9_./-]*/)?${
      escapeRegExp(stem)
    }(?:\\.answer\\.md|\\.md)?(?: ?\\.)?[- ]*$`,
    "i",
  ).test(normalized);
}
export function isFinishedAnswer(input: string, stem: string): boolean {
  const lines = input.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (
      !/[A-Za-z0-9]/.test(line) ||
      /^(?:\s*<\/?[A-Za-z_][\w:.-]*\s*\/?>)+\s*$/.test(line)
    ) continue;
    return isAnswerEndLine(line, stem);
  }
  return false;
}
async function finishedLocators(directory: string): Promise<Set<string>> {
  const locators = new Set<string>();
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".answer.md")) continue;
    const stem = name.slice(0, -".answer.md".length);
    if (!STEM.test(stem)) throw new Error("Malformed answer filename");
    if (isFinishedAnswer(text(await optionalFile(directory, name)), stem)) {
      locators.add(stem.toLowerCase());
    }
  }
  return locators;
}
function locator(entry: Entry, known: Set<string>): string | undefined {
  const match = /(?:—|–|\s-\s)\s*([A-Za-z0-9_]+)(?:\.answer\.md)?\.?\s*$/.exec(
    entry.text,
  );
  const stem = match?.[1].toLowerCase();
  return stem && known.has(stem) ? stem : undefined;
}
function gateReason(input: string, known: Set<string>): string | undefined {
  const entries = parseLedger(input);
  const live = [...entries.values()].filter((entry) =>
    entry.retractedBy === undefined && entry.status !== "RETRACT"
  );
  const goals = live.filter((entry) => entry.tags.has("GOAL"));
  const goal = goals[goals.length - 1];
  if (!goal) return "No live [GOAL] entry";
  if (goal.status !== "PROVED" && goal.status !== "REFUTED") {
    return `Newest goal entry ${goal.id} is unsettled`;
  }
  const chain = new Set<number>();
  const visiting = new Set<number>();
  function visit(id: number): string | undefined {
    if (visiting.has(id)) return `Circular support at entry ${id}`;
    if (chain.has(id)) return undefined;
    const entry = entries.get(id);
    if (
      !entry || entry.retractedBy !== undefined || entry.status === "RETRACT"
    ) return `Support entry ${id} is missing or retracted`;
    if (
      id !== goal?.id && (entry.status !== "PROVED" || entry.tags.has("AUDIT"))
    ) return `Support entry ${id} is not a proved claim`;
    if (!locator(entry, known)) {
      return `Entry ${id} has no completed answer locator`;
    }
    visiting.add(id);
    for (const support of citedIds(entry.text)) {
      const reason = visit(support);
      if (reason) return reason;
    }
    visiting.delete(id);
    chain.add(id);
    return undefined;
  }
  const badChain = visit(goal.id);
  if (badChain) return badChain;
  for (const entry of live) {
    if (!entry.tags.has("CRITICAL")) continue;
    if (!chain.has(entry.id)) {
      return `Critical obligation ${entry.id} is not accounted for by the goal's support chain`;
    }
  }
  const audits: { cites: Set<number>; locator: string }[] = [];
  const seen = new Set<string>();
  for (const entry of live) {
    if (
      entry.status !== "PROVED" || !entry.tags.has("AUDIT") ||
      entry.tags.has("GOAL") || chain.has(entry.id)
    ) continue;
    const cites = citedIds(entry.text);
    if (!cites.size || [...cites].some((id) => !chain.has(id))) continue;
    const source = locator(entry, known);
    if (!source) continue;
    const normalized = entry.text.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    audits.push({ cites, locator: source });
  }
  if (
    audits.length < 2 ||
    new Set(audits.map((audit) => audit.locator)).size < 2 ||
    !audits.some((audit) => audit.cites.has(goal.id))
  ) {
    return `Need two distinct completed-query [AUDIT] certifications of the live support chain, at least one citing goal entry ${goal.id}`;
  }
  return undefined;
}

function normalizeStem(input: string): string {
  if (
    typeof input !== "string" || input.includes("/") || input.includes("\\") ||
    input.includes("\0")
  ) throw new Error("Stems must be filenames, not paths");
  const stem = input.replace(/\.(?:answer|partial|noanswer)\.md$|\.md$/, "");
  if (!STEM.test(stem)) {
    throw new Error("A query stem uses only letters, digits and underscores");
  }
  return stem;
}
async function classifyAnswers(
  directory: string,
  inputs: string[],
): Promise<LedgerOutcome> {
  if (!Array.isArray(inputs) || !inputs.length) {
    throw new Error("Provide at least one query stem");
  }
  const stems = [...new Set(inputs.map(normalizeStem))];
  const changes: {
    stem: string;
    answer?: Buffer;
    partial?: Buffer;
    noAnswer?: Buffer;
  }[] = [];
  for (const stem of stems) {
    const query = await optionalFile(directory, `${stem}.md`);
    const answer = await optionalFile(directory, `${stem}.answer.md`);
    const partial = await optionalFile(directory, `${stem}.partial.md`);
    await optionalFile(directory, `${stem}.partial.prev.md`);
    const noAnswer = await optionalFile(directory, `${stem}.noanswer.md`);
    if (text(noAnswer).trim()) {
      throw new Error(`No-answer marker for ${stem} must be empty`);
    }
    if (!query && !answer && !partial && !noAnswer) {
      throw new Error(`No query or answer artifact exists for ${stem}`);
    }
    changes.push({ stem, answer, partial, noAnswer });
    for (
      const suffix of [
        ".answer.md",
        ".partial.md",
        ".partial.prev.md",
        ".noanswer.md",
      ]
    ) await outputPath(directory, stem + suffix);
  }
  const rows: NonNullable<LedgerOutcome["answers"]> = [];
  const totals = { answered: 0, partial: 0, noAnswer: 0 };
  for (const change of changes) {
    const { stem, answer, partial, noAnswer } = change;
    let status: "answered" | "partial" | "no answer";
    if (answer && isFinishedAnswer(text(answer), stem)) status = "answered";
    else {
      let retained = partial;
      if (answer) {
        if (!text(answer).trim()) {
          if (!noAnswer) {
            await writeWorkspaceFile(directory, `${stem}.noanswer.md`, "");
          }
          await unlink(await workspacePath(directory, `${stem}.answer.md`));
        } else if (
          partial && text(partial).trim() && partial.length > answer.length
        ) {
          await rename(
            await workspacePath(directory, `${stem}.answer.md`),
            await workspacePath(directory, `${stem}.partial.prev.md`),
          );
        } else {
          if (partial && text(partial).trim()) {
            await rename(
              await workspacePath(directory, `${stem}.partial.md`),
              await workspacePath(directory, `${stem}.partial.prev.md`),
            );
          }
          await rename(
            await workspacePath(directory, `${stem}.answer.md`),
            await workspacePath(directory, `${stem}.partial.md`),
          );
          retained = answer;
        }
      }
      status = text(retained).trim() ? "partial" : "no answer";
    }
    rows.push({ stem, status });
    if (status === "no answer") totals.noAnswer++;
    else totals[status]++;
  }
  return { verdict: "ANSWERS", answers: rows, totals };
}

function attack(input: string): boolean {
  let seen = 0;
  for (const line of input.split(/\r?\n/)) {
    if (!/[A-Za-z]/.test(line)) continue;
    if (
      /^[*_\s`#>\-]*kind[*_`\s]*[:=][\s"'*_`]*(?:attempt|attack)\b/i.test(line)
    ) return true;
    if (++seen >= 3) return false;
  }
  return false;
}
function readState(
  input: Buffer | undefined,
  round: number,
  wave: number,
  minRounds: number,
): PlanState {
  if (!input) return { round, attempts: 0, wave, minRounds };
  const value: unknown = JSON.parse(text(input));
  if (
    !value || typeof value !== "object" || !("round" in value) ||
    value.round !== round || !("attempts" in value) ||
    typeof value.attempts !== "number" || !Number.isInteger(value.attempts) ||
    value.attempts < 1 || value.attempts > MAX_ATTEMPTS || !("wave" in value) ||
    value.wave !== wave || !("minRounds" in value) ||
    value.minRounds !== minRounds
  ) throw new Error("Invalid persisted plan state or changed round settings");
  let terminal: LedgerOutcome | undefined;
  if ("terminal" in value) {
    const candidate = value.terminal;
    if (
      !candidate || typeof candidate !== "object" ||
      !("verdict" in candidate) ||
      !["WAVE", "CONCLUDE", "TAIL"].includes(String(candidate.verdict)) ||
      !("round" in candidate) || candidate.round !== round ||
      !("attempt" in candidate) || candidate.attempt !== value.attempts ||
      !("reason" in candidate) || typeof candidate.reason !== "string"
    ) throw new Error("Invalid persisted terminal verdict");
    if (candidate.verdict === "WAVE") {
      if (
        !("queries" in candidate) || !Array.isArray(candidate.queries) ||
        !candidate.queries.length || candidate.queries.length > wave ||
        !candidate.queries.every((stem: unknown, index: number) =>
          stem === `round${round}_q${index + 1}`
        ) || !("floor" in candidate) ||
        candidate.floor !==
          Math.max(1, Math.floor(3 * candidate.queries.length / 10))
      ) throw new Error("Invalid persisted wave verdict");
    }
    terminal = candidate as LedgerOutcome;
  }
  if (value.attempts === MAX_ATTEMPTS && !terminal) {
    throw new Error("Exhausted plan state has no terminal verdict");
  }
  return { round, attempts: value.attempts, wave, minRounds, terminal };
}
async function checkPlan(
  directory: string,
  request: Extract<LedgerWriteParams, { operation: "check" }>,
): Promise<LedgerOutcome> {
  const { round, wave, minRounds } = request;
  const stateName = `judge/plan_r${round}_state.json`;
  const state = readState(
    await optionalFile(directory, stateName),
    round,
    wave,
    minRounds,
  );
  if (state.terminal) return state.terminal;
  await outputPath(directory, stateName);
  const attempt = Math.min(
    MAX_ATTEMPTS,
    Math.max(request.attempt ?? 1, state.attempts + 1),
  );
  const final = attempt === MAX_ATTEMPTS;
  const all = await parts(directory);
  const numbered = await pending(directory, all, round);
  const appendPlan = await prepareAppend(directory, all, round, numbered);
  const summary = text(
    await optionalFile(directory, `round${round}_summary.md`),
  );
  const doneName = `round${round}_DONE.md`;
  const done = await optionalFile(directory, doneName);
  const queries: { name: string; index: number; text: string }[] = [];
  for (const name of await readdir(directory)) {
    const match = new RegExp(`^round${round}_q(\\d+)\\.md$`).exec(name);
    if (!match) continue;
    const index = Number(match[1]);
    positive(index, "Query number");
    if (name !== `round${round}_q${index}.md`) {
      throw new Error("Noncanonical query filename");
    }
    queries.push({
      name,
      index,
      text: text(await optionalFile(directory, name)),
    });
  }
  queries.sort((a, b) => a.index - b.index);
  const moves: Move[] = [];
  const active = queries.filter((query) => {
    if (
      !query.text.trim() ||
      /^[([]?\s*withdrawn\s*[)\]]?\.?$/i.test(query.text.trim())
    ) {
      moves.push({
        from: query.name,
        to: query.name.replace(/\.md$/, ".withdrawn.md"),
      });
      return false;
    }
    return true;
  });
  for (const [index, query] of active.entries()) {
    const canonical = `round${round}_q${index + 1}.md`;
    if (query.name !== canonical) {
      for (const stem of [query.name.slice(0, -3), canonical.slice(0, -3)]) {
        if (
          await optionalFile(directory, `${stem}.answer.md`) ||
          await optionalFile(directory, `${stem}.partial.md`) ||
          await optionalFile(directory, `${stem}.noanswer.md`)
        ) {
          throw new Error(
            "Cannot renumber a query that already has answer artifacts",
          );
        }
      }
      moves.push({ from: query.name, to: canonical });
    }
    query.name = canonical;
    if (index >= wave) {
      moves.push({
        from: canonical,
        to: canonical.replace(/\.md$/, ".overcount.md"),
      });
    }
  }
  if (active.length && done) {
    moves.push({ from: doneName, to: `round${round}_DONE.superseded.md` });
  }
  const selected = active.slice(0, wave);
  let outcome: LedgerOutcome;
  function correction(reason: string): LedgerOutcome {
    return { verdict: final ? "TAIL" : "RETRY", round, attempt, reason };
  }
  if (!summary.trim()) {
    outcome = correction(
      `Write a nonempty round${round}_summary.md before planning a wave or conclusion`,
    );
  } else if (selected.length) {
    const required = Math.ceil(selected.length / 2);
    const attempts = selected.filter((query) => attack(query.text)).length;
    outcome = attempts < required
      ? correction(
        `Only ${attempts}/${selected.length} queries are marked kind: attempt; at least ${required} must attack flagged open obligations`,
      )
      : {
        verdict: "WAVE",
        round,
        attempt,
        reason: `${attempts}/${selected.length} attempt queries${
          active.length > wave ? "; overcount set aside" : ""
        }`,
        queries: selected.map((query) => query.name.slice(0, -3)),
        floor: Math.max(1, Math.floor(3 * selected.length / 10)),
      };
  } else if (text(done).trim()) {
    const reason = gateReason(
      priorText(all, round) + numbered,
      await finishedLocators(directory),
    );
    outcome = reason ? correction(reason) : {
      verdict: "CONCLUDE",
      round,
      attempt,
      reason: round < minRounds
        ? "Audited support chain accepted before minimum round"
        : "Audited support chain accepted",
    };
    if (reason && !final) {
      moves.push({
        from: doneName,
        to: `round${round}_DONE.rejected${attempt}.md`,
      });
    }
  } else {outcome = correction(
      `Write either round${round}_DONE.md or 1 to ${wave} self-contained query files`,
    );}
  // Validate every destination before the first mutation, including archive collisions.
  const sources = new Set(moves.map((move) => move.from));
  for (const move of moves) {
    await outputPath(directory, move.from);
    await outputPath(directory, move.to);
    if (!sources.has(move.to) && await optionalFile(directory, move.to)) {
      throw new Error(
        `Archive ${move.to} already exists; preserve it under another name first`,
      );
    }
  }
  const terminal = outcome.verdict !== "RETRY";
  const commit = terminal && !!summary.trim();
  if (commit) outcome.appended = appendPlan.count;
  const next: PlanState = {
    round,
    attempts: attempt,
    wave,
    minRounds,
    ...(terminal ? { terminal: outcome } : {}),
  };
  // Planning is a single-writer operation, called only after all workers stop writing.
  for (const move of moves) {
    await rename(
      await workspacePath(directory, move.from),
      await workspacePath(directory, move.to),
    );
  }
  if (commit) await publish(directory, appendPlan.writes);
  await writeWorkspaceFile(
    directory,
    stateName,
    JSON.stringify(next, null, 2) + "\n",
    true,
  );
  return outcome;
}

async function perform(
  cwd: string,
  request: LedgerRequest,
  signal?: AbortSignal,
): Promise<LedgerOutcome> {
  signal?.throwIfAborted();
  if (
    !request ||
    !["append", "gate", "answers", "check"].includes(request.operation)
  ) throw new Error("Unknown ledger operation");
  if (
    request.operation === "append" || request.operation === "check" ||
    (request.operation === "gate" && request.round !== undefined)
  ) positive(request.round ?? 0, "Round");
  if (request.operation === "check") {
    positive(request.wave, "Wave cap");
    positive(request.minRounds, "Minimum round", true);
    positive(request.attempt ?? 1, "Attempt");
    if ((request.attempt ?? 1) > MAX_ATTEMPTS) {
      throw new Error("Attempt exceeds the persisted three-attempt bound");
    }
  }
  const directory = await workspacePath(cwd, request.directory);
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error("Run directory must already exist");
  }
  if (request.operation === "answers") {
    return await classifyAnswers(directory, request.stems);
  }
  if (request.operation === "check") return await checkPlan(directory, request);
  const all = await parts(directory);
  if (request.operation === "append") {
    const plan = await prepareAppend(
      directory,
      all,
      request.round,
      await pending(directory, all, request.round),
    );
    await publish(directory, plan.writes);
    return { verdict: "APPENDED", round: request.round, appended: plan.count };
  }
  const assembled = request.round === undefined
    ? all.map((part) => part.text).join("")
    : priorText(all, request.round) +
      await pending(directory, all, request.round);
  const reason = gateReason(assembled, await finishedLocators(directory));
  return reason ? { verdict: "REJECT", reason } : { verdict: "CONCLUDE" };
}
export async function proofLedger(
  cwd: string,
  request: LedgerRequest,
  signal?: AbortSignal,
): Promise<LedgerOutcome> {
  // Serialize callers sharing a run directory; persisted counters also survive restart.
  let key: string;
  try {
    key = await workspacePath(cwd, request.directory);
  } catch (error) {
    return {
      verdict: "ERROR",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const previous = queues.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(key, current);
  await previous;
  try {
    return await perform(cwd, request, signal);
  } catch (error) {
    return {
      verdict: "ERROR",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

export default function proofLedgerTools(
  pi: ToolAPI,
): [Tool<LedgerWriteParams>, Tool<GateParams>] {
  const T = pi.typebox.Type;
  const directory = T.String({
    description: "Existing run directory within the workspace; no symlinks",
  });
  const round = T.Integer({ minimum: 1 });
  return [
    {
      name: "proof_ledger",
      label: "Proof ledger bookkeeping",
      approval: "write",
      description:
        "Append immutable numbered rounds, preserve incomplete answers, or check a plan with a persisted three-attempt bound. Bookkeeping only: never certifies a proof's validity.",
      parameters: T.Union([
        T.Object({ operation: T.Literal("append"), directory, round }, {
          additionalProperties: false,
        }),
        T.Object({
          operation: T.Literal("answers"),
          directory,
          stems: T.Array(T.String(), { minItems: 1 }),
        }, { additionalProperties: false }),
        T.Object({
          operation: T.Literal("check"),
          directory,
          round,
          wave: T.Integer({ minimum: 1 }),
          minRounds: T.Integer({ minimum: 0 }),
          attempt: T.Optional(T.Integer({ minimum: 1, maximum: MAX_ATTEMPTS })),
        }, { additionalProperties: false }),
      ]),
      execute: async (_id, params, _onUpdate, _ctx, signal) =>
        result(await proofLedger(pi.cwd, params, signal)),
    },
    {
      name: "proof_ledger_gate",
      label: "Inspect proof ledger conclusion gate",
      approval: "read",
      description:
        "Read the assembled ledger or a pending round. Require a settled live goal, acyclic settled support, completed answer locators, and two distinct audit-query attestations. Not a proof-validity checker.",
      parameters: T.Object({ directory, round: T.Optional(round) }, {
        additionalProperties: false,
      }),
      execute: async (_id, params, _onUpdate, _ctx, signal) =>
        result(
          await proofLedger(pi.cwd, { operation: "gate", ...params }, signal),
        ),
    },
  ];
}
