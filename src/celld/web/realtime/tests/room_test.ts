// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import { type Draft, RoomRefusal } from "@celld/web/realtime";
import { memoryRoom } from "@celld/web/realtime/testing";

const ADA = { id: "ada", name: "Ada" };
const BOB = { id: "bob", name: "Bob" };
const CHAT = { read: ["chat"], write: ["chat"], presence: true };

Deno.test("room: a welcome, then messages in order to subscribers only", () => {
  const room = memoryRoom({ room: "lobby" });
  const ada = room.connect(ADA, CHAT);
  const welcome = ada.of("welcome")[0];
  assertEquals(welcome.room, "lobby");
  assertEquals(welcome.identity, ADA);
  assertEquals(welcome.grants, CHAT);
  assertEquals(welcome.presence.map((entry) => entry.identity.id), ["ada"]);
  const bob = room.connect(BOB, CHAT);
  ada.send({ type: "subscribe", channel: "chat" });
  ada.send({ type: "publish", channel: "chat", data: "one", id: "p1" });
  bob.send({ type: "publish", channel: "chat", data: "two" });
  const messages = ada.of("message");
  assertEquals(messages.map((m) => [m.seq, m.data, m.from?.id]), [
    [1, "one", "ada"],
    [2, "two", "bob"],
  ]);
  assertEquals(ada.of("ack"), [{ type: "ack", id: "p1", seq: 1 }]);
  assertEquals(bob.of("message"), [], "bob is not subscribed");
  assertEquals(ada.of("subscribed"), [{
    type: "subscribed",
    channel: "chat",
    last: 0,
  }]);
  assertEquals(
    messages.map((m) => m.prev),
    [0, 1],
    "each names its predecessor",
  );
});

Deno.test("room: grants decide who reads and writes what", () => {
  const room = memoryRoom();
  const reader = room.connect(ADA, { read: ["doc:*"] });
  reader.send({ type: "subscribe", channel: "chat" });
  reader.send({ type: "publish", channel: "doc:1", data: 1, id: "w" });
  reader.send({ type: "presence", state: { typing: true } });
  assertEquals(reader.of("error").map((e) => [e.code, e.id]), [
    ["forbidden", undefined],
    ["forbidden", "w"],
    ["forbidden", undefined],
  ]);
  reader.send({ type: "subscribe", channel: "doc:1" });
  room.core.publish("doc:1", { edit: 1 });
  assertEquals(reader.of("message").map((m) => [m.data, m.from]), [[
    { edit: 1 },
    null,
  ]]);
});

Deno.test("room: presence joins, updates and leaves, for those in it", () => {
  const room = memoryRoom();
  const ada = room.connect(ADA, CHAT);
  const lurker = room.connect({ id: "lurker" }, { read: ["chat"] });
  const bob = room.connect(BOB, CHAT);
  assertEquals(ada.of("presence").map((p) => [p.event, p.identity.id]), [[
    "join",
    "bob",
  ]]);
  assertEquals(bob.of("welcome")[0].presence.map((e) => e.identity.id), [
    "ada",
    "bob",
  ]);
  bob.send({ type: "presence", state: { cursor: [1, 2] } });
  bob.send({ type: "presence", state: "x".repeat(2000) });
  assertEquals(bob.of("error").map((e) => e.code), ["too_large"]);
  bob.close();
  assertEquals(
    ada.of("presence").map((p) => [p.event, p.identity.id, p.state]),
    [
      ["join", "bob", null],
      ["update", "bob", { cursor: [1, 2] }],
      ["leave", "bob", { cursor: [1, 2] }],
    ],
  );
  assertEquals(lurker.of("presence").length, 3, "a lurker sees presence");
  assertEquals(room.core.presence().map((e) => e.identity.id), ["ada"]);
});

