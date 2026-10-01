// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Adapted from Anthropic claude-plugins-official ab024cdc,
// plugins/skill-creator/skills/skill-creator/scripts/aggregate_benchmark.py
// (Apache-2.0). Modified: explicit variants and pairs, no invented zero/token
// measurements, evidence-aware grades, bounded artifacts, no CLI/model wrapper.

import { decodeUtf8, readWorkspaceFile } from "../lib/files.ts";
import { result, type Tool, type ToolAPI } from "../lib/tool.ts";

export const metrics = ["pass_rate", "time_seconds", "tokens", "tool_calls", "errors"] as const;
export type Metric = typeof metrics[number];
export interface Statistics { n: number; mean: number | null; stddev: number | null; min: number | null; max: number | null }
export interface ArtifactRun { case: string; run: number; variant: string; grading?: unknown; timing?: unknown }
export interface MeasuredRun { case: string; run: number; variant: string; values: Record<Metric, number | null>; missing: string[]; expectations: string[] | null }
export interface Benchmark { variants: string[]; runs: MeasuredRun[]; summary: Record<string, Record<Metric, Statistics>>; pairs: { case: string; run: number; deltas: Record<Metric, number | null>; missing: string[] }[]; pairedDelta: Record<Metric, Statistics> }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function statistics(values: number[]): Statistics {
  if (values.length === 0) return { n: 0, mean: null, stddev: null, min: null, max: null };
  let min = Infinity, max = -Infinity, scale = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error("Statistics require finite measurements");
    min = Math.min(min, value); max = Math.max(max, value);
    scale = Math.max(scale, Math.abs(value));
  }
  let sum = 0;
  if (scale) for (const value of values) sum += value / scale;
  const normalizedMean = sum / values.length;
  let squared = 0;
  if (scale) for (const value of values) squared += (value / scale - normalizedMean) ** 2;
  const mean = normalizedMean * scale;
  const stddev = values.length > 1 ? Math.sqrt(squared / (values.length - 1)) * scale : 0;
  if (!Number.isFinite(mean) || !Number.isFinite(stddev)) throw new Error("Statistics exceed the representable numeric range");
  return { n: values.length, mean, stddev, min, max };
}

