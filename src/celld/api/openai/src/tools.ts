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
 * @module
 */

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
  /** Aborted on timeout or when the caller cancels. */
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
  readonly timeoutMs?: number;
  run(input: string, context: ToolContext): ToolResult | Promise<ToolResult>;
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
export function functionTool<S extends AnySchema>(spec: {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
  readonly strict?: boolean;
  readonly risk?: ToolRisk;
  readonly timeoutMs?: number;
  run(
    args: Output<S>,
    context: ToolContext,
  ): ToolResult | Promise<ToolResult>;
}): FunctionTool<Output<S>> {
  checkSpec(spec.name, spec.description);
  const strict = spec.strict ?? true;
  return Object.freeze({
    kind: "function" as const,
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    jsonSchema: parametersSchema(spec.name, spec.parameters, strict),
    strict,
    risk: spec.risk ?? "other",
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    run: spec.run,
  });
}

/** A custom tool; `run` gets the model's text. */
export function customTool(spec: {
  readonly name: string;
  readonly description: string;
  readonly format?: CustomToolFormat;
  readonly risk?: ToolRisk;
  readonly timeoutMs?: number;
  run(input: string, context: ToolContext): ToolResult | Promise<ToolResult>;
}): CustomTool {
  checkSpec(spec.name, spec.description);
  return Object.freeze({
    kind: "custom" as const,
    name: spec.name,
    description: spec.description,
    ...(spec.format === undefined ? {} : { format: spec.format }),
    risk: spec.risk ?? "other",
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
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
}

/** How {@link ToolRegistry.execute} runs calls. */
export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  /** Consulted before each call runs; default: allow everything. */
  readonly approve?: Approver;
  /** Per-call timeout; default 60 s. */
  readonly timeoutMs?: number;
  /**
   * Output longer than this is cut in the middle; default 20,000
   * characters (about Codex's 10,000-token truncation policy, halved).
   */
  readonly maxOutputChars?: number;
  /** Calls run at once; default 4. */
  readonly concurrency?: number;
  readonly turn?: number;
  readonly runtime?: Runtime;
  /** When set, no call runs; each gets this reason as a `skipped` output. */
  readonly skip?: string;
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

/** Tools by name, and the machinery to run the model's calls to them. */
export class ToolRegistry {
  readonly #tools: Map<string, Tool>;

  /** @throws {TypeError} duplicate names. */
  constructor(tools: readonly Tool[] = []) {
    this.#tools = new Map();
    for (const tool of tools) {
      if (this.#tools.has(tool.name)) {
        throw new TypeError(`duplicate tool ${tool.name}`);
      }
      this.#tools.set(tool.name, tool);
    }
  }

  /** A new registry with more tools. */
  with(...tools: Tool[]): ToolRegistry {
    return new ToolRegistry([...this.#tools.values(), ...tools]);
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
   * Runs the calls (concurrently, up to `concurrency`) and returns one
   * execution per call, in call order.
   *
   * @throws {GptAbortError} when `signal` aborts; nothing else throws.
   */
  async execute(
    calls: readonly ToolCall[],
    options: ExecuteOptions = {},
  ): Promise<ToolExecution[]> {
    const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(
        `concurrency must be a positive integer, got ${concurrency}`,
      );
    }
    const results: ToolExecution[] = new Array(calls.length);
    let next = 0;
    const worker = async () => {
      while (next < calls.length) {
        const index = next++;
        results[index] = await this.#one(calls[index], options);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, calls.length) }, worker),
    );
    if (options.signal?.aborted) {
      throw new GptAbortError("tool execution was aborted", {
        cause: options.signal.reason,
      });
    }
    return results;
  }

  async #one(call: ToolCall, options: ExecuteOptions): Promise<ToolExecution> {
    const runtime = options.runtime ?? defaultRuntime;
    const started = runtime.now();
    const maxChars = options.maxOutputChars ?? 20_000;
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
      if (!decision.allow) return done("denied", `denied: ${decision.reason}`);
    }
    const timeoutMs = tool.timeoutMs ?? options.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal!.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    let cancel = () => {};
    const timeout = new Promise<never>((_, reject) => {
      cancel = runtime.setTimer(timeoutMs, () => {
        timedOut = true;
        controller.abort(new Error("timeout"));
        reject(new Error("timeout"));
      });
    });
    timeout.catch(() => {});
    const context: ToolContext = {
      signal: controller.signal,
      call,
      turn: options.turn ?? 0,
    };
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          tool.kind === "function"
            ? tool.run(parsedArgs, context)
            : tool.run(args as string, context)
        ),
        timeout,
      ]);
      return done("ok", render(result));
    } catch (error) {
      if (timedOut) {
        return done("timeout", `error: timed out after ${timeoutMs} ms`);
      }
      if (options.signal?.aborted) {
        return done("skipped", "error: not run: aborted");
      }
      return done("error", `error: ${message(error)}`);
    } finally {
      cancel();
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
