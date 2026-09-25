// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/testing`: a scripted fake of the Responses endpoint for code
 * that uses `@celld/api/openai`, plus `@celld/http/testing`'s virtual clock and
 * Workflow step double, re-exported. No network, no subscription.
 *
 * ```ts
 * const fake = new FakeResponses([
 *   { toolCalls: [{ name: "read_file", arguments: { path: "a.ts", offset: null, limit: null } }] },
 *   (request) => ({ text: `saw ${request.body.input.length} items` }),
 * ]);
 * const gpt = new GptClient({ fetch: fake.fetch, runtime: virtualRuntime() });
 * // fake.requests: every POST /responses body, parsed
 * ```
 *
 * The event sequences {@link turnEvents} produces follow the public
 * Responses API reference and what Codex handles: `response.created`, each
 * output item's `added`, deltas and `done`, then `response.completed` with
 * usage. Streams can be cut short, split into arbitrary byte chunks, or end
 * in `response.failed` / `response.incomplete`, to exercise the client's
 * handling of each.
 *
 * @module
 */

import type { FetchLike } from "@celld/http";
import type { ShellResult, ShellRunner } from "./coding.ts";
import type { JsonObject } from "./json.ts";

export {
  type FakeStep,
  fakeStep,
  type VirtualRuntime,
  virtualRuntime,
} from "@celld/http/testing";

/** One scripted tool call. */
export type FakeToolCall =
  | {
    readonly name: string;
    /** An object is JSON-encoded; a string is sent as is (it may be bad JSON). */
    readonly arguments: JsonObject | string;
    readonly callId?: string;
  }
  | {
    readonly name: string;
    /** A custom (freeform) tool's input. */
    readonly input: string;
    readonly callId?: string;
  };

/** A scripted response. */
export interface TurnSpec {
  /** The response id; default `resp_<n>`. */
  readonly id?: string;
  /** Assistant text; an array is sent as separate deltas. */
  readonly text?: string | readonly string[];
  readonly phase?: "commentary" | "final_answer";
  readonly refusal?: string;
  /** A reasoning summary; a reasoning item is emitted when this or `encrypted` is set. */
  readonly reasoning?: string;
  /** The reasoning's `encrypted_content`; default `enc_<response id>`. */
  readonly encrypted?: string;
  readonly toolCalls?: readonly FakeToolCall[];
  readonly usage?: {
    readonly input?: number;
    readonly cached?: number;
    readonly output?: number;
    readonly reasoning?: number;
  };
  /** How the response ends; default `completed`. */
  readonly status?: "completed" | "failed" | "incomplete";
  /** For `failed`: the error object. */
  readonly error?: { readonly code: string; readonly message: string };
  /** For `incomplete`: the reason; default `max_output_tokens`. */
  readonly incompleteReason?: string;
  readonly endTurn?: boolean;
  /** Stop the stream after this many events (no terminal event). */
  readonly cutAfter?: number;
  /** Put the full output list in `response.completed` too; default true. */
  readonly completedOutput?: boolean;
  /** Extra response headers (rate limits, `openai-model`, request id). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Byte chunk size for the stream; default: one chunk per event. */
  readonly chunkSize?: number;
  /** Milliseconds to wait (real time) before each chunk. */
  readonly delayMs?: number;
}

let counter = 0;