Deno.test("room: a subscriber resumes after a sequence number, or is told to reset", () => {
  const room = memoryRoom({ options: { history: 3 } });
  for (let i = 1; i <= 5; i++) room.core.publish(i % 2 ? "odd" : "even", i);
  const late = room.connect(ADA, { read: ["*"] });
  late.send({ type: "subscribe", channel: "odd", after: 2 });
  assertEquals(late.of("message").map((m) => m.data), [3, 5]);
  assertEquals(late.frames().at(-1), {
    type: "subscribed",
    channel: "odd",
    last: 5,
  });
  assertEquals(late.of("message").map((m) => m.prev), [1, 3], "the odd chain");
  late.send({ type: "subscribe", channel: "even", after: 1 });
  assertEquals(late.of("reset"), [{ type: "reset", channel: "even" }]);
  late.send({ type: "subscribe", channel: "even", after: 2 });
  assertEquals(late.of("message").map((m) => m.data), [3, 5, 4]);
  assertEquals(room.core.history("odd").messages.map((m) => m.seq), [3, 5]);
  assertEquals(room.core.history(null, 3).messages.map((m) => m.seq), [4, 5]);
});

Deno.test("room: with no history, a resume resets only if it missed something", () => {
  const room = memoryRoom({ options: { history: 0 } });
  room.core.publish("chat", 1);
  const ada = room.connect(ADA, CHAT);
  ada.send({ type: "subscribe", channel: "chat", after: 0 });
  assertEquals(ada.of("reset").length, 1);
  assertEquals(room.core.history().messages, []);
  ada.send({ type: "subscribe", channel: "chat", after: 1 });
  ada.send({ type: "subscribe", channel: "other", after: 0 });
  assertEquals(ada.of("reset").length, 1, "nothing was missed");
});

Deno.test("room: a quiet channel in a busy room resumes without a reset", () => {
  const room = memoryRoom({ options: { history: 3 } });
  room.core.publish("quiet", "a");
  room.core.publish("quiet", "b");
  for (let i = 0; i < 10; i++) room.core.publish("busy", i);
  const resume = (after: number) => {
    const connection = room.connect(ADA, { read: ["*"] });
    connection.send({ type: "subscribe", channel: "quiet", after });
    return connection;
  };
  // Messages 1 to 9 are gone, but quiet's two came before the resume point.
  assertEquals(resume(2).of("reset"), []);
  assertEquals(room.core.history("quiet", 2).complete, true);
  room.core.publish("quiet", "c");
  for (let i = 0; i < 5; i++) room.core.publish("busy", i);
  // c (13) is gone now, so a resume from b has missed it.
  assertEquals(resume(2).of("reset"), [{ type: "reset", channel: "quiet" }]);
  assertEquals(room.core.history("quiet", 2).complete, false);
  // A kept message that follows on from the resume point is a full replay.
  room.core.publish("quiet", "d");
  const caughtUp = resume(13);
  assertEquals(caughtUp.of("reset"), []);
  assertEquals(caughtUp.of("message").map((m) => [m.data, m.prev]), [[
    "d",
    13,
  ]]);
  assertEquals(room.core.history(null, 2).complete, false, "room-wide");
});

Deno.test("room: limits on subscriptions, frames and rate", () => {
  let now = 0;
  const room = memoryRoom({
    now: () => now,
    options: {
      maxSubscriptions: 2,
      maxFrameBytes: 256,
      rate: [{ name: "frames", limit: 5, window: 1, burst: 5 }],
    },
  });
  const ada = room.connect(ADA, { read: ["*"], write: ["*"] });
  ada.send({ type: "subscribe", channel: "a" });
  ada.send({ type: "subscribe", channel: "b" });
  ada.send({ type: "subscribe", channel: "c" });
  ada.send({ type: "publish", channel: "a", data: "x".repeat(300) });
  ada.send({ type: "ping" }); // exactly PING: the runtime answers it
  ada.send({ type: "publish", channel: "a", data: 1, id: "one" });
  ada.send({ type: "publish", channel: "a", data: 2, id: "two" });
  ada.send({ type: "publish", channel: "a", data: 3, id: "three" });
  assertEquals(ada.of("error").map((e) => [e.code, e.id]), [
    ["too_many_subscriptions", undefined],
    ["too_large", undefined],
    ["rate_limited", "two"],
    ["rate_limited", "three"],
  ]);
  assertEquals(ada.of("pong").length, 1, "pings are answered and not counted");
  now += 1000;
  ada.send({ type: "publish", channel: "a", data: 4, id: "four" });
  // Every frame the room reads counts, refused ones too: a, b, c, the
  // oversized one and one fill the burst.
  assertEquals(ada.of("ack").map((a) => a.id), ["one", "four"]);
});

