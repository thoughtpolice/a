// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `RealtimeRoom`, the Durable Object each room is, and the only module
 * here that imports `cloudflare:workers`.
 *
 * Its sockets are hibernatable: an idle room holds its connections without
 * running, and wakes for the next frame. What must outlive a wake (each
 * connection's identity, grants, subscriptions and presence; the kept
 * messages; the sequence counter) is in its SQLite, and each socket's
 * attachment holds only its connection id. Pings are answered by the
 * runtime's auto-response, without waking it.
 *
 * Bind it as is, or extend it to change the limits (`roomOptions`) or to
 * check what is published (`validate`, which throws `RoomRefusal`; the
 * `publish` RPC answers a refusal as `{ ok: false, refusal }`):
 *
 * ```ts
 * export class ChatRoom extends RealtimeRoom {
 *   protected override validate(draft: Draft): void {
 *     if (typeof draft.data !== "string") throw new RoomRefusal("text only");
 *   }
 * }
 * ```
 *
 * ```python
 * celld.project(..., bindings = {"ROOMS": "ChatRoom"})
 * ```
 *
 * Connections come only through `connectRoom` from
 * `@celld/web/realtime/router`, which the Worker calls after authenticating the
 * caller; the object trusts the identity and grants it forwards, which is
 * safe because nothing but the Worker can reach it.
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import {
  checkGrants,
  checkIdentity,
  CONNECT_HEADER,
  type Identity,
  isRoomName,
  type Json,
  type Message,
  PING,
  PONG,
  type PresenceEntry,
  type PublishResult,
  type RoomApi,
} from "./protocol.ts";
import {
  type Connection,
  type Draft,
  RoomCore,
  type RoomHost,
  type RoomOptions,
  RoomRefusal,
} from "./room.ts";

export type { RoomApi };

interface Attachment {
  readonly id: string;
}

/** {@link RoomHost} over hibernatable WebSockets and a Durable Object's SQLite. */
class DurableRoomHost implements RoomHost<WebSocket> {
  readonly #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
    for (
      const statement of [
        "CREATE TABLE IF NOT EXISTS celld_realtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS celld_realtime_connections (id TEXT PRIMARY KEY, record TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS celld_realtime_messages (seq INTEGER PRIMARY KEY, channel TEXT NOT NULL, record TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS celld_realtime_channels (channel TEXT PRIMARY KEY, last INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS celld_realtime_messages_channel ON celld_realtime_messages (channel, seq)",
      ]
    ) ctx.storage.sql.exec(statement).toArray();
  }

  #sql<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    return this.#ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  meta(key: string): string | null {
    const [row] = this.#sql<{ value: string }>(
      "SELECT value FROM celld_realtime_meta WHERE key = ?",
      key,
    );
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#sql(
      "INSERT INTO celld_realtime_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  now(): number {
    return Date.now();
  }

  sockets(): readonly WebSocket[] {
    return this.#ctx.getWebSockets();
  }

  idOf(socket: WebSocket): string | null {
    const attachment = socket.deserializeAttachment<Attachment>();
    return typeof attachment?.id === "string" ? attachment.id : null;
  }

  send(socket: WebSocket, text: string): void {
    socket.send(text);
  }

  close(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  loadConnections(): Connection[] {
    return this.#sql<{ record: string }>(
      "SELECT record FROM celld_realtime_connections",
    ).map((row) => JSON.parse(row.record));
  }

  putConnection(connection: Connection): void {
    this.#sql(
      "INSERT INTO celld_realtime_connections (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record",
      connection.id,
      JSON.stringify(connection),
    );
  }

  deleteConnection(id: string): void {
    this.#sql("DELETE FROM celld_realtime_connections WHERE id = ?", id);
  }

  lastSeq(): number {
    return Number(this.meta("seq") ?? "0");
  }

  channelLast(channel: string): number {
    const [row] = this.#sql<{ last: number }>(
      "SELECT last FROM celld_realtime_channels WHERE channel = ?",
      channel,
    );
    return row?.last ?? 0;
  }

  append(message: Message, keep: number): void {
    this.#ctx.storage.transactionSync(() => {
      this.setMeta("seq", String(message.seq));
      this.#sql(
        "INSERT INTO celld_realtime_channels (channel, last) VALUES (?, ?) ON CONFLICT (channel) DO UPDATE SET last = excluded.last",
        message.channel,
        message.seq,
      );
      if (keep === 0) {
        this.setMeta("trimmed", String(message.seq));
        return;
      }
      this.#sql(
        "INSERT INTO celld_realtime_messages (seq, channel, record) VALUES (?, ?, ?)",
        message.seq,
        message.channel,
        JSON.stringify(message),
      );
      const cut = message.seq - keep;
      if (cut > Number(this.meta("trimmed") ?? "0")) {
        this.#sql("DELETE FROM celld_realtime_messages WHERE seq <= ?", cut);
        this.setMeta("trimmed", String(cut));
      }
    });
  }

  after(channel: string | null, seq: number, limit: number) {
    const trimmed = Number(this.meta("trimmed") ?? "0");
    const rows = channel === null
      ? this.#sql<{ record: string }>(
        "SELECT record FROM celld_realtime_messages WHERE seq > ? ORDER BY seq LIMIT ?",
        seq,
        limit,
      )
      : this.#sql<{ record: string }>(
        "SELECT record FROM celld_realtime_messages WHERE channel = ? AND seq > ? ORDER BY seq LIMIT ?",
        channel,
        seq,
        limit,
      );
    return {
      messages: rows.map((row) => JSON.parse(row.record) as Message),
      complete: seq >= trimmed,
    };
  }
}

