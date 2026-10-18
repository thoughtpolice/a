// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic claude-plugins-official session-report and
// receipts (Apache-2.0), pinned ab024cdc. Journal mapping is an independent OMP
// implementation; Claude request IDs, model weights, telemetry and Git are absent.

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  decodeUtf8,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../lib/files.ts";
import { result, type Tool, type ToolAPI } from "../lib/tool.ts";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
const time = (value: unknown): number | null => {
  const n = typeof value === "string" ? Date.parse(value) : count(value);
  return n !== null && Number.isFinite(n) ? n : null;
};
const iso = (value: number): string => new Date(value).toISOString();
const day = (value: number): string => iso(value).slice(0, 10);
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_ENTRIES = 200_000;

export interface Selection {
  inputRoot: string;
  files: string[];
  since: string;
  until: string;
  includePaths?: boolean;
  includePrompts?: boolean;
  includeCacheBreaks?: boolean;
  cacheBreakThreshold?: number;
  html?: string;
  csv?: string;
  overwrite?: boolean;
}
export interface HistoryScope {
  root: string;
  revisions: string;
  label?: string;
  authorEmail?: string;
}
export interface ReceiptSelection extends Selection {
  history: HistoryScope[];
  maxCommits?: number;
}
export interface Journal {
  source: string;
  header: RecordValue;
  entries: RecordValue[];
}
interface Fact {
  journal: Journal;
  entry: RecordValue;
  identity: string;
  lineage: string;
  session: string;
  timestamp: number | null;
}
export interface Meter {
  value: number | null;
  observedSum: number;
  observedRecords: number;
  missingRecords: number;
}
export interface UsageMetrics {
  records: number;
  input: Meter;
  output: Meter;
  cacheRead: Meter;
  cacheWrite: Meter;
  totalTokens: Meter;
  orchestrationInput: Meter;
  orchestrationOutput: Meter;
  orchestrationCacheRead: Meter;
  recordedCost: Meter;
}
export interface FileActivity {
  session: string;
  timestamp: number;
  path: string;
  kind: "read" | "write" | "edit";
  linesChanged: number | null;
}
export interface Insights {
  kind: "session-report";
  window: {
    since: string;
    until: string;
    timezone: "UTC";
    calendarDays: number;
  };
  provenance: {
    files: number;
    entries: number;
    deduplicatedEntries: number;
    undatedEntries: number;
    identityGaps: number;
    malformedLines: number;
  };
  totals: {
    sessions: number;
    prompts: number;
    activeDays: number;
    assistantMessages: number;
    supplementalUsageRecords: number;
    usage: UsageMetrics;
    wallMs: number | null;
    activeMs: number | null;
    timedIntervals: number;
    timingGaps: number;
  };
  sessions: {
    id: string;
    prompts: number;
    assistantMessages: number;
    first: string;
    last: string;
    wallMs: number;
    activeMs: number | null;
    usage: UsageMetrics;
    agent: string | null;
  }[];
  days: {
    date: string;
    sessions: number;
    prompts: number;
    usage: UsageMetrics;
    activeMs: number | null;
  }[];
  tools: {
    name: string;
    attempted: number;
    succeeded: number;
    failed: number;
    unknown: number;
  }[];
  models: {
    provider: string | null;
    model: string | null;
    usage: UsageMetrics;
  }[];
  tasks: {
    session: string;
    child: string;
    agent: string | null;
    durationMs: number | null;
    task?: string;
  }[];
  skills: { name: string; successfulReads: number }[];
  requests: {
    entry: string;
    session: string;
    timestamp: string;
    prompt: string | null;
    provider: string | null;
    model: string | null;
    purpose: string | null;
    usage: UsageMetrics;
  }[];
  requestContextOmitted: number;
  topPrompts?: { id: string; text: string; usage: UsageMetrics }[];
  cacheBreakEvidence?: {
    entry: string;
    session: string;
    timestamp: string;
    uncachedInput: number;
    cacheRead: number | null;
    precedingUncachedInput: number | null;
    modelChanged: boolean | null;
  }[];
  caveats: string[];
}
const caveats = [
  "Selected local journals only; missing journals and branches outside this selection are not inferred.",
  "All recorded branches count as activity; parent links identify prompt context, not proof of causation. Resume/fork replays deduplicate within linked session lineages, not across unrelated sessions.",
  "Usage records are persisted assistant messages plus model_usage entries, not invented provider request IDs. Task-result rollups are excluded to avoid counting child usage twice.",
  "Missing usage is unknown, not zero. Recorded cost is journal metadata, not a verified bill; zero may be unpriced, repaired or reset inherited cost. No provider/model weighting or savings estimates.",
  "Wall time is the per-session envelope of selected activity timestamps and clipped runtime endpoints, including runtime-only sessions. Active time is the union of overlapping explicit model/tool runtime intervals, not human effort or idle-gap guesses; timing gaps describe selected events only.",
  "UTC dates and half-open [since, until) windows apply to activity and history. Usage is assigned to its recorded event timestamp, not split across days. Sessions and day memberships are not additive.",
  "Skill evidence is a successful skill:// read, not proof of invocation. Task facts come from task result details; child journals must be explicitly selected to include their usage.",
  "No prompt text, filesystem paths, session titles or task text appear unless explicitly requested. Labels and journal content are untrusted data. Exports remain local and are not published.",
];

function windowFor(
  params: Selection,
): { start: number; end: number; public: Insights["window"] } {
  // Requiring an explicit UTC offset avoids host-local/DST ambiguity.
  const parse = (value: string): number => {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/
        .test(value)
    ) {
      throw new Error(
        "Window endpoints require ISO timestamps with an explicit timezone",
      );
    }
    const parsed = time(value);
    if (parsed === null) throw new Error("Invalid window endpoint");
    const date = value.slice(0, 10);
    if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw new Error("Invalid calendar date");
    }
    return parsed;
  };
  const start = parse(params.since), end = parse(params.until);
  if (end <= start) throw new Error("until must be later than since");
  if (end - start > 36_600 * 86_400_000) {
    throw new Error("Window exceeds the 36600 day analysis limit");
  }
  return {
    start,
    end,
    public: {
      since: iso(start),
      until: iso(end),
      timezone: "UTC",
      calendarDays: Math.floor((end - 1) / 86_400_000) -
        Math.floor(start / 86_400_000) + 1,
    },
  };
}

