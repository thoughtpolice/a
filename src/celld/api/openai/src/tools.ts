// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed tools and the registry that runs the model's calls to them.
 *
 * ```ts
 * const lookup = functionTool({
 *   name: "lookup_cve",
 *   description: "Fetch a CVE record by id.",
 *   parameters: v.object({ id: v.string().regex(/^CVE-\\d{4}-\\d+$/) }),
 *   risk: "network",
 *   run: async ({ id }) => await nvd(id), // id: string
 * });
 * const tools = new ToolRegistry([lookup, applyPatchTool(fs)]);
 * ```
 *
 * Function tools declare their parameters with a `@celld/sieve` schema, so
 * the model sees a strict JSON Schema (sieve's `openai-strict` target), the
 * handler gets the parsed, typed arguments, and arguments that do not
 * match are refused before the handler runs. Custom
 * tools take free text, optionally constrained by a Lark or regex grammar
 * (as `apply_patch` is).
 *
 * Nothing a tool does can throw out of the registry: bad arguments, unknown
 * tools, denials, timeouts and handler errors all become the call's output
 * text, which goes back to the model so it can correct itself.
 *
 * A call that times out or is cancelled is not simply abandoned: its
 * `context.signal` aborts, and the registry waits for the handler to
 * settle (a sandbox bridge settles once the sandbox has killed the command
 * or the patch has stopped between two files) before it reports the
 * timeout. A handler that has not settled within `cancelGraceMs` (default
 * 5 s) is reported as `abandoned`, and logged.
 *
 * Every tool declares whether it `mutates` (default true). Mutating calls
 * run one at a time per workspace (the tool's `workspace` key, or the
 * registry's own for tools that name none), in call order, across every
 * execution that shares the key: a call takes its place before its
 * approval is awaited, so a slow approval holds back the calls after it on
 * that workspace rather than letting them run first. Read-only calls
 * overlap up to `concurrency`. A workspace whose call was abandoned
 * refuses further mutations until that call settles. `runAgent` lets the
 * model call tools in parallel only when every registered tool is
 * read-only ({@link ToolRegistry.readOnly}); the registry serializes
 * regardless.
 *
 * @module
 */

import { MAX_TIMER_MS, nonNegativeMs, safeInt } from "@celld/core/bounds";
import { defaultRuntime, type Runtime } from "@celld/http";
import type { AnySchema, Output, Schema } from "@celld/sieve";
import { toJSONSchema } from "@celld/sieve/json-schema";
import { GptAbortError } from "./errors.ts";
import { outputFor } from "./items.ts";
import {
  formatIssues,
  type JsonObject,
  type JsonValue,
  tryParseJson,
} from "./json.ts";
import type {
  CustomToolCallOutputItem,
  CustomToolFormat,
  FunctionCallOutputItem,
  ToolCall,
  ToolDefinition,
} from "./types.ts";

/**
 * What a tool can do, for approval policies: `read` observes, `write`
 * changes files, `exec` runs commands, `network` reaches other systems.
 */
export type ToolRisk = "read" | "write" | "exec" | "network" | "other";

/** What a handler gets besides its arguments. */
export interface ToolContext {
  /**
   * Aborted on timeout or when the caller cancels. A handler that changes
   * anything must stop doing so when it fires, and settle only once it has
   * stopped: the registry reports the timeout when the handler settles (or
   * after `cancelGraceMs`, as abandoned).
   */
  readonly signal: AbortSignal;
  readonly call: ToolCall;
  /** The agent turn, from 0; 0 outside an agent loop. */
  readonly turn: number;
}

/** A handler's result: text as is, anything else as JSON. */
export type ToolResult = string | JsonValue | undefined;

/** A function tool with typed arguments. */
export interface FunctionTool<A = unknown> {
  readonly kind: "function";
  readonly name: string;
  readonly description: string;
  /** Parses the model's arguments; `run` gets its output. */
  // deno-lint-ignore no-explicit-any
  readonly parameters: Schema<A, any>;
  /** The parameters' JSON Schema, as sent to the model. */
  readonly jsonSchema: JsonObject;
  /** Server-side strict argument decoding; default true. */
  readonly strict: boolean;
  readonly risk: ToolRisk;
  /** See {@link ToolSpecBase.mutates}. */
  readonly mutates: boolean;
  /** See {@link ToolSpecBase.workspace}. */
  readonly workspace?: object;
  /** Overrides the registry's per-call timeout. */
  readonly timeoutMs?: number;
  run(args: A, context: ToolContext): ToolResult | Promise<ToolResult>;
}

/** A custom (freeform) tool. */
export interface CustomTool {
  readonly kind: "custom";
  readonly name: string;
  readonly description: string;
  readonly format?: CustomToolFormat;
  readonly risk: ToolRisk;
  /** See {@link ToolSpecBase.mutates}. */
  readonly mutates: boolean;
  /** See {@link ToolSpecBase.workspace}. */
  readonly workspace?: object;
  readonly timeoutMs?: number;
  run(input: string, context: ToolContext): ToolResult | Promise<ToolResult>;
}

/** What every tool spec may say besides its name and handler. */
export interface ToolSpecBase {
  readonly risk?: ToolRisk;
  /**
   * Whether a call can change state (files, processes, anything outside
   * the call). Default true: only a tool proven read-only should say
   * false, since read-only calls run concurrently with everything.
   */
  readonly mutates?: boolean;
  /**
   * What the tool changes, as an identity: mutating calls with the same
   * `workspace` never run at once. Tools over one sandbox or file system
   * pass the same object. Default: the registry's own key, shared by every
   * tool that names none.
   */
  readonly workspace?: object;
  /**
   * Overrides the registry's per-call timeout: a number of milliseconds
   * from 0 to {@link MAX_TOOL_TIMEOUT_MS}, checked when the tool is made.
   */
  readonly timeoutMs?: number;
}

/** The longest per-call timeout: the longest timer a runtime can set. */
export const MAX_TOOL_TIMEOUT_MS = MAX_TIMER_MS;

function checkTimeout(value: unknown, name: string): number {
  return nonNegativeMs(value, { name, max: MAX_TOOL_TIMEOUT_MS });
}

function toolExtras(spec: ToolSpecBase) {
  if (spec.mutates !== undefined && typeof spec.mutates !== "boolean") {
    throw new TypeError("mutates must be a boolean");
  }
  if (spec.timeoutMs !== undefined) checkTimeout(spec.timeoutMs, "timeoutMs");
  if (
    spec.workspace !== undefined &&
    (spec.workspace === null ||
      (typeof spec.workspace !== "object" &&
        typeof spec.workspace !== "function"))
  ) {
    throw new TypeError("workspace must be an object");
  }
  return {
    risk: spec.risk ?? "other",
    mutates: spec.mutates ?? true,
    ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
  };
}

/** Any tool. */
// deno-lint-ignore no-explicit-any
export type Tool = FunctionTool<any> | CustomTool;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

function checkSpec(name: string, description: string): void {
  if (!NAME.test(name)) {
    throw new TypeError(
      `tool name ${
        JSON.stringify(name)
      } must be 1 to 64 letters, digits, _ or -`,
    );
  }
  if (description.trim() === "") {
    throw new TypeError(`tool ${name} needs a description`);
  }
}

/**
 * The JSON Schema a function tool sends for `parameters`. A strict tool
 * uses sieve's `openai-strict` target, which throws on anything strict mode
 * would refuse (an `.optional()` key, a loose object). A non-strict one is
 * the input schema without `$schema`; use `v.strictObject` to keep
 * `additionalProperties: false` there, since a stripping `v.object`
 * accepts (and drops) unknown keys.
 *
 * @throws {TypeError} the root is not an object, or a strict tool's
 * parameters are not valid in strict mode.
 */
export function parametersSchema(
  name: string,
  parameters: AnySchema,
  strict: boolean,
): JsonObject {
  const root = toJSONSchema(parameters, {
    io: "input",
    unrepresentable: "any",
  });
  if (root.type !== "object") {
    throw new TypeError(`tool ${name} parameters must be an object schema`);
  }
  let json: JsonObject;
  try {
    json = (strict
      ? toJSONSchema(parameters, { target: "openai-strict" })
      : toJSONSchema(parameters, {
        io: "input",
        $schema: false,
      })) as JsonObject;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      strict
        ? `tool ${name} is strict but its parameters are not: ${reason}; pass strict: false`
        : `tool ${name} parameters have no JSON Schema: ${reason}`,
    );
  }
  return json;
}

/** A function tool; `run` gets the arguments `parameters` parsed. */
export function functionTool<S extends AnySchema>(
  spec: ToolSpecBase & {
    readonly name: string;
    readonly description: string;
    readonly parameters: S;
    readonly strict?: boolean;
    run(
      args: Output<S>,
      context: ToolContext,
    ): ToolResult | Promise<ToolResult>;
  },
): FunctionTool<Output<S>> {
  checkSpec(spec.name, spec.description);
  const strict = spec.strict ?? true;
  return Object.freeze({
    kind: "function" as const,
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    jsonSchema: parametersSchema(spec.name, spec.parameters, strict),
    strict,
    ...toolExtras(spec),
    run: spec.run,
  });
}

/** A custom tool; `run` gets the model's text. */
export function customTool(
  spec: ToolSpecBase & {
    readonly name: string;
    readonly description: string;
    readonly format?: CustomToolFormat;
    run(input: string, context: ToolContext): ToolResult | Promise<ToolResult>;
  },
): CustomTool {
  checkSpec(spec.name, spec.description);
  return Object.freeze({
    kind: "custom" as const,
    name: spec.name,
    description: spec.description,
    ...(spec.format === undefined ? {} : { format: spec.format }),
    ...toolExtras(spec),
    run: spec.run,
  });
}

/** The wire definition of a tool. */
export function toolDefinition(tool: Tool): ToolDefinition {
  return tool.kind === "function"
    ? {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
      strict: tool.strict,
    }
    : {
      type: "custom",
      name: tool.name,
      description: tool.description,
      ...(tool.format === undefined ? {} : { format: tool.format }),
    };
}

/** A tool call awaiting approval, as plain data (it can go to Jev). */
export interface ApprovalRequest {
  readonly call: ToolCall;
  readonly tool: {
    readonly name: string;
    readonly kind: "function" | "custom";
    readonly description: string;
    readonly risk: ToolRisk;
  };
  /**
   * The arguments as the model sent them (they passed `parameters`), or
   * the custom tool's input text.
   */
  readonly args: JsonValue;
  readonly turn: number;
}

/** An approval: `true`/`{allow: true}`, or a denial with its reason. */
export type ApprovalDecision =
  | boolean
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

/** Decides whether a call may run. */
export type Approver = (
  request: ApprovalRequest,
) => ApprovalDecision | Promise<ApprovalDecision>;

/**
 * An approver that allows the listed risks outright and asks `otherwise`
 * (default: deny) about the rest.
 */
export function approveByRisk(policy: {
  readonly allow: readonly ToolRisk[];
  readonly otherwise?: Approver;
}): Approver {
  return (request) =>
    policy.allow.includes(request.tool.risk)
      ? true
      : policy.otherwise?.(request) ??
        { allow: false, reason: `${request.tool.risk} tools need approval` };
}

/** How a call ended. */
export type ToolStatus =
  | "ok"
  | "error"
  | "invalid_arguments"
  | "unknown_tool"
  | "denied"
  | "timeout"
  | "skipped";

/** One executed (or refused) call. Plain data. */
export interface ToolExecution {
  readonly callId: string;
  readonly name: string;
  readonly status: ToolStatus;
  /** The text sent back to the model. */
  readonly output: string;
  readonly durationMs: number;
  /** The item to append to the conversation. */
  readonly item: FunctionCallOutputItem | CustomToolCallOutputItem;
  /**
   * True when the call timed out or was cancelled and its handler had not
   * stopped within `cancelGraceMs`: it may still be running. Absent
   * otherwise.
   */
  readonly abandoned?: true;
}

/** The default {@link ExecuteOptions.cancelGraceMs}: five seconds. */
export const DEFAULT_CANCEL_GRACE_MS = 5_000;

/** How {@link ToolRegistry.execute} runs calls. */
export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  /** Consulted before each call runs; default: allow everything. */
  readonly approve?: Approver;
  /** Per-call timeout; default 60 s, at most {@link MAX_TOOL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * How long a timed-out or cancelled call's handler gets to stop after its
   * signal fires, before the call is reported as `abandoned`; default
   * {@link DEFAULT_CANCEL_GRACE_MS}.
   */
  readonly cancelGraceMs?: number;
  /**
   * Called with each abandoned execution; default `console.warn`. An
   * abandoned handler may still be changing the workspace.
   */
  readonly onAbandoned?: (execution: ToolExecution) => void;
  /**
   * Output longer than this is cut in the middle; default 20,000
   * characters (about Codex's 10,000-token truncation policy, halved). A
   * whole number from {@link MIN_OUTPUT_CHARS} to {@link MAX_OUTPUT_CHARS}.
   */
  readonly maxOutputChars?: number;
  /**
   * Calls run at once; default 4. Mutating calls on one workspace still
   * run one at a time.
   */
  readonly concurrency?: number;
  readonly turn?: number;
  readonly runtime?: Runtime;
  /** When set, no call runs; each gets this reason as a `skipped` output. */
  readonly skip?: string;
  /**
   * When set, no call to a tool that mutates runs: each gets this reason
   * as a `skipped` output, while read-only calls run. For calls that may
   * already have run once (a resumed conversation, a replayed Workflow
   * step), where running a mutation again would repeat it.
   */
  readonly skipMutating?: string;
}

