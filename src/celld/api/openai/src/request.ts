// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Building the `POST /responses` body the ChatGPT (Codex) backend accepts,
 * and refusing, before anything is sent, everything it would refuse or read
 * differently.
 *
 * Every request is built the way Codex's `build_responses_request`
 * (`codex-rs/core/src/client.rs`) builds one:
 *
 * - `stream: true` and `store: false`, always. The backend keeps no state,
 *   so each turn replays the conversation.
 * - `include: ["reasoning.encrypted_content"]`, always, so reasoning comes
 *   back in a form the next turn can replay.
 * - `instructions` set (Codex never sends a request without its base
 *   instructions), `tool_choice`, `parallel_tool_calls`, `reasoning`, and a
 *   `prompt_cache_key`.
 * - Nothing Codex does not send: no `previous_response_id` (meaningless
 *   with `store: false`), no `max_output_tokens`, `temperature`, `top_p`,
 *   `truncation`, `metadata` or `user`. There is no way to pass them.
 *
 * For models the Codex catalog marks `use_responses_lite` (the GPT-6
 * family), the "lite" encoding moves tools and instructions into two leading
 * input items (`additional_tools` and a developer message), sets
 * `reasoning.context: "all_turns"`, turns parallel tool calls off and drops
 * image `detail`, exactly as Codex does.
 *
 * @module
 */

import { v } from "@celld/sieve";
import {
  isPlainObject,
  type Issue,
  type JsonObject,
  type JsonValue,
  type Path,
  sha256Hex,
} from "./json.ts";
import { normalizeItem } from "./items.ts";
import { modelInfo, REASONING_EFFORTS } from "./models.ts";
import type {
  ContentPart,
  Item,
  OutputFormat,
  ReasoningEffort,
  ReasoningSummary,
  ToolChoice,
  ToolDefinition,
  Verbosity,
} from "./types.ts";

/** The instructions sent when a request gives none. Small on purpose. */
export const DEFAULT_INSTRUCTIONS =
  "You are a careful, precise assistant. Answer directly and say when you are unsure.";

/** How tools and instructions are placed in the body. */
export type Encoding = "standard" | "lite";

/** A model call, as the caller writes it. */
export interface GptRequest {
  /** A user message, or the whole input as items (a conversation replay). */
  readonly input: string | readonly Item[];
  /** The system prompt; default {@link DEFAULT_INSTRUCTIONS} or the client's. */
  readonly instructions?: string;
  /** Overrides the client's model. */
  readonly model?: string;
  readonly tools?: readonly ToolDefinition[];
  /** Default `"auto"`, which is all Codex ever sends. */
  readonly toolChoice?: ToolChoice;
  /** Default true when there are tools (always false in the lite encoding). */
  readonly parallelToolCalls?: boolean;
  readonly reasoning?: {
    readonly effort?: ReasoningEffort;
    /** Default `"auto"`; `"none"` omits the summary. */
    readonly summary?: ReasoningSummary;
  };
  readonly verbosity?: Verbosity;
  /** Structured output: the answer must be JSON matching this schema. */
  readonly format?: OutputFormat;
  /**
   * The cache key. Default: the conversation's id when there is one, else
   * a hash of model, instructions and tools, so calls sharing a prompt
   * prefix share the cache.
   */
  readonly promptCacheKey?: string;
  /** `service_tier`, such as `"priority"`; passed through unverified. */
  readonly serviceTier?: string;
  /** Force an encoding; default from the model catalog. */
  readonly encoding?: Encoding;
}

