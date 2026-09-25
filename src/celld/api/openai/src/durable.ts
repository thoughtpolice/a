// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/durable`: the Durable Objects.
 *
 * - `GptPacer`: one per ChatGPT subscription, the admission point for every
 *   Worker that shares it (see `PacerState` for the rules). Leases are
 *   memory-only soft state: an evicted object forgets calls in flight,
 *   which at worst admits one extra batch. A block (usage limit,
 *   `retry-after`, an exhausted window), the configuration and the usage
 *   totals are stored in the object's SQLite, and a new or longer block
 *   waits for `storage.sync()` before the caller hears back, so a usage
 *   limit keeps holding everyone across restarts until it resets.
 * - `GptConversations`: stored conversations, one row per item so a long
 *   conversation never hits the per-row size limit, written in one
 *   synchronous transaction and made durable with `storage.sync()`.
 *
 * ```ts
 * export { GptConversations, GptPacer } from "@celld/api/openai/durable";
 * ```
 *
 * ```python
 * celld.project(..., bindings = {"GPT_PACER": "GptPacer", "GPT_CONVERSATIONS": "GptConversations"})
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { ulid } from "@celld/ulid";
import {
  Conversation,
  type ConversationData,
  type ConversationsApi,
} from "./conversation.ts";
import { GptInvalidRequestError } from "./errors.ts";
import { addUsage, normalizeItem } from "./items.ts";
import type { Issue } from "./json.ts";
import {
  type PacerApi,
  type PacerBlock,
  type PacerConfig,
  type PacerDecision,
  type PacerReport,
  type PacerSnapshot,
  PacerState,
  type PacerTotals,
  resolvePacerConfig,
} from "./pacer.ts";
import type { Item, Usage } from "./types.ts";

export type { ConversationsApi, PacerApi };

function parse<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The fleet-wide pacer for one subscription. */
export class GptPacer extends DurableObject implements PacerApi {
  #state: PacerState;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS gpt_pacer (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL, block TEXT, totals TEXT NOT NULL, rate_limits TEXT NOT NULL)",
    ).toArray();
    const rows = sql.exec<{
      config: string;
      block: string | null;
      totals: string;
      rate_limits: string;
    }>("SELECT config, block, totals, rate_limits FROM gpt_pacer WHERE id = 1")
      .toArray();
    let config: PacerConfig = resolvePacerConfig();
    try {
      if (rows.length === 1) {
        config = resolvePacerConfig(JSON.parse(rows[0].config));
      }
    } catch {
      // An unreadable config falls back to the defaults.
    }
    this.#state = new PacerState(config, {
      block: parse(rows[0]?.block, null),
      totals: parse<PacerTotals | undefined>(rows[0]?.totals, undefined),
      rateLimits: parse(rows[0]?.rate_limits, []),
    });
  }

  #persist(): void {
    const snapshot = this.#state.snapshot(Date.now());
    this.ctx.storage.sql.exec(
      "INSERT INTO gpt_pacer (id, config, block, totals, rate_limits) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET config = excluded.config, block = excluded.block, totals = excluded.totals, rate_limits = excluded.rate_limits",
      JSON.stringify(snapshot.config),
      snapshot.block === null ? null : JSON.stringify(snapshot.block),
      JSON.stringify(snapshot.totals),
      JSON.stringify(snapshot.rateLimits),
    ).toArray();
  }

  acquire(request: { readonly leaseMs: number }): PacerDecision {
    return this.#state.acquire(
      Date.now(),
      request.leaseMs,
      ulid(),
    );
  }

  async release(report: PacerReport): Promise<void> {
    const before = this.#state.snapshot(Date.now()).block;
    this.#state.release(Date.now(), report);
    this.#persist();
    const after = this.#state.snapshot(Date.now()).block;
    if (after !== null && after.until !== before?.until) {
      await this.ctx.storage.sync();
    }
  }

  async block(block: PacerBlock): Promise<boolean> {
    const changed = this.#state.block(Date.now(), block);
    if (changed) {
      this.#persist();
      await this.ctx.storage.sync();
    }
    return changed;
  }

  async unblock(): Promise<void> {
    this.#state.unblock();
    this.#persist();
    await this.ctx.storage.sync();
  }

  async configure(config: Partial<PacerConfig>): Promise<PacerConfig> {
    const next = this.#state.configure(config);
    this.#persist();
    await this.ctx.storage.sync();
    return next;
  }

  snapshot(): PacerSnapshot {
    return this.#state.snapshot(Date.now());
  }
}

interface HeaderRow extends Record<string, SqlStorageValue> {
  id: string;
  instructions: string | null;
  model: string | null;
  usage: string;
  turns: number;
  item_count: number;
}

/** Stored conversations, keyed by id. */
export class GptConversations extends DurableObject
  implements ConversationsApi {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS gpt_conversations (id TEXT PRIMARY KEY, instructions TEXT, model TEXT, usage TEXT NOT NULL, turns INTEGER NOT NULL, item_count INTEGER NOT NULL, updated INTEGER NOT NULL)",
    ).toArray();
    sql.exec(
      "CREATE TABLE IF NOT EXISTS gpt_conversation_items (conversation TEXT NOT NULL, seq INTEGER NOT NULL, item TEXT NOT NULL, PRIMARY KEY (conversation, seq))",
    ).toArray();
  }

  #header(id: string): HeaderRow | null {
    const rows = this.ctx.storage.sql.exec<HeaderRow>(
      "SELECT id, instructions, model, usage, turns, item_count FROM gpt_conversations WHERE id = ?",
      id,
    ).toArray();
    return rows[0] ?? null;
  }

  load(id: string): ConversationData | null {
    const header = this.#header(id);
    if (header === null) return null;
    const items = this.ctx.storage.sql.exec<{ item: string }>(
      "SELECT item FROM gpt_conversation_items WHERE conversation = ? ORDER BY seq",
      id,
    ).toArray().map((row) => JSON.parse(row.item) as Item);
    return {
      version: 1,
      id,
      instructions: header.instructions,
      model: header.model,
      items,
      usage: JSON.parse(header.usage) as Usage,
      turns: header.turns,
    };
  }

  async save(data: ConversationData): Promise<void> {
    const checked = Conversation.fromJSON(data).toJSON();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        "DELETE FROM gpt_conversation_items WHERE conversation = ?",
        checked.id,
      ).toArray();
      checked.items.forEach((item, seq) => {
        sql.exec(
          "INSERT INTO gpt_conversation_items (conversation, seq, item) VALUES (?, ?, ?)",
          checked.id,
          seq,
          JSON.stringify(item),
        ).toArray();
      });
      sql.exec(
        "INSERT INTO gpt_conversations (id, instructions, model, usage, turns, item_count, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET instructions = excluded.instructions, model = excluded.model, usage = excluded.usage, turns = excluded.turns, item_count = excluded.item_count, updated = excluded.updated",
        checked.id,
        checked.instructions,
        checked.model,
        JSON.stringify(checked.usage),
        checked.turns,
        checked.items.length,
        Date.now(),
      ).toArray();
    });
    await this.ctx.storage.sync();
  }

  async append(
    id: string,
    items: readonly Item[],
    usage: Usage,
    turns: number,
  ): Promise<boolean> {
    const issues: Issue[] = [];
    const normalized = items.flatMap((raw, index) => {
      const item = normalizeItem(raw, ["items", index], issues);
      return item === null ? [] : [item];
    });
    if (normalized.length !== items.length && issues.length === 0) {
      issues.push({
        path: ["items"],
        message: "an item kind that is not replayed",
      });
    }
    if (issues.length > 0) throw new GptInvalidRequestError(issues);
    const sql = this.ctx.storage.sql;
    const appended = this.ctx.storage.transactionSync(() => {
      const header = this.#header(id);
      if (header === null) return false;
      normalized.forEach((item, offset) => {
        sql.exec(
          "INSERT INTO gpt_conversation_items (conversation, seq, item) VALUES (?, ?, ?)",
          id,
          header.item_count + offset,
          JSON.stringify(item),
        ).toArray();
      });
      sql.exec(
        "UPDATE gpt_conversations SET usage = ?, turns = ?, item_count = ?, updated = ? WHERE id = ?",
        JSON.stringify(addUsage(JSON.parse(header.usage) as Usage, usage)),
        header.turns + turns,
        header.item_count + normalized.length,
        Date.now(),
        id,
      ).toArray();
      return true;
    });
    if (appended) await this.ctx.storage.sync();
    return appended;
  }

  async remove(id: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM gpt_conversation_items WHERE conversation = ?", id)
        .toArray();
      sql.exec("DELETE FROM gpt_conversations WHERE id = ?", id).toArray();
    });
    await this.ctx.storage.sync();
  }

  list(): string[] {
    return this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM gpt_conversations ORDER BY updated DESC, id",
    ).toArray().map((row) => row.id);
  }
}
