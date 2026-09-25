// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Building input items, and normalising items the server returned so they
 * replay exactly as Codex replays them.
 *
 * ```ts
 * user("Review this diff", image("data:image/png;base64,..."));
 * functionOutput("call_1", "ok");
 * ```
 *
 * @module
 */

import {
  describeValue,
  isPlainObject,
  type Issue,
  type JsonObject,
  type Path,
} from "./json.ts";
import type {
  ContentPart,
  CustomToolCallOutputItem,
  FunctionCallOutputItem,
  ImageDetail,
  InputImage,
  InputText,
  Item,
  MessageItem,
  Role,
  SummaryText,
  ToolCall,
  ToolOutputPart,
  Usage,
} from "./types.ts";

/** A text part. */
export function text(value: string): InputText {
  return { type: "input_text", text: value };
}

/** An image part from an `https:` or `data:` URL. */
export function image(url: string, detail?: ImageDetail): InputImage {
  return detail === undefined
    ? { type: "input_image", image_url: url }
    : { type: "input_image", image_url: url, detail };
}

function message(
  role: Role,
  parts: readonly (string | ContentPart)[],
): MessageItem {
  return {
    type: "message",
    role,
    content: parts.map((part) => typeof part === "string" ? text(part) : part),
  };
}

/** A user message from text and parts. */
export function user(...parts: (string | ContentPart)[]): MessageItem {
  return message("user", parts);
}

/** A developer (system) message. */
export function developer(...parts: (string | InputText)[]): MessageItem {
  return message("developer", parts);
}

/** An assistant message, for examples or seeding a conversation. */
export function assistant(textValue: string): MessageItem {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: textValue }],
  };
}

/** The output of a function tool call. */
export function functionOutput(
  callId: string,
  output: string | readonly ToolOutputPart[],
): FunctionCallOutputItem {
  return { type: "function_call_output", call_id: callId, output };
}

/** The output of a custom tool call. */
export function customOutput(
  callId: string,
  output: string | readonly ToolOutputPart[],
): CustomToolCallOutputItem {
  return { type: "custom_tool_call_output", call_id: callId, output };
}

/** The output item for a call of either kind. */
export function outputFor(
  call: ToolCall,
  output: string | readonly ToolOutputPart[],
): FunctionCallOutputItem | CustomToolCallOutputItem {
  return call.kind === "function"
    ? functionOutput(call.callId, output)
    : customOutput(call.callId, output);
}

const ROLES = new Set(["user", "assistant", "developer", "system"]);
const DETAILS = new Set(["auto", "low", "high", "original"]);

function str(
  value: unknown,
  path: Path,
  issues: Issue[],
  what: string,
): string {
  if (typeof value !== "string") {
    issues.push({
      path,
      message: `${what} must be a string, got ${describeValue(value)}`,
    });
    return "";
  }
  return value;
}

function optionalId(raw: Record<string, unknown>, path: Path, issues: Issue[]) {
  if (raw.id === undefined || raw.id === null) return {};
  return { id: str(raw.id, [...path, "id"], issues, "id") };
}

function part(
  raw: unknown,
  path: Path,
  issues: Issue[],
  allowed: ReadonlySet<string>,
): ContentPart | null {
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      message: `a content part must be an object, got ${describeValue(raw)}`,
    });
    return null;
  }
  const type = raw.type;
  if (typeof type !== "string" || !allowed.has(type)) {
    issues.push({
      path: [...path, "type"],
      message: `unsupported content part type ${JSON.stringify(type)}`,
    });
    return null;
  }
  switch (type) {
    case "input_text":
    case "output_text":
      return { type, text: str(raw.text, [...path, "text"], issues, "text") };
    case "refusal":
      return {
        type,
        refusal: str(raw.refusal, [...path, "refusal"], issues, "refusal"),
      };
    default: {
      const hasUrl = typeof raw.image_url === "string" && raw.image_url !== "";
      const hasFile = typeof raw.file_id === "string" && raw.file_id !== "";
      if (hasUrl === hasFile) {
        issues.push({
          path,
          message: "an image needs exactly one of image_url and file_id",
        });
      }
      if (
        raw.detail !== undefined && raw.detail !== null &&
        !DETAILS.has(raw.detail as string)
      ) {
        issues.push({
          path: [...path, "detail"],
          message: "detail must be auto, low, high or original",
        });
      }
      return {
        type: "input_image",
        ...(hasUrl ? { image_url: raw.image_url as string } : {}),
        ...(hasFile ? { file_id: raw.file_id as string } : {}),
        ...(typeof raw.detail === "string"
          ? { detail: raw.detail as ImageDetail }
          : {}),
      };
    }
  }
}

