// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link RoomCore}: what a room does with its connections and messages,
 * apart from where its sockets and state live. The `RealtimeRoom` Durable
 * Object runs one over hibernatable WebSockets and its SQLite;
 * `@celld/web/realtime/testing` runs one over maps and fake sockets.
 *
 * Everything is synchronous, so each frame is handled whole before the
 * next: sequence numbers follow the order messages were accepted, and a
 * subscription's replay and its live messages never interleave as sent.
 * celld delivers them in that order too.
 *
 * @module
 */

import { LocalLimiter, type Policy } from "@celld/sec/ratelimit";
import {
  checkGrants,
  checkIdentity,
  type ClientFrame,
  granted,
  type Grants,
  type Identity,
  isChannel,
  type Json,
  type Message,
  parseClientFrame,
  PONG,
  type PresenceEntry,
  type RoomErrorCode,
  type ServerFrame,
} from "./protocol.ts";

/** A connection's state, kept across hibernation. */
export interface Connection {
  readonly id: string;
  readonly identity: Identity;
  readonly grants: Grants;
  readonly subscriptions: readonly string[];
  readonly presence: Json;
  readonly joinedAt: number;
}

/** Where a room's sockets and state live; see {@link RoomCore}. */
export interface RoomHost<S> {
  now(): number;
  /** Every socket the room holds. */
  sockets(): readonly S[];
  /** The connection id a socket was accepted with, or null. */
  idOf(socket: S): string | null;
  /** Sends a text frame; may throw if the socket is closing. */
  send(socket: S, text: string): void;
  close(socket: S, code: number, reason: string): void;
  loadConnections(): Connection[];
  putConnection(connection: Connection): void;
  deleteConnection(id: string): void;
  /** The last sequence number handed out; 0 for none. */
  lastSeq(): number;
  /** The `seq` of a channel's latest message; 0 for none. */
  channelLast(channel: string): number;
  /**
   * Stores a message (its `seq` the next one) as its channel's latest,
   * keeping only the newest `keep` messages.
   */
  append(message: Message, keep: number): void;
  /**
   * Kept messages after `seq` (of one channel, or all), oldest first, at
   * most `limit`, and whether none of the room's messages after `seq` was
   * dropped. {@link RoomCore} judges a channel by its own `prev` chain.
   */
  after(
    channel: string | null,
    seq: number,
    limit: number,
  ): { readonly messages: Message[]; readonly complete: boolean };
}

/** A room's limits. */
export interface RoomOptions {
  /** The most connections; past it, new ones are refused. Default 1000. */
  readonly maxConnections?: number;
  /** The most channels one connection may subscribe to. Default 32. */
  readonly maxSubscriptions?: number;
  /** The largest frame a client may send, in bytes. Default 64 KiB. */
  readonly maxFrameBytes?: number;
  /** The largest presence state, in bytes of JSON. Default 1 KiB. */
  readonly maxPresenceBytes?: number;
  /**
   * How many messages the room keeps for replay (0 for none). Default 100.
   * A client resuming from before the oldest gets a `reset`.
   */
  readonly history?: number;
  /**
   * Each connection's frame rate, as `@celld/sec/ratelimit` policies. Default
   * 20 a second with bursts of 40. Every frame the room reads counts,
   * malformed ones included; only pings the runtime answers do not.
   */
  readonly rate?: readonly Policy[];
}

/** Resolved {@link RoomOptions}. */
export interface ResolvedRoomOptions {
  readonly maxConnections: number;
  readonly maxSubscriptions: number;
  readonly maxFrameBytes: number;
  readonly maxPresenceBytes: number;
  readonly history: number;
  readonly rate: readonly Policy[];
}

/** A refusal the room's `validate` hook throws; the client sees `invalid`. */
export class RoomRefusal extends Error {
  override readonly name = "RoomRefusal";
}

/** What a room hands its `validate` hook: a message about to be accepted. */
export interface Draft {
  readonly channel: string;
  readonly data: Json;
  /** Null when the server publishes. */
  readonly from: Identity | null;
}

function count(value: unknown, what: string, min: number, max: number): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < min ||
    value > max
  ) {
    throw new RangeError(
      `${what} must be a whole number from ${min} to ${max}`,
    );
  }
  return value;
}

