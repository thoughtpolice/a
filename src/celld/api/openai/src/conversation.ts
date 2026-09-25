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

import { safeInt } from "@celld/core/bounds";
import { ulid } from "@celld/core/ulid";
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

const USAGE_COUNTS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}

/**
 * The issues of a usage record and a turn count as stored: each token
 * count and `turns` a non-negative safe integer (NaN, a fraction or a
 * negative number would poison every later sum).
 */
export function usageIssues(usage: unknown, turns: unknown): Issue[] {
  const issues: Issue[] = [];
  const record = isPlainObject(usage) ? usage : null;
  if (record === null || USAGE_COUNTS.some((key) => !isCount(record[key]))) {
    issues.push({
      path: ["usage"],
      message: "usage must have the five token counts, each a whole number",
    });
  }
  if (!isCount(turns)) {
    issues.push({
      path: ["turns"],
      message: "turns must be a non-negative integer",
    });
  }
  return issues;
}

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
    issues.push(...usageIssues(data.usage, data.turns));
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

/** The most items one stored conversation may hold. */
export const MAX_CONVERSATION_ITEMS = 20_000;

/**
 * What a {@link ConversationStore.save} may replace. Stored conversations
 * only grow (every turn appends), and a conditional save checks that:
 *
 * - `{expectedItems: n}`: the stored conversation must have `n` items
 *   (the count you loaded) and they must be the first `n` items saved, so
 *   a save only ever extends what is stored; `{expectedItems: null}`:
 *   none may be stored. Otherwise the save is refused with
 *   {@link ConversationConflictError} and nothing changes: another writer
 *   saved first (or the conversation was removed and made again), so load
 *   again and redo the turn.
 * - `{overwrite: true}`: replace whatever is stored. Only for a
 *   conversation with one writer; two writers lose each other's turns.
 *
 * `maxConversations` (a positive integer) caps the store: a save that
 * would add a conversation to a store already holding that many is
 * refused with {@link ConversationLimitError}, checked with the write
 * (in the Durable Object, in the same transaction), so concurrent creates
 * cannot pass it together. Saves of stored conversations are not limited.
 */
export type SaveOptions =
  & (
    | { readonly expectedItems: number | null; readonly overwrite?: undefined }
    | { readonly overwrite: true; readonly expectedItems?: undefined }
  )
  & { readonly maxConversations?: number };

/** What a store checks with a save besides the version; see {@link SaveOptions}. */
export interface SaveLimits {
  readonly maxConversations?: number;
}

/** A conditional save found another version stored; see {@link SaveOptions}. */
export class ConversationConflictError extends Error {
  override readonly name = "ConversationConflictError";

  constructor(
    readonly id: string,
    /** The item count the save expected; null for none stored. */
    readonly expected: number | null,
    /** The item count stored; null for none. */
    readonly actual: number | null,
  ) {
    super(
      actual !== null && actual === expected
        ? `conversation ${id} has other items stored than the ones this save extends: another writer saved it first`
        : `conversation ${id} has ${
          actual === null ? "no stored version" : `${actual} items stored`
        }, not ${
          expected === null ? "none" : expected
        }: another writer saved it first`,
    );
  }
}

/** A save would add a conversation past `maxConversations`. */
export class ConversationLimitError extends Error {
  override readonly name = "ConversationLimitError";

  constructor(readonly id: string, readonly limit: number) {
    super(
      `conversation ${id} is new and the store already holds ${limit} (maxConversations)`,
    );
  }
}

/**
 * The limits of save options, checked.
 *
 * @throws {RangeError} a `maxConversations` that is not a positive integer.
 */
export function saveLimits(options: SaveOptions): SaveLimits {
  const max = (options as SaveLimits | null)?.maxConversations;
  return max === undefined ? {} : {
    maxConversations: safeInt(max, { name: "maxConversations", min: 1 }),
  };
}

/**
 * Whether `items` begin with `stored`, item by item as JSON: what a
 * conditional save requires of the stored conversation.
 */
