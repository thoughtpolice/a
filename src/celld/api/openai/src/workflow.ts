// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/workflow`: model calls and agent runs inside celld
 * Workflows, where `run` is replayed from the top after every suspension.
 *
 * ```ts
 * const outcome = await respondStep(step, "summarise", gpt, { input });
 *
 * const result = await runAgentWorkflow(step, "fix-bug", {
 *   client: gpt,
 *   conversation: new Conversation({ id: event.instanceId, instructions }).user(task),
 *   tools,
 * });
 * ```
 *
 * Each model turn is one step and each batch of tool calls is another, named
 * from the conversation's position (`fix-bug:turn-0`, `fix-bug:tools-0`,
 * ...). On replay the stored results are returned and recorded into the
 * conversation again, so it is rebuilt exactly: a finished turn is never
 * paid for twice and a finished tool batch never runs again. A batch whose
 * step failed is retried as a whole, every call in it, so only read-only
 * batches are ({@link DEFAULT_TOOLS_STEP}); a batch with a mutating call
 * gets {@link DEFAULT_MUTATING_TOOLS_STEP}, which fails the run instead.
 *
 * No retry policy covers a crash: when the isolate dies mid-batch, the
 * step has no stored result, and celld reruns `run` on resume, calling the
 * batch's callback again. So a mutating batch first records a marker step
 * (`<name>:start`); a replay that finds the marker stored but not the
 * batch knows an earlier attempt started it, and answers every mutating
 * call as `INTERRUPTED_CALL` ("may have run; check before repeating it")
 * while the read-only calls run again. The model decides what to redo.
 *
 * Keep the conversation's starting state deterministic (build it from the
 * event).
 *
 * Transient model failures that outlast the client's own retries are
 * thrown so the step's durable retries take over; permanent ones are
 * stored as plain data and end the run. A usage limit is permanent for the
 * step but has a known end: {@link waitForUsageReset} sleeps the Workflow
 * until then, which costs nothing while it waits.
 *
 * Step results are capped at 1 MiB. A turn carries its encrypted reasoning,
 * which is usually a few kilobytes and occasionally much more; a run with
 * very long tool outputs should keep `maxToolOutputChars` modest.
 *
 * @module
 */

import { nonNegativeMs } from "@celld/core/bounds";
import {
  type AgentOptions,
  type AgentResult,
  runAgent,
  type StepRunner,
} from "./agent.ts";
import type { CallOptions, GptClient, GptOutcome } from "./client.ts";
import type { GptErrorData } from "./errors.ts";
import type { GptRequest } from "./request.ts";

/** The step policy for model turns. */
export const DEFAULT_TURN_STEP: WorkflowStepConfig = Object.freeze({
  retries: Object.freeze({
    limit: 5,
    delay: "30 seconds",
    backoff: "exponential",
  }) as WorkflowStepRetries,
  timeout: "30 minutes",
});

/**
 * The step policy for tool batches whose calls are all read-only. The
 * registry never throws for a tool's own failure (it becomes the call's
 * output), so a retry here only covers the step itself being interrupted,
 * and repeating reads is harmless.
 */
export const DEFAULT_TOOLS_STEP: WorkflowStepConfig = Object.freeze({
  retries: Object.freeze({
    limit: 2,
    delay: "10 seconds",
    backoff: "constant",
  }) as WorkflowStepRetries,
  timeout: "15 minutes",
});

/**
 * The step policy for tool batches with a call that may change state: no
 * retries, since a retry would run the whole batch again, repeating
 * changes that may already have happened; the run fails instead. (A crash
 * is not a retry: see the module documentation for how a replay avoids
 * rerunning mutations.) A caller whose mutating tools are idempotent can
 * pass `unsafeRetryMutatingTools: true` to use the tools policy anyway.
 */
export const DEFAULT_MUTATING_TOOLS_STEP: WorkflowStepConfig = Object.freeze({
  retries: Object.freeze({
    limit: 0,
    delay: "10 seconds",
    backoff: "constant",
  }) as WorkflowStepRetries,
  timeout: "15 minutes",
});

function isOutcome(value: unknown): value is GptOutcome<unknown> {
  return typeof value === "object" && value !== null && "ok" in value &&
    typeof (value as { ok: unknown }).ok === "boolean";
}

function transient(error: GptErrorData): Error {
  const thrown = new Error(error.message);
  thrown.name = `GptError(${error.kind})`;
  return thrown;
}

/**
 * Runs `client.tryRespond(request)` as the durable step `name`. Keep `name`
 * stable across replays and unique within the run.
 */
export function respondStep(
  step: WorkflowStep,
  name: string,
  client: Pick<GptClient, "tryRespond">,
  request: GptRequest,
  options: {
    readonly config?: WorkflowStepConfig;
    readonly call?: CallOptions;
  } = {},
): Promise<GptOutcome> {
  return step.do(name, options.config ?? DEFAULT_TURN_STEP, async () => {
    const outcome = await client.tryRespond(request, options.call);
    if (!outcome.ok && outcome.error.retryable) throw transient(outcome.error);
    return outcome;
  });
}