/** Checks {@link RoomOptions}, filling in the defaults. */
export function resolveRoomOptions(
  options: RoomOptions = {},
): ResolvedRoomOptions {
  for (const key of Object.keys(options)) {
    if (
      ![
        "maxConnections",
        "maxSubscriptions",
        "maxFrameBytes",
        "maxPresenceBytes",
        "history",
        "rate",
      ].includes(key)
    ) {
      throw new TypeError(`a room has no option ${JSON.stringify(key)}`);
    }
  }
  return Object.freeze({
    maxConnections: count(
      options.maxConnections ?? 1000,
      "maxConnections",
      1,
      32_768,
    ),
    maxSubscriptions: count(
      options.maxSubscriptions ?? 32,
      "maxSubscriptions",
      1,
      1024,
    ),
    maxFrameBytes: count(
      options.maxFrameBytes ?? 65_536,
      "maxFrameBytes",
      256,
      1_048_576,
    ),
    maxPresenceBytes: count(
      options.maxPresenceBytes ?? 1024,
      "maxPresenceBytes",
      2,
      65_536,
    ),
    history: count(options.history ?? 100, "history", 0, 100_000),
    rate: options.rate ?? [{ name: "frames", limit: 20, window: 1, burst: 40 }],
  });
}

const encoder = new TextEncoder();

/** The protocol engine of one room; see the module documentation. */
export class RoomCore<S> {
  readonly room: string;
  readonly options: ResolvedRoomOptions;
  readonly #host: RoomHost<S>;
  readonly #validate: (draft: Draft) => void;
  readonly #limiter: LocalLimiter;
  #connections: Map<string, Connection> | null = null;
  #sockets = new Map<string, S>();