/** What {@link buildRequest} produces. */
export interface BuiltRequest {
  readonly body: JsonObject;
  readonly model: string;
  readonly encoding: Encoding;
  readonly promptCacheKey: string;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_FIELDS = new Set([
  "input",
  "instructions",
  "model",
  "tools",
  "toolChoice",
  "parallelToolCalls",
  "reasoning",
  "verbosity",
  "format",
  "promptCacheKey",
  "serviceTier",
  "encoding",
]);
const SUMMARIES = new Set(["auto", "concise", "detailed", "none"]);
const VERBOSITY = new Set(["low", "medium", "high"]);

function toolIssues(
  tools: unknown,
  issues: Issue[],
): Set<string> {
  const names = new Set<string>();
  if (tools === undefined) return names;
  if (!Array.isArray(tools)) {
    issues.push({ path: ["tools"], message: "tools must be a list" });
    return names;
  }
  tools.forEach((tool, index) => {
    const path = ["tools", index];
    if (!isPlainObject(tool)) {
      issues.push({ path, message: "a tool must be an object" });
      return;
    }
    if (typeof tool.name !== "string" || !NAME.test(tool.name)) {
      issues.push({
        path: [...path, "name"],
        message: "a tool name is 1 to 64 letters, digits, _ or -",
      });
    } else if (names.has(tool.name)) {
      issues.push({
        path: [...path, "name"],
        message: `duplicate tool ${tool.name}`,
      });
    } else {
      names.add(tool.name);
    }
    if (typeof tool.description !== "string") {
      issues.push({
        path: [...path, "description"],
        message: "a tool needs a description",
      });
    }
    if (tool.type === "function") {
      if (
        !isPlainObject(tool.parameters) || tool.parameters.type !== "object"
      ) {
        issues.push({
          path: [...path, "parameters"],
          message: "function parameters must be an object schema",
        });
      } else if (tool.strict === true) {
        issues.push(
          ...strictSchemaIssues(tool.parameters, [...path, "parameters"]),
        );
      }
      if (typeof tool.strict !== "boolean") {
        issues.push({
          path: [...path, "strict"],
          message: "strict must be a boolean",
        });
      }
    } else if (tool.type === "custom") {
      const format = tool.format;
      if (format !== undefined) {
        if (!isPlainObject(format)) {
          issues.push({
            path: [...path, "format"],
            message: "format must be an object",
          });
        } else if (format.type === "grammar") {
          if (format.syntax !== "lark" && format.syntax !== "regex") {
            issues.push({
              path: [...path, "format", "syntax"],
              message: "grammar syntax must be lark or regex",
            });
          }
          if (
            typeof format.definition !== "string" ||
            format.definition.trim() === ""
          ) {
            issues.push({
              path: [...path, "format", "definition"],
              message: "a grammar needs a definition",
            });
          }
        } else if (format.type !== "text") {
          issues.push({
            path: [...path, "format", "type"],
            message: "format type must be text or grammar",
          });
        }
      }
    } else {
      issues.push({
        path: [...path, "type"],
        message: "only function and custom tools reach this backend",
      });
    }
  });
  return names;
}

const JSON_VALUE = v.json();

/**
 * Every reason `value` is not plain JSON (undefined, functions, symbols,
 * bigints, non-finite numbers, array holes, non-plain objects, cycles), at
 * `path`. `JSON.stringify` would quietly drop or convert each of them, so
 * the model would see something other than what the caller wrote.
 */
function jsonIssues(value: unknown, path: Path): Issue[] {
  const result = JSON_VALUE.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => ({
    ...issue,
    path: [...path, ...issue.path],
  }));
}

/**
 * Reasons a JSON Schema written by hand (a `format.schema` or a tool's
 * `parameters`) will be refused in strict mode: the root must be an
 * object, and every object must list all its properties as `required` and
 * set `additionalProperties: false`. Schemas from `@celld/sieve`'s
 * `openai-strict` target always pass.
 */
function strictSchemaIssues(json: unknown, path: Path): Issue[] {
  const issues: Issue[] = [];
  if (!isPlainObject(json) || json.type !== "object") {
    issues.push({
      path,
      message: "the root of a strict schema must be an object schema",
    });
    return issues;
  }
  walkStrict(json, path, issues);
  return issues;
}

