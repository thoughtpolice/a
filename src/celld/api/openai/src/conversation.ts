// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A stateless conversation: the items of every turn so far, replayed in full
 * on the next request, because with `store: false` the backend remembers
 * nothing between calls.
 *
 * ```ts
 * const thread = new Conversation({ instructions: "You review Rust code." });
 * thread.user("Is this function sound? ...");
 * const turn = await gpt.respond(thread.request());
 * thread.record(turn);
 * await store.save(thread.toJSON()); // plain JSON; resume with fromJSON
 * ```
 *
 * Replay is exact: reasoning items go back with their `encrypted_content`
 * (the only way the model sees its earlier reasoning when nothing is
 * stored), tool calls go back with their outputs, and items keep the ids the
 * server gave them, as Codex does. The conversation's id is also its
 * `prompt_cache_key`, so every turn of one conversation lands on the same
 * cache and a long replayed prefix costs cached-input rates.
 *
 * @module
 */

import { ulid } from "@celld/ulid";
import { GptDecodeError, GptInvalidRequestError } from "./errors.ts";
import {
  addUsage,
  assistantText,
  developer,
  normalizeItem,
  pendingCalls,
  user,
  ZERO_USAGE,
} from "./items.ts";
import { describeValue, isPlainObject, type Issue } from "./json.ts";
import type { GptRequest } from "./request.ts";
import type { ContentPart, Item, ToolCall, Turn, Usage } from "./types.ts";

/** The stored form of a conversation. Plain JSON. */
export interface ConversationData {
  readonly version: 1;
  /** The id, also used as the prompt cache key. */
  readonly id: string;
  readonly instructions: string | null;
  readonly model: string | null;
  readonly items: readonly Item[];
  /** Usage summed over every recorded turn. */
  readonly usage: Usage;
  /** Turns recorded. */
  readonly turns: number;
}

/** How to start a conversation. */
export interface ConversationOptions {
  /** Default: a new ULID. Must be stable to keep the cache warm. */
  readonly id?: string;
  /** Default: the client's instructions. */
  readonly instructions?: string;
  /** Default: the client's model. */
  readonly model?: string;
  readonly items?: readonly Item[];
}

/** A conversation replayed in full on every turn. */
export class Conversation {
  readonly id: string;
  instructions: string | null;
  model: string | null;
  #items: Item[] = [];
  #usage: Usage = ZERO_USAGE;
  #turns = 0;

  constructor(options: ConversationOptions = {}) {
    if (options.id !== undefined && options.id.trim() === "") {
      throw new TypeError("a conversation id must not be blank");
    }
    this.id = options.id ?? ulid();
    this.instructions = options.instructions ?? null;
    this.model = options.model ?? null;
    if (options.items !== undefined) this.push(...options.items);
  }

  /** Every item so far. */
  get items(): readonly Item[] {
    return this.#items;
  }

  /** Usage summed over the recorded turns. */
  get usage(): Usage {
    return this.#usage;
  }

  /** Turns recorded. */
  get turns(): number {
    return this.#turns;
  }

