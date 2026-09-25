// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/jev`: Jev (TypeSafe's calibrated decision model) as the
 * control plane around GPT.
 *
 * ```ts
 * const jev = JevClient.fromEnv(env);
 * await runAgent({ ..., approve: jevApprover(jev, { task }) });
 * const { effort } = await routeEffort(jev, task);
 * const { escalate } = await needsEscalation(jev, finding);
 * const { score } = await scoreOutput(jev, { task, output: turn.finalText });
 * ```
 *
 * Each helper asks one small, typed question and reads Jev's calibrated
 * probability through `@celld/api/jev`'s own banding and gating helpers, with
 * the thresholds as parameters. None hides a decision: every result carries
 * the probability or confidence it was made on.
 *
 * @module
 */

import {
  choice,
  gateChoice,
  type JevClient,
  mostLikelyLevel,
  normalizeScore,
  noul,
  noulBand,
  type NoulBands,
  score,
} from "@celld/api/jev";
import type {
  ApprovalDecision,
  ApprovalRequest,
  Approver,
  ReasoningEffort,
  ToolRisk,
} from "@celld/api/openai";
import type { Finding } from "@celld/api/openai/blueteam";

/** What the helpers need from a Jev client. `JevClient` is one. */
export type JevAsker = Pick<JevClient, "ask">;

const MAX_STATE_CHARS = 8_000;

function clip(text: string): string {
  return text.length > MAX_STATE_CHARS
    ? `${text.slice(0, MAX_STATE_CHARS / 2)}\n…[${
      text.length - MAX_STATE_CHARS
    } characters omitted]…\n${text.slice(text.length - MAX_STATE_CHARS / 2)}`
    : text;
}

/** How {@link jevApprover} decides. */
export interface JevApproverOptions {
  /** What the agent was asked to do; Jev judges calls against it. */
  readonly task?: string;
  /** Replaces the question. */
  readonly question?: string;
  /** Default `{yes: 0.8, no: 0.3}`: allow at 0.8 or more, deny at 0.3 or less. */
  readonly bands?: NoulBands;
  /** Risks allowed without asking; default `["read"]`. */
  readonly autoAllow?: readonly ToolRisk[];
  /** The middle band: deny (default), allow, or ask another approver (a human). */
  readonly onUncertain?: "deny" | "allow" | Approver;
  /** When Jev fails: deny (default) or allow. */
  readonly onError?: "deny" | "allow";
}

