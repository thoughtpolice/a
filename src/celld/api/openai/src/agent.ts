// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A bounded agent loop: ask the model, run the tools it calls, feed the
 * results back, and stop when it answers without calling a tool or a bound
 * is reached.
 *
 * ```ts
 * const result = await runAgent({
 *   client: gpt,
 *   conversation: new Conversation({ instructions: CODING_INSTRUCTIONS }).user(task),
 *   tools: new ToolRegistry([applyPatchTool(fs), ...readOnlyTools(fs)]),
 *   maxTurns: 30,
 *   budget: { tokens: 2_000_000, timeMs: 20 * 60_000 },
 *   approve: jevApprover(jev), // from @celld/api/openai/jev
 * });
 * result.stopReason; // "completed" | "max_turns" | "token_budget" | "time_budget"
 * ```
 *
 * The bounds are checked between steps, never in the middle of one: a
 * model turn in flight finishes, and a batch of tool calls either runs or,
 * once a budget is spent, is answered with "not run" outputs, so the
 * conversation is always valid to resume (the backend refuses a call
 * without an output).
 *
 * Each model turn and each batch of tool calls goes through a
 * {@link StepRunner}. The default just runs them; the Workflow runner in
 * `@celld/api/openai/workflow` makes each one a durable step, so a replayed
 * Workflow neither pays for a finished turn twice nor reruns a finished
 * tool batch. A batch whose step was interrupted (an evicted isolate) has
 * no stored result, and celld reruns its callback on replay whatever the
 * retry policy says; the runner then passes `{interrupted: true}` to the
 * batch (see {@link StepResume}), which answers every mutating call as
 * {@link INTERRUPTED_CALL} instead of running it again, and reruns only
 * the read-only ones.
 *
 * A call is never run twice by the loop itself either. When `signal`
 * aborts mid-batch, every call's execution (finished, stopped or never
 * started) is recorded in the conversation before the abort is rethrown,
 * so nothing is left pending. A conversation that does come back with
 * pending calls (its run died between the turn and the save of its
 * results) has its mutating calls answered as {@link INTERRUPTED_CALL},
 * since they may have run; `unsafeRerunPendingMutations` runs them again.
 *
 * @module
 */

import { finite, nonNegativeMs, safeInt } from "@celld/core/bounds";
import { defaultRuntime, type Runtime } from "@celld/http";
import type { CallOptions, GptOutcome } from "./client.ts";
import { type Conversation, type ConversationData } from "./conversation.ts";
import { GptError, gptErrorFromData } from "./errors.ts";
import type { StreamEvent } from "./events.ts";
import { addUsage, ZERO_USAGE } from "./items.ts";
import type { GptRequest } from "./request.ts";
import {
  type Approver,
  MAX_OUTPUT_CHARS,
  MAX_TOOL_TIMEOUT_MS,
  MIN_OUTPUT_CHARS,
  ToolBatchAbortedError,
  type ToolExecution,
  ToolRegistry,
} from "./tools.ts";
import type { ToolCall, Turn, Usage } from "./types.ts";

/** What the loop needs from a client. `GptClient` is one. */
export interface Responder {
  tryRespond(request: GptRequest, options?: CallOptions): Promise<GptOutcome>;
}

/** What a {@link StepRunner} is told about a step besides its name. */
export interface StepInfo {
  /**
   * For a tool batch: whether any call in it may change state (its tool
   * `mutates`, or it is unknown). Running such a batch twice repeats
   * those changes, so a durable runner must not retry it.
   */
  readonly mutates: boolean;
}

/**
 * What a {@link StepRunner} may tell a tool batch it runs: `interrupted`
 * when an earlier attempt at this batch started and never recorded its
 * result, so its mutating calls may have run. The batch then answers
 * those as {@link INTERRUPTED_CALL} and runs only the read-only ones.
 */
export interface StepResume {
  readonly interrupted: true;
}

/**
 * The answer to a mutating call that may have run already but whose
 * result was never recorded.
 */
export const INTERRUPTED_CALL =
  "interrupted before its result was recorded; it may have run; check before repeating it";

/**
 * Runs one step of the loop. `name` is stable for a given conversation
 * state (`turn-3`, then `tools-3` for that turn's calls), which is what
 * makes durable replay work. `run` takes an optional {@link StepResume};
 * runners that know nothing of it call `run()`.
 */
export type StepRunner = <T>(
  name: string,
  kind: "turn" | "tools",
  run: (resume?: StepResume) => Promise<T>,
  info?: StepInfo,
) => Promise<T>;

/** Runs each step directly. */
export const directSteps: StepRunner = (_name, _kind, run) => run();