export function parseJournal(
  source: string,
  input: string,
): { journal: Journal; malformedLines: number } {
  const entries: RecordValue[] = [];
  let header: RecordValue | undefined, malformedLines = 0;
  const rows = input.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(rows[i]);
    } catch {
      // The writer can leave only the final record crash-truncated. Earlier
      // corruption is an error, not silently omitted analytics.
      if (rows.slice(i + 1).some((row) => row.trim())) {
        throw new Error("Malformed journal JSON before the final record");
      }
      malformedLines++;
      continue;
    }
    const entry = object(raw);
    if (!text(entry.type)) {
      throw new Error("Journal record is missing its type");
    }
    if (entry.type === "session") {
      if (header) throw new Error("Journal contains multiple session headers");
      header = entry;
    } else entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      throw new Error("Journal entry limit exceeded");
    }
  }
  if (!header || !text(header.id)) {
    throw new Error("OMP session header with a nonempty id is required");
  }
  return { journal: { source, header, entries }, malformedLines };
}

async function loadJournals(
  params: Selection,
  signal?: AbortSignal,
): Promise<{ journals: Journal[]; malformedLines: number }> {
  windowFor(params);
  if (
    !Array.isArray(params.files) || params.files.length < 1 ||
    params.files.length > 256
  ) throw new Error("Select between 1 and 256 journal files explicitly");
  const journals: Journal[] = [], seen = new Set<string>();
  let total = 0, entries = 0, malformedLines = 0;
  for (const input of params.files) {
    signal?.throwIfAborted();
    if (!/\.jsonl(?:\.gz)?$/.test(input)) {
      throw new Error("Selected inputs must be .jsonl or .jsonl.gz journals");
    }
    const file = await readWorkspaceFile(params.inputRoot, input, MAX_FILE);
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const bytes = input.endsWith(".gz")
      ? gunzipSync(file.bytes, { maxOutputLength: MAX_FILE })
      : file.bytes;
    total += bytes.length;
    if (total > MAX_TOTAL) {
      throw new Error("Selected journals exceed the 64 MiB decoded scan limit");
    }
    const parsed = parseJournal(file.path, decodeUtf8(bytes));
    entries += parsed.journal.entries.length;
    if (entries > MAX_ENTRIES) {
      throw new Error("Selected journals exceed the 200000 entry scan limit");
    }
    journals.push(parsed.journal);
    malformedLines += parsed.malformedLines;
  }
  return { journals, malformedLines };
}

function mineFacts(
  journals: Journal[],
): { facts: Fact[]; duplicates: number; gaps: number } {
  const bySession = new Map<string, Journal>(),
    byPath = new Map<string, Journal>();
  for (const journal of journals) {
    bySession.set(String(journal.header.id), journal);
    byPath.set(resolve(journal.source), journal);
  }
  const parent = (journal: Journal): Journal | undefined => {
    const link = text(journal.header.parentSession);
    return link
      ? bySession.get(link) ?? byPath.get(resolve(link)) ??
        byPath.get(resolve(journal.source, "..", link))
      : undefined;
  };
  const lineage = (journal: Journal): { id: string; depth: number } => {
    let cursor = journal, depth = 0;
    const visited = new Set<Journal>();
    while (parent(cursor)) {
      if (visited.has(cursor)) throw new Error("Cyclic session lineage");
      visited.add(cursor);
      cursor = parent(cursor)!;
      depth++;
    }
    return { id: String(cursor.header.id), depth };
  };
  const ordered = journals.map((journal) => ({
    journal,
    lineage: lineage(journal),
  })).sort((a, b) =>
    a.lineage.depth - b.lineage.depth ||
    a.journal.source.localeCompare(b.journal.source)
  );
  const seen = new Set<string>(), facts: Fact[] = [];
  let duplicates = 0, gaps = 0;
  for (const { journal, lineage: root } of ordered) {
    for (let index = 0; index < journal.entries.length; index++) {
      const entry = journal.entries[index], message = object(entry.message);
      const id = text(entry.id), stamp = text(entry.timestamp);
      // OMP entry IDs are session-local short IDs. Include the linked lineage,
      // original envelope timestamp and record type; never dedupe unrelated roots.
      const identity = id && stamp
        ? `${root.id}\0${id}\0${stamp}\0${String(entry.type)}\0${
          String(message.role ?? "")
        }`
        : `${String(journal.header.id)}\0unidentified\0${
          digest(journal.source)
        }\0${index}`;
      if (!id || !stamp) gaps++;
      if (seen.has(identity)) {
        duplicates++;
        continue;
      }
      seen.add(identity);
      facts.push({
        journal,
        entry,
        identity,
        lineage: root.id,
        session: `session-${digest(String(journal.header.id))}`,
        timestamp: time(entry.timestamp) ?? time(message.timestamp),
      });
    }
  }
  return { facts, duplicates, gaps };
}

const newMeter = (): Meter => ({
  value: null,
  observedSum: 0,
  observedRecords: 0,
  missingRecords: 0,
});
function meterAdd(meter: Meter, value: number | null): void {
  if (value === null) meter.missingRecords++;
  else {
    meter.observedSum += value;
    meter.observedRecords++;
  }
  meter.value = meter.missingRecords === 0 && meter.observedRecords > 0
    ? meter.observedSum
    : null;
}
function newUsage(): UsageMetrics {
  return {
    records: 0,
    input: newMeter(),
    output: newMeter(),
    cacheRead: newMeter(),
    cacheWrite: newMeter(),
    totalTokens: newMeter(),
    orchestrationInput: newMeter(),
    orchestrationOutput: newMeter(),
    orchestrationCacheRead: newMeter(),
    recordedCost: newMeter(),
  };
}
function addUsage(target: UsageMetrics, raw: unknown): void {
  const usage = object(raw), orchestration = object(usage.orchestration);
  target.records++;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    meterAdd(target[key], count(usage[key]));
  }
  // Optional orchestration is zero only when a usage payload exists. Missing
  // whole usage still leaves all counters unknown.
  const hasUsage = Object.keys(usage).length > 0;
  const buckets = [
    count(usage.input),
    count(usage.output),
    count(usage.cacheRead),
    count(usage.cacheWrite),
  ];
  const extra = ["input", "output", "cacheRead"].map((key) =>
    usage.orchestration === undefined && hasUsage
      ? 0
      : count(orchestration[key])
  );
  const all = [...buckets, ...extra];
  meterAdd(
    target.totalTokens,
    count(usage.totalTokens) ??
      (all.every((n) => n !== null)
        ? all.reduce<number>((sum, n) => sum + (n ?? 0), 0)
        : null),
  );
  meterAdd(target.orchestrationInput, extra[0]);
  meterAdd(target.orchestrationOutput, extra[1]);
  meterAdd(target.orchestrationCacheRead, extra[2]);
  meterAdd(target.recordedCost, count(object(usage.cost).total));
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => object(block).type === "text").map((block) =>
    text(object(block).text) ?? ""
  ).join("\n");
}
function unionMs(intervals: [number, number][]): number | null {
  if (!intervals.length) return null;
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  let [start, end] = sorted[0], total = 0;
  for (const [a, b] of sorted.slice(1)) {
    if (a > end) {
      total += end - start;
      start = a;
      end = b;
    } else end = Math.max(end, b);
  }
  return total + end - start;
}
function runtime(message: RecordValue): [number, number] | null {
  let start = time(message.timestamp), end = time(message.completedAt);
  const duration = count(message.duration);
  if (start !== null && end === null && duration !== null) {
    end = start + duration;
  }
  if (start === null && end !== null && duration !== null) {
    start = end - duration;
  }
  return start !== null && end !== null && end >= start ? [start, end] : null;
}