  /** The last assistant text, or "". */
  get lastText(): string {
    for (let index = this.#items.length - 1; index >= 0; index--) {
      const text = assistantText([this.#items[index]]);
      if (text !== "") return text;
    }
    return "";
  }

  /** Appends a user message. */
  user(...parts: (string | ContentPart)[]): this {
    return this.push(user(...parts));
  }

  /** Appends a developer message (mid-conversation guidance). */
  developer(...parts: string[]): this {
    return this.push(developer(...parts));
  }

  /**
   * Appends items, checking each.
   *
   * @throws {GptInvalidRequestError} an item that is malformed or of a kind
   * this library does not replay.
   */
  push(...items: readonly Item[]): this {
    const issues: Issue[] = [];
    const normalized: Item[] = [];
    items.forEach((raw, index) => {
      const before = issues.length;
      const item = normalizeItem(
        raw,
        ["items", this.#items.length + index],
        issues,
      );
      if (item !== null) normalized.push(item);
      else if (issues.length === before) {
        issues.push({
          path: ["items", this.#items.length + index],
          message: `items of type ${
            describeValue((raw as { type?: unknown }).type)
          } are not replayed`,
        });
      }
    });
    if (issues.length > 0) throw new GptInvalidRequestError(issues);
    this.#items.push(...normalized);
    return this;
  }

  /** Appends a turn's output and adds its usage. */
  record(turn: Turn): this {
    this.#items.push(...turn.output);
    this.#usage = addUsage(this.#usage, turn.usage);
    this.#turns++;
    return this;
  }

  /** Tool calls that have no output yet. */
  pendingCalls(): ToolCall[] {
    return pendingCalls(this.#items);
  }

  /**
   * The items to send. Reasoning without `encrypted_content` is left out:
   * with nothing stored, the server could not resolve it.
   */
  replay(): Item[] {
    return this.#items.filter((item) =>
      item.type !== "reasoning" || item.encrypted_content !== null
    );
  }

  /**
   * The next request: the replayed items, the conversation's instructions
   * and model when set, and its id as the prompt cache key. `extra` adds
   * tools, reasoning, format and the rest.
   */
  request(extra: Omit<GptRequest, "input"> = {}): GptRequest {
    return {
      ...(this.instructions === null
        ? {}
        : { instructions: this.instructions }),
      ...(this.model === null ? {} : { model: this.model }),
      promptCacheKey: this.id,
      ...extra,
      input: this.replay(),
    };
  }

  /** A copy, sharing nothing mutable. */
  fork(id?: string): Conversation {
    const data = this.toJSON();
    return Conversation.fromJSON({ ...data, id: id ?? ulid() });
  }

  /** The stored form. */
  toJSON(): ConversationData {
    return {
      version: 1,
      id: this.id,
      instructions: this.instructions,
      model: this.model,
      items: structuredClone(this.#items),
      usage: this.#usage,
      turns: this.#turns,
    };
  }

  /**
   * A conversation from its stored form.
   *
   * @throws {GptDecodeError} data that is not a stored conversation, with
   * every problem's path.
   */
  static fromJSON(data: unknown): Conversation {
    const issues: Issue[] = [];
    if (!isPlainObject(data)) {
      throw new GptDecodeError([{
        path: [],
        message: "a stored conversation must be an object",
      }]);
    }
    if (data.version !== 1) {
      issues.push({ path: ["version"], message: "unsupported version" });
    }
    if (typeof data.id !== "string" || data.id.trim() === "") {
      issues.push({ path: ["id"], message: "id must be a non-blank string" });
    }
    for (const key of ["instructions", "model"] as const) {
      if (data[key] !== null && typeof data[key] !== "string") {
        issues.push({ path: [key], message: "must be a string or null" });
      }
    }
    const items: Item[] = [];
    if (!Array.isArray(data.items)) {
      issues.push({ path: ["items"], message: "items must be a list" });
    } else {
      data.items.forEach((raw, index) => {
        const before = issues.length;
        const item = normalizeItem(raw, ["items", index], issues);
        if (item !== null) items.push(item);
        else if (issues.length === before) {
          issues.push({
            path: ["items", index],
            message: "an item kind that is not replayed",
          });
        }
      });
    }
    const usage = isPlainObject(data.usage) ? data.usage : null;
    const counts = [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens",
    ];
    if (
      usage === null || counts.some((key) => typeof usage[key] !== "number")
    ) {
      issues.push({
        path: ["usage"],
        message: "usage must have the five token counts",
      });
    }
    if (
      typeof data.turns !== "number" || !Number.isInteger(data.turns) ||
      data.turns < 0
    ) {
      issues.push({
        path: ["turns"],
        message: "turns must be a non-negative integer",
      });
    }
    if (issues.length > 0) throw new GptDecodeError(issues);
    const conversation = new Conversation({
      id: data.id as string,
      ...(data.instructions === null
        ? {}
        : { instructions: data.instructions as string }),
      ...(data.model === null ? {} : { model: data.model as string }),
    });
    conversation.#items = items;
    conversation.#usage = usage as unknown as Usage;
    conversation.#turns = data.turns as number;
    return conversation;
  }
}

/** Somewhere to keep conversations. */
export interface ConversationStore {
  load(id: string): Promise<ConversationData | null>;
  save(data: ConversationData): Promise<void>;
  delete(id: string): Promise<void>;
}

/** A store in this isolate's memory. Entries are cloned both ways. */
export function memoryConversationStore(): ConversationStore & {
  readonly size: number;
} {
  const entries = new Map<string, string>();
  return {
    get size() {
      return entries.size;
    },
    load: (id) => {
      const stored = entries.get(id);
      return Promise.resolve(stored === undefined ? null : JSON.parse(stored));
    },
    save: (data) => {
      entries.set(data.id, JSON.stringify(data));
      return Promise.resolve();
    },
    delete: (id) => {
      entries.delete(id);
      return Promise.resolve();
    },
  };
}

/**
 * A store in Workers KV, one key per conversation (`prefix` + id). KV is
 * eventually consistent across locations and caps values at 25 MiB; use
 * the `GptConversations` Durable Object when one conversation is written
 * from several places or grows large.
 */
export function kvConversationStore(
  kv: KVNamespace,
  options: { readonly prefix?: string; readonly ttlSeconds?: number } = {},
): ConversationStore {
  const prefix = options.prefix ?? "gpt/conversation/";
  return {
    async load(id) {
      const text = await kv.get(prefix + id);
      if (text === null) return null;
      return Conversation.fromJSON(JSON.parse(text)).toJSON();
    },
    async save(data) {
      await kv.put(
        prefix + data.id,
        JSON.stringify(data),
        options.ttlSeconds === undefined
          ? undefined
          : { expirationTtl: options.ttlSeconds },
      );
    },
    async delete(id) {
      await kv.delete(prefix + id);
    },
  };
}

/**
 * The RPC surface of the `GptConversations` Durable Object in
 * `@celld/api/openai/durable`: `GPT_CONVERSATIONS:
 * DurableObjectNamespace<ConversationsApi>`.
 */
export interface ConversationsApi {
  load(id: string): ConversationData | null;
  save(data: ConversationData): Promise<void>;
  /** Appends items and usage to a stored conversation; false if absent. */
  append(
    id: string,
    items: readonly Item[],
    usage: Usage,
    turns: number,
  ): Promise<boolean>;
  /** Removes a stored conversation. (`delete` is not usable over RPC stubs.) */
  remove(id: string): Promise<void>;
  list(): string[];
}

/**
 * A store backed by the `GptConversations` object named `name`. Put the
 * conversations of one tenant, agent or case in one object.
 */
export function durableConversationStore(
  namespace: DurableObjectNamespace<ConversationsApi>,
  name = "default",
): ConversationStore {
  const stub = () => namespace.getByName(name);
  return {
    load: async (id) => await stub().load(id),
    save: async (data) => await stub().save(data),
    delete: async (id) => await stub().remove(id),
  };
}
