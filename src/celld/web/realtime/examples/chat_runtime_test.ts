// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `chat` example under `celld dev` with real WebSockets: `RoomClient`s
 * (and a raw socket or two) against the packaged project, which the
 * example harness cannot do, since it speaks only HTTP. Each test starts
 * its own server.
 */

import { assert, assertEquals } from "@celld/core/assert";
import type { Message, PresenceEntry } from "@celld/web/realtime";
import {
  RoomClient,
  RoomClientError,
  type RoomStatus,
  type WebSocketLike,
} from "@celld/web/realtime/client";
import { DevServer } from "./dev_server.ts";
import spec from "./chat.json" with { type: "json" };

const CELLD = Deno.env.get("CELLD")!;
const PROJECT = Deno.env.get("PROJECT")!;

// The realtime router's default identity is SHA-256(principal.key), not the
// potentially colliding human-facing subject.
const ADA_ID =
  "aaaca25b7e94ef424296b5a31d3457305584abca3952f983e8abfdb127127692";
const BOB_ID =
  "580a52ef441a181dd56323a8a5a25f4ceda358afbb69a9a1c5969e6f05b121f8";

async function until(
  what: string,
  condition: () => boolean,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function socket(url: string, headers: Record<string, string>): WebSocketLike {
  // Deno's WebSocket takes headers, which a browser's does not.
  const Socket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocketLike;
  return new Socket(url, { headers });
}

interface Member {
  readonly client: RoomClient;
  readonly messages: Message[];
  readonly errors: string[];
  readonly statuses: RoomStatus[];
  presence: readonly PresenceEntry[];
}

function member(server: DevServer, key: string, room = "lobby"): Member {
  const state: Member = {
    client: undefined as unknown as RoomClient,
    messages: [],
    errors: [],
    statuses: [],
    presence: [],
  };
  (state as { client: RoomClient }).client = new RoomClient({
    url: `${server.origin}/rooms/${room}/socket`,
    connect: (url) => socket(url, { "x-api-key": key }),
    reconnect: { minMs: 200, maxMs: 1000 },
    onError: (error) => state.errors.push(error.code),
    onStatus: (status) => state.statuses.push(status),
    onPresence: (presence) => state.presence = presence,
  });
  return state;
}

async function withServer(fn: (server: DevServer) => Promise<void>) {
  const server = await DevServer.start(CELLD, PROJECT, spec.vars);
  try {
    await fn(server);
  } catch (error) {
    throw new Error(`${error}\n--- celld dev ---\n${server.log}`, {
      cause: error,
    });
  } finally {
    await server.stop();
  }
}

function announce(server: DevServer, text: string, room = "lobby") {
  return fetch(`${server.origin}/rooms/${room}/announcements`, {
    method: "POST",
    headers: {
      "x-api-key": "example-key-root",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  }).then((response) => response.json());
}

const options = { sanitizeOps: false, sanitizeResources: false };

Deno.test(
  "chat: members talk, in order, and see each other come and go",
  options,
  async () => {
    await withServer(async (server) => {
      const ada = member(server, "example-key-ada");
      ada.client.subscribe("chat", (message) => ada.messages.push(message));
      await ada.client.ready();
      const bob = member(server, "example-key-bob");
      bob.client.subscribe("chat", (message) => bob.messages.push(message));
      await bob.client.ready();
      await until("ada sees bob", () => ada.presence.length === 2);
      assertEquals(
        ada.presence.map((entry) => entry.identity.id).sort(),
        [
          ADA_ID,
          BOB_ID,
        ].sort(),
      );

      const first = await bob.client.publish("chat", { text: "hi ada" });
      const second = await ada.client.publish("chat", { text: "hi bob" });
      assertEquals(second, first + 1);
      await until(
        "both messages",
        () => ada.messages.length === 2 && bob.messages.length === 2,
      );
      assertEquals(
        ada.messages.map((
          m,
        ) => [m.seq, m.from?.id, (m.data as { text: string }).text]),
        [[first, BOB_ID, "hi ada"], [second, ADA_ID, "hi bob"]],
      );

      bob.client.close();
      await until("bob leaves", () => ada.presence.length === 1);
      const presence = await fetch(`${server.origin}/rooms/lobby/presence`, {
        headers: { "x-api-key": "example-key-root" },
      }).then((response) => response.json());
      assertEquals(
        presence.presence.map((entry: PresenceEntry) => entry.identity.id),
        [ADA_ID],
      );
      ada.client.close();
    });
  },
);

Deno.test(
  "chat: the room checks what is published, and who may",
  options,
  async () => {
    await withServer(async (server) => {
      const ada = member(server, "example-key-ada");
      await ada.client.ready();
      const refusals: string[] = [];
      for (
        const [channel, data] of [
          ["chat", { text: "" }],
          ["chat", { text: "hi", extra: 1 }],
          ["announcements", { text: "I am the server now" }],
        ] as const
      ) {
        await ada.client.publish(channel, data).catch((
          error: RoomClientError,
        ) => refusals.push(error.code));
      }
      assertEquals(refusals, ["invalid", "invalid", "forbidden"]);

      const vic = member(server, "example-key-vic");
      await vic.client.ready();
      vic.client.subscribe("chat", (message) => vic.messages.push(message));
      const denied = await vic.client.publish("chat", { text: "hello?" }).catch(
        (e) => e,
      );
      assert(
        denied instanceof RoomClientError && denied.code === "forbidden",
        String(denied),
      );
      await ada.client.publish("chat", { text: "for readers" });
      await until("the viewer reads", () => vic.messages.length === 1);
      assertEquals(
        ada.presence.map((entry) => entry.identity.id),
        [ADA_ID],
        "viewers are not in presence",
      );
      ada.client.close();
      vic.client.close();
    });
  },
);

Deno.test(
  "chat: announcements from the server, pings, and cross-site sockets",
  options,
  async () => {
    await withServer(async (server) => {
      const ada = member(server, "example-key-ada");
      ada.client.subscribe(
        "announcements",
        (message) => ada.messages.push(message),
      );
      await ada.client.ready();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assertEquals(await announce(server, "maintenance at noon"), { seq: 1 });
      await until("the announcement", () => ada.messages.length === 1);
      assertEquals(ada.messages[0].from, null);

      // A raw socket's ping is answered by the runtime, without the room.
      const raw = socket(
        `${server.origin.replace("http", "ws")}/rooms/lobby/socket`,
        {
          "x-api-key": "example-key-bob",
        },
      );
      const frames: string[] = [];
      raw.onmessage = (event) => frames.push(event.data);
      await until(
        "the welcome",
        () => frames.some((f) => f.includes('"welcome"')),
      );
      raw.send('{"type":"ping"}');
      await until("the pong", () => frames.includes('{"type":"pong"}'));
      raw.close();

      // Another site's page is refused at the handshake.
      let refused = false;
      const hijack = socket(
        `${server.origin.replace("http", "ws")}/rooms/lobby/socket`,
        {
          "x-api-key": "example-key-bob",
          origin: "https://evil.example",
        },
      );
      hijack.onerror = () => refused = true;
      hijack.onclose = () => refused = true;
      await until("the refusal", () => refused);
      ada.client.close();
    });
  },
);

Deno.test(
  "chat: an admin removes a member, who does not come back",
  options,
  async () => {
    await withServer(async (server) => {
      const bob = member(server, "example-key-bob");
      await bob.client.ready();
      const removed = await fetch(
        `${server.origin}/rooms/lobby/members/${BOB_ID}`,
        {
          method: "DELETE",
          headers: { "x-api-key": "example-key-root" },
        },
      ).then((response) => response.json());
      assertEquals(removed, { closed: 1 });
      await until("bob is closed", () => bob.client.status === "closed");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assertEquals(
        bob.statuses.at(-1),
        "closed",
        "no reconnect after a removal",
      );
    });
  },
);

Deno.test(
  "chat: after a restart, clients reconnect and miss nothing kept",
  options,
  async () => {
    await withServer(async (server) => {
      const ada = member(server, "example-key-ada");
      ada.client.subscribe(
        "announcements",
        (message) => ada.messages.push(message),
      );
      await ada.client.ready();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await announce(server, "one");
      await until("the first", () => ada.messages.length === 1);

      await server.restart();
      // Published before ada is back: the room keeps it, ada's resume replays it.
      assertEquals(await announce(server, "two"), { seq: 2 });
      await until("ada reconnects", () => ada.client.status === "open", 20_000);
      await announce(server, "three");
      await until(
        `the rest (have ${JSON.stringify(ada.messages)}, ${ada.statuses})`,
        () => ada.messages.length === 3,
        20_000,
      );
      assertEquals(
        ada.messages.map((m) => [m.seq, (m.data as { text: string }).text]),
        [[1, "one"], [2, "two"], [3, "three"]],
      );
      assert(ada.statuses.includes("reconnecting"), ada.statuses.join());
      ada.client.close();
    });
  },
);

Deno.test(
  "chat: messages from sockets and from the server arrive in order",
  options,
  async () => {
    await withServer(async (server) => {
      // Messages from a socket's handler and from RPCs interleave, and the
      // client delivers them as they arrive: each must follow its channel's
      // previous one on the wire (celld #236 used to shuffle them).
      const ada = member(server, "example-key-ada");
      await ada.client.ready();
      const bob = member(server, "example-key-bob");
      bob.client.subscribe("chat", (message) => bob.messages.push(message));
      bob.client.subscribe(
        "announcements",
        (message) => bob.messages.push(message),
      );
      await bob.client.ready();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const work: Promise<unknown>[] = [];
      for (let i = 0; i < 20; i++) {
        work.push(announce(server, `s${i}`));
        work.push(ada.client.publish("chat", { text: `c${i}` }));
      }
      await Promise.all(work);
      await until("all forty", () => bob.messages.length === 40);
      for (const channel of ["chat", "announcements"]) {
        const received = bob.messages.filter((m) => m.channel === channel);
        // Arrived in order: each follows the one before in its channel.
        received.forEach((m, i) => {
          if (i > 0) {
            assertEquals(m.prev, received[i - 1].seq, `${channel} ${m.seq}`);
          }
        });
        const texts = received.map((m) => (m.data as { text: string }).text);
        const sent = Array.from(
          { length: 20 },
          (_, i) => `${channel === "chat" ? "c" : "s"}${i}`,
        );
        // One socket's publishes keep their order; concurrent HTTP ones are
        // numbered in whatever order the room took them.
        assertEquals(
          channel === "chat" ? texts : [...texts].sort(),
          channel === "chat" ? sent : [...sent].sort(),
          channel,
        );
      }
      ada.client.close();
      bob.client.close();
    });
  },
);
