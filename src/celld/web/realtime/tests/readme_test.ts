// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** The examples in README.md, as written there, over in-memory rooms. */

import { assertEquals } from "@celld/core/assert";
import { type Draft, RoomRefusal } from "@celld/web/realtime";
import { RoomClient } from "@celld/web/realtime/client";
import {
  connectRoom,
  principalIdentity,
  type RoomNamespace,
} from "@celld/web/realtime/router";
import { memoryRoom } from "@celld/web/realtime/testing";
import {
  apiKey,
  hashApiKey,
  hashedKeys,
  type PrincipalInput,
  router,
} from "@celld/web/router";

function validate(draft: Draft): void {
  if (typeof draft.data !== "string") throw new RoomRefusal("text only");
}

Deno.test("the README's room, grants and client", async () => {
  const room = memoryRoom({ room: "lobby", validate });
  const lines: unknown[] = [];
  const members: string[][] = [];
  const client = new RoomClient({
    url: "https://example.com/rooms/lobby/socket",
    connect: () =>
      room.socket({ id: "ada", name: "Ada" }, {
        read: ["chat", "cursor:*"],
        write: ["chat"],
        presence: true,
      }),
    onPresence: (list) => members.push(list.map((entry) => entry.identity.id)),
  });
  client.subscribe(
    "chat",
    (message) => lines.push([message.from?.id, message.data]),
  );
  await client.ready();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await client.publish("chat", "hi");
  room.core.publish("chat", "hello");
  client.setPresence({ typing: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(lines, [["ada", "hi"], [undefined, "hello"]]);
  assertEquals(members.at(-1), ["ada"]);
  assertEquals(room.core.presence()[0].state, { typing: false });
  const refused = await client.publish("chat", { not: "text" }).catch((e) =>
    e.code
  );
  assertEquals(refused, "invalid");
  client.close();
});

Deno.test("the README's route hands the room identity and grants", async () => {
  const seen: string[] = [];
  const rooms: RoomNamespace = {
    getByName: (name) => ({
      fetch: (request) => {
        seen.push(`${name} ${request.headers.get("x-celld-realtime-connect")}`);
        return Promise.resolve(new Response("upgraded"));
      },
    }),
  };
  const principal: PrincipalInput = { subject: "ada", claims: { name: "Ada" } };
  const keys = hashedKeys({ [await hashApiKey("key-ada")]: principal });
  const app = router({ auth: apiKey({ lookup: keys }) });
  app.get(
    "/rooms/:room/socket",
    async (c) =>
      connectRoom(c, rooms, c.params.room, {
        identity: {
          ...await principalIdentity(c.principal),
          name: c.principal.claims.name as string,
        },
        grants: { read: ["chat", "cursor:*"], write: ["chat"], presence: true },
      }),
  );
  const response = await app.fetch(
    new Request("https://example.com/rooms/lobby/socket", {
      headers: { upgrade: "websocket", "x-api-key": "key-ada" },
    }),
    {},
    {
      waitUntil: () => {},
      passThroughOnException: () => {},
      abort: () => {},
      exports: {},
      props: undefined,
    },
  );
  assertEquals(await response.text(), "upgraded");
  assertEquals(seen.length, 1);
  const [room, header] = [seen[0].slice(0, 5), JSON.parse(seen[0].slice(6))];
  assertEquals([room, header], ["lobby", {
    room: "lobby",
    identity: { id: header.identity.id, subject: "ada", name: "Ada" },
    grants: { read: ["chat", "cursor:*"], write: ["chat"], presence: true },
  }]);
  assertEquals(header.identity.id.length, 64);
});