interface Call {
  name: string;
  args: RecordValue;
}
function callIndex(journals: Journal[]): Map<string, Call> {
  const calls = new Map<string, Call>();
  for (const journal of journals) {
    for (const entry of journal.entries) {
      const message = object(entry.message);
      if (
        message.role !== "assistant" || !Array.isArray(message.content)
      ) continue;
      for (const raw of message.content) {
        const block = object(raw), id = text(block.id), name = text(block.name);
        if (block.type !== "toolCall" || !id || !name) continue;
        calls.set(`${String(journal.header.id)}\0${id}`, {
          name,
          args: object(block.arguments),
        });
      }
    }
  }
  return calls;
}
interface EntryContext {
  byId: Map<string, RecordValue>;
  prompts: Map<RecordValue, RecordValue | null>;
}
interface SessionAccumulator {
  row: Insights["sessions"][number];
  times: number[];
  intervals: [number, number][];
}
function promptAncestor(fact: Fact, context: EntryContext): RecordValue | null {
  let cursor: RecordValue | undefined = fact.entry;
  const visited: RecordValue[] = [], seen = new Set<RecordValue>();
  let prompt: RecordValue | null = null;
  while (cursor && !seen.has(cursor)) {
    if (context.prompts.has(cursor)) {
      prompt = context.prompts.get(cursor) ?? null;
      break;
    }
    visited.push(cursor);
    seen.add(cursor);
    const message = object(cursor.message);
    if (message.role === "user" && message.synthetic !== true) {
      prompt = cursor;
      break;
    }
    const id = text(cursor.parentId);
    cursor = id ? context.byId.get(id) : undefined;
  }
  for (const entry of visited) context.prompts.set(entry, prompt);
  return prompt;
}