function walkStrict(node: unknown, path: Path, issues: Issue[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkStrict(item, [...path, index], issues));
    return;
  }
  if (!isPlainObject(node)) return;
  const isObject = node.type === "object" ||
    (Array.isArray(node.type) && node.type.includes("object"));
  if (isObject) {
    const properties = isPlainObject(node.properties) ? node.properties : {};
    if (node.additionalProperties !== false) {
      issues.push({
        path,
        message: "strict mode needs additionalProperties: false",
      });
    }
    const required = Array.isArray(node.required) ? node.required : [];
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) {
        issues.push({
          path: [...path, "properties", key],
          message:
            "strict mode needs every property in required; use a nullable type instead",
        });
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "enum" || key === "const" || key === "required") continue;
    walkStrict(value, [...path, key], issues);
  }
}

/** Problems with `request`, all at once, with paths. */
export function requestIssues(request: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isPlainObject(request)) {
    return [{ path: [], message: "a request must be an object" }];
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_FIELDS.has(key)) {
      issues.push({
        path: [key],
        message: key === "previousResponseId" || key === "maxOutputTokens" ||
            key === "temperature" || key === "store" || key === "stream"
          ? "not supported by the ChatGPT backend; see the README"
          : "unknown field",
      });
    }
  }
  const input = request.input;
  if (typeof input === "string") {
    if (input.trim() === "") {
      issues.push({ path: ["input"], message: "input must not be blank" });
    }
  } else if (Array.isArray(input)) {
    if (input.length === 0) {
      issues.push({
        path: ["input"],
        message: "input needs at least one item",
      });
    }
    issues.push(...jsonIssues(input, ["input"]));
    const items: Item[] = [];
    input.forEach((raw, index) => {
      const before = issues.length;
      const item = normalizeItem(raw, ["input", index], issues);
      if (item !== null) items.push(item);
      else if (issues.length === before && isPlainObject(raw)) {
        issues.push({
          path: ["input", index, "type"],
          message: `items of type ${raw.type} are not sent by this client`,
        });
      }
    });
    const calls = new Set<string>();
    items.forEach((item, index) => {
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        calls.add(item.call_id);
      }
      if (
        (item.type === "function_call_output" ||
          item.type === "custom_tool_call_output") && !calls.has(item.call_id)
      ) {
        issues.push({
          path: ["input", index, "call_id"],
          message: `no earlier tool call has call_id ${item.call_id}`,
        });
      }
    });
    const answered = new Set(
      items.flatMap((item) =>
        item.type === "function_call_output" ||
          item.type === "custom_tool_call_output"
          ? [item.call_id]
          : []
      ),
    );
    items.forEach((item, index) => {
      if (
        (item.type === "function_call" || item.type === "custom_tool_call") &&
        !answered.has(item.call_id)
      ) {
        issues.push({
          path: ["input", index],
          message:
            `tool call ${item.call_id} has no output; the backend refuses unanswered calls`,
        });
      }
    });
  } else {
    issues.push({
      path: ["input"],
      message: "input must be a string or a list of items",
    });
  }
  if (request.instructions !== undefined) {
    if (
      typeof request.instructions !== "string" ||
      request.instructions.trim() === ""
    ) {
      issues.push({
        path: ["instructions"],
        message: "instructions must be non-blank text",
      });
    }
  }
  if (
    request.model !== undefined &&
    (typeof request.model !== "string" || request.model.trim() === "")
  ) {
    issues.push({
      path: ["model"],
      message: "model must be a non-blank string",
    });
  }
  const names = toolIssues(request.tools, issues);
  const choice = request.toolChoice;
  if (choice !== undefined) {
    if (typeof choice === "string") {
      if (!["auto", "none", "required"].includes(choice)) {
        issues.push({
          path: ["toolChoice"],
          message: "toolChoice must be auto, none, required or a named tool",
        });
      } else if (choice === "required" && names.size === 0) {
        issues.push({
          path: ["toolChoice"],
          message: "required needs at least one tool",
        });
      }
    } else if (
      isPlainObject(choice) &&
      (choice.type === "function" || choice.type === "custom") &&
      typeof choice.name === "string"
    ) {
      if (!names.has(choice.name)) {
        issues.push({
          path: ["toolChoice", "name"],
          message: `no tool named ${choice.name}`,
        });
      }
    } else {
      issues.push({
        path: ["toolChoice"],
        message: "toolChoice must be auto, none, required or a named tool",
      });
    }
  }
  if (
    request.parallelToolCalls !== undefined &&
    typeof request.parallelToolCalls !== "boolean"
  ) {
    issues.push({ path: ["parallelToolCalls"], message: "must be a boolean" });
  }
  const reasoning = request.reasoning;
  if (reasoning !== undefined) {
    if (!isPlainObject(reasoning)) {
      issues.push({
        path: ["reasoning"],
        message: "reasoning must be an object",
      });
    } else {
      for (const key of Object.keys(reasoning)) {
        if (key !== "effort" && key !== "summary") {
          issues.push({ path: ["reasoning", key], message: "unknown field" });
        }
      }
      if (reasoning.effort !== undefined) {
        const effort = reasoning.effort as ReasoningEffort;
        const known = typeof request.model === "string"
          ? modelInfo(request.model)
          : null;
        if (!REASONING_EFFORTS.includes(effort)) {
          issues.push({
            path: ["reasoning", "effort"],
            message: `effort must be one of ${REASONING_EFFORTS.join(", ")}`,
          });
        } else if (known !== null && !known.efforts.includes(effort)) {
          issues.push({
            path: ["reasoning", "effort"],
            message: `${known.id} accepts ${known.efforts.join(", ")}`,
          });
        }
      }
      if (
        reasoning.summary !== undefined &&
        !SUMMARIES.has(reasoning.summary as string)
      ) {
        issues.push({
          path: ["reasoning", "summary"],
          message: "summary must be auto, concise, detailed or none",
        });
      }
    }
  }
  if (
    request.verbosity !== undefined &&
    !VERBOSITY.has(request.verbosity as string)
  ) {
    issues.push({
      path: ["verbosity"],
      message: "verbosity must be low, medium or high",
    });
  }
  const format = request.format;
  if (format !== undefined) {
    if (!isPlainObject(format)) {
      issues.push({ path: ["format"], message: "format must be an object" });
    } else {
      if (typeof format.name !== "string" || !NAME.test(format.name)) {
        issues.push({
          path: ["format", "name"],
          message: "a format name is 1 to 64 letters, digits, _ or -",
        });
      }
      if (format.strict !== false) {
        issues.push(...strictSchemaIssues(format.schema, ["format", "schema"]));
      } else if (!isPlainObject(format.schema)) {
        issues.push({
          path: ["format", "schema"],
          message: "schema must be an object",
        });
      }
      issues.push(...jsonIssues(format.schema, ["format", "schema"]));
    }
  }
  for (const key of ["promptCacheKey", "serviceTier"] as const) {
    const value = request[key];
    if (
      value !== undefined && (typeof value !== "string" || value.trim() === "")
    ) {
      issues.push({ path: [key], message: "must be a non-blank string" });
    }
  }
  if (
    request.encoding !== undefined && request.encoding !== "standard" &&
    request.encoding !== "lite"
  ) {
    issues.push({
      path: ["encoding"],
      message: "encoding must be standard or lite",
    });
  }
  return issues;
}