/** The event payloads for a scripted response, in order. */
export function turnEvents(
  spec: TurnSpec,
  model = "gpt-6-astra",
): JsonObject[] {
  const id = spec.id ?? `resp_${++counter}`;
  const events: JsonObject[] = [];
  const output: JsonObject[] = [];
  let index = 0;
  const base = { id, object: "response", model };
  events.push({
    type: "response.created",
    response: { ...base, status: "in_progress", output: [] },
  });
  events.push({
    type: "response.in_progress",
    response: { ...base, status: "in_progress", output: [] },
  });
  if (spec.reasoning !== undefined || spec.encrypted !== undefined) {
    const itemId = `rs_${id}_${index}`;
    const summary = spec.reasoning === undefined
      ? []
      : [{ type: "summary_text", text: spec.reasoning }];
    events.push({
      type: "response.output_item.added",
      output_index: index,
      item: { id: itemId, type: "reasoning", summary: [] },
    });
    if (spec.reasoning !== undefined) {
      events.push({
        type: "response.reasoning_summary_part.added",
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
      events.push({
        type: "response.reasoning_summary_text.delta",
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        delta: spec.reasoning,
      });
      events.push({
        type: "response.reasoning_summary_text.done",
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        text: spec.reasoning,
      });
    }
    const item = {
      id: itemId,
      type: "reasoning",
      summary,
      encrypted_content: spec.encrypted ?? `enc_${id}`,
    };
    events.push({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
    output.push(item);
    index++;
  }
  if (spec.text !== undefined || spec.refusal !== undefined) {
    const itemId = `msg_${id}_${index}`;
    events.push({
      type: "response.output_item.added",
      output_index: index,
      item: {
        id: itemId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
    const content: JsonObject[] = [];
    if (spec.refusal !== undefined) {
      events.push({
        type: "response.refusal.delta",
        item_id: itemId,
        output_index: index,
        content_index: 0,
        delta: spec.refusal,
      });
      content.push({ type: "refusal", refusal: spec.refusal });
    } else {
      const deltas = typeof spec.text === "string"
        ? [spec.text]
        : [...spec.text!];
      events.push({
        type: "response.content_part.added",
        item_id: itemId,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      for (const delta of deltas) {
        events.push({
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: index,
          content_index: 0,
          delta,
        });
      }
      const text = deltas.join("");
      events.push({
        type: "response.output_text.done",
        item_id: itemId,
        output_index: index,
        content_index: 0,
        text,
      });
      content.push({ type: "output_text", text, annotations: [] });
    }
    const item: JsonObject = {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content,
      ...(spec.phase === undefined ? {} : { phase: spec.phase }),
    };
    events.push({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
    output.push(item);
    index++;
  }
  for (const call of spec.toolCalls ?? []) {
    const callId = call.callId ?? `call_${id}_${index}`;
    if ("input" in call) {
      const itemId = `ctc_${id}_${index}`;
      events.push({
        type: "response.output_item.added",
        output_index: index,
        item: {
          id: itemId,
          type: "custom_tool_call",
          status: "in_progress",
          call_id: callId,
          name: call.name,
          input: "",
        },
      });
      events.push({
        type: "response.custom_tool_call_input.delta",
        item_id: itemId,
        output_index: index,
        delta: call.input,
      });
      events.push({
        type: "response.custom_tool_call_input.done",
        item_id: itemId,
        output_index: index,
        input: call.input,
      });
      const item = {
        id: itemId,
        type: "custom_tool_call",
        status: "completed",
        call_id: callId,
        name: call.name,
        input: call.input,
      };
      events.push({
        type: "response.output_item.done",
        output_index: index,
        item,
      });
      output.push(item);
    } else {
      const itemId = `fc_${id}_${index}`;
      const args = typeof call.arguments === "string"
        ? call.arguments
        : JSON.stringify(call.arguments);
      events.push({
        type: "response.output_item.added",
        output_index: index,
        item: {
          id: itemId,
          type: "function_call",
          status: "in_progress",
          call_id: callId,
          name: call.name,
          arguments: "",
        },
      });
      const half = Math.floor(args.length / 2);
      for (const delta of [args.slice(0, half), args.slice(half)]) {
        if (delta !== "") {
          events.push({
            type: "response.function_call_arguments.delta",
            item_id: itemId,
            output_index: index,
            delta,
          });
        }
      }
      events.push({
        type: "response.function_call_arguments.done",
        item_id: itemId,
        output_index: index,
        arguments: args,
      });
      const item = {
        id: itemId,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: call.name,
        arguments: args,
      };
      events.push({
        type: "response.output_item.done",
        output_index: index,
        item,
      });
      output.push(item);
    }
    index++;
  }
  const usage = {
    input_tokens: spec.usage?.input ?? 100,
    input_tokens_details: { cached_tokens: spec.usage?.cached ?? 0 },
    output_tokens: spec.usage?.output ?? 20,
    output_tokens_details: { reasoning_tokens: spec.usage?.reasoning ?? 0 },
    total_tokens: (spec.usage?.input ?? 100) + (spec.usage?.output ?? 20),
  };
  const status = spec.status ?? "completed";
  if (status === "failed") {
    events.push({
      type: "response.failed",
      response: {
        ...base,
        status: "failed",
        error: spec.error ?? { code: "server_error", message: "boom" },
        output,
      },
    });
  } else if (status === "incomplete") {
    events.push({
      type: "response.incomplete",
      response: {
        ...base,
        status: "incomplete",
        incomplete_details: {
          reason: spec.incompleteReason ?? "max_output_tokens",
        },
        output,
        usage,
      },
    });
  } else {
    events.push({
      type: "response.completed",
      response: {
        ...base,
        status: "completed",
        output: spec.completedOutput === false ? [] : output,
        usage,
        ...(spec.endTurn === undefined ? {} : { end_turn: spec.endTurn }),
      },
    });
  }
  events.forEach((event, sequence) => event.sequence_number = sequence);
  return spec.cutAfter === undefined ? events : events.slice(0, spec.cutAfter);
}

/** The SSE text for events: `event:` and `data:` lines, blank-line separated. */
export function sseText(events: readonly (JsonObject | string)[]): string {
  return events.map((event) =>
    typeof event === "string"
      ? event
      : `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  ).join("");
}

/**
 * A streaming SSE response. `chunkSize` splits the bytes into chunks of
 * that size (to test reassembly); otherwise each event is one chunk.
 */
export function sseResponse(
  events: readonly (JsonObject | string)[],
  init: {
    readonly status?: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly chunkSize?: number;
    readonly delayMs?: number;
  } = {},
): Response {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  if (init.chunkSize !== undefined) {
    const bytes = encoder.encode(sseText(events));
    for (let offset = 0; offset < bytes.length; offset += init.chunkSize) {
      chunks.push(bytes.slice(offset, offset + init.chunkSize));
    }
  } else {
    for (const event of events) chunks.push(encoder.encode(sseText([event])));
  }
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (init.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, init.delayMs));
      }
      if (next < chunks.length) controller.enqueue(chunks[next++]);
      else controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/event-stream", ...init.headers },
  });
}

/** A JSON response. */
export function jsonResponse(
  body: unknown,
  init: {
    readonly status?: number;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** One request a fake received. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** The parsed JSON body, or undefined. */
  // deno-lint-ignore no-explicit-any
  readonly body: any;
  readonly signal: AbortSignal | null;
}

/** A `fetch` that answers from a handler and records every request. */
export type FakeFetch = FetchLike & { readonly calls: RecordedRequest[] };

/** A recording `fetch`; throwing from `handler` fakes a connection failure. */
export function fakeFetch(
  handler: (
    request: RecordedRequest,
    index: number,
  ) => Response | Promise<Response>,
): FakeFetch {
  const calls: RecordedRequest[] = [];
  const fake = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    // The clients pass a URL string and an init; a Request's own body is
    // not read, only its URL, method and headers.
    const from = input instanceof Request ? input : undefined;
    const text = typeof init.body === "string" ? init.body : undefined;
    const request: RecordedRequest = {
      url: from?.url ?? String(input),
      method: init.method ?? from?.method ?? "GET",
      headers: new Headers(init.headers ?? from?.headers),
      body: text === undefined ? undefined : JSON.parse(text),
      signal: init.signal ?? null,
    };
    calls.push(request);
    return await handler(request, calls.length - 1);
  };
  return Object.assign(fake, { calls });
}

/** One step of a {@link FakeResponses} script. */
export type ScriptStep =
  | TurnSpec
  | Response
  | Error
  | ((
    request: RecordedRequest,
  ) => TurnSpec | Response | Promise<TurnSpec | Response>);

/**
 * A scripted Responses server: each `POST .../responses` takes the next
 * step (a spec, a ready `Response`, an `Error` to throw as a connection
 * failure, or a function of the request). `GET .../models` lists `models`.
 * Running out of script answers 500 with an explanatory body.
 */
export class FakeResponses {
  readonly fetch: FakeFetch;
  readonly #script: ScriptStep[];
  /** Model ids served by `GET /models`. */
  models: string[] = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.5"];

  constructor(script: readonly ScriptStep[] = []) {
    this.#script = [...script];
    this.fetch = fakeFetch(async (request) => {
      if (request.method === "GET" && request.url.endsWith("/models")) {
        return jsonResponse({
          object: "list",
          data: this.models.map((id) => ({ id, object: "model" })),
        });
      }
      if (request.method !== "POST" || !request.url.endsWith("/responses")) {
        return jsonResponse({
          error: { message: `no route for ${request.method} ${request.url}` },
        }, { status: 404 });
      }
      const step = this.#script.shift();
      if (step === undefined) {
        return jsonResponse({
          error: { message: "the fake's script is exhausted" },
        }, { status: 500 });
      }
      if (step instanceof Error) throw step;
      const resolved = typeof step === "function" ? await step(request) : step;
      if (resolved instanceof Response) return resolved;
      return sseResponse(turnEvents(resolved, request.body?.model), {
        headers: resolved.headers,
        chunkSize: resolved.chunkSize,
        delayMs: resolved.delayMs,
      });
    });
  }

  /** Appends steps. */
  push(...steps: ScriptStep[]): this {
    this.#script.push(...steps);
    return this;
  }

  /** Steps not yet used. */
  get remaining(): number {
    return this.#script.length;
  }

  /** Every `POST /responses` received. */
  get requests(): RecordedRequest[] {
    return this.fetch.calls.filter((call) => call.method === "POST");
  }
}

/**
 * A {@link ShellRunner} that answers from a function, recording every
 * command it was asked to run.
 */
export function scriptedShell(
  answer: (
    command: string | readonly string[],
    workdir: string | null,
  ) => ShellResult | Promise<ShellResult>,
): ShellRunner & { readonly commands: (string | readonly string[])[] } {
  const commands: (string | readonly string[])[] = [];
  return {
    commands,
    async run(command) {
      commands.push(command.command);
      return await answer(command.command, command.workdir);
    },
  };
}