/** An approver that asks Jev whether each risky tool call is safe to run. */
export function jevApprover(
  jev: JevAsker,
  options: JevApproverOptions = {},
): Approver {
  const bands = options.bands ?? { yes: 0.8, no: 0.3 };
  const autoAllow = options.autoAllow ?? ["read"];
  const safe = noul(
    options.question ??
      "Is this tool call safe to run without a human reviewing it first?",
    {
      true:
        "It serves the task, touches only what the task needs, and cannot cause irreversible damage or leak secrets.",
      false:
        "It is destructive, out of scope, exfiltrates data, escalates privileges, or cannot be undone.",
    },
  );
  return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    if (autoAllow.includes(request.tool.risk)) return true;
    let probability: number;
    try {
      const { answers } = await jev.ask({
        state: {
          task: options.task ?? "(not stated)",
          tool: request.tool,
          call: clip(
            typeof request.args === "string"
              ? request.args
              : JSON.stringify(request.args, null, 2),
          ),
        },
        questions: { safe },
      });
      probability = answers.safe.noul;
    } catch (error) {
      if (options.onError === "allow") return true;
      return {
        allow: false,
        reason: `the safety check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const band = noulBand(probability, bands);
    if (band === "yes") return true;
    if (band === "no") {
      return {
        allow: false,
        reason: `judged unsafe (p(safe) = ${probability.toFixed(2)})`,
      };
    }
    const onUncertain = options.onUncertain ?? "deny";
    if (onUncertain === "allow") return true;
    if (onUncertain === "deny") {
      return {
        allow: false,
        reason: `needs human review (p(safe) = ${probability.toFixed(2)})`,
      };
    }
    return await onUncertain(request);
  };
}

const EFFORT_MEANING: Record<string, string> = {
  none: "A lookup or reformatting; no reasoning at all.",
  minimal: "Trivial; a sentence of thought.",
  low: "Routine and well specified; little ambiguity.",
  medium: "Everyday work with some ambiguity or several steps.",
  high: "Complex: subtle bugs, multi-file changes, security analysis.",
  xhigh: "Very hard: deep debugging, novel design, adversarial analysis.",
  max: "The hardest problems, where cost does not matter.",
};

/** A routing decision on reasoning effort. */
export interface EffortRoute {
  readonly effort: ReasoningEffort;
  /** Jev's confidence in its choice. */
  readonly confidence: number;
  /** False when confidence was under the floor and `fallback` was used. */
  readonly decided: boolean;
}

/**
 * Picks a reasoning effort for a task: Jev chooses among `efforts`
 * (default low, medium, high, xhigh), and below `floor` confidence
 * (default 0.5) the `fallback` (default `high`) is used instead.
 */
export async function routeEffort(
  jev: JevAsker,
  task: string | object,
  options: {
    readonly efforts?: readonly [
      ReasoningEffort,
      ReasoningEffort,
      ...ReasoningEffort[],
    ];
    readonly floor?: number;
    readonly fallback?: ReasoningEffort;
  } = {},
): Promise<EffortRoute> {
  const efforts = options.efforts ?? ["low", "medium", "high", "xhigh"];
  const criteria = Object.fromEntries(
    efforts.map((effort) => [effort, EFFORT_MEANING[effort] ?? null]),
  );
  const { answers } = await jev.ask({
    state: typeof task === "string" ? clip(task) : task,
    questions: {
      effort: choice(
        "How much reasoning does a capable model need to do this task well?",
        criteria,
      ),
    },
  });
  const floor = options.floor ?? 0.5;
  const { decision, choice: picked, confidence } = gateChoice(answers.effort, {
    floor,
  });
  return decision === "escalate"
    ? { effort: options.fallback ?? "high", confidence, decided: false }
    : { effort: picked as ReasoningEffort, confidence, decided: true };
}

/** Whether a finding needs a human now. */
export interface Escalation {
  readonly escalate: "yes" | "no" | "uncertain";
  readonly probability: number;
}

/**
 * Asks whether a security finding (or alert text) needs escalation to a
 * human now. Default bands `{yes: 0.7, no: 0.3}`.
 */
export async function needsEscalation(
  jev: JevAsker,
  finding: Finding | string,
  options: { readonly bands?: NoulBands; readonly context?: string } = {},
): Promise<Escalation> {
  const { answers } = await jev.ask({
    state: {
      ...(options.context === undefined ? {} : { context: options.context }),
      finding: typeof finding === "string" ? clip(finding) : finding,
    },
    questions: {
      escalate: noul(
        "Does this security finding need a human to act on it now?",
        {
          true:
            "Likely real, exploitable, and on something that matters: act today.",
          false:
            "Low impact, unlikely, or safely handled in the normal backlog.",
        },
      ),
    },
  });
  const probability = answers.escalate.noul;
  return {
    escalate: noulBand(probability, options.bands ?? { yes: 0.7, no: 0.3 }),
    probability,
  };
}

/** A graded output. */
export interface OutputScore {
  /** 0 (worst) to 1 (best): the expected level, normalised. */
  readonly score: number;
  /** The single most likely level, from 0. */
  readonly level: number;
  readonly confidence: number;
}

/** The default five-level rubric for {@link scoreOutput}. */
export const DEFAULT_RUBRIC = [
  "Wrong or harmful: does not do the task, or does damage.",
  "Poor: attempts the task with major errors or omissions.",
  "Acceptable: does the task with minor problems.",
  "Good: correct and complete, small room for improvement.",
  "Excellent: correct, complete, clear and well judged.",
] as const;

/** Grades a model's output against a task, on `rubric` (lowest first). */
export async function scoreOutput(
  jev: JevAsker,
  input: {
    readonly task: string;
    readonly output: string;
    readonly rubric?: readonly [string, string, ...string[]];
  },
): Promise<OutputScore> {
  const { answers } = await jev.ask({
    state: { task: clip(input.task), output: clip(input.output) },
    questions: {
      quality: score(
        "How well does the output accomplish the task?",
        input.rubric ?? DEFAULT_RUBRIC,
      ),
    },
  });
  return {
    score: normalizeScore(answers.quality),
    level: mostLikelyLevel(answers.quality),
    confidence: answers.quality.confidence,
  };
}
