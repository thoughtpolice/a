// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/blueteam`: structured security review, reverse-engineering
 * notes and triage.
 *
 * ```ts
 * const review = await securityReview(gpt, { diff, context: "payments service" });
 * for (const finding of review.findings) {
 *   finding.severity; // "critical" | "high" | "medium" | "low" | "info"
 *   finding.cwe;      // "CWE-89" | null
 *   finding.location; // { path, startLine, endLine, symbol }
 * }
 * const verdict = await triage(gpt, { alert: siemAlertText });
 * ```
 *
 * Each helper is a structured call ({@link GptClient.structured}) with a
 * `@celld/sieve` schema from this module (strict objects, so an answer
 * with an extra key is an error) and a short default prompt that the caller can
 * replace. Large inputs are split with the chunkers from `@celld/api/openai`
 * and the per-chunk results merged; findings are de-duplicated by
 * location, CWE and title.
 *
 * The ChatGPT backend may refuse security work under its cyber policy
 * (`GptError` kind `policy`, code `cyber_policy`). That is not retried.
 * Keep prompts defensive and specific. `gpt-daybreak-blue-latest`, the
 * Daybreak Blue cyber model, is served through a ChatGPT subscription
 * (unlisted in `/models`); `turn.accessPrograms` shows `{cyber:
 * "daybreak_blue"}` when its program applied. Daybreak Red is refused for
 * ChatGPT accounts.
 *
 * @module
 */

import { type AnySchema, type Infer, type Output, v } from "@celld/sieve";
import {
  type Chunk,
  chunkDiff,
  chunkDisassembly,
  chunkLines,
  chunkLog,
  mapChunks,
} from "./chunk.ts";
import type { CallOptions, GptClient } from "./client.ts";
import { addUsage, ZERO_USAGE } from "./items.ts";
import type { GptRequest } from "./request.ts";
import type { ReasoningEffort, Turn, Usage } from "./types.ts";

/** Severities, most severe first. */
export const SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;

/** A severity. */
export type Severity = (typeof SEVERITIES)[number];

const probability = () => v.number().min(0).max(1);

/** Where a finding is. */
export const Location = v.strictObject({
  path: v.string().describe(
    "File path, or binary/section name for RE targets.",
  ),
  startLine: v.int().min(1).describe("First line (1-based), or null.")
    .nullable(),
  endLine: v.int().min(1).describe("Last line (1-based), or null.")
    .nullable(),
  symbol: v.string().describe("Function, method or address, or null.")
    .nullable(),
});

/** One security finding. */
export const Finding = v.strictObject({
  title: v.string().describe("A one-line statement of the problem."),
  severity: v.enum(SEVERITIES).describe(
    "Impact if exploited, assuming realistic attacker access.",
  ),
  cwe: v.string().regex(/^CWE-[0-9]+$/).describe(
    "The most specific CWE id, such as CWE-89, or null if none fits.",
  ).nullable(),
  location: Location,
  evidence: v.string().describe(
    "The code or behaviour that shows the problem, quoted or described precisely.",
  ),
  exploitability: v.string().describe(
    "How an attacker would reach and trigger it.",
  ),
  confidence: probability().describe(
    "Probability that this is a real, reachable issue.",
  ),
  remediation: v.string().describe("The concrete fix."),
});
/** One security finding. */
export type Finding = Infer<typeof Finding>;

/** A review of one input. */
export const SecurityReview = v.strictObject({
  summary: v.string().describe(
    "Two or three sentences on the overall security posture.",
  ),
  findings: v.array(Finding).describe(
    "Real issues only, most severe first; empty if none.",
  ),
});
/** A review of one input. */
export type SecurityReview = Infer<typeof SecurityReview>;

/** Notes from reverse-engineering a function or binary region. */
export const ReNotes = v.strictObject({
  summary: v.string().describe("What this code does, in a paragraph."),
  architecture: v.string().describe("Instruction set and ABI, if evident.")
    .nullable(),
  functions: v.array(v.strictObject({
    name: v.string().describe("Symbol or address."),
    purpose: v.string(),
    confidence: probability(),
  })),
  capabilities: v.array(v.string()).describe(
    "Behaviours such as network access, persistence, crypto, anti-analysis.",
  ),
  indicators: v.array(v.strictObject({
    kind: v.enum([
      "domain",
      "ip",
      "url",
      "path",
      "registry",
      "mutex",
      "hash",
      "string",
      "other",
    ]),
    value: v.string(),
    context: v.string(),
  })),
  vulnerabilities: v.array(Finding),
  openQuestions: v.array(v.string()).describe("What to look at next."),
});
/** Notes from reverse-engineering a function or binary region. */
export type ReNotes = Infer<typeof ReNotes>;

/** A triage decision on an alert or finding. */
export const Triage = v.strictObject({
  verdict: v.enum([
    "true_positive",
    "false_positive",
    "benign",
    "needs_more_info",
    "duplicate",
  ]),
  severity: v.enum(SEVERITIES),
  priority: v.enum(["P0", "P1", "P2", "P3", "P4"]).describe(
    "P0 drop everything, P4 backlog.",
  ),
  confidence: probability(),
  rationale: v.string(),
  escalate: v.boolean().describe("Whether a human must look at this now."),
  nextSteps: v.array(v.string()),
});
/** A triage decision. */
export type Triage = Infer<typeof Triage>;

