// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The wire protocol between a room and its clients: JSON text frames, one
 * message each.
 *
 * Frames arrive in the order the room sent them. Every message also names
 * the previous message of its channel (`prev`), which is how the room tells
 * whether a resumed subscription missed anything of its channel.
 *
 * Client to room:
 *
 * | Frame | Meaning |
 * | --- | --- |
 * | `{"type":"subscribe","channel":c,"after"?:seq}` | receive `c`'s messages, first replaying those after `seq` |
 * | `{"type":"unsubscribe","channel":c}` | stop |
 * | `{"type":"publish","channel":c,"data":d,"id"?:s}` | send `d` to `c`'s subscribers; answered by `ack` or `error` with `id` |
 * | `{"type":"presence","state":d}` | set this connection's presence state (`null` clears it) |
 * | `{"type":"ping"}` | answered `{"type":"pong"}` without waking the room |
 *
 * Room to client:
 *
 * | Frame | Meaning |
 * | --- | --- |
 * | `{"type":"welcome","connection","room","identity","grants","presence":[...]}` | the connection is open, with who is in presence |
 * | `{"type":"message","channel","seq","prev","data","from","at"}` | a message; `seq` orders every message of the room, `prev` is the channel's previous one (0 for none) |
 * | `{"type":"subscribed","channel","last"}` | the subscription is live, and replay (if any) is done; `last` is the channel's latest `seq` |
 * | `{"type":"reset","channel"}` | the replay asked for is no longer kept: reload the channel's state |
 * | `{"type":"presence","event":"join"\|"update"\|"leave","connection","identity","state"}` | presence changed |
 * | `{"type":"ack","id","seq"}` | a publish was accepted |
 * | `{"type":"error","code","message","id"?}` | something was refused |
 *
 * @module
 */

import { parseJsonBounded } from "@celld/core/bounds";

/** A JSON value. */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** Who a connection is, as other members see it: chosen by the Worker. */
export interface Identity {
  /** A public, stable id (a user id, not a credential). */
  readonly id: string;
  /** Anything else members may see (a display name, an avatar). */
  readonly [key: string]: Json;
}

/**
 * What a connection may do, decided by the Worker when it connects. A
 * pattern is a channel name, a prefix ending in `*` (`doc:*`), or `*`.
 */
export interface Grants {
  /** Channels it may subscribe to. */
  readonly read: readonly string[];
  /** Channels it may publish to. */
  readonly write: readonly string[];
  /** Whether it appears in presence (and may set presence state). */
  readonly presence: boolean;
}

/** A message as a room stores and delivers it. */
export interface Message {
  readonly channel: string;
  /** The room's sequence number: every message of a room has its own. */
  readonly seq: number;
  /** The `seq` of the channel's previous message, or 0 for its first. */
  readonly prev: number;
  readonly data: Json;
  /** Who published it; null when the server did. */
  readonly from: Identity | null;
  /** When the room accepted it, in epoch milliseconds. */
  readonly at: number;
}

/** A connection in presence. */
export interface PresenceEntry {
  readonly connection: string;
  readonly identity: Identity;
  readonly state: Json;
  readonly joinedAt: number;
}

/** A frame a client sends. */
export type ClientFrame =
  | {
    readonly type: "subscribe";
    readonly channel: string;
    readonly after?: number;
  }
  | { readonly type: "unsubscribe"; readonly channel: string }
  | {
    readonly type: "publish";
    readonly channel: string;
    readonly data: Json;
    readonly id?: string;
  }
  | { readonly type: "presence"; readonly state: Json }
  | { readonly type: "ping" };

/** A frame a room sends. */
export type ServerFrame =
  | {
    readonly type: "welcome";
    readonly connection: string;
    readonly room: string;
    readonly identity: Identity;
    readonly grants: Grants;
    readonly presence: readonly PresenceEntry[];
  }
  | ({ readonly type: "message" } & Message)
  | {
    readonly type: "subscribed";
    readonly channel: string;
    readonly last: number;
  }
  | { readonly type: "reset"; readonly channel: string }
  | {
    readonly type: "presence";
    readonly event: "join" | "update" | "leave";
    readonly connection: string;
    readonly identity: Identity;
    readonly state: Json;
  }
  | { readonly type: "ack"; readonly id: string; readonly seq: number }
  | {
    readonly type: "error";
    readonly code: RoomErrorCode;
    readonly message: string;
    readonly id?: string;
  }
  | { readonly type: "pong" };

/** Why a room refused a frame. */
export type RoomErrorCode =
  /** Not a frame of this protocol, or a malformed one. */
  | "bad_frame"
  /** The connection's grants do not allow it. */
  | "forbidden"
  /** Too many frames too fast. */
  | "rate_limited"
  /** Over a size limit. */
  | "too_large"
  /** Too many subscriptions. */
  | "too_many_subscriptions"
  /** The room's own validation refused the data. */
  | "invalid";

/** The ping a client sends, and the pong a room answers without waking. */
export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';

const CHANNEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const PATTERN = /^(?:\*|[A-Za-z0-9_.:-]{1,64}\*?)$/;
const ROOM = /^[A-Za-z0-9_.:-]{1,128}$/;
const PUBLISH_ID = /^[\x21-\x7e]{1,64}$/;

/** Whether `name` is a channel name: 1 to 64 of `A-Z a-z 0-9 _ . : -`. */
export function isChannel(name: unknown): name is string {
  return typeof name === "string" && CHANNEL.test(name);
}

/** Whether `name` is a room name: 1 to 128 of `A-Z a-z 0-9 _ . : -`. */
export function isRoomName(name: unknown): name is string {
  return typeof name === "string" && ROOM.test(name);
}

