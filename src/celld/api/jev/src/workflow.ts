// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Asking inside a Workflow step.
 *
 * A Workflow replays `run` from the top after every suspension, reusing the
 * stored result of each finished `step.do`, so the API call must live in a
 * step with a stable name or it would be paid for on every replay. Step
 * results must be structured-cloneable and at most 1 MiB, and a step that
 * throws keeps only its error's name and message; so {@link askStep} stores a
 * {@link JevOutcome}, which is plain data either way.
 *
 * Transient failures (rate limits, overload, 5xx, connection, timeout) that
 * outlast the client's own quick retries are thrown, so the step's durable
 * retries take over with their longer delays; every other failure is
 * returned as `{ok: false}`, since repeating it cannot help. When the step's
 * retries run out, `step.do` rejects and the Workflow run fails as usual.
 *
 * @module
 */

import type { AskOptions, JevClient, JevOutcome } from "./client.ts";
import type { JevRequest, Questions } from "./types.ts";

/** The step policy {@link askStep} uses unless given one. */
export const DEFAULT_STEP_CONFIG: WorkflowStepConfig = Object.freeze({
  retries: Object.freeze({
    limit: 5,
    delay: "10 seconds",
    backoff: "exponential",
  }) as WorkflowStepRetries,
  timeout: "2 minutes",
});

/**
 * Runs `client.tryAsk(request)` as the durable step `name` and returns its
 * outcome. Keep `name` stable across replays and unique within the run.
 *
 * ```ts
 * const outcome = await askStep(step, "triage", client, { state, questions });
 * if (outcome.ok) outcome.result.answers.team.choice;
 * ```
 */
export function askStep<const Qs extends Questions>(
  step: WorkflowStep,
  name: string,
  client: JevClient,
  request: JevRequest<Qs>,
  options: { readonly config?: WorkflowStepConfig; readonly ask?: AskOptions } =
    {},
): Promise<JevOutcome<Qs>> {
  return step.do(
    name,
    options.config ?? DEFAULT_STEP_CONFIG,
    async (): Promise<JevOutcome<Qs>> => {
      const outcome = await client.tryAsk(request, options.ask);
      if (!outcome.ok && outcome.error.retryable) {
        const error = new Error(outcome.error.message);
        error.name = `JevError(${outcome.error.kind})`;
        throw error;
      }
      return outcome;
    },
  );
}