Deno.test("room: frames the room cannot use still count against the rate", () => {
  let now = 0;
  const room = memoryRoom({
    now: () => now,
    options: { rate: [{ name: "frames", limit: 3, window: 1, burst: 3 }] },
  });
  const ada = room.connect(ADA, CHAT);
  // Malformed JSON, a frame of no known type, and a ping spelled so the
  // runtime's auto-response does not match: each reaches the room.
  ada.send("{not json");
  ada.send({ type: "nonsense" });
  ada.send('{ "type": "ping" }');
  ada.send("{not json");
  ada.send('{ "type": "ping" }');
  ada.send({ type: "publish", channel: "chat", data: 1, id: "late" });
  assertEquals(ada.of("pong").length, 1);
  assertEquals(ada.of("error").map((e) => [e.code, e.id]), [
    ["bad_frame", undefined],
    ["bad_frame", undefined],
    ["rate_limited", undefined],
    ["rate_limited", undefined],
    ["rate_limited", "late"],
  ]);
  now += 1000;
  ada.send({ type: "publish", channel: "chat", data: 2, id: "later" });
  assertEquals(ada.of("ack").map((a) => a.id), ["later"]);
});

Deno.test("room: the validate hook can refuse, for clients and the server", () => {
  const room = memoryRoom({
    validate: (draft: Draft) => {
      if (typeof draft.data !== "string") throw new RoomRefusal("text only");
    },
  });
  const ada = room.connect(ADA, CHAT);
  ada.send({ type: "publish", channel: "chat", data: 5, id: "n" });
  assertEquals(ada.of("error"), [{
    type: "error",
    code: "invalid",
    message: "text only",
    id: "n",
  }]);
  assertThrows(() => room.core.publish("chat", 5), RoomRefusal);
  assertEquals(
    room.core.publish("chat", "ok").seq,
    1,
    "refusals take no number",
  );
  assertThrows(() => room.core.publish("bad channel", "x"), TypeError);
});

Deno.test("room: state survives hibernation, and stale records are dropped", () => {
  const room = memoryRoom();
  const ada = room.connect(ADA, CHAT);
  const bob = room.connect(BOB, CHAT);
  ada.send({ type: "subscribe", channel: "chat" });
  bob.send({ type: "presence", state: "here" });
  // Bob's socket goes away while the room sleeps; its record lingers.
  room.host.sockets_.delete(bob.socket);
  room.hibernate();
  room.core.publish("chat", "after waking");
  assertEquals(ada.of("message").map((m) => m.data), ["after waking"]);
  assertEquals(room.core.presence().map((e) => e.identity.id), ["ada"]);
  assert(!room.host.connections.has(bob.socket.id), "bob's record is gone");
  assertEquals(
    room.core.publish("chat", "next").seq,
    2,
    "the counter survives",
  );
});

Deno.test("room: disconnecting an identity closes its sockets", () => {
  const room = memoryRoom();
  const ada1 = room.connect(ADA, CHAT);
  const ada2 = room.connect(ADA, CHAT);
  const bob = room.connect(BOB, CHAT);
  assertEquals(room.core.disconnect("ada", "banned"), 2);
  assertEquals(ada1.socket.closed, { code: 4000, reason: "banned" });
  assertEquals(ada2.socket.closed?.code, 4000);
  assertEquals(bob.socket.closed, null);
  assertEquals(room.core.presence().map((e) => e.identity.id), ["bob"]);
});

Deno.test("room: frames from an unknown socket close it", () => {
  const room = memoryRoom();
  const ada = room.connect(ADA, CHAT);
  room.host.connections.clear();
  room.hibernate();
  ada.send({ type: "subscribe", channel: "chat" });
  assertEquals(ada.socket.closed?.code, 1011);
});