/** Whether `channel` matches one of `patterns` (see {@link Grants}). */
export function granted(patterns: readonly string[], channel: string): boolean {
  return patterns.some((pattern) =>
    pattern === "*" || pattern === channel ||
    (pattern.endsWith("*") && channel.startsWith(pattern.slice(0, -1)))
  );
}

/** Checks grants; throws a `TypeError` for a bad one. */
export function checkGrants(grants: unknown): Grants {
  const g = grants as Partial<Grants> | null;
  if (typeof g !== "object" || g === null) {
    throw new TypeError("grants must be an object");
  }
  for (const key of Object.keys(g)) {
    if (!["read", "write", "presence"].includes(key)) {
      throw new TypeError(`grants have no ${JSON.stringify(key)}`);
    }
  }
  const list = (value: unknown, what: string): string[] => {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) || value.length > 64 ||
      value.some((p) => typeof p !== "string" || !PATTERN.test(p))
    ) {
      throw new TypeError(
        `grants.${what} is a list of at most 64 channels, prefixes ending in *, or *`,
      );
    }
    return [...value];
  };
  if (g.presence !== undefined && typeof g.presence !== "boolean") {
    throw new TypeError("grants.presence is a boolean");
  }
  return Object.freeze({
    read: Object.freeze(list(g.read, "read")),
    write: Object.freeze(list(g.write, "write")),
    presence: g.presence ?? false,
  });
}

/** The most UTF-8 bytes of an identity's JSON. */
export const MAX_IDENTITY_BYTES = 1024;

/** Checks an identity; throws a `TypeError` for a bad one. */
export function checkIdentity(identity: unknown): Identity {
  const value = identity as Partial<Identity> | null;
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof value.id !== "string" || value.id === "" || value.id.length > 256
  ) {
    throw new TypeError(
      "an identity is an object with an id of 1 to 256 characters",
    );
  }
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > MAX_IDENTITY_BYTES) {
    throw new TypeError(
      `an identity is at most ${MAX_IDENTITY_BYTES} bytes of JSON`,
    );
  }
  return JSON.parse(text);
}

/**
 * Parses a client frame, or returns a reason it is not one. `maxBytes`
 * bounds the whole frame.
 */
export function parseClientFrame(
  text: string | ArrayBuffer,
  maxBytes: number,
): ClientFrame | { readonly error: RoomErrorCode; readonly message: string } {
  if (typeof text !== "string") {
    return { error: "bad_frame", message: "frames are JSON text" };
  }
  if (
    text.length * 3 > maxBytes &&
    new TextEncoder().encode(text).length > maxBytes
  ) {
    return {
      error: "too_large",
      message: `a frame is at most ${maxBytes} bytes`,
    };
  }
  let value: unknown;
  try {
    value = parseJsonBounded(text, {
      maxDepth: 16,
      maxKeys: 256,
      maxItems: 1024,
      maxBytes,
    });
  } catch {
    return { error: "bad_frame", message: "a frame is a bounded JSON object" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "bad_frame", message: "a frame is a JSON object" };
  }
  const frame = value as Record<string, unknown>;
  const bad = (message: string) => ({ error: "bad_frame" as const, message });
  switch (frame.type) {
    case "subscribe": {
      if (!isChannel(frame.channel)) {
        return bad("subscribe needs a channel name");
      }
      const after = frame.after;
      if (
        after !== undefined &&
        (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0)
      ) {
        return bad("after is a sequence number");
      }
      return {
        type: "subscribe",
        channel: frame.channel,
        ...(after === undefined ? {} : { after }),
      };
    }
    case "unsubscribe":
      if (!isChannel(frame.channel)) {
        return bad("unsubscribe needs a channel name");
      }
      return { type: "unsubscribe", channel: frame.channel };
    case "publish": {
      if (!isChannel(frame.channel)) return bad("publish needs a channel name");
      if (!("data" in frame)) return bad("publish needs data");
      const id = frame.id;
      if (
        id !== undefined && (typeof id !== "string" || !PUBLISH_ID.test(id))
      ) {
        return bad("a publish id is 1 to 64 printable characters");
      }
      return {
        type: "publish",
        channel: frame.channel,
        data: frame.data as Json,
        ...(id === undefined ? {} : { id }),
      };
    }
    case "presence":
      if (!("state" in frame)) {
        return bad("presence needs a state (null to clear)");
      }
      return { type: "presence", state: frame.state as Json };
    case "ping":
      return { type: "ping" };
    default:
      return bad("an unknown frame type");
  }
}

/** The header a connection's identity and grants travel to the room in. */
export const CONNECT_HEADER = "x-celld-realtime-connect";

/**
 * The RPC surface of `RealtimeRoom`. Type its binding with it:
 * `ROOMS: DurableObjectNamespace<RoomApi>`.
 */
export interface RoomApi {
  fetch(request: Request): Response | Promise<Response>;
  /**
   * Publishes from the server. A refusal by the room's `validate` is a
   * result, not a throw: an error thrown across RPC loses its class.
   */
  publish(input: {
    readonly channel: string;
    readonly data: Json;
    readonly from?: Identity | null;
  }): PublishResult;
  presence(): PresenceEntry[];
  /** Kept messages after `after`, of one channel or all. */
  history(input?: {
    readonly channel?: string | null;
    readonly after?: number;
    readonly limit?: number;
  }): { readonly messages: Message[]; readonly complete: boolean };
  /** Closes every connection of one identity; returns how many. */
  disconnect(
    input: { readonly identity: string; readonly reason?: string },
  ): number;
}

/** What `RoomApi.publish` answers. */
export type PublishResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly refusal: string };