/** One realtime room; see the module documentation. */
export class RealtimeRoom<Env = unknown> extends DurableObject<Env>
  implements RoomApi {
  readonly #host: DurableRoomHost;
  #core: RoomCore<WebSocket> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#host = new DurableRoomHost(ctx);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** The room's limits; override to change them. */
  protected roomOptions(): RoomOptions {
    return {};
  }

  /**
   * Checks a message about to be accepted, from a client or the server;
   * throw `RoomRefusal` to refuse it. The default accepts everything within
   * the size limits. It runs synchronously, before the message is numbered.
   */
  protected validate(_draft: Draft): void {}

  #room(name?: string): RoomCore<WebSocket> {
    if (this.#core !== null) return this.#core;
    let room = this.#host.meta("room");
    if (room === null) {
      room = name ?? this.ctx.id.name ?? this.ctx.id.toString();
      this.#host.setMeta("room", room);
    }
    this.#core = new RoomCore(
      this.#host,
      room,
      this.roomOptions(),
      (draft) => this.validate(draft),
    );
    return this.#core;
  }

  /** Accepts a connection forwarded by `connectRoom`; nothing else. */
  fetch(request: Request): Response {
    const header = request.headers.get(CONNECT_HEADER);
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      header === null
    ) {
      return new Response("rooms take connections from connectRoom", {
        status: 400,
      });
    }
    const { room, identity, grants } = JSON.parse(header) as {
      room: string;
      identity: Identity;
      grants: unknown;
    };
    if (!isRoomName(room)) return new Response("bad room", { status: 400 });
    const core = this.#room(room);
    if (!core.hasRoom()) {
      return new Response("the room is full", {
        status: 503,
        headers: { "retry-after": "10" },
      });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id } satisfies Attachment);
    core.accept(server, id, checkIdentity(identity), checkGrants(grants));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    this.#room().message(socket, message);
  }

  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): void {
    this.#room().closed(socket);
    try {
      socket.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  webSocketError(socket: WebSocket): void {
    this.#room().closed(socket);
  }

  publish(input: {
    readonly channel: string;
    readonly data: Json;
    readonly from?: Identity | null;
  }): PublishResult {
    try {
      return {
        ok: true,
        message: this.#room().publish(
          input.channel,
          input.data,
          input.from ?? null,
        ),
      };
    } catch (error) {
      if (!(error instanceof RoomRefusal)) throw error;
      return { ok: false, refusal: error.message };
    }
  }

  presence(): PresenceEntry[] {
    return this.#room().presence();
  }

  history(input: {
    readonly channel?: string | null;
    readonly after?: number;
    readonly limit?: number;
  } = {}): { readonly messages: Message[]; readonly complete: boolean } {
    return this.#room().history(
      input.channel ?? null,
      input.after ?? 0,
      input.limit,
    );
  }

  disconnect(
    input: { readonly identity: string; readonly reason?: string },
  ): number {
    return this.#room().disconnect(input.identity, input.reason);
  }
}
