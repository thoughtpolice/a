// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The Responses API shapes this library sends and keeps, narrowed to what
 * the ChatGPT (Codex) backend is known to accept.
 *
 * Items follow Codex's `ResponseItem` serialisation
 * (`codex-rs/protocol/src/models.rs`), which is what the backend receives
 * from the official client every turn: messages keep `role`, `content` and
 * `phase`; reasoning keeps `summary` and `encrypted_content`; tool calls keep
 * their `call_id`, `name` and arguments or input. Fields the public API adds
 * on output (`status`, `annotations`, `logprobs`) are dropped when an item is
 * stored, exactly as Codex drops them, so what is replayed is what Codex
 * would replay.
 *
 * @module
 */

import type { JsonObject } from "./json.ts";
import type { RateLimitSnapshot } from "./ratelimits.ts";

/** Who wrote a message. `developer` is the Responses API's system role. */
export type Role = "user" | "assistant" | "developer" | "system";

/** Image detail; `original` is accepted by models that support it. */
export type ImageDetail = "auto" | "low" | "high" | "original";

/** Text from the user, developer or a tool. */
export interface InputText {
  readonly type: "input_text";
  readonly text: string;
}

/** An image by URL (`https:` or `data:`) or uploaded file id. */
export interface InputImage {
  readonly type: "input_image";
  readonly image_url?: string;
  readonly file_id?: string;
  readonly detail?: ImageDetail;
}

/** Text the model wrote. */
export interface OutputText {
  readonly type: "output_text";
  readonly text: string;
}

/** A refusal the model wrote instead of text. */
export interface Refusal {
  readonly type: "refusal";
  readonly refusal: string;
}

/** Any message content part. */
export type ContentPart = InputText | InputImage | OutputText | Refusal;

/** A message. */
export interface MessageItem {
  readonly type: "message";
  readonly id?: string;
  readonly role: Role;
  readonly content: readonly ContentPart[];
  /** `commentary` (mid-turn narration) or `final_answer`, when reported. */
  readonly phase?: "commentary" | "final_answer";
}

/** One reasoning summary part. */
export interface SummaryText {
  readonly type: "summary_text";
  readonly text: string;
}

/**
 * The model's reasoning. With `store: false` the server keeps nothing, so
 * `encrypted_content` is the only way the next turn can see this reasoning:
 * it must be replayed verbatim.
 */
export interface ReasoningItem {
  readonly type: "reasoning";
  readonly id?: string;
  readonly summary: readonly SummaryText[];
  readonly encrypted_content: string | null;
}

/** A call to a function tool; `arguments` is a JSON string. */
export interface FunctionCallItem {
  readonly type: "function_call";
  readonly id?: string;
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
  readonly namespace?: string;
}

/** A call to a custom (freeform) tool; `input` is free text. */
export interface CustomToolCallItem {
  readonly type: "custom_tool_call";
  readonly id?: string;
  readonly call_id: string;
  readonly name: string;
  readonly input: string;
  readonly namespace?: string;
}

/** What a tool returns: text, or text and image parts. */
export type ToolOutputPart = InputText | InputImage;

/** The result of a function call. */
export interface FunctionCallOutputItem {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string | readonly ToolOutputPart[];
}

/** The result of a custom tool call. */
export interface CustomToolCallOutputItem {
  readonly type: "custom_tool_call_output";
  readonly call_id: string;
  readonly output: string | readonly ToolOutputPart[];
}

/** Every item kind this library sends and replays. */
export type Item =
  | MessageItem
  | ReasoningItem
  | FunctionCallItem
  | CustomToolCallItem
  | FunctionCallOutputItem
  | CustomToolCallOutputItem;

/** A tool call the model made, in one shape for both tool kinds. */
export type ToolCall =
  | {
    readonly kind: "function";
    readonly callId: string;
    readonly name: string;
    /** The raw JSON argument string, as the model wrote it. */
    readonly arguments: string;
  }
  | {
    readonly kind: "custom";
    readonly callId: string;
    readonly name: string;
    /** The freeform input, as the model wrote it. */
    readonly input: string;
  };

