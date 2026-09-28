// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import {
  type ClientRuntime,
  RoomClient,
  RoomClientError,
  type RoomStatus,
} from "@celld/web/realtime/client";
import { memoryRoom } from "@celld/web/realtime/testing";

/** Timers a test moves by hand; `random` is fixed, for exact backoff. */
class Timers implements ClientRuntime {
  now = 0;
  #queue: { at: number; fn: () => void; id: number }[] = [];
  #serial = 0;
  setTimer(ms: number, fn: () => void): () => void {
    const id = ++this.#serial;
    this.#queue.push({ at: this.now + ms, fn, id });
    return () => {
      this.#queue = this.#queue.filter((timer) => timer.id !== id);
    };
  }
  random(): number {
    return 1;
  }
  /** Runs every timer due by `now + ms`, in order, letting sockets settle. */
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      this.#queue.sort((a, b) => a.at - b.at);
      const next = this.#queue[0];
      if (next === undefined || next.at > until) break;
      this.#queue.shift();
      this.now = next.at;
      next.fn();
      await settle();
    }
    this.now = until;
    await settle();
  }
  get pending(): number {
    return this.#queue.length;
  }
}

/** Lets queued microtasks and socket deliveries run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const ADA = { id: "ada" };
const CHAT = { read: ["chat"], write: ["chat"], presence: true };

function setup() {
  const room = memoryRoom();
  const timers = new Timers();
  const sockets: ReturnType<typeof room.socket>[] = [];
  const statuses: RoomStatus[] = [];
  const client = new RoomClient({
    url: "https://example.com/rooms/lobby",
    connect: () => {
      const socket = room.socket(ADA, CHAT);
      sockets.push(socket);
      return socket;
    },
    runtime: timers,
    onStatus: (status) => statuses.push(status),
  });
  return { room, timers, sockets, statuses, client };
}

Deno.test("client: subscribe, publish and receive, in order", async () => {
  const { room, client } = setup();
  const seen: unknown[] = [];
  client.subscribe("chat", (message) => seen.push([message.seq, message.data]));
  await client.ready();
  await settle();
  const seq = await client.publish("chat", { text: "hi" });
  room.core.publish("chat", "from the server");
  await settle();
  assertEquals(seq, 1);
  assertEquals(seen, [[1, { text: "hi" }], [2, "from the server"]]);
  assertEquals(client.status, "open");
  assertEquals(client.presence.map((entry) => entry.identity.id), ["ada"]);
});

Deno.test("client: a drop reconnects, resumes, and never repeats a message", async () => {
  const { room, timers, sockets, statuses, client } = setup();
  const seen: number[] = [];
  client.subscribe("chat", (message) => seen.push(message.data as number));
  await client.ready();
  await settle();
  room.core.publish("chat", 1);
  await settle();
  sockets[0].drop();
  await settle();
  assertEquals(client.status, "reconnecting");
  // Missed while away.
  room.core.publish("chat", 2);
  room.core.publish("chat", 3);
  await timers.advance(500);
  await client.ready();
  await settle();
  room.core.publish("chat", 4);
  await settle();
  assertEquals(seen, [1, 2, 3, 4]);
  assertEquals(sockets.length, 2);
  assertEquals(statuses, ["open", "reconnecting", "open"]);
});

Deno.test("client: backoff doubles to its cap, then resets once welcomed", async () => {
  const room = memoryRoom();
  const timers = new Timers();
  let fail = true;
  let opened = 0;
  const client = new RoomClient({
    url: "wss://example.com/rooms/lobby",
    connect: () => {
      opened++;
      const socket = room.socket(ADA, CHAT);
      if (fail) queueMicrotask(() => socket.drop());
      return socket;
    },
    runtime: timers,
    reconnect: { minMs: 100, maxMs: 400 },
  });
  await settle();
  assertEquals(opened, 1);
  for (const wait of [100, 200, 400, 400]) {
    await timers.advance(wait - 1);
    const before = opened;
    await timers.advance(1);
    assertEquals(opened, before + 1, `a retry after ${wait} ms`);
  }
  fail = false;
  await timers.advance(400);
  await client.ready();
  assertEquals(client.status, "open");
  client.close();
});

Deno.test("client: a publish in flight is rejected on a drop; an unsent one waits", async () => {
  const { sockets, timers, client } = setup();
  await client.ready();
  await settle();
  const inFlight = client.publish("chat", "maybe");
  sockets[0].drop();
  const error = await assertRejects(() => inFlight, RoomClientError);
  assertEquals(error.code, "disconnected");
  await settle();
  const queued = client.publish("chat", "later");
  await timers.advance(500);
  // The one in flight was lost with the connection here; with a real
  // network it may or may not have been accepted, so it is not resent.
  assertEquals(await queued, 1);
});

Deno.test("client: presence state is restored after a reconnect", async () => {
  const { room, sockets, timers, client } = setup();
  await client.ready();
  client.setPresence({ typing: true });
  await settle();
  sockets[0].drop();
  await settle();
  await timers.advance(500);
  await client.ready();
  await settle();
  assertEquals(room.core.presence().map((entry) => entry.state), [{
    typing: true,
  }]);
});

Deno.test("client: refusals reject publishes, and reach onError otherwise", async () => {
  const room = memoryRoom();
  const errors: string[] = [];
  const client = new RoomClient({
    url: "https://example.com/x",
    connect: () => room.socket(ADA, { read: ["chat"] }),
    runtime: new Timers(),
    onError: (error) => errors.push(error.code),
  });
  await client.ready();
  const refused = await assertRejects(
    () => client.publish("chat", 1),
    RoomClientError,
  );
  assertEquals(refused.code, "forbidden");
  client.subscribe("secret", () => {});
  await settle();
  assertEquals(errors, ["forbidden"]);
});

Deno.test("client: a replay the room no longer keeps calls onReset", async () => {
  const room = memoryRoom({ options: { history: 1 } });
  room.core.publish("chat", 1);
  room.core.publish("chat", 2);
  const resets: string[] = [];
  const client = new RoomClient({
    url: "https://example.com/x",
    connect: () => room.socket(ADA, CHAT),
    runtime: new Timers(),
  });
  client.subscribe("chat", () => {}, {
    after: 0,
    onReset: () => resets.push("chat"),
  });
  await client.ready();
  await settle();
  assertEquals(resets, ["chat"]);
});

Deno.test("client: pings find a dead connection; a kick is not retried", async () => {
  const { room, sockets, timers, client } = setup();
  await client.ready();
  await settle();
  // The room stops answering (a half-open socket): no pongs come back.
  room.host.sockets_.clear();
  await timers.advance(25_000 * 3 + 500);
  assert(sockets.length >= 2, "reconnected after two unanswered pings");
  await client.ready();
  await settle();
  // A kick (4000) is final.
  room.core.disconnect("ada", "banned");
  await settle();
  const last = sockets.at(-1)!;
  last.onclose?.({ code: 4000, reason: "banned" } as CloseEvent);
  await timers.advance(60_000);
  assertEquals(client.status, "closed");
  await assertRejects(() => client.publish("chat", 1), RoomClientError);
});

Deno.test("client: close stops everything", async () => {
  const { sockets, timers, client } = setup();
  await client.ready();
  const pending = client.publish("chat", "x");
  client.close();
  const error = await assertRejects(() => pending, RoomClientError);
  assert(["closed", "disconnected"].includes(error.code), error.code);
  await timers.advance(60_000);
  assertEquals(sockets.length, 1);
  assertEquals(timers.pending, 0);
});

/** A socket whose server frames the test writes, in any order it likes. */
function scripted() {
  const sent: Record<string, unknown>[] = [];
  const socket = {
    readyState: 1,
    send: (data: string) => void sent.push(JSON.parse(data)),
    close() {},
    onopen: null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null,
    onerror: null,
    push(frame: object) {
      socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
    },
  };
  return { socket, sent };
}