const MESSAGE_PARTS = new Set([
  "input_text",
  "input_image",
  "output_text",
  "refusal",
]);
const TOOL_PARTS = new Set(["input_text", "input_image"]);

function toolOutput(
  raw: unknown,
  path: Path,
  issues: Issue[],
): string | ToolOutputPart[] {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) {
    issues.push({
      path,
      message: `a tool output must be a string or a list of parts, got ${
        describeValue(raw)
      }`,
    });
    return "";
  }
  return raw.flatMap((item, index) => {
    const parsed = part(item, [...path, index], issues, TOOL_PARTS);
    return parsed === null ? [] : [parsed as ToolOutputPart];
  });
}

/** The item kinds {@link normalizeItem} understands. */
export const ITEM_TYPES: ReadonlySet<string> = new Set([
  "message",
  "reasoning",
  "function_call",
  "custom_tool_call",
  "function_call_output",
  "custom_tool_call_output",
]);

/**
 * Normalises one item to the shape Codex replays, appending problems to
 * `issues`. Returns null for kinds this library does not replay (such as
 * `web_search_call`) without an issue; callers decide what to do with them.
 */
export function normalizeItem(
  raw: unknown,
  path: Path,
  issues: Issue[],
): Item | null {
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      message: `an item must be an object, got ${describeValue(raw)}`,
    });
    return null;
  }
  const type = raw.type ?? (raw.role !== undefined ? "message" : undefined);
  if (typeof type !== "string") {
    issues.push({ path: [...path, "type"], message: "an item needs a type" });
    return null;
  }
  if (!ITEM_TYPES.has(type)) return null;
  const before = issues.length;
  let item: Item;
  switch (type) {
    case "message": {
      const role = raw.role;
      if (typeof role !== "string" || !ROLES.has(role)) {
        issues.push({
          path: [...path, "role"],
          message: "role must be user, assistant, developer or system",
        });
      }
      let content: ContentPart[] = [];
      if (typeof raw.content === "string") {
        content = [
          role === "assistant"
            ? { type: "output_text", text: raw.content }
            : text(raw.content),
        ];
      } else if (Array.isArray(raw.content)) {
        content = raw.content.flatMap((entry, index) => {
          const parsed = part(
            entry,
            [...path, "content", index],
            issues,
            MESSAGE_PARTS,
          );
          return parsed === null ? [] : [parsed];
        });
      } else {
        issues.push({
          path: [...path, "content"],
          message: "content must be a string or a list of parts",
        });
      }
      const phase = raw.phase === "commentary" || raw.phase === "final_answer"
        ? { phase: raw.phase }
        : {};
      item = {
        type: "message",
        ...optionalId(raw, path, issues),
        role: role as Role,
        content,
        ...phase,
      } as MessageItem;
      break;
    }
    case "reasoning": {
      const summary: SummaryText[] = [];
      if (Array.isArray(raw.summary)) {
        raw.summary.forEach((entry, index) => {
          if (isPlainObject(entry) && typeof entry.text === "string") {
            summary.push({ type: "summary_text", text: entry.text });
          } else {
            issues.push({
              path: [...path, "summary", index],
              message: "a summary part needs text",
            });
          }
        });
      } else if (raw.summary !== undefined && raw.summary !== null) {
        issues.push({
          path: [...path, "summary"],
          message: "summary must be a list",
        });
      }
      const encrypted = raw.encrypted_content;
      if (
        encrypted !== undefined && encrypted !== null &&
        typeof encrypted !== "string"
      ) {
        issues.push({
          path: [...path, "encrypted_content"],
          message: "encrypted_content must be a string",
        });
      }
      item = {
        type: "reasoning",
        ...optionalId(raw, path, issues),
        summary,
        encrypted_content: typeof encrypted === "string" ? encrypted : null,
      };
      break;
    }
    case "function_call":
      item = {
        type: "function_call",
        ...optionalId(raw, path, issues),
        call_id: str(raw.call_id, [...path, "call_id"], issues, "call_id"),
        name: str(raw.name, [...path, "name"], issues, "name"),
        arguments: typeof raw.arguments === "string"
          ? raw.arguments
          : raw.arguments === undefined || raw.arguments === null
          ? ""
          : JSON.stringify(raw.arguments),
        ...(typeof raw.namespace === "string"
          ? { namespace: raw.namespace }
          : {}),
      };
      break;
    case "custom_tool_call":
      item = {
        type: "custom_tool_call",
        ...optionalId(raw, path, issues),
        call_id: str(raw.call_id, [...path, "call_id"], issues, "call_id"),
        name: str(raw.name, [...path, "name"], issues, "name"),
        input: typeof raw.input === "string"
          ? raw.input
          : str(raw.input, [...path, "input"], issues, "input"),
        ...(typeof raw.namespace === "string"
          ? { namespace: raw.namespace }
          : {}),
      };
      break;
    case "function_call_output":
    case "custom_tool_call_output":
      item = {
        type,
        call_id: str(raw.call_id, [...path, "call_id"], issues, "call_id"),
        output: toolOutput(raw.output, [...path, "output"], issues),
      };
      break;
    default:
      return null;
  }
  if ("call_id" in item && item.call_id === "" && issues.length === before) {
    issues.push({
      path: [...path, "call_id"],
      message: "call_id must not be empty",
    });
  }
  return issues.length === before ? item : null;
}

