// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link RoomClient}: a room's client, for browsers and Deno. It keeps one
 * socket open: it reconnects with jittered backoff when the socket drops,
 * resubscribes each channel from the last message it saw (so nothing is
 * missed that the room still keeps, and nothing is seen twice), restores
 * its presence state, and pings to find a dead connection.
 *
 * ```ts
 * const room = new RoomClient({ url: "/rooms/lobby" });
 * room.subscribe("chat", (message) => render(message.data));
 * await room.publish("chat", { text: "hello" });
 * ```
 *
 * Publishing is at most once: a publish waiting for its `ack` when the
 * socket drops is rejected (`disconnected`) rather than sent again, since
 * the room may have accepted it. One not yet sent waits for the next
 * connection.
 *
 * @module
 */

import {
  type Json,
  type Message,
  PING,
  type PresenceEntry,
  type RoomErrorCode,
  type ServerFrame,
} from "./protocol.ts";

/** The part of `WebSocket` the client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

/** Where the client is. */
export type RoomStatus = "connecting" | "open" | "reconnecting" | "closed";

/** Timers and randomness, injectable for tests. */
export interface ClientRuntime {
  setTimer(ms: number, callback: () => void): () => void;
  random(): number;
}

const defaultRuntime: ClientRuntime = {
  setTimer(ms, callback) {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
  random: () => Math.random(),
};

/** Options for a {@link RoomClient}. */
export interface RoomClientOptions {
  /**
   * The room's socket: `ws(s)://` or `http(s)://`, or a path, resolved
   * against the page's location.
   */
  readonly url: string | URL;
  /**
   * Opens a socket; default `new WebSocket(url)`. In Deno, pass one that
   * sets headers: `(url) => new WebSocket(url, { headers })`.
   */
  readonly connect?: (url: string) => WebSocketLike;
  /**
   * Reconnect after a drop, waiting from `minMs` (default 500) doubling to
   * `maxMs` (default 30,000), with jitter; false never reconnects. A room
   * that closes with a code from 4000 (a kick) is not reconnected to.
   */
  readonly reconnect?: false | {
    readonly minMs?: number;
    readonly maxMs?: number;
  };
  /** How often to ping; default 25,000 ms, 0 for never. Two unanswered ones drop the socket. */
  readonly pingMs?: number;
  /** How long a publish waits for its `ack`; default 10,000 ms. */
  readonly ackTimeoutMs?: number;
  readonly onStatus?: (status: RoomStatus) => void;
  /** Called with everyone in presence whenever it changes. */
  readonly onPresence?: (presence: readonly PresenceEntry[]) => void;
  /** Errors not tied to a publish (a refused subscription, a rate limit). */
  readonly onError?: (error: RoomClientError) => void;
  readonly runtime?: ClientRuntime;
}

/** A refusal from the room, or a publish that could not be confirmed. */
export class RoomClientError extends Error {
  override readonly name = "RoomClientError";
  constructor(
    readonly code: RoomErrorCode | "disconnected" | "timeout" | "closed",
    message: string,
  ) {
    super(message);
  }
}

/** A subscriber's view of a message. */
export type Received<T = Json> = Message & { readonly data: T };

type MessageFrame = Extract<ServerFrame, { type: "message" }>;

interface Channel {
  readonly handlers: Set<(message: Received<never>) => void>;
  readonly resets: Set<() => void>;
  /**
   * The `seq` of the last message delivered, where a resubscription resumes;
   * -1 while unknown (a live subscription waiting for `subscribed`).
   */
  last: number;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: RoomClientError) => void;
  done: boolean;
}

interface Pending {
  readonly resolve: (seq: number) => void;
  readonly reject: (error: RoomClientError) => void;
  readonly cancel: () => void;
  sent: boolean;
  readonly frame: string;
}

function socketUrl(url: string | URL): string {
  const base = (globalThis as { location?: { href: string } }).location?.href;
  const resolved = new URL(url, base);
  if (resolved.protocol === "http:") resolved.protocol = "ws:";
  if (resolved.protocol === "https:") resolved.protocol = "wss:";
  return resolved.href;
}

/** A room's client; see the module documentation. */
export class RoomClient {
  readonly #url: string;
  readonly #options: RoomClientOptions;
  readonly #runtime: ClientRuntime;
  readonly #channels = new Map<string, Channel>();
  readonly #pending = new Map<string, Pending>();
  #socket: WebSocketLike | null = null;
  #status: RoomStatus = "connecting";
  #connection: string | null = null;
  #presence: PresenceEntry[] = [];
  #state: Json = null;
  #serial = 0;
  #attempt = 0;
  #ready: Deferred;
  #stopPing: (() => void) | null = null;
  #unanswered = 0;

