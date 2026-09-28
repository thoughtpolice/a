// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  checkGrants,
  checkIdentity,
  granted,
  isChannel,
  isRoomName,
  parseClientFrame,
} from "@celld/web/realtime";

Deno.test("protocol: client frames parse, and only the known ones", () => {
  assertEquals(
    parseClientFrame('{"type":"subscribe","channel":"chat"}', 1024),
    {
      type: "subscribe",
      channel: "chat",
    },
  );
  assertEquals(
    parseClientFrame('{"type":"subscribe","channel":"chat","after":7}', 1024),
    { type: "subscribe", channel: "chat", after: 7 },
  );
  assertEquals(
    parseClientFrame(
      '{"type":"publish","channel":"a","data":{"x":[1]},"id":"p1"}',
      1024,
    ),
    { type: "publish", channel: "a", data: { x: [1] }, id: "p1" },
  );
  assertEquals(parseClientFrame('{"type":"presence","state":null}', 1024), {
    type: "presence",
    state: null,
  });
  assertEquals(parseClientFrame('{"type":"ping"}', 1024), { type: "ping" });
  const refused: [string | ArrayBuffer, string][] = [
    [new ArrayBuffer(4), "bad_frame"],
    ["not json", "bad_frame"],
    ["[1]", "bad_frame"],
    ['{"type":"shout"}', "bad_frame"],
    ['{"type":"subscribe","channel":"has space"}', "bad_frame"],
    ['{"type":"subscribe","channel":"a","after":-1}', "bad_frame"],
    ['{"type":"subscribe","channel":"a","after":1.5}', "bad_frame"],
    ['{"type":"publish","channel":"a"}', "bad_frame"],
    ['{"type":"publish","channel":"a","data":1,"id":""}', "bad_frame"],
    ['{"type":"presence"}', "bad_frame"],
    ['{"type":"ping","__proto__":{}}', "bad_frame"],
    [
      `{"type":"publish","channel":"a","data":"${"x".repeat(2000)}"}`,
      "too_large",
    ],
  ];
  for (const [text, code] of refused) {
    const result = parseClientFrame(text, 1024);
    assert("error" in result, String(text).slice(0, 40));
    assertEquals(result.error, code, String(text).slice(0, 40));
  }
});

Deno.test("protocol: grants match names, prefixes and everything", () => {
  assert(granted(["chat"], "chat"), "exact");
  assert(!granted(["chat"], "chatter"), "not a prefix unless it says so");
  assert(granted(["doc:*"], "doc:42"), "prefix");
  assert(!granted(["doc:*"], "docs"), "prefix is literal");
  assert(granted(["*"], "anything"), "everything");
  assert(!granted([], "chat"), "nothing");
});

Deno.test("protocol: grants and identities are checked", () => {
  assertEquals(checkGrants({ read: ["a", "b:*"] }), {
    read: ["a", "b:*"],
    write: [],
    presence: false,
  });
  assertThrows(() => checkGrants({ read: ["a*b"] }), TypeError);
  assertThrows(() => checkGrants({ read: "a" }), TypeError);
  assertThrows(() => checkGrants({ admin: true }), TypeError);
  assertThrows(() => checkGrants({ presence: "yes" }), TypeError);
  assertEquals(checkIdentity({ id: "u1", name: "Ada" }), {
    id: "u1",
    name: "Ada",
  });
  assertThrows(() => checkIdentity({ name: "no id" }), TypeError);
  assertThrows(
    () => checkIdentity({ id: "u1", bio: "x".repeat(2000) }),
    TypeError,
  );
  assert(isChannel("doc:42.cursor_a-b"), "channel");
  assert(!isChannel(""), "empty");
  assert(isRoomName("team:acme"), "room");
  assert(!isRoomName("a/b"), "slash");
});
