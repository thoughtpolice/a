// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import { CONNECT_HEADER } from "@celld/web/realtime";
import {
  connectRoom,
  principalIdentity,
  type RoomNamespace,
} from "@celld/web/realtime/router";
import {
  apiKey,
  hashApiKey,
  hashedKeys,
  router,
  toPrincipal,
} from "@celld/web/router";

const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  abort: () => {},
  exports: {},
  props: undefined,
};

/** A namespace that records what reaches each room, and answers 200. */
function rooms() {
  const seen: { room: string; request: Request }[] = [];
  const namespace: RoomNamespace = {
    getByName: (room) => ({
      fetch: (request) => {
        seen.push({ room, request });
        return Promise.resolve(new Response("upgraded"));
      },
    }),
  };
  return { seen, namespace };
}

async function app(origins?: string[]) {
  const { seen, namespace } = rooms();
  const keys = hashedKeys({
    [await hashApiKey("key-ada")]: { subject: "ada" },
  });
  const served = router({ auth: apiKey({ lookup: keys }) });
  served.get("/rooms/:room", (c) =>
    connectRoom(c, namespace, c.params.room, {
      grants: { read: ["chat"], write: ["chat"], presence: true },
      ...(origins === undefined ? {} : { origins }),
    }));
  const send = (path: string, headers: Record<string, string> = {}) =>
    served.fetch(
      new Request(`https://chat.example.com${path}`, {
        headers: { "x-api-key": "key-ada", ...headers },
      }),
      {},
      ctx,
    );
  return { seen, send };
}

const UPGRADE = { upgrade: "websocket", connection: "Upgrade" };

Deno.test("connect: an upgrade reaches the room with only identity and grants", async () => {
  const { seen, send } = await app();
  const response = await send("/rooms/lobby", {
    ...UPGRADE,
    origin: "https://chat.example.com",
    cookie: "secret=1",
    [CONNECT_HEADER]:
      '{"room":"lobby","identity":{"id":"admin"},"grants":{"write":["*"]}}',
    "sec-websocket-protocol": "celld.v1",
  });
  assertEquals(await response.text(), "upgraded");
  assertEquals(seen.length, 1);
  const { room, request } = seen[0];
  assertEquals(room, "lobby");
  const forwarded = JSON.parse(request.headers.get(CONNECT_HEADER)!);
  assertEquals(forwarded, {
    room: "lobby",
    identity: { id: forwarded.identity.id, subject: "ada" },
    grants: { read: ["chat"], write: ["chat"], presence: true },
  });
  assert(/^[0-9a-f]{64}$/.test(forwarded.identity.id), "a SHA-256 in hex");
  assertEquals(request.headers.get("cookie"), null);
  assertEquals(request.headers.get("sec-websocket-protocol"), "celld.v1");
  assertEquals(request.headers.get("upgrade"), "websocket");
});

Deno.test("connect: not an upgrade is a 426", async () => {
  const { seen, send } = await app();
  const response = await send("/rooms/lobby");
  assertEquals(response.status, 426);
  assertEquals(response.headers.get("upgrade"), "websocket");
  assertEquals((await response.json()).error, "upgrade_required");
  assertEquals(seen, []);
});

Deno.test("connect: another site's page cannot open the socket", async () => {
  const { seen, send } = await app();
  const hijack = await send("/rooms/lobby", {
    ...UPGRADE,
    origin: "https://evil.example",
  });
  assertEquals([hijack.status, (await hijack.json()).error], [
    403,
    "forbidden_origin",
  ]);
  // A client that is not a browser sends no Origin, and cannot be a visitor.
  assertEquals((await send("/rooms/lobby", UPGRADE)).status, 200);
  assertEquals(seen.length, 1);
  const listed = await app(["https://app.example.net"]);
  assertEquals(
    (await listed.send("/rooms/lobby", {
      ...UPGRADE,
      origin: "https://app.example.net",
    }))
      .status,
    200,
  );
  assertEquals(
    (await listed.send("/rooms/lobby", {
      ...UPGRADE,
      origin: "https://chat.example.com",
    }))
      .status,
    403,
  );
});

Deno.test("connect: room names are checked, and the caller authenticated first", async () => {
  const { seen, send } = await app();
  const bad = await send("/rooms/a%20b", UPGRADE);
  assertEquals([bad.status, (await bad.json()).error], [400, "bad_room"]);
  const anonymous = await send("/rooms/lobby", {
    ...UPGRADE,
    "x-api-key": "wrong",
  });
  assertEquals(anonymous.status, 401);
  assert(seen.length === 0, "nothing reached a room");
});

Deno.test("connect: the default identity is the principal's key, not its subject", async () => {
  // Two schemes, or two issuers, can each have a user "ada"; a room must
  // not take one for the other (in presence, or in `disconnect`).
  const keyed = toPrincipal({ subject: "ada" }, "api-key");
  const bearer = toPrincipal(
    { subject: "ada", issuer: "https://idp.example" },
    "bearer",
  );
  const [a, b] = [
    await principalIdentity(keyed),
    await principalIdentity(bearer),
  ];
  assertEquals([a.subject, b.subject], ["ada", "ada"]);
  assert(a.id !== b.id, "two principals named ada are two identities");
  assertEquals(await principalIdentity(keyed), a);
});