/** Default prompt for {@link securityReview}. Replace freely. */
export const SECURITY_REVIEW_INSTRUCTIONS = [
  "You are a senior application security engineer doing a defensive code review for the code's owners.",
  "Report only real, reachable vulnerabilities, with evidence from the input. Do not pad with style issues or generic advice.",
  "Use the most specific CWE. Rate severity by realistic impact. Give confidence as a probability.",
  "Cite locations by the file path and line numbers shown in the input.",
  "If there is nothing to report, return an empty findings list.",
].join("\n");

/** Default prompt for {@link reverseEngineer}. Replace freely. */
export const REVERSE_ENGINEERING_INSTRUCTIONS = [
  "You are a reverse engineer on a defensive team analysing code the team is authorised to study.",
  "Describe what the code does, precisely and without speculation beyond the evidence.",
  "Name functions by their symbol or address as shown. Extract indicators exactly as they appear.",
  "Flag memory-safety and logic vulnerabilities as findings, with locations.",
].join("\n");

/** Default prompt for {@link triage}. Replace freely. */
export const TRIAGE_INSTRUCTIONS = [
  "You are an on-call security analyst triaging alerts and findings.",
  "Decide whether the item is real, how severe it is, and what to do next.",
  "Be conservative: when evidence is thin, choose needs_more_info rather than guessing.",
  "Escalate only what needs a human now.",
].join("\n");

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Findings, most severe first, then most confident. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.confidence - a.confidence
  );
}

function findingKey(finding: Finding): string {
  return JSON.stringify([
    finding.location.path,
    finding.location.startLine,
    finding.cwe,
    finding.title.trim().toLowerCase(),
  ]);
}

/**
 * Removes duplicates (same path, start line, CWE and title), keeping the
 * most severe, then most confident, of each.
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const kept = new Map<string, Finding>();
  for (const finding of sortFindings(findings)) {
    const key = findingKey(finding);
    if (!kept.has(key)) kept.set(key, finding);
  }
  return sortFindings([...kept.values()]);
}

/** The findings at or above a severity. */
export function atLeast(
  findings: readonly Finding[],
  severity: Severity,
): Finding[] {
  return findings.filter((finding) =>
    SEVERITY_RANK[finding.severity] <= SEVERITY_RANK[severity]
  );
}

/** Settings shared by the helpers. */
export interface AnalysisOptions {
  /** Replaces the default instructions. */
  readonly instructions?: string;
  /** Default `high`: reviews reward thinking. */
  readonly effort?: ReasoningEffort;
  /** Characters per chunk; default 120,000 (about 30,000 tokens). */
  readonly maxChars?: number;
  /** Chunks analysed at once; default 2. */
  readonly concurrency?: number;
  readonly model?: string;
  readonly call?: CallOptions;
}

/** A merged analysis and what it cost. */
export interface Analysis<T> {
  readonly result: T;
  /** The per-chunk results, in chunk order. */
  readonly parts: readonly T[];
  readonly chunks: number;
  readonly usage: Usage;
  readonly turns: readonly Turn[];
}

