// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Test doubles: {@link memoryRoom}, a {@link RoomCore} over maps and fake
 * sockets, with connections a test drives frame by frame
 * ({@link TestConnection}) or through a real {@link RoomClient} over an
 * in-process socket pair, whose network the test can cut. As the runtime's
 * auto-response does for `RealtimeRoom`, the host answers a frame that is
 * exactly `PING` itself, so the room never sees it.
 *
 * @module
 */

import type { WebSocketLike } from "./client.ts";
import {
  type Grants,
  type Identity,
  type Message,
  PING,
  PONG,
  type ServerFrame,
} from "./protocol.ts";
import {
  type Connection,
  type Draft,
  RoomCore,
  type RoomHost,
  type RoomOptions,
} from "./room.ts";

/** The room's end of a fake connection. */
export class FakeSocket {
  readonly id: string;
  /** Frames the room sent, as text. */
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  /** Called with each frame the room sends. */
  onSend: ((text: string) => void) | null = null;

  constructor(id: string) {
    this.id = id;
  }
}

/** A {@link RoomHost} over maps. */
export class MemoryRoomHost implements RoomHost<FakeSocket> {
  readonly sockets_ = new Set<FakeSocket>();
  readonly connections = new Map<string, Connection>();
  readonly messages: Message[] = [];
  readonly channels = new Map<string, number>();
  seq = 0;
  trimmed = 0;

  constructor(readonly now: () => number = Date.now) {}

  sockets(): readonly FakeSocket[] {
    return [...this.sockets_];
  }

  idOf(socket: FakeSocket): string | null {
    // Like a hibernatable socket's attachment, the id outlives the socket.
    return socket.id;
  }

  send(socket: FakeSocket, text: string): void {
    if (socket.closed !== null) throw new Error("closed");
    socket.sent.push(text);
    socket.onSend?.(text);
  }

  close(socket: FakeSocket, code: number, reason: string): void {
    socket.closed ??= { code, reason };
    this.sockets_.delete(socket);
  }

  loadConnections(): Connection[] {
    return [...this.connections.values()].map((c) => structuredClone(c));
  }

  putConnection(connection: Connection): void {
    this.connections.set(connection.id, structuredClone(connection));
  }

  deleteConnection(id: string): void {
    this.connections.delete(id);
  }

  lastSeq(): number {
    return this.seq;
  }

  channelLast(channel: string): number {
    return this.channels.get(channel) ?? 0;
  }

  append(message: Message, keep: number): void {
    this.seq = message.seq;
    this.channels.set(message.channel, message.seq);
    if (keep > 0) this.messages.push(structuredClone(message));
    const cut = message.seq - keep;
    if (cut > this.trimmed) {
      this.trimmed = cut;
      while (this.messages.length > 0 && this.messages[0].seq <= cut) {
        this.messages.shift();
      }
    }
  }

  after(channel: string | null, seq: number, limit: number) {
    return {
      messages: this.messages
        .filter((m) =>
          m.seq > seq && (channel === null || m.channel === channel)
        )
        .slice(0, limit)
        .map((m) => structuredClone(m)),
      complete: seq >= this.trimmed,
    };
  }
}

/** A connection a test drives by hand. */
export interface TestConnection {
  readonly socket: FakeSocket;
  /** The frames the room sent it so far, parsed. */
  frames(): ServerFrame[];
  /** The frames of one type. */
  of<T extends ServerFrame["type"]>(
    type: T,
  ): Extract<ServerFrame, { type: T }>[];
  /** Sends a frame (an object, or raw text). */
  send(frame: object | string): void;
  /** Closes it, as the client going away would. */
  close(): void;
}

/** {@link memoryRoom}'s result. */
export interface MemoryRoom {
  readonly core: RoomCore<FakeSocket>;
  readonly host: MemoryRoomHost;
  /** Connects a test connection. */
  connect(identity: Identity, grants: Partial<Grants>): TestConnection;
  /**
   * A socket for {@link RoomClient}'s `connect` option: it opens
   * asynchronously, as a network one would, and `drop()` cuts it without
   * a clean close.
   */
  socket(identity: Identity, grants: Partial<Grants>): WebSocketLike & {
    drop(): void;
  };
  /**
   * Simulates hibernation: the room forgets everything held in memory and
   * reloads from the host on its next event, as a woken object does.
   */
  hibernate(): void;
}

function fullGrants(grants: Partial<Grants>): Grants {
  return {
    read: grants.read ?? [],
    write: grants.write ?? [],
    presence: grants.presence ?? false,
  };
}

/** A room in memory; see the module documentation. */
export function memoryRoom(
  options: {
    readonly room?: string;
    readonly options?: RoomOptions;
    readonly validate?: (draft: Draft) => void;
    readonly now?: () => number;
  } = {},
): MemoryRoom {
  const host = new MemoryRoomHost(options.now);
  const make = () =>
    new RoomCore(
      host,
      options.room ?? "room",
      options.options,
      options.validate,
    );
  let core = make();
  let serial = 0;

  /** A frame from the client: the auto-response's, or the room's. */
  function deliver(socket: FakeSocket, text: string): void {
    if (text === PING) host.send(socket, PONG);
    else core.message(socket, text);
  }

  function open(identity: Identity, grants: Partial<Grants>): FakeSocket {
    const socket = new FakeSocket(`c${++serial}`);
    host.sockets_.add(socket);
    core.accept(socket, socket.id, identity, fullGrants(grants));
    return socket;
  }

  return {
    get core() {
      return core;
    },
    host,
    connect(identity, grants) {
      const socket = open(identity, grants);
      const frames = () =>
        socket.sent.map((text) => JSON.parse(text) as ServerFrame);
      return {
        socket,
        frames,
        of: (type) => frames().filter((frame) => frame.type === type) as never,
        send: (frame) =>
          deliver(
            socket,
            typeof frame === "string" ? frame : JSON.stringify(frame),
          ),
        close() {
          host.sockets_.delete(socket);
          core.closed(socket);
        },
      };
    },
    socket(identity, grants) {
      let server: FakeSocket | null = null;
      const client: WebSocketLike & { drop(): void; readyState: number } = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(data: string) {
          if (client.readyState !== 1 || server === null) {
            throw new Error("not open");
          }
          const socket = server;
          queueMicrotask(() => {
            if (host.sockets_.has(socket)) deliver(socket, data);
          });
        },
        close(code = 1000, reason = "") {
          if (client.readyState >= 2) return;
          client.readyState = 3;
          const socket = server;
          if (socket !== null) {
            host.sockets_.delete(socket);
            core.closed(socket);
          }
          queueMicrotask(() =>
            client.onclose?.({ code, reason, wasClean: true } as CloseEvent)
          );
        },
        drop() {
          if (client.readyState >= 2) return;
          client.readyState = 3;
          const socket = server;
          if (socket !== null) {
            host.sockets_.delete(socket);
            core.closed(socket);
          }
          queueMicrotask(() =>
            client.onclose?.(
              { code: 1006, reason: "", wasClean: false } as CloseEvent,
            )
          );
        },
      };
      queueMicrotask(() => {
        if (client.readyState !== 0) return;
        client.readyState = 1;
        client.onopen?.(new Event("open"));
        const socket = new FakeSocket(`c${++serial}`);
        socket.onSend = (text) =>
          queueMicrotask(() => {
            if (client.readyState === 1) {
              client.onmessage?.({ data: text } as MessageEvent);
            }
          });
        server = socket;
        host.sockets_.add(socket);
        core.accept(socket, socket.id, identity, fullGrants(grants));
      });
      return client;
    },
    hibernate() {
      core = make();
    },
  };
}
