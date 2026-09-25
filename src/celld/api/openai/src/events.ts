// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Turning the Responses event stream into typed events and one final
 * {@link Turn}.
 *
 * The events handled, and how, follow Codex's `process_responses_event`
 * (`codex-rs/codex-api/src/sse/responses.rs`) and the public Responses API
 * reference:
 *
 * - `response.output_item.done` carries each finished output item; items
 *   are ordered by `output_index`. If an item never got its `done` event
 *   but the response completed, it is rebuilt from `output_item.added` and
 *   the deltas that followed it.
 * - `response.output_text.delta`, `response.refusal.delta`,
 *   `response.reasoning_summary_text.delta`/`.done`,
 *   `response.function_call_arguments.delta` and
 *   `response.custom_tool_call_input.delta` are surfaced as they arrive.
 * - `response.completed` ends the response and carries `usage` (and, on
 *   the ChatGPT backend, `end_turn`).
 * - `response.failed` and `response.incomplete` end it with an error.
 * - An `error` event is remembered and reported if the stream then ends
 *   without completing, as Codex does.
 * - `codex.rate_limits` events update the rate-limit snapshot.
 * - Everything else (`response.in_progress`, `content_part.*`, `*.done`
 *   echoes, metadata) is ignored, and so is an event whose data is not
 *   JSON, as in Codex.
 *
 * @module
 */

import type { SseEvent } from "@celld/http/sse";
import {
  apiErrorFromEvent,
  GptApiError,
  GptDecodeError,
  type GptError,
  type GptErrorData,
} from "./errors.ts";
import {
  assistantText,
  normalizeItem,
  refusalOf,
  toolCallsOf,
  usageFrom,
  ZERO_USAGE,
} from "./items.ts";
import {
  isPlainObject,
  type Issue,
  type JsonObject,
  tryParseJson,
} from "./json.ts";
import { parseRateLimitEvent, type RateLimitSnapshot } from "./ratelimits.ts";
import type { Item, Turn, TurnMeta, Usage } from "./types.ts";

/** One event of a streaming response, as the caller sees it. */
export type StreamEvent =
  /** The response started. */
  | { readonly type: "created"; readonly responseId: string | null }
  /** The model that is answering, when the server reports it. */
  | { readonly type: "model"; readonly model: string }
  /** Rate-limit windows, from headers or a `codex.rate_limits` event. */
  | {
    readonly type: "rate_limits";
    readonly rateLimits: readonly RateLimitSnapshot[];
  }
  /** An output item started; `itemType` is its `type` (`message`, `function_call`...). */
  | {
    readonly type: "item.added";
    readonly outputIndex: number | null;
    readonly itemType: string;
  }
  /** Assistant text. */
  | {
    readonly type: "text.delta";
    readonly itemId: string | null;
    readonly delta: string;
  }
  /** Refusal text. */
  | {
    readonly type: "refusal.delta";
    readonly itemId: string | null;
    readonly delta: string;
  }
  /** Reasoning summary text. */
  | {
    readonly type: "reasoning.delta";
    readonly itemId: string | null;
    readonly summaryIndex: number;
    readonly delta: string;
  }
  /** A finished reasoning summary part. */
  | {
    readonly type: "reasoning.done";
    readonly itemId: string | null;
    readonly summaryIndex: number;
    readonly text: string;
  }
  /** Function-call arguments or custom-tool input, as it streams. */
  | {
    readonly type: "tool.delta";
    readonly kind: "function" | "custom";
    readonly itemId: string | null;
    readonly callId: string | null;
    readonly name: string | null;
    readonly delta: string;
  }
  /** An output item finished; `item` is null for kinds not replayed. */
  | {
    readonly type: "item.done";
    readonly outputIndex: number | null;
    readonly item: Item | null;
  }
  /**
   * The attempt failed before any output and will be retried after
   * `delayMs`.
   */
  | {
    readonly type: "retry";
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: GptErrorData;
  }
  /** The response completed; `turn` is the result. */
  | { readonly type: "completed"; readonly turn: Turn };

/** The event types that carry model output. */
export const OUTPUT_EVENTS: ReadonlySet<StreamEvent["type"]> = new Set([
  "item.added",
  "text.delta",
  "refusal.delta",
  "reasoning.delta",
  "reasoning.done",
  "tool.delta",
  "item.done",
]);

interface Slot {
  raw: JsonObject;
  done: boolean;
  arrival: number;
  outputIndex: number | null;
  /** Accumulated text, arguments or input from deltas. */
  accumulated: string;
  summaries: Map<number, string>;
}