/**
 * Limits on a whole run. `runAgent` throws a `RangeError` for a value that
 * is not a non-negative (whole, for tokens) finite number.
 */
export interface AgentBudget {
  /** Stop once this many total tokens have been used. */
  readonly tokens?: number;
  /** Stop once this much time has passed. */
  readonly timeMs?: number;
}

/** Why the loop stopped. */
export type AgentStopReason =
  | "completed"
  | "max_turns"
  | "token_budget"
  | "time_budget";

/** Progress, for logs and UIs. */
export type AgentEvent =
  | {
    readonly type: "stream";
    readonly turn: number;
    readonly event: StreamEvent;
  }
  | { readonly type: "turn"; readonly turn: number; readonly result: Turn }
  | {
    readonly type: "tools";
    readonly turn: number;
    readonly executions: readonly ToolExecution[];
  };

/** How to run the loop. */
export interface AgentOptions {
  readonly client: Responder;
  /** The conversation so far; the loop appends to it. */
  readonly conversation: Conversation;
  readonly tools?: ToolRegistry;
  /** Model turns at most; default 20. */
  readonly maxTurns?: number;
  readonly budget?: AgentBudget;
  /** Consulted before each tool call; default: allow everything. */
  readonly approve?: Approver;
  /** Request settings for every turn (reasoning, verbosity, format...). */
  readonly request?: Omit<GptRequest, "input" | "tools">;
  readonly call?: Omit<CallOptions, "signal" | "onEvent">;
  /** Per tool call; default 60 s, at most `MAX_TOOL_TIMEOUT_MS`. */
  readonly toolTimeoutMs?: number;
  /**
   * How long a timed-out tool call gets to stop before it is reported as
   * abandoned; `ExecuteOptions.cancelGraceMs`, default 5 s.
   */
  readonly toolCancelGraceMs?: number;
  /**
   * Default 20,000 characters; from `MIN_OUTPUT_CHARS` to
   * `MAX_OUTPUT_CHARS`.
   */
  readonly maxToolOutputChars?: number;
  /** Tool calls at once; default 4. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly steps?: StepRunner;
  readonly runtime?: Runtime;
  /**
   * UNSAFE: run a resumed conversation's pending mutating calls again
   * rather than answering them as {@link INTERRUPTED_CALL}. They may have
   * run before the previous run died; only for idempotent tools.
   */
  readonly unsafeRerunPendingMutations?: boolean;
}

/** How a run ended. Plain data. */
export interface AgentResult {
  readonly stopReason: AgentStopReason;
  /** The last turn's final text ("" if the last turn only called tools). */
  readonly text: string;
  /** Model turns taken in this run. */
  readonly turns: number;
  /** Tool calls answered in this run. */
  readonly toolCalls: number;
  /** Usage of this run. */
  readonly usage: Usage;
  readonly lastTurn: Turn | null;
  /** The conversation afterwards. */
  readonly conversation: ConversationData;
}

/**
 * Runs the loop.
 *
 * @throws {GptError} a model call that failed after its retries; the
 * conversation keeps everything up to the failure, so it can be resumed.
 * An abort (`GptAbortError`) during a tool batch comes after the batch's
 * executions were recorded.
 * @throws {RangeError} for a bound or tool option out of range, before
 * anything runs.
 */