  constructor(
    host: RoomHost<S>,
    room: string,
    options: RoomOptions = {},
    validate: (draft: Draft) => void = () => {},
  ) {
    this.#host = host;
    this.room = room;
    this.options = resolveRoomOptions(options);
    this.#validate = validate;
    this.#limiter = new LocalLimiter({
      name: "realtime",
      policies: this.options.rate,
      now: () => host.now(),
      maxKeys: this.options.maxConnections,
    });
  }

  /**
   * The connections, loaded from the host the first time after a start (or
   * a wake from hibernation), with records for sockets that are gone
   * dropped.
   */
  #live(): Map<string, Connection> {
    if (this.#connections !== null) return this.#connections;
    const sockets = new Map<string, S>();
    for (const socket of this.#host.sockets()) {
      const id = this.#host.idOf(socket);
      if (id !== null) sockets.set(id, socket);
    }
    const connections = new Map<string, Connection>();
    for (const connection of this.#host.loadConnections()) {
      if (sockets.has(connection.id)) {
        connections.set(connection.id, connection);
      } else this.#host.deleteConnection(connection.id);
    }
    this.#connections = connections;
    this.#sockets = sockets;
    return connections;
  }

  #send(socket: S | undefined, frame: ServerFrame): void {
    if (socket === undefined) return;
    try {
      this.#host.send(socket, JSON.stringify(frame));
    } catch {
      // A closing socket; the runtime reports its close.
    }
  }

  #error(socket: S, code: RoomErrorCode, message: string, id?: string): void {
    this.#send(socket, {
      type: "error",
      code,
      message,
      ...(id === undefined ? {} : { id }),
    });
  }

  #presenceOf(connection: Connection): PresenceEntry {
    return {
      connection: connection.id,
      identity: connection.identity,
      state: connection.presence,
      joinedAt: connection.joinedAt,
    };
  }

  #announce(
    event: "join" | "update" | "leave",
    connection: Connection,
  ): void {
    if (!connection.grants.presence) return;
    const frame: ServerFrame = {
      type: "presence",
      event,
      connection: connection.id,
      identity: connection.identity,
      state: connection.presence,
    };
    for (const [id, socket] of this.#sockets) {
      if (id !== connection.id) this.#send(socket, frame);
    }
  }

  /** How many connections the room has. */
  get size(): number {
    return this.#live().size;
  }

  /** Whether another connection fits. */
  hasRoom(): boolean {
    return this.#live().size < this.options.maxConnections;
  }

  /**
   * Takes a socket the host accepted with connection id `id`, and welcomes
   * it. The caller has checked {@link hasRoom}.
   */
  accept(socket: S, id: string, identity: Identity, grants: Grants): void {
    const connections = this.#live();
    const connection: Connection = {
      id,
      identity: checkIdentity(identity),
      grants: checkGrants(grants),
      subscriptions: [],
      presence: null,
      joinedAt: this.#host.now(),
    };
    connections.set(id, connection);
    this.#sockets.set(id, socket);
    this.#host.putConnection(connection);
    this.#send(socket, {
      type: "welcome",
      connection: id,
      room: this.room,
      identity: connection.identity,
      grants: connection.grants,
      presence: this.presence(),
    });
    this.#announce("join", connection);
  }

  /** Handles one frame from a socket. */
  message(socket: S, text: string | ArrayBuffer): void {
    const id = this.#host.idOf(socket);
    const connection = id === null ? undefined : this.#live().get(id);
    if (connection === undefined) {
      this.#host.close(socket, 1011, "unknown connection");
      return;
    }
    // Count before anything is answered: a malformed frame, an oversized
    // one, or a ping spelled differently from `PING` would otherwise get a
    // reply at any rate.
    const allowed = this.#limiter.limit(connection.id).allowed;
    const frame = parseClientFrame(text, this.options.maxFrameBytes);
    if (!allowed) {
      this.#error(
        socket,
        "rate_limited",
        "too many frames",
        "type" in frame && frame.type === "publish" ? frame.id : undefined,
      );
      return;
    }
    if ("error" in frame) {
      this.#error(socket, frame.error, frame.message);
      return;
    }
    if (frame.type === "ping") {
      this.#send(socket, JSON.parse(PONG));
      return;
    }
    this.#handle(socket, connection, frame);
  }

  #update(connection: Connection, change: Partial<Connection>): Connection {
    const updated = { ...connection, ...change };
    this.#live().set(connection.id, updated);
    this.#host.putConnection(updated);
    return updated;
  }

  #handle(socket: S, connection: Connection, frame: ClientFrame): void {
    switch (frame.type) {
      case "subscribe": {
        if (!granted(connection.grants.read, frame.channel)) {
          this.#error(
            socket,
            "forbidden",
            `no read grant for ${frame.channel}`,
          );
          return;
        }
        if (!connection.subscriptions.includes(frame.channel)) {
          if (
            connection.subscriptions.length >= this.options.maxSubscriptions
          ) {
            this.#error(
              socket,
              "too_many_subscriptions",
              `at most ${this.options.maxSubscriptions} subscriptions`,
            );
            return;
          }
          connection = this.#update(connection, {
            subscriptions: [...connection.subscriptions, frame.channel],
          });
        }
        if (frame.after !== undefined) {
          this.#replay(socket, frame.channel, frame.after);
        }
        this.#send(socket, {
          type: "subscribed",
          channel: frame.channel,
          last: this.#host.channelLast(frame.channel),
        });
        return;
      }
      case "unsubscribe":
        this.#update(connection, {
          subscriptions: connection.subscriptions.filter((c) =>
            c !== frame.channel
          ),
        });
        return;
      case "publish": {
        if (!granted(connection.grants.write, frame.channel)) {
          this.#error(
            socket,
            "forbidden",
            `no write grant for ${frame.channel}`,
            frame.id,
          );
          return;
        }
        let message: Message;
        try {
          message = this.#accept(
            frame.channel,
            frame.data,
            connection.identity,
          );
        } catch (error) {
          if (!(error instanceof RoomRefusal)) throw error;
          this.#error(socket, "invalid", error.message, frame.id);
          return;
        }
        if (frame.id !== undefined) {
          this.#send(socket, { type: "ack", id: frame.id, seq: message.seq });
        }
        return;
      }
      case "presence": {
        if (!connection.grants.presence) {
          this.#error(socket, "forbidden", "no presence grant");
          return;
        }
        const size = encoder.encode(JSON.stringify(frame.state)).length;
        if (size > this.options.maxPresenceBytes) {
          this.#error(
            socket,
            "too_large",
            `presence state is at most ${this.options.maxPresenceBytes} bytes`,
          );
          return;
        }
        this.#announce(
          "update",
          this.#update(connection, { presence: frame.state }),
        );
        return;
      }
    }
  }

  /**
   * Kept messages after `after`. A channel's are complete when nothing of
   * it came after `after`, or when the first kept one follows `after` in
   * the channel's `prev` chain: what the room dropped belonged to other
   * channels. The room-wide answer would reset a quiet channel in a busy
   * room.
   */
  #after(
    channel: string | null,
    after: number,
    limit: number,
  ): { readonly messages: Message[]; readonly complete: boolean } {
    const kept = this.#host.after(channel, after, limit);
    if (channel === null || kept.complete) return kept;
    const first = kept.messages[0];
    return {
      messages: kept.messages,
      complete: first === undefined
        ? this.#host.channelLast(channel) <= after
        : first.prev <= after,
    };
  }

  #replay(socket: S, channel: string, after: number): void {
    const { messages, complete } = this.#after(
      channel,
      after,
      this.options.history,
    );
    if (!complete) {
      this.#send(socket, { type: "reset", channel });
      return;
    }
    for (const message of messages) {
      this.#send(socket, { type: "message", ...message });
    }
  }

  /** Validates, numbers, keeps and delivers a message. */
  #accept(channel: string, data: Json, from: Identity | null): Message {
    this.#validate({ channel, data, from });
    const message: Message = {
      channel,
      seq: this.#host.lastSeq() + 1,
      prev: this.#host.channelLast(channel),
      data,
      from,
      at: this.#host.now(),
    };
    this.#host.append(message, this.options.history);
    const frame: ServerFrame = { type: "message", ...message };
    for (const [id, connection] of this.#live()) {
      if (connection.subscriptions.includes(channel)) {
        this.#send(this.#sockets.get(id), frame);
      }
    }
    return message;
  }

  /**
   * Publishes from the server (an HTTP handler, a Workflow): the same path
   * as a client's publish, with `from` null unless given. Throws
   * {@link RoomRefusal} when `validate` refuses it.
   */
  publish(channel: string, data: Json, from: Identity | null = null): Message {
    if (!isChannel(channel)) {
      throw new TypeError("a channel name is 1 to 64 of A-Z a-z 0-9 _ . : -");
    }
    const size = encoder.encode(JSON.stringify(data)).length;
    if (size > this.options.maxFrameBytes) {
      throw new RangeError(
        `a message is at most ${this.options.maxFrameBytes} bytes`,
      );
    }
    return this.#accept(
      channel,
      data,
      from === null ? null : checkIdentity(from),
    );
  }

  /** Forgets a socket that closed, and tells the others it left. */
  closed(socket: S): void {
    const id = this.#host.idOf(socket);
    if (id === null) return;
    const connection = this.#live().get(id);
    this.#live().delete(id);
    this.#sockets.delete(id);
    this.#host.deleteConnection(id);
    this.#limiter.reset(id);
    if (connection !== undefined) this.#announce("leave", connection);
  }

  /** Everyone in presence. */
  presence(): PresenceEntry[] {
    return [...this.#live().values()]
      .filter((connection) => connection.grants.presence)
      .map((connection) => this.#presenceOf(connection));
  }

  /** Kept messages after `after` (of one channel, or all), oldest first. */
  history(
    channel: string | null = null,
    after = 0,
    limit = this.options.history,
  ): { readonly messages: Message[]; readonly complete: boolean } {
    return this.#after(channel, after, limit);
  }

  /** Closes every connection of the identity `id` (a ban, a sign-out). */
  disconnect(identityId: string, reason = "disconnected"): number {
    let closed = 0;
    for (const [id, connection] of [...this.#live()]) {
      if (connection.identity.id !== identityId) continue;
      const socket = this.#sockets.get(id);
      if (socket !== undefined) this.#host.close(socket, 4000, reason);
      if (socket !== undefined) this.closed(socket);
      closed++;
    }
    return closed;
  }
}
