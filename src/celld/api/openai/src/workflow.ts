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
 * paid for twice and a finished tool call never runs again. Keep the
 * conversation's starting state deterministic (build it from the event).
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
 * The step policy for tool batches. The registry never throws for a tool's
 * own failure (it becomes the call's output), so a retry here only covers
 * the step itself being interrupted.
 */
export const DEFAULT_TOOLS_STEP: WorkflowStepConfig = Object.freeze({
  retries: Object.freeze({
    limit: 2,
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

/** A {@link StepRunner} that makes each agent step a durable step. */
export function workflowSteps(
  step: WorkflowStep,
  options: {
    /** Prepended to step names; include a separator. */
    readonly prefix?: string;
    readonly turn?: WorkflowStepConfig;
    readonly tools?: WorkflowStepConfig;
  } = {},
): StepRunner {
  const prefix = options.prefix ?? "";
  return (name, kind, run) =>
    step.do(
      `${prefix}${name}`,
      kind === "turn"
        ? options.turn ?? DEFAULT_TURN_STEP
        : options.tools ?? DEFAULT_TOOLS_STEP,
      async () => {
        const result = await run();
        if (
          kind === "turn" && isOutcome(result) && !result.ok &&
          result.error.retryable
        ) {
          throw transient(result.error);
        }
        return result as never;
      },
    );
}

/** {@link runAgent} with every turn and tool batch as a durable step. */
export function runAgentWorkflow(
  step: WorkflowStep,
  name: string,
  options: Omit<AgentOptions, "steps"> & {
    readonly turnStep?: WorkflowStepConfig;
    readonly toolsStep?: WorkflowStepConfig;
  },
): Promise<AgentResult> {
  return runAgent({
    ...options,
    steps: workflowSteps(step, {
      prefix: `${name}:`,
      turn: options.turnStep,
      tools: options.toolsStep,
    }),
  });
}

/**
 * Sleeps the Workflow until a usage limit resets (plus `marginMs`, default
 * one minute). Returns false, without sleeping, for any other error or when
 * the reset time is unknown.
 */
export async function waitForUsageReset(
  step: WorkflowStep,
  name: string,
  error: GptErrorData,
  options: { readonly marginMs?: number } = {},
): Promise<boolean> {
  if (error.kind !== "usage_limit" || error.resetsAt === null) return false;
  await step.sleepUntil(name, error.resetsAt + (options.marginMs ?? 60_000));
  return true;
}