/**
 * A {@link StepRunner} that makes each agent step a durable step. A tool
 * batch with a mutating call gets `mutatingTools` (default
 * {@link DEFAULT_MUTATING_TOOLS_STEP}, no retries) and a `<name>:start`
 * marker step before it, so that a replay after a crash answers its
 * mutating calls as interrupted instead of running them again; an all
 * read-only batch gets `tools`. `unsafeRetryMutatingTools` gives mutating
 * batches the `tools` policy and no marker, repeating their changes
 * whenever a step is retried or replayed: only for idempotent tools.
 */
export function workflowSteps(
  step: WorkflowStep,
  options: {
    /** Prepended to step names; include a separator. */
    readonly prefix?: string;
    readonly turn?: WorkflowStepConfig;
    readonly tools?: WorkflowStepConfig;
    readonly mutatingTools?: WorkflowStepConfig;
    readonly unsafeRetryMutatingTools?: boolean;
  } = {},
): StepRunner {
  const prefix = options.prefix ?? "";
  const tools = options.tools ?? DEFAULT_TOOLS_STEP;
  const mutating = options.unsafeRetryMutatingTools === true
    ? tools
    : options.mutatingTools ?? DEFAULT_MUTATING_TOOLS_STEP;
  const unsafe = options.unsafeRetryMutatingTools === true;
  return async (name, kind, run, info) => {
    const config = kind === "turn"
      ? options.turn ?? DEFAULT_TURN_STEP
      : info?.mutates === false
      ? tools
      : mutating;
    // A mutating batch: `fresh` says whether its marker was recorded by
    // this very attempt. When the marker comes back stored while the batch
    // itself has no result, an earlier attempt started the batch and died.
    let fresh = true;
    if (kind === "tools" && info?.mutates !== false && !unsafe) {
      fresh = false;
      await step.do(`${prefix}${name}:start`, config, () => {
        fresh = true;
        return true;
      });
    }
    return await step.do(`${prefix}${name}`, config, async () => {
      const result = await (fresh ? run() : run({ interrupted: true }));
      if (
        kind === "turn" && isOutcome(result) && !result.ok &&
        result.error.retryable
      ) {
        throw transient(result.error);
      }
      return result as never;
    });
  };
}

/** {@link runAgent} with every turn and tool batch as a durable step. */
export function runAgentWorkflow(
  step: WorkflowStep,
  name: string,
  options: Omit<AgentOptions, "steps"> & {
    readonly turnStep?: WorkflowStepConfig;
    /** For all read-only tool batches. */
    readonly toolsStep?: WorkflowStepConfig;
    /** For tool batches with a mutating call; default no retries. */
    readonly mutatingToolsStep?: WorkflowStepConfig;
    /** See {@link workflowSteps}. */
    readonly unsafeRetryMutatingTools?: boolean;
  },
): Promise<AgentResult> {
  return runAgent({
    ...options,
    steps: workflowSteps(step, {
      prefix: `${name}:`,
      turn: options.turnStep,
      tools: options.toolsStep,
      mutatingTools: options.mutatingToolsStep,
      unsafeRetryMutatingTools: options.unsafeRetryMutatingTools,
    }),
  });
}

/** The longest {@link waitForUsageReset} sleeps: 8 days. */
export const MAX_USAGE_RESET_WAIT_MS = 8 * 24 * 60 * 60 * 1000;

/** The largest `marginMs` {@link waitForUsageReset} takes: one hour. */
export const MAX_USAGE_RESET_MARGIN_MS = 60 * 60 * 1000;

/**
 * Sleeps the Workflow until a usage limit resets (plus `marginMs`, default
 * one minute, at most {@link MAX_USAGE_RESET_MARGIN_MS}). Returns false,
 * without sleeping, for any other error, when the reset time is unknown,
 * or when it is not a finite time within {@link MAX_USAGE_RESET_WAIT_MS}
 * of now (the time comes from the server).
 *
 * @throws {RangeError} `marginMs` is not a duration from 0 to
 * {@link MAX_USAGE_RESET_MARGIN_MS}.
 */
export async function waitForUsageReset(
  step: WorkflowStep,
  name: string,
  error: GptErrorData,
  options: { readonly marginMs?: number } = {},
): Promise<boolean> {
  const marginMs = nonNegativeMs(options.marginMs ?? 60_000, {
    name: "marginMs",
    max: MAX_USAGE_RESET_MARGIN_MS,
  });
  if (error.kind !== "usage_limit" || error.resetsAt === null) return false;
  const until = error.resetsAt + marginMs;
  if (
    typeof error.resetsAt !== "number" || !Number.isFinite(until) ||
    until - Date.now() > MAX_USAGE_RESET_WAIT_MS
  ) {
    return false;
  }
  await step.sleepUntil(name, until);
  return true;
}