const WELCOME = {
  type: "welcome",
  connection: "c1",
  room: "lobby",
  identity: { id: "ada" },
  grants: CHAT,
  presence: [],
};

function message(seq: number, prev: number) {
  return {
    type: "message",
    channel: "chat",
    seq,
    prev,
    data: seq,
    from: null,
    at: 0,
  };
}

Deno.test("client: a stale stop leaves a newer subscription alone", () => {
  const { socket, sent } = scripted();
  const client = new RoomClient({
    url: "wss://example.com/x",
    connect: () => socket,
    runtime: new Timers(),
  });
  socket.push(WELCOME);
  const first: number[] = [];
  const second: number[] = [];
  const stopFirst = client.subscribe("chat", (m) => first.push(m.seq));
  stopFirst();
  client.subscribe("chat", (m) => second.push(m.seq));
  socket.push({ type: "subscribed", channel: "chat", last: 0 });
  stopFirst();
  socket.push(message(1, 0));
  assertEquals([first, second], [[], [1]]);
  assertEquals(sent.map((frame) => frame.type), [
    "subscribe",
    "unsubscribe",
    "subscribe",
  ]);
  client.close();
});

Deno.test("client: ready() rejects once the client is closed for good", async () => {
  const { client } = setup();
  const waiting = client.ready();
  client.close();
  assertEquals(
    (await assertRejects(() => waiting, RoomClientError)).code,
    "closed",
  );
  // So does a later call, even after a welcome had resolved an earlier one.
  const welcomed = setup();
  await welcomed.client.ready();
  welcomed.client.close();
  assertEquals(
    (await assertRejects(() => welcomed.client.ready(), RoomClientError)).code,
    "closed",
  );
});

Deno.test("client: a kick settles ready() for good", async () => {
  const { room, sockets, timers, client } = setup();
  await client.ready();
  await settle();
  room.core.disconnect("ada", "banned");
  sockets.at(-1)!.onclose?.({ code: 4000, reason: "banned" } as CloseEvent);
  await timers.advance(60_000);
  assertEquals(client.status, "closed");
  await assertRejects(() => client.ready(), RoomClientError);
});