export function analyzeJournals(
  journals: Journal[],
  params: Selection,
  malformedLines = 0,
): Insights {
  const window = windowFor(params),
    mined = mineFacts(journals),
    calls = callIndex(journals);
  const selected = mined.facts.filter((f) =>
    f.timestamp !== null && f.timestamp >= window.start &&
    f.timestamp < window.end
  ).sort((a, b) => a.timestamp! - b.timestamp!);
  const contexts = new Map<Journal, EntryContext>();
  for (const journal of journals) {
    const context: EntryContext = { byId: new Map(), prompts: new Map() };
    for (const entry of journal.entries) {
      if (text(entry.id)) context.byId.set(String(entry.id), entry);
    }
    contexts.set(journal, context);
  }
  const usage = newUsage(), allIntervals: [number, number][] = [];
  const sessionRows = new Map<string, SessionAccumulator>();
  const days = new Map<
    string,
    {
      row: Insights["days"][number];
      sessions: Set<string>;
      intervals: [number, number][];
    }
  >();
  const tools = new Map<string, Insights["tools"][number]>(),
    models = new Map<string, Insights["models"][number]>();
  const tasks: Insights["tasks"] = [],
    skills = new Map<string, number>(),
    requests: Insights["requests"] = [];
  const prompts = new Map<
    string,
    { id: string; text: string; usage: UsageMetrics }
  >();
  const cache: NonNullable<Insights["cacheBreakEvidence"]> = [],
    previous = new Map<
      string,
      { uncached: number | null; model: string | null }
    >();
  const starts = new Map<string, number>();
  for (const fact of mined.facts) {
    const data = object(fact.entry.data);
    if (
      fact.entry.type === "custom" &&
      fact.entry.customType === "tool_execution_start" && text(data.toolCallId)
    ) {
      const start = time(data.startedAt) ?? fact.timestamp;
      if (start !== null) {
        starts.set(
          `${String(fact.journal.header.id)}\0${String(data.toolCallId)}`,
          start,
        );
      }
    }
  }
  let assistantMessages = 0, supplemental = 0, promptCount = 0, timingGaps = 0;
  const toolRow = (name: string) => {
    if (!tools.has(name)) {
      tools.set(name, {
        name,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        unknown: 0,
      });
    }
    return tools.get(name)!;
  };
  const sessionFor = (fact: Fact): SessionAccumulator => {
    if (!sessionRows.has(fact.session)) {
      sessionRows.set(fact.session, {
        row: {
          id: fact.session,
          prompts: 0,
          assistantMessages: 0,
          first: "",
          last: "",
          wallMs: 0,
          activeMs: null,
          usage: newUsage(),
          agent: null,
        },
        times: [],
        intervals: [],
      });
    }
    return sessionRows.get(fact.session)!;
  };
  const factRuntime = (fact: Fact): [number, number] | null => {
    const entry = fact.entry, message = object(entry.message);
    if (message.role === "assistant" || entry.type === "model_usage") {
      return runtime(entry.type === "model_usage" ? entry : message);
    }
    if (message.role !== "toolResult") return null;
    const start = starts.get(
      `${String(fact.journal.header.id)}\0${String(message.toolCallId)}`,
    );
    const end = time(message.timestamp) ?? fact.timestamp;
    return start !== undefined && end !== null && end >= start
      ? [start, end]
      : null;
  };
  const addInterval = (
    interval: [number, number],
    session: SessionAccumulator,
  ): void => {
    const clipped: [number, number] = [
      Math.max(window.start, interval[0]),
      Math.min(window.end, interval[1]),
    ];
    if (clipped[1] <= clipped[0]) return;
    allIntervals.push(clipped);
    session.intervals.push(clipped);
    session.times.push(...clipped);
    // Time is split at UTC midnight, unlike token record assignment.
    for (let a = clipped[0]; a < clipped[1];) {
      const b = Math.min(
        clipped[1],
        (Math.floor(a / 86_400_000) + 1) * 86_400_000,
      );
      const key = day(a);
      if (!days.has(key)) {
        days.set(key, {
          row: {
            date: key,
            sessions: 0,
            prompts: 0,
            usage: newUsage(),
            activeMs: null,
          },
          sessions: new Set(),
          intervals: [],
        });
      }
      days.get(key)!.intervals.push([a, b]);
      days.get(key)!.sessions.add(session.row.id);
      a = b;
    }
  };
  // Runtime selection is independent of the persisted event timestamp. Facts
  // are already lineage-deduplicated; selected events must not add them again.
  for (const fact of mined.facts) {
    const interval = factRuntime(fact);
    if (
      interval && interval[0] < window.end && interval[1] > window.start &&
      interval[1] > interval[0]
    ) addInterval(interval, sessionFor(fact));
  }
  for (const fact of selected) {
    const stamp = fact.timestamp!,
      entry = fact.entry,
      message = object(entry.message);
    // Metadata alone must not create session or day membership.
    if (
      !["message", "model_usage", "session_init"].includes(String(entry.type))
    ) continue;
    const session = sessionFor(fact);
    if (entry.type === "session_init") session.row.agent = text(entry.agent);
    session.times.push(stamp);
    const date = day(stamp);
    if (!days.has(date)) {
      days.set(date, {
        row: {
          date,
          sessions: 0,
          prompts: 0,
          usage: newUsage(),
          activeMs: null,
        },
        sessions: new Set(),
        intervals: [],
      });
    }
    const daily = days.get(date)!;
    daily.sessions.add(fact.session);
    if (message.role === "user" && message.synthetic !== true) {
      promptCount++;
      session.row.prompts++;
      daily.row.prompts++;
    }
    if (message.role === "assistant" || entry.type === "model_usage") {
      if (message.role === "assistant") {
        assistantMessages++;
        session.row.assistantMessages++;
      } else supplemental++;
      const payload = entry.type === "model_usage" ? entry : message;
      addUsage(usage, payload.usage);
      addUsage(session.row.usage, payload.usage);
      addUsage(daily.row.usage, payload.usage);
      const model = text(payload.model),
        provider = text(payload.provider),
        modelKey = JSON.stringify([provider, model]);
      if (!models.has(modelKey)) {
        models.set(modelKey, { provider, model, usage: newUsage() });
      }
      addUsage(models.get(modelKey)!.usage, payload.usage);
      const ancestor = promptAncestor(fact, contexts.get(fact.journal)!),
        prompt = ancestor
          ? `prompt-${
            digest(
              `${fact.lineage}\0${String(ancestor.id)}\0${
                String(ancestor.timestamp)
              }`,
            )
          }`
          : null;
      const request = {
        entry: `entry-${digest(fact.identity)}`,
        session: fact.session,
        timestamp: iso(stamp),
        prompt,
        provider,
        model,
        purpose: text(entry.purpose),
        usage: newUsage(),
      };
      addUsage(request.usage, payload.usage);
      if (requests.length < 1000) requests.push(request);
      if (params.includePrompts && prompt && ancestor) {
        if (!prompts.has(prompt)) {
          prompts.set(prompt, {
            id: prompt,
            text: contentText(object(ancestor.message).content).slice(0, 1000),
            usage: newUsage(),
          });
        }
        addUsage(prompts.get(prompt)!.usage, payload.usage);
      }
      if (!factRuntime(fact)) timingGaps++;
      if (params.includeCacheBreaks) {
        const u = object(payload.usage),
          input = count(u.input),
          write = count(u.cacheWrite);
        const uncached = input !== null && write !== null
          ? input + write
          : null;
        const prior = previous.get(fact.session);
        if (
          uncached !== null &&
          uncached >= (params.cacheBreakThreshold ?? 100_000)
        ) {
          cache.push({
            entry: request.entry,
            session: fact.session,
            timestamp: iso(stamp),
            uncachedInput: uncached,
            cacheRead: count(u.cacheRead),
            precedingUncachedInput: prior?.uncached ?? null,
            modelChanged: prior?.model && model ? prior.model !== model : null,
          });
        }
        previous.set(fact.session, { uncached, model });
      }
      if (Array.isArray(message.content)) {
        for (const raw of message.content) {
          const block = object(raw);
          if (block.type === "toolCall" && text(block.name)) {
            toolRow(String(block.name)).attempted++;
          }
        }
      }
    }
    if (message.role === "toolResult") {
      const key = `${String(fact.journal.header.id)}\0${
          String(message.toolCallId)
        }`,
        call = calls.get(key),
        name = text(message.toolName) ?? call?.name ?? "unknown";
      const row = toolRow(name);
      if (message.isError === true) row.failed++;
      else if (message.isError === false) row.succeeded++;
      else row.unknown++;
      if (!factRuntime(fact)) timingGaps++;
      if (message.isError === false && name === "read") {
        const path = text(call?.args.path),
          match = path?.match(/^skill:\/\/([\w.-]+)(?:\/|$)/);
        if (match) skills.set(match[1], (skills.get(match[1]) ?? 0) + 1);
      }
      const details = object(message.details);
      if (name === "task" && Array.isArray(details.results)) {
        for (const raw of details.results) {
          const child = object(raw), id = text(child.id);
          if (id) {
            tasks.push({
              session: fact.session,
              child: `task-${digest(id)}`,
              agent: text(child.agent),
              durationMs: count(child.durationMs),
              ...(params.includePrompts && text(child.task)
                ? { task: String(child.task).slice(0, 1000) }
                : {}),
            });
          }
        }
      }
    }
  }
  const sessions = [...sessionRows.values()].filter((s) => s.times.length).map(
    (s) => {
      let first = Infinity, last = -Infinity;
      for (const stamp of s.times) {
        first = Math.min(first, stamp);
        last = Math.max(last, stamp);
      }
      return {
        ...s.row,
        first: iso(first),
        last: iso(last),
        wallMs: last - first,
        activeMs: unionMs(s.intervals),
      };
    },
  );
  const report: Insights = {
    kind: "session-report",
    window: window.public,
    provenance: {
      files: journals.length,
      entries: journals.reduce((n, j) => n + j.entries.length, 0),
      deduplicatedEntries: mined.duplicates,
      undatedEntries: mined.facts.filter((f) => f.timestamp === null).length,
      identityGaps: mined.gaps,
      malformedLines,
    },
    totals: {
      sessions: sessions.length,
      prompts: promptCount,
      activeDays: days.size,
      assistantMessages,
      supplementalUsageRecords: supplemental,
      usage,
      wallMs: sessions.length
        ? sessions.reduce((n, s) => n + s.wallMs, 0)
        : null,
      activeMs: unionMs(allIntervals),
      timedIntervals: allIntervals.length,
      timingGaps,
    },
    sessions,
    days: [...days.values()].map((d) => ({
      ...d.row,
      sessions: d.sessions.size,
      activeMs: unionMs(d.intervals),
    })).sort((a, b) => a.date.localeCompare(b.date)),
    tools: [...tools.values()],
    models: [...models.values()],
    tasks,
    skills: [...skills].map(([name, successfulReads]) => ({
      name,
      successfulReads,
    })),
    requests,
    requestContextOmitted: Math.max(0, usage.records - requests.length),
    ...(params.includePrompts
      ? {
        topPrompts: [...prompts.values()].sort((a, b) =>
          b.usage.totalTokens.observedSum - a.usage.totalTokens.observedSum
        ).slice(0, 100),
      }
      : {}),
    ...(params.includeCacheBreaks
      ? {
        cacheBreakEvidence: cache.sort((a, b) =>
          b.uncachedInput - a.uncachedInput
        ).slice(0, 100),
      }
      : {}),
    caveats: [...caveats],
  };
  return report;
}