function request(
  options: AnalysisOptions,
  instructions: string,
  input: string,
): Omit<GptRequest, "format"> {
  return {
    input,
    instructions: options.instructions ?? instructions,
    reasoning: { effort: options.effort ?? "high" },
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}

function framed(
  chunk: Chunk,
  what: string,
  context: string | undefined,
): string {
  return [
    context === undefined ? null : `Context: ${context}`,
    chunk.total > 1
      ? `This is part ${chunk.index + 1} of ${chunk.total} of the ${what}${
        chunk.label === "" ? "" : ` (${chunk.label})`
      }, lines ${chunk.startLine}-${chunk.endLine}.`
      : null,
    `<${what}>`,
    chunk.text,
    `</${what}>`,
  ].filter((line) => line !== null).join("\n");
}

async function analyse<S extends AnySchema>(
  client: GptClient,
  schema: S,
  inputs: readonly string[],
  instructions: string,
  options: AnalysisOptions,
  name: string,
): Promise<{ parts: Output<S>[]; turns: Turn[]; usage: Usage }> {
  const results = await mapChunks(
    inputs.map((text, index) => ({
      index,
      total: inputs.length,
      text,
      startLine: 1,
      endLine: 1,
      label: "",
    })),
    (chunk) =>
      client.structured(
        { ...request(options, instructions, chunk.text), schema, name },
        options.call,
      ),
    { concurrency: options.concurrency },
  );
  const turns = results.map((result) => result.turn);
  return {
    parts: results.map((result) => result.value),
    turns,
    usage: addUsage(ZERO_USAGE, ...turns.map((turn) => turn.usage)),
  };
}

/**
 * Reviews source files or a diff for vulnerabilities. Give `files` (path
 * to text; lines are numbered for citation) or a unified `diff`.
 *
 * @throws {GptError} as `structured` does; a chunk that fails fails the review.
 */
export async function securityReview(
  client: GptClient,
  input: {
    readonly files?: Readonly<Record<string, string>>;
    readonly diff?: string;
    /** What the code is and what matters, in a sentence or two. */
    readonly context?: string;
  },
  options: AnalysisOptions = {},
): Promise<Analysis<SecurityReview> & { readonly findings: Finding[] }> {
  const maxChars = options.maxChars ?? 120_000;
  const pieces: { chunk: Chunk; what: string }[] = [];
  if (input.diff !== undefined) {
    for (const chunk of chunkDiff(input.diff, { maxChars })) {
      pieces.push({ chunk, what: "diff" });
    }
  }
  for (const [path, text] of Object.entries(input.files ?? {})) {
    for (const chunk of chunkLines(text, { maxChars, numberLines: true })) {
      pieces.push({
        chunk: {
          ...chunk,
          label: path,
          text: `// file: ${path}\n${chunk.text}`,
        },
        what: "code",
      });
    }
  }
  if (pieces.length === 0) {
    throw new TypeError("securityReview needs files or a diff");
  }
  const inputs = pieces.map(({ chunk, what }, index) =>
    framed({ ...chunk, index, total: pieces.length }, what, input.context)
  );
  const { parts, turns, usage } = await analyse(
    client,
    SecurityReview,
    inputs,
    SECURITY_REVIEW_INSTRUCTIONS,
    options,
    "security_review",
  );
  const findings = dedupeFindings(parts.flatMap((part) => part.findings));
  return {
    result: {
      summary: parts.map((part) => part.summary).join("\n\n"),
      findings,
    },
    findings,
    parts,
    chunks: pieces.length,
    usage,
    turns,
  };
}

/**
 * Reverse-engineering notes for disassembly or decompiler output, split at
 * function boundaries.
 */
export async function reverseEngineer(
  client: GptClient,
  input: { readonly disassembly: string; readonly context?: string },
  options: AnalysisOptions = {},
): Promise<Analysis<ReNotes>> {
  const chunks = chunkDisassembly(input.disassembly, {
    maxChars: options.maxChars ?? 120_000,
  });
  if (chunks.length === 0) {
    throw new TypeError("reverseEngineer needs disassembly");
  }
  const { parts, turns, usage } = await analyse(
    client,
    ReNotes,
    chunks.map((chunk) => framed(chunk, "disassembly", input.context)),
    REVERSE_ENGINEERING_INSTRUCTIONS,
    options,
    "re_notes",
  );
  const unique = <T>(items: T[], key: (item: T) => string) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const k = key(item);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const result: ReNotes = {
    summary: parts.map((part) => part.summary).join("\n\n"),
    architecture:
      parts.find((part) => part.architecture !== null)?.architecture ?? null,
    functions: unique(
      parts.flatMap((part) => part.functions),
      (item) => item.name,
    ),
    capabilities: unique(
      parts.flatMap((part) => part.capabilities),
      (item) => item,
    ),
    indicators: unique(
      parts.flatMap((part) => part.indicators),
      (item) => `${item.kind}:${item.value}`,
    ),
    vulnerabilities: dedupeFindings(
      parts.flatMap((part) => part.vulnerabilities),
    ),
    openQuestions: unique(
      parts.flatMap((part) => part.openQuestions),
      (item) => item,
    ),
  };
  return { result, parts, chunks: chunks.length, usage, turns };
}

/**
 * Triage of one alert, log excerpt or finding. A long `alert` is cut to
 * `maxChars` (its head and tail) rather than split: a verdict needs the
 * whole picture at once.
 */
export async function triage(
  client: GptClient,
  input: {
    readonly alert: string | Finding;
    /** Surrounding facts: asset criticality, recent changes, related alerts. */
    readonly context?: string;
  },
  options: Omit<AnalysisOptions, "concurrency"> = {},
): Promise<{ readonly triage: Triage; readonly turn: Turn }> {
  const text = typeof input.alert === "string"
    ? input.alert
    : JSON.stringify(input.alert, null, 2);
  const maxChars = options.maxChars ?? 120_000;
  const body = text.length > maxChars
    ? `${text.slice(0, maxChars / 2)}\n…[${
      text.length - maxChars
    } characters omitted]…\n${text.slice(text.length - maxChars / 2)}`
    : text;
  const { value, turn } = await client.structured({
    ...request(
      { ...options, effort: options.effort ?? "medium" },
      TRIAGE_INSTRUCTIONS,
      [
        input.context === undefined ? null : `Context: ${input.context}`,
        "<item>",
        body,
        "</item>",
      ].filter((line) => line !== null).join("\n"),
    ),
    schema: Triage,
    name: "triage",
  }, options.call);
  return { triage: value, turn };
}

/**
 * Chunks of a log with numbered lines, ready for per-chunk triage or
 * summarisation with {@link mapChunks}.
 */
export function logChunks(log: string, maxChars = 120_000): Chunk[] {
  return chunkLog(log, { maxChars });
}
