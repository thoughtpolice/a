// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { DurableObject } from "cloudflare:workers";
import {
  ChannelNameSchema,
  MAX_CHANNELS,
  MessageBodySchema,
} from "@celld/web/switchboard/contracts";
import type { Channel } from "@celld/web/switchboard/contracts";
import { RoomRefusal } from "@celld/web/realtime";
import type { Draft, RoomOptions } from "@celld/web/realtime";
import { RealtimeRoom } from "@celld/web/realtime/durable";
import type { Env } from "./server.ts";

/** Every transport passes through the same validation before numbering. */
export class ChatRoom extends RealtimeRoom<Env> {
  protected override roomOptions(): RoomOptions {
    return { history: 200 };
  }

  protected override validate(draft: Draft): void {
    const data = draft.data;
    if (
      draft.channel !== "chat" || typeof data !== "object" || data === null ||
      Array.isArray(data) || Object.keys(data).length !== 1 || !("text" in data)
    ) {
      throw new RoomRefusal("A chat message must contain only text.");
    }
    const parsed = MessageBodySchema.safeParse(data);
    if (!parsed.success) {
      throw new RoomRefusal("Use 1 to 2000 nonblank characters.");
    }
    // The core stores this same JSON object after the validation hook returns.
    Object.assign(data, { text: parsed.data.text });
  }
}

const initialChannels: readonly Channel[] = [
  {
    name: "lobby",
    topic: "Arrivals, introductions, and everyday conversation.",
  },
  {
    name: "development",
    topic: "Building things: code, questions, and work in progress.",
  },
  { name: "off-topic", topic: "Everything beyond the keyboard." },
];

export type CreateChannelResult = "created" | "exists" | "full";

/** The singleton catalog owns channel names and durable topics. */
export class ChannelDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS channels (name TEXT PRIMARY KEY, topic TEXT NOT NULL)",
      ).toArray();
      for (const channel of initialChannels) {
        ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO channels (name, topic) VALUES (?, ?)",
          channel.name,
          channel.topic,
        ).toArray();
      }
    });
  }

  list(): Channel[] {
    return this.ctx.storage.sql.exec<{ name: string; topic: string }>(
      "SELECT name, topic FROM channels ORDER BY CASE WHEN name = 'lobby' THEN 0 ELSE 1 END, name",
    ).toArray();
  }

  lookup(name: string): Channel | null {
    const channel = this.ctx.storage.sql.exec<{ name: string; topic: string }>(
      "SELECT name, topic FROM channels WHERE name = ?",
      ChannelNameSchema.parse(name),
    ).toArray()[0];
    return channel ?? null;
  }

  /** A duplicate never replaces the existing topic. */
  create(name: string, topic: string): CreateChannelResult {
    name = ChannelNameSchema.parse(name);
    if (typeof topic !== "string" || topic.length > 160) {
      throw new TypeError("Invalid channel topic");
    }
    return this.ctx.storage.transactionSync(() => {
      if (this.lookup(name) !== null) return "exists";
      const count = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM channels",
      ).toArray()[0].count;
      if (count >= MAX_CHANNELS) return "full";
      this.ctx.storage.sql.exec(
        "INSERT INTO channels (name, topic) VALUES (?, ?)",
        name,
        topic.trim(),
      ).toArray();
      return "created";
    });
  }
}