/** The least {@link ExecuteOptions.maxOutputChars}. */
export const MIN_OUTPUT_CHARS = 100;
/** The most {@link ExecuteOptions.maxOutputChars}. */
export const MAX_OUTPUT_CHARS = 10_000_000;

/**
 * What {@link ToolRegistry.execute} throws when its `signal` aborts: a
 * {@link GptAbortError} that also carries one execution per call, in call
 * order, so the calls that finished are recorded rather than left pending
 * (and run again on resume). Calls that never started are `skipped`
 * ("not run: aborted"); calls stopped midway say so, or carry the error
 * their handler stopped with; an abandoned call is marked `abandoned`.
 */
export class ToolBatchAbortedError extends GptAbortError {
  readonly executions: readonly ToolExecution[];

  constructor(executions: readonly ToolExecution[], cause: unknown) {
    super("tool execution was aborted", { cause });
    this.executions = executions;
  }
}

/** Cuts `text` to `max` characters, keeping the head and the tail. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (omitted: number) => `\n…[${omitted} characters omitted]…\n`;
  const room = Math.max(0, max - marker(text.length).length);
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return text.slice(0, head) + marker(text.length - room) +
    (tail > 0 ? text.slice(text.length - tail) : "");
}

function render(result: ToolResult): string {
  if (result === undefined) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDecision(
  decision: ApprovalDecision,
): { allow: boolean; reason: string } {
  if (decision === true) return { allow: true, reason: "" };
  if (decision === false) return { allow: false, reason: "not approved" };
  return decision.allow
    ? { allow: true, reason: "" }
    : { allow: false, reason: decision.reason };
}

/**
 * One workspace's queue of mutating calls: each waits for the one before
 * it, in the order it took its place.
 */