export function extendsStored(
  stored: readonly unknown[],
  items: readonly unknown[],
): boolean {
  if (items.length < stored.length) return false;
  return stored.every((item, index) =>
    JSON.stringify(item) === JSON.stringify(items[index])
  );
}

/**
 * An {@link GptInvalidRequestError} for a conversation of more than
 * {@link MAX_CONVERSATION_ITEMS} items.
 */
export function checkItemCount(id: string, count: number): void {
  if (count > MAX_CONVERSATION_ITEMS) {
    throw new GptInvalidRequestError([{
      path: ["items"],
      message:
        `conversation ${id} would hold ${count} items; at most ${MAX_CONVERSATION_ITEMS} are stored`,
    }]);
  }
}

/**
 * Checks save options: `"overwrite"`, or the expected item count (null
 * for none stored).
 *
 * @throws {TypeError} for anything else.
 */
export function saveExpectation(
  options: SaveOptions,
): number | null | "overwrite" {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(
      "save needs {expectedItems} or {overwrite: true}: say what it replaces",
    );
  }
  if (options.overwrite === true && options.expectedItems === undefined) {
    return "overwrite";
  }
  const expected = options.expectedItems;
  if (
    options.overwrite === undefined &&
    (expected === null ||
      (Number.isSafeInteger(expected) && (expected as number) >= 0))
  ) {
    return expected as number | null;
  }
  throw new TypeError(
    "save needs {expectedItems: a count or null} or {overwrite: true}, not both",
  );
}

/** Somewhere to keep conversations. */
export interface ConversationStore {
  load(id: string): Promise<ConversationData | null>;
  /**
   * Stores `data` when what is stored is what `options` expects.
   *
   * @throws {ConversationConflictError} when another version is stored.
   */
  save(data: ConversationData, options: SaveOptions): Promise<void>;
  delete(id: string): Promise<void>;
}

/** The default {@link memoryConversationStore} `maxEntries`. */
export const DEFAULT_MEMORY_CONVERSATIONS = 10_000;

/**
 * A store in this isolate's memory. Entries are cloned both ways. It holds
 * at most `maxEntries` conversations (default
 * {@link DEFAULT_MEMORY_CONVERSATIONS}): a save that would add one more is
 * a {@link ConversationLimitError}.
 *
 * @throws {RangeError} a `maxEntries` that is not a positive integer.
 */