function localPath(raw: unknown, cwd: unknown): string | null {
  const input = text(raw);
  if (
    !input || input.includes("\0") || input.includes("://") ||
    input.includes(";") || /[\[\]*?]/.test(input)
  ) return null;
  if (!isAbsolute(input) && !text(cwd)) return null;
  return resolve(text(cwd) ?? "/", input);
}
function diffLines(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  return raw.split("\n").filter((line) =>
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---"))
  ).length;
}
export function completedFileActivity(
  journals: Journal[],
  params: Selection,
): {
  activity: FileActivity[];
  unknownResults: number;
  unattributedResults: number;
} {
  const window = windowFor(params),
    calls = callIndex(journals),
    mined = mineFacts(journals);
  const activity: FileActivity[] = [];
  let unknownResults = 0, unattributedResults = 0;
  for (const fact of mined.facts) {
    if (
      fact.timestamp === null || fact.timestamp < window.start ||
      fact.timestamp >= window.end
    ) continue;
    const message = object(fact.entry.message),
      call = calls.get(
        `${String(fact.journal.header.id)}\0${String(message.toolCallId)}`,
      );
    const name = text(message.toolName) ?? call?.name;
    if (
      message.role !== "toolResult" ||
      !["read", "write", "edit", "ast_edit"].includes(name ?? "")
    ) continue;
    if (message.isError !== false) {
      if (message.isError !== true) unknownResults++;
      continue;
    }
    const details = object(message.details),
      created = time(fact.journal.header.timestamp);
    // A fork may inherit results from a different cwd. Absolute result paths
    // remain evidence; pre-fork relative paths must not be rebased to its new cwd.
    const inherited = text(fact.journal.header.parentSession) &&
      (created === null || fact.timestamp < created);
    const cwd = inherited ? undefined : fact.journal.header.cwd;
    const push = (
      path: unknown,
      kind: FileActivity["kind"],
      lines: number | null,
    ): boolean => {
      const absolute = localPath(path, cwd);
      if (!absolute) return false;
      activity.push({
        session: fact.session,
        timestamp: fact.timestamp!,
        path: absolute,
        kind,
        linesChanged: lines,
      });
      return true;
    };
    let attributed = false;
    if (name === "read") {
      const source = object(object(details.meta).source);
      // Do not parse selectors, directory listings or URLs as file paths.
      const path = details.resolvedPath ??
        (source.type === "path" ? source.value : undefined);
      attributed = details.isDirectory !== true && push(path, "read", null);
    } else if (name === "write") {
      const content = call?.args.content;
      const lines = typeof content === "string"
        ? (content.length ? content.split("\n").length : 0)
        : null;
      attributed = push(details.resolvedPath, "write", lines);
    } else if (name === "edit") {
      const rows = Array.isArray(details.perFileResults)
        ? details.perFileResults
        : [details];
      for (const raw of rows) {
        const row = object(raw);
        attributed = push(row.path, "edit", diffLines(row.diff)) || attributed;
        if (text(row.sourcePath)) {
          attributed = push(row.sourcePath, "edit", null) || attributed;
        }
      }
    } else {
      // ast_edit reports replacement counts and paths only after application.
      const rows = details.fileReplacements;
      if (details.applied === true && Array.isArray(rows)) {
        for (const raw of rows) {
          const row = object(raw);
          if ((count(row.count) ?? 0) > 0) {
            attributed = push(row.path, "edit", null) || attributed;
          }
        }
      }
    }
    if (!attributed) unattributedResults++;
  }
  return { activity, unknownResults, unattributedResults };
}

export interface HistoryCommit {
  commit: string;
  author: string;
  time: number;
  paths: string[];
}
export function parseHistory(output: string): HistoryCommit[] {
  if (Buffer.byteLength(output) > MAX_FILE) {
    throw new Error("History output exceeds 8 MiB");
  }
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const row = object(JSON.parse(line));
    if (
      !text(row.commit) || !/^[0-9a-f]{40,64}$/.test(String(row.commit)) ||
      typeof row.author !== "string" || time(row.time) === null ||
      !Array.isArray(row.paths) || row.paths.some((p) =>
        typeof p !== "string" || isAbsolute(p) || p.split("/").includes("..") ||
        p.includes("\0")
      )
    ) {
      throw new Error("Unsupported jj history record");
    }
    return {
      commit: String(row.commit),
      author: row.author,
      time: time(row.time)!,
      paths: row.paths as string[],
    };
  });
}
const HISTORY_TEMPLATE = String
  .raw`'{' ++ '"commit":' ++ json(stringify(commit_id)) ++ ',"author":' ++ json(author.email()) ++ ',"time":' ++ json(author.timestamp().utc().format("%Y-%m-%dT%H:%M:%SZ")) ++ ',"paths":' ++ json(self.diff().files().map(|f| f.path())) ++ '}' ++ "\n"`;