class Lane {
  #tail: Promise<void> = Promise.resolve();
  #abandoned = false;
  readonly #onAbandon = new Set<() => void>();

  /**
   * Takes the next place in the queue, synchronously, so places follow the
   * order calls reach the registry however long their approvals take.
   * `release` must be called exactly once, after `wait` or instead of it;
   * releasing a place that never ran passes the turn on.
   */
  reserve(): Place {
    const previous = this.#tail;
    let release = () => {};
    const mine = new Promise<void>((resolve) => (release = resolve));
    this.#tail = previous.then(() => mine);
    return {
      release,
      wait: (signal) => this.#wait(previous, signal),
    };
  }

  /**
   * Waits for the places before this one. Refused while a call abandoned
   * on this workspace may still run.
   */
  async #wait(
    previous: Promise<void>,
    signal: AbortSignal | undefined,
  ): Promise<"ready" | "aborted" | "abandoned"> {
    if (this.#abandoned) return "abandoned";
    if (signal?.aborted) return "aborted";
    let stopWaiting = () => {};
    const interrupted = new Promise<"aborted" | "abandoned">((resolve) => {
      const onAbort = () => resolve("aborted");
      const onAbandon = () => resolve("abandoned");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#onAbandon.add(onAbandon);
      stopWaiting = () => {
        signal?.removeEventListener("abort", onAbort);
        this.#onAbandon.delete(onAbandon);
      };
    });
    const outcome = await Promise.race([
      previous.then(() => "ready" as const),
      interrupted,
    ]);
    stopWaiting();
    // A place given up keeps the queue intact: whoever waits on it waits
    // on the one before instead.
    return outcome;
  }

  /**
   * The holder's call was abandoned: refuse everyone until `until`
   * settles, then pass the turn on.
   */
  abandon(until: Promise<unknown>, release: () => void): void {
    this.#abandoned = true;
    for (const notify of [...this.#onAbandon]) notify();
    until.finally(() => {
      this.#abandoned = false;
      release();
    });
  }
}

/** Options checked once per `execute`. */
interface Checked {
  readonly timeoutMs: number;
  readonly maxChars: number;
  readonly graceMs: number;
}

/** A call's place in a {@link Lane}. */
interface Place {
  /** Resolves once every earlier place has been released. */
  wait(
    signal: AbortSignal | undefined,
  ): Promise<"ready" | "aborted" | "abandoned">;
  readonly release: () => void;
}

const lanes = new WeakMap<object, Lane>();

function laneOf(key: object): Lane {
  let lane = lanes.get(key);
  if (lane === undefined) lanes.set(key, lane = new Lane());
  return lane;
}

/** Options for a {@link ToolRegistry}. */
export interface ToolRegistryOptions {
  /**
   * The workspace key of tools that name none; default a fresh object,
   * kept by {@link ToolRegistry.with}.
   */
  readonly workspace?: object;
}

/** Tools by name, and the machinery to run the model's calls to them. */
export class ToolRegistry {
  readonly #tools: Map<string, Tool>;
  readonly #workspace: object;

  /**
   * @throws {TypeError} duplicate names, or a tool whose `mutates` is not a
   * boolean.
   * @throws {RangeError} a tool whose `timeoutMs` is out of range.
   */
  constructor(tools: readonly Tool[] = [], options: ToolRegistryOptions = {}) {
    this.#workspace = options.workspace ?? {};
    this.#tools = new Map();
    for (const tool of tools) {
      // Tool objects may be built by hand: a missing `mutates` counts as
      // mutating everywhere (see `#one`), a wrong one is refused.
      if (tool.mutates !== undefined && typeof tool.mutates !== "boolean") {
        throw new TypeError(`tool ${tool.name}: mutates must be a boolean`);
      }
      if (tool.timeoutMs !== undefined) {
        checkTimeout(tool.timeoutMs, `tool ${tool.name} timeoutMs`);
      }
      if (this.#tools.has(tool.name)) {
        throw new TypeError(`duplicate tool ${tool.name}`);
      }
      this.#tools.set(tool.name, tool);
    }
  }

  /** A new registry with more tools, sharing this one's workspace key. */
  with(...tools: Tool[]): ToolRegistry {
    return new ToolRegistry([...this.#tools.values(), ...tools], {
      workspace: this.#workspace,
    });
  }

  /**
   * True when no tool mutates, so the model may call them in parallel
   * (`runAgent` sets `parallelToolCalls` from it).
   */
  get readOnly(): boolean {
    for (const tool of this.#tools.values()) {
      if (tool.mutates !== false) return false;
    }
    return true;
  }

  get size(): number {
    return this.#tools.size;
  }

  get names(): string[] {
    return [...this.#tools.keys()];
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  /** The definitions to send. */
  definitions(): ToolDefinition[] {
    return [...this.#tools.values()].map(toolDefinition);
  }

  /**
   * Runs the calls (concurrently, up to `concurrency`, with mutating calls
   * on one workspace one at a time in call order) and returns one
   * execution per call, in call order.
   *
   * @throws {ToolBatchAbortedError} (a {@link GptAbortError}) when
   * `signal` aborts, carrying every call's execution.
   * @throws {RangeError} before any call runs, for an option out of range
   * (`timeoutMs`, `cancelGraceMs`, `maxOutputChars`, `concurrency`).
   * Nothing a tool does throws; should the registry itself fail, no
   * further call starts and the calls already started are awaited before
   * the error is rethrown.
   */
  async execute(
    calls: readonly ToolCall[],
    options: ExecuteOptions = {},
  ): Promise<ToolExecution[]> {
    const concurrency = safeInt(options.concurrency ?? 4, {
      name: "concurrency",
      min: 1,
    });
    const checked: Checked = {
      timeoutMs: checkTimeout(options.timeoutMs ?? 60_000, "timeoutMs"),
      maxChars: safeInt(options.maxOutputChars ?? 20_000, {
        name: "maxOutputChars",
        min: MIN_OUTPUT_CHARS,
        max: MAX_OUTPUT_CHARS,
      }),
      graceMs: nonNegativeMs(
        options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
        { name: "cancelGraceMs" },
      ),
    };
    const results: ToolExecution[] = new Array(calls.length);
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < calls.length) {
        const index = next++;
        try {
          results[index] = await this.#one(calls[index], options, checked);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    // Every worker settles before anything is thrown, so no call is still
    // being started or run when `execute` returns.
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, calls.length) }, worker),
    );
    for (const outcome of settled) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
    if (options.signal?.aborted) {
      throw new ToolBatchAbortedError(results, options.signal.reason);
    }
    return results;
  }

  async #one(
    call: ToolCall,
    options: ExecuteOptions,
    checked: Checked,
  ): Promise<ToolExecution> {
    const runtime = options.runtime ?? defaultRuntime;
    const started = runtime.now();
    const maxChars = checked.maxChars;
    const done = (status: ToolStatus, text: string): ToolExecution => {
      const output = truncateMiddle(text, maxChars);
      return {
        callId: call.callId,
        name: call.name,
        status,
        output,
        durationMs: runtime.now() - started,
        item: outputFor(call, output),
      };
    };
    if (options.skip !== undefined) {
      return done("skipped", `error: not run: ${options.skip}`);
    }
    if (options.signal?.aborted) {
      return done("skipped", "error: not run: aborted");
    }
    const tool = this.#tools.get(call.name);
    if (tool === undefined || tool.kind !== call.kind) {
      return done(
        "unknown_tool",
        `error: unknown ${call.kind} tool ${
          JSON.stringify(call.name)
        }; available: ${this.names.join(", ") || "none"}`,
      );
    }
    // A tool that does not say `mutates: false` mutates.
    const mutates = tool.mutates !== false;
    if (mutates && options.skipMutating !== undefined) {
      return done("skipped", `error: not run: ${options.skipMutating}`);
    }
    let args: JsonValue;
    let parsedArgs: unknown;
    if (tool.kind === "function") {
      const raw = (call as { arguments: string }).arguments;
      const parsed = raw.trim() === "" ? {} : tryParseJson(raw);
      if (parsed === undefined) {
        return done("invalid_arguments", "error: invalid arguments: not JSON");
      }
      let result;
      try {
        result = tool.parameters.safeParse(parsed);
      } catch (error) {
        return done(
          "invalid_arguments",
          `error: invalid arguments: ${message(error)}`,
        );
      }
      if (!result.success) {
        return done(
          "invalid_arguments",
          `error: invalid arguments: ${formatIssues(result.error.issues)}`,
        );
      }
      args = parsed;
      parsedArgs = result.data;
    } else {
      args = (call as { input: string }).input;
    }
    // A mutating call takes its place on its workspace before its approval
    // is awaited: approvals finish in any order, the calls run in theirs.
    const lane = mutates ? laneOf(tool.workspace ?? this.#workspace) : null;
    const place = lane?.reserve() ?? null;
    // The place is released here unless an abandoned call holds it.
    let held = false;
    try {
      if (options.approve !== undefined) {
        let decision: { allow: boolean; reason: string };
        try {
          decision = normalizeDecision(
            await options.approve({
              call,
              tool: {
                name: tool.name,
                kind: tool.kind,
                description: tool.description,
                risk: tool.risk,
              },
              args,
              turn: options.turn ?? 0,
            }),
          );
        } catch (error) {
          decision = {
            allow: false,
            reason: `approval failed: ${message(error)}`,
          };
        }
        if (!decision.allow) {
          return done("denied", `denied: ${decision.reason}`);
        }
        if (options.signal?.aborted) {
          return done("skipped", "error: not run: aborted");
        }
      }
      if (lane === null || place === null) {
        return (await this.#invoke(
          tool,
          call,
          args,
          parsedArgs,
          options,
          checked,
          done,
        ))
          .execution;
      }
      const turn = await place.wait(options.signal);
      if (turn === "aborted") return done("skipped", "error: not run: aborted");
      if (turn === "abandoned") {
        return done(
          "skipped",
          "error: not run: an earlier call on this workspace was abandoned and may still be running",
        );
      }
      const invoked = await this.#invoke(
        tool,
        call,
        args,
        parsedArgs,
        options,
        checked,
        done,
      );
      if (invoked.running !== null) {
        lane.abandon(invoked.running, place.release);
        held = true;
      }
      return invoked.execution;
    } finally {
      if (!held) place?.release();
    }
  }

  /**
   * Runs one approved call under its timeout. `running` is the handler's
   * promise when it was abandoned, else null.
   */
  async #invoke(
    tool: Tool,
    call: ToolCall,
    args: JsonValue,
    parsedArgs: unknown,
    options: ExecuteOptions,
    checked: Checked,
    done: (status: ToolStatus, text: string) => ToolExecution,
  ): Promise<
    { execution: ToolExecution; running: Promise<unknown> | null }
  > {
    const runtime = options.runtime ?? defaultRuntime;
    const graceMs = checked.graceMs;
    const timeoutMs = tool.timeoutMs ?? checked.timeoutMs;
    const controller = new AbortController();
    // Why the call was stopped, set once: the timer or the caller.
    let stopped: "timeout" | "aborted" | null = null;
    let wake = () => {};
    const stop = new Promise<null>((resolve) => (wake = () => resolve(null)));
    const halt = (why: "timeout" | "aborted", reason: unknown) => {
      if (stopped !== null) return;
      stopped = why;
      controller.abort(reason);
      wake();
    };
    const onAbort = () => halt("aborted", options.signal!.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Aborted while waiting for the workspace: the handler starts stopped.
    if (options.signal?.aborted) onAbort();
    const cancelTimer = runtime.setTimer(
      timeoutMs,
      () => halt("timeout", new Error("timeout")),
    );
    const context: ToolContext = {
      signal: controller.signal,
      call,
      turn: options.turn ?? 0,
    };
    type Settled =
      | { readonly ok: true; readonly value: ToolResult }
      | { readonly ok: false; readonly error: unknown };
    const settled: Promise<Settled> = Promise.resolve().then(() =>
      tool.kind === "function"
        ? tool.run(parsedArgs, context)
        : tool.run(args as string, context)
    ).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    let outcome: Settled | null;
    try {
      outcome = await Promise.race([settled, stop]);
      if (outcome === null) {
        // Stopped: wait for the handler to confirm, up to the grace period.
        let cancelGrace = () => {};
        const grace = new Promise<null>((resolve) => {
          cancelGrace = runtime.setTimer(graceMs, () => resolve(null));
        });
        try {
          outcome = await Promise.race([settled, grace]);
        } finally {
          cancelGrace();
        }
      }
    } finally {
      cancelTimer();
      options.signal?.removeEventListener("abort", onAbort);
    }
    const finished = (execution: ToolExecution) => ({
      execution,
      running: null,
    });
    const why = stopped as "timeout" | "aborted" | null;
    if (why === null) {
      return finished(
        outcome!.ok
          ? done("ok", render(outcome!.value))
          : done("error", `error: ${message(outcome!.error)}`),
      );
    }
    if (outcome === null) {
      const execution: ToolExecution = {
        ...done(
          why === "timeout" ? "timeout" : "skipped",
          `${
            why === "timeout"
              ? `error: timed out after ${timeoutMs} ms`
              : "error: aborted"
          }; the call did not stop within ${graceMs} ms of being cancelled and may still be running`,
        ),
        abandoned: true,
      };
      try {
        (options.onAbandoned ?? warnAbandoned)(execution);
      } catch {
        // A logging hook must not turn into the call's failure.
      }
      return { execution, running: settled };
    }
    if (why === "aborted") {
      // A handler that finished its work reports it; one that stopped says
      // so (it ran, so never "not run"), keeping its own error, which may
      // say what it changed before it stopped.
      if (outcome.ok) return finished(done("ok", render(outcome.value)));
      return finished(done(
        "error",
        outcome.error === controller.signal.reason
          ? "error: aborted while running; the call stopped"
          : `error: aborted\n${message(outcome.error)}`,
      ));
    }
    const head = `error: timed out after ${timeoutMs} ms`;
    // A handler that finished after the timer fired did its work: the
    // model must see the result, or it would redo it.
    if (outcome.ok) {
      return finished(done(
        "timeout",
        `${head}, but the call finished:\n${render(outcome.value)}`,
      ));
    }
    return finished(done(
      "timeout",
      outcome.error === controller.signal.reason
        ? head
        : `${head}\n${message(outcome.error)}`,
    ));
  }
}

function warnAbandoned(execution: ToolExecution): void {
  console.warn(
    `tool call ${execution.callId} (${execution.name}) was abandoned: ${execution.output}`,
  );
}