function index(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** What {@link ResponseAccumulator.state} reports. */
export type AccumulatorState =
  | "open"
  | "completed"
  | "failed"
  | "incomplete";

/**
 * Consumes decoded SSE events for one response and builds the {@link Turn}.
 * One accumulator per HTTP attempt.
 */
export class ResponseAccumulator {
  #state: AccumulatorState = "open";
  #error: GptError | null = null;
  #pendingError: GptApiError | null = null;
  #responseId: string | null = null;
  #servedModel: string | null = null;
  #accessPrograms: Readonly<Record<string, string>> | null = null;
  #usage: Usage | null = null;
  #endTurn: boolean | null = null;
  #slots: Slot[] = [];
  #byIndex = new Map<number, Slot>();
  #byId = new Map<string, Slot>();
  #rateLimits: RateLimitSnapshot[] = [];
  #skipped = 0;
  readonly #requestId: string | null;

  constructor(requestId: string | null = null) {
    this.#requestId = requestId;
  }

  /** Whether the response has ended, and how. */
  get state(): AccumulatorState {
    return this.#state;
  }

  /** The error a `failed` or `incomplete` response ended with. */
  get error(): GptError | null {
    return this.#error;
  }

  /** An `error` event seen before the stream ended, if any. */
  get pendingError(): GptApiError | null {
    return this.#pendingError;
  }

  /** Events whose data was not JSON, skipped. */
  get skipped(): number {
    return this.#skipped;
  }

  /** Whether anything was produced that a consumer could have acted on. */
  get producedOutput(): boolean {
    return this.#slots.length > 0;
  }

  /** Records the model named by the `openai-model` header. */
  setServedModel(model: string): void {
    this.#servedModel = model;
  }

  /** Rate limits seen in the stream. */
  get rateLimits(): readonly RateLimitSnapshot[] {
    return this.#rateLimits;
  }

  #slot(data: Record<string, unknown>, create: boolean): Slot | null {
    const outputIndex = index(data.output_index);
    const itemId = stringOrNull(data.item_id);
    const found =
      (outputIndex !== null ? this.#byIndex.get(outputIndex) : undefined) ??
        (itemId !== null ? this.#byId.get(itemId) : undefined);
    if (found !== undefined || !create) return found ?? null;
    const slot: Slot = {
      raw: {},
      done: false,
      arrival: this.#slots.length,
      outputIndex,
      accumulated: "",
      summaries: new Map(),
    };
    this.#slots.push(slot);
    if (outputIndex !== null) this.#byIndex.set(outputIndex, slot);
    if (itemId !== null) this.#byId.set(itemId, slot);
    return slot;
  }

  #placeItem(data: Record<string, unknown>, done: boolean): Slot | null {
    if (!isPlainObject(data.item)) return null;
    const raw = data.item as JsonObject;
    const outputIndex = index(data.output_index);
    const id = stringOrNull(raw.id);
    let slot =
      (outputIndex !== null ? this.#byIndex.get(outputIndex) : undefined) ??
        (id !== null ? this.#byId.get(id) : undefined);
    if (slot === undefined) {
      slot = {
        raw,
        done,
        arrival: this.#slots.length,
        outputIndex,
        accumulated: "",
        summaries: new Map(),
      };
      this.#slots.push(slot);
    } else {
      slot.raw = raw;
      slot.done = slot.done || done;
      slot.outputIndex ??= outputIndex;
    }
    if (outputIndex !== null) this.#byIndex.set(outputIndex, slot);
    if (id !== null) this.#byId.set(id, slot);
    return slot;
  }

  /** Handles one SSE event; returns the stream events it produced. */
  handle(event: SseEvent): StreamEvent[] {
    if (this.#state !== "open") return [];
    const parsed = tryParseJson(event.data);
    if (!isPlainObject(parsed)) {
      this.#skipped++;
      return [];
    }
    const data = parsed as Record<string, unknown>;
    const type = typeof data.type === "string" ? data.type : event.event;
    const out: StreamEvent[] = [];
    switch (type) {
      case "response.created":
      case "response.in_progress": {
        const response = isPlainObject(data.response) ? data.response : {};
        const id = stringOrNull(response.id);
        if (typeof response.model === "string" && this.#servedModel === null) {
          this.#servedModel = response.model;
        }
        this.#accessPrograms = accessProgramsOf(response.access_programs) ??
          this.#accessPrograms;
        if (type === "response.created") {
          this.#responseId = id ?? this.#responseId;
          out.push({ type: "created", responseId: id });
        } else if (id !== null) {
          this.#responseId ??= id;
        }
        break;
      }
      case "response.output_item.added": {
        const slot = this.#placeItem(data, false);
        if (slot !== null) {
          out.push({
            type: "item.added",
            outputIndex: slot.outputIndex,
            itemType: typeof slot.raw.type === "string"
              ? slot.raw.type
              : "unknown",
          });
        }
        break;
      }
      case "response.output_item.done": {
        const slot = this.#placeItem(data, true);
        if (slot !== null) {
          const issues: Issue[] = [];
          const item = normalizeItem(slot.raw, [
            "output",
            slot.outputIndex ?? slot.arrival,
          ], issues);
          out.push({ type: "item.done", outputIndex: slot.outputIndex, item });
        }
        break;
      }
      case "response.output_text.delta":
      case "response.refusal.delta": {
        const delta = stringOrNull(data.delta);
        if (delta === null) break;
        const slot = this.#slot(data, true)!;
        if (type === "response.output_text.delta") slot.accumulated += delta;
        out.push({
          type: type === "response.output_text.delta"
            ? "text.delta"
            : "refusal.delta",
          itemId: stringOrNull(data.item_id),
          delta,
        });
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done": {
        const summaryIndex = index(data.summary_index) ?? 0;
        const slot = this.#slot(data, true)!;
        if (type.endsWith(".delta")) {
          const delta = stringOrNull(data.delta);
          if (delta === null) break;
          slot.summaries.set(
            summaryIndex,
            (slot.summaries.get(summaryIndex) ?? "") + delta,
          );
          out.push({
            type: "reasoning.delta",
            itemId: stringOrNull(data.item_id),
            summaryIndex,
            delta,
          });
        } else {
          const text = stringOrNull(data.text) ??
            slot.summaries.get(summaryIndex) ?? "";
          slot.summaries.set(summaryIndex, text);
          out.push({
            type: "reasoning.done",
            itemId: stringOrNull(data.item_id),
            summaryIndex,
            text,
          });
        }
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const delta = stringOrNull(data.delta);
        if (delta === null) break;
        const slot = this.#slot(data, true)!;
        slot.accumulated += delta;
        out.push({
          type: "tool.delta",
          kind: type.startsWith("response.function") ? "function" : "custom",
          itemId: stringOrNull(data.item_id),
          callId: stringOrNull(slot.raw.call_id) ?? stringOrNull(data.call_id),
          name: stringOrNull(slot.raw.name),
          delta,
        });
        break;
      }
      case "response.completed": {
        const response = isPlainObject(data.response) ? data.response : {};
        this.#responseId = stringOrNull(response.id) ?? this.#responseId;
        if (typeof response.model === "string" && this.#servedModel === null) {
          this.#servedModel = response.model;
        }
        this.#accessPrograms = accessProgramsOf(response.access_programs) ??
          this.#accessPrograms;
        this.#usage = usageFrom(response.usage);
        this.#endTurn = typeof response.end_turn === "boolean"
          ? response.end_turn
          : null;
        if (Array.isArray(response.output)) {
          response.output.forEach((raw, position) => {
            if (!isPlainObject(raw)) return;
            const existing = this.#byIndex.get(position) ??
              (typeof raw.id === "string" ? this.#byId.get(raw.id) : undefined);
            if (existing === undefined || !existing.done) {
              this.#placeItem({ item: raw, output_index: position }, true);
            }
          });
        }
        this.#state = "completed";
        break;
      }
      case "response.failed": {
        const response = isPlainObject(data.response) ? data.response : {};
        this.#error = apiErrorFromEvent(
          response.error,
          "the response failed",
          this.#requestId,
        );
        this.#state = "failed";
        break;
      }
      case "response.incomplete": {
        const response = isPlainObject(data.response) ? data.response : {};
        const details = isPlainObject(response.incomplete_details)
          ? response.incomplete_details
          : {};
        const reason = stringOrNull(details.reason) ?? "unknown";
        this.#usage = usageFrom(response.usage);
        this.#error = new GptApiError(
          "incomplete",
          `the response is incomplete: ${reason}`,
          {
            status: 200,
            code: reason,
            requestId: this.#requestId,
            body: response as JsonObject,
          },
        );
        this.#state = "incomplete";
        break;
      }
      case "error": {
        this.#pendingError = apiErrorFromEvent(
          isPlainObject(data.error) ? data.error : data,
          "the stream reported an error",
          this.#requestId,
        );
        break;
      }
      case "codex.rate_limits": {
        const snapshot = parseRateLimitEvent(data);
        if (snapshot !== null) {
          this.#rateLimits = [
            ...this.#rateLimits.filter((item) =>
              item.limitId !== snapshot.limitId
            ),
            snapshot,
          ];
          out.push({ type: "rate_limits", rateLimits: [snapshot] });
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** The usage reported so far (by `completed` or `incomplete`), or null. */
  get usage(): Usage | null {
    return this.#usage;
  }

  #itemFromSlot(slot: Slot): JsonObject {
    const raw = { ...slot.raw };
    if (slot.done) return raw;
    // Rebuilt from `added` plus deltas: the item never got its `done`.
    if (raw.type === "message" && slot.accumulated !== "") {
      const content = Array.isArray(raw.content) ? raw.content : [];
      if (content.length === 0) {
        raw.content = [{ type: "output_text", text: slot.accumulated }];
      }
    } else if (raw.type === "function_call" && !raw.arguments) {
      raw.arguments = slot.accumulated;
    } else if (raw.type === "custom_tool_call" && !raw.input) {
      raw.input = slot.accumulated;
    } else if (raw.type === "reasoning" && slot.summaries.size > 0) {
      const summary = Array.isArray(raw.summary) ? raw.summary : [];
      if (summary.length === 0) {
        raw.summary = [...slot.summaries.entries()].sort((a, b) => a[0] - b[0])
          .map(([, text]) => ({ type: "summary_text", text }));
      }
    }
    return raw;
  }

  /**
   * The finished turn. Call only when {@link state} is `completed`.
   *
   * @throws {GptDecodeError} an output item of a known kind is malformed.
   */
  turn(model: string, meta: TurnMeta): Turn {
    const ordered = this.#slots.filter((slot) =>
      typeof slot.raw.type === "string"
    )
      .sort((a, b) =>
        (a.outputIndex ?? Number.MAX_SAFE_INTEGER) -
          (b.outputIndex ?? Number.MAX_SAFE_INTEGER) || a.arrival - b.arrival
      );
    const issues: Issue[] = [];
    const output: Item[] = [];
    const otherOutput: JsonObject[] = [];
    ordered.forEach((slot, position) => {
      const raw = this.#itemFromSlot(slot);
      const before = issues.length;
      const item = normalizeItem(raw, ["output", position], issues);
      if (item !== null) output.push(item);
      else if (issues.length === before) otherOutput.push(raw);
    });
    if (issues.length > 0) {
      throw new GptDecodeError(issues, {
        status: 200,
        requestId: this.#requestId,
      });
    }
    const text = assistantText(output);
    const finalText = assistantText(output, "final_answer");
    const reasoningSummary = output.flatMap((item) =>
      item.type === "reasoning" ? item.summary.map((part) => part.text) : []
    );
    return {
      id: this.#responseId,
      model,
      servedModel: this.#servedModel,
      accessPrograms: this.#accessPrograms,
      output,
      otherOutput,
      text,
      finalText: finalText === "" ? text : finalText,
      refusal: refusalOf(output),
      reasoningSummary,
      toolCalls: toolCallsOf(output),
      usage: this.#usage ?? ZERO_USAGE,
      usageReported: this.#usage !== null,
      endTurn: this.#endTurn,
      meta: {
        ...meta,
        rateLimits: [
          ...meta.rateLimits.filter((snapshot) =>
            !this.#rateLimits.some((item) => item.limitId === snapshot.limitId)
          ),
          ...this.#rateLimits,
        ],
      },
    };
  }
}

/**
 * An accumulator fed a whole (non-streaming) response object, for a proxy
 * that answers with JSON despite `stream: true`.
 */
export function accumulateResponseObject(
  response: unknown,
  requestId: string | null,
): ResponseAccumulator {
  const accumulator = new ResponseAccumulator(requestId);
  const status = isPlainObject(response) ? response.status : undefined;
  const type = status === "failed"
    ? "response.failed"
    : status === "incomplete"
    ? "response.incomplete"
    : "response.completed";
  accumulator.handle({
    event: "message",
    data: JSON.stringify({ type, response }),
    id: null,
    retry: null,
  });
  return accumulator;
}

/**
 * The `access_programs` object of a response (for example
 * `{cyber: "daybreak_blue"}`), keeping string values only; null when absent,
 * `null` on the wire, or empty.
 */
function accessProgramsOf(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) return null;
  const programs: Record<string, string> = {};
  for (const [key, program] of Object.entries(value)) {
    if (typeof program === "string") programs[key] = program;
  }
  return Object.keys(programs).length === 0 ? null : Object.freeze(programs);
}