export interface ReceiptProject {
  label: string;
  sessions: number;
  activeDays: number;
  filesRead: number;
  filesChanged: number;
  completedOperations: number;
  knownLinesTouched: number;
  operationsWithUnknownLines: number;
  historyStatus: "complete" | "truncated" | "unavailable";
  commitsIntersectingChangedFiles: number | null;
  observedMatchingCommits: number;
  commitActiveDayOverlap: number | null;
  files?: string[];
}
export interface Receipt {
  kind: "work-receipts";
  window: Insights["window"];
  provenance: Insights["provenance"];
  totals: {
    sessions: number;
    activeDays: number;
    filesRead: number;
    filesChanged: number;
    completedOperations: number;
    unknownResults: number;
    unattributedResults: number;
    outsideHistoryScope: number;
    commitsIntersectingChangedFiles: number | null;
    observedMatchingCommits: number;
  };
  projects: ReceiptProject[];
  usage: UsageMetrics;
  caveats: string[];
}
export async function mineReceipts(
  api: Pick<ToolAPI, "cwd" | "exec">,
  journals: Journal[],
  params: ReceiptSelection,
  malformedLines = 0,
  signal?: AbortSignal,
): Promise<Receipt> {
  if (
    !Array.isArray(params.history) || params.history.length < 1 ||
    params.history.length > 16
  ) {
    throw new Error(
      "Select between 1 and 16 explicit jj roots and revision scopes",
    );
  }
  const maximum = params.maxCommits ?? 500;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 2000) {
    throw new Error("maxCommits must be between 1 and 2000");
  }
  const window = windowFor(params),
    report = analyzeJournals(journals, params, malformedLines),
    mined = completedFileActivity(journals, params);
  const scopes = await Promise.all(params.history.map(async (scope, index) => {
    if (!text(scope.revisions)) {
      throw new Error("Each history scope needs an explicit revset");
    }
    return {
      ...scope,
      root: await realpath(scope.root),
      label: scope.label ?? `project-${index + 1}`,
    };
  }));
  if (new Set(scopes.map((s) => s.root)).size !== scopes.length) {
    throw new Error("Duplicate history roots are ambiguous");
  }
  const projects: ReceiptProject[] = [],
    totalCommits = new Set<string>(),
    sessionSet = new Set<string>(),
    days = new Set<string>(),
    reads = new Set<string>(),
    writes = new Set<string>();
  let complete = true, operations = 0, outsideHistoryScope = 0;
  const buckets = scopes.map(() => [] as FileActivity[]);
  for (const activity of mined.activity) {
    const matches = scopes.map((s, i) => ({
      s,
      i,
      rel: relative(s.root, activity.path),
    })).filter((v) =>
      v.rel && v.rel !== ".." && !v.rel.startsWith(`..${sep}`) &&
      !isAbsolute(v.rel)
    );
    matches.sort((a, b) => b.s.root.length - a.s.root.length);
    const match = matches[0];
    if (
      !match ||
      match.rel.split(sep).some((part) => [".jj", ".git"].includes(part))
    ) {
      outsideHistoryScope++;
      continue;
    }
    buckets[match.i].push(activity);
  }
  for (let index = 0; index < scopes.length; index++) {
    signal?.throwIfAborted();
    const scope = scopes[index],
      activity = buckets[index],
      changed = new Map<string, number>(),
      projectDays = new Set<string>(),
      sessions = new Set<string>(),
      filesRead = new Set<string>();
    let lines = 0, unknownLines = 0;
    for (const item of activity) {
      const path = relative(scope.root, item.path).split(sep).join("/");
      sessions.add(item.session);
      projectDays.add(day(item.timestamp));
      sessionSet.add(item.session);
      days.add(day(item.timestamp));
      operations++;
      if (item.kind === "read") {
        filesRead.add(path);
        reads.add(item.path);
      } else {
        changed.set(
          path,
          Math.min(changed.get(path) ?? Infinity, item.timestamp),
        );
        writes.add(item.path);
        if (item.linesChanged === null) unknownLines++;
        else lines += item.linesChanged;
      }
    }
    let status: ReceiptProject["historyStatus"] = "complete",
      commits: HistoryCommit[] = [];
    try {
      const root = await api.exec("jj", [
        "--ignore-working-copy",
        "--color=never",
        "root",
      ], { cwd: scope.root, signal, timeout: 30_000 });
      if (
        root.code !== 0 || root.killed ||
        await realpath(root.stdout.trim()) !== scope.root
      ) throw new Error("Selected path is not an exact jj workspace root");
      const history = await api.exec("jj", [
        "--ignore-working-copy",
        "--color=never",
        "log",
        "--no-graph",
        "--revisions",
        scope.revisions,
        "--limit",
        String(maximum + 1),
        "--template",
        HISTORY_TEMPLATE,
      ], { cwd: scope.root, signal, timeout: 30_000 });
      if (history.code !== 0 || history.killed) {
        throw new Error("jj history unavailable");
      }
      commits = parseHistory(history.stdout);
      if (commits.length > maximum) {
        status = "truncated";
        commits = commits.slice(0, maximum);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      status = "unavailable";
    }
    if (status !== "complete") complete = false;
    const matching = commits.filter((commit) =>
      commit.time >= window.start && commit.time < window.end &&
      (!scope.authorEmail || commit.author === scope.authorEmail) &&
      commit.paths.some((path) =>
        changed.has(path) && changed.get(path)! <= commit.time
      )
    );
    const matched = new Set(matching.map((c) => c.commit)),
      overlap = new Set(
        matching.map((c) => day(c.time)).filter((date) =>
          projectDays.has(date)
        ),
      );
    for (const commit of matched) totalCommits.add(commit);
    projects.push({
      label: scope.label,
      sessions: sessions.size,
      activeDays: projectDays.size,
      filesRead: filesRead.size,
      filesChanged: changed.size,
      completedOperations: activity.length,
      knownLinesTouched: lines,
      operationsWithUnknownLines: unknownLines,
      historyStatus: status,
      commitsIntersectingChangedFiles: status === "complete"
        ? matched.size
        : null,
      observedMatchingCommits: matched.size,
      commitActiveDayOverlap: status === "complete" ? overlap.size : null,
      ...(params.includePaths
        ? { files: [...new Set([...filesRead, ...changed.keys()])].sort() }
        : {}),
    });
  }
  return {
    kind: "work-receipts",
    window: report.window,
    provenance: report.provenance,
    totals: {
      sessions: sessionSet.size,
      activeDays: days.size,
      filesRead: reads.size,
      filesChanged: writes.size,
      completedOperations: operations,
      unknownResults: mined.unknownResults,
      unattributedResults: mined.unattributedResults,
      outsideHistoryScope,
      commitsIntersectingChangedFiles: complete ? totalCommits.size : null,
      observedMatchingCommits: totalCommits.size,
    },
    projects,
    usage: report.totals.usage,
    caveats: [
      ...caveats,
      "Only explicit successful native read/write/edit/ast_edit results with filesystem evidence count. Errors, attempts, unknown result status, shell commands and AST previews are not completed file work.",
      "Project membership comes from completed file paths inside selected roots, never cwd votes or weighted model ratios. Usage is for the selected journals/window, not apportioned to projects or tool activities.",
      "History matches are read-only jj commit IDs in the selected revsets, optionally filtered by exact author email, with a changed-path intersection after a recorded edit. This is correlation, not proof of shipped output, authorship by an assistant, PR success or causation.",
      "No author filter means all authors. Unavailable/truncated history yields unknown, not zero; observed matches are a lower bound. Shared history is deduplicated by commit ID in totals. Sessions, active days and project commit memberships must not be added together.",
      "Known lines touched count changed diff lines or write payload length, including revisits; unknown edit extents stay unknown. This is not net lines of code or lines shipped.",
      "Default project labels are opaque. Explicit labels and includePaths can disclose confidential names; review before sharing. No time saved, dollar savings, PR metrics or publication are inferred.",
    ],
  };
}

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "unknown" : String(value);
  if (/^[\s\p{Cc}]*[=+\-@]/u.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
export function reportCsv(report: Insights | Receipt): string {
  const rows: unknown[][] = report.kind === "work-receipts"
    ? [
      [
        "Project",
        "Sessions (nonadditive)",
        "Active days (nonadditive)",
        "Files read",
        "Files changed",
        "Completed operations",
        "Known lines touched (not net)",
        "Unknown line extents",
        "History status",
        "Intersecting commits (nonadditive)",
      ],
      ...report.projects.map(
        (p) => [
          p.label,
          p.sessions,
          p.activeDays,
          p.filesRead,
          p.filesChanged,
          p.completedOperations,
          p.knownLinesTouched,
          p.operationsWithUnknownLines,
          p.historyStatus,
          p.commitsIntersectingChangedFiles,
        ],
      ),
    ]
    : [
      [
        "UTC day",
        "Sessions (nonadditive)",
        "Prompts",
        "Total tokens",
        "Observed tokens (partial if unknown)",
        "Missing token records",
        "Active runtime ms (partial)",
      ],
      ...report.days.map(
        (d) => [
          d.date,
          d.sessions,
          d.prompts,
          d.usage.totalTokens.value,
          d.usage.totalTokens.observedSum,
          d.usage.totalTokens.missingRecords,
          d.activeMs,
        ],
      ),
    ];
  rows.push([], ...report.caveats.map((note) => [`Note: ${note}`]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(
      /\u2029/g,
      "\\u2029",
    );
}
export function renderReport(report: Insights | Receipt): string {
  const title = report.kind === "work-receipts"
    ? "OMP work receipts"
    : "OMP session insights";
  const csv = reportCsv(report);
  return `<!doctype html>
<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp; SPDX-License-Identifier: Apache-2.0 -->
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'">
<title>${title}</title><style>
:root{color-scheme:light dark;font:16px system-ui;background:#101820;color:#e6edf3}body{max-width:1100px;margin:auto;padding:2rem}h1{font-size:2.5rem}h2{margin-top:2rem}small,.note{color:#b4c2ce}button,input{font:inherit;border:1px solid #536879;border-radius:5px;padding:.5rem;background:#203442;color:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #6ce4cb}.cards{display:flex;flex-wrap:wrap;gap:1rem}.card{padding:1rem;background:#203442;border-radius:8px;min-width:130px}.card strong{display:block;font-size:1.7rem;color:#6ce4cb}.scroll{overflow:auto}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.7rem;border-bottom:1px solid #536879}th button{border:0;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer;padding:.5rem}li{margin:.5rem 0}.bar{height:5px;background:#6ce4cb}@media(max-width:600px){body{padding:1rem}h1{font-size:2rem}}@media print{body{background:white;color:black}button,input{display:none}.note,small{color:#444}}
</style><body><h1>${title}</h1><p>${escapeHtml(report.window.since)} — ${
    escapeHtml(report.window.until)
  } <small>UTC · end exclusive</small></p>
<div class="cards" id="cards"></div><h2>${
    report.kind === "work-receipts"
      ? "Completed file activity by selected project"
      : "Daily usage"
  }</h2>
<label>Filter rows <input id="filter" type="search"></label> <button id="csv" type="button">Export CSV</button><div class="scroll"><table id="table"></table></div>
<p class="note">Unknown is not zero. Session/day/project memberships are not additive. Runtime is partial where explicit timing is absent.</p>
<div id="detail"></div><h2>Evidence and limits</h2><ul>${
    report.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join("")
  }</ul>
<details><summary>Complete structured metrics</summary><pre id="json"></pre></details>
<script id="report-data" type="application/json">${
    scriptJson(report)
  }</script><script>
"use strict";
const data=JSON.parse(document.getElementById("report-data").textContent),csv=${
    scriptJson(csv)
  };
const el=(tag,value)=>{const node=document.createElement(tag);if(value!==undefined)node.textContent=String(value===null?"unknown":value);return node};
const receipt=data.kind==="work-receipts",totals=data.totals,usage=receipt?data.usage:totals.usage;
const metrics=receipt?[["Sessions",totals.sessions],["Active days",totals.activeDays],["Files changed",totals.filesChanged],["Intersecting commits",totals.commitsIntersectingChangedFiles]]:[["Sessions",totals.sessions],["Prompts",totals.prompts],["Recorded tokens",usage.totalTokens.value],["Active runtime (ms)",totals.activeMs]];
for(const [label,value] of metrics){const card=el("div");card.className="card";card.append(el("strong",value),el("span",label));document.getElementById("cards").append(card)}
const columns=receipt?[["Project","label"],["Sessions","sessions"],["Active days","activeDays"],["Files read","filesRead"],["Files changed","filesChanged"],["Known lines touched","knownLinesTouched"],["Unknown extents","operationsWithUnknownLines"],["History","historyStatus"],["Intersecting commits","commitsIntersectingChangedFiles"]]:[["UTC day","date"],["Sessions","sessions"],["Prompts","prompts"],["Tokens","tokens"],["Observed tokens","observed"],["Usage gaps","gaps"],["Active ms","activeMs"]];
let rows=receipt?data.projects:data.days.map(d=>({...d,tokens:d.usage.totalTokens.value,observed:d.usage.totalTokens.observedSum,gaps:d.usage.totalTokens.missingRecords})),sortKey=columns[0][1],direction=1;
function draw(){const table=document.getElementById("table");table.replaceChildren();const tr=el("tr");for(const [name,key] of columns){const th=el("th"),button=el("button",name);button.type="button";button.onclick=()=>{direction=sortKey===key?-direction:1;sortKey=key;draw()};th.append(button);tr.append(th)}const thead=el("thead");thead.append(tr);table.append(thead);const body=el("tbody"),query=document.getElementById("filter").value.toLowerCase();for(const row of rows.filter(r=>String(r[columns[0][1]]).toLowerCase().includes(query)).slice().sort((a,b)=>{const x=a[sortKey],y=b[sortKey];return direction*(typeof x==="number"&&typeof y==="number"?x-y:String(x).localeCompare(String(y)))})){const line=el("tr");for(const [,key] of columns)line.append(el("td",row[key]));body.append(line)}table.append(body)}
draw();document.getElementById("filter").addEventListener("input",draw);
for(const name of (receipt?[]:["sessions","tools","models","tasks","skills","requests","topPrompts","cacheBreakEvidence"]))if(data[name]){const detail=el("details"),summary=el("summary",name),pre=el("pre",JSON.stringify(data[name],null,2));detail.append(summary,pre);document.getElementById("detail").append(detail)}
document.getElementById("json").textContent=JSON.stringify(data,null,2);
document.getElementById("csv").onclick=()=>{const url=URL.createObjectURL(new Blob(["\\ufeff"+csv],{type:"text/csv;charset=utf-8"})),a=el("a");a.href=url;a.download=receipt?"omp-work-receipts.csv":"omp-session-insights.csv";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),0)};
</script><noscript>Enable JavaScript for sorting and drilldowns. The evidence and limits above remain readable; use the separate CSV export for tabular data.</noscript></body></html>`;
}

async function exportsFor(
  api: Pick<ToolAPI, "cwd">,
  report: Insights | Receipt,
  params: Selection,
): Promise<{ html: string | null; csv: string | null }> {
  if (
    params.html && params.csv &&
    resolve(api.cwd, params.html) === resolve(api.cwd, params.csv)
  ) throw new Error("HTML and CSV outputs must differ");
  const html = params.html ? renderReport(report) : null,
    csv = params.csv ? reportCsv(report) : null;
  if (
    (html && Buffer.byteLength(html) > MAX_FILE) ||
    (csv && Buffer.byteLength(csv) > MAX_FILE)
  ) throw new Error("Export exceeds 8 MiB");
  return {
    html: html && params.html
      ? await writeWorkspaceFile(
        api.cwd,
        params.html,
        html,
        params.overwrite ?? false,
      )
      : null,
    csv: csv && params.csv
      ? await writeWorkspaceFile(
        api.cwd,
        params.csv,
        csv,
        params.overwrite ?? false,
      )
      : null,
  };
}

export async function runSessionAnalysis(
  api: Pick<ToolAPI, "cwd">,
  params: Selection,
  signal?: AbortSignal,
): Promise<
  { report: Insights; exports: { html: string | null; csv: string | null } }
> {
  const input = await loadJournals(params, signal);
  const report = analyzeJournals(input.journals, params, input.malformedLines);
  return { report, exports: await exportsFor(api, report, params) };
}

export async function runWorkReceipts(
  api: Pick<ToolAPI, "cwd" | "exec">,
  params: ReceiptSelection,
  signal?: AbortSignal,
): Promise<
  { report: Receipt; exports: { html: string | null; csv: string | null } }
> {
  const input = await loadJournals(params, signal);
  const report = await mineReceipts(
    api,
    input.journals,
    params,
    input.malformedLines,
    signal,
  );
  return { report, exports: await exportsFor(api, report, params) };
}

export default function sessionInsights(
  api: ToolAPI,
): [Tool<Selection>, Tool<ReceiptSelection>] {
  const T = api.typebox.Type;
  const common = {
    inputRoot: T.String({
      description:
        "Explicit root containing selected OMP journals; never scanned globally",
    }),
    files: T.Array(T.String(), { minItems: 1, maxItems: 256 }),
    since: T.String({ description: "Inclusive ISO timestamp with timezone" }),
    until: T.String({ description: "Exclusive ISO timestamp with timezone" }),
    includePaths: T.Optional(T.Boolean({ default: false })),
    includePrompts: T.Optional(T.Boolean({ default: false })),
    includeCacheBreaks: T.Optional(T.Boolean({ default: false })),
    cacheBreakThreshold: T.Optional(T.Integer({ minimum: 1, default: 100000 })),
    html: T.Optional(
      T.String({ description: "Offline HTML output under api.cwd" }),
    ),
    csv: T.Optional(
      T.String({ description: "Formula-safe CSV output under api.cwd" }),
    ),
    overwrite: T.Optional(T.Boolean({ default: false })),
  };
  return [{
    name: "session_analyze",
    label: "OMP session insights",
    approval: "write",
    description:
      "Mine explicit OMP journals for deduplicated usage, runtime, tools, tasks and skill evidence; optionally export offline HTML/CSV. No implicit scans or prompt text by default.",
    parameters: T.Object(common),
    async execute(_id, params, _onUpdate, _ctx, signal) {
      return result(await runSessionAnalysis(api, params, signal));
    },
  }, {
    name: "work_receipts",
    label: "OMP work receipts",
    approval: "exec",
    description:
      "Mine completed native file activity from explicit journals and correlate selected jj roots/revsets using read-only ignore-working-copy history. Export private offline HTML/CSV; unavailable history remains unknown.",
    parameters: T.Object({
      ...common,
      history: T.Array(
        T.Object({
          root: T.String(),
          revisions: T.String(),
          label: T.Optional(T.String()),
          authorEmail: T.Optional(T.String()),
        }),
        { minItems: 1, maxItems: 16 },
      ),
      maxCommits: T.Optional(
        T.Integer({ minimum: 1, maximum: 2000, default: 500 }),
      ),
    }),
    async execute(_id, params, _onUpdate, _ctx, signal) {
      return result(await runWorkReceipts(api, params, signal));
    },
  }];
}