export function memoryConversationStore(
  options: { readonly maxEntries?: number } = {},
): ConversationStore & {
  readonly size: number;
} {
  const maxEntries = safeInt(
    options.maxEntries ?? DEFAULT_MEMORY_CONVERSATIONS,
    { name: "maxEntries", min: 1 },
  );
  const entries = new Map<string, string>();
  return {
    get size() {
      return entries.size;
    },
    load: (id) => {
      const stored = entries.get(id);
      return Promise.resolve(stored === undefined ? null : JSON.parse(stored));
    },
    save: (data, options) => {
      try {
        const expected = saveExpectation(options);
        const limit = saveLimits(options).maxConversations;
        checkItemCount(data.id, data.items.length);
        const stored = entries.get(data.id);
        const items = stored === undefined
          ? null
          : (JSON.parse(stored) as ConversationData).items;
        if (
          expected !== "overwrite" &&
          (items?.length ?? null) !== expected
        ) {
          throw new ConversationConflictError(
            data.id,
            expected,
            items?.length ?? null,
          );
        }
        if (
          expected !== "overwrite" && items !== null &&
          !extendsStored(items, data.items)
        ) {
          throw new ConversationConflictError(data.id, expected, items.length);
        }
        if (items === null) {
          if (limit !== undefined && entries.size >= limit) {
            throw new ConversationLimitError(data.id, limit);
          }
          if (entries.size >= maxEntries) {
            throw new ConversationLimitError(data.id, maxEntries);
          }
        }
        entries.set(data.id, JSON.stringify(data));
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
    delete: (id) => {
      entries.delete(id);
      return Promise.resolve();
    },
  };
}

/** The default `ConversationsApi.list` limit. */
export const DEFAULT_LIST_LIMIT = 1_000;
/** The largest `ConversationsApi.list` limit. */
export const MAX_LIST_LIMIT = 10_000;

/** How long {@link kvConversationStore} keeps a conversation: 30 days. */
export const DEFAULT_CONVERSATION_TTL_SECONDS = 30 * 86_400;

/**
 * A store in Workers KV, one key per conversation (`prefix` + id). KV is
 * eventually consistent across locations, has no compare-and-set and caps
 * values at 25 MiB, so it takes only `{overwrite: true}` saves (one writer
 * per conversation): a conditional save throws a `TypeError`. Use the
 * `GptConversations` Durable Object when one conversation is written from
 * several places or grows large.
 *
 * Each save keeps the conversation for `ttlSeconds` from then (default
 * {@link DEFAULT_CONVERSATION_TTL_SECONDS}, 30 days; at least 60, KV's
 * minimum, and at most a year). `ttlSeconds: null` keeps conversations
 * until they are deleted. Throws a `RangeError` for any other value.
 */
export function kvConversationStore(
  kv: KVNamespace,
  options: {
    readonly prefix?: string;
    readonly ttlSeconds?: number | null;
  } = {},
): ConversationStore {
  const prefix = options.prefix ?? "gpt/conversation/";
  const ttlSeconds = options.ttlSeconds === null ? null : safeInt(
    options.ttlSeconds ?? DEFAULT_CONVERSATION_TTL_SECONDS,
    { name: "ttlSeconds", min: 60, max: 365 * 86_400 },
  );
  return {
    async load(id) {
      const text = await kv.get(prefix + id);
      if (text === null) return null;
      return Conversation.fromJSON(JSON.parse(text)).toJSON();
    },
    async save(data, saving) {
      if (saveLimits(saving).maxConversations !== undefined) {
        throw new TypeError(
          "Workers KV cannot count and write in one step, so it cannot enforce maxConversations; use durableConversationStore",
        );
      }
      if (saveExpectation(saving) !== "overwrite") {
        throw new TypeError(
          "Workers KV cannot compare and set, so it cannot make a conditional save; use durableConversationStore, or {overwrite: true} for a conversation with one writer",
        );
      }
      await kv.put(
        prefix + data.id,
        JSON.stringify(data),
        ttlSeconds === null ? undefined : { expirationTtl: ttlSeconds },
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
  /**
   * Stores `data` when the stored conversation has `expected` items and
   * they begin `data.items` (null: none stored; "overwrite": whatever is
   * stored), checked and written in one transaction. Answers the stored
   * item count when it differed (or the items did), and `limit` when
   * `limits.maxConversations` refused a new conversation.
   */
  save(
    data: ConversationData,
    expected: number | null | "overwrite",
    limits?: SaveLimits,
  ): Promise<
    { readonly saved: true } | {
      readonly saved: false;
      readonly actual: number | null;
      readonly limit?: number;
    }
  >;
  /** Appends items and usage to a stored conversation; false if absent. */
  append(
    id: string,
    items: readonly Item[],
    usage: Usage,
    turns: number,
  ): Promise<boolean>;
  /** Removes a stored conversation. (`delete` is not usable over RPC stubs.) */
  remove(id: string): Promise<void>;
  /**
   * Stored ids, most recently saved first: at most `limit` (default
   * {@link DEFAULT_LIST_LIMIT}, at most {@link MAX_LIST_LIMIT}).
   */
  list(limit?: number): string[];
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
    save: async (data, options) => {
      const expected = saveExpectation(options);
      const limits = saveLimits(options);
      const answer = await stub().save(data, expected, limits);
      if (!answer.saved && answer.limit !== undefined) {
        throw new ConversationLimitError(data.id, answer.limit);
      }
      if (!answer.saved) {
        throw new ConversationConflictError(
          data.id,
          expected as number | null,
          answer.actual,
        );
      }
    },
    delete: async (id) => await stub().remove(id),
  };
}