export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const runtime = options.runtime ?? defaultRuntime;
  const steps = options.steps ?? directSteps;
  const tools = options.tools ?? new ToolRegistry();
  const maxTurns = options.maxTurns ?? 20;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new RangeError(
      `maxTurns must be a positive integer, got ${maxTurns}`,
    );
  }
  const budget = options.budget;
  if (budget?.tokens !== undefined) {
    safeInt(budget.tokens, { name: "budget.tokens", min: 0 });
  }
  if (budget?.timeMs !== undefined) {
    finite(budget.timeMs, { name: "budget.timeMs", min: 0 });
  }
  if (options.toolTimeoutMs !== undefined) {
    nonNegativeMs(options.toolTimeoutMs, {
      name: "toolTimeoutMs",
      max: MAX_TOOL_TIMEOUT_MS,
    });
  }
  if (options.maxToolOutputChars !== undefined) {
    safeInt(options.maxToolOutputChars, {
      name: "maxToolOutputChars",
      min: MIN_OUTPUT_CHARS,
      max: MAX_OUTPUT_CHARS,
    });
  }
  if (options.concurrency !== undefined) {
    safeInt(options.concurrency, { name: "concurrency", min: 1 });
  }
  const conversation = options.conversation;
  const started = runtime.now();
  let usage: Usage = ZERO_USAGE;
  let turns = 0;
  let toolCalls = 0;
  let last: Turn | null = null;
  const definitions = tools.definitions();

  const over = (): AgentStopReason | null => {
    const budget = options.budget;
    if (budget?.tokens !== undefined && usage.totalTokens >= budget.tokens) {
      return "token_budget";
    }
    if (
      budget?.timeMs !== undefined && runtime.now() - started >= budget.timeMs
    ) {
      return "time_budget";
    }
    return null;
  };
  const finish = (stopReason: AgentStopReason): AgentResult => ({
    stopReason,
    text: last?.finalText ?? "",
    turns,
    toolCalls,
    usage,
    lastTurn: last,
    conversation: conversation.toJSON(),
  });
  const record = (index: number, executions: readonly ToolExecution[]) => {
    conversation.push(...executions.map((execution) => execution.item));
    toolCalls += executions.length;
    options.onEvent?.({ type: "tools", turn: index, executions });
  };
  const answer = async (
    calls: readonly ToolCall[],
    skip?: string,
    pending = false,
  ) => {
    // The batch answers the latest turn: `tools-N` follows `turn-N`.
    const index = Math.max(0, conversation.turns - 1);
    // A skipped batch runs nothing; otherwise any call that may mutate
    // makes the batch unsafe to repeat.
    const mutates = skip === undefined &&
      calls.some((call) => tools.get(call.name)?.mutates !== false);
    let executions: ToolExecution[];
    try {
      executions = await steps(
        `tools-${index}`,
        "tools",
        (resume) => {
          const interrupted = resume?.interrupted === true ||
            (pending && options.unsafeRerunPendingMutations !== true);
          return tools.execute(calls, {
            signal: options.signal,
            approve: options.approve,
            timeoutMs: options.toolTimeoutMs,
            cancelGraceMs: options.toolCancelGraceMs,
            maxOutputChars: options.maxToolOutputChars,
            concurrency: options.concurrency,
            turn: index,
            runtime,
            ...(skip === undefined ? {} : { skip }),
            ...(interrupted ? { skipMutating: INTERRUPTED_CALL } : {}),
          });
        },
        { mutates },
      );
    } catch (error) {
      // Aborted mid-batch: record what every call did before rethrowing,
      // so none is left pending and run again on resume.
      if (
        error instanceof ToolBatchAbortedError &&
        error.executions.length === calls.length &&
        conversation.pendingCalls().length === calls.length
      ) {
        record(index, error.executions);
      }
      throw error;
    }
    record(index, executions);
  };

  // A conversation resumed between a turn and its tools answers them
  // first; its mutating calls may have run already (see the module doc).
  const resumed = conversation.pendingCalls();
  if (resumed.length > 0) {
    const stop = over();
    await answer(
      resumed,
      stop === null ? undefined : "the run's budget is spent",
      true,
    );
    if (stop !== null) return finish(stop);
  }

  while (turns < maxTurns) {
    const stop = over();
    if (stop !== null) return finish(stop);
    const index = conversation.turns;
    const outcome = await steps(
      `turn-${index}`,
      "turn",
      () =>
        options.client.tryRespond(
          conversation.request({
            ...options.request,
            ...(definitions.length > 0
              ? {
                tools: definitions,
                // Parallel calls only when nothing can conflict; the
                // registry serializes mutations regardless.
                parallelToolCalls: options.request?.parallelToolCalls ??
                  tools.readOnly,
              }
              : {}),
          }),
          {
            ...options.call,
            signal: options.signal,
            onEvent: options.onEvent === undefined
              ? undefined
              : (event) =>
                options.onEvent!({ type: "stream", turn: index, event }),
          },
        ),
    );
    if (!outcome.ok) throw gptErrorFromData(outcome.error);
    const turn = outcome.result;
    conversation.record(turn);
    usage = addUsage(usage, turn.usage);
    turns++;
    last = turn;
    options.onEvent?.({ type: "turn", turn: index, result: turn });
    const calls = conversation.pendingCalls();
    if (calls.length === 0) return finish("completed");
    const spent = over();
    await answer(
      calls,
      spent === null ? undefined : "the run's budget is spent",
    );
    if (spent !== null) return finish(spent);
  }
  return finish("max_turns");
}

/** {@link runAgent}, with a failed model call returned as plain data. */
export async function tryRunAgent(
  options: AgentOptions,
): Promise<GptOutcome<AgentResult>> {
  try {
    return { ok: true, result: await runAgent(options) };
  } catch (error) {
    if (error instanceof GptError) return { ok: false, error: error.toJSON() };
    throw error;
  }
}