  constructor(options: RoomClientOptions) {
    this.#options = options;
    this.#url = socketUrl(options.url);
    this.#runtime = options.runtime ?? defaultRuntime;
    this.#ready = this.#deferred();
    this.#open();
  }

  #deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (error: RoomClientError) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Nobody may be waiting; the callers of ready() still see the rejection.
    promise.catch(() => {});
    return { promise, resolve, reject, done: false };
  }

  /** Where the client is. */
  get status(): RoomStatus {
    return this.#status;
  }

  /** This connection's id, while open. */
  get connection(): string | null {
    return this.#connection;
  }

  /** Everyone in presence, as of the last update. */
  get presence(): readonly PresenceEntry[] {
    return this.#presence;
  }

  /**
   * Resolves once the room has welcomed the current (or next) connection.
   * Rejects (`closed`) once the client is closed for good, since no
   * connection will come.
   */
  ready(): Promise<void> {
    return this.#ready.promise;
  }

  #setStatus(status: RoomStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#options.onStatus?.(status);
  }

  #open(): void {
    const connect = this.#options.connect ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    let socket: WebSocketLike;
    try {
      socket = connect(this.#url);
    } catch {
      this.#dropped(1006);
      return;
    }
    this.#socket = socket;
    socket.onmessage = (event) => {
      if (this.#socket !== socket || typeof event.data !== "string") return;
      this.#unanswered = 0;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#receive(frame);
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#dropped(event.code);
    };
    socket.onerror = () => {};
  }

  #write(text: string): boolean {
    const socket = this.#socket;
    if (
      socket === null || socket.readyState !== 1 || this.#connection === null
    ) {
      return false;
    }
    try {
      socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  #subscribeFrame(name: string, channel: Channel): string {
    return JSON.stringify({
      type: "subscribe",
      channel: name,
      ...(channel.last >= 0 ? { after: channel.last } : {}),
    });
  }

  #receive(frame: ServerFrame): void {
    switch (frame.type) {
      case "welcome": {
        this.#connection = frame.connection;
        this.#presence = [...frame.presence];
        this.#attempt = 0;
        this.#setStatus("open");
        for (const [name, channel] of this.#channels) {
          this.#write(this.#subscribeFrame(name, channel));
        }
        if (this.#state !== null) {
          this.#write(JSON.stringify({ type: "presence", state: this.#state }));
        }
        for (const pending of this.#pending.values()) {
          if (!pending.sent) pending.sent = this.#write(pending.frame);
        }
        this.#startPing();
        this.#options.onPresence?.(this.#presence);
        this.#ready.resolve();
        this.#ready.done = true;
        return;
      }
      case "message": {
        const channel = this.#channels.get(frame.channel);
        if (channel === undefined) return;
        // A replay after a reconnect can repeat what was delivered.
        if (channel.last >= 0 && frame.seq <= channel.last) return;
        this.#deliver(channel, frame);
        return;
      }
      case "subscribed": {
        const channel = this.#channels.get(frame.channel);
        if (channel === undefined) return;
        if (channel.last < 0) channel.last = frame.last;
        return;
      }
      case "reset": {
        const channel = this.#channels.get(frame.channel);
        if (channel === undefined) return;
        // The channel resumes from the `subscribed` that follows.
        channel.last = -1;
        for (const reset of channel.resets) reset();
        return;
      }
      case "presence":
        this.#applyPresence(frame);
        return;
      case "ack": {
        const pending = this.#pending.get(frame.id);
        if (pending === undefined) return;
        this.#pending.delete(frame.id);
        pending.cancel();
        pending.resolve(frame.seq);
        return;
      }
      case "error": {
        const error = new RoomClientError(frame.code, frame.message);
        const pending = frame.id === undefined
          ? undefined
          : this.#pending.get(frame.id);
        if (pending !== undefined) {
          this.#pending.delete(frame.id!);
          pending.cancel();
          pending.reject(error);
        } else this.#options.onError?.(error);
        return;
      }
      case "pong":
        return;
    }
  }

  #deliver(channel: Channel, frame: MessageFrame): void {
    channel.last = frame.seq;
    const { type: _type, ...message } = frame;
    for (const handler of channel.handlers) handler(message as never);
  }

  #applyPresence(frame: Extract<ServerFrame, { type: "presence" }>): void {
    const previous = this.#presence.find((e) =>
      e.connection === frame.connection
    );
    const others = this.#presence.filter((e) =>
      e.connection !== frame.connection
    );
    this.#presence = frame.event === "leave" ? others : [...others, {
      connection: frame.connection,
      identity: frame.identity,
      state: frame.state,
      joinedAt: previous?.joinedAt ?? 0,
    }];
    this.#options.onPresence?.(this.#presence);
  }

  #startPing(): void {
    this.#stopPing?.();
    const every = this.#options.pingMs ?? 25_000;
    if (every <= 0) return;
    const tick = () => {
      if (this.#unanswered >= 2) {
        // Two pings without an answer: the connection is dead.
        this.#socket?.close(4999, "no answer");
        this.#dropped(1006);
        return;
      }
      this.#unanswered++;
      this.#write(PING);
      this.#stopPing = this.#runtime.setTimer(every, tick);
    };
    this.#stopPing = this.#runtime.setTimer(every, tick);
  }

  #dropped(code: number): void {
    this.#socket = null;
    this.#connection = null;
    this.#stopPing?.();
    this.#stopPing = null;
    this.#unanswered = 0;
    for (const [id, pending] of this.#pending) {
      if (!pending.sent) continue;
      this.#pending.delete(id);
      pending.cancel();
      pending.reject(
        new RoomClientError(
          "disconnected",
          "the socket dropped before the ack",
        ),
      );
    }
    if (this.#status === "closed") return;
    const reconnect = this.#options.reconnect;
    if (reconnect === false || (code >= 4000 && code < 4999)) {
      this.close();
      return;
    }
    this.#setStatus("reconnecting");
    if (this.#ready.done) this.#ready = this.#deferred();
    const min = reconnect?.minMs ?? 500;
    const max = reconnect?.maxMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** this.#attempt) *
      (0.5 + this.#runtime.random() / 2);
    this.#attempt++;
    this.#runtime.setTimer(delay, () => {
      if (this.#status !== "closed") this.#open();
    });
  }

  /**
   * Calls `handler` with each message of `channel`, and returns a function
   * that stops. With `after`, the room first replays the messages it keeps
   * after that sequence number (0 for all it keeps); `onReset` is called when
   * it no longer keeps them all, so the page reloads the channel's state.
   */
  subscribe<T = Json>(
    name: string,
    handler: (message: Received<T>) => void,
    options: { readonly after?: number; readonly onReset?: () => void } = {},
  ): () => void {
    let channel = this.#channels.get(name);
    const fresh = channel === undefined;
    if (channel === undefined) {
      channel = {
        handlers: new Set(),
        resets: new Set(),
        last: options.after ?? -1,
      };
      this.#channels.set(name, channel);
    }
    channel.handlers.add(handler as (message: Received<never>) => void);
    if (options.onReset !== undefined) channel.resets.add(options.onReset);
    if (fresh) this.#write(this.#subscribeFrame(name, channel));
    return () => {
      channel.handlers.delete(handler as (message: Received<never>) => void);
      if (options.onReset !== undefined) channel.resets.delete(options.onReset);
      // A stale stop, after this subscription ended and another of the same
      // name began, must leave the new one alone.
      if (channel.handlers.size === 0 && this.#channels.get(name) === channel) {
        this.#channels.delete(name);
        this.#write(JSON.stringify({ type: "unsubscribe", channel: name }));
      }
    };
  }

  /**
   * Publishes `data` to `channel`, resolving with its sequence number once
   * the room accepts it; see the module documentation for what a drop does.
   */
  publish(channel: string, data: Json): Promise<number> {
    if (this.#status === "closed") {
      return Promise.reject(
        new RoomClientError("closed", "the client is closed"),
      );
    }
    const id = `p${++this.#serial}`;
    const frame = JSON.stringify({ type: "publish", channel, data, id });
    return new Promise((resolve, reject) => {
      const cancel = this.#runtime.setTimer(
        this.#options.ackTimeoutMs ?? 10_000,
        () => {
          this.#pending.delete(id);
          reject(new RoomClientError("timeout", "no ack in time"));
        },
      );
      const pending: Pending = { resolve, reject, cancel, sent: false, frame };
      this.#pending.set(id, pending);
      pending.sent = this.#write(frame);
    });
  }

  /** Sets this connection's presence state (null clears it); kept across reconnects. */
  setPresence(state: Json): void {
    this.#state = state;
    this.#write(JSON.stringify({ type: "presence", state }));
  }

  /** Closes the socket for good. */
  close(): void {
    if (this.#status === "closed") return;
    this.#setStatus("closed");
    this.#stopPing?.();
    const socket = this.#socket;
    this.#socket = null;
    this.#connection = null;
    try {
      socket?.close(1000, "closed");
    } catch {
      // Already closed.
    }
    for (const pending of this.#pending.values()) {
      pending.cancel();
      pending.reject(new RoomClientError("closed", "the client is closed"));
    }
    this.#pending.clear();
    if (this.#ready.done) this.#ready = this.#deferred();
    this.#ready.done = true;
    this.#ready.reject(new RoomClientError("closed", "the client is closed"));
  }
}