/** The encoding Codex would use for `model`. */
export function encodingFor(model: string): Encoding {
  return modelInfo(model)?.lite === true ? "lite" : "standard";
}

function withoutDetail<P extends ContentPart>(part: P): P {
  if (part.type !== "input_image" || part.detail === undefined) return part;
  const { detail: _, ...rest } = part;
  return rest as P;
}

function stripImageDetail(item: Item): Item {
  if (item.type === "message") {
    return { ...item, content: item.content.map(withoutDetail) };
  }
  if (
    (item.type === "function_call_output" ||
      item.type === "custom_tool_call_output") &&
    typeof item.output !== "string"
  ) {
    return { ...item, output: item.output.map(withoutDetail) };
  }
  return item;
}

/**
 * The request body for an already-validated request. Callers pass the
 * resolved model and instructions (request's, else client's, else default).
 */
export async function buildRequest(
  request: GptRequest,
  defaults: {
    readonly model: string;
    readonly instructions: string;
    readonly encoding?: Encoding;
  },
): Promise<BuiltRequest> {
  const model = request.model ?? defaults.model;
  const instructions = request.instructions ?? defaults.instructions;
  const encoding = request.encoding ?? defaults.encoding ?? encodingFor(model);
  const tools = (request.tools ?? []) as unknown as JsonValue[];
  const issues: Issue[] = [];
  let input: Item[] = typeof request.input === "string"
    ? [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: request.input }],
    }]
    : request.input.flatMap((raw, index) => {
      const item = normalizeItem(raw, ["input", index], issues);
      return item === null ? [] : [item];
    });
  const promptCacheKey = request.promptCacheKey ??
    `celld-openai-${
      (await sha256Hex(JSON.stringify([model, instructions, tools]))).slice(
        0,
        32,
      )
    }`;
  const info = modelInfo(model);
  const effort = request.reasoning?.effort ?? info?.defaultEffort;
  const summary = request.reasoning?.summary ?? "auto";
  const reasoning: JsonObject = {};
  if (effort !== undefined) reasoning.effort = effort;
  if (summary !== "none") reasoning.summary = summary;
  const body: JsonObject = { model };
  if (encoding === "lite") {
    // Stable ids keep the prefix byte-identical across turns, which is what
    // makes the prompt cache hit.
    const toolsJson = JSON.stringify(tools);
    const prefix: JsonObject[] = [{
      type: "additional_tools",
      id: `at_${
        (await sha256Hex(`${promptCacheKey}\n${toolsJson}`)).slice(0, 32)
      }`,
      role: "developer",
      tools,
    }];
    prefix.push({
      type: "message",
      id: `msg_${
        (await sha256Hex(`${promptCacheKey}\n${instructions}`)).slice(0, 32)
      }`,
      role: "developer",
      content: [{ type: "input_text", text: instructions }],
    });
    input = input.map(stripImageDetail);
    body.input = [...prefix, ...(input as unknown as JsonObject[])];
    reasoning.context = "all_turns";
  } else {
    body.instructions = instructions;
    body.input = input as unknown as JsonObject[];
    if (tools.length > 0) body.tools = tools;
  }
  body.tool_choice = (request.toolChoice ?? "auto") as JsonValue;
  body.parallel_tool_calls = encoding === "lite"
    ? false
    : request.parallelToolCalls ?? tools.length > 0;
  body.reasoning = reasoning;
  body.store = false;
  body.stream = true;
  body.include = ["reasoning.encrypted_content"];
  if (request.serviceTier !== undefined) {
    body.service_tier = request.serviceTier;
  }
  body.prompt_cache_key = promptCacheKey;
  const text: JsonObject = {};
  if (request.verbosity !== undefined) text.verbosity = request.verbosity;
  if (request.format !== undefined) {
    text.format = {
      type: "json_schema",
      name: request.format.name,
      schema: request.format.schema,
      strict: request.format.strict ?? true,
      ...(request.format.description === undefined
        ? {}
        : { description: request.format.description }),
    };
  }
  if (Object.keys(text).length > 0) body.text = text;
  return { body, model, encoding, promptCacheKey };
}