export function aggregateBenchmark(variants: string[], artifacts: ArtifactRun[]): Benchmark {
  if (variants.length !== 2 || !variants.every((v) => typeof v === "string" && v.trim()) || variants[0] === variants[1]) throw new Error("Select two distinct variants in primary, baseline order");
  if (!artifacts.length || artifacts.length > 1000) throw new Error("Expected 1–1000 explicitly selected runs");
  const seen = new Set<string>();
  const runs: MeasuredRun[] = artifacts.map((artifact) => {
    if (typeof artifact.case !== "string" || !artifact.case.trim() || !Number.isSafeInteger(artifact.run) || artifact.run < 1 || !variants.includes(artifact.variant)) throw new Error("Invalid case, run number or selected variant");
    const identity = JSON.stringify([artifact.case, artifact.run, artifact.variant]);
    if (seen.has(identity)) throw new Error("Duplicate case/run/variant artifact");
    seen.add(identity);
    const values: Record<Metric, number | null> = { pass_rate: null, time_seconds: null, tokens: null, tool_calls: null, errors: null };
    const missing: string[] = [];
    let expectations: string[] | null = null;
    const grading = artifact.grading;
    if (grading !== undefined && !object(grading)) throw new Error("Grading artifact must be an object");
    if (object(grading)) {
      const raw = grading.expectations;
      if (raw !== undefined && !Array.isArray(raw)) throw new Error("Grading expectations must be an array");
      if (Array.isArray(raw)) {
        let passed = 0;
        let verified = true;
        expectations = [];
        for (const expectation of raw) {
          if (!object(expectation) || typeof expectation.text !== "string" || !expectation.text.trim() || typeof expectation.passed !== "boolean") throw new Error("Each expectation needs text and a boolean verdict");
          if (expectations.includes(expectation.text)) throw new Error("Duplicate grading expectation");
          expectations.push(expectation.text);
          if (typeof expectation.evidence !== "string" || !expectation.evidence.trim()) verified = false;
          if (expectation.passed) passed++;
        }
        expectations.sort();
        if (raw.length && verified) values.pass_rate = passed / raw.length;
        else missing.push(raw.length ? "grading: expectation evidence missing" : "grading: no expectations");
        if (grading.summary !== undefined) {
          if (!object(grading.summary)) throw new Error("Grading summary must be an object");
          const summary = grading.summary;
          const computed: Record<string, number> = { passed, failed: raw.length - passed, total: raw.length };
          if (raw.length) computed.pass_rate = passed / raw.length;
          for (const [field, expected] of Object.entries(computed)) if (summary[field] !== undefined && (typeof summary[field] !== "number" || Math.abs(summary[field] - expected) > 1e-9)) throw new Error("Grading summary contradicts expectation verdicts");
        }
      } else missing.push("grading: expectation verdicts and evidence missing");
    } else missing.push("grading: artifact missing");
    const timing = artifact.timing ?? (object(grading) ? grading.timing : undefined);
    if (timing !== undefined && !object(timing)) throw new Error("Timing artifact must be an object");
    const execution = object(grading) ? grading.execution_metrics : undefined;
    if (execution !== undefined && !object(execution)) throw new Error("execution_metrics must be an object");
    const measured = (metric: Metric, value: unknown, integer: boolean) => {
      if (value === undefined) return;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new Error(`Invalid measured ${metric}`);
      values[metric] = value;
    };
    if (object(timing)) {
      measured("time_seconds", timing.total_duration_seconds, false);
      measured("tokens", timing.total_tokens, true);
    }
    if (object(execution)) {
      if (values.tokens === null) measured("tokens", execution.total_tokens, true);
      measured("tool_calls", execution.total_tool_calls, true);
      measured("errors", execution.errors_encountered, true);
    }
    for (const metric of metrics) if (values[metric] === null) missing.push(`${metric}: not measured`);
    return { case: artifact.case, run: artifact.run, variant: artifact.variant, values, missing, expectations };
  });
  const summary: Benchmark["summary"] = Object.create(null);
  for (const variant of variants) {
    const variantRuns = runs.filter((r) => r.variant === variant);
    summary[variant] = Object.fromEntries(metrics.map((metric) => [metric, statistics(variantRuns.flatMap((r) => r.values[metric] === null ? [] : [r.values[metric]]))])) as Record<Metric, Statistics>;
  }
  const groups = new Map<string, MeasuredRun[]>();
  for (const run of runs) {
    const identity = JSON.stringify([run.case, run.run]);
    const group = groups.get(identity) ?? [];
    group.push(run);
    groups.set(identity, group);
  }
  const pairs: Benchmark["pairs"] = [];
  for (const group of groups.values()) {
    const primary = group.find((r) => r.variant === variants[0]);
    const baseline = group.find((r) => r.variant === variants[1]);
    const deltas = Object.fromEntries(metrics.map((metric) => [metric, null])) as Record<Metric, number | null>;
    const missing: string[] = [];
    if (!primary || !baseline) missing.push(`Unpaired variant: ${!primary ? variants[0] : variants[1]}`);
    for (const metric of metrics) {
      const a = primary?.values[metric];
      const b = baseline?.values[metric];
      if (a === undefined || a === null || b === undefined || b === null) { missing.push(`${metric}: pair lacks measurements`); continue; }
      if (metric === "pass_rate" && JSON.stringify(primary?.expectations) !== JSON.stringify(baseline?.expectations)) { missing.push("pass_rate: unlike expectation sets"); continue; }
      deltas[metric] = a - b;
    }
    pairs.push({ case: group[0].case, run: group[0].run, deltas, missing });
  }
  const pairedDelta = Object.fromEntries(metrics.map((metric) => [metric, statistics(pairs.flatMap((p) => p.deltas[metric] === null ? [] : [p.deltas[metric]]))])) as Record<Metric, Statistics>;
  return { variants, runs, summary, pairs, pairedDelta };
}

interface RunInput { case: string; run: number; variant: string; grading?: string; timing?: string }
interface Params { variants: string[]; runs: RunInput[] }
export default function factory(pi: ToolAPI): Tool<Params> {
  const T = pi.typebox.Type;
  return {
    name: "skill_benchmark", label: "Aggregate measured skill benchmark", approval: "read",
    description: "Aggregate explicitly selected grading/timing JSON artifacts; two variants in primary, baseline order. Compute sample mean/stddev/min/max and matched-case deltas. Missing evidence stays null, characters are never tokens. No model invocation or artifact/config writes.",
    parameters: T.Object({ variants: T.Array(T.String(), { minItems: 2, maxItems: 2 }), runs: T.Array(T.Object({ case: T.String(), run: T.Integer({ minimum: 1 }), variant: T.String(), grading: T.Optional(T.String()), timing: T.Optional(T.String()) }), { minItems: 1, maxItems: 1000 }) }),
    async execute(_id, params, _onUpdate, _ctx, signal) {
      if (!Array.isArray(params.runs) || params.runs.length > 1000) throw new Error("Expected bounded explicit run list");
      const artifacts: ArtifactRun[] = [];
      let bytes = 0;
      for (const run of params.runs) {
        signal?.throwIfAborted();
        const artifact: ArtifactRun = { case: run.case, run: run.run, variant: run.variant };
        for (const field of ["grading", "timing"] as const) {
          if (run[field] === undefined) continue;
          const file = await readWorkspaceFile(pi.cwd, run[field], 256 * 1024);
          bytes += file.bytes.length;
          if (bytes > 8 * 1024 * 1024) throw new Error("Benchmark artifacts exceed aggregate 8 MiB limit");
          artifact[field] = JSON.parse(decodeUtf8(file.bytes));
        }
        artifacts.push(artifact);
      }
      return result(aggregateBenchmark(params.variants, artifacts));
    },
  };
}