/** Reasoning effort, as sent on the wire. */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** How much reasoning summary to stream back. */
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

/** Answer length, for models that support `text.verbosity`. */
export type Verbosity = "low" | "medium" | "high";

/** A function tool definition, as sent. */
export interface FunctionToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly strict: boolean;
}

/** A custom tool's input format: free text, or a Lark/regex grammar. */
export type CustomToolFormat =
  | { readonly type: "text" }
  | {
    readonly type: "grammar";
    readonly syntax: "lark" | "regex";
    readonly definition: string;
  };

/** A custom (freeform) tool definition, as sent. */
export interface CustomToolDefinition {
  readonly type: "custom";
  readonly name: string;
  readonly description: string;
  readonly format?: CustomToolFormat;
}

/** Any tool definition. */
export type ToolDefinition = FunctionToolDefinition | CustomToolDefinition;

/**
 * Which tools the model may call. Codex always sends `"auto"`; the others
 * are the public API's and are passed through unverified.
 */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "function"; readonly name: string }
  | { readonly type: "custom"; readonly name: string };

/** A JSON-schema output format (`text.format`). */
export interface OutputFormat {
  /** 1 to 64 letters, digits, `_` or `-`. */
  readonly name: string;
  readonly schema: JsonObject;
  /** Server-side strict decoding; default true. */
  readonly strict?: boolean;
  readonly description?: string;
}

/** Token usage for one response. */
export interface Usage {
  readonly inputTokens: number;
  /** Input tokens served from the prompt cache. */
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** Output tokens spent on reasoning. */
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

/** Facts about how a turn was obtained. Plain data. */
export interface TurnMeta {
  /** HTTP attempts, including retries. */
  readonly attempts: number;
  /** Milliseconds from the call to the result, including waits. */
  readonly latencyMs: number;
  /** The answering response's request id header, if any. */
  readonly requestId: string | null;
  /** The `prompt_cache_key` that was sent. */
  readonly promptCacheKey: string;
  /** The request encoding used (see `encoding` on the client). */
  readonly encoding: "standard" | "lite";
  /** Rate-limit windows from the response headers or stream. */
  readonly rateLimits: readonly RateLimitSnapshot[];
}

/**
 * One completed model response, as plain data: it can cross Durable Object
 * RPC, be a Workflow step result, and be stored.
 */
export interface Turn {
  /** The response id (`resp_...`), or null if the stream gave none. */
  readonly id: string | null;
  /** The model requested. */
  readonly model: string;
  /**
   * The model that answered, from the `openai-model` header or the
   * response; it can differ when the backend reroutes. Null if unreported.
   */
  readonly servedModel: string | null;
  /**
   * The access programs the backend applied to the response, such as
   * `{cyber: "daybreak_blue"}` for the Daybreak Blue models. Null when the
   * response reports none.
   */
  readonly accessPrograms: Readonly<Record<string, string>> | null;
  /** The output items, normalised for replay, in output order. */
  readonly output: readonly Item[];
  /** Output items of kinds this library does not replay, as received. */
  readonly otherOutput: readonly JsonObject[];
  /** The assistant's text: every `output_text` part, joined. */
  readonly text: string;
  /** The final-answer text: `final_answer` messages, else all text. */
  readonly finalText: string;
  /** The model's refusal text, if it refused. */
  readonly refusal: string | null;
  /** The reasoning summary parts, in order. */
  readonly reasoningSummary: readonly string[];
  /** The tool calls the model made, in order. */
  readonly toolCalls: readonly ToolCall[];
  /** Token usage; zeros when the response reported none. */
  readonly usage: Usage;
  /** Whether usage was reported at all. */
  readonly usageReported: boolean;
  /** The backend's `end_turn`, when reported. */
  readonly endTurn: boolean | null;
  readonly meta: TurnMeta;
}

/** One entry of `GET /models`. */
export interface ModelCard {
  /** The id to send as `model`. */
  readonly id: string;
  readonly displayName: string | null;
  /** The entry as received. */
  readonly raw: JsonObject;
}