/** The tool calls among `items`, in order. */
export function toolCallsOf(items: readonly Item[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const item of items) {
    if (item.type === "function_call") {
      out.push({
        kind: "function",
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    } else if (item.type === "custom_tool_call") {
      out.push({
        kind: "custom",
        callId: item.call_id,
        name: item.name,
        input: item.input,
      });
    }
  }
  return out;
}

/** Calls in `items` that have no output item yet. */
export function pendingCalls(items: readonly Item[]): ToolCall[] {
  const answered = new Set<string>();
  for (const item of items) {
    if (
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output"
    ) {
      answered.add(item.call_id);
    }
  }
  return toolCallsOf(items).filter((call) => !answered.has(call.callId));
}

/** Every assistant `output_text`, joined by blank lines. */
export function assistantText(
  items: readonly Item[],
  phase?: "final_answer",
): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type !== "message" || item.role !== "assistant") continue;
    if (phase !== undefined && item.phase !== phase) continue;
    const textParts = item.content.flatMap((entry) =>
      entry.type === "output_text" ? [entry.text] : []
    );
    if (textParts.length > 0) parts.push(textParts.join(""));
  }
  return parts.join("\n\n");
}

/** The first refusal in the assistant messages, or null. */
export function refusalOf(items: readonly Item[]): string | null {
  for (const item of items) {
    if (item.type !== "message" || item.role !== "assistant") continue;
    for (const entry of item.content) {
      if (entry.type === "refusal") return entry.refusal;
    }
  }
  return null;
}

/** A usage object from the API's snake_case form; null if absent. */
export function usageFrom(raw: unknown): Usage | null {
  if (!isPlainObject(raw)) return null;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : 0;
  const input = count(raw.input_tokens);
  const output = count(raw.output_tokens);
  const inputDetails = isPlainObject(raw.input_tokens_details)
    ? raw.input_tokens_details
    : {};
  const outputDetails = isPlainObject(raw.output_tokens_details)
    ? raw.output_tokens_details
    : {};
  return {
    inputTokens: input,
    cachedInputTokens: count(inputDetails.cached_tokens),
    outputTokens: output,
    reasoningTokens: count(outputDetails.reasoning_tokens),
    totalTokens: raw.total_tokens === undefined
      ? input + output
      : count(raw.total_tokens),
  };
}

/** No usage. */
export const ZERO_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

/** The sum of usages. */
export function addUsage(...usages: readonly Usage[]): Usage {
  return usages.reduce((sum, usage) => ({
    inputTokens: sum.inputTokens + usage.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
    outputTokens: sum.outputTokens + usage.outputTokens,
    reasoningTokens: sum.reasoningTokens + usage.reasoningTokens,
    totalTokens: sum.totalTokens + usage.totalTokens,
  }), ZERO_USAGE);
}

/** An item as a JSON object, for places typed as JSON. */
export function itemJson(item: Item): JsonObject {
  return item as unknown as JsonObject;
}
